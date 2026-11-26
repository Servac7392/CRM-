begin;

alter table public.tasks
    add column amount numeric(14, 2) check (amount >= 0 and amount <= 999999999999.99),
    add column amount_kind text not null default 'expense' check (amount_kind in ('expense', 'income'));

grant insert (amount, amount_kind), update (amount, amount_kind) on public.tasks to authenticated;

-- An active task owner can edit the amount even without an assignee record.
create policy tasks_edit_amount_as_owner on public.tasks for update to authenticated
    using (owner_id = (select auth.uid()) and crm_private.is_member(event_id))
    with check (owner_id = (select auth.uid()) and crm_private.is_member(event_id));

create function crm_private.validate_task_amount_owner_edit()
returns trigger language plpgsql set search_path = ''
as $$
begin
    if not crm_private.can_work_on_task(old.event_id, old.id)
        and (to_jsonb(new) - array['amount', 'amount_kind', 'updated_at'])
            is distinct from (to_jsonb(old) - array['amount', 'amount_kind', 'updated_at']) then
        raise exception using errcode = '42501', message = 'Недостаточно прав для изменения полей задачи';
    end if;
    return new;
end;
$$;
revoke execute on function crm_private.validate_task_amount_owner_edit() from public, anon, authenticated;
create trigger tasks_validate_amount_owner_edit before update on public.tasks for each row
    when (old.owner_id = auth.uid()) execute function crm_private.validate_task_amount_owner_edit();

create view public.finance_task_plan with (security_invoker = true) as
select e.id as event_id, plan.income_kopecks, plan.expense_kopecks
from public.events e
cross join lateral (
    -- A task amount covers its branch. Descend only when there is no amount to count.
    with recursive task_plan (id, department_id, amount, amount_kind) as (
        select t.id, t.department_id, case when t.status <> 'cancelled' then t.amount end, t.amount_kind
        from public.tasks t where t.event_id = e.id and t.parent_id is null
        union all
        select t.id, t.department_id, case when t.status <> 'cancelled' then t.amount end, t.amount_kind
        from task_plan parent
        join public.tasks t on t.event_id = e.id and t.department_id = parent.department_id and t.parent_id = parent.id
        where parent.amount is null
    )
    select trunc(coalesce(sum(amount) filter (where amount_kind = 'income'), 0) * 100)::text as income_kopecks,
           trunc(coalesce(sum(amount) filter (where amount_kind = 'expense'), 0) * 100)::text as expense_kopecks
    from task_plan
) plan
where crm_private.is_coordinator(e.id);

revoke all on public.finance_task_plan from public, anon, authenticated;
grant select on public.finance_task_plan to authenticated;

notify pgrst, 'reload schema';

commit;
