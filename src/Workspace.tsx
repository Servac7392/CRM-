import { useEffect, useState } from 'react'
import { HashRouter, Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  canEditTaskAmount, daysUntil, deadlineDay, eventStatuses, eventTabPath, eventTabTitle, formatDate, isOverdue, loadEvent, loadEvents,
  managesDepartment, orderedEventTabs, taskAmountKinds, taskPriorities, taskStatuses,
  type DepartmentMembership, type EventSummary, type EventWorkspace, type Task,
} from './events'
import { TaskEditor } from './TaskEditor'
import { TaskDetails } from './TaskDetails'
import { EventSettings, EventTeam } from './EventAdministration'
import { EventSections } from './EventSections'
import { DirectionLeadership } from './DirectionLeadership'
import { DirectionRecordRoute, DirectionRecords } from './DirectionRecords'
import { TicketWorkspace } from './TicketWorkspace'
import { EventFinances } from './EventFinances'
import { formatAmount } from './CounterpartyFields'

type RequestState<T> = { data: T; error?: never } | { error: string; data?: never } | null
type EventReader = { client: SupabaseClient; userId: string }

export default function Workspace({ client, userId, onSignOut, signOutFailed }: EventReader & {
  onSignOut: () => void
  signOutFailed: boolean
}) {
  return (
    <HashRouter>
      <header className="site-header">
        <div className="site-header-inner">
          <Link className="brand" to="/">CRM</Link>
          <nav aria-label="Основное меню" className="event-nav"><Link to="/">Мой рабочий стол</Link><Link to="/events">Мероприятия</Link></nav>
          <button type="button" className="button" onClick={onSignOut}>Выйти</button>
        </div>
      </header>
      <main className="workspace">
        {signOutFailed && <p role="alert" className="message error">Не удалось выйти. Попробуйте ещё раз.</p>}
        <Routes>
          <Route path="/" element={<PersonalDashboard client={client} userId={userId} />} />
          <Route path="/events" element={<EventList client={client} />} />
          <Route path="/events/:eventId/*" element={<EventRoute client={client} userId={userId} />} />
          <Route path="*" element={<Unavailable>Страница не найдена.</Unavailable>} />
        </Routes>
      </main>
    </HashRouter>
  )
}

function PersonalDashboard({ client, userId }: EventReader) {
  const [state, setState] = useState<RequestState<EventWorkspace[]>>(null)
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      const events = await loadEvents(client, controller.signal)
      const workspaces = await Promise.all(events.filter((event) => event.status !== 'archived')
        .map((event) => loadEvent(client, event.id, userId, controller.signal)))
      if (!controller.signal.aborted) setState({ data: workspaces.filter((model): model is EventWorkspace => model !== null) })
    })().catch(() => {
      if (!controller.signal.aborted) setState({ error: 'Не удалось загрузить рабочий стол.' })
    })
    return () => controller.abort()
  }, [client, userId])

  if (!state) return <p role="status">Загружаем рабочий стол…</p>
  if (state.error) return <p role="alert" className="message error">{state.error}</p>

  const now = Date.now()
  const mine = state.data.flatMap((model) => model.tasks
    .filter((task) => (task.owner_id === userId || model.assignedTasks.has(task.id)) &&
      task.status !== 'done' && task.status !== 'cancelled')
    .map((task) => ({ task, model })))
  const overdue = mine.filter(({ task }) => isOverdue(task, now)).length
  const today = mine.filter(({ task }) => task.due_at && !isOverdue(task, now) &&
    deadlineDay(task.due_at) === deadlineDay(new Date(now).toISOString())).length
  const ordered = [...mine].sort((a, b) =>
    (a.task.due_at ? Date.parse(a.task.due_at) : Infinity) -
    (b.task.due_at ? Date.parse(b.task.due_at) : Infinity))

  return <div className="dashboard">
    <div className="section-heading"><h1>Мой рабочий стол</h1><Link to="/events">Все мероприятия</Link></div>
    <ul className="card-grid metric-grid">
      <li className="panel metric"><strong>{mine.length}</strong><span>Мои открытые задачи</span></li>
      <li className="panel metric"><strong>{today}</strong><span>Срок сегодня</span></li>
      <li className="panel metric"><strong>{overdue}</strong><span>Просрочено</span></li>
    </ul>
    <section>
      <h2>Мои задачи</h2>
      {ordered.length === 0 ? <p className="message">Нет открытых задач, назначенных вам.</p> :
        <ul className="card-grid">{ordered.slice(0, 20).map(({ task, model }) =>
          <li className="panel" key={task.id}>
            <Link className="card-title" to={`/events/${model.event.id}/tasks/${task.id}`}>{task.title}</Link>
            <p>{model.event.name} · {taskStatuses[task.status]}</p>
            {task.due_at && <p>{isOverdue(task, now) ? 'Просрочено · ' : 'Срок · '}{formatDate(task.due_at)}</p>}
          </li>)}</ul>}
      {ordered.length > 20 && <p>Показаны первые 20 задач по сроку.</p>}
    </section>
    <section>
      <h2>Мои мероприятия</h2>
      <ul className="card-grid">{state.data.map((model) => <li className="panel" key={model.event.id}>
        <Link className="card-title" to={`/events/${model.event.id}`}>{model.event.name}</Link>
        <p>{model.coordinator ? 'Координатор' : 'Участник'} · {formatDate(model.event.starts_at)}</p>
      </li>)}</ul>
    </section>
  </div>
}

function EventList({ client }: { client: SupabaseClient }) {
  const [state, setState] = useState<RequestState<EventSummary[]>>(null)
  useEffect(() => {
    const controller = new AbortController()
    void loadEvents(client, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setState({ data }) })
      .catch(() => { if (!controller.signal.aborted) setState({ error: 'Не удалось загрузить мероприятия.' }) })
    return () => controller.abort()
  }, [client])

  return <>
    <h1>Мероприятия</h1>
    {!state && <p role="status">Загружаем мероприятия…</p>}
    {state?.error && <p role="alert" className="message error">{state.error}</p>}
    {state?.data?.length === 0 && <p className="message">У вас пока нет доступных мероприятий.</p>}
    <div className="event-list">
      {(['active', 'planned', 'archived'] as const).map((status) => {
        const events = state?.data?.filter((event) => event.status === status) ?? []
        if (events.length === 0) return null
        const heading = { active: 'Активные', planned: 'Будущие', archived: 'Архивные' }[status]
        return <section key={status} aria-label={heading}>
          <h2>{heading}</h2>
          <ul className="card-grid">
            {events.map((event) => <li key={event.id} className="panel">
              <Link className="card-title" to={`/events/${event.id}`}>{event.name}</Link>
              <p><time dateTime={event.starts_at}>{formatDate(event.starts_at)}</time></p>
              {event.venue && <p>{event.venue}</p>}
            </li>)}
          </ul>
        </section>
      })}
    </div>
  </>
}

function EventRoute(props: EventReader) {
  const { eventId } = useParams()
  return eventId && /^[0-9a-f-]{36}$/i.test(eventId)
    ? <EventPage key={eventId} eventId={eventId} {...props} />
    : <Unavailable>Мероприятие недоступно.</Unavailable>
}

function EventPage({ client, eventId, userId }: EventReader & { eventId: string }) {
  const [state, setState] = useState<RequestState<EventWorkspace | null>>(null)
  const [revision, setRevision] = useState(0)
  const navigate = useNavigate()
  useEffect(() => {
    const controller = new AbortController()
    void loadEvent(client, eventId, userId, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setState({ data }) })
      .catch(() => { if (!controller.signal.aborted) setState({ error: 'Не удалось загрузить мероприятие.' }) })
    return () => controller.abort()
  }, [client, eventId, userId, revision])

  if (!state) return <p role="status">Загружаем мероприятие…</p>
  if (state.error) return <p role="alert" className="message error">{state.error}</p>
  if (!state.data) return <Unavailable>Мероприятие недоступно.</Unavailable>

  const model = state.data
  const { event } = model
  const base = `/events/${event.id}`
  const tabs = orderedEventTabs(model).filter((tab) => !tab.archived &&
    (model.coordinator || (tab.builtin !== 'settings' && tab.builtin !== 'finance')))
  const firstTab = tabs[0]
  function refresh(preserveView = false) {
    if (!preserveView) setState(null)
    setRevision((current) => current + 1)
  }

  function leadershipSaved(membership: DepartmentMembership) {
    setState((current) => {
      if (!current?.data) return current
      const other = current.data.departmentMemberships.filter((row) =>
        row.department_id !== membership.department_id || row.user_id !== membership.user_id)
      return { data: { ...current.data, departmentMemberships: [...other, membership] } }
    })
  }
  return <>
    <div className="event-heading">
      <Link className="back-link" to="/events">Все мероприятия</Link>
      <h1>{event.name}</h1>
      <p>
        <span className="status">{eventStatuses[event.status]}</span>
        <time dateTime={event.starts_at}>{formatDate(event.starts_at)}</time>
        {event.venue && <span>{event.venue}</span>}
      </p>
    </div>
    <nav className="event-nav" aria-label="Разделы мероприятия">
      {tabs.map((tab) => <Link key={tab.id} to={eventTabPath(base, tab)}>{tab.name}</Link>)}
      {model.coordinator && <Link className="event-admin-link" to={`${base}/sections`}>Управление разделами</Link>}
    </nav>
    <Routes>
      <Route index element={
        !firstTab ? <p className="message">Для этого мероприятия нет активных вкладок.</p>
          : firstTab.builtin === 'dashboard' ? <Dashboard model={model} />
            : <Navigate replace to={eventTabPath(base, firstTab)} />
      } />
      <Route path="finance" element={model.coordinator
        ? <EventFinances model={model} client={client} />
        : <Unavailable>Финансы недоступны.</Unavailable>} />
      <Route path="directions" element={<Directions model={model} openDirection />} />
      <Route path="directions/new" element={model.coordinator
        ? <Navigate replace to={`${base}/sections?section=direction&edit=new`} />
        : <Unavailable>Создание направления недоступно.</Unavailable>} />
      <Route path="directions/:departmentId" element={<DirectionCard model={model} client={client}
        leadershipSaved={leadershipSaved} />} />
      <Route path="directions/:departmentId/cards/new" element={<DirectionRecordRoute client={client} model={model} creating />} />
      <Route path="directions/:departmentId/cards/:cardId" element={<DirectionRecordRoute client={client} model={model} />} />
      <Route path="tasks" element={<TaskList model={model} />} />
      <Route path="tasks/new" element={<TaskEditor client={client} model={model} saved={refresh} cancel={() => navigate(`${base}/tasks`)} />} />
      <Route path="tasks/:taskId" element={<TaskCard model={model} client={client} saved={refresh} />} />
      <Route path="team" element={<EventTeam model={model} client={client} saved={() => refresh(true)}
        leadershipSaved={leadershipSaved} />} />
      <Route path="settings" element={model.coordinator
        ? <EventSettings model={model} client={client} saved={() => { refresh(); navigate(base) }} />
        : <Unavailable>Настройки недоступны.</Unavailable>} />
      <Route path="sections" element={model.coordinator
        ? <EventSections client={client} model={model} saved={() => refresh(true)} />
        : <Unavailable>Управление разделами недоступно.</Unavailable>} />
      <Route path="pages/:tabId" element={<EventTextPage model={model} />} />
      <Route path="*" element={<Unavailable>Раздел недоступен.</Unavailable>} />
    </Routes>
  </>
}

function EventTextPage({ model }: { model: EventWorkspace }) {
  const { tabId } = useParams()
  const tab = model.tabs.find((row) => row.id === tabId && row.builtin === null)
  if (!tab || (tab.archived && !model.coordinator)) return <Unavailable>Вкладка недоступна.</Unavailable>
  return <section className="panel">
    <h2>{tab.name}</h2>
    {tab.archived && <p><span className="status">В архиве</span></p>}
    {tab.body && <p className="preserve-lines">{tab.body}</p>}
  </section>
}

function Dashboard({ model }: { model: EventWorkspace }) {
  const { event, tasks, coordinator } = model
  const parentIds = new Set(tasks.map((task) => task.parent_id))
  const leaves = tasks.filter((task) => !parentIds.has(task.id) && task.status !== 'cancelled')
  const now = new Date()
  const until = daysUntil(event.starts_at, now)
  const tasksUrl = `/events/${event.id}/tasks`
  const metrics = [
    { name: 'Всего задач', count: leaves.length, filter: 'leaf=1' },
    { name: 'Выполнено', count: leaves.filter((task) => task.status === 'done').length, filter: 'leaf=1&status=done' },
    { name: 'В работе', count: leaves.filter((task) => task.status === 'in_progress').length, filter: 'leaf=1&status=in_progress' },
    { name: 'Просрочено', count: leaves.filter((task) => isOverdue(task, now.getTime())).length, filter: 'leaf=1&deadline=overdue' },
    { name: 'Ожидает решения', count: leaves.filter((task) => task.status === 'decision').length, filter: 'leaf=1&status=decision' },
  ]
  const upcoming = leaves.filter((task) => task.due_at && !isOverdue(task, now.getTime()) && task.status !== 'done')
    .sort((left, right) => Date.parse(left.due_at!) - Date.parse(right.due_at!)).slice(0, 5)
  const overdue = leaves.filter((task) => isOverdue(task, now.getTime()))
    .sort((left, right) => Date.parse(left.due_at!) - Date.parse(right.due_at!)).slice(0, 5)
  const blocked = leaves.filter((task) => task.status === 'blocked')
  const decisions = leaves.filter((task) => task.status === 'decision')
  const finance = coordinator && model.tabs.find((tab) => tab.builtin === 'finance' && !tab.archived)
  return <div className="dashboard">
    <section>
      <div className="section-heading">
        <h2>{eventTabTitle(model, 'dashboard', 'Дашборд')}</h2>
        {finance && <Link className="button" to={eventTabPath(`/events/${event.id}`, finance)}>Открыть финансы</Link>}
      </div>
      {until >= 0 && <p>{until === 0 ? 'Мероприятие сегодня' : `Дней до мероприятия — ${until}`}</p>}
      <ul className="card-grid metric-grid">
        {metrics.map((metric) => <li key={metric.name}>
          <Link className="panel metric" to={`${tasksUrl}?${metric.filter}`}>
            <strong>{metric.count}</strong>
            <span>{metric.name}</span>
          </Link>
        </li>)}
      </ul>
    </section>
    <Directions model={model} />
    <div className="card-grid">
      <TaskSection title="Ближайшие дедлайны" tasks={upcoming} model={model} href={`${tasksUrl}?leaf=1&deadline=upcoming`} />
      <TaskSection title="Просрочки" tasks={overdue} model={model} href={`${tasksUrl}?leaf=1&deadline=overdue`} />
      <TaskSection title="Блокировки" tasks={blocked.slice(0, 5)} model={model} href={`${tasksUrl}?leaf=1&status=blocked`} />
      {coordinator && <TaskSection title="Требует моего решения" tasks={decisions.slice(0, 5)} model={model}
        href={`${tasksUrl}?leaf=1&status=decision`} />}
    </div>
  </div>
}

function Directions({ model, openDirection = false }: { model: EventWorkspace; openDirection?: boolean }) {
  const parentIds = new Set(model.tasks.map((task) => task.parent_id))
  const departments = model.departments.filter((department) => !department.archived)
  return <section>
    <div className="section-heading">
      <h2>{openDirection ? eventTabTitle(model, 'directions', 'Направления') : 'Направления'}</h2>
      {openDirection && model.coordinator && <Link className="button button-primary"
        to={`/events/${model.event.id}/directions/new`}>Новое направление</Link>}
    </div>
    {departments.length === 0 && <p className="message">Активных направлений пока нет.</p>}
    <ul className="card-grid">
      {departments.map((department) => {
        const leaves = model.tasks.filter((task) => task.department_id === department.id &&
          !parentIds.has(task.id) && task.status !== 'cancelled')
        const done = leaves.filter((task) => task.status === 'done').length
        const percent = leaves.length ? Math.round(100 * done / leaves.length) : null
        const directionUrl = `/events/${model.event.id}/directions/${department.id}`
        const taskUrl = `/events/${model.event.id}/tasks?department=${department.id}&leaf=1`
        const progress = percent === null ? null : `${percent}% · ${done} из ${leaves.length}`
        const hasWorkspace = department.sponsor_workspace || department.ticket_workspace
        return <li className="panel" key={department.id}>
          <Link className="card-title" to={openDirection || hasWorkspace ? directionUrl : taskUrl}>
            {department.name}
          </Link>
          {percent === null ? <p>Нет данных о задачах</p> : <>
            <p>{!openDirection && hasWorkspace
              ? <Link to={taskUrl} aria-label={`Задачи направления «${department.name}» — ${progress}`}>{progress}</Link>
              : progress}</p>
            <progress value={done} max={leaves.length} aria-label={`Выполнение направления «${department.name}»`} />
          </>}
        </li>
      })}
    </ul>
  </section>
}

function DirectionCard({ model, client, leadershipSaved }: {
  model: EventWorkspace; client: SupabaseClient; leadershipSaved: (membership: DepartmentMembership) => void
}) {
  const { departmentId } = useParams()
  const department = model.departments.find((item) => item.id === departmentId)
  if (!department) return <Unavailable>Направление недоступно.</Unavailable>
  const base = `/events/${model.event.id}`
  const tasks = model.tasks.filter((task) => task.department_id === department.id)
  return <section className="panel" key={department.id}>
    <Link className="back-link" to={`${base}/directions`}>Все направления</Link>
    <h2>{department.name}</h2>
    {department.archived && <p><span className="status">В архиве</span></p>}
    {model.coordinator && <p><Link to={`${base}/sections?section=direction&edit=${department.id}`}>
      Редактировать направление
    </Link></p>}
    <DirectionLeadership key={department.id} client={client} model={model} departmentId={department.id} saved={leadershipSaved} />
    {department.ticket_workspace && <TicketWorkspace client={client} eventId={model.event.id}
      departmentId={department.id} coordinator={model.coordinator}
      canManage={!department.archived && managesDepartment(model, department.id)} />}
    <DirectionRecords key={department.id} client={client} model={model} department={department} />
    <p><Link to={`${base}/tasks?department=${department.id}`}>Задачи направления</Link></p>
    {tasks.length > 0 ? <TaskRows tasks={tasks} model={model} /> : <p>Задач пока нет.</p>}
  </section>
}

function TaskSection({ title, tasks, model, href }: {
  title: string; tasks: Task[]; model: EventWorkspace; href: string
}) {
  return <section className="panel">
    <h2><Link to={href}>{title}</Link></h2>
    {tasks.length === 0 ? <p>Задач нет</p> : <TaskRows tasks={tasks} model={model} />}
  </section>
}

function TaskRows({ tasks, model }: { tasks: Task[]; model: EventWorkspace }) {
  const owners = new Map(model.teammates.map((person) => [person.id, person.display_name]))
  return <ul className="task-list">
    {tasks.map((task) => <li key={task.id}>
      <Link to={`/events/${model.event.id}/tasks/${task.id}`}>{task.title}</Link>
      <span>{owners.get(task.owner_id) ?? 'Нет имени'}{task.due_at && <> · <time dateTime={task.due_at}>{formatDate(task.due_at)}</time></>}</span>
    </li>)}
  </ul>
}

function TaskList({ model }: { model: EventWorkspace }) {
  const [params, setParams] = useSearchParams()
  const parentIds = new Set(model.tasks.map((task) => task.parent_id))
  const now = Date.now()
  const department = params.get('department') ?? ''
  const owner = params.get('owner') ?? ''
  const status = params.get('status') ?? ''
  const deadline = params.get('deadline') ?? ''
  const leaf = params.get('leaf') === '1'
  const calendar = params.get('view') === 'calendar'
  const month = params.get('month') ?? deadlineDay(new Date().toISOString()).slice(0, 7)
  const tasks = model.tasks.filter((task) => {
    return (!department || department === task.department_id) &&
      (!owner || owner === task.owner_id) &&
      (!status || status === task.status) &&
      (!leaf || (!parentIds.has(task.id) && task.status !== 'cancelled')) &&
      (deadline !== 'overdue' || isOverdue(task, now)) &&
      (deadline !== 'upcoming' || (task.due_at !== null && !isOverdue(task, now) &&
        task.status !== 'done' && task.status !== 'cancelled'))
  }).sort((a, b) => (a.due_at ? Date.parse(a.due_at) : Infinity) -
    (b.due_at ? Date.parse(b.due_at) : Infinity) || a.title.localeCompare(b.title, 'ru'))

  function filter(name: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(name, value)
    else next.delete(name)
    setParams(next)
  }

  return <section>
    <div className="section-heading">
      <h2>{eventTabTitle(model, 'tasks', 'Задачи')}</h2>
      {model.departments.some((row) => !row.archived && managesDepartment(model, row.id)) &&
        <Link className="button button-primary" to={`/events/${model.event.id}/tasks/new${department ? `?department=${department}` : ''}`}>
          Новая задача
        </Link>}
    </div>
    <div className="form-buttons view-switch">
      <button type="button" className="button" aria-pressed={!calendar} onClick={() => filter('view', '')}>Список</button>
      <button type="button" className="button" aria-pressed={calendar} onClick={() => filter('view', 'calendar')}>Календарь</button>
    </div>
    <div className="filters">
      <label>Направление<select value={department} onChange={(e) => filter('department', e.target.value)}>
        <option value="">Все направления</option>
        {model.departments.map((item) => <option value={item.id} key={item.id}>
          {item.name}{item.archived ? ' (в архиве)' : ''}
        </option>)}
      </select></label>
      <label>Ответственный<select value={owner} onChange={(e) => filter('owner', e.target.value)}>
        <option value="">Все ответственные</option>
        {model.teammates.map((person) => <option value={person.id} key={person.id}>{person.display_name}</option>)}
      </select></label>
      <label>Статус<select value={status} onChange={(e) => filter('status', e.target.value)}>
        <option value="">Все статусы</option>
        {Object.entries(taskStatuses).map(([value, name]) => <option value={value} key={value}>{name}</option>)}
      </select></label>
      <label>Срок<select value={deadline} onChange={(e) => filter('deadline', e.target.value)}>
        <option value="">Все сроки</option>
        <option value="overdue">Просроченные</option>
        <option value="upcoming">Предстоящие</option>
      </select></label>
      <label className="check-filter"><input type="checkbox" checked={leaf} onChange={(e) => filter('leaf', e.target.checked ? '1' : '')} />
        Конечные задачи без отменённых
      </label>
      {calendar && <label>Месяц<input type="month" value={month} onChange={(e) => filter('month', e.target.value)} /></label>}
    </div>
    {calendar ? <TaskCalendar tasks={tasks} model={model} month={month} /> :
      tasks.length === 0 ? <p className="message">Задач по этим фильтрам нет.</p> : <TaskRows tasks={tasks} model={model} />}
  </section>
}

function TaskCalendar({ tasks, model, month }: { tasks: Task[]; model: EventWorkspace; month: string }) {
  const byDay = new Map<string, Task[]>()
  for (const task of tasks) {
    if (!task.due_at) continue
    const day = deadlineDay(task.due_at)
    if (!day.startsWith(`${month}-`)) continue
    const onDay = byDay.get(day)
    if (onDay) onDay.push(task)
    else byDay.set(day, [task])
  }
  if (!byDay.size) return <p className="message">В этом месяце нет задач по выбранным фильтрам.</p>

  const label = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'long', weekday: 'long', timeZone: 'UTC',
  })
  return <div className="event-list">
    {Array.from(byDay, ([day, rows]) => <section className="panel" key={day}>
      <h3><time dateTime={day}>{label.format(new Date(day))}</time></h3>
      <TaskRows tasks={rows} model={model} />
    </section>)}
  </div>
}

function TaskCard({ model, client, saved }: { model: EventWorkspace; client: SupabaseClient; saved: () => void }) {
  const { taskId } = useParams()
  const task = model.tasks.find((row) => row.id === taskId)
  if (!task) return <Unavailable>Задача недоступна.</Unavailable>
  return <TaskArticle key={task.id} task={task} model={model} client={client} saved={saved} />
}

function TaskArticle({ task, model, client, saved }: {
  task: Task; model: EventWorkspace; client: SupabaseClient; saved: () => void
}) {
  const [editing, setEditing] = useState(false)
  const department = model.departments.find((row) => row.id === task.department_id)
  const parent = model.tasks.find((row) => row.id === task.parent_id)
  const owner = model.teammates.find((row) => row.id === task.owner_id)
  const children = model.tasks.filter((row) => row.parent_id === task.id)
  const base = `/events/${model.event.id}/tasks`
  const canManage = managesDepartment(model, task.department_id)
  const canWork = canManage || model.assignedTasks.has(task.id)
  return <article className="panel task-card">
    <Link className="back-link" to={base}>Все задачи</Link>
    <div className="section-heading">
      <h2>{task.title}</h2>
      {canEditTaskAmount(model, task) && !editing &&
        <button type="button" className="button" onClick={() => setEditing(true)}>Редактировать</button>}
    </div>
    {editing && <TaskEditor client={client} model={model} task={task}
      saved={() => { setEditing(false); saved() }} cancel={() => setEditing(false)} />}
    <dl>
      <div><dt>Статус</dt><dd>{taskStatuses[task.status]}</dd></div>
      {department && <div><dt>Направление</dt><dd><Link to={`${base}?department=${department.id}`}>{department.name}</Link></dd></div>}
      <div><dt>Ответственный</dt><dd>{owner?.display_name ?? 'Нет имени'}</dd></div>
      <div><dt>Сумма</dt><dd>{task.amount === null ? 'Не указана' : `${taskAmountKinds[task.amount_kind]} · ${formatAmount(task.amount)}`}</dd></div>
      {task.priority && <div><dt>Приоритет</dt><dd>{taskPriorities[task.priority]}</dd></div>}
      {task.due_at && <div><dt>Срок</dt><dd><time dateTime={task.due_at}>{formatDate(task.due_at)}</time></dd></div>}
      {parent && <div><dt>Родительская задача</dt><dd><Link to={`${base}/${parent.id}`}>{parent.title}</Link></dd></div>}
    </dl>
    {task.description && <section><h3>Описание</h3><p className="preserve-lines">{task.description}</p></section>}
    {task.result && <section><h3>Результат</h3><p className="preserve-lines">{task.result}</p></section>}
    {children.length > 0 && <section><h3>Подзадачи</h3><TaskRows tasks={children} model={model} /></section>}
    <TaskDetails client={client} model={model} task={task} canManage={canManage} canWork={canWork} />
  </article>
}

function Unavailable({ children }: { children: string }) {
  return <section className="panel">
    <h2>{children}</h2>
    <Link to="/">Перейти к мероприятиям</Link>
  </section>
}
