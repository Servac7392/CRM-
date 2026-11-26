import { useRef, useState, type FormEvent } from 'react'
import { parseAmount } from './CounterpartyFields'
import { availableSeats, seatsPerTable, ticketWriteError, type TicketReservation, type TicketScope, type TicketTable } from './ticketInventory'
import { paymentLabels, type PaymentMethod } from './money'

type SaleEntry = {
  quantity: number
  amount: number
  payment_method: PaymentMethod
  table_number: number | null
}

export const saleColumns = 'id,quantity,amount,payment_method,created_at,table_number,reservation_id,revision,voided_at'
export type Sale = SaleEntry & {
  id: string; created_at: string; reservation_id: string | null; revision: number; voided_at: string | null
}

export function TicketSaleForm({ client, eventId, departmentId, tables, reservation, sale, refresh, done, cancel }:
  Pick<TicketScope, 'client' | 'eventId' | 'departmentId'> & {
    tables: TicketTable[]
    reservation?: TicketReservation
    sale?: Sale
    refresh: () => void
    done?: () => void
    cancel?: () => void
  }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [table, setTable] = useState(() => sale ? String(sale.table_number ?? 'unassigned') : '')
  const attempt = useRef<{ id: string; values: string } | null>(null)
  const selected = tables.find((row) => row.table_number === Number(table))
  const unassigned = sale?.table_number === null && table === 'unassigned'
  const quantityLimit = unassigned ? 2147483647 : seatsPerTable

  async function recordSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setSaved(false)
    const form = event.currentTarget
    const fields = new FormData(form)
    const quantity = reservation?.quantity ?? Number(fields.get('quantity'))
    const amount = parseAmount(String(fields.get('amount') ?? ''))
    const paymentMethod = fields.get('payment_method')
    const tableNumber = reservation?.table_number ?? selected?.table_number ?? null
    if ((!tableNumber && !unassigned) || !Number.isInteger(quantity) || quantity < 1 || quantity > quantityLimit || !amount ||
        (paymentMethod !== 'cash' && paymentMethod !== 'cashless')) {
      setError('Укажите стол, количество билетов, положительную сумму и способ оплаты.')
      return
    }

    const entry: SaleEntry = { quantity, amount: Number(amount), payment_method: paymentMethod,
      table_number: tableNumber }
    setPending(true)
    setError('')
    try {
      function findSale(id: string) {
        return client.from('ticket_sales').select(saleColumns)
          .eq('event_id', eventId).eq('department_id', departmentId).eq('id', id).maybeSingle<Sale>()
      }
      function matches(data: Sale | null) {
        return data?.voided_at === null && data.amount === entry.amount && data.quantity === entry.quantity &&
          data.payment_method === entry.payment_method && data.table_number === entry.table_number
      }

      if (sale) {
        const { data, error: writeError } = await client.from('ticket_sales').update(entry)
          .eq('event_id', eventId).eq('department_id', departmentId).eq('id', sale.id)
          .eq('revision', sale.revision).select('id').maybeSingle()
        if (writeError) throw writeError
        if (!data) {
          const current = await findSale(sale.id)
          if (current.error) throw current.error
          if (!matches(current.data)) {
            refresh()
            throw new Error('ticket_sale_changed')
          }
        }
      } else {
        const values = JSON.stringify(entry)
        if (attempt.current?.values !== values) attempt.current = { id: crypto.randomUUID(), values }
        const { id } = attempt.current
        const reservationId = reservation?.id ?? null
        const result = await client.from('ticket_sales')
          .insert({ id, event_id: eventId, department_id: departmentId, reservation_id: reservationId, ...entry })
        if (result.error?.code === '23505') {
          const { data, error: readError } = await findSale(id)
          if (readError || !matches(data) || data?.reservation_id !== reservationId) {
            if (reservation && !readError) throw new Error('ticket_reservation_inactive')
            throw result.error
          }
        } else if (result.error) throw result.error
        attempt.current = null
        form.reset()
        setTable('')
        setSaved(true)
      }
      refresh()
      done?.()
    } catch (cause) {
      if (typeof cause === 'object' && cause && 'code' in cause && cause.code === '23514') refresh()
      setError(ticketWriteError(cause, 'Не удалось подтвердить запись продажи. Повторите сохранение с теми же данными.'))
    } finally {
      setPending(false)
    }
  }

  const label = sale ? 'Редактирование продажи' : reservation ? 'Выкуп брони' : 'Новая продажа'
  return <>
    {sale?.reservation_id && <p>Стол и количество мест в выкупленной брони обновятся вместе с продажей.</p>}
    <form className="inline-form ticket-entry-form" aria-label={label} onSubmit={recordSale}>
      {!reservation && <>
        <label>Стол<select name="table_number" value={table} onChange={(event) => setTable(event.currentTarget.value)} required disabled={pending}>
          <option value="">Выберите стол</option>
          {sale?.table_number === null && <option value="unassigned">Без стола</option>}
          {tables.map((row) => {
            const seats = availableSeats(row) + (sale && row.table_number === sale.table_number ? sale.quantity : 0)
            return <option key={row.table_number} value={row.table_number} disabled={!seats && row !== selected}>
              № {row.table_number} · {sale ? 'доступно' : 'свободно'} {seats}
            </option>
          })}
        </select></label>
        <label>Количество билетов<input type="number" inputMode="numeric" name="quantity" min="1" step="1"
          max={quantityLimit} defaultValue={sale?.quantity} required disabled={pending || (!selected && !unassigned)} /></label>
      </>}
      <label>Общая сумма, ₽<input name="amount" inputMode="decimal" defaultValue={sale?.amount} required disabled={pending} /></label>
      <label>Способ оплаты<select name="payment_method" defaultValue={sale?.payment_method ?? ''} required disabled={pending}>
        <option value="" disabled>Выберите способ</option>
        <option value="cash">{paymentLabels.cash}</option>
        <option value="cashless">{paymentLabels.cashless}</option>
      </select></label>
      <button className="button button-primary" disabled={pending || (!reservation && !selected && !unassigned)}>
        {pending ? 'Сохраняем…' : sale ? 'Сохранить изменения' : reservation ? 'Подтвердить выкуп' : 'Записать продажу'}
      </button>
      {cancel && <button type="button" className="button" disabled={pending} onClick={cancel}>Отмена</button>}
    </form>
    {error && <p className="message error" role="alert">{error}</p>}
    {saved && <p className="message" role="status">Продажа записана.</p>}
  </>
}
