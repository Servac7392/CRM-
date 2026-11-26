import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ControlDatesEditor, ControlDatesSummary, counterpartyStatuses, formatAmount, parseAmount, readControlDates,
  type ControlDate, type CounterpartyStatus,
} from './CounterpartyFields'
import { managesDepartment, pages, type Department, type EventWorkspace } from './events'
import { SponsorDetails, SponsorEditor, sponsorColumns, sponsorStatuses, type Sponsor } from './SponsorsWorkspace'

type Counterparty = {
  id: string
  name: string
  status: CounterpartyStatus
  amount: number | null
  notes: string | null
  control_dates: ControlDate[]
  updated_at: string
}
type ListRow = { id: string; name: string; status: string; amount: number | null; amountLabel?: string }
type DirectionProps = { client: SupabaseClient; model: EventWorkspace; department: Department }

const counterpartyColumns = 'id,name,status,amount,notes,control_dates,updated_at'
const sponsorListColumns = 'id,company,status,received_amount,pledged_amount'
const counterpartyListColumns = 'id,name,status,amount'

function labelsFor(department: Department) {
  if (department.sponsor_workspace) {
    return { list: 'Список спонсоров', add: 'Добавить спонсора', create: 'Новый спонсор', name: 'Компания', amount: 'Сумма' }
  }
  const name = department.name.trim().toLowerCase()
  if (name.startsWith('концерт')) {
    return { list: 'Артисты и коллективы', add: 'Добавить исполнителя', create: 'Новый исполнитель',
      name: 'Имя исполнителя или название коллектива', amount: 'Стоимость участия' }
  }
  if (name.startsWith('ресторан')) {
    return { list: 'Заведения', add: 'Добавить заведение', create: 'Новое заведение', name: 'Название заведения', amount: 'Сумма' }
  }
  return { list: 'Контрагенты', add: 'Добавить контрагента', create: 'Новый контрагент', name: 'Название', amount: 'Сумма' }
}

function directionPath(eventId: string, departmentId: string) {
  return `/events/${eventId}/directions/${departmentId}`
}

export function DirectionRecords({ client, model, department }: DirectionProps) {
  const [rows, setRows] = useState<ListRow[] | null>(null)
  const [error, setError] = useState(false)
  const eventId = model.event.id
  const { id: departmentId, sponsor_workspace: sponsors } = department
  const base = directionPath(eventId, departmentId)
  const labels = labelsFor(department)

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    const counterparties = pages<Pick<Counterparty, 'id' | 'name' | 'status' | 'amount'>>((from, to) =>
      client.from('direction_cards').select(counterpartyListColumns).eq('event_id', eventId).eq('department_id', departmentId)
        .order('name').order('id').range(from, to).abortSignal(signal))
      .then((records) => records.map((record) => ({ ...record, status: counterpartyStatuses[record.status] })))
    const load = sponsors
      ? Promise.all([
        counterparties,
        pages<Pick<Sponsor, 'id' | 'company' | 'status' | 'received_amount' | 'pledged_amount'>>((from, to) =>
          client.from('sponsors').select(sponsorListColumns).eq('event_id', eventId).eq('department_id', departmentId)
            .order('company').order('id').range(from, to).abortSignal(signal)),
      ]).then(([cards, sponsors]) => [
        ...cards,
        ...sponsors.map((record) => ({
          id: record.id, name: record.company, status: sponsorStatuses[record.status],
          amount: record.received_amount ?? record.pledged_amount,
          amountLabel: record.received_amount == null ? 'Обещано' : 'Получено',
        })),
      ].sort((left, right) => left.name.localeCompare(right.name, 'ru') || left.id.localeCompare(right.id)))
      : counterparties

    void load.then((records) => { if (!signal.aborted) setRows(records) })
      .catch(() => { if (!signal.aborted) setError(true) })
    return () => controller.abort()
  }, [client, eventId, departmentId, sponsors])

  return <section className="direction-records" aria-labelledby="direction-records-title">
    <div className="section-heading">
      <h3 id="direction-records-title">{labels.list}</h3>
      {!department.archived && managesDepartment(model, departmentId) &&
        <Link className="button button-primary" to={`${base}/cards/new`}>{labels.add}</Link>}
    </div>
    {error && <p role="alert" className="message error">Не удалось загрузить карточки.</p>}
    {!rows && !error && <p role="status">Загружаем карточки…</p>}
    {rows?.length === 0 && <p className="message">Карточек пока нет.</p>}
    {!!rows?.length && <table className="record-list" aria-labelledby="direction-records-title">
      <thead><tr><th scope="col">Название</th><th scope="col">Статус</th><th scope="col">{labels.amount}</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id}>
        <td><Link to={`${base}/cards/${row.id}`}>{row.name}</Link></td>
        <td>{row.status}</td>
        <td>{row.amount == null ? '—' : <>
          {row.amountLabel && <small>{row.amountLabel}</small>}
          {formatAmount(row.amount)}
        </>}</td>
      </tr>)}</tbody>
    </table>}
  </section>
}

export function DirectionRecordRoute({ client, model, creating = false }: {
  client: SupabaseClient; model: EventWorkspace; creating?: boolean
}) {
  const { departmentId, cardId } = useParams()
  const department = model.departments.find((row) => row.id === departmentId)
  if (!department) return <p className="message">Направление недоступно.</p>
  return <DirectionRecordPage key={`${department.id}/${cardId ?? 'new'}`}
    client={client} model={model} department={department} cardId={creating ? undefined : cardId} />
}

function DirectionRecordPage({ client, model, department, cardId }: DirectionProps & { cardId?: string }) {
  const [record, setRecord] = useState<Sponsor | Counterparty | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [savedNotice, setSavedNotice] = useState(false)
  const navigate = useNavigate()
  const eventId = model.event.id
  const { id: departmentId, sponsor_workspace: sponsors } = department
  const base = directionPath(eventId, departmentId)
  const labels = labelsFor(department)
  const canManage = managesDepartment(model, departmentId)
  const creating = cardId == null
  const isSponsor = record && 'company' in record
  const canEdit = canManage || (isSponsor && record.owner_id === model.userId)

  useEffect(() => {
    if (!cardId) return
    if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(cardId)) {
      setError('Карточка недоступна.')
      return
    }
    const controller = new AbortController()
    const read = (table: string, columns: string) => client.from(table).select(columns)
      .eq('event_id', eventId).eq('department_id', departmentId).eq('id', cardId).abortSignal(controller.signal)
      .maybeSingle<Sponsor | Counterparty>()
    const load = async () => {
      if (sponsors) {
        const sponsor = await read('sponsors', sponsorColumns)
        if (sponsor.data || sponsor.error) return sponsor
      }
      // A direction enabled for sponsors may already have regular cards from before its rename.
      return read('direction_cards', counterpartyColumns)
    }
    void load().then(({ data, error: loadError }) => {
      if (controller.signal.aborted) return
      if (loadError) setError('Не удалось загрузить карточку.')
      else if (!data) setError('Карточка недоступна.')
      else setRecord(data)
    }).catch(() => { if (!controller.signal.aborted) setError('Не удалось загрузить карточку.') })
    return () => controller.abort()
  }, [client, eventId, departmentId, sponsors, cardId])

  function saved(value: Sponsor | Counterparty) {
    if (creating) navigate(`${base}/cards/${value.id}`, { replace: true })
    else {
      setRecord(value)
      setEditing(false)
      setSavedNotice(true)
    }
  }

  function cancel() {
    if (creating) navigate(base)
    else setEditing(false)
  }

  return <article className="panel direction-record-page">
    <Link className="back-link" to={base}>К списку</Link>
    {creating && (!canManage || department.archived) && <p className="message">Создание карточки недоступно.</p>}
    {error && <p role="alert" className="message error">{error}</p>}
    {!creating && !record && !error && <p role="status">Загружаем карточку…</p>}
    {(record || (creating && canManage && !department.archived)) && <>
      <div className="section-heading">
        <h2>{record ? ('company' in record ? record.company : record.name) : labels.create}</h2>
        {record && canEdit && !editing && <button type="button" className="button" onClick={() => {
          setSavedNotice(false)
          setEditing(true)
        }}>Редактировать</button>}
      </div>
      {savedNotice && <p role="status" className="message">Карточка сохранена.</p>}
      {(creating || (editing && canEdit)) ? (
        (creating ? sponsors : isSponsor)
          ? <SponsorEditor client={client} model={model} department={department}
            existing={isSponsor ? record : undefined} saved={saved} cancel={cancel} />
          : <CounterpartyEditor client={client} model={model} department={department}
            existing={record && 'name' in record ? record : undefined} saved={saved} cancel={cancel} />
      ) : record && ('company' in record
        ? <SponsorDetails sponsor={record} model={model} />
        : <CounterpartyDetails record={record} amountLabel={labels.amount} />)}
    </>}
  </article>
}

function CounterpartyDetails({ record, amountLabel }: { record: Counterparty; amountLabel: string }) {
  return <>
    <dl className="record-details">
      <div><dt>Статус</dt><dd>{counterpartyStatuses[record.status]}</dd></div>
      <div><dt>{amountLabel}</dt><dd>{formatAmount(record.amount)}</dd></div>
    </dl>
    {record.notes && <section className="record-detail-section">
      <h3>Комментарий</h3><p className="preserve-lines">{record.notes}</p>
    </section>}
    <ControlDatesSummary dates={record.control_dates} />
  </>
}

function CounterpartyEditor({ client, model, department, existing, saved, cancel }: DirectionProps & {
  existing?: Counterparty; saved: (record: Counterparty) => void; cancel: () => void
}) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const labels = labelsFor(department)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setError('')
    const form = new FormData(event.currentTarget)
    const value = (key: string) => String(form.get(key) ?? '').trim()
    const name = value('name')
    const amount = parseAmount(value('amount'), true)
    const controlDates = readControlDates(form)
    if (!name) return setError('Введите название.')
    if (amount === undefined) return setError('Укажите сумму в рублях, максимум два знака после запятой.')
    if (!controlDates) return setError('Укажите название и дату для каждого пункта.')

    const fields = { name, amount, status: value('status'), notes: value('notes') || null, control_dates: controlDates }
    const eventId = model.event.id
    const departmentId = department.id
    setPending(true)
    try {
      const table = client.from('direction_cards')
      const query = existing
        ? table.update(fields).eq('event_id', eventId).eq('department_id', departmentId)
          .eq('id', existing.id).eq('updated_at', existing.updated_at)
        : table.insert({ ...fields, event_id: eventId, department_id: departmentId })
      const { data, error: saveError } = await query.select(counterpartyColumns).maybeSingle<Counterparty>()
      if (saveError?.code === '23514') setError('Проверьте поля карточки и контрольные даты.')
      else if (saveError || !data) setError('Не удалось сохранить карточку. Проверьте права или обновите страницу.')
      else saved(data)
    } catch {
      setError('Не удалось сохранить карточку. Проверьте подключение.')
    } finally {
      setPending(false)
    }
  }

  return <form className="form task-form" onSubmit={submit}>
    <label>{labels.name}<input name="name" defaultValue={existing?.name} maxLength={200} required disabled={pending} /></label>
    <div className="filters">
      <label>Статус<select name="status" defaultValue={existing?.status ?? 'new'} disabled={pending}>
        {Object.entries(counterpartyStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <label>{labels.amount}, ₽<input name="amount" inputMode="decimal" defaultValue={existing?.amount ?? ''} disabled={pending} /></label>
    </div>
    <div className="field">
      <label htmlFor="counterparty-notes">Комментарий</label>
      <textarea id="counterparty-notes" name="notes" defaultValue={existing?.notes ?? ''} maxLength={4000} disabled={pending} />
    </div>
    <ControlDatesEditor dates={existing?.control_dates ?? []} disabled={pending} />
    {error && <p role="alert" className="message error">{error}</p>}
    <div className="form-buttons">
      <button className="button button-primary" disabled={pending}>Сохранить карточку</button>
      <button type="button" className="button" disabled={pending} onClick={cancel}>Отмена</button>
    </div>
  </form>
}
