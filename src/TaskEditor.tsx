import { useId, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { SupabaseClient } from '@supabase/supabase-js'
import { canEditTaskAmount, deadlineInput, managesDepartment, parseDeadline, taskAmountKinds, taskPriorities, taskStatuses, type EventWorkspace, type Task } from './events'
import { parseAmount } from './CounterpartyFields'

export function TaskEditor({ client, model, task, saved, cancel }: {
  client: SupabaseClient
  model: EventWorkspace
  task?: Task
  saved: () => void
  cancel: () => void
}) {
  const allManaged = model.departments.filter((row) => managesDepartment(model, row.id) &&
    (!row.archived || row.id === task?.department_id))
  const canManage = !task || managesDepartment(model, task.department_id)
  const canEditAmount = !task || canEditTaskAmount(model, task)
  const canEditProgress = canManage || (!!task && task.status !== 'cancelled' && model.assignedTasks.has(task.id))
  const [params] = useSearchParams()
  const requestedDepartment = allManaged.find((row) => row.id === params.get('department'))
  const [departmentId, setDepartmentId] = useState(task?.department_id ?? requestedDepartment?.id ?? allManaged[0]?.id ?? '')
  const [parentId, setParentId] = useState(task?.parent_id ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const fieldId = useId()
  const navigate = useNavigate()
  const base = `/events/${model.event.id}/tasks`
  const parents = model.tasks.filter((parent) => parent.department_id === departmentId && parent.id !== task?.id)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setError('')
    setPending(true)
    const form = new FormData(event.currentTarget)
    const value = (name: string) => String(form.get(name) ?? '').trim()
    try {
      const progress = canEditProgress ? { status: value('status'), result: value('result') || null } : {}
      const amount = canEditAmount ? parseAmount(value('amount'), true) : null
      const amountKind = value('amount_kind')
      if (canEditAmount && (amount === undefined || (amountKind !== 'expense' && amountKind !== 'income'))) {
        setError('Укажите сумму в рублях с точностью до двух знаков после запятой и выберите тип суммы.')
        return
      }
      const money = canEditAmount ? { amount, amount_kind: amountKind } : {}
      const deadline = value('due')
      const managed = canManage ? {
        department_id: departmentId,
        parent_id: parentId || null,
        title: value('title'),
        description: value('description') || null,
        owner_id: value('owner'),
        priority: value('priority') || null,
        due_at: deadline ? (task?.due_at && deadlineInput(task.due_at) === deadline ? task.due_at : parseDeadline(deadline)) : null,
      } : {}
      const query = task
        ? client.from('tasks').update({ ...progress, ...money, ...managed }).eq('event_id', model.event.id)
          .eq('id', task.id).eq('updated_at', task.updated_at)
        : client.from('tasks').insert({ ...managed, ...progress, ...money, event_id: model.event.id })
      const { data, error: writeError } = await query.select('id').maybeSingle<{ id: string }>()
      if (writeError?.message === 'Направление в архиве') {
        setError('Направление в архиве. Выберите активное направление.')
      } else if (writeError?.code === '23514' || writeError?.code === '23503') {
        setError('Проверьте родительскую задачу и ответственного. Связи должны оставаться в пределах мероприятия и направления.')
      } else if (writeError) {
        setError('Не удалось сохранить задачу.')
      } else if (!data) {
        setError('Задача изменилась или стала недоступна. Обновите страницу перед редактированием.')
      } else {
        saved()
        navigate(`${base}/${data.id}`)
      }
    } catch {
      setError('Не удалось сохранить задачу. Проверьте заполнение полей и подключение.')
    } finally {
      setPending(false)
    }
  }

  if (!task && !allManaged.length) return <section className="panel">
    <h2>Создание задачи недоступно.</h2>
    <Link to={base}>Все задачи</Link>
  </section>
  if (task && !canEditAmount) return null

  return <form className="form task-form" onSubmit={submit}>
    <h2>{task ? 'Редактирование задачи' : 'Новая задача'}</h2>
    {canManage && <>
      <label>Название<input name="title" required defaultValue={task?.title} /></label>
      <div className="field">
        <label htmlFor={`${fieldId}-description`}>Описание</label>
        <textarea id={`${fieldId}-description`} name="description" defaultValue={task?.description ?? ''} />
      </div>
      <div className="filters">
        <label>Направление<select value={departmentId} onChange={(e) => {
          setDepartmentId(e.target.value)
          setParentId('')
        }} required>
          {allManaged.map((department) => <option value={department.id} key={department.id}>
            {department.name}{department.archived ? ' (в архиве)' : ''}
          </option>)}
        </select></label>
        <label>Родительская задача<select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">Без родительской задачи</option>
          {parents.map((parent) => <option value={parent.id} key={parent.id}>{parent.title}</option>)}
        </select></label>
        <label>Ответственный<select name="owner" required defaultValue={task?.owner_id ?? ''}>
          <option value="">Выберите ответственного</option>
          {task && !model.teammates.some((person) => person.id === task.owner_id) &&
            <option value={task.owner_id}>Текущий ответственный недоступен</option>}
          {model.teammates.map((person) => <option value={person.id} key={person.id}>{person.display_name}</option>)}
        </select></label>
        <label>Приоритет<select name="priority" defaultValue={task?.priority ?? ''}>
          <option value="">Без приоритета</option>
          {Object.entries(taskPriorities).map(([value, name]) => <option value={value} key={value}>{name}</option>)}
        </select></label>
        <label>Срок по Владивостоку<input name="due" type="datetime-local"
          defaultValue={task?.due_at ? deadlineInput(task.due_at) : ''} /></label>
      </div>
    </>}
    {canEditAmount && <div className="filters">
      <label>Сумма, ₽<input name="amount" inputMode="decimal" defaultValue={task?.amount ?? ''} disabled={pending} /></label>
      <label htmlFor={`${fieldId}-amount-kind`}>Тип суммы
        <select id={`${fieldId}-amount-kind`} name="amount_kind" defaultValue={task?.amount_kind ?? 'expense'} disabled={pending}>
          <option value="expense">{taskAmountKinds.expense}</option>
          <option value="income">{taskAmountKinds.income}</option>
        </select>
      </label>
    </div>}
    {canEditProgress && <>
      <label>Статус<select name="status" defaultValue={task?.status ?? 'new'}>
        {Object.entries(taskStatuses).filter(([value]) => canManage || value !== 'cancelled')
          .map(([value, name]) => <option value={value} key={value}>{name}</option>)}
      </select></label>
      <div className="field">
        <label htmlFor={`${fieldId}-result`}>Результат</label>
        <textarea id={`${fieldId}-result`} name="result" defaultValue={task?.result ?? ''} />
      </div>
    </>}
    {error && <p role="alert" className="message error">{error}</p>}
    <div className="form-buttons">
      <button className="button button-primary" disabled={pending}>Сохранить задачу</button>
      <button className="button" type="button" disabled={pending} onClick={cancel}>Отмена</button>
    </div>
  </form>
}
