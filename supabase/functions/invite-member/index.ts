import { createClient } from 'npm:@supabase/supabase-js@2.119.2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

function reply(status: number, code: string) {
  return Response.json({ code }, { status, headers: { ...cors, 'Cache-Control': 'no-store' } })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
  if (request.method !== 'POST') return reply(405, 'method_not_allowed')

  const token = /^Bearer (\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1]
  if (!token) return reply(401, 'unauthorized')

  try {
    const url = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
      || Deno.env.get('SUPABASE_SECRET_KEY')
      || JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default
    if (!url || !serviceKey) return reply(503, 'unavailable')

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data: identity, error: authError } = await admin.auth.getUser(token)
    if (authError || !identity.user) return reply(401, 'unauthorized')

    const body = await request.json().catch(() => null)
    const eventId = typeof body?.eventId === 'string' ? body.eventId : ''
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!uuid.test(eventId) || !name || name.length > 120 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return reply(400, 'invalid_input')
    }

    const enroll = (expectedId: string | null) => admin.rpc('crm_enroll_invited_member', {
      p_actor_id: identity.user.id,
      p_event_id: eventId,
      p_email: email,
      p_display_name: name,
      p_expected_user_id: expectedId,
    })

    const current = await enroll(null)
    if (current.error) return reply(503, 'unavailable')
    if (current.data === 'forbidden') return reply(403, 'forbidden')
    if (current.data !== 'missing') return reply(200, current.data)

    const invitation = await admin.auth.admin.inviteUserByEmail(email)
    if (invitation.error) {
      // A concurrent invite may already have created the account.
      if (['email_exists', 'user_already_exists'].includes(invitation.error.code ?? '')) {
        const concurrent = await enroll(null)
        if (concurrent.data === 'forbidden') return reply(403, 'forbidden')
        if (!concurrent.error && concurrent.data !== 'missing') return reply(200, concurrent.data)
      }
      if (invitation.error.status === 429) return reply(429, 'try_later')
      return reply(502, 'invite_failed')
    }
    if (!invitation.data.user) return reply(502, 'invite_failed')

    const enrolled = await enroll(invitation.data.user.id)
    if (enrolled.data === 'forbidden') return reply(403, 'forbidden')
    if (enrolled.error || enrolled.data === 'missing') return reply(503, 'enrollment_pending')
    return reply(200, enrolled.data === 'added' ? 'invited' : enrolled.data)
  } catch {
    return reply(503, 'unavailable')
  }
})
