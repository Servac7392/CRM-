begin;

alter table public.departments add column ticket_workspace boolean not null default false;
update public.departments set ticket_workspace = true where lower(btrim(name)) = 'билеты';

create function crm_private.enable_ticket_workspace()
returns trigger language plpgsql set search_path = ''
as $$
begin
    if lower(btrim(new.name)) = 'билеты' then
        new.ticket_workspace := true;
    end if;
    return new;
end;
$$;
revoke execute on function crm_private.enable_ticket_workspace() from public, anon, authenticated;
create trigger departments_enable_ticket_workspace before insert or update of name on public.departments
    for each row execute function crm_private.enable_ticket_workspace();

create function crm_private.can_record_ticket_activity(target_event uuid, target_department uuid)
returns boolean language sql stable set search_path = ''
as $$
    select crm_private.can_manage_department(target_event, target_department) and exists (
        select 1 from public.departments
        where event_id = target_event and id = target_department and ticket_workspace and not archived
    );
$$;
revoke execute on function crm_private.can_record_ticket_activity(uuid, uuid) from public, anon, authenticated;
grant execute on function crm_private.can_record_ticket_activity(uuid, uuid) to authenticated;

create table public.ticket_sales (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null,
    department_id uuid not null,
    quantity integer not null check (quantity > 0),
    amount numeric(14,2) not null check (amount > 0 and amount <> 'NaN'::numeric),
    payment_method text not null check (payment_method in ('cash', 'cashless')),
    created_at timestamptz not null default now(),
    foreign key (event_id, department_id) references public.departments (event_id, id)
);
create index ticket_sales_department_idx on public.ticket_sales (event_id, department_id, created_at, id);

alter table public.ticket_sales enable row level security;
revoke all on public.ticket_sales from public, anon, authenticated;
grant select on public.ticket_sales to authenticated;
grant insert (id, event_id, department_id, quantity, amount, payment_method) on public.ticket_sales to authenticated;

create policy ticket_sales_read on public.ticket_sales for select to authenticated
    using (crm_private.is_member(event_id));
create policy ticket_sales_record on public.ticket_sales for insert to authenticated
    with check (crm_private.can_record_ticket_activity(event_id, department_id));

create trigger ticket_sales_log after insert on public.ticket_sales
    for each row execute function crm_private.log_change();

-- Paths use <event_id>/<department_id>/<uuid>.<extension>. Each upload is a new version.
create function crm_private.can_access_ticket_layout(object_name text, write_access boolean)
returns boolean language plpgsql stable set search_path = ''
as $$
declare
    target_event uuid;
    target_department uuid;
begin
    if object_name !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}[.](pdf|png|jpg|webp)$' then
        return false;
    end if;
    target_event := split_part(object_name, '/', 1)::uuid;
    target_department := split_part(object_name, '/', 2)::uuid;
    if write_access then
        return crm_private.can_record_ticket_activity(target_event, target_department);
    end if;
    return exists (
        select 1 from public.departments
        where event_id = target_event and id = target_department and ticket_workspace
    );
end;
$$;
revoke execute on function crm_private.can_access_ticket_layout(text, boolean) from public, anon, authenticated;
grant execute on function crm_private.can_access_ticket_layout(text, boolean) to authenticated;

create policy crm_ticket_layouts_read on storage.objects for select to authenticated
    using (bucket_id = 'crm-ticket-layouts' and crm_private.can_access_ticket_layout(name, false));
create policy crm_ticket_layouts_upload on storage.objects for insert to authenticated
    with check (bucket_id = 'crm-ticket-layouts' and crm_private.can_access_ticket_layout(name, true));
create policy crm_ticket_layouts_read_boundary on storage.objects as restrictive for select to authenticated
    using (bucket_id is distinct from 'crm-ticket-layouts' or crm_private.can_access_ticket_layout(name, false));
create policy crm_ticket_layouts_upload_boundary on storage.objects as restrictive for insert to authenticated
    with check (bucket_id is distinct from 'crm-ticket-layouts' or crm_private.can_access_ticket_layout(name, true));
create policy crm_ticket_layouts_update_boundary on storage.objects as restrictive for update to anon, authenticated
    using (bucket_id is distinct from 'crm-ticket-layouts')
    with check (bucket_id is distinct from 'crm-ticket-layouts');
create policy crm_ticket_layouts_delete_boundary on storage.objects as restrictive for delete to anon, authenticated
    using (bucket_id is distinct from 'crm-ticket-layouts');
create policy crm_ticket_layouts_anon_read_boundary on storage.objects as restrictive for select to anon
    using (bucket_id is distinct from 'crm-ticket-layouts');
create policy crm_ticket_layouts_anon_upload_boundary on storage.objects as restrictive for insert to anon
    with check (bucket_id is distinct from 'crm-ticket-layouts');

notify pgrst, 'reload schema';

commit;
