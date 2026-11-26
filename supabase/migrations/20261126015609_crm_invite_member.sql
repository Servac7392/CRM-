begin;

-- Only the Edge Function calls this with the ID verified by Supabase Auth.
create function crm_private.enroll_invited_member(
    p_actor_id uuid,
    p_event_id uuid,
    p_email text,
    p_display_name text,
    p_expected_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    invitee_id uuid;
    existing_active boolean;
begin
    perform 1 from public.event_members
    where event_id = p_event_id and user_id = p_actor_id and active and role = 'coordinator'
    for share;
    if not found then
        return 'forbidden';
    end if;

    select id into invitee_id from auth.users
    where email = p_email and not is_sso_user and deleted_at is null
      and (p_expected_user_id is null or id = p_expected_user_id)
    for share;
    if not found then
        return 'missing';
    end if;

    insert into public.profiles (id, display_name)
    values (invitee_id, p_display_name)
    on conflict (id) do nothing;

    perform pg_catalog.set_config('request.jwt.claim.sub', p_actor_id::text, true);
    insert into public.event_members (event_id, user_id, role)
    values (p_event_id, invitee_id, 'member')
    on conflict (event_id, user_id) do nothing;
    if found then
        return 'added';
    end if;

    select active into existing_active from public.event_members
    where event_id = p_event_id and user_id = invitee_id;
    return case when existing_active then 'already_member' else 'inactive_member' end;
end;
$$;

create function public.crm_enroll_invited_member(
    p_actor_id uuid,
    p_event_id uuid,
    p_email text,
    p_display_name text,
    p_expected_user_id uuid
)
returns text
language sql
security invoker
set search_path = ''
return crm_private.enroll_invited_member(p_actor_id, p_event_id, p_email, p_display_name, p_expected_user_id);

revoke execute on function crm_private.enroll_invited_member(uuid, uuid, text, text, uuid)
    from public, anon, authenticated;
revoke execute on function public.crm_enroll_invited_member(uuid, uuid, text, text, uuid)
    from public, anon, authenticated;
grant usage on schema crm_private to service_role;
grant execute on function crm_private.enroll_invited_member(uuid, uuid, text, text, uuid),
    public.crm_enroll_invited_member(uuid, uuid, text, text, uuid) to service_role;

notify pgrst, 'reload schema';

commit;
