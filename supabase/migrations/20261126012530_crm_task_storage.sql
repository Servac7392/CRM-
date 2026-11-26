-- Проект политики Storage для согласования. Требует 01-core.sql и 02-tasks.sql.
-- Перед настройкой политики создать приватный bucket crm-task-files через Supabase Storage.
begin;

-- Формат имени объекта: <event_id>/<task_id>/<uuid>, без исходного имени файла.
create function crm_private.can_access_task_file(object_name text, write_access boolean)
returns boolean language plpgsql stable set search_path = ''
as $$
declare
    path_parts text[];
    target_event uuid;
    target_task uuid;
begin
    if object_name !~ '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' then
        return false;
    end if;
    path_parts := string_to_array(object_name, '/');
    target_event := path_parts[1]::uuid;
    target_task := path_parts[2]::uuid;

    if write_access then
        return crm_private.can_work_on_task(target_event, target_task);
    end if;
    return exists (
        select 1 from public.tasks
        where event_id = target_event and id = target_task
    );
end;
$$;

revoke execute on function crm_private.can_access_task_file(text, boolean)
    from public, anon, authenticated;
grant execute on function crm_private.can_access_task_file(text, boolean) to authenticated;

create policy crm_task_files_read on storage.objects for select to authenticated
    using (bucket_id = 'crm-task-files' and crm_private.can_access_task_file(name, false));

create policy crm_task_files_upload on storage.objects for insert to authenticated
    with check (bucket_id = 'crm-task-files' and crm_private.can_access_task_file(name, true));

-- Защита bucket от более широких разрешающих политик других приложений.
create policy crm_task_files_read_boundary on storage.objects as restrictive for select to authenticated
    using (bucket_id is distinct from 'crm-task-files' or crm_private.can_access_task_file(name, false));
create policy crm_task_files_upload_boundary on storage.objects as restrictive for insert to authenticated
    with check (bucket_id is distinct from 'crm-task-files' or crm_private.can_access_task_file(name, true));
create policy crm_task_files_update_boundary on storage.objects as restrictive for update to anon, authenticated
    using (bucket_id is distinct from 'crm-task-files')
    with check (bucket_id is distinct from 'crm-task-files');
create policy crm_task_files_delete_boundary on storage.objects as restrictive for delete to anon, authenticated
    using (bucket_id is distinct from 'crm-task-files');
create policy crm_task_files_anon_read_boundary on storage.objects as restrictive for select to anon
    using (bucket_id is distinct from 'crm-task-files');
create policy crm_task_files_anon_upload_boundary on storage.objects as restrictive for insert to anon
    with check (bucket_id is distinct from 'crm-task-files');

commit;
