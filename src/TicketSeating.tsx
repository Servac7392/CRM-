import { useEffect, useRef, useState, type FormEvent } from 'react'
import { deadlineDay, pages } from './events'
import { TicketSaleForm } from './TicketSaleForm'
import { availableSeats, seatsPerTable, ticketWriteError, type TicketReservation, type TicketScope, type TicketTable } from './ticketInventory'

const columns = 'id,table_number,guest_name,quantity,reserved_until,status'
const dates = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'UTC' })
type SeatingProps = TicketScope & { tables: TicketTable[]; revision: number; refresh: () => void }

export function TicketSeating({ tables, revision, refresh, ...scope }: SeatingProps) {
  const { client, eventId, departmentId } = scope
  const [selected, setSelected] = useState(1)
  const [reservations, setReservations] = useState<TicketReservation[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState('')
  const [added, setAdded] = useState<number | null>(null)
  const addRequest = useRef<string | null>(null)
  const details = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    const controller = new AbortController()
    void pages<TicketReservation>((from, to) => client.from('ticket_reservations').select(columns)
      .eq('event_id', eventId).eq('department_id', departmentId)
      .order('created_at').order('id').range(from, to).abortSignal(controller.signal))
      .then((rows) => {
        if (!controller.signal.aborted) {
          setReservations(rows.reverse())
          setLoadError(false)
        }
      })
      .catch(() => { if (!controller.signal.aborted) setLoadError(true) })
    return () => controller.abort()
  }, [client, eventId, departmentId, revision])

  async function addTable() {
    if (adding) return
    addRequest.current ??= crypto.randomUUID()
    const requestId = addRequest.current
    setAdding(true)
    setAddError('')
    setAdded(null)
    try {
      const query = client.from('ticket_tables')
      const result = await query.insert({ event_id: eventId, department_id: departmentId, request_id: requestId })
        .select('table_number').single<{ table_number: number }>()
      const confirmed = result.error?.code === '23505'
        ? await query.select('table_number').eq('event_id', eventId).eq('department_id', departmentId)
          .eq('request_id', requestId).maybeSingle<{ table_number: number }>()
        : result
      if (confirmed.error || !confirmed.data) throw confirmed.error
      addRequest.current = null
      setAdded(confirmed.data.table_number)
      refresh()
    } catch {
      setAddError('Не удалось подтвердить добавление стола. Повторите попытку.')
    } finally {
      setAdding(false)
    }
  }

  const table = tables.find((row) => row.table_number === selected)
  const totals = tables.reduce((sum, row) => ({
    free: sum.free + availableSeats(row), reserved: sum.reserved + row.reserved_count, sold: sum.sold + row.sold_count,
  }), { free: 0, reserved: 0, sold: 0 })
  return <section className="record-detail-section" aria-labelledby="ticket-tables-heading">
    <div className="section-heading">
      <h3 id="ticket-tables-heading">Столы и бронирование</h3>
      {scope.canManage && <button type="button" className="button" disabled={adding} onClick={() => { void addTable() }}>
        {adding ? 'Добавляем…' : 'Добавить стол'}
      </button>}
    </div>
    {addError && <p className="message error" role="alert">{addError}</p>}
    {added !== null && <p className="message" role="status">Стол № {added} добавлен.</p>}
    <p>{tables.length} столов по {seatsPerTable} мест · Свободно {totals.free} · В резерве {totals.reserved} · Продано {totals.sold}</p>
    <ul className="ticket-table-grid" aria-label="Столы">
      {tables.map((row) => <li key={row.table_number}>
        <button type="button" className="ticket-table" aria-pressed={selected === row.table_number} onClick={() => {
          setSelected(row.table_number)
          details.current?.focus()
        }}>
          <strong>Стол № {row.table_number}</strong>
          {row.sold_count === seatsPerTable
            ? <span className="ticket-all-sold">Продан целиком</span>
            : <span>Свободно {availableSeats(row)} · Резерв {row.reserved_count} · Продано {row.sold_count}</span>}
        </button>
      </li>)}
    </ul>
    {table && <div className="panel">
      <h3 ref={details} tabIndex={-1}>Стол № {table.table_number}</h3>
      <p>Свободно {availableSeats(table)} · В резерве {table.reserved_count} · Продано {table.sold_count} из {seatsPerTable}</p>
      {loadError && <div className="form-buttons">
        <p className="message error" role="alert">Не удалось обновить список броней.</p>
        <button type="button" className="button" onClick={refresh}>Обновить брони</button>
      </div>}
      {!reservations && !loadError && <p role="status">Загружаем брони…</p>}
      <TableReservations key={selected} {...scope} table={table} tables={tables} refresh={refresh}
        reservations={reservations?.filter((row) => row.table_number === selected) ?? null} />
    </div>}
  </section>
}

function TableReservations({ client, eventId, departmentId, canManage, table, tables, reservations, refresh }:
  TicketScope & { table: TicketTable; tables: TicketTable[]; reservations: TicketReservation[] | null; refresh: () => void }) {
  const active = reservations?.filter(({ status }) => status === 'reserved')
  const history = reservations?.filter(({ status }) => status !== 'reserved') ?? []
  const today = deadlineDay(new Date().toISOString())
  const free = availableSeats(table)
  const [checkout, setCheckout] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState('')
  const attempt = useRef<{ id: string; values: string } | null>(null)

  async function reserve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const guestName = String(fields.get('guest_name') ?? '').trim()
    const quantity = Number(fields.get('quantity'))
    const reservedUntil = String(fields.get('reserved_until') ?? '')
    setFeedback('')
    if (!guestName || !Number.isInteger(quantity) || quantity < 1 || quantity > seatsPerTable || !reservedUntil || reservedUntil < today) {
      setError('Укажите имя, количество мест и срок брони.')
      return
    }

    const entry = { guest_name: guestName, quantity, reserved_until: reservedUntil, table_number: table.table_number }
    const values = JSON.stringify(entry)
    if (attempt.current?.values !== values) attempt.current = { id: crypto.randomUUID(), values }
    const { id } = attempt.current
    setBusy(true)
    setError('')
    try {
      const result = await client.from('ticket_reservations').insert({ id, event_id: eventId, department_id: departmentId, ...entry })
      if (result.error?.code === '23505') {
        const { data, error: readError } = await client.from('ticket_reservations').select(columns)
          .eq('event_id', eventId).eq('department_id', departmentId).eq('id', id).maybeSingle<TicketReservation>()
        if (readError || !data || data.table_number !== entry.table_number || data.guest_name !== guestName ||
            data.quantity !== quantity || data.reserved_until !== reservedUntil) throw result.error
      } else if (result.error) throw result.error
      attempt.current = null
      form.reset()
      setFeedback('Бронь записана.')
      refresh()
    } catch (cause) {
      if (typeof cause === 'object' && cause && 'code' in cause && cause.code === '23514') refresh()
      setError(ticketWriteError(cause, 'Не удалось подтвердить бронь. Повторите сохранение с теми же данными.'))
    } finally {
      setBusy(false)
    }
  }

  async function release(reservation: TicketReservation) {
    if (busy || !window.confirm(`Снять бронь «${reservation.guest_name}» и вернуть места в продажу?`)) return
    setBusy(true)
    setError('')
    setFeedback('')
    try {
      const query = client.from('ticket_reservations')
      const { data, error: updateError } = await query.update({ status: 'released' })
        .eq('event_id', eventId).eq('department_id', departmentId).eq('id', reservation.id).select('status').maybeSingle()
      if (updateError) throw updateError
      if (!data) {
        const current = await query.select('status').eq('event_id', eventId).eq('department_id', departmentId)
          .eq('id', reservation.id).maybeSingle()
        if (current.error) throw current.error
        if (current.data?.status !== 'released') throw new Error('ticket_reservation_inactive')
      }
      setFeedback('Бронь снята. Места снова свободны.')
    } catch (cause) {
      setError(ticketWriteError(cause, 'Не удалось подтвердить снятие брони.'))
    } finally {
      setBusy(false)
      refresh()
    }
  }

  function reservationFacts(reservation: TicketReservation) {
    return <>
      <strong>{reservation.guest_name}</strong>
      <p>Мест: {reservation.quantity} · До <time dateTime={reservation.reserved_until}>
        {dates.format(new Date(`${reservation.reserved_until}T00:00:00Z`))}
      </time></p>
    </>
  }

  return <>
    {canManage && (free > 0 || attempt.current) && <form className="inline-form ticket-entry-form" aria-label="Новая бронь" onSubmit={reserve}>
      <label>Кто бронирует<input name="guest_name" maxLength={200} required disabled={busy} /></label>
      <label>Количество мест<input name="quantity" type="number" inputMode="numeric" min="1" max={seatsPerTable}
        step="1" required disabled={busy} /></label>
      <label>Бронь до<input type="date" name="reserved_until" min={today} required disabled={busy} /></label>
      <button type="submit" className="button button-primary" disabled={busy}>Забронировать места</button>
    </form>}
    {error && <p className="message error" role="alert">{error}</p>}
    {feedback && <p className="message" role="status">{feedback}</p>}
    {active && !active.length && <p>Активных броней нет.</p>}
    {!!active?.length && <ul className="ticket-booking-list" aria-label="Активные брони">
      {active.map((reservation) => <li key={reservation.id}>
        <div className="section-heading">
          <div>{reservationFacts(reservation)}
            {reservation.reserved_until < today && <p><span className="status">Срок прошёл · места в резерве</span></p>}
          </div>
          {canManage && <div className="form-buttons">
            <button type="button" className="button" aria-expanded={checkout === reservation.id} disabled={busy}
              onClick={() => setCheckout(checkout === reservation.id ? null : reservation.id)}>Выкупить бронь</button>
            <button type="button" className="button" disabled={busy || checkout === reservation.id}
              onClick={() => { void release(reservation) }}>Снять бронь</button>
          </div>}
        </div>
        {canManage && checkout === reservation.id && <TicketSaleForm {...{ client, eventId, departmentId, tables, reservation, refresh }}
          done={() => { setCheckout(null); setFeedback('Бронь выкуплена. Оплата записана в журнал продаж.') }} />}
      </li>)}
    </ul>}
    {history.length > 0 && <details className="section-archive">
      <summary>История броней</summary>
      <ul className="ticket-booking-list">{history.map((reservation) => <li key={reservation.id}>
        {reservationFacts(reservation)}
        <span className="status">{reservation.status === 'sold' ? 'Выкуплена' : 'Снята'}</span>
      </li>)}</ul>
    </details>}
  </>
}
