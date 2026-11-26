begin;

create function crm_private.valid_control_dates(value jsonb)
returns boolean language plpgsql immutable strict set search_path = ''
as $$
declare
    item jsonb;
begin
    if jsonb_typeof(value) <> 'array' then
        return false;
    end if;
    if jsonb_array_length(value) > 50 then
        return false;
    end if;
    for item in select element from jsonb_array_elements(value) as dates(element) loop
        if jsonb_typeof(item) <> 'object'
           or jsonb_typeof(item -> 'label') is distinct from 'string'
           or jsonb_typeof(item -> 'date') is distinct from 'string'
           or char_length(btrim(item ->> 'label')) not between 1 and 120
           or item ->> 'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
            return false;
        end if;
        if item - array['label', 'date'] <> '{}'::jsonb then
            return false;
        end if;
        begin
            perform (item ->> 'date')::date;
        exception when invalid_datetime_format or datetime_field_overflow then
            return false;
        end;
    end loop;
    return true;
end;
$$;
revoke execute on function crm_private.valid_control_dates(jsonb) from public, anon, authenticated;
grant execute on function crm_private.valid_control_dates(jsonb) to authenticated, service_role;

alter table public.sponsors
    add column notes text check (char_length(notes) <= 4000),
    add column control_dates jsonb not null default '[]'::jsonb
        check (crm_private.valid_control_dates(control_dates));
grant insert (notes, control_dates), update (notes, control_dates) on public.sponsors to authenticated;

create or replace function crm_private.validate_sponsor_change()
returns trigger language plpgsql set search_path = ''
as $$
begin
    if tg_op = 'UPDATE'
       and row(new.company, new.owner_id, new.notes) is distinct from row(old.company, old.owner_id, old.notes)
       and auth.uid() is not null
       and not crm_private.can_manage_department(old.event_id, old.department_id) then
        raise exception using errcode = '42501', message = 'Компания, назначение и комментарий изменяются руководителем направления';
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

create table public.direction_cards (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null,
    department_id uuid not null,
    name text not null check (char_length(btrim(name)) between 1 and 200),
    status text not null default 'new'
        check (status in ('new', 'in_progress', 'discussed', 'agreed', 'declined')),
    amount numeric(14, 2) check (amount >= 0 and amount <= 999999999999.99),
    notes text check (char_length(notes) <= 4000),
    control_dates jsonb not null default '[]'::jsonb check (crm_private.valid_control_dates(control_dates)),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (event_id, department_id) references public.departments (event_id, id)
);
create index direction_cards_department_idx on public.direction_cards (event_id, department_id, name, id);

alter table public.direction_cards enable row level security;
revoke all on public.direction_cards from public, anon, authenticated;
grant select on public.direction_cards to authenticated;
grant insert (event_id, department_id, name, status, amount, notes, control_dates),
    update (name, status, amount, notes, control_dates) on public.direction_cards to authenticated;

create policy direction_cards_read on public.direction_cards for select to authenticated
    using (crm_private.is_member(event_id));
create policy direction_cards_create on public.direction_cards for insert to authenticated
    with check (
        crm_private.can_manage_department(event_id, department_id)
        and exists (
            select 1 from public.departments as department
            where department.event_id = direction_cards.event_id and department.id = direction_cards.department_id
              and not department.sponsor_workspace and not department.archived
        )
    );
create policy direction_cards_edit on public.direction_cards for update to authenticated
    using (crm_private.can_manage_department(event_id, department_id))
    with check (crm_private.can_manage_department(event_id, department_id));

create trigger direction_cards_touch before update on public.direction_cards
    for each row execute function crm_private.set_updated_at();
create trigger direction_cards_log after insert or update on public.direction_cards
    for each row execute function crm_private.log_change();

notify pgrst, 'reload schema';

commit;
