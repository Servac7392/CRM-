import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL?.trim()
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()

// Supabase обрабатывает фрагмент ссылки и очищает его при создании сессии.
const fragment = new URLSearchParams(window.location.hash.slice(1))
export const emailCallback = {
  accessToken: fragment.get('access_token'),
  type: fragment.get('type'),
  failed: fragment.has('error_description') || fragment.has('error_code'),
}

export const supabase = url && key ? createClient(url, key) : null
