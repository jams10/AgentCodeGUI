// Match ComfyUI_frontend UserCredit.vue + creditsUtil.ts: despite the *_micros
// field names, /api/billing/balance values feed formatCreditsFromCents directly.
// Do not copy comfy-cli's micro-USD interpretation; it understates this balance
// by 10,000x. Unknown is not a zero balance.
export function creditNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !value.trim()) return null
  const number = Number(value)
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : null
}

export function tripoCreditValues(body: unknown): { balance: number; frozen: number | null } | null {
  const result = body as { code?: unknown; data?: { balance?: unknown; frozen?: unknown } } | null
  const balance = creditNumber(result?.data?.balance)
  if (result?.code !== 0 || balance == null) return null
  return { balance, frozen: creditNumber(result.data?.frozen) }
}

export function comfyCreditValues(balance: Record<string, unknown>, status: Record<string, unknown>): number | null {
  const fields = ['effective_balance_micros', 'amount_micros', 'prepaid_balance_micros', 'cloud_credit_balance_micros']
  let cents: number | null = null
  for (const field of fields) {
    const value = creditNumber(balance[field])
    if (value == null) continue
    cents = value
    if (value !== 0) break // a zero aggregate must not mask a nonzero component
  }
  const subscription = typeof status.subscription_status === 'string' ? status.subscription_status.trim().toLowerCase() : ''
  const hasSubscription = !['', 'none', 'null', 'no_subscription'].includes(subscription)
  const hasFunds = status.has_funds === true || (typeof status.has_funds === 'string' && ['true', '1', 'yes'].includes(status.has_funds.toLowerCase()))
  if (cents == null || (cents === 0 && !hasSubscription && !hasFunds)) return null
  // Same integer rounding as the Cloud credit badge (211 credits / USD).
  return Math.round(cents * (211 / 100))
}
