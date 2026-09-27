// 어댑터 공용 HTTP — 시간 제한 · JSON 파싱 · 오류 본문 요약. 키는 오류 메시지에 절대 싣지 않는다.
export class HttpError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

export type FetchLike = typeof fetch

export async function requestJson<T = unknown>(
  fetchImpl: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}
): Promise<T> {
  const res = await fetchImpl(url, {
    method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
    headers: { Accept: 'application/json', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    redirect: 'follow',
    signal: AbortSignal.timeout(init.timeoutMs ?? 30000)
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text.slice(0, 300)
  }
  if (!res.ok) {
    const detail =
      (body && typeof body === 'object' && ((body as Record<string, unknown>).detail ?? (body as Record<string, unknown>).message ?? (body as Record<string, unknown>).error)) || (typeof body === 'string' ? body : '')
    throw new HttpError(res.status, `HTTP ${res.status}${detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 200)}` : ''}`, body)
  }
  return body as T
}

export function num(v: unknown): number | null {
  if (typeof v !== 'number' && typeof v !== 'string') return null
  if (typeof v === 'string' && !v.trim()) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
