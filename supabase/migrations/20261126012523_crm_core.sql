-- Проект миграции для согласования. Применение к проекту Supabase отдельно согласовывается.
begin;

create schema crm_private;
revoke all on schema crm_private from public, anon, authenticated;
grant usage on schema crm_private to authenticated;

create table public.profiles (
    id uuid primary key references auth.users (id),
    display_name text not null check (btrim(display_name) <> ''),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.events (
    id uuid primary key default gen_random_uuid(),
    name text not null check (btrim(name) <> ''),
    starts_at timestamptz not null,
    venue text,
    status text not null check (status in ('planned', 'active', 'archived')),
    created_by uuid not null references public.profiles (id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table public.event_members (
    event_id uuid not null references public.events (id),
    user_id uuid not null references public.profiles (id),
    role text not null check (role in ('coordinator', 'member')),
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (event_id, user_id)
);

create table public.departments (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events (id),
    name text not null check (btrim(name) <> ''),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (event_id, id),
    unique (event_id, name)
);

create table public.department_members (
    event_id uuid not null,
    department_id uuid not null,
    user_id uuid not null,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (event_id, department_id, user_id),
    foreign key (event_id, department_id) references public.departments (event_id, id),
    foreign key (event_id, user_id) references public.event_members (event_id, user_id)
);

create table public.activity_log (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events (id),
    actor_id uuid references auth.users (id),
    entity_type text not null,
    entity_id uuid not null,
    action text not null check (action in ('insert', 'update')),
    changed_at timestamptz not null default now(),
    changes jsonb not null
);

create index events_created_by_idx on public.events (created_by);
create index event_members_user_idx on public.event_members (user_id, event_id);
create index department_members_user_idx on public.department_members (event_id, user_id);
create index activity_log_event_date_idx on public.activity_log (event_id, changed_at desc);
create index activity_log_actor_idx on public.activity_log (actor_id);

-- Эти функции читают таблицы членства без повторного входа в их собственные RLS.
-- Схема crm_private остаётся вне списка схем Data API.
create function crm_private.is_member(target_event uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.event_members
        where event_id = target_event and user_id = (select auth.uid()) and active
    );
$$;

create function crm_private.is_coordinator(target_event uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.event_members
        where event_id = target_event and user_id = (select auth.uid())
          and active and role = 'coordinator'
    );
$$;

create function crm_private.can_manage_department(target_event uuid, target_department uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
    select crm_private.is_coordinator(target_event) or (
        crm_private.is_member(target_event) and exists (
            select 1 from public.department_members
            where event_id = target_event and department_id = target_department
              and user_id = (select auth.uid()) and active
        )
    );
$$;

create function crm_private.can_read_profile(target_user uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
    select (select auth.uid()) = target_user or exists (
        select 1 from public.event_members viewer
        join public.event_members teammate using (event_id)
        where viewer.user_id = (select auth.uid()) and viewer.active
          and teammate.user_id = target_user and teammate.active
    );
$$;

create function crm_private.set_updated_at()
returns trigger language plpgsql set search_path = ''
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create function crm_private.log_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
    before_row jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
    after_row jsonb := to_jsonb(new);
    changed_fields jsonb;
begin
    select jsonb_agg(field.name order by field.name) into changed_fields
    from jsonb_object_keys(after_row) as field(name)
    where field.name not in ('created_at', 'updated_at')
      and before_row -> field.name is distinct from after_row -> field.name;

    if changed_fields is not null then
        insert into public.activity_log (event_id, actor_id, entity_type, entity_id, action, changes)
        values (
            (coalesce(after_row ->> 'event_id', after_row ->> 'id'))::uuid,
            auth.uid(), tg_table_name,
            (coalesce(after_row ->> 'id', after_row ->> 'user_id'))::uuid,
            lower(tg_op),
            jsonb_strip_nulls(jsonb_build_object(
                'fields', changed_fields,
                'department_id', after_row -> 'department_id',
                'task_id', after_row -> 'task_id',
                'status_before', before_row -> 'status',
                'status_after', after_row -> 'status'
            ))
        );
    end if;
    return new;
end;
$$;

revoke execute on all functions in schema crm_private from public, anon, authenticated;
grant execute on function crm_private.is_member(uuid), crm_private.is_coordinator(uuid),
    crm_private.can_manage_department(uuid, uuid), crm_private.can_read_profile(uuid)
to authenticated;

alter table public.profiles enable row level security;
alter table public.events enable row level security;
alter table public.event_members enable row level security;
alter table public.departments enable row level security;
alter table public.department_members enable row level security;
alter table public.activity_log enable row level security;

revoke all on public.profiles, public.events, public.event_members, public.departments,
    public.department_members, public.activity_log from public, anon, authenticated;
grant select on public.profiles, public.events, public.event_members, public.departments,
    public.department_members, public.activity_log to authenticated;
grant update (display_name) on public.profiles to authenticated;
grant update (name, starts_at, venue, status) on public.events to authenticated;
grant insert (event_id, user_id, role, active), update (active)
    on public.event_members to authenticated;
grant insert (event_id, name), update (name) on public.departments to authenticated;
grant insert (event_id, department_id, user_id, active), update (active)
    on public.department_members to authenticated;

create policy profiles_read on public.profiles for select to authenticated
    using (crm_private.can_read_profile(id));
create policy profiles_edit on public.profiles for update to authenticated
    using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy events_read on public.events for select to authenticated
    using (crm_private.is_member(id));
create policy events_edit on public.events for update to authenticated
    using (crm_private.is_coordinator(id)) with check (crm_private.is_coordinator(id));

create policy event_members_read on public.event_members for select to authenticated
    using (crm_private.is_member(event_id));
create policy event_members_add on public.event_members for insert to authenticated
    with check (crm_private.is_coordinator(event_id) and role = 'member');
create policy event_members_edit on public.event_members for update to authenticated
    using (crm_private.is_coordinator(event_id) and role = 'member')
    with check (crm_private.is_coordinator(event_id) and role = 'member');

create policy departments_read on public.departments for select to authenticated
    using (crm_private.is_member(event_id));
create policy departments_add on public.departments for insert to authenticated
    with check (crm_private.is_coordinator(event_id));
create policy departments_edit on public.departments for update to authenticated
    using (crm_private.can_manage_department(event_id, id))
    with check (crm_private.can_manage_department(event_id, id));

create policy department_members_read on public.department_members for select to authenticated
    using (crm_private.is_member(event_id));
create policy department_members_add on public.department_members for insert to authenticated
    with check (crm_private.is_coordinator(event_id));
create policy department_members_edit on public.department_members for update to authenticated
    using (crm_private.is_coordinator(event_id)) with check (crm_private.is_coordinator(event_id));

create policy activity_log_read on public.activity_log for select to authenticated
    using (crm_private.is_member(event_id));

create trigger profiles_touch before update on public.profiles
    for each row execute function crm_private.set_updated_at();
create trigger events_touch before update on public.events
    for each row execute function crm_private.set_updated_at();
create trigger event_members_touch before update on public.event_members
    for each row execute function crm_private.set_updated_at();
create trigger departments_touch before update on public.departments
    for each row execute function crm_private.set_updated_at();
create trigger department_members_touch before update on public.department_members
    for each row execute function crm_private.set_updated_at();

create trigger events_log after insert or update on public.events
    for each row execute function crm_private.log_change();
create trigger event_members_log after insert or update on public.event_members
    for each row execute function crm_private.log_change();
create trigger departments_log after insert or update on public.departments
    for each row execute function crm_private.log_change();
create trigger department_members_log after insert or update on public.department_members
    for each row execute function crm_private.log_change();

commit;
