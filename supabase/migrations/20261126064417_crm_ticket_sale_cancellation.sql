begin;

alter table public.ticket_sales add column voided_at timestamptz;

-- A cancelled sale keeps its original table. The same booking may be sold again and moved later.
alter table public.ticket_reservations add constraint ticket_reservations_scoped_id_key unique (event_id, department_id, id);
alter table public.ticket_sales
    drop constraint ticket_sales_event_id_department_id_table_number_reservati_fkey,
    drop constraint ticket_sales_reservation_id_key,
    add constraint ticket_sales_reservation_fkey foreign key (event_id, department_id, reservation_id)
        references public.ticket_reservations (event_id, department_id, id);
create unique index ticket_sales_active_reservation_idx on public.ticket_sales (reservation_id)
    where voided_at is null and reservation_id is not null;
create index ticket_sales_reservation_idx on public.ticket_sales (event_id, department_id, reservation_id);

grant update (voided_at) on public.ticket_sales to authenticated;
alter policy ticket_sales_read on public.ticket_sales using (
    crm_private.is_member(event_id) and (voided_at is null or crm_private.is_coordinator(event_id))
);
alter policy ticket_sales_edit on public.ticket_sales
    using (voided_at is null and crm_private.can_record_ticket_activity(event_id, department_id));

create function crm_private.prepare_ticket_sale_cancellation()
returns trigger language plpgsql set search_path = ''
as $$
begin
    if old.voided_at is not null then
        raise exception using errcode = '23514', message = 'ticket_sale_already_voided';
    end if;
    if new.voided_at is null then return new; end if;
    if not crm_private.is_coordinator(old.event_id) then
        raise exception using errcode = '42501', message = 'ticket_sale_cancellation_forbidden';
    end if;
    if (old.table_number, old.quantity, old.amount, old.payment_method)
        is distinct from (new.table_number, new.quantity, new.amount, new.payment_method) then
        raise exception using errcode = '23514', message = 'ticket_sale_cancellation_with_edit';
    end if;
    new.voided_at := statement_timestamp();
    new.revision := old.revision + 1;
    return new;
end;
$$;
revoke execute on function crm_private.prepare_ticket_sale_cancellation() from public, anon, authenticated;
create trigger ticket_sales_prepare_cancellation before update on public.ticket_sales
    for each row execute function crm_private.prepare_ticket_sale_cancellation();

create or replace function crm_private.ticket_reservation_inventory()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    if tg_op = 'INSERT' or (old.status = 'sold' and new.status = 'reserved') then
        if tg_op = 'INSERT' and new.reserved_until < (statement_timestamp() at time zone 'Asia/Vladivostok')::date then
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

create function crm_private.cancel_ticket_sale_inventory()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    if old.table_number is not null then
        update public.ticket_tables set sold_count = sold_count - old.quantity
        where event_id = old.event_id and department_id = old.department_id and table_number = old.table_number;
    end if;
    if old.reservation_id is not null then
        update public.ticket_reservations set status = 'reserved'
        where id = old.reservation_id and event_id = old.event_id and department_id = old.department_id
          and table_number = old.table_number and quantity = old.quantity and status = 'sold';
        if not found then
            raise exception using errcode = '23514', message = 'ticket_reservation_inactive';
        end if;
    end if;
    return null;
end;
$$;
revoke execute on function crm_private.cancel_ticket_sale_inventory() from public, anon, authenticated;
create trigger ticket_sales_cancel_inventory after update on public.ticket_sales
    for each row when (old.voided_at is null and new.voided_at is not null)
    execute function crm_private.cancel_ticket_sale_inventory();

create or replace function crm_private.log_ticket_sale_edit()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    insert into public.activity_log (event_id, actor_id, entity_type, entity_id, action, changes)
    values (new.event_id, auth.uid(), tg_table_name, new.id, 'update', jsonb_build_object(
        'department_id', new.department_id,
        'before', jsonb_build_object('table_number', old.table_number, 'quantity', old.quantity,
                                    'amount', old.amount, 'payment_method', old.payment_method),
        'after', jsonb_strip_nulls(jsonb_build_object('table_number', new.table_number, 'quantity', new.quantity,
                                    'amount', new.amount, 'payment_method', new.payment_method, 'voided_at', new.voided_at))
    ));
    return null;
end;
$$;

alter policy activity_log_read on public.activity_log using (
    crm_private.is_member(event_id)
    and ((entity_type <> 'finance_expense_payments'
          and (entity_type <> 'ticket_sales' or changes #>> '{after,voided_at}' is null))
         or crm_private.is_coordinator(event_id))
);

create or replace view public.finance_overview with (security_invoker = true) as
select e.id as event_id,
       trunc(sponsors.amount * 100)::text as sponsors_kopecks,
       trunc(tickets.amount * 100)::text as tickets_kopecks,
       trunc(expenses.paid * 100)::text as paid_kopecks,
       trunc(expenses.reserved * 100)::text as reserved_kopecks,
       trunc((sponsors.amount + tickets.amount - expenses.paid) * 100)::text as balance_kopecks,
       trunc((sponsors.amount + tickets.amount - expenses.paid - expenses.reserved) * 100)::text as available_kopecks
from public.events e
cross join lateral (
    select coalesce(sum(s.received_amount), 0) as amount
    from public.sponsors s where s.event_id = e.id and s.payment_status = 'received'
) sponsors
cross join lateral (
    select coalesce(sum(t.amount), 0) as amount from public.ticket_sales t where t.event_id = e.id and t.voided_at is null
) tickets
cross join lateral (
    select coalesce(sum(f.amount) filter (where f.paid_on is not null), 0) as paid,
           coalesce(sum(f.amount) filter (where f.paid_on is null), 0) as reserved
    from public.finance_expenses f where f.event_id = e.id
) expenses
where crm_private.is_coordinator(e.id);

notify pgrst, 'reload schema';

commit;
