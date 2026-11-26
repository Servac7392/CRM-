import { useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { managesDepartment, type Department, type EventWorkspace } from './events'
import { ControlDatesEditor, ControlDatesSummary, formatAmount, parseAmount, readControlDates, type ControlDate } from './CounterpartyFields'

export const sponsorStatuses = {
  new: 'Новый',
  in_progress: 'В работе',
  discussed: 'Проведена беседа',
  agreed: 'Дал согласие',
  declined: 'Не дал согласия',
}

const paymentStatuses = {
  not_received: 'Деньги не получили',
  received: 'Получили деньги',
}

export type Sponsor = {
  id: string
  company: string
  contact_name: string | null
  owner_id: string | null
  status: keyof typeof sponsorStatuses
  payment_status: keyof typeof paymentStatuses
  pledged_amount: number | null
  received_amount: number | null
  notes: string | null
  control_dates: ControlDate[]
  updated_at: string
}

export const sponsorColumns =
  'id,company,contact_name,owner_id,status,payment_status,pledged_amount,received_amount,notes,control_dates,updated_at'

export function SponsorEditor({ client, model, department, existing, saved, cancel }: {
  client: SupabaseClient; model: EventWorkspace; department: Department; existing?: Sponsor
  saved: (sponsor: Sponsor) => void; cancel: () => void
}) {
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const eventId = model.event.id
  const departmentId = department.id
  const canManage = managesDepartment(model, departmentId)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setError('')
    const form = new FormData(event.currentTarget)
    const value = (field: string) => String(form.get(field) ?? '').trim()
    const company = value('company')
    if (canManage && !company) {
      setError('Введите название компании.')
      return
    }
    const pledgedAmount = parseAmount(value('pledged_amount'))
    const receivedAmount = parseAmount(value('received_amount'))
    const paymentStatus = value('payment')
    if (pledgedAmount === undefined || receivedAmount === undefined) {
      setError('Укажите положительную сумму в рублях, максимум два знака после запятой.')
      return
    }
    if (receivedAmount && paymentStatus !== 'received') {
      setError('Для полученной суммы выберите статус «Получили деньги».')
      return
    }
    const controlDates = readControlDates(form)
    if (!controlDates) {
      setError('Укажите название и дату для каждого пункта.')
      return
    }

    const fields = {
      contact_name: value('contact') || null,
      status: value('status'),
      payment_status: paymentStatus,
      pledged_amount: pledgedAmount,
      received_amount: receivedAmount,
      control_dates: controlDates,
      ...(canManage ? { company, owner_id: value('owner') || null, notes: value('notes') || null } : {}),
    }

    setPending(true)
    try {
      const table = client.from('sponsors')
      const query = existing
        ? table.update(fields).eq('id', existing.id).eq('event_id', eventId)
          .eq('department_id', departmentId).eq('updated_at', existing.updated_at)
        : table.insert({ ...fields, event_id: eventId, department_id: departmentId })
      const { data, error: saveError } = await query.select(sponsorColumns).maybeSingle<Sponsor>()
      if (saveError?.code === '23514') {
        setError('Проверьте поля карточки и выбранного ответственного.')
      } else if (saveError || !data) {
        setError('Не удалось сохранить карточку. Проверьте права или обновите страницу.')
      } else {
        saved(data)
      }
    } catch {
      setError('Не удалось сохранить карточку. Проверьте подключение.')
    } finally {
      setPending(false)
    }
  }

  return <form className="form task-form" onSubmit={submit}>
      {canManage && <label>Компания<input name="company" defaultValue={existing?.company} maxLength={200}
        required disabled={pending} /></label>}
      <label>Контактное лицо<input name="contact" defaultValue={existing?.contact_name ?? ''} maxLength={200} disabled={pending} /></label>
      {canManage && <label>Ответственный в команде<select name="owner" defaultValue={existing?.owner_id ?? ''} disabled={pending}>
        <option value="">Без ответственного</option>
        {existing?.owner_id && !model.teammates.some((person) => person.id === existing.owner_id) &&
          <option value={existing.owner_id}>Текущий ответственный недоступен</option>}
        {model.teammates.map((person) => <option key={person.id} value={person.id}>{person.display_name}</option>)}
      </select></label>}
      <div className="filters">
        <label>Переговоры<select name="status" defaultValue={existing?.status ?? 'new'} disabled={pending}>
          {Object.entries(sponsorStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Поступление денег<select name="payment" defaultValue={existing?.payment_status ?? 'not_received'} disabled={pending}>
          {Object.entries(paymentStatuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <label>Обещанная сумма, ₽<input name="pledged_amount" inputMode="decimal"
          defaultValue={existing?.pledged_amount ?? ''} disabled={pending} /></label>
        <label>Фактически полученная сумма, ₽<input name="received_amount" inputMode="decimal"
          defaultValue={existing?.received_amount ?? ''} disabled={pending} /></label>
      </div>
      {canManage && <div className="field">
        <label htmlFor="sponsor-notes">Комментарий</label>
        <textarea id="sponsor-notes" name="notes" defaultValue={existing?.notes ?? ''} maxLength={4000} disabled={pending} />
      </div>}
      <ControlDatesEditor dates={existing?.control_dates ?? []} disabled={pending} />
      {error && <p role="alert" className="message error">{error}</p>}
      <div className="form-buttons">
        <button className="button button-primary" disabled={pending}>Сохранить спонсора</button>
        <button type="button" className="button" disabled={pending} onClick={cancel}>Отмена</button>
      </div>
    </form>
}

export function SponsorDetails({ sponsor, model }: { sponsor: Sponsor; model: EventWorkspace }) {
  const owner = model.teammates.find((person) => person.id === sponsor.owner_id)
  return <>
    <dl className="record-details">
      <div><dt>Контактное лицо</dt><dd>{sponsor.contact_name || 'Не указано'}</dd></div>
      <div><dt>Ответственный</dt><dd>{sponsor.owner_id ? owner?.display_name ?? 'Участник недоступен' : 'Без ответственного'}</dd></div>
      <div><dt>Переговоры</dt><dd>{sponsorStatuses[sponsor.status]}</dd></div>
      <div><dt>Поступление денег</dt><dd>{paymentStatuses[sponsor.payment_status]}</dd></div>
      <div><dt>Обещано</dt><dd>{formatAmount(sponsor.pledged_amount)}</dd></div>
      <div><dt>Получено</dt><dd>{formatAmount(sponsor.received_amount)}</dd></div>
    </dl>
    {sponsor.notes && <section className="record-detail-section">
      <h3>Комментарий</h3><p className="preserve-lines">{sponsor.notes}</p>
    </section>}
    <ControlDatesSummary dates={sponsor.control_dates} />
  </>
}
