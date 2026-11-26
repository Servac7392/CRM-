import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatDate } from './events'

const extensions: Record<string, string | undefined> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}
const sizeLimit = 20 * 1024 * 1024
type Layout = { name: string; created_at: string | null }
type Preview = { layout: Layout; name: string; url: string }

export function TicketLayouts({ client, eventId, departmentId, canManage }: {
  client: SupabaseClient; eventId: string; departmentId: string; canManage: boolean
}) {
  const directory = `${eventId}/${departmentId}`
  const [layouts, setLayouts] = useState<Layout[] | null>(null)
  const [revision, setRevision] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const [error, setError] = useState('')
  const [uploaded, setUploaded] = useState(false)
  const [pending, setPending] = useState<'upload' | 'preview' | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const uploadPath = useRef<string | null>(null)

  useEffect(() => {
    let current = true
    const bucket = client.storage.from('crm-ticket-layouts')
    void (async () => {
      const files: Layout[] = []
      const pageSize = 100
      for (let offset = 0; current; offset += pageSize) {
        const { data, error: listError } = await bucket.list(directory, {
          offset, limit: pageSize, sortBy: { column: 'name', order: 'asc' },
        })
        if (!current) return
        if (listError) throw listError
        files.push(...data.filter((file) => file.id))
        if (data.length < pageSize) {
          setLayouts(files.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? '') || a.name.localeCompare(b.name)))
          return
        }
      }
    })().catch(() => { if (current) setLoadError(true) })
    return () => { current = false }
  }, [client, directory, revision])

  function reload() {
    setLoadError(false)
    setRevision((value) => value + 1)
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    setUploaded(false)
    const form = event.currentTarget
    const file = new FormData(form).get('layout')
    if (!(file instanceof File) || !file.size || !extensions[file.type] || file.size > sizeLimit) {
      setError('Выберите непустой файл PDF, PNG, JPEG или WebP размером до 20 МБ.')
      return
    }
    uploadPath.current ??= `${directory}/${crypto.randomUUID()}.${extensions[file.type]}`
    const path = uploadPath.current
    setPending('upload')
    setError('')
    try {
      const bucket = client.storage.from('crm-ticket-layouts')
      const { error: uploadError } = await bucket.upload(path, file, {
        upsert: false, contentType: file.type, cacheControl: '0', metadata: { filename: file.name },
      })
      if (uploadError) {
        const { data: exists } = await bucket.exists(path)
        if (!exists) throw uploadError
      }
      uploadPath.current = null
      form.reset()
      setUploaded(true)
      reload()
    } catch {
      setError('Не удалось подтвердить загрузку схемы. Повторите загрузку выбранного файла.')
    } finally {
      setPending(null)
    }
  }

  async function open(layout: Layout) {
    if (pending) return
    setPending('preview')
    setError('')
    setPreview(null)
    try {
      const bucket = client.storage.from('crm-ticket-layouts')
      const path = `${directory}/${layout.name}`
      const [sign, info] = await Promise.all([bucket.createSignedUrl(path, 300), bucket.info(path)])
      if (sign.error || !sign.data) throw sign.error
      const original = info.data?.metadata?.filename
      const name = typeof original === 'string' && original ? original : 'Схема расстановки столов'
      setPreview({ layout, name, url: sign.data.signedUrl })
    } catch {
      setError('Не удалось открыть схему. Попробуйте ещё раз.')
    } finally {
      setPending(null)
    }
  }

  const [latest, ...previous] = layouts ?? []
  function layoutRow(file: Layout) {
    return <li key={file.name}>
      {file.created_at && <time dateTime={file.created_at}>{formatDate(file.created_at)}</time>}
      <span className="status">{file.name.split('.').pop()?.toUpperCase()}</span>
      <button type="button" className="button" disabled={pending !== null}
        onClick={() => { void open(file) }}>Открыть схему</button>
    </li>
  }

  return <section className="record-detail-section" aria-labelledby="ticket-layouts-heading">
    <h3 id="ticket-layouts-heading">Расстановка столов</h3>
    {loadError && <>
      <p className="message error" role="alert">Не удалось загрузить список схем.</p>
      <button type="button" className="button" onClick={reload}>Обновить список схем</button>
    </>}
    {!layouts && !loadError && <p role="status">Загружаем список схем…</p>}
    {layouts?.length === 0 && <p>Схема пока не загружена.</p>}
    {latest && <ul className="ticket-layouts" aria-label="Последняя схема">{layoutRow(latest)}</ul>}
    {previous.length > 0 && <details className="section-archive">
      <summary>Предыдущие версии</summary>
      <ul className="ticket-layouts">{previous.map(layoutRow)}</ul>
    </details>}
    {canManage && <form className="inline-form ticket-layout-upload" onSubmit={upload}>
      <label>Файл схемы (PDF, PNG, JPEG или WebP, до 20 МБ)
        <input type="file" name="layout" accept={Object.keys(extensions).join(',')}
          required disabled={pending !== null} onChange={() => { uploadPath.current = null }} />
      </label>
      <button className="button" disabled={pending !== null}>{pending === 'upload' ? 'Загружаем…' : 'Загрузить схему'}</button>
    </form>}
    {error && <p className="message error" role="alert">{error}</p>}
    {uploaded && <p className="message" role="status">Схема загружена.</p>}
    {pending === 'preview' && <p role="status">Открываем схему…</p>}
    {preview && <div className="ticket-layout-preview">
      <div className="section-heading">
        <a href={preview.url} target="_blank" rel="noreferrer">Открыть в новой вкладке</a>
        <button type="button" className="button" onClick={() => setPreview(null)}>Закрыть просмотр</button>
      </div>
      {preview.layout.name.endsWith('.pdf')
        ? <iframe src={preview.url} title={preview.name} referrerPolicy="no-referrer" />
        : <img src={preview.url} alt={preview.name} referrerPolicy="no-referrer" />}
    </div>}
  </section>
}
