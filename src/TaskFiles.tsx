import { useEffect, useState, type FormEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatDate } from './events'

type Attachment = { name: string; created_at: string | null }

export function TaskFiles({ client, eventId, taskId, canUpload }: {
  client: SupabaseClient; eventId: string; taskId: string; canUpload: boolean
}) {
  const directory = `${eventId}/${taskId}`
  const [files, setFiles] = useState<Attachment[] | null>(null)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [link, setLink] = useState<{ name: string; url: string } | null>(null)

  useEffect(() => {
    let current = true
    void (async () => {
      const bucket = client.storage.from('crm-task-files')
      const attachments: Attachment[] = []
      const pageSize = 100
      for (let offset = 0; current; offset += pageSize) {
        const { data, error: listError } = await bucket.list(directory, {
          offset, limit: pageSize, sortBy: { column: 'name', order: 'asc' },
        })
        if (!current) return
        if (listError) {
          setError('Не удалось загрузить список вложений.')
          return
        }
        attachments.push(...data.filter((file) => file.id))
        if (data.length < pageSize) {
          setFiles(attachments)
          return
        }
      }
    })().catch(() => { if (current) setError('Не удалось загрузить список вложений.') })
    return () => { current = false }
  }, [client, directory, revision])

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const form = event.currentTarget
    const file = new FormData(form).get('file')
    if (!(file instanceof File) || !file.name) return
    setPending(true)
    setError('')
    try {
      const name = crypto.randomUUID()
      const { error: uploadError } = await client.storage.from('crm-task-files').upload(`${directory}/${name}`, file, {
        upsert: false,
        cacheControl: '0',
        metadata: { filename: file.name },
      })
      if (uploadError) setError('Не удалось загрузить вложение.')
      else {
        form.reset()
        setRevision((current) => current + 1)
      }
    } catch {
      setError('Не удалось загрузить вложение.')
    } finally {
      setPending(false)
    }
  }

  async function download(name: string) {
    if (pending) return
    setPending(true)
    setError('')
    setLink(null)
    try {
      const bucket = client.storage.from('crm-task-files')
      const path = `${directory}/${name}`
      const { data: info } = await bucket.info(path)
      const original = info?.metadata?.filename
      const filename = typeof original === 'string' && original ? original : name
      const { data, error: signError } = await bucket.createSignedUrl(path, 300, { download: filename })
      if (signError || !data) setError('Не удалось получить ссылку на вложение.')
      else setLink({ name, url: data.signedUrl })
    } catch {
      setError('Не удалось получить ссылку на вложение.')
    } finally {
      setPending(false)
    }
  }

  return <section>
    <h3>Вложения</h3>
    {error && <p className="message error" role="alert">{error}</p>}
    {files?.length === 0 && <p>Вложений пока нет.</p>}
    <ul className="task-detail-list">
      {files?.map((file) => <li key={file.name}>
        {file.created_at ? <>Файл от <time dateTime={file.created_at}>{formatDate(file.created_at)}</time></> : `Файл ${file.name}`}
        {' '}
        {link?.name === file.name
          ? <a href={link.url} rel="noreferrer" onClick={() => setLink(null)}>Скачать файл</a>
          : <button className="button" type="button" disabled={pending} onClick={() => { void download(file.name) }}>Подготовить ссылку</button>}
      </li>)}
    </ul>
    {canUpload && <form className="inline-form" onSubmit={upload}>
      <label>Файл<input type="file" name="file" required /></label>
      <button className="button" disabled={pending}>Загрузить файл</button>
    </form>}
  </section>
}
