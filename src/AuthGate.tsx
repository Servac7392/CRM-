import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { emailCallback } from './supabase'

const Workspace = lazy(() => import('./Workspace'))

type AuthState = {
  session: Session | null
  setupPassword: boolean
  invalidLink: boolean
}

const PASSWORD_SETUP = 'crm-password-setup'

export function AuthGate({ client }: { client: SupabaseClient | null }) {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [signOutFailed, setSignOutFailed] = useState(false)

  useEffect(() => {
    if (!client) return

    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      let invalidLink = false
      if (event === 'INITIAL_SESSION') {
        invalidLink = emailCallback.failed ||
          (!!emailCallback.accessToken && session?.access_token !== emailCallback.accessToken)
        if (invalidLink) window.history.replaceState(null, '', window.location.pathname)
        if (!invalidLink && session && emailCallback.accessToken &&
            (emailCallback.type === 'recovery' || emailCallback.type === 'invite')) {
          sessionStorage.setItem(PASSWORD_SETUP, session.user.id)
        }
        emailCallback.accessToken = null
      }
      if (session && event === 'PASSWORD_RECOVERY') {
        sessionStorage.setItem(PASSWORD_SETUP, session.user.id)
      }
      if (event === 'SIGNED_OUT') sessionStorage.removeItem(PASSWORD_SETUP)
      setAuth({
        session,
        setupPassword: !!session && sessionStorage.getItem(PASSWORD_SETUP) === session.user.id,
        invalidLink,
      })
    })
    return () => subscription.unsubscribe()
  }, [client])

  async function signOut() {
    if (!client) return
    setSignOutFailed(false)
    const { error } = await client.auth.signOut({ scope: 'local' })
    if (error) setSignOutFailed(true)
  }

  if (client && !auth) {
    return <main className="auth-layout"><p role="status">Проверяем вход…</p></main>
  }

  if (client && auth?.session && !auth.setupPassword) {
    return <Suspense fallback={<main className="auth-layout"><p role="status">Загружаем мероприятия…</p></main>}>
      <Workspace
        key={auth.session.user.id}
        client={client}
        userId={auth.session.user.id}
        onSignOut={signOut}
        signOutFailed={signOutFailed}
      />
    </Suspense>
  }

  return <AuthForm
    key={auth?.setupPassword ? 'setup' : 'sign-in'}
    client={client}
    setupPassword={auth?.setupPassword ?? false}
    invalidLink={auth?.invalidLink ?? false}
    onPasswordSet={() => {
      sessionStorage.removeItem(PASSWORD_SETUP)
      setAuth((current) => current && { ...current, setupPassword: false })
    }}
    onSignOut={signOut}
    signOutFailed={signOutFailed}
  />
}

function AuthForm({ client, setupPassword, invalidLink, onPasswordSet, onSignOut, signOutFailed }: {
  client: SupabaseClient | null
  setupPassword: boolean
  invalidLink: boolean
  onPasswordSet: () => void
  onSignOut: () => void
  signOutFailed: boolean
}) {
  const [recovering, setRecovering] = useState(false)
  const [email, setEmail] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const showEmail = !setupPassword
  const title = setupPassword ? 'Установите пароль' : recovering ? 'Восстановление пароля' : 'Вход'

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!client || pending) return
    const fields = new FormData(event.currentTarget)
    const password = String(fields.get('password') ?? '')
    setError('')
    setNotice('')
    setPending(true)
    try {
      if (setupPassword) {
        if (password !== fields.get('confirmation')) {
          setError('Пароли должны совпадать.')
          return
        }
        const { error: updateError } = await client.auth.updateUser({ password })
        if (updateError) {
          setError('Не удалось сохранить пароль. Проверьте требования к паролю или запросите новую ссылку.')
        } else {
          onPasswordSet()
        }
      } else if (recovering) {
        const redirectTo = new URL(window.location.pathname, window.location.origin).href
        const { error: recoveryError } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo })
        if (recoveryError && recoveryError.status !== 404) {
          setError('Не удалось отправить запрос. Попробуйте позже.')
        } else {
          setNotice('Если адрес связан с аккаунтом, на него придёт письмо со ссылкой.')
        }
      } else {
        const { error: signInError } = await client.auth.signInWithPassword({ email: email.trim(), password })
        if (signInError) setError('Не удалось войти. Проверьте адрес и пароль.')
      }
    } catch {
      setError('Не удалось связаться с сервисом. Попробуйте ещё раз.')
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-card" aria-labelledby="auth-title">
        <p className="brand">Мероприятия</p>
        <h1 id="auth-title">{title}</h1>
        {!client && <p role="status" className="message">Подключение к проекту Supabase ещё не настроено.</p>}
        {invalidLink && !recovering && <p role="alert" className="message">Ссылка недействительна или истекла. Запросите новую.</p>}
        <form onSubmit={submit} className="form">
          {showEmail && <label>
            Электронная почта
            <input name="email" value={email} onChange={(event) => setEmail(event.target.value)}
              type="email" autoComplete="email" required />
          </label>}
          {!recovering && <label>
            {setupPassword ? 'Новый пароль' : 'Пароль'}
            <input name="password" type="password" autoComplete={setupPassword ? 'new-password' : 'current-password'} required />
          </label>}
          {setupPassword && <label>
            Повторите пароль
            <input name="confirmation" type="password" autoComplete="new-password" required />
          </label>}
          {error && <p role="alert" className="message error">{error}</p>}
          {notice && <p role="status" className="message">{notice}</p>}
          {setupPassword && signOutFailed && <p role="alert" className="message error">Не удалось выйти. Попробуйте ещё раз.</p>}
          <button disabled={!client || pending} className="button button-primary">
            {setupPassword ? 'Сохранить пароль' : recovering ? 'Отправить ссылку' : 'Войти'}
          </button>
        </form>
        {setupPassword
          ? <button type="button" className="text-button" onClick={onSignOut}>Выйти</button>
          : <button type="button" disabled={pending} className="text-button" onClick={() => {
            setRecovering(!recovering)
            setNotice('')
            setError('')
          }}>{recovering ? 'Вернуться ко входу' : 'Забыли пароль?'}</button>}
      </section>
    </main>
  )
}
