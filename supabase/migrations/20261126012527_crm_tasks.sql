-- Проект миграции для согласования. Требует 01-core.sql.
begin;

create table public.tasks (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null,
    department_id uuid not null,
    parent_id uuid,
    title text not null check (btrim(title) <> ''),
    description text,
    owner_id uuid not null,
    status text not null check (status in ('new', 'in_progress', 'decision', 'blocked', 'done', 'cancelled')),
    priority text check (priority in ('low', 'normal', 'high')),
    due_at timestamptz,
    result text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (event_id, id),
    unique (event_id, department_id, id),
    foreign key (event_id, department_id) references public.departments (event_id, id),
    foreign key (event_id, department_id, parent_id) references public.tasks (event_id, department_id, id),
    foreign key (event_id, owner_id) references public.event_members (event_id, user_id),
    check (parent_id is distinct from id)
);

create table public.task_assignees (
    event_id uuid not null,
    task_id uuid not null,
    user_id uuid not null,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (event_id, task_id, user_id),
    foreign key (event_id, task_id) references public.tasks (event_id, id),
    foreign key (event_id, user_id) references public.event_members (event_id, user_id)
);

create table public.task_checklist (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null,
    task_id uuid not null,
    title text not null check (btrim(title) <> ''),
    completed boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (event_id, task_id) references public.tasks (event_id, id)
);

create table public.task_comments (
    id uuid primary key default gen_random_uuid(),
    event_id uuid not null,
    task_id uuid not null,
    author_id uuid not null default auth.uid(),
    body text not null check (btrim(body) <> ''),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (event_id, task_id) references public.tasks (event_id, id),
    foreign key (event_id, author_id) references public.event_members (event_id, user_id)
);

-- Сериализация изменений дерева в пределах мероприятия.
-- При старом снимке одного из двух параллельных изменений PostgreSQL отклоняет запись.
create table crm_private.task_tree_revisions (
    event_id uuid primary key references public.events (id),
    revision bigint not null
);
alter table crm_private.task_tree_revisions enable row level security;

create index tasks_parent_idx on public.tasks (event_id, department_id, parent_id);
create index tasks_owner_idx on public.tasks (event_id, owner_id);
create index tasks_due_idx on public.tasks (event_id, due_at);
create index tasks_status_idx on public.tasks (event_id, status);
create index task_assignees_user_idx on public.task_assignees (event_id, user_id);
create index task_checklist_task_idx on public.task_checklist (event_id, task_id);
create index task_comments_task_idx on public.task_comments (event_id, task_id, created_at);
create index task_comments_author_idx on public.task_comments (event_id, author_id);

create function crm_private.can_manage_task(target_event uuid, target_task uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
    select exists (
        select 1 from public.tasks
        where event_id = target_event and id = target_task
          and crm_private.can_manage_department(event_id, department_id)
    );
$$;

create function crm_private.can_work_on_task(target_event uuid, target_task uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
    select crm_private.can_manage_task(target_event, target_task) or (
        crm_private.is_member(target_event) and exists (
            select 1 from public.task_assignees
            where event_id = target_event and task_id = target_task
              and user_id = (select auth.uid()) and active
        )
    );
$$;

create function crm_private.validate_task()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    if auth.uid() is not null then
        if tg_op = 'INSERT' or new.department_id is distinct from old.department_id then
            if not crm_private.can_manage_department(new.event_id, new.department_id) then
                raise exception using errcode = '42501', message = 'Недостаточно прав для изменения направления задачи';
            end if;
        end if;
    end if;

    if tg_op = 'UPDATE' and auth.uid() is not null
       and not crm_private.can_manage_department(old.event_id, old.department_id) then
        if row(new.department_id, new.parent_id, new.title, new.description,
               new.owner_id, new.priority, new.due_at)
            is distinct from
           row(old.department_id, old.parent_id, old.title, old.description,
               old.owner_id, old.priority, old.due_at)
           or (new.status is distinct from old.status and 'cancelled' in (old.status, new.status))
        then
            raise exception using errcode = '42501', message = 'Недостаточно прав для изменения полей задачи';
        end if;
    end if;

    if tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id then
        if not exists (
            select 1 from public.event_members
            where event_id = new.event_id and user_id = new.owner_id and active
        ) then
            raise exception using errcode = '23514', message = 'Ответственный должен быть активным участником мероприятия';
        end if;
    end if;

    if new.parent_id is not null and (
        tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id
        or new.department_id is distinct from old.department_id
    ) then
        insert into crm_private.task_tree_revisions as tree (event_id, revision)
        values (new.event_id, 1)
        on conflict (event_id) do update set revision = tree.revision + 1;

        if exists (
            with recursive ancestors (id, parent_id) as (
                select id, parent_id from public.tasks
                where event_id = new.event_id and id = new.parent_id
                union
                select task.id, task.parent_id from public.tasks task
                join ancestors on ancestors.parent_id = task.id
                where task.event_id = new.event_id
            )
            select 1 from ancestors where id = new.id
        ) then
            raise exception using errcode = '23514', message = 'Циклическая вложенность задач недопустима';
        end if;
    end if;
    return new;
end;
$$;

create function crm_private.validate_task_assignee()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
    if auth.uid() is not null and not crm_private.can_manage_task(new.event_id, new.task_id) then
        raise exception using errcode = '42501', message = 'Недостаточно прав для назначения соисполнителя';
    end if;
    if new.active and not exists (
        select 1 from public.event_members
        where event_id = new.event_id and user_id = new.user_id and active
    ) then
        raise exception using errcode = '23514', message = 'Соисполнитель должен быть активным участником мероприятия';
    end if;
    return new;
end;
$$;

revoke execute on function crm_private.can_manage_task(uuid, uuid),
    crm_private.can_work_on_task(uuid, uuid), crm_private.validate_task(),
    crm_private.validate_task_assignee() from public, anon, authenticated;
grant execute on function crm_private.can_manage_task(uuid, uuid),
    crm_private.can_work_on_task(uuid, uuid) to authenticated;

alter table public.tasks enable row level security;
alter table public.task_assignees enable row level security;
alter table public.task_checklist enable row level security;
alter table public.task_comments enable row level security;

revoke all on public.tasks, public.task_assignees, public.task_checklist,
    public.task_comments from public, anon, authenticated;
grant select on public.tasks, public.task_assignees, public.task_checklist,
    public.task_comments to authenticated;
grant insert (event_id, department_id, parent_id, title, description, owner_id, status, priority, due_at, result),
    update (department_id, parent_id, title, description, owner_id, status, priority, due_at, result)
    on public.tasks to authenticated;
grant insert (event_id, task_id, user_id, active), update (active) on public.task_assignees to authenticated;
grant insert (event_id, task_id, title, completed), update (title, completed)
    on public.task_checklist to authenticated;
grant insert (event_id, task_id, body) on public.task_comments to authenticated;

create policy tasks_read on public.tasks for select to authenticated
    using (crm_private.is_member(event_id));
create policy tasks_add on public.tasks for insert to authenticated
    with check (crm_private.can_manage_department(event_id, department_id));
create policy tasks_edit on public.tasks for update to authenticated
    using (crm_private.can_work_on_task(event_id, id))
    with check (
        crm_private.can_manage_department(event_id, department_id)
        or crm_private.can_work_on_task(event_id, id)
    );

create policy task_assignees_read on public.task_assignees for select to authenticated
    using (crm_private.is_member(event_id));
create policy task_assignees_add on public.task_assignees for insert to authenticated
    with check (crm_private.can_manage_task(event_id, task_id));
create policy task_assignees_edit on public.task_assignees for update to authenticated
    using (crm_private.can_manage_task(event_id, task_id))
    with check (crm_private.can_manage_task(event_id, task_id));

create policy task_checklist_read on public.task_checklist for select to authenticated
    using (crm_private.is_member(event_id));
create policy task_checklist_add on public.task_checklist for insert to authenticated
    with check (crm_private.can_work_on_task(event_id, task_id));
create policy task_checklist_edit on public.task_checklist for update to authenticated
    using (crm_private.can_work_on_task(event_id, task_id))
    with check (crm_private.can_work_on_task(event_id, task_id));

create policy task_comments_read on public.task_comments for select to authenticated
    using (crm_private.is_member(event_id));
create policy task_comments_add on public.task_comments for insert to authenticated
    with check (author_id = (select auth.uid()) and crm_private.can_work_on_task(event_id, task_id));

create trigger tasks_validate before insert or update on public.tasks
    for each row execute function crm_private.validate_task();
create trigger task_assignees_validate before insert or update on public.task_assignees
    for each row execute function crm_private.validate_task_assignee();

create trigger tasks_touch before update on public.tasks
    for each row execute function crm_private.set_updated_at();
create trigger task_assignees_touch before update on public.task_assignees
    for each row execute function crm_private.set_updated_at();
create trigger task_checklist_touch before update on public.task_checklist
    for each row execute function crm_private.set_updated_at();

create trigger tasks_log after insert or update on public.tasks
    for each row execute function crm_private.log_change();
create trigger task_assignees_log after insert or update on public.task_assignees
    for each row execute function crm_private.log_change();
create trigger task_checklist_log after insert or update on public.task_checklist
    for each row execute function crm_private.log_change();
create trigger task_comments_log after insert on public.task_comments
    for each row execute function crm_private.log_change();

commit;
