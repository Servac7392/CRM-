import { useRef, useState } from 'react'

export const counterpartyStatuses = {
  new: 'Новый',
  in_progress: 'В работе',
  discussed: 'Переговоры проведены',
  agreed: 'Согласились',
  declined: 'Отказались',
}

export type CounterpartyStatus = keyof typeof counterpartyStatuses
export type ControlDate = { label: string; date: string }

const rubles = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' })
const calendar = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'UTC' })

export function formatAmount(amount: number | null) {
  return amount == null ? 'Не указано' : rubles.format(amount)
}

export function parseAmount(source: string, allowZero = false) {
  const value = source.replace(/\s/g, '').replace(',', '.')
  if (!value) return null
  return /^\d{1,12}(\.\d{1,2})?$/.test(value) && (allowZero || Number(value) > 0)
    ? value : undefined
}

export function readControlDates(form: FormData) {
  const labels = form.getAll('control_label').map((value) => String(value).trim())
  const dates = form.getAll('control_date').map(String)
  if (labels.length !== dates.length ||
      labels.some((label, index) => !label || !/^\d{4}-\d{2}-\d{2}$/.test(dates[index]))) return null
  return labels.map((label, index) => ({ label, date: dates[index] }))
}

export function ControlDatesEditor({ dates, disabled }: { dates: ControlDate[]; disabled: boolean }) {
  const [rows, setRows] = useState(() => dates.map((entry, key) => ({ ...entry, key })))
  const nextKey = useRef(dates.length)

  function addDate() {
    const key = nextKey.current++
    setRows((current) => [...current, { key, label: '', date: '' }])
  }

  return <fieldset className="control-dates" disabled={disabled}>
    <legend>Контрольные даты</legend>
    {rows.map((entry, i) => <div className="control-date-row" key={entry.key}>
      <label>Название даты<input name="control_label" defaultValue={entry.label} maxLength={120} required /></label>
      <label>Дата<input name="control_date" type="date" min="0001-01-01" max="9999-12-31" defaultValue={entry.date} required /></label>
      <button type="button" className="button" aria-label={`Убрать дату ${i + 1}`}
        onClick={() => setRows((current) => current.filter((row) => row.key !== entry.key))}>Убрать</button>
    </div>)}
    {rows.length < 50 && <button type="button" className="button" onClick={addDate}>Добавить контрольную дату</button>}
  </fieldset>
}

export function ControlDatesSummary({ dates }: { dates: ControlDate[] }) {
  return <section className="record-detail-section">
    <h3>Контрольные даты</h3>
    {dates.length > 0 ? <ul className="task-list">
      {[...dates].sort((left, right) => left.date.localeCompare(right.date)).map((entry, index) =>
        <li key={index}>
          {entry.label}
          <time dateTime={entry.date}>{calendar.format(new Date(`${entry.date}T00:00:00Z`))}</time>
        </li>)}
    </ul> : <p>Даты пока не поставлены.</p>}
  </section>
}
