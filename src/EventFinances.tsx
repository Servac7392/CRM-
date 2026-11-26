import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatAmount } from './CounterpartyFields'
import { deadlineDay, eventTabTitle, pages, type EventWorkspace } from './events'
import { formatKopecks, paymentLabels, type PaymentMethod } from './money'

type Overview = {
  sponsors_kopecks: string
  tickets_kopecks: string
  paid_kopecks: string
  reserved_kopecks: string
  balance_kopecks: string
  available_kopecks: string
}
type TaskPlan = { income_kopecks: string; expense_kopecks: string }
type Expense = {
  card_id: string
  department_id: string
  department_name: string
  card_name: string
  amount: number
  paid_on: string | null
  payment_method: PaymentMethod | null
}
type Finance = { overview: Overview; expenses: Expense[]; taskPlan: TaskPlan }
type Payment = Pick<Expense, 'card_id' | 'amount' | 'paid_on' | 'payment_method'>

const dateFormat = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'medium', timeZone: 'UTC' })
const paymentColumns = 'card_id,amount,paid_on,payment_method'

export function EventFinances({ model, client }: { model: EventWorkspace; client: SupabaseClient }) {
  const eventId = model.event.id
  const [data, setData] = useState<Finance | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [payingCard, setPayingCard] = useState<string | null>(null)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    const overview = client.from('finance_overview').select('*').eq('event_id', eventId)
      .abortSignal(controller.signal).single<Overview>()
    const expenses = pages<Expense>((from, to) => client.from('finance_expenses')
      .select('card_id,department_id,department_name,card_name,amount,paid_on,payment_method')
      .eq('event_id', eventId).order('department_name').order('card_name').order('card_id')
      .range(from, to).abortSignal(controller.signal))
    const taskPlan = client.from('finance_task_plan').select('income_kopecks,expense_kopecks').eq('event_id', eventId)
      .abortSignal(controller.signal).single<TaskPlan>()
    void Promise.all([overview, expenses, taskPlan]).then(([result, rows, plan]) => {
      if (result.error || !result.data || plan.error || !plan.data) throw result.error ?? plan.error
      if (!controller.signal.aborted) {
        setData({ overview: result.data, expenses: rows, taskPlan: plan.data })
        setLoadError(false)
      }
    }).catch(() => {
      if (!controller.signal.aborted) {
        setData(null)
        setLoadError(true)
      }
    })
    return () => controller.abort()
  }, [eventId, client, revision])

  function refresh() {
    setRevision((value) => value + 1)
  }

  function markSaved() {
    setPayingCard(null)
    setNotice('Оплата записана.')
    refresh()
  }

  const base = `/events/${eventId}`
  const sponsors = model.departments.find((department) => department.sponsor_workspace && !department.archived)
  const tickets = model.departments.find((department) => department.ticket_workspace && !department.archived)
  const reserved = data?.expenses.filter((expense) => expense.paid_on === null) ?? []
  const paid = data?.expenses.filter((expense) => expense.paid_on !== null)
    .sort((a, b) => (b.paid_on ?? '').localeCompare(a.paid_on ?? '')) ?? []

  function expenseName(expense: Expense) {
    const department = model.departments.find((row) => row.id === expense.department_id)
    return <>
      <strong>{department && !department.sponsor_workspace
        ? <Link to={`${base}/directions/${expense.department_id}/cards/${expense.card_id}`}>{expense.card_name}</Link>
        : expense.card_name}</strong>
      <p>{expense.department_name}</p>
    </>
  }

  return <section className="event-list" aria-label="Финансовый учёт мероприятия">
    <div className="section-heading">
      <h2>{eventTabTitle(model, 'finance', 'Финансы')}</h2>
      <button type="button" className="button" onClick={refresh}>Обновить</button>
    </div>
    {loadError && <p className="message error" role="alert">Не удалось загрузить финансы. Обновите данные.</p>}
    {!data && !loadError && <p role="status">Загружаем финансы…</p>}
    {data && <>
      <FinanceTotals overview={data.overview} />
      <section className="panel" aria-labelledby="finance-task-plan">
        <h3 id="finance-task-plan">План по задачам</h3>
        <p>План учитывает сумму родительской задачи, если она указана. При пустой сумме учитываются подзадачи.</p>
        <dl className="card-grid metric-grid finance-totals">
          <div className="panel"><dt>Плановые поступления</dt><dd>{formatKopecks(BigInt(data.taskPlan.income_kopecks))}</dd></div>
          <div className="panel"><dt>Плановые расходы</dt><dd>{formatKopecks(BigInt(data.taskPlan.expense_kopecks))}</dd></div>
        </dl>
      </section>
      <section className="panel" aria-labelledby="finance-income">
        <h3 id="finance-income">Поступления</h3>
        <dl className="finance-income-list">
          <div><dt>{sponsors ? <Link to={`${base}/directions/${sponsors.id}`}>Спонсорские взносы</Link> : 'Спонсорские взносы'}</dt>
            <dd>+{formatKopecks(BigInt(data.overview.sponsors_kopecks))}</dd></div>
          <div><dt>{tickets ? <Link to={`${base}/directions/${tickets.id}`}>Продажа билетов</Link> : 'Продажа билетов'}</dt>
            <dd>+{formatKopecks(BigInt(data.overview.tickets_kopecks))}</dd></div>
        </dl>
      </section>
      {notice && <p className="message" role="status">{notice}</p>}
      <section className="panel" aria-labelledby="finance-reserves">
        <h3 id="finance-reserves">Резервы к оплате</h3>
        {reserved.length === 0 && <p>Резервов к оплате нет.</p>}
        <ul className="finance-expense-list">
          {reserved.map((expense) => <li key={expense.card_id}>
            <div className="finance-expense-row">
              <div>{expenseName(expense)}</div>
              <strong>{formatAmount(expense.amount)}</strong>
              <button type="button" className="button" aria-expanded={payingCard === expense.card_id} onClick={() => {
                setNotice('')
                setPayingCard(payingCard === expense.card_id ? null : expense.card_id)
              }}>Записать оплату</button>
            </div>
            {payingCard === expense.card_id && <ExpensePaymentForm {...{ client, eventId, expense, refresh }} done={markSaved}
              cancel={() => setPayingCard(null)} />}
          </li>)}
        </ul>
      </section>
      <section className="panel" aria-labelledby="finance-paid">
        <h3 id="finance-paid">Оплаченные расходы</h3>
        {paid.length === 0 && <p>Оплаченных расходов пока нет.</p>}
        <ul className="finance-expense-list">
          {paid.map((expense) => <li key={expense.card_id} className="finance-expense-row">
            <div>{expenseName(expense)}</div>
            <p>{expense.paid_on && <time dateTime={expense.paid_on}>{dateFormat.format(new Date(`${expense.paid_on}T00:00:00Z`))}</time>}
              {expense.payment_method && <> · {paymentLabels[expense.payment_method]}</>}</p>
            <strong>{formatAmount(-expense.amount)}</strong>
          </li>)}
        </ul>
      </section>
    </>}
  </section>
}

function FinanceTotals({ overview }: { overview: Overview }) {
  const sponsors = BigInt(overview.sponsors_kopecks)
  const tickets = BigInt(overview.tickets_kopecks)
  return <dl className="card-grid metric-grid finance-totals">
    <div className="panel"><dt>Всего поступило</dt><dd>{formatKopecks(sponsors + tickets)}</dd></div>
    <div className="panel"><dt>Оплачено расходов</dt><dd>{formatKopecks(-BigInt(overview.paid_kopecks))}</dd></div>
    <div className="panel"><dt>Фактический остаток</dt><dd>{formatKopecks(BigInt(overview.balance_kopecks))}</dd></div>
    <div className="panel"><dt>Зарезервировано</dt><dd>{formatKopecks(-BigInt(overview.reserved_kopecks))}</dd></div>
    <div className="panel"><dt>Остаток после оплаты резервов</dt><dd>{formatKopecks(BigInt(overview.available_kopecks))}</dd></div>
  </dl>
}

function ExpensePaymentForm({ client, eventId, expense, refresh, done, cancel }: {
  client: SupabaseClient; eventId: string; expense: Expense; refresh: () => void; done: () => void; cancel: () => void
}) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const attempt = useRef<{ id: string; values: string } | null>(null)
  const today = deadlineDay(new Date().toISOString())

  async function pay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const fields = new FormData(event.currentTarget)
    const method = fields.get('payment_method')
    const paidOn = String(fields.get('paid_on') ?? '')
    if (!paidOn || paidOn > today || (method !== 'cash' && method !== 'cashless')) {
      setError('Укажите дату и способ оплаты.')
      return
    }
    const payment: Payment = { card_id: expense.card_id, amount: expense.amount, paid_on: paidOn, payment_method: method }
    const values = JSON.stringify(payment)
    if (attempt.current?.values !== values) attempt.current = { id: crypto.randomUUID(), values }
    const { id } = attempt.current
    setPending(true)
    setError('')
    try {
      const result = await client.from('finance_expense_payments').insert({ ...payment, id, event_id: eventId })
      if (result.error?.code === '23505') {
        const previous = await client.from('finance_expense_payments').select(paymentColumns)
          .eq('event_id', eventId).eq('id', id).maybeSingle<Payment>()
        const row = previous.data
        if (previous.error || !row || row.card_id !== payment.card_id || row.amount !== payment.amount ||
            row.paid_on !== paidOn || row.payment_method !== method) throw result.error
      } else if (result.error) throw result.error
      done()
    } catch (cause) {
      const message = typeof cause === 'object' && cause && 'message' in cause ? cause.message : null
      const code = typeof cause === 'object' && cause && 'code' in cause ? cause.code : null
      if (message === 'finance_reserve_changed') {
        setError('Резерв изменился. Проверьте обновлённую сумму перед оплатой.')
        refresh()
      } else if (message === 'finance_payment_date_future') setError('Дата оплаты не может быть позже сегодняшней.')
      else if (code === '23505') {
        setError('Оплата по этой карточке уже записана.')
        refresh()
      } else setError('Не удалось подтвердить оплату. Повторите сохранение с теми же данными.')
    } finally {
      setPending(false)
    }
  }

  return <>
    <form className="inline-form" aria-label="Оплата расхода" onSubmit={pay}>
      <label>Дата оплаты<input type="date" name="paid_on" defaultValue={today} max={today} required disabled={pending} /></label>
      <label>Способ оплаты<select name="payment_method" defaultValue="" required disabled={pending}>
        <option value="" disabled>Выберите способ</option>
        <option value="cash">{paymentLabels.cash}</option>
        <option value="cashless">{paymentLabels.cashless}</option>
      </select></label>
      <button type="submit" className="button button-primary" disabled={pending}>
        {pending ? 'Сохраняем…' : `Подтвердить оплату ${formatAmount(expense.amount)}`}
      </button>
      <button type="button" className="button" disabled={pending} onClick={cancel}>Отмена</button>
    </form>
    {error && <p className="message error" role="alert">{error}</p>}
  </>
}
