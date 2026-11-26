import { useEffect, useState, type FormEvent } from 'react'
import { FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js'
import {
  deadlineInput, eventStatuses, eventTabTitle, parseDeadline, saveDepartmentLeadership,
  type DepartmentMembership, type EventWorkspace, type TeamProfile,
} from './events'

export function EventSettings({ client, model, saved }: {
  client: SupabaseClient; model: EventWorkspace; saved: () => void
}) {
  const { event } = model
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault()
    if (pending) return
    const fields = new FormData(formEvent.currentTarget)
    const name = String(fields.get('name') ?? '').trim()
    const starts = String(fields.get('starts') ?? '')
    if (!name) {
      setError('Укажите название мероприятия.')
      return
    }
    setError('')
    setPending(true)
    try {
      const { error: writeError } = await client.from('events').update({
        name,
        starts_at: starts === deadlineInput(event.starts_at) ? event.starts_at : parseDeadline(starts),
        venue: String(fields.get('venue') ?? '').trim() || null,
        status: fields.get('status'),
      }).eq('id', event.id).eq('updated_at', event.updated_at).select('id').single()
      if (writeError) setError('Не удалось сохранить мероприятие. Проверьте права или обновите страницу.')
      else saved()
    } catch {
      setError('Не удалось сохранить мероприятие. Проверьте заполнение полей и подключение.')
    } finally {
      setPending(false)
    }
  }

  return <form className="form task-form" onSubmit={submit}>
    <h2>{eventTabTitle(model, 'settings', 'Настройки мероприятия')}</h2>
    <label>Название<input name="name" defaultValue={event.name} required /></label>
    <label>Дата и время по Владивостоку<input name="starts" type="datetime-local" defaultValue={deadlineInput(event.starts_at)} required /></label>
    <label>Площадка<input name="venue" defaultValue={event.venue ?? ''} /></label>
    <label>Статус<select name="status" defaultValue={event.status}>
      {Object.entries(eventStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    {error && <p role="alert" className="message error">{error}</p>}
    <div className="form-buttons"><button className="button button-primary" disabled={pending}>Сохранить мероприятие</button></div>
  </form>
}

type Member = { user_id: string; role: string; active: boolean; profiles: TeamProfile | null }

const invitationMessages: Record<string, string> = {
  invited: 'Участник добавлен. Приглашение отправлено на указанную почту.',
  added: 'Пользователь с этой почтой добавлен в команду.',
  already_member: 'Этот участник уже в команде.',
  inactive_member: 'Доступ участника отключён. Его можно восстановить в карточке участника.',
}

const invitationErrors: Record<string, string> = {
  unauthorized: 'Войдите заново, чтобы пригласить участника.',
  forbidden: 'Приглашать участников может координатор этого мероприятия.',
  invalid_input: 'Проверьте имя и адрес электронной почты.',
  try_later: 'Достигнут лимит отправки приглашений. Повторите попытку позже.',
  invite_failed: 'Не удалось отправить приглашение. Проверьте адрес или повторите попытку позже.',
  enrollment_pending: 'Приглашение отправлено. Повторите добавление с тем же адресом, чтобы завершить действие.',
}

export function EventTeam({ client, model, saved, leadershipSaved }: {
  client: SupabaseClient; model: EventWorkspace; saved: () => void
  leadershipSaved: (membership: DepartmentMembership) => void
}) {
  const eventId = model.event.id
  const [members, setMembers] = useState<Member[] | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    void Promise.resolve(client.from('event_members').select('user_id,role,active,profiles(id,display_name)').eq('event_id', eventId)
      .order('active', { ascending: false }).order('user_id').abortSignal(signal).returns<Member[]>()
    ).then(({ data }) => {
      if (signal.aborted) return
      if (!data) setError('Не удалось загрузить команду.')
      else setMembers(data)
    }).catch(() => { if (!signal.aborted) setError('Не удалось загрузить команду.') })
    return () => controller.abort()
  }, [client, eventId, model.teammates])

  async function save<T>(query: PromiseLike<{ data: T | null; error: unknown }>, onSaved: (data: T) => void = () => saved()) {
    if (pending) return
    setPending(true)
    setError('')
    setNotice('')
    try {
      const { data, error: writeError } = await query
      if (writeError || !data) setError('Не удалось сохранить. Проверьте права и текущее членство.')
      else onSaved(data)
    } catch {
      setError('Не удалось сохранить изменения.')
    } finally {
      setPending(false)
    }
  }

  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const name = String(fields.get('name') ?? '').trim()
    const email = String(fields.get('email') ?? '').trim()
    setError('')
    setNotice('')
    if (!name || !email) {
      setError(invitationErrors.invalid_input)
      return
    }
    setPending(true)
    try {
      const { data, error: inviteError } = await client.functions.invoke<{ code: string }>('invite-member', {
        body: { eventId, name, email },
      })
      if (inviteError || !data?.code || !Object.hasOwn(invitationMessages, data.code)) {
        const failure = inviteError instanceof FunctionsHttpError
          ? await inviteError.context.json().catch(() => null)
          : null
        const code = failure?.code
        setError(typeof code === 'string' && Object.hasOwn(invitationErrors, code)
          ? invitationErrors[code]
          : 'Не удалось добавить участника. Повторите попытку позже.')
      } else {
        form.reset()
        setNotice(invitationMessages[data.code])
        saved()
      }
    } catch {
      setError('Не удалось связаться с сервером. Повторите попытку позже.')
    } finally {
      setPending(false)
    }
  }

  function setDirection(userId: string, departmentId: string, active: boolean) {
    if (pending) return
    void save(saveDepartmentLeadership(client, model, { department_id: departmentId, user_id: userId, active }),
      (membership) => {
        leadershipSaved(membership)
        setNotice(active ? 'Ответственный назначен.' : 'Назначение снято.')
      })
  }

  return <section>
    <h2>{eventTabTitle(model, 'team', 'Команда')}</h2>
    {error && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message">{notice}</p>}
    {!members && !error && <p role="status">Загружаем команду…</p>}
    {members && <ul className="card-grid">
      {members.filter((member) => member.active || model.coordinator).map((member) => {
        const name = member.profiles?.display_name ?? member.user_id
        const manages = model.departments.filter((department) => model.departmentMemberships.some((row) =>
          row.active && row.user_id === member.user_id && row.department_id === department.id))
        return <li className="panel" key={member.user_id}>
          <h3>{name}</h3>
          <p>{member.role === 'coordinator' ? 'Координатор' : member.active ? 'Активный участник' : 'Доступ отключён'}</p>
          {manages.length > 0 && <p>Руководит направлениями · {manages.map((row) => row.name).join(', ')}</p>}
          {model.coordinator && member.role !== 'coordinator' && <>
            {member.active && model.departments.length > 0 && <details>
              <summary>Руководство направлениями</summary>
              {model.departments.map((department) => <label className="check-filter" key={department.id}>
                <input type="checkbox" checked={manages.some((row) => row.id === department.id)}
                  disabled={pending} onChange={(e) => setDirection(member.user_id, department.id, e.target.checked)} />
                {department.name}
              </label>)}
            </details>}
            <button className="button" type="button" disabled={pending} onClick={() => {
              void save(client.from('event_members').update({ active: !member.active }).eq('event_id', eventId)
                .eq('user_id', member.user_id).select('user_id').single())
            }}>{member.active ? 'Отключить доступ' : 'Восстановить доступ'}</button>
          </>}
        </li>
      })}
    </ul>}
    {model.coordinator && <form className="form task-form" onSubmit={addMember}>
      <h3>Пригласить участника</h3>
      <label>Имя<input name="name" autoComplete="off" maxLength={120} disabled={pending} required /></label>
      <label>Электронная почта<input name="email" type="email" autoComplete="off" maxLength={254} disabled={pending} required /></label>
      <div className="form-buttons"><button className="button button-primary" disabled={pending}>
        {pending ? 'Сохраняем…' : 'Пригласить'}
      </button></div>
    </form>}
  </section>
}
