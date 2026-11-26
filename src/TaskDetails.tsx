import { useEffect, useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatDate, type EventWorkspace, type Task } from './events'
import { TaskFiles } from './TaskFiles'

type Assignment = { user_id: string; active: boolean }
type ChecklistItem = { id: string; title: string; completed: boolean }
type Comment = { id: string; author_id: string; body: string; created_at: string }
type LogEntry = { id: string; actor_id: string | null; action: string; entity_type: string; changed_at: string }
type TaskExtras = { assignments: Assignment[]; checklist: ChecklistItem[]; comments: Comment[]; log: LogEntry[] }

export function TaskDetails({ client, model, task, canManage, canWork }: {
  client: SupabaseClient; model: EventWorkspace; task: Task; canManage: boolean; canWork: boolean
}) {
  const { id: eventId } = model.event
  const { id: taskId } = task
  const [data, setData] = useState<TaskExtras | null>(null)
  const [revision, setRevision] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const [pending, setPending] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    void Promise.all([
      client.from('task_assignees').select('user_id,active').eq('event_id', eventId).eq('task_id', taskId)
        .abortSignal(signal).returns<Assignment[]>(),
      client.from('task_checklist').select('id,title,completed').eq('event_id', eventId).eq('task_id', taskId)
        .order('created_at').abortSignal(signal).returns<ChecklistItem[]>(),
      client.from('task_comments').select('id,author_id,body,created_at').eq('event_id', eventId).eq('task_id', taskId)
        .order('created_at', { ascending: false }).abortSignal(signal).returns<Comment[]>(),
      client.from('activity_log').select('id,actor_id,action,entity_type,changed_at').eq('event_id', eventId)
        .or(`entity_id.eq.${taskId},changes->>task_id.eq.${taskId}`).order('changed_at', { ascending: false })
        .abortSignal(signal).returns<LogEntry[]>(),
    ]).then(([assignments, checklist, comments, log]) => {
      if (signal.aborted) return
      if (!assignments.data || !checklist.data || !comments.data || !log.data) setLoadError(true)
      else {
        setData({ assignments: assignments.data, checklist: checklist.data, comments: comments.data, log: log.data })
        setLoadError(false)
      }
    }).catch(() => { if (!signal.aborted) setLoadError(true) })
    return () => controller.abort()
  }, [client, eventId, taskId, revision])

  async function save(query: PromiseLike<{ error: unknown }>, form?: HTMLFormElement) {
    if (pending) return
    setPending(true)
    setSaveError(false)
    try {
      const { error } = await query
      if (error) setSaveError(true)
      else {
        form?.reset()
        setRevision((current) => current + 1)
      }
    } catch {
      setSaveError(true)
    } finally {
      setPending(false)
    }
  }

  function submitAssignment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const userId = String(new FormData(form).get('helper') ?? '')
    if (!userId) return
    const assignment = data?.assignments.find((row) => row.user_id === userId)
    if (assignment) void setAssignment(userId, true, form)
    else void save(client.from('task_assignees').insert({ event_id: eventId, task_id: taskId, user_id: userId }), form)
  }

  function setAssignment(userId: string, active: boolean, form?: HTMLFormElement) {
    return save(client.from('task_assignees').update({ active })
      .eq('event_id', eventId).eq('task_id', taskId).eq('user_id', userId).select('user_id').single(), form)
  }

  function addItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const title = String(new FormData(form).get('item') ?? '').trim()
    if (title) void save(client.from('task_checklist').insert({ event_id: eventId, task_id: taskId, title }), form)
  }

  function addComment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const body = String(new FormData(form).get('comment') ?? '').trim()
    if (body) void save(client.from('task_comments').insert({ event_id: eventId, task_id: taskId, body }), form)
  }

  const names = new Map(model.teammates.map((person) => [person.id, person.display_name]))
  const active = data?.assignments.filter((assignment) => assignment.active) ?? []
  const helperOptions = model.teammates.filter((person) => person.id !== task.owner_id &&
    !active.some((assignment) => assignment.user_id === person.id))

  return <>
    {!data && !loadError && <p role="status">Загружаем детали задачи…</p>}
    {loadError && <p className="message error" role="alert">Не удалось загрузить детали задачи.</p>}
    {saveError && <p className="message error" role="alert">Не удалось сохранить изменение. Проверьте права или обновите страницу.</p>}
    {data && <>
      <section>
        <h3>Соисполнители</h3>
        {active.length === 0 && <p>Соисполнителей нет.</p>}
        <ul className="task-detail-list">
          {active.map(({ user_id }) => <li key={user_id}>
            <span>{names.get(user_id) ?? 'Участник недоступен'}</span>{' '}
            {canManage && <button type="button" className="button" disabled={pending}
              onClick={() => { void setAssignment(user_id, false) }}>Снять назначение</button>}
          </li>)}
        </ul>
        {canManage && helperOptions.length > 0 && <form className="inline-form" onSubmit={submitAssignment}>
          <label>Участник<select name="helper" defaultValue="" required>
            <option value="">Выберите соисполнителя</option>
            {helperOptions.map((person) => <option key={person.id} value={person.id}>{person.display_name}</option>)}
          </select></label>
          <button className="button" disabled={pending}>Назначить</button>
        </form>}
      </section>
      <section>
        <h3>Чек-лист</h3>
        {data.checklist.length === 0 && <p>Пунктов пока нет.</p>}
        <ul className="task-detail-list">
          {data.checklist.map((item) => <li key={item.id}>
            <label><input type="checkbox" checked={item.completed} disabled={!canWork || pending}
              onChange={(event) => {
                void save(client.from('task_checklist').update({ completed: event.target.checked })
                  .eq('id', item.id).eq('task_id', taskId).eq('event_id', eventId).select('id').single())
              }} />{item.title}</label>
          </li>)}
        </ul>
        {canWork && <form className="inline-form" onSubmit={addItem}>
          <label>Новый пункт<input name="item" required /></label>
          <button className="button" disabled={pending}>Добавить пункт</button>
        </form>}
      </section>
      <section>
        <h3>Комментарии</h3>
        {data.comments.length === 0 && <p>Комментариев пока нет.</p>}
        <ul className="task-detail-list">
          {data.comments.map((comment) => <li key={comment.id}>
            <strong>{names.get(comment.author_id) ?? 'Участник'}</strong>{' '}
            <time dateTime={comment.created_at}>{formatDate(comment.created_at)}</time>
            <p className="preserve-lines">{comment.body}</p>
          </li>)}
        </ul>
        {canWork && <form className="inline-form" onSubmit={addComment}>
          <label>Комментарий<textarea name="comment" required /></label>
          <button className="button" disabled={pending}>Добавить комментарий</button>
        </form>}
      </section>
      <section>
        <h3>История изменений</h3>
        {data.log.length === 0 && <p>Записей пока нет.</p>}
        <ul className="task-detail-list">
          {data.log.map((entry) => <li key={entry.id}>
            <time dateTime={entry.changed_at}>{formatDate(entry.changed_at)}</time>
            {' · '}{names.get(entry.actor_id ?? '') ?? 'Система или недоступный участник'}
            {' · '}{entry.action === 'insert' ? 'добавление' : 'изменение'}
            {' · '}{({
              tasks: 'задача', task_assignees: 'назначение', task_checklist: 'чек-лист', task_comments: 'комментарий',
            })[entry.entity_type] ?? 'запись'}
          </li>)}
        </ul>
      </section>
    </>}
    <TaskFiles client={client} eventId={eventId} taskId={taskId} canUpload={canWork} />
  </>
}
