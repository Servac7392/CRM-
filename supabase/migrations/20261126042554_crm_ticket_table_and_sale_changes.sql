begin;

alter table public.ticket_tables drop constraint ticket_tables_table_number_check;
alter table public.ticket_tables add constraint ticket_tables_table_number_check check (table_number > 0);
alter table public.ticket_tables add column request_id uuid unique;

grant insert (event_id, department_id, request_id) on public.ticket_tables to authenticated;
create policy ticket_tables_add on public.ticket_tables for insert to authenticated
    with check (request_id is not null and crm_private.can_record_ticket_activity(event_id, department_id));

create function crm_private.assign_ticket_table_number()
returns trigger language plpgsql set search_path = ''
as $$
begin
    if not crm_private.can_record_ticket_activity(new.event_id, new.department_id) then
        raise exception using errcode = '42501', message = 'ticket_table_add_forbidden';
    end if;
    -- Serialize numbering within one department. Existing tables retain their numbers.
    perform pg_advisory_xact_lock(hashtextextended('crm.ticket_tables/' || new.department_id::text, 0));
    select coalesce(max(table_number), 0) + 1 into new.table_number
    from public.ticket_tables where event_id = new.event_id and department_id = new.department_id;
    return new;
end;
$$;
revoke execute on function crm_private.assign_ticket_table_number() from public, anon, authenticated;
create trigger ticket_tables_assign_number before insert on public.ticket_tables
    for each row when (new.table_number is null) execute function crm_private.assign_ticket_table_number();

alter table public.ticket_sales add column revision integer not null default 0;
-- The sale and its sold reservation may move together before the foreign key is checked.
alter table public.ticket_sales alter constraint ticket_sales_event_id_department_id_table_number_reservati_fkey
    deferrable initially deferred;

grant update (table_number, quantity, amount, payment_method) on public.ticket_sales to authenticated;
create policy ticket_sales_edit on public.ticket_sales for update to authenticated
    using (crm_private.can_record_ticket_activity(event_id, department_id))
    with check (crm_private.can_record_ticket_activity(event_id, department_id));

create function crm_private.bump_ticket_sale_revision()
returns trigger language plpgsql set search_path = ''
as $$
begin
    new.revision := old.revision + 1;
    return new;
end;
$$;
revoke execute on function crm_private.bump_ticket_sale_revision() from public, anon, authenticated;
create trigger ticket_sales_bump_revision before update on public.ticket_sales for each row
    when ((old.table_number, old.quantity, old.amount, old.payment_method)
          is distinct from (new.table_number, new.quantity, new.amount, new.payment_method))
    execute function crm_private.bump_ticket_sale_revision();

create function crm_private.adjust_ticket_sale_inventory()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    if new.table_number is null and old.table_number is not null then
        raise exception using errcode = '23514', message = 'ticket_table_required';
    end if;

    -- Lock both rows in the same order for transfers in either direction.
    perform 1 from public.ticket_tables
    where event_id = new.event_id and department_id = new.department_id
      and table_number in (old.table_number, new.table_number)
    order by table_number for no key update;

    if old.table_number is not null then
        update public.ticket_tables set sold_count = sold_count - old.quantity
        where event_id = old.event_id and department_id = old.department_id and table_number = old.table_number;
    end if;
    if new.table_number is not null then
        update public.ticket_tables set sold_count = sold_count + new.quantity
        where event_id = new.event_id and department_id = new.department_id and table_number = new.table_number
          and new.quantity <= 12 - reserved_count - sold_count;
        if not found then
            raise exception using errcode = '23514', message = 'ticket_capacity_exceeded';
        end if;
    end if;
    if old.reservation_id is not null then
        update public.ticket_reservations set table_number = new.table_number, quantity = new.quantity
        where id = old.reservation_id and event_id = old.event_id and department_id = old.department_id
          and table_number = old.table_number and quantity = old.quantity and status = 'sold';
        if not found then
            raise exception using errcode = '23514', message = 'ticket_reservation_inactive';
        end if;
    end if;
    return null;
end;
$$;
revoke execute on function crm_private.adjust_ticket_sale_inventory() from public, anon, authenticated;
create trigger ticket_sales_adjust_inventory after update on public.ticket_sales for each row
    when ((old.table_number, old.quantity) is distinct from (new.table_number, new.quantity))
    execute function crm_private.adjust_ticket_sale_inventory();

create function crm_private.log_ticket_sale_edit()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    insert into public.activity_log (event_id, actor_id, entity_type, entity_id, action, changes)
    values (new.event_id, auth.uid(), tg_table_name, new.id, 'update', jsonb_build_object(
        'department_id', new.department_id,
        'before', jsonb_build_object('table_number', old.table_number, 'quantity', old.quantity,
                                    'amount', old.amount, 'payment_method', old.payment_method),
        'after', jsonb_build_object('table_number', new.table_number, 'quantity', new.quantity,
                                   'amount', new.amount, 'payment_method', new.payment_method)
    ));
    return null;
end;
$$;
revoke execute on function crm_private.log_ticket_sale_edit() from public, anon, authenticated;
create trigger ticket_sales_log_edit after update on public.ticket_sales for each row
    when (old.revision is distinct from new.revision) execute function crm_private.log_ticket_sale_edit();

notify pgrst, 'reload schema';

commit;
