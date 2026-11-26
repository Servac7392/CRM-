begin;

create table public.ticket_tables (
    event_id uuid not null,
    department_id uuid not null,
    table_number integer not null check (table_number between 1 and 20),
    reserved_count integer not null default 0 check (reserved_count >= 0),
    sold_count integer not null default 0 check (sold_count >= 0),
    primary key (event_id, department_id, table_number),
    foreign key (event_id, department_id) references public.departments (event_id, id),
    check (reserved_count + sold_count <= 12)
);

insert into public.ticket_tables (event_id, department_id, table_number)
select d.event_id, d.id, n from public.departments d cross join generate_series(1, 20) n
where d.ticket_workspace;

create function crm_private.create_ticket_tables()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    if tg_op = 'UPDATE' and old.ticket_workspace then return new; end if;
    insert into public.ticket_tables (event_id, department_id, table_number)
    select new.event_id, new.id, n from generate_series(1, 20) n on conflict do nothing;
    return new;
end;
$$;
revoke execute on function crm_private.create_ticket_tables() from public, anon, authenticated;
create trigger departments_create_ticket_tables after insert or update of name, ticket_workspace on public.departments
    for each row when (new.ticket_workspace) execute function crm_private.create_ticket_tables();

create table public.ticket_reservations (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null,
    department_id uuid not null,
    table_number integer not null,
    guest_name text not null check (btrim(guest_name) <> '' and char_length(guest_name) <= 200),
    quantity integer not null check (quantity between 1 and 12),
    reserved_until date not null check (isfinite(reserved_until)),
    status text not null default 'reserved' check (status in ('reserved', 'sold', 'released')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (event_id, department_id, table_number, id),
    foreign key (event_id, department_id, table_number) references public.ticket_tables
);
create index ticket_reservations_order_idx on public.ticket_reservations (event_id, department_id, created_at, id);

alter table public.ticket_tables enable row level security;
alter table public.ticket_reservations enable row level security;
revoke all on public.ticket_tables, public.ticket_reservations from public, anon, authenticated;
grant select on public.ticket_tables, public.ticket_reservations to authenticated;
grant insert (id, event_id, department_id, table_number, guest_name, quantity, reserved_until),
    update (status) on public.ticket_reservations to authenticated;

create policy ticket_tables_read on public.ticket_tables for select to authenticated
    using (crm_private.is_member(event_id));
create policy ticket_reservations_read on public.ticket_reservations for select to authenticated
    using (crm_private.is_member(event_id));
create policy ticket_reservations_record on public.ticket_reservations for insert to authenticated
    with check (crm_private.can_record_ticket_activity(event_id, department_id) and status = 'reserved');
create policy ticket_reservations_release on public.ticket_reservations for update to authenticated
    using (crm_private.can_record_ticket_activity(event_id, department_id) and status = 'reserved')
    with check (crm_private.can_record_ticket_activity(event_id, department_id) and status = 'released');

alter table public.ticket_sales
    add column table_number integer,
    add column reservation_id uuid unique,
    add foreign key (event_id, department_id, table_number) references public.ticket_tables,
    add foreign key (event_id, department_id, table_number, reservation_id)
        references public.ticket_reservations (event_id, department_id, table_number, id),
    add check (reservation_id is null or table_number is not null);
create index ticket_sales_table_idx on public.ticket_sales (event_id, department_id, table_number)
    where table_number is not null;
grant insert (table_number, reservation_id) on public.ticket_sales to authenticated;
alter policy ticket_sales_record on public.ticket_sales
    with check (table_number is not null and crm_private.can_record_ticket_activity(event_id, department_id));

-- Both triggers update the same inventory row to serialize changes to each table.
-- Any failed inventory check rolls back the whole reservation or sale.
create function crm_private.ticket_reservation_inventory()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    if tg_op = 'INSERT' then
        if new.reserved_until < (statement_timestamp() at time zone 'Asia/Vladivostok')::date then
            raise exception using errcode = '23514', message = 'ticket_reservation_date_past';
        end if;
        update public.ticket_tables set reserved_count = reserved_count + new.quantity
        where event_id = new.event_id and department_id = new.department_id and table_number = new.table_number
          and reserved_count + sold_count + new.quantity <= 12;
        if not found then
            raise exception using errcode = '23514', message = 'ticket_capacity_exceeded';
        end if;
    elsif old.status = 'reserved' and new.status in ('released', 'sold') then
        update public.ticket_tables set reserved_count = reserved_count - old.quantity
        where event_id = old.event_id and department_id = old.department_id and table_number = old.table_number;
    else
        raise exception using errcode = '23514', message = 'ticket_reservation_inactive';
    end if;
    return null;
end;
$$;
revoke execute on function crm_private.ticket_reservation_inventory() from public, anon, authenticated;
create trigger ticket_reservations_inventory after insert or update of status on public.ticket_reservations
    for each row execute function crm_private.ticket_reservation_inventory();
create trigger ticket_reservations_touch before update on public.ticket_reservations
    for each row execute function crm_private.set_updated_at();
create trigger ticket_reservations_log after insert or update on public.ticket_reservations
    for each row execute function crm_private.log_change();

create function crm_private.ticket_sale_inventory()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    if new.reservation_id is not null then
        update public.ticket_reservations set status = 'sold'
        where id = new.reservation_id and event_id = new.event_id and department_id = new.department_id
          and table_number = new.table_number and quantity = new.quantity and status = 'reserved';
        if not found then
            raise exception using errcode = '23514', message = 'ticket_reservation_inactive';
        end if;
    end if;

    update public.ticket_tables set sold_count = sold_count + new.quantity
    where event_id = new.event_id and department_id = new.department_id and table_number = new.table_number
      and new.quantity <= 12 - reserved_count - sold_count;
    if not found then
        raise exception using errcode = '23514', message = 'ticket_capacity_exceeded';
    end if;
    return null;
end;
$$;
revoke execute on function crm_private.ticket_sale_inventory() from public, anon, authenticated;
create trigger ticket_sales_inventory after insert on public.ticket_sales for each row
    when (new.table_number is not null) execute function crm_private.ticket_sale_inventory();

notify pgrst, 'reload schema';

commit;
