export const paymentLabels = { cash: 'Наличными', cashless: 'Безналичными' }
export type PaymentMethod = keyof typeof paymentLabels

const rubles = new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB' })

export function formatKopecks(amount: bigint) {
  const negative = amount < 0n
  const magnitude = negative ? -amount : amount
  const fraction = String(magnitude % 100n).padStart(2, '0')
  const formatted = rubles.formatToParts(magnitude / 100n)
    .map((part) => part.type === 'fraction' ? fraction : part.value).join('')
  return negative ? `−${formatted}` : formatted
}
