begin;

alter table public.departments add column archived boolean not null default false;
grant update (archived) on public.departments to authenticated;

alter policy departments_edit on public.departments
    using (crm_private.is_coordinator(event_id))
    with check (crm_private.is_coordinator(event_id));

create table public.event_tabs (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events (id),
    builtin text check (builtin in ('dashboard', 'directions', 'tasks', 'team', 'settings')),
    name text not null check (btrim(name) <> '' and char_length(name) <= 120),
    body text not null default '' check (
        char_length(body) <= 20000 and (builtin is null or body = '')
    ),
    archived boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (event_id, builtin),
    unique (event_id, name)
);

alter table public.event_tabs enable row level security;
revoke all on public.event_tabs from public, anon, authenticated;
grant select on public.event_tabs to authenticated;
grant insert (event_id, name, body), update (name, body, archived)
    on public.event_tabs to authenticated;
grant select, insert on public.event_tabs to service_role;

create policy event_tabs_read on public.event_tabs for select to authenticated
    using (
        crm_private.is_member(event_id)
        and ((not archived and builtin is distinct from 'settings') or crm_private.is_coordinator(event_id))
    );
create policy event_tabs_add on public.event_tabs for insert to authenticated
    with check (crm_private.is_coordinator(event_id) and builtin is null and not archived);
create policy event_tabs_edit on public.event_tabs for update to authenticated
    using (crm_private.is_coordinator(event_id)) with check (crm_private.is_coordinator(event_id));

create function crm_private.default_event_tabs()
returns table (builtin text, name text)
language sql immutable set search_path = ''
as $$
    values ('dashboard', 'Дашборд'), ('directions', 'Направления'), ('tasks', 'Задачи'),
           ('team', 'Команда'), ('settings', 'Настройки');
$$;

create function crm_private.add_default_event_tabs()
returns trigger language plpgsql set search_path = ''
as $$
begin
    insert into public.event_tabs (event_id, builtin, name)
    select new.id, defaults.builtin, defaults.name from crm_private.default_event_tabs() as defaults;
    return new;
end;
$$;

revoke execute on function crm_private.default_event_tabs(), crm_private.add_default_event_tabs()
    from public, anon, authenticated;
grant execute on function crm_private.default_event_tabs() to service_role;

-- Existing events keep their original menu and all of their data.
insert into public.event_tabs (event_id, builtin, name)
select event.id, defaults.builtin, defaults.name
from public.events as event cross join crm_private.default_event_tabs() as defaults;

create trigger events_add_default_tabs after insert on public.events
    for each row execute function crm_private.add_default_event_tabs();
create trigger event_tabs_touch before update on public.event_tabs
    for each row execute function crm_private.set_updated_at();
create trigger event_tabs_log after insert or update on public.event_tabs
    for each row execute function crm_private.log_change();

create function crm_private.tasks_check_department_archive()
returns trigger language plpgsql set search_path = ''
as $$
begin
    if tg_op = 'UPDATE' and new.department_id is not distinct from old.department_id then
        return new;
    end if;
    if exists (
        select 1 from public.departments
        where event_id = new.event_id and id = new.department_id and archived
    ) then
        raise exception using errcode = '23514', message = 'Направление в архиве';
    end if;
    return new;
end;
$$;

revoke execute on function crm_private.tasks_check_department_archive()
    from public, anon, authenticated;
create trigger tasks_verify_department_archive before insert or update of department_id on public.tasks
    for each row execute function crm_private.tasks_check_department_archive();

notify pgrst, 'reload schema';

commit;
