import type { SupabaseClient } from '@supabase/supabase-js'

export type TicketScope = {
  client: SupabaseClient
  eventId: string
  departmentId: string
  canManage: boolean
}

export type TicketTable = {
  table_number: number
  reserved_count: number
  sold_count: number
}

export type TicketReservation = {
  id: string
  table_number: number
  guest_name: string
  quantity: number
  reserved_until: string
  status: 'reserved' | 'released' | 'sold'
}

export const seatsPerTable = 12
export const availableSeats = (table: TicketTable) => seatsPerTable - table.reserved_count - table.sold_count

export function ticketWriteError(cause: unknown, fallback: string) {
  const message = typeof cause === 'object' && cause && 'message' in cause ? cause.message : null
  switch (message) {
    case 'ticket_capacity_exceeded': return 'На этом столе уже недостаточно свободных мест.'
    case 'ticket_reservation_inactive': return 'Бронь уже снята или выкуплена.'
    case 'ticket_reservation_date_past': return 'Укажите сегодняшнюю или более позднюю дату.'
    case 'ticket_table_required': return 'Укажите стол для этой продажи.'
    case 'ticket_sale_changed': return 'Запись уже изменили. Закройте форму и откройте продажу снова.'
    default: return fallback
  }
}
