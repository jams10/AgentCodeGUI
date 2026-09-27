// 생성 게이트웨이 클라이언트 — 접속 정보는 Rust(`studio:gateway-info`)에서 받고, 이후는 로컬 API에 직접 붙는다.
// 작업 · 잔액 · 사용액을 모듈 전역 스토어 하나에 모아 두고(useSyncExternalStore), 이벤트 스트림(SSE)으로 갱신한다.
// 게이트웨이 쪽 타입(studio/services/gen-gateway/src/types.ts)의 화면용 사본이다.
import { invoke } from '@tauri-apps/api/core'
import { useSyncExternalStore } from 'react'

export type ProviderId = 'comfy' | 'tripo' | 'higgsfield' | 'fake'
export type JobState = 'awaiting_approval' | 'rejected' | 'submitting' | 'running' | 'succeeded' | 'failed' | 'canceled'
export interface Cost {
  amount: number
  unit: 'credits' | 'usd'
  usd: number | null
}
export interface Balance extends Cost {
  checkedAt: number
}
export interface Job {
  id: string
  createdAt: number
  updatedAt: number
  state: JobState
  capability: 'image' | 'video' | 'model3d' | 'audio'
  model: string
  provider: ProviderId
  prompt: string | null
  params: Record<string, unknown> | null
  inputs: { kind: string; url?: string; path?: string; view?: string }[] | null
  origin: { space?: string; source?: 'ui' | 'agent'; title?: string; userPrompt?: string } | null
  estimate: Cost | null
  cost: Cost | null
  fallbackReason: string | null
  progress: number | null
  error: string | null
  balanceBefore: Balance | null
  styleId: string | null
}
export interface Output {
  id: string
  jobId: string
  kind: 'image' | 'video' | 'model' | 'audio' | 'other'
  url: string
  storageKey: string | null
}
export interface ProviderInfo {
  id: ProviderId
  configured: boolean
  keyHint: string | null
  lastBalance: Balance | null
}
export interface Spend {
  provider: ProviderId
  jobs: number
  usd: number
  unknown: number
}

export interface ModelOption {
  key: string
  label: string
  type: 'enum' | 'number' | 'bool' | 'text'
  values?: (string | number)[]
  default?: string | number | boolean
  min?: number
  max?: number
}
export interface ModelInfo {
  id: string
  label: string
  capability: Job['capability']
  input: 'none' | 'image' | 'images' | 'optional-image'
  prompt: 'required' | 'optional' | 'none'
  note?: string
  options: ModelOption[]
  providers: { id: ProviderId; configured: boolean }[]
  available: boolean
}
export interface LibraryItem {
  output: Output & { mime: string | null; createdAt: number }
  job: Job
}
export interface QuoteRequest {
  capability: Job['capability']
  model: string
  prompt?: string
  inputs?: { kind: 'image'; path?: string; url?: string; view?: string }[]
  params?: Record<string, unknown>
  origin?: Job['origin']
  style?: string
}
export interface Style {
  id: string
  name: string
  description: string | null
  promptPrefix: string | null
  promptSuffix: string | null
  negative: string | null
  count: number
}
export type StyleInput = Pick<Style, 'name' | 'description' | 'promptPrefix' | 'promptSuffix' | 'negative'>

export interface GatewayState {
  status: 'connecting' | 'ready' | 'offline'
  /** 결과가 새로 생길 때마다 올라간다 — 갤러리가 다시 읽는 신호 */
  outputsVersion: number
  /** 스타일이 바뀔 때마다 올라간다 */
  stylesVersion: number
  jobs: Record<string, Job>
  outputs: Record<string, Output[]>
  providers: ProviderInfo[]
  balances: Record<string, Balance | null | { error: string }>
  spend: Spend[]
  checkedAt: number | null
}

let state: GatewayState = { status: 'connecting', outputsVersion: 0, stylesVersion: 0, jobs: {}, outputs: {}, providers: [], balances: {}, spend: [], checkedAt: null }
const subs = new Set<() => void>()
const set = (patch: Partial<GatewayState>): void => {
  state = { ...state, ...patch }
  for (const s of subs) s()
}

let info: { port: number; token: string } | null = null

async function loadInfo(): Promise<typeof info> {
  try {
    const v = (await invoke('ipc_call', { channel: 'studio:gateway-info', payload: [] })) as { port?: number; token?: string } | null
    info = v && typeof v.port === 'number' && typeof v.token === 'string' ? { port: v.port, token: v.token } : null
  } catch {
    info = null
  }
  return info
}

export async function gw<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const i = info ?? (await loadInfo())
  if (!i) throw new Error('생성 게이트웨이가 아직 준비되지 않았어요.')
  let res: Response
  try {
    res = await fetch(`http://127.0.0.1:${i.port}${path}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: { Authorization: `Bearer ${i.token}`, 'Content-Type': 'application/json' },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    })
  } catch (e) {
    info = null // 게이트웨이가 다시 떴을 수 있다 — 다음 호출 때 접속 정보를 새로 받는다
    throw e
  }
  const body = (await res.json().catch(() => null)) as (T & { message?: string; error?: string }) | null
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`)
  return body as T
}

function upsert(job: Job, outputs?: Output[]): void {
  const jobs = { ...state.jobs, [job.id]: job }
  set(outputs ? { jobs, outputs: { ...state.outputs, [job.id]: outputs } } : { jobs })
}

export async function refreshAll(fresh = false): Promise<void> {
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000
  const [jobs, providers, spend] = await Promise.all([gw<Job[]>('/jobs?limit=100'), gw<ProviderInfo[]>('/providers'), gw<Spend[]>(`/spend?since=${since}`)])
  set({ jobs: Object.fromEntries(jobs.map((j) => [j.id, j])), providers, spend, status: 'ready' })
  if (fresh) {
    const balances = await gw<GatewayState['balances']>('/balances')
    set({ balances, checkedAt: Date.now() })
  }
}

// ── 이벤트 스트림 — EventSource는 인증 헤더를 못 실어서 fetch 스트림으로 읽는다 ──
let started = false
async function streamLoop(): Promise<void> {
  for (;;) {
    try {
      const i = info ?? (await loadInfo())
      if (!i) throw new Error('no gateway')
      await refreshAll(state.checkedAt == null)
      const res = await fetch(`http://127.0.0.1:${i.port}/events`, { headers: { Authorization: `Bearer ${i.token}` } })
      if (!res.ok || !res.body) throw new Error(`events ${res.status}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let cut: number
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, cut)
          buf = buf.slice(cut + 2)
          const line = chunk.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          const e = JSON.parse(line.slice(6)) as { type: 'job'; job: Job; outputs?: Output[] } | { type: 'balance'; provider: ProviderId; balance: Balance } | { type: 'styles' } | { type: 'providers' }
          if (e.type === 'job') {
            upsert(e.job, e.outputs)
            if (e.job.state === 'succeeded') {
              set({ outputsVersion: state.outputsVersion + 1 })
              void gw<Spend[]>(`/spend?since=${Date.now() - 30 * 24 * 60 * 60 * 1000}`).then((spend) => set({ spend }))
            }
          } else if (e.type === 'styles') set({ stylesVersion: state.stylesVersion + 1 })
          else if (e.type === 'providers') void refreshAll(true).catch(() => {})
          else set({ balances: { ...state.balances, [e.provider]: e.balance } })
        }
      }
    } catch {
      info = null
    }
    set({ status: 'offline' })
    await new Promise((r) => setTimeout(r, 3000))
  }
}

function ensureStarted(): void {
  if (started) return
  started = true
  void streamLoop()
}

export function useGateway(): GatewayState {
  ensureStarted()
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    () => state
  )
}

// ── 동작 ──────────────────────────────────────────────
export const approve = (id: string): Promise<Job> => gw<Job>(`/jobs/${id}/approve`, { method: 'POST' }).then((j) => (upsert(j), j))
export const reject = (id: string): Promise<Job> => gw<Job>(`/jobs/${id}/reject`, { method: 'POST' }).then((j) => (upsert(j), j))
export const cancel = (id: string): Promise<Job> => gw<Job>(`/jobs/${id}/cancel`, { method: 'POST' }).then((j) => (upsert(j), j))
export const outputUrl = (id: string): Promise<{ url: string; localPath?: string; stored: boolean }> => gw(`/outputs/${id}/url`)
export const refreshBalances = (): Promise<void> => refreshAll(true)
export interface KeyInfo {
  provider: ProviderId
  configured: boolean
  hint: string | null
  updatedAt: number | null
}
export const listKeys = (): Promise<KeyInfo[]> => gw<KeyInfo[]>('/keys')
/** 키 원문은 게이트웨이로 바로 보내고 화면에는 남기지 않는다 — 돌아오는 것은 끝 4자리 힌트뿐 */
export const saveKey = (p: ProviderId, key: string): Promise<{ ok: boolean; hint: string | null }> => gw(`/keys/${p}`, { body: { key } })
export const deleteKey = (p: ProviderId): Promise<{ ok: boolean }> => gw(`/keys/${p}/delete`, { body: {} })
export const testKey = (p: ProviderId): Promise<{ ok: boolean; message: string }> => gw(`/keys/${p}/test`, { body: {} })
export const listStyles = (): Promise<Style[]> => gw<Style[]>('/styles')
export const createStyle = (s: StyleInput): Promise<Style> => gw<Style>('/styles', { body: s })
export const updateStyle = (id: string, s: Partial<StyleInput>): Promise<Style> => gw<Style>(`/styles/${id}`, { body: s })
export const deleteStyle = (id: string): Promise<unknown> => gw(`/styles/${id}/delete`, { body: {} })
export const setJobStyle = (jobId: string, styleId: string | null): Promise<Job> => gw<Job>(`/jobs/${jobId}/style`, { body: { styleId } }).then((j) => (upsert(j), j))
/** 스타일 앞 문구 + 프롬프트 + 뒤 문구 — 게이트웨이 composePrompt와 같은 규칙(화면 미리보기용) */
export function composePrompt(st: Pick<Style, 'promptPrefix' | 'promptSuffix'> | null | undefined, prompt: string): string {
  return [st?.promptPrefix, prompt, st?.promptSuffix].map((p) => p?.trim()).filter((p): p is string => !!p).join(', ')
}
export const listModels = (): Promise<ModelInfo[]> => gw<ModelInfo[]>('/models')
export const listLibrary = (limit = 300): Promise<LibraryItem[]> => gw<LibraryItem[]>(`/outputs?limit=${limit}`)
/** 견적 → 승인 대기 작업. 승인은 승인 센터 카드에서만 한다. */
export const quote = (req: QuoteRequest): Promise<Job> => gw<Job>('/jobs', { body: req }).then((j) => (upsert(j), j))

/** <img>/<video>에 바로 넣을 결과 주소(게이트웨이가 보관본을 흘리거나 지금 열 수 있는 링크로 넘겨 준다) */
export function contentUrl(outputId: string): string | null {
  return info ? `http://127.0.0.1:${info.port}/outputs/${encodeURIComponent(outputId)}/content?t=${info.token}` : null
}

// ── 표시 도우미 ───────────────────────────────────────
export const PROVIDER_NAME: Record<ProviderId, string> = { comfy: 'ComfyCloud', tripo: 'Tripo', higgsfield: 'Higgsfield', fake: '테스트(과금 없음)' }
export const CAP_NAME: Record<Job['capability'], string> = { image: '이미지 생성', video: '영상 생성', model3d: '3D 생성', audio: '오디오 생성' }

export function fmtCost(c: Cost | null | undefined): string {
  if (!c) return '알 수 없음'
  if (c.unit === 'usd') return `$${c.amount.toFixed(c.amount < 1 ? 3 : 2)}`
  return `${Math.round(c.amount).toLocaleString('ko-KR')} 크레딧${c.usd != null ? ` (≈ $${c.usd.toFixed(2)})` : ''}`
}
