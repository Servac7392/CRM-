import { useState, type FormEvent } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { SupabaseClient } from '@supabase/supabase-js'
import { orderedEventTabs, type EventWorkspace } from './events'

type Section = 'direction' | 'tab'
type SectionRow = EventWorkspace['departments'][number] | EventWorkspace['tabs'][number]

const tables = { direction: 'departments', tab: 'event_tabs' }
const groupNames = { direction: 'Направления', tab: 'Вкладки' }
const createNames = { direction: 'Новое направление', tab: 'Новая вкладка' }

export function EventSections({ client, model, saved }: {
  client: SupabaseClient; model: EventWorkspace; saved: () => void
}) {
  const [params, setParams] = useSearchParams()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const eventId = model.event.id
  const groups = { direction: model.departments, tab: orderedEventTabs(model) }
  const section = params.get('section')
  const editId = params.get('edit')

  function openEditor(kind: Section, id: string) {
    setError('')
    setNotice('')
    setParams({ section: kind, edit: id })
  }

  async function write(query: PromiseLike<{ data: { id: string } | null; error: { code: string } | null }>, message: string) {
    setPending(true)
    setError('')
    setNotice('')
    try {
      const result = await query
      if (result.error?.code === '23505') setError('Раздел с таким названием уже есть. Проверьте список и архив.')
      else if (result.error || !result.data) setError('Не удалось сохранить раздел. Проверьте права или обновите страницу.')
      else {
        setParams({}, { replace: true })
        setNotice(message)
        saved()
      }
    } catch {
      setError('Не удалось сохранить изменения. Проверьте подключение.')
    } finally {
      setPending(false)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>, kind: Section, row?: SectionRow) {
    event.preventDefault()
    if (pending) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('section_name') ?? '').trim()
    if (!name) {
      setError('Введите название.')
      return
    }
    const body = form.get('section_body')
    const fields = typeof body === 'string' ? { name, body } : { name }
    const table = client.from(tables[kind])
    const query = row
      ? table.update(fields).eq('event_id', eventId).eq('id', row.id).eq('updated_at', row.updated_at)
      : table.insert({ event_id: eventId, ...fields })
    void write(query.select('id').maybeSingle<{ id: string }>(), 'Раздел сохранён.')
  }

  function toggleArchive(kind: Section, row: SectionRow) {
    if (pending) return
    const query = client.from(tables[kind]).update({ archived: !row.archived })
      .eq('event_id', eventId).eq('id', row.id).eq('updated_at', row.updated_at)
    void write(query.select('id').maybeSingle<{ id: string }>(),
      row.archived ? 'Раздел восстановлен.' : 'Раздел перенесён в архив.')
  }

  function list(kind: Section, rows: SectionRow[]) {
    if (!rows.length) return <p className="message">Активных разделов пока нет.</p>
    return <ul className="managed-sections">
      {rows.map((row) => <li className="panel" key={row.id}>
        <strong>{row.name}</strong>
        <div className="form-buttons">
          <button type="button" className="button" disabled={pending} onClick={() => openEditor(kind, row.id)}>
            Редактировать
          </button>
          <button type="button" className="button" disabled={pending} onClick={() => toggleArchive(kind, row)}>
            {row.archived ? 'Восстановить' : 'В архив'}
          </button>
        </div>
      </li>)}
    </ul>
  }

  return <section className="event-list">
    <h2>Управление разделами</h2>
    {error && <p className="message error" role="alert">{error}</p>}
    {notice && <p className="message" role="status">{notice}</p>}
    {(['direction', 'tab'] as const).map((kind) => {
      const rows = groups[kind]
      const edited = section === kind ? rows.find((row) => row.id === editId) : undefined
      const isNew = section === kind && editId === 'new'
      const archived = rows.filter((row) => row.archived)
      const textPage = kind === 'tab' && model.tabs.find((tab) => tab.id === edited?.id && tab.builtin === null)
      return <section key={kind}>
        <div className="section-heading">
          <h3>{groupNames[kind]}</h3>
          <button type="button" className="button button-primary" disabled={pending} onClick={() => openEditor(kind, 'new')}>
            {createNames[kind]}
          </button>
        </div>
        {(edited || isNew) && <form key={edited?.id ?? 'new'} className="form task-form panel"
          onSubmit={(event) => { submit(event, kind, edited) }}>
          <h3>{edited ? 'Редактирование раздела' : createNames[kind]}</h3>
          <label>Название<input name="section_name" defaultValue={edited?.name}
            required maxLength={kind === 'tab' ? 120 : undefined} disabled={pending} /></label>
          {kind === 'tab' && (isNew || textPage) && <div className="field">
            <label htmlFor="event-section-text">Текст страницы</label>
            <textarea id="event-section-text" name="section_body" defaultValue={textPage ? textPage.body : ''}
              maxLength={20000} disabled={pending} />
          </div>}
          <div className="form-buttons">
            <button className="button button-primary" disabled={pending}>Сохранить раздел</button>
            <button type="button" className="button" disabled={pending} onClick={() => setParams({})}>Отмена</button>
          </div>
        </form>}
        {list(kind, rows.filter((row) => !row.archived))}
        {archived.length > 0 && <details className="section-archive">
          <summary>{kind === 'direction' ? 'Архив направлений' : 'Архив вкладок'}</summary>
          {list(kind, archived)}
        </details>}
      </section>
    })}
  </section>
}
