begin;

alter table public.event_tabs drop constraint event_tabs_builtin_check;
alter table public.event_tabs add constraint event_tabs_builtin_check
    check (builtin in ('dashboard', 'finance', 'directions', 'tasks', 'team', 'settings'));

create or replace function crm_private.default_event_tabs()
returns table (builtin text, name text)
language sql immutable set search_path = ''
as $$
    values ('dashboard', 'Дашборд'), ('finance', 'Финансы'), ('directions', 'Направления'),
           ('tasks', 'Задачи'), ('team', 'Команда'), ('settings', 'Настройки');
$$;

-- Keep existing custom tabs, even if they already use the name «Финансы».
insert into public.event_tabs (event_id, builtin, name)
select e.id, 'finance', available.name
from public.events e
cross join lateral (
    select candidate.name
    from generate_series(1, (select count(*) + 1 from public.event_tabs where event_id = e.id)) as n(number)
    cross join lateral (select case when n.number = 1 then 'Финансы' else 'Финансы (' || n.number || ')' end as name) candidate
    where not exists (select 1 from public.event_tabs t where t.event_id = e.id and t.name = candidate.name)
    order by n.number
    limit 1
) available;

alter policy event_tabs_read on public.event_tabs using (
    crm_private.is_member(event_id)
    and ((not archived and builtin is distinct from 'settings' and builtin is distinct from 'finance')
         or crm_private.is_coordinator(event_id))
);

create table public.finance_expense_payments (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null references public.events (id),
    card_id uuid not null unique references public.direction_cards (id),
    amount numeric(14, 2) not null check (amount > 0 and amount <> 'NaN'::numeric),
    paid_on date not null check (isfinite(paid_on)),
    payment_method text not null check (payment_method in ('cash', 'cashless')),
    created_at timestamptz not null default now()
);
create index finance_expense_payments_event_idx on public.finance_expense_payments (event_id);

alter table public.finance_expense_payments enable row level security;
revoke all on public.finance_expense_payments from public, anon, authenticated;
grant select on public.finance_expense_payments to authenticated;
grant insert (id, event_id, card_id, amount, paid_on, payment_method) on public.finance_expense_payments to authenticated;

create policy finance_expense_payments_read on public.finance_expense_payments for select to authenticated
    using (crm_private.is_coordinator(event_id));
create policy finance_expense_payments_record on public.finance_expense_payments for insert to authenticated
    with check (crm_private.is_coordinator(event_id));

create function crm_private.check_finance_expense_payment()
returns trigger language plpgsql set search_path = ''
as $$
declare
    reserved_amount numeric(14, 2);
begin
    -- Serialize the payment with changes to the card and its direction.
    select c.amount into reserved_amount
    from public.direction_cards c
    join public.departments d on d.event_id = c.event_id and d.id = c.department_id
    where c.id = new.card_id and c.event_id = new.event_id and c.status = 'agreed'
      and c.amount > 0 and not d.sponsor_workspace
    for share of c, d;

    if reserved_amount is null or new.amount is distinct from reserved_amount then
        raise exception using errcode = '23514', message = 'finance_reserve_changed';
    end if;
    if new.paid_on > (statement_timestamp() at time zone 'Asia/Vladivostok')::date then
        raise exception using errcode = '23514', message = 'finance_payment_date_future';
    end if;
    return null;
end;
$$;
revoke execute on function crm_private.check_finance_expense_payment() from public, anon, authenticated;
create trigger finance_expense_payments_check after insert on public.finance_expense_payments
    for each row execute function crm_private.check_finance_expense_payment();
create trigger finance_expense_payments_log after insert on public.finance_expense_payments
    for each row execute function crm_private.log_change();

alter policy activity_log_read on public.activity_log using (
    crm_private.is_member(event_id)
    and (entity_type <> 'finance_expense_payments' or crm_private.is_coordinator(event_id))
);

create view public.finance_expenses with (security_invoker = true) as
select c.event_id, c.id as card_id, c.department_id, d.name as department_name, c.name as card_name,
       coalesce(p.amount, c.amount) as amount, p.paid_on, p.payment_method
from public.direction_cards c
join public.departments d on d.event_id = c.event_id and d.id = c.department_id
left join public.finance_expense_payments p on p.event_id = c.event_id and p.card_id = c.id
where crm_private.is_coordinator(c.event_id)
  and (p.id is not null or (c.status = 'agreed' and c.amount > 0 and not d.sponsor_workspace));

create view public.finance_overview with (security_invoker = true) as
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
    select coalesce(sum(t.amount), 0) as amount from public.ticket_sales t where t.event_id = e.id
) tickets
cross join lateral (
    select coalesce(sum(f.amount) filter (where f.paid_on is not null), 0) as paid,
           coalesce(sum(f.amount) filter (where f.paid_on is null), 0) as reserved
    from public.finance_expenses f where f.event_id = e.id
) expenses
where crm_private.is_coordinator(e.id);

revoke all on public.finance_overview, public.finance_expenses from public, anon, authenticated;
grant select on public.finance_overview, public.finance_expenses to authenticated;

notify pgrst, 'reload schema';

commit;
