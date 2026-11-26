-- Запускать одной сессией на отдельном тестовом экземпляре после 01–03.
-- Фикстуры и тестовые политики исчезают после ROLLBACK.
begin;

create function pg_temp.expect_count(query text, expected bigint, scenario text)
returns void language plpgsql as $$
declare actual bigint;
begin
    execute query into actual;
    if actual is distinct from expected then
        raise exception '%: ожидалось %, получено %', scenario, expected, actual;
    end if;
    raise notice 'OK: %', scenario;
end;
$$;

create function pg_temp.expect_error(query text, expected text, scenario text)
returns void language plpgsql as $$
begin
    begin
        execute query;
    exception when others then
        if sqlstate <> expected then
            raise exception '%: ожидался SQLSTATE %, получен % (%)', scenario, expected, sqlstate, sqlerrm;
        end if;
        raise notice 'OK: %', scenario;
        return;
    end;
    raise exception '%: ожидалась ошибка %', scenario, expected;
end;
$$;

insert into auth.users (id, email) values
    ('00000000-0000-4000-8000-000000000001', 'coord-a@example.invalid'),
    ('00000000-0000-4000-8000-000000000002', 'lead-a@example.invalid'),
    ('00000000-0000-4000-8000-000000000003', 'helper-a@example.invalid'),
    ('00000000-0000-4000-8000-000000000004', 'inactive-a@example.invalid'),
    ('00000000-0000-4000-8000-000000000005', 'coord-b@example.invalid');

insert into public.profiles (id, display_name)
select id, email from auth.users where email in (
    'coord-a@example.invalid', 'lead-a@example.invalid', 'helper-a@example.invalid',
    'inactive-a@example.invalid', 'coord-b@example.invalid'
);

insert into public.events (id, name, starts_at, status, created_by) values
    ('00000000-0000-4000-8000-0000000000a1', 'Тест A', '2027-02-06 18:00:00+10', 'planned', '00000000-0000-4000-8000-000000000001'),
    ('00000000-0000-4000-8000-0000000000b1', 'Тест B', '2027-02-07 18:00:00+10', 'active', '00000000-0000-4000-8000-000000000005');

insert into public.event_members (event_id, user_id, role, active) values
    ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001', 'coordinator', true),
    ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000002', 'member', true),
    ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000003', 'member', true),
    ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000004', 'member', false),
    ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000005', 'coordinator', true);

insert into public.departments (id, event_id, name) values
    ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a1', 'Концерт'),
    ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-0000000000a1', 'Ресторан'),
    ('00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000b1', 'Билеты');

insert into public.department_members (event_id, department_id, user_id) values
    ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000002');

insert into public.tasks (id, event_id, department_id, title, owner_id, status) values
    ('00000000-0000-4000-8000-0000000000a4', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2',
        'Программа', '00000000-0000-4000-8000-000000000002', 'new'),
    ('00000000-0000-4000-8000-0000000000a5', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2',
        'Репетиция', '00000000-0000-4000-8000-000000000002', 'new'),
    ('00000000-0000-4000-8000-0000000000a6', '00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a3',
        'Меню', '00000000-0000-4000-8000-000000000001', 'new'),
    ('00000000-0000-4000-8000-0000000000b3', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2',
        'Категории', '00000000-0000-4000-8000-000000000005', 'new');

update public.tasks set parent_id = '00000000-0000-4000-8000-0000000000a4'
where id = '00000000-0000-4000-8000-0000000000a5';

insert into public.task_assignees (event_id, task_id, user_id) values
    ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a5', '00000000-0000-4000-8000-000000000003'),
    ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a6', '00000000-0000-4000-8000-000000000002');

insert into storage.objects (bucket_id, name) values (
    'crm-task-files', '00000000-0000-4000-8000-0000000000a1/00000000-0000-4000-8000-0000000000a6/00000000-0000-4000-8000-000000000010'
);

-- Имитируем общее разрешение другого приложения: границы CRM всё равно действуют.
create policy crm_test_other_storage_policy on storage.objects for all to anon, authenticated
    using (true) with check (true);

set local role anon;
select pg_temp.expect_error('select * from public.events', '42501', 'анонимный доступ к событиям закрыт');
select pg_temp.expect_error('select * from public.tasks', '42501', 'анонимный доступ к задачам закрыт');
select pg_temp.expect_count('select count(*) from storage.objects where bucket_id = ''crm-task-files''', 0, 'аноним не видит файлы');

set local role authenticated;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000005"}';
select pg_temp.expect_count('select count(*) from public.events where name = ''Тест A''', 0, 'координатор другого события не читает событие');
select pg_temp.expect_count('select count(*) from public.tasks where title in (''Программа'', ''Репетиция'', ''Меню'')', 0, 'задачи другого события скрыты');
select pg_temp.expect_count('select count(*) from public.profiles where display_name = ''lead-a@example.invalid''', 0, 'профиль другого события скрыт');
select pg_temp.expect_count('select count(*) from storage.objects where bucket_id = ''crm-task-files''', 0, 'файлы другого события скрыты');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000004"}';
select pg_temp.expect_count('select count(*) from public.events where name = ''Тест A''', 0, 'неактивный пользователь теряет доступ');
select pg_temp.expect_count('select count(*) from public.activity_log where event_id = ''00000000-0000-4000-8000-0000000000a1''', 0, 'неактивный пользователь не видит журнал');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000002"}';
select pg_temp.expect_count('select count(*) from public.departments where event_id = ''00000000-0000-4000-8000-0000000000a1''', 2, 'руководитель читает оба направления');
select pg_temp.expect_count($q$with edited as (update public.departments set name = 'Концерт обновлён'
    where name = 'Концерт' returning 1) select count(*) from edited$q$, 0, 'руководитель направления не переименовывает раздел');
select pg_temp.expect_count($q$with edited as (update public.departments set name = 'Чужое'
    where name = 'Ресторан' returning 1) select count(*) from edited$q$, 0, 'руководитель не меняет чужое направление');
select pg_temp.expect_count($q$with added as (insert into public.tasks (event_id, department_id, title, owner_id, status)
    values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2',
            'Тест создания', '00000000-0000-4000-8000-000000000002', 'new') returning 1)
    select count(*) from added$q$, 1, 'руководитель создаёт задачу в своём направлении');
select pg_temp.expect_error($q$update public.tasks set title = 'Чужое меню' where title = 'Меню'$q$,
    '42501', 'руководитель как соисполнитель чужой задачи не меняет её название');
select pg_temp.expect_error($q$update public.tasks set department_id = '00000000-0000-4000-8000-0000000000a3'
    where title = 'Тест создания'$q$, '42501', 'руководитель не переносит задачу в чужое направление');
select pg_temp.expect_error($q$update public.tasks set parent_id = '00000000-0000-4000-8000-0000000000a5'
    where title = 'Программа'$q$, '23514', 'запрет циклической вложенности');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000003"}';
select pg_temp.expect_count($q$with edited as (update public.tasks set status = 'in_progress', result = 'Готов черновик'
    where title = 'Репетиция' returning 1) select count(*) from edited$q$, 1, 'соисполнитель меняет статус и результат');
select pg_temp.expect_count($q$select count(*) from public.tasks where title = 'Репетиция'
    and owner_id = '00000000-0000-4000-8000-000000000002'$q$, 1, 'основной ответственный сохраняется');
select pg_temp.expect_error($q$update public.tasks set owner_id = '00000000-0000-4000-8000-000000000003'
    where title = 'Репетиция'$q$, '42501', 'соисполнитель не меняет ответственного');
select pg_temp.expect_error($q$update public.tasks set status = 'cancelled'
    where title = 'Репетиция'$q$, '42501', 'соисполнитель не отменяет задачу');
select pg_temp.expect_count($q$with edited as (update public.tasks set status = 'done'
    where title = 'Программа' returning 1) select count(*) from edited$q$, 0, 'назначение не даёт права на родительскую задачу');
select pg_temp.expect_error($q$update public.event_members set role = 'coordinator' where user_id = auth.uid()$q$,
    '42501', 'участник не повышает себе роль');
select pg_temp.expect_error($q$insert into public.task_assignees (event_id, task_id, user_id)
    values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a6', auth.uid())$q$,
    '42501', 'участник не назначает себя на чужую задачу');
select pg_temp.expect_count($q$with added as (insert into public.task_checklist (event_id, task_id, title, completed)
    values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a5', 'Тест', true) returning 1)
    select count(*) from added$q$, 1, 'соисполнитель ведёт чек-лист своей задачи');
select pg_temp.expect_count($q$with added as (insert into public.task_comments (event_id, task_id, body)
    values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a5', 'Тест') returning author_id)
    select count(*) from added where author_id = auth.uid()$q$, 1, 'автор комментария установлен сервером');
select pg_temp.expect_count('select count(*) from storage.objects where bucket_id = ''crm-task-files''', 1, 'участник читает вложение своей команды');
select pg_temp.expect_count($q$with added as (insert into storage.objects (bucket_id, name)
    values ('crm-task-files', '00000000-0000-4000-8000-0000000000a1/00000000-0000-4000-8000-0000000000a5/00000000-0000-4000-8000-000000000011')
    returning 1) select count(*) from added$q$, 1, 'соисполнитель добавляет вложение в назначенную задачу');
select pg_temp.expect_error($q$insert into storage.objects (bucket_id, name)
    values ('crm-task-files', '00000000-0000-4000-8000-0000000000a1/00000000-0000-4000-8000-0000000000a6/00000000-0000-4000-8000-000000000012')$q$,
    '42501', 'соисполнитель не загружает файл в чужую задачу');
select pg_temp.expect_error($q$insert into storage.objects (bucket_id, name)
    values ('crm-task-files', 'неверный-путь')$q$, '42501', 'неправильный путь закрыт политикой Storage');
select pg_temp.expect_error($q$insert into storage.objects (bucket_id, name)
    values ('crm-task-files', '00000000-0000-4000-8000-0000000000b1/00000000-0000-4000-8000-0000000000a5/00000000-0000-4000-8000-000000000012')$q$,
    '42501', 'для вложения нельзя подменить мероприятие');
do $$
declare removed_count bigint;
begin
    begin
        with removed as (delete from storage.objects where bucket_id = 'crm-task-files' returning 1)
        select count(*) into removed_count from removed;
    exception when others then
        -- Actual Supabase Storage can reject direct deletion before it evaluates RLS.
        if sqlstate <> '42501' and sqlerrm not like 'Direct deletion from storage tables is not allowed.%' then
            raise;
        end if;
        removed_count := 0;
    end;
    if removed_count <> 0 then
        raise exception 'Физическое удаление вложений доступно';
    end if;
    raise notice 'OK: вложения защищены от прямого удаления';
end;
$$;
select pg_temp.expect_error($q$delete from public.tasks where title = 'Репетиция'$q$, '42501', 'физическое удаление задач недоступно');
select pg_temp.expect_error($q$update public.activity_log set changes = '{}'::jsonb$q$, '42501', 'журнал нельзя редактировать с клиента');
select pg_temp.expect_count($q$select count(*) from public.activity_log where actor_id = auth.uid()
    and entity_type = 'tasks' and action = 'update' and changes ->> 'status_after' = 'in_progress'$q$,
    1, 'сервер записал автора и смену статуса');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.expect_count($q$with edited as (update public.tasks set status = 'decision'
    where title = 'Меню' returning 1) select count(*) from edited$q$, 1, 'координатор редактирует задачу любого направления своего события');
select pg_temp.expect_error($q$update public.tasks set parent_id = '00000000-0000-4000-8000-0000000000b3'
    where title = 'Программа'$q$, '23503', 'связь задач между мероприятиями запрещена');
select pg_temp.expect_count($q$with edited as (update public.event_members set active = false
    where user_id = '00000000-0000-4000-8000-000000000003' returning 1) select count(*) from edited$q$,
    1, 'координатор деактивирует участника своего события');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000003"}';
select pg_temp.expect_count($q$select count(*) from public.tasks where title = 'Репетиция'$q$,
    0, 'после деактивации прежнее назначение не даёт доступа');

select pg_temp.expect_error($q$select public.crm_enroll_invited_member(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1',
    'invitee@example.invalid', 'Приглашённый', null)$q$,
    '42501', 'клиентский JWT не может вызвать служебную функцию и подменить координатора');

reset role;
insert into auth.users (id, email) values ('00000000-0000-4000-8000-000000000006', 'invitee@example.invalid');
set local role service_role;
select pg_temp.expect_count($q$select count(*) where public.crm_enroll_invited_member(
    '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-0000000000a1',
    'invitee@example.invalid', 'Приглашённый', null) = 'forbidden'$q$,
    1, 'руководитель направления не может приглашать');
select pg_temp.expect_count($q$select count(*) where public.crm_enroll_invited_member(
    '00000000-0000-4000-8000-000000000005', '00000000-0000-4000-8000-0000000000a1',
    'invitee@example.invalid', 'Приглашённый', null) = 'forbidden'$q$,
    1, 'координатор не может приглашать в чужое мероприятие');
select pg_temp.expect_count($q$select count(*) where public.crm_enroll_invited_member(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1',
    'invitee@example.invalid', 'Приглашённый', '00000000-0000-4000-8000-000000000005') = 'missing'$q$,
    1, 'UID из Auth должен соответствовать адресу приглашения');
select pg_temp.expect_count($q$select count(*) where public.crm_enroll_invited_member(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1',
    'invitee@example.invalid', 'Приглашённый', '00000000-0000-4000-8000-000000000006') = 'added'$q$,
    1, 'координатор добавляет пользователя по почте');
select pg_temp.expect_count($q$select count(*) where public.crm_enroll_invited_member(
    '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000a1',
    'invitee@example.invalid', 'Другое имя', null) = 'already_member'$q$,
    1, 'повторное добавление не создаёт дубль');

set local role authenticated;
set local request.jwt.claim.sub = '';
set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.expect_count($q$select count(*) from public.event_members m
    join public.profiles p on p.id = m.user_id
    where m.event_id = '00000000-0000-4000-8000-0000000000a1' and m.active and m.role = 'member'
    and p.id = '00000000-0000-4000-8000-000000000006' and p.display_name = 'Приглашённый'$q$,
    1, 'профиль создаётся автоматически и сохраняет имя при повторе');
select pg_temp.expect_count($q$select count(*) from public.activity_log
    where event_id = '00000000-0000-4000-8000-0000000000a1'
    and actor_id = '00000000-0000-4000-8000-000000000001' and action = 'insert'
    and entity_type = 'event_members' and entity_id = '00000000-0000-4000-8000-000000000006'$q$,
    1, 'журнал сохраняет координатора как автора добавления');

select pg_temp.expect_count($q$select count(*) from public.event_tabs
    where event_id = '00000000-0000-4000-8000-0000000000a1'$q$,
    6, 'при создании мероприятия появляются шесть стандартных вкладок');
select pg_temp.expect_count($q$with added as (
    insert into public.departments (event_id, name)
    values ('00000000-0000-4000-8000-0000000000a1', 'Новый раздел') returning 1
) select count(*) from added$q$, 1, 'координатор создаёт направление');
select pg_temp.expect_count($q$with edited as (
    update public.departments set name = 'Рабочий концерт', archived = true
    where id = '00000000-0000-4000-8000-0000000000a2' returning 1
) select count(*) from edited$q$, 1, 'координатор переименовывает и архивирует направление');
select pg_temp.expect_count($q$select count(*) from public.tasks where title = 'Репетиция'
    and department_id = '00000000-0000-4000-8000-0000000000a2'$q$,
    1, 'архивация направления сохраняет задачи и связи');
select pg_temp.expect_error($q$insert into public.tasks (event_id, department_id, title, owner_id, status)
    values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2',
        'Новая архивная задача', '00000000-0000-4000-8000-000000000001', 'new')$q$,
    '23514', 'новые задачи нельзя добавлять в архивное направление');
select pg_temp.expect_count($q$with edited as (
    update public.tasks set result = 'Архивная история' where title = 'Репетиция' returning 1
) select count(*) from edited$q$, 1, 'существующая задача доступна в архивном направлении');
select pg_temp.expect_count($q$with added as (
    insert into public.event_tabs (event_id, name, body)
    values ('00000000-0000-4000-8000-0000000000a1', 'Памятка', 'Текст памятки') returning 1
) select count(*) from added$q$, 1, 'координатор создаёт текстовую вкладку');
select pg_temp.expect_count($q$with edited as (update public.event_tabs set name = 'Рабочие задачи'
    where builtin = 'tasks' returning 1) select count(*) from edited$q$,
    1, 'координатор меняет название стандартной вкладки в своём мероприятии');
select pg_temp.expect_count($q$with edited as (update public.event_tabs set archived = true
    where name = 'Памятка' returning 1) select count(*) from edited$q$, 1, 'координатор архивирует текстовую вкладку');
select pg_temp.expect_error($q$delete from public.event_tabs where name = 'Памятка'$q$,
    '42501', 'физическое удаление вкладок из клиента закрыто');
select pg_temp.expect_error($q$delete from public.departments where name = 'Новый раздел'$q$,
    '42501', 'физическое удаление направлений из клиента закрыто');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000002"}';
select pg_temp.expect_count($q$select count(*) from public.event_tabs where name = 'Памятка'$q$,
    0, 'архивный текст недоступен руководителю направления');
select pg_temp.expect_count($q$select count(*) from public.event_tabs where builtin = 'settings'$q$,
    0, 'вкладка настроек доступна только координатору');
select pg_temp.expect_count($q$with edited as (update public.departments set archived = false
    where name = 'Рабочий концерт' returning 1) select count(*) from edited$q$,
    0, 'руководитель не может восстановить направление');
select pg_temp.expect_count($q$with edited as (update public.event_tabs set archived = true
    where name = 'Рабочие задачи' returning 1) select count(*) from edited$q$,
    0, 'руководитель не может архивировать вкладку');
select pg_temp.expect_error($q$insert into public.event_tabs (event_id, name)
    values ('00000000-0000-4000-8000-0000000000a1', 'Чужая вкладка')$q$,
    '42501', 'руководитель не может создавать вкладки');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.expect_count($q$with edited as (update public.departments set archived = false
    where name = 'Рабочий концерт' returning 1) select count(*) from edited$q$,
    1, 'координатор восстанавливает направление');
select pg_temp.expect_count($q$with edited as (update public.event_tabs set archived = false
    where name = 'Памятка' and body = 'Текст памятки' returning 1) select count(*) from edited$q$,
    1, 'после восстановления вкладки её текст сохранён');

reset role;
insert into public.departments (id, event_id, name)
values ('00000000-0000-4000-8000-0000000000a7', '00000000-0000-4000-8000-0000000000a1', 'Спонсоры');
insert into public.department_members (event_id, department_id, user_id)
values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a7', '00000000-0000-4000-8000-000000000002');

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000002"}';
select pg_temp.expect_count($q$select count(*) from public.departments where name = 'Спонсоры' and sponsor_workspace$q$,
    1, 'у направления «Спонсоры» автоматически появляется рабочее место');
select pg_temp.expect_count($q$with added as (
    insert into public.sponsors (event_id, department_id, company, contact_name, owner_id)
    values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a7',
        'Компания А', 'Первый контакт', '00000000-0000-4000-8000-000000000006')
    returning status, payment_status
) select count(*) from added where status = 'new' and payment_status = 'not_received'$q$,
    1, 'руководитель заводит спонсора с двумя начальными статусами и ответственным');
select pg_temp.expect_count($q$with added as (
    insert into public.sponsors (event_id, department_id, company)
    values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a7', 'Компания Б')
    returning 1
) select count(*) from added$q$, 1, 'компанию можно добавить до назначения ответственного');
select pg_temp.expect_error($q$update public.sponsors
    set owner_id = '00000000-0000-4000-8000-000000000004' where company = 'Компания Б'$q$,
    '23514', 'руководитель не может назначить неактивного участника');
select pg_temp.expect_error($q$update public.sponsors
    set owner_id = '00000000-0000-4000-8000-000000000005' where company = 'Компания Б'$q$,
    '23514', 'руководитель не может назначить участника чужого мероприятия');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000006"}';
select pg_temp.expect_count($q$select count(*) from public.sponsors where company in ('Компания А', 'Компания Б')$q$,
    2, 'участник может читать список спонсоров своего мероприятия');
select pg_temp.expect_count($q$with edited as (
    update public.sponsors set contact_name = 'Новый контакт', status = 'discussed', payment_status = 'received'
    where company = 'Компания А' returning 1
) select count(*) from edited$q$, 1, 'ответственный обновляет контакт и оба статуса своего спонсора');
select pg_temp.expect_count($q$with edited as (
    update public.sponsors set pledged_amount = 12500.50, received_amount = 6000.25
    where company = 'Компания А' returning pledged_amount, received_amount
) select count(*) from edited where pledged_amount = 12500.50 and received_amount = 6000.25$q$,
    1, 'ответственный вносит обещанную и полученную суммы с копейками');
select pg_temp.expect_error($q$update public.sponsors set pledged_amount = -1 where company = 'Компания А'$q$,
    '23514', 'отрицательная сумма обещания запрещена');
select pg_temp.expect_error($q$update public.sponsors set received_amount = 'NaN' where company = 'Компания А'$q$,
    '23514', 'некорректное числовое значение полученной суммы отклоняется');
select pg_temp.expect_error($q$update public.sponsors set payment_status = 'not_received' where company = 'Компания А'$q$,
    '23514', 'полученная сумма требует отметки о поступлении');
select pg_temp.expect_count($q$with edited as (
    update public.sponsors set pledged_amount = 200 where company = 'Компания Б' returning 1
) select count(*) from edited$q$, 0, 'ответственный не меняет сумму чужого спонсора');
select pg_temp.expect_error($q$update public.sponsors set company = 'Переименование' where company = 'Компания А'$q$,
    '42501', 'ответственный не переименовывает компанию');
select pg_temp.expect_error($q$update public.sponsors set owner_id = null where company = 'Компания А'$q$,
    '42501', 'ответственный не меняет назначение');
select pg_temp.expect_count($q$with edited as (
    update public.sponsors set status = 'declined' where company = 'Компания Б' returning 1
) select count(*) from edited$q$, 0, 'ответственный не меняет чужую карточку в том же направлении');
select pg_temp.expect_error($q$insert into public.sponsors (event_id, department_id, company)
    values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a7', 'Компания В')$q$,
    '42501', 'назначение спонсора не даёт права создавать дополнительные карточки');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000005"}';
select pg_temp.expect_count($q$select count(*) from public.sponsors where company in ('Компания А', 'Компания Б')$q$,
    0, 'координатор другого мероприятия не видит спонсоров');
select pg_temp.expect_error($q$insert into public.sponsors (event_id, department_id, company)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 'Компания В')$q$,
    '42501', 'карточки спонсоров создаются только в нужном направлении');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.expect_count($q$with edited as (
    update public.departments set name = 'Работа со спонсорами'
    where id = '00000000-0000-4000-8000-0000000000a7' returning sponsor_workspace
) select count(*) from edited where sponsor_workspace$q$,
    1, 'переименование направления сохраняет рабочее место спонсоров');
select pg_temp.expect_count($q$select count(*) from public.activity_log where entity_type = 'sponsors'
    and action = 'update' and actor_id = '00000000-0000-4000-8000-000000000006'
    and changes ->> 'status_after' = 'discussed' and changes -> 'fields' ? 'payment_status'$q$,
    1, 'журнал сохраняет автора и изменения двух статусов');
select pg_temp.expect_error($q$delete from public.sponsors where company = 'Компания А'$q$,
    '42501', 'карточки спонсоров защищены от физического удаления из клиента');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000002"}';
select pg_temp.expect_count($q$with added as (
    insert into public.direction_cards (event_id, department_id, name, status, amount, notes, control_dates)
    values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2',
        'Тестовый коллектив', 'agreed', 15000.50, 'Предоставить автобус',
        '[{"label":"Позвонить","date":"2027-01-20"},{"label":"Подтвердить участие","date":"2027-02-01"}]')
    returning status, amount, control_dates
) select count(*) from added where status = 'agreed' and amount = 15000.50 and jsonb_array_length(control_dates) = 2$q$,
    1, 'руководитель сохраняет контрагента со стоимостью и несколькими датами');
select pg_temp.expect_error($q$update public.direction_cards
    set control_dates = '[{"label":"Проверка","date":"2027-02-30"}]' where name = 'Тестовый коллектив'$q$,
    '23514', 'несуществующая контрольная дата запрещена');
select pg_temp.expect_error($q$update public.direction_cards
    set control_dates = '[{"label":"  ","date":"2027-02-28"}]' where name = 'Тестовый коллектив'$q$,
    '23514', 'контрольной дате нужно непустое название');
select pg_temp.expect_error($q$insert into public.direction_cards (event_id, department_id, name)
    values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a3', 'Чужое заведение')$q$,
    '42501', 'руководитель не создаёт карточки в чужом направлении');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000006"}';
select pg_temp.expect_count($q$select count(*) from public.direction_cards where name = 'Тестовый коллектив'$q$,
    1, 'обычный участник видит контрагентов своего мероприятия');
select pg_temp.expect_count($q$with edited as (
    update public.direction_cards set status = 'declined' where name = 'Тестовый коллектив' returning 1
) select count(*) from edited$q$, 0, 'обычный участник не редактирует карточку коллектива');
select pg_temp.expect_count($q$with edited as (
    update public.sponsors set control_dates = '[{"label":"Получить договор","date":"2027-01-24"}]'
    where company = 'Компания А' returning control_dates, received_amount
) select count(*) from edited where control_dates -> 0 ->> 'date' = '2027-01-24' and received_amount = 6000.25$q$,
    1, 'ответственный добавляет дату своего спонсора с сохранением полученной суммы');
select pg_temp.expect_count($q$with edited as (
    update public.sponsors set control_dates = '[{"label":"Позвонить","date":"2027-01-24"}]'
    where company = 'Компания Б' returning 1
) select count(*) from edited$q$, 0, 'ответственный не меняет даты чужого спонсора');
select pg_temp.expect_error($q$update public.sponsors set notes = 'Подмена комментария' where company = 'Компания А'$q$,
    '42501', 'ответственный не получает дополнительные права на комментарий руководителя');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000005"}';
select pg_temp.expect_count($q$select count(*) from public.direction_cards where name = 'Тестовый коллектив'$q$,
    0, 'карточка контрагента изолирована от другого мероприятия');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.expect_count($q$with added as (
    insert into public.direction_cards (event_id, department_id, name, status, amount, notes)
    values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a3',
        'Тестовое заведение', 'discussed', 0, 'Салаты') returning amount, notes
) select count(*) from added where amount = 0 and notes = 'Салаты'$q$,
    1, 'координатор может указать вклад заведения и нулевую стоимость');
select pg_temp.expect_error($q$delete from public.direction_cards where name = 'Тестовый коллектив'$q$,
    '42501', 'физическое удаление карточек из клиента закрыто');

select pg_temp.expect_error($q$insert into public.ticket_sales (event_id, department_id, table_number, quantity, amount, payment_method)
    values ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', 1, 1, 100, 'cash')$q$,
    '42501', 'координатор записывает продажи только в направлении билетов');

reset role;
insert into public.event_members (event_id, user_id, role) values
    ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000002', 'member'),
    ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-000000000003', 'member');
insert into public.department_members (event_id, department_id, user_id)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-000000000002');

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000002"}';
select pg_temp.expect_count($q$with added as (
    insert into public.ticket_sales (event_id, department_id, table_number, quantity, amount, payment_method)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 1, 3, 1000.25, 'cash'),
           ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 1, 2, 900.50, 'cashless') returning *
) select sum(quantity) from added having sum(amount) = 1900.75$q$, 5, 'руководитель записывает продажи с обоими способами оплаты');
select pg_temp.expect_error($q$insert into public.ticket_sales (event_id, department_id, table_number, quantity, amount, payment_method)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 1, 0, 1, 'cash')$q$,
    '23514', 'нулевое количество билетов запрещено');
select pg_temp.expect_error($q$insert into public.ticket_sales (event_id, department_id, table_number, quantity, amount, payment_method)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 1, 1, 'NaN', 'cash')$q$,
    '23514', 'некорректная сумма продажи запрещена');
select pg_temp.expect_count($q$with added as (insert into storage.objects (bucket_id, name)
    values ('crm-ticket-layouts', '00000000-0000-4000-8000-0000000000b1/00000000-0000-4000-8000-0000000000b2/00000000-0000-4000-8000-000000000011.pdf')
    returning 1) select count(*) from added$q$, 1, 'руководитель билетов может загрузить схему');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000003"}';
select pg_temp.expect_count($q$select count(*) from public.ticket_sales where department_id = '00000000-0000-4000-8000-0000000000b2'$q$,
    2, 'участник читает продажи своего мероприятия');
select pg_temp.expect_count($q$select count(*) from storage.objects where bucket_id = 'crm-ticket-layouts' and name like '00000000-0000-4000-8000-0000000000b1/%'$q$,
    1, 'участник читает схему своего мероприятия');
select pg_temp.expect_error($q$insert into public.ticket_sales (event_id, department_id, table_number, quantity, amount, payment_method)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 1, 1, 100, 'cash')$q$,
    '42501', 'обычный участник не записывает продажи');
select pg_temp.expect_error($q$insert into storage.objects (bucket_id, name)
    values ('crm-ticket-layouts', '00000000-0000-4000-8000-0000000000b1/00000000-0000-4000-8000-0000000000b2/00000000-0000-4000-8000-000000000012.png')$q$,
    '42501', 'обычный участник не загружает схему даже при общей политике Storage');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.expect_count($q$select count(*) from public.ticket_sales where department_id = '00000000-0000-4000-8000-0000000000b2'$q$,
    0, 'продажи изолированы от другого мероприятия');
select pg_temp.expect_count($q$select count(*) from storage.objects where bucket_id = 'crm-ticket-layouts' and name like '00000000-0000-4000-8000-0000000000b1/%'$q$,
    0, 'схема изолирована от другого мероприятия даже при общей политике Storage');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000002"}';
select pg_temp.expect_count($q$select count(*) from public.ticket_tables where department_id = '00000000-0000-4000-8000-0000000000b2'$q$,
    20, 'в новом направлении билетов двадцать столов');
insert into public.ticket_reservations (id, event_id, department_id, table_number, guest_name, quantity, reserved_until)
values ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2',
    1, 'Тестовая бронь', 7, (statement_timestamp() at time zone 'Asia/Vladivostok')::date + 1),
    ('00000000-0000-4000-8000-000000000014', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2',
    2, 'Резерв целого стола', 12, (statement_timestamp() at time zone 'Asia/Vladivostok')::date);
select pg_temp.expect_count($q$select reserved_count from public.ticket_tables
    where department_id = '00000000-0000-4000-8000-0000000000b2' and table_number = 1 and sold_count = 5$q$,
    7, 'продажи и брони учитываются вместе на одном столе');
select pg_temp.expect_error($q$insert into public.ticket_sales (event_id, department_id, table_number, quantity, amount, payment_method)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 1, 1, 100, 'cash')$q$,
    '23514', 'прямая продажа не забирает зарезервированное место');
select pg_temp.expect_error($q$insert into public.ticket_sales (event_id, department_id, table_number, quantity, amount, payment_method, reservation_id)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 1, 3, 100, 'cash', '00000000-0000-4000-8000-000000000013')$q$,
    '23514', 'бронь выкупается целиком');
select pg_temp.expect_error($q$update public.ticket_reservations set status = 'sold' where id='00000000-0000-4000-8000-000000000013'$q$,
    '42501', 'подтверждение продажи требует записи оплаты');
insert into public.ticket_sales (event_id, department_id, table_number, quantity, amount, payment_method, reservation_id)
values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 1, 7, 400.25, 'cash', '00000000-0000-4000-8000-000000000013');
select pg_temp.expect_count($q$select sold_count from public.ticket_tables
    where department_id = '00000000-0000-4000-8000-0000000000b2' and table_number = 1 and reserved_count = 0$q$,
    12, 'выкуп из брони отмечает весь стол проданным');
select pg_temp.expect_error($q$insert into public.ticket_sales (event_id, department_id, table_number, quantity, amount, payment_method, reservation_id)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 1, 7, 400.25, 'cash', '00000000-0000-4000-8000-000000000013')$q$,
    '23505', 'одна бронь не может попасть в журнал дважды');
update public.ticket_reservations set status = 'released' where id = '00000000-0000-4000-8000-000000000014';
select pg_temp.expect_count($q$select reserved_count from public.ticket_tables
    where department_id = '00000000-0000-4000-8000-0000000000b2' and table_number = 2 and sold_count = 0$q$,
    0, 'ручное снятие целого стола возвращает все места');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000003"}';
select pg_temp.expect_count($q$select count(*) from public.ticket_reservations where guest_name = 'Тестовая бронь' and status = 'sold'$q$,
    1, 'участник видит имя и статус брони');
select pg_temp.expect_error($q$insert into public.ticket_reservations (event_id, department_id, table_number, guest_name, quantity, reserved_until)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 2, 'Посторонняя запись', 1,
        (statement_timestamp() at time zone 'Asia/Vladivostok')::date + 1)$q$,
    '42501', 'участник без роли не может бронировать');
set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.expect_count($q$select count(*) from public.ticket_reservations where id = '00000000-0000-4000-8000-000000000013'$q$,
    0, 'имена в бронях изолированы от других мероприятий');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000005"}';
select pg_temp.expect_error($q$delete from public.ticket_sales where department_id = '00000000-0000-4000-8000-0000000000b2'$q$,
    '42501', 'история продаж защищена от физического удаления из клиента');
select pg_temp.expect_count($q$with archived as (
    update public.departments set archived = true, name = 'Работа с билетами'
    where id = '00000000-0000-4000-8000-0000000000b2' returning ticket_workspace
) select count(*) from archived where ticket_workspace$q$, 1, 'переименование и архив сохраняют рабочее место билетов');
select pg_temp.expect_error($q$insert into public.ticket_sales (event_id, department_id, table_number, quantity, amount, payment_method)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', 1, 1, 100, 'cash')$q$,
    '42501', 'новые продажи закрыты в архивном направлении');

select pg_temp.expect_count($q$select count(*) from public.finance_overview
    where event_id = '00000000-0000-4000-8000-0000000000b1' and tickets_kopecks = '230100' and sponsors_kopecks = '0'$q$,
    1, 'выкуп и прямые продажи отражаются в финансах одного мероприятия');
select pg_temp.expect_count($q$select count(*) from public.finance_overview where event_id = '00000000-0000-4000-8000-0000000000a1'$q$,
    0, 'координатор другого мероприятия не видит финансовую сводку');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.expect_count($q$select count(*) from public.finance_overview
    where sponsors_kopecks = '600025' and reserved_kopecks = '1500050' and paid_kopecks = '0'
      and balance_kopecks = '600025' and available_kopecks = '-900025'$q$,
    1, 'учтён полученный взнос, резерв уменьшает только прогнозный остаток');
update public.direction_cards set status = 'declined' where name = 'Тестовый коллектив';
select pg_temp.expect_count($q$select count(*) from public.finance_expenses where card_name = 'Тестовый коллектив'$q$,
    0, 'снятие согласования убирает неоплаченный резерв');
update public.direction_cards set status = 'agreed', amount = 15001.20 where name = 'Тестовый коллектив';
select pg_temp.expect_error($q$insert into public.finance_expense_payments (event_id, card_id, amount, paid_on, payment_method)
    select event_id, id, 15000.50, (statement_timestamp() at time zone 'Asia/Vladivostok')::date, 'cash'
    from public.direction_cards where name = 'Тестовый коллектив'$q$,
    '23514', 'платёж со старой суммой резерва отклоняется');
insert into public.finance_expense_payments (event_id, card_id, amount, paid_on, payment_method)
select event_id, id, amount, (statement_timestamp() at time zone 'Asia/Vladivostok')::date, 'cash'
from public.direction_cards where name = 'Тестовый коллектив';
select pg_temp.expect_error($q$insert into public.finance_expense_payments (event_id, card_id, amount, paid_on, payment_method)
    select event_id, id, amount, (statement_timestamp() at time zone 'Asia/Vladivostok')::date, 'cash'
    from public.direction_cards where name = 'Тестовый коллектив'$q$,
    '23505', 'согласованная карточка оплачивается один раз');
update public.direction_cards set amount = 18000 where name = 'Тестовый коллектив';
select pg_temp.expect_count($q$select count(*) from public.finance_overview
    where reserved_kopecks = '0' and paid_kopecks = '1500120' and balance_kopecks = '-900095' and available_kopecks = '-900095'$q$,
    1, 'оплата уменьшает фактический остаток и остаётся неизменной при редактировании карточки');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000002"}';
select pg_temp.expect_count($q$select count(*) from public.event_tabs where builtin = 'finance'$q$,
    0, 'финансовая вкладка скрыта от руководителя направления');
select pg_temp.expect_count($q$select count(*) from public.finance_overview$q$, 0, 'руководитель не читает сводку');
select pg_temp.expect_count($q$select count(*) from public.finance_expenses$q$, 0, 'руководитель не читает резервы и оплаченные расходы');
select pg_temp.expect_count($q$select count(*) from public.finance_expense_payments$q$, 0, 'платежи недоступны через базовую таблицу');
select pg_temp.expect_count($q$select count(*) from public.activity_log where entity_type = 'finance_expense_payments'$q$,
    0, 'журнал финансовых действий скрыт от руководителя');
select pg_temp.expect_error($q$insert into public.finance_expense_payments (event_id, card_id, amount, paid_on, payment_method)
    select event_id, id, 50, (statement_timestamp() at time zone 'Asia/Vladivostok')::date, 'cashless'
    from public.direction_cards where name = 'Тестовое заведение'$q$,
    '42501', 'руководитель не записывает оплату через API');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000005"}';
update public.departments set archived = false where id = '00000000-0000-4000-8000-0000000000b2';

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000002"}';
select pg_temp.expect_count($q$with added as (
    insert into public.ticket_tables (event_id, department_id, request_id)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-000000000099')
    returning table_number
) select max(table_number) from added$q$, 21, 'руководителю доступен следующий номер нового стола');
update public.ticket_sales set table_number = 21, quantity = 10, amount = 550.10, payment_method = 'cashless'
where reservation_id = '00000000-0000-4000-8000-000000000013';
select pg_temp.expect_count($q$select count(*) from public.ticket_reservations
    where id = '00000000-0000-4000-8000-000000000013' and table_number = 21 and quantity = 10 and status = 'sold'$q$,
    1, 'выкупленная бронь переезжает вместе с исправленной продажей');
select pg_temp.expect_count($q$select count(*) from public.ticket_tables
    where department_id = '00000000-0000-4000-8000-0000000000b2'
      and ((table_number = 1 and sold_count = 5) or (table_number = 21 and sold_count = 10))$q$,
    2, 'новая продажа освобождает старые места и занимает новые');
select pg_temp.expect_error($q$update public.ticket_sales set table_number = 1
    where reservation_id = '00000000-0000-4000-8000-000000000013'$q$,
    '23514', 'исправление продажи не может превысить вместимость');
select pg_temp.expect_count($q$select count(*) from public.ticket_sales
    where reservation_id = '00000000-0000-4000-8000-000000000013' and table_number = 21 and revision = 1$q$,
    1, 'неудачная правка не изменяет продажу или версию записи');
select pg_temp.expect_count($q$select count(*) from public.activity_log
    where event_id = '00000000-0000-4000-8000-0000000000b1' and entity_type = 'ticket_sales' and action = 'update'
      and changes #>> '{before,quantity}' = '7' and changes #>> '{after,quantity}' = '10'$q$,
    1, 'история хранит данные продажи до и после правки');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000005"}';
select pg_temp.expect_count($q$select count(*) from public.finance_overview
    where event_id = '00000000-0000-4000-8000-0000000000b1' and tickets_kopecks = '245085'$q$,
    1, 'в финансах отражается исправленная сумма без дублирования');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000003"}';
select pg_temp.expect_error($q$insert into public.ticket_tables (event_id, department_id, request_id)
    values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-000000000098')$q$,
    '42501', 'участник без роли не добавляет столы');
select pg_temp.expect_count($q$with edited as (update public.ticket_sales set amount = 1
    where reservation_id = '00000000-0000-4000-8000-000000000013' returning 1) select count(*) from edited$q$,
    0, 'участник без роли не исправляет продажу');

reset role;
update public.ticket_reservations set reserved_until = (statement_timestamp() at time zone 'Asia/Vladivostok')::date - 1
where id = '00000000-0000-4000-8000-000000000013';
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000002"}';
select pg_temp.expect_error($q$update public.ticket_sales set voided_at = now()
    where reservation_id = '00000000-0000-4000-8000-000000000013'$q$,
    '42501', 'руководитель «Билетов» не может удалить продажу');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000005"}';
update public.ticket_sales set voided_at = now() where reservation_id = '00000000-0000-4000-8000-000000000013';
update public.ticket_sales set voided_at = now() where amount = 1000.25 and event_id = '00000000-0000-4000-8000-0000000000b1';
select pg_temp.expect_count($q$select count(*) from public.ticket_reservations
    where id = '00000000-0000-4000-8000-000000000013' and status = 'reserved' and quantity = 10
      and reserved_until = (statement_timestamp() at time zone 'Asia/Vladivostok')::date - 1$q$,
    1, 'удаление выкупа возвращает бронь даже с истёкшим сроком');
select pg_temp.expect_count($q$select count(*) from public.ticket_tables
    where department_id = '00000000-0000-4000-8000-0000000000b2'
      and ((table_number = 1 and sold_count = 2 and reserved_count = 0)
           or (table_number = 21 and sold_count = 0 and reserved_count = 10))$q$,
    2, 'прямые продажи освобождают места, выкуп переводит места обратно в резерв');
select pg_temp.expect_count($q$select count(*) from public.finance_overview
    where event_id = '00000000-0000-4000-8000-0000000000b1' and tickets_kopecks = '90050'$q$,
    1, 'удалённые продажи исключаются из выручки');
select pg_temp.expect_count($q$select count(*) from public.activity_log
    where event_id = '00000000-0000-4000-8000-0000000000b1' and actor_id = '00000000-0000-4000-8000-000000000005'
      and entity_type = 'ticket_sales' and changes #>> '{after,voided_at}' is not null$q$,
    2, 'журнал хранит время и автора удаления');

insert into public.ticket_sales (id, event_id, department_id, table_number, quantity, amount, payment_method, reservation_id)
values ('00000000-0000-4000-8000-000000000091', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2',
    21, 10, 350.10, 'cash', '00000000-0000-4000-8000-000000000013');
update public.ticket_sales set table_number = 2 where id = '00000000-0000-4000-8000-000000000091';
select pg_temp.expect_count($q$select count(*) from public.ticket_sales
    where reservation_id = '00000000-0000-4000-8000-000000000013'
      and ((table_number = 21 and amount = 550.10 and voided_at is not null) or (table_number = 2 and voided_at is null))$q$,
    2, 'повторный выкуп и перенос сохраняют исходную запись в истории');
select pg_temp.expect_count($q$with edited as (update public.ticket_sales set amount = 1 where voided_at is not null returning 1)
    select count(*) from edited$q$, 0, 'удалённые продажи недоступны для редактирования');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000002"}';
select pg_temp.expect_count($q$select count(*) from public.ticket_sales where voided_at is not null$q$,
    0, 'руководитель видит рабочий журнал без удалённых продаж');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.expect_count($q$select count(*) from public.tasks where title = 'Меню' and amount is null and amount_kind = 'expense'$q$,
    1, 'сумма существующей задачи пуста, тип по умолчанию расход');
update public.event_members set active = true where event_id = '00000000-0000-4000-8000-0000000000a1'
    and user_id = '00000000-0000-4000-8000-000000000003';
update public.tasks set owner_id = '00000000-0000-4000-8000-000000000003' where title = 'Меню';

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000003"}';
select pg_temp.expect_count($q$with edited as (update public.tasks set amount = 450.15, amount_kind = 'expense'
    where title = 'Меню' returning amount) select count(*) from edited where amount = 450.15$q$,
    1, 'ответственный меняет сумму без назначения соисполнителем');
select pg_temp.expect_error($q$update public.tasks set status = 'in_progress' where title = 'Меню'$q$, '42501',
    'право менять сумму не даёт ответственному дополнительных прав на статус');
select pg_temp.expect_count($q$with edited as (update public.tasks set amount = 120.25, amount_kind = 'income'
    where title = 'Репетиция' returning amount, amount_kind)
    select count(*) from edited where amount = 120.25 and amount_kind = 'income'$q$,
    1, 'соисполнитель может указать сумму поступления');
select pg_temp.expect_error($q$update public.tasks set amount = -1 where title = 'Репетиция'$q$, '23514',
    'знак задаётся типом и сумма не может быть отрицательной');
select pg_temp.expect_count($q$with edited as (update public.tasks set amount = 99 where title = 'Программа' returning 1)
    select count(*) from edited$q$, 0, 'участник без назначения не меняет сумму другой задачи');
select pg_temp.expect_count($q$select count(*) from public.finance_task_plan$q$, 0, 'план по задачам доступен только координатору');

set local request.jwt.claims = '{"role":"authenticated","sub":"00000000-0000-4000-8000-000000000001"}';
select pg_temp.expect_count($q$select count(*) from public.finance_task_plan where income_kopecks = '12025' and expense_kopecks = '45015'$q$,
    1, 'пустая сумма родителя позволяет учесть поступление из подзадачи');
update public.tasks set amount = 800.50 where title = 'Программа';
select pg_temp.expect_count($q$select count(*) from public.finance_task_plan where income_kopecks = '0' and expense_kopecks = '125065'$q$,
    1, 'план учитывает указанную сумму родителя вместо суммы подзадачи');
update public.tasks set status = 'cancelled' where title = 'Программа';
select pg_temp.expect_count($q$select count(*) from public.finance_task_plan where income_kopecks = '12025' and expense_kopecks = '45015'$q$,
    1, 'отменённая задача исключена, её активная подзадача учитывается');
select pg_temp.expect_count($q$select count(*) from public.finance_overview
    where sponsors_kopecks = '600025' and balance_kopecks = '-900095'$q$,
    1, 'плановые суммы задач не изменяют фактический остаток');

rollback;
