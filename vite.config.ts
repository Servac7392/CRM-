import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const { VITE_SUPABASE_PUBLISHABLE_KEY: key, VITE_SUPABASE_URL: url } = loadEnv(mode, '.', 'VITE_')
  if (key && !/^sb_publishable_[A-Za-z0-9_-]+$/.test(key.trim())) {
    throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY должен содержать только публичный ключ Supabase.')
  }
  if (url) {
    const endpoint = URL.parse(url.trim())
    const isLocal = endpoint?.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname)
    if (!endpoint || (!isLocal && endpoint.protocol !== 'https:') ||
        endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      throw new Error('VITE_SUPABASE_URL должен содержать адрес API проекта без пути и параметров.')
    }
  }
  return { base: './', plugins: [react()] }
})
