import { Fragment, useEffect, useState } from 'react'
import { formatAmount } from './CounterpartyFields'
import { formatDate, pages } from './events'
import { TicketLayouts } from './TicketLayouts'
import { TicketSeating } from './TicketSeating'
import { TicketSaleForm, saleColumns, type Sale } from './TicketSaleForm'
import { type TicketScope, type TicketTable } from './ticketInventory'
import { formatKopecks, paymentLabels } from './money'
const counts = new Intl.NumberFormat('ru-RU')

export function TicketWorkspace({ coordinator, ...props }: TicketScope & { coordinator: boolean }) {
  const { client, eventId, departmentId } = props
  const [tables, setTables] = useState<TicketTable[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [revision, setRevision] = useState(0)
  const refresh = () => { setRevision((value) => value + 1) }

  useEffect(() => {
    const controller = new AbortController()
    void pages<TicketTable>((from, to) => client.from('ticket_tables').select('table_number,reserved_count,sold_count')
      .eq('event_id', eventId).eq('department_id', departmentId).order('table_number').range(from, to).abortSignal(controller.signal))
      .then((data) => {
        if (!controller.signal.aborted) {
          setTables(data)
          setLoadError(false)
        }
      })
      .catch(() => { if (!controller.signal.aborted) setLoadError(true) })
    return () => controller.abort()
  }, [client, eventId, departmentId, revision])

  return <>
    {loadError && <div className="form-buttons">
      <p className="message error" role="alert">Не удалось обновить список столов.</p>
      <button type="button" className="button" onClick={refresh}>Обновить столы</button>
    </div>}
    {!tables && !loadError && <p role="status">Загружаем столы…</p>}
    {tables && <TicketSeating {...props} {...{ tables, revision, refresh }} />}
    <TicketSales {...props} {...{ tables, revision, refresh, coordinator }} />
    <TicketLayouts {...props} />
  </>
}

function TicketSales({ client, eventId, departmentId, canManage, tables, revision, refresh, coordinator }: TicketScope & {
  tables: TicketTable[] | null; revision: number; refresh: () => void; coordinator: boolean
}) {
  const [rows, setRows] = useState<Sale[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [editingSale, setEditingSale] = useState<Sale | null>(null)
  const [voidingId, setVoidingId] = useState<string | null>(null)
  const [voidError, setVoidError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    void pages<Sale>((from, to) => client.from('ticket_sales').select(saleColumns)
      .eq('event_id', eventId).eq('department_id', departmentId)
      .order('created_at').order('id').range(from, to).abortSignal(controller.signal))
      .then((data) => {
        if (!controller.signal.aborted) {
          setRows(data.reverse())
          setLoadError(false)
        }
      })
      .catch(() => { if (!controller.signal.aborted) setLoadError(true) })
    return () => controller.abort()
  }, [client, eventId, departmentId, revision])

  async function voidSale(sale: Sale) {
    if (voidingId) return
    const effect = sale.reservation_id ? 'Места вернутся в бронь с прежним сроком.'
      : sale.table_number !== null ? 'Места на столе освободятся.' : 'Сумма будет исключена из выручки.'
    if (!window.confirm(`Удалить продажу на ${formatAmount(sale.amount)}? ${effect} Запись останется в истории.`)) return
    setVoidingId(sale.id)
    setVoidError('')
    setNotice('')
    try {
      const table = client.from('ticket_sales')
      const saved = await table.update({ voided_at: new Date().toISOString() })
        .eq('event_id', eventId).eq('department_id', departmentId).eq('id', sale.id)
        .eq('revision', sale.revision).select('voided_at').maybeSingle<{ voided_at: string | null }>()
      if (saved.error) throw saved.error
      let voidedAt = saved.data?.voided_at
      if (!voidedAt) {
        const current = await table.select('voided_at').eq('event_id', eventId).eq('department_id', departmentId)
          .eq('id', sale.id).maybeSingle<{ voided_at: string | null }>()
        if (current.error) throw current.error
        voidedAt = current.data?.voided_at
      }
      if (!voidedAt) {
        setVoidError('Запись изменилась. Проверьте обновлённый журнал перед удалением.')
      } else {
        setRows((current) => current?.map((row) => row.id === sale.id ? { ...row, voided_at: voidedAt } : row) ?? null)
        setEditingSale(null)
        setNotice('Продажа удалена из журнала. Запись сохранена в истории.')
      }
      refresh()
    } catch {
      setVoidError('Не удалось подтвердить удаление продажи. Повторите попытку.')
    } finally {
      setVoidingId(null)
    }
  }

  const active = rows?.filter((sale) => sale.voided_at === null)
  const history = rows?.filter((sale) => sale.voided_at !== null) ?? []
  let quantity = 0n
  const paid = { cash: 0n, cashless: 0n }
  for (const sale of active ?? []) {
    quantity += BigInt(sale.quantity)
    paid[sale.payment_method] += BigInt(Math.round(sale.amount * 100))
  }

  return <section className="record-detail-section" aria-labelledby="ticket-sales-heading">
    <h3 id="ticket-sales-heading">Продажи билетов</h3>
    {loadError && <>
      <p className="message error" role="alert">Не удалось обновить продажи и итоги.</p>
      <button type="button" className="button" onClick={refresh}>Обновить продажи</button>
    </>}
    {!rows && !loadError && <p role="status">Загружаем продажи…</p>}
    {rows && <dl className="card-grid metric-grid ticket-totals">
      <div className="panel"><dt>Продано билетов</dt><dd>{counts.format(quantity)}</dd></div>
      <div className="panel"><dt>Получено наличными</dt><dd>{formatKopecks(paid.cash)}</dd></div>
      <div className="panel"><dt>Получено безналичными</dt><dd>{formatKopecks(paid.cashless)}</dd></div>
      <div className="panel"><dt>Всего получено</dt><dd>{formatKopecks(paid.cash + paid.cashless)}</dd></div>
    </dl>}
    {canManage && tables && <TicketSaleForm {...{ client, eventId, departmentId, tables, refresh }} />}
    {notice && <p className="message" role="status">{notice}</p>}
    {voidError && <p className="message error" role="alert">{voidError}</p>}
    {active?.length === 0 && <p>Продаж пока нет.</p>}
    {!!active?.length && <table className="record-list ticket-sales-list" aria-label="Записи о продажах">
      <thead><tr><th scope="col">Записано</th><th scope="col">Стол</th><th scope="col">Билетов</th><th scope="col">Оплата</th><th scope="col">Сумма</th></tr></thead>
      <tbody>{active.map((sale) => <Fragment key={sale.id}><tr>
        <td><time dateTime={sale.created_at}>{formatDate(sale.created_at)}</time></td>
        <td>{sale.table_number === null ? 'Без стола' : `№ ${sale.table_number}`}</td>
        <td>{counts.format(sale.quantity)}</td>
        <td>{paymentLabels[sale.payment_method]}</td>
        <td>{formatAmount(sale.amount)}
          {canManage && <div className="ticket-sale-actions">
            {tables && <button type="button" className="button ticket-sale-edit" aria-expanded={editingSale?.id === sale.id}
              disabled={voidingId !== null}
              onClick={() => { setNotice(''); setEditingSale(editingSale?.id === sale.id ? null : sale) }}>Изменить</button>}
            {coordinator && <button type="button" className="button ticket-sale-edit ticket-sale-delete"
              disabled={voidingId !== null || editingSale !== null}
              onClick={() => { void voidSale(sale) }}>{voidingId === sale.id ? 'Удаляем…' : 'Удалить'}</button>}
          </div>}
        </td>
      </tr>
        {canManage && tables && editingSale?.id === sale.id && <tr><td colSpan={5} className="ticket-sale-editor">
          <TicketSaleForm {...{ client, eventId, departmentId, tables, refresh }} sale={editingSale}
            done={() => { setEditingSale(null); setNotice('Изменения в продаже сохранены.') }} cancel={() => setEditingSale(null)} />
        </td></tr>}
      </Fragment>)}</tbody>
    </table>}
    {coordinator && history.length > 0 && <details className="section-archive">
      <summary>Удалённые продажи</summary>
      <ul className="ticket-booking-list">{history.map((sale) => <li key={sale.id}>
        <strong>{formatAmount(sale.amount)}</strong>
        <p>{sale.table_number === null ? 'Без стола' : `Стол № ${sale.table_number}`} · Билетов {counts.format(sale.quantity)} · {paymentLabels[sale.payment_method]}</p>
        {sale.voided_at && <p>Удалена <time dateTime={sale.voided_at}>{formatDate(sale.voided_at)}</time></p>}
      </li>)}</ul>
    </details>}
  </section>
}
