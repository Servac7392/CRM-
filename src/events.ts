import type { SupabaseClient } from '@supabase/supabase-js'

export const eventStatuses = { active: 'Активное', planned: 'Будущее', archived: 'Архивное' }
export const taskStatuses = {
  new: 'Новая',
  in_progress: 'В работе',
  decision: 'Ожидает решения',
  blocked: 'Заблокирована',
  done: 'Выполнена',
  cancelled: 'Отменена',
}
export const taskPriorities = { low: 'Низкий', normal: 'Обычный', high: 'Высокий' }
export const taskAmountKinds = { expense: 'Расход', income: 'Поступление' }

export type EventSummary = {
  id: string
  name: string
  starts_at: string
  venue: string | null
  status: keyof typeof eventStatuses
  updated_at: string
}

type SectionSummary = { id: string; name: string; archived: boolean; updated_at: string }
export type Department = SectionSummary & { sponsor_workspace: boolean; ticket_workspace: boolean }

const tabPaths = { dashboard: '', finance: '/finance', directions: '/directions', tasks: '/tasks', team: '/team', settings: '/settings' }
type BuiltinTab = keyof typeof tabPaths
export type EventTab = SectionSummary & { builtin: BuiltinTab | null; body: string }
export type DepartmentMembership = { department_id: string; user_id: string; active: boolean }
export type TeamProfile = { id: string; display_name: string }
export type Task = {
  id: string
  department_id: string
  parent_id: string | null
  owner_id: string
  title: string
  description: string | null
  result: string | null
  status: keyof typeof taskStatuses
  priority: keyof typeof taskPriorities | null
  amount: number | null
  amount_kind: keyof typeof taskAmountKinds
  due_at: string | null
  updated_at: string
}

const timezone = 'Asia/Vladivostok'
const dateTime = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeStyle: 'short', timeZone: timezone })
const calendarDay = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric', month: 'numeric', day: 'numeric', timeZone: timezone,
})
const localMinute = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23', timeZone: timezone,
})
const utcOffset = new Intl.DateTimeFormat('en', { timeZoneName: 'longOffset', timeZone: timezone })

export const formatDate = (value: string) => dateTime.format(new Date(value))
export const deadlineInput = (value: string) => localMinute.format(new Date(value)).replace(' ', 'T')
export const deadlineDay = (value: string) => deadlineInput(value).slice(0, 10)

export function parseDeadline(value: string) {
  const offset = utcOffset.formatToParts(new Date(`${value}Z`)).find((part) => part.type === 'timeZoneName')
  if (!offset) throw new Error('Не удалось определить часовой пояс срока.')
  const timestamp = new Date(`${value}${offset.value.replace('GMT', '')}`)
  if (deadlineInput(timestamp.toISOString()) !== value) throw new Error('Укажите корректный срок.')
  return timestamp.toISOString()
}

export function daysUntil(value: string, now: Date) {
  const [start, current] = [new Date(value), now].map((date) => {
    const { year, month, day } = Object.fromEntries(calendarDay.formatToParts(date).map(({ type, value }) => [type, value]))
    return Date.UTC(Number(year), Number(month) - 1, Number(day))
  })
  return Math.round((start - current) / 86_400_000)
}

export function isOverdue(task: Task, now: number) {
  return (
    task.status !== 'done' && task.status !== 'cancelled' &&
    task.due_at !== null && Date.parse(task.due_at) < now
  )
}

const eventColumns = 'id,name,starts_at,venue,status,updated_at'
const departmentMembershipColumns = 'department_id,user_id,active'

export async function pages<T>(
  getPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
) {
  const rows: T[] = []
  const size = 200
  for (let from = 0; ; from += size) {
    const { data, error } = await getPage(from, from + size - 1)
    if (error || !data) throw new Error('Не удалось загрузить данные.')
    rows.push(...data)
    if (data.length < size) return rows
  }
}

export function loadEvents(client: SupabaseClient, signal: AbortSignal) {
  return pages<EventSummary>((from, to) => client.from('events').select(eventColumns)
    .order('starts_at').order('id').range(from, to).abortSignal(signal))
}

export async function loadEvent(client: SupabaseClient, eventId: string, userId: string, signal: AbortSignal) {
  const event = await client.from('events').select(eventColumns)
    .eq('id', eventId).abortSignal(signal).maybeSingle<EventSummary>()
  if (event.error) throw new Error('Не удалось загрузить мероприятие.')
  if (!event.data) return null

  const [departments, tabs, tasks, teammates, membership, departmentMemberships, assignments] = await Promise.all([
    pages<Department>((from, to) => client.from('departments').select('id,name,archived,sponsor_workspace,ticket_workspace,updated_at')
      .eq('event_id', eventId).order('name').order('id').range(from, to).abortSignal(signal)),
    pages<EventTab>((from, to) => client.from('event_tabs').select('id,builtin,name,body,archived,updated_at')
      .eq('event_id', eventId).order('created_at').order('id').range(from, to).abortSignal(signal)),
    pages<Task>((from, to) => client.from('tasks')
      .select('id,department_id,parent_id,owner_id,title,description,result,status,priority,amount,amount_kind,due_at,updated_at')
      .eq('event_id', eventId).order('id').range(from, to).abortSignal(signal)),
    pages<{ profiles: TeamProfile | null }>((from, to) => client.from('event_members')
      .select('profiles(id,display_name)').eq('event_id', eventId).eq('active', true)
      .order('user_id').range(from, to).abortSignal(signal).returns<{ profiles: TeamProfile | null }[]>()),
    client.from('event_members').select('role').eq('event_id', eventId)
      .eq('user_id', userId).eq('active', true).abortSignal(signal).maybeSingle<{ role: string }>(),
    pages<DepartmentMembership>((from, to) => client.from('department_members').select(departmentMembershipColumns)
      .eq('event_id', eventId).order('department_id').order('user_id').range(from, to).abortSignal(signal)),
    pages<{ task_id: string }>((from, to) => client.from('task_assignees').select('task_id')
      .eq('event_id', eventId).eq('user_id', userId).eq('active', true)
      .order('task_id').range(from, to).abortSignal(signal)),
  ])
  if (membership.error) throw new Error('Не удалось проверить права.')
  if (!membership.data) return null

  return {
    event: event.data,
    userId,
    departments,
    tabs,
    tasks,
    teammates: teammates.flatMap(({ profiles }) => profiles ? [profiles] : []),
    coordinator: membership.data.role === 'coordinator',
    departmentMemberships,
    assignedTasks: new Set(assignments.map((row) => row.task_id)),
  }
}

export type EventWorkspace = NonNullable<Awaited<ReturnType<typeof loadEvent>>>

export function managesDepartment(model: EventWorkspace, departmentId: string) {
  return model.coordinator || model.departmentMemberships.some((membership) =>
    membership.department_id === departmentId && membership.user_id === model.userId && membership.active)
}

export function canEditTaskAmount(model: EventWorkspace, task: Task) {
  return managesDepartment(model, task.department_id) || task.owner_id === model.userId || model.assignedTasks.has(task.id)
}

export async function saveDepartmentLeadership(client: SupabaseClient, model: EventWorkspace, membership: DepartmentMembership) {
  const { department_id, user_id, active } = membership
  const eventId = model.event.id
  const exists = model.departmentMemberships.some((row) => row.department_id === department_id && row.user_id === user_id)
  if (!exists && active) {
    const inserted = await client.from('department_members').insert({ event_id: eventId, ...membership })
      .select(departmentMembershipColumns).single<DepartmentMembership>()
    if (inserted.error?.code !== '23505') return inserted
  }
  return client.from('department_members').update({ active })
    .eq('event_id', eventId).eq('department_id', department_id).eq('user_id', user_id)
    .select(departmentMembershipColumns).single<DepartmentMembership>()
}

export function eventTabPath(base: string, tab: EventTab) {
  return tab.builtin ? base + tabPaths[tab.builtin] : `${base}/pages/${tab.id}`
}

export function orderedEventTabs(model: EventWorkspace) {
  const order = Object.keys(tabPaths)
  const rank = (tab: EventTab) => tab.builtin ? order.indexOf(tab.builtin) : order.length
  return [...model.tabs].sort((left, right) => rank(left) - rank(right))
}

export function eventTabTitle(model: EventWorkspace, tab: BuiltinTab, fallback: string) {
  return model.tabs.find((row) => row.builtin === tab)?.name ?? fallback
}
