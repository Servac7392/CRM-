import { createRoot } from 'react-dom/client'
import { AuthGate } from './AuthGate'
import { supabase } from './supabase'
import './styles.css'

const root = createRoot(document.getElementById('root')!)
root.render(<AuthGate client={supabase} />)
