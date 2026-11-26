begin;

alter table public.departments add column sponsor_workspace boolean not null default false;
update public.departments set sponsor_workspace = true where lower(btrim(name)) = 'спонсоры';

create function crm_private.enable_sponsor_workspace()
returns trigger language plpgsql set search_path = ''
as $$
begin
    if lower(btrim(new.name)) = 'спонсоры' then
        new.sponsor_workspace := true;
    end if;
    return new;
end;
$$;
revoke execute on function crm_private.enable_sponsor_workspace() from public, anon, authenticated;
create trigger departments_enable_sponsor_workspace before insert or update of name on public.departments
    for each row execute function crm_private.enable_sponsor_workspace();

create table public.sponsors (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null,
    department_id uuid not null,
    company text not null check (btrim(company) <> '' and char_length(company) <= 200),
    contact_name text check (contact_name is null or char_length(contact_name) <= 200),
    owner_id uuid,
    status text not null default 'new'
        check (status in ('new', 'in_progress', 'discussed', 'agreed', 'declined')),
    payment_status text not null default 'not_received'
        check (payment_status in ('not_received', 'received')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (event_id, department_id) references public.departments (event_id, id),
    foreign key (event_id, owner_id) references public.event_members (event_id, user_id)
);

create index sponsors_department_idx on public.sponsors (event_id, department_id, company, id);
create index sponsors_owner_idx on public.sponsors (event_id, owner_id);

alter table public.sponsors enable row level security;
revoke all on public.sponsors from public, anon, authenticated;
grant select on public.sponsors to authenticated;
grant insert (event_id, department_id, company, contact_name, owner_id, status, payment_status),
    update (company, contact_name, owner_id, status, payment_status) on public.sponsors to authenticated;

create policy sponsors_read on public.sponsors for select to authenticated
    using (crm_private.is_member(event_id));
create policy sponsors_create on public.sponsors for insert to authenticated
    with check (
        crm_private.can_manage_department(event_id, department_id)
        and exists (
            select 1 from public.departments as department
            where department.event_id = sponsors.event_id and department.id = sponsors.department_id
              and department.sponsor_workspace and not department.archived
        )
    );
create policy sponsors_edit on public.sponsors for update to authenticated
    using (
        crm_private.can_manage_department(event_id, department_id)
        or (owner_id = (select auth.uid()) and crm_private.is_member(event_id))
    )
    with check (
        crm_private.can_manage_department(event_id, department_id)
        or (owner_id = (select auth.uid()) and crm_private.is_member(event_id))
    );

create function crm_private.validate_sponsor_change()
returns trigger language plpgsql set search_path = ''
as $$
begin
    if tg_op = 'UPDATE'
       and row(new.company, new.owner_id) is distinct from row(old.company, old.owner_id)
       and auth.uid() is not null
       and not crm_private.can_manage_department(old.event_id, old.department_id) then
        raise exception using errcode = '42501', message = 'Компания и ответственный изменяются руководителем направления';
    end if;

    if new.owner_id is not null
       and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
       and not exists (
           select 1 from public.event_members
           where event_id = new.event_id and user_id = new.owner_id and active
       ) then
        raise exception using errcode = '23514', message = 'Ответственный должен быть активным участником мероприятия';
    end if;
    return new;
end;
$$;

revoke execute on function crm_private.validate_sponsor_change() from public, anon, authenticated;
create trigger sponsors_validate before insert or update on public.sponsors
    for each row execute function crm_private.validate_sponsor_change();
create trigger sponsors_touch before update on public.sponsors
    for each row execute function crm_private.set_updated_at();
create trigger sponsors_log after insert or update on public.sponsors
    for each row execute function crm_private.log_change();

notify pgrst, 'reload schema';

commit;
