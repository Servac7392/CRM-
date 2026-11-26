import { useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { saveDepartmentLeadership, type DepartmentMembership, type EventWorkspace } from './events'

export function DirectionLeadership({ client, model, departmentId, saved }: {
  client: SupabaseClient
  model: EventWorkspace
  departmentId: string
  saved: (membership: DepartmentMembership) => void
}) {
  const [userId, setUserId] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const leaderIds = new Set(model.departmentMemberships
    .filter((membership) => membership.department_id === departmentId && membership.active)
    .map((membership) => membership.user_id))
  const leaders = model.teammates.filter((person) => leaderIds.has(person.id))
  const candidates = model.teammates.filter((person) => !leaderIds.has(person.id))

  async function save(target: string, active: boolean) {
    if (pending) return
    setPending(true)
    setError('')
    setNotice('')
    try {
      const result = await saveDepartmentLeadership(client, model, { department_id: departmentId, user_id: target, active })
      if (result.error || !result.data) {
        setError('Не удалось сохранить назначение. Проверьте права и членство участника.')
        return
      }
      saved(result.data)
      setUserId('')
      setNotice(active ? 'Ответственный назначен.' : 'Назначение снято.')
    } catch {
      setError('Не удалось сохранить назначение. Проверьте подключение.')
    } finally {
      setPending(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (candidates.some((person) => person.id === userId)) void save(userId, true)
  }

  return <section className="direction-leadership">
    <h3>Ответственные за направление</h3>
    {leaders.length === 0 ? <p>Ответственные пока не назначены.</p> : <ul className="task-detail-list">
      {leaders.map((person) => <li key={person.id}>
        {person.display_name}{' '}
        {model.coordinator && <button type="button" className="button" disabled={pending}
          aria-label={`Снять назначение · ${person.display_name}`} onClick={() => void save(person.id, false)}>
          Снять назначение
        </button>}
      </li>)}
    </ul>}
    {model.coordinator && candidates.length > 0 && <form className="inline-form" onSubmit={submit}>
      <label>Участник команды<select value={userId} required disabled={pending} onChange={(event) => setUserId(event.target.value)}>
        <option value="">Выберите участника</option>
        {candidates.map((person) => <option key={person.id} value={person.id}>{person.display_name}</option>)}
      </select></label>
      <button type="submit" className="button button-primary" disabled={pending || !userId}>
        {pending ? 'Сохраняем…' : 'Назначить'}
      </button>
    </form>}
    {error && <p role="alert" className="message error">{error}</p>}
    {notice && <p role="status" className="message">{notice}</p>}
  </section>
}
