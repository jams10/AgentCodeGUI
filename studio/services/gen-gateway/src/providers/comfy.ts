// ComfyCloud 어댑터 (https://docs.comfy.org — Comfy API v2 · 2026-09 확인)
//  - 제출·상태·취소·업로드는 v2(Authorization: Bearer <key>), 잔액은 v1 경로(X-API-Key).
//  - 워크플로는 "API 형식" JSON을 params.workflow로 받는다(UI 형식은 서비스가 422로 거절).
//  - 입력 파일은 v2 assets로 올리고, 워크플로 안의 문자열 "$INPUT_0", "$INPUT_1" …을 자산 참조로 바꾼다.
//  - 파트너 노드(Nano Banana · Seedance · Kling …)는 같은 키를 extra_data.api_key_comfy_org로 넘긴다.
//  - 작업별 비용 필드가 없다 → 견적 null, 실제 비용은 게이트웨이가 잔액 차이로 계산한다.
//  - 결과 URL(/api/v2/assets/{id}/content)은 키가 있어야 열리고 약 6시간짜리 서명 URL로 302 된다 → resolveOutput.
//  - 잔액 단위는 크레딧. 서버 값은 센트이고 Cloud 배지와 같은 211 크레딧/USD로 환산한다(이전 앱에서 실측한 규칙).
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { requestJson, num, type FetchLike } from '../http.ts'
import type { Balance, Estimate, GenerationRequest, OutputKind, Provider, ProviderOutput, RemoteStatus } from '../types.ts'

const BASE = 'https://cloud.comfy.org'
const CREDITS_PER_USD = 211
const INPUT_TOKEN = /^\$INPUT_(\d+)$/

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.glb': 'model/gltf-binary', '.wav': 'audio/wav', '.mp3': 'audio/mpeg' }

interface V2Output {
  type?: string
  content_type?: string
  url?: string
  url_expires_at?: string
  name?: string
  id?: string
}
interface V2Job {
  id?: string
  status?: string
  progress?: { value?: number } | null
  outputs?: V2Output[]
  error?: { message?: string; code?: string } | string | null
}

function kindOf(o: V2Output): OutputKind {
  const t = (o.content_type || o.type || '').toLowerCase()
  if (t.startsWith('image')) return 'image'
  if (t.startsWith('video')) return 'video'
  if (t.startsWith('audio')) return 'audio'
  if (t.includes('gltf') || t.includes('model') || /\.(glb|gltf|obj|fbx)$/i.test(o.name ?? '')) return 'model'
  return 'other'
}

/** 워크플로 안의 "$INPUT_n" 문자열을 자산 참조 객체로 바꾼 사본 */
export function substituteInputs(node: unknown, assets: string[]): unknown {
  if (typeof node === 'string') {
    const m = INPUT_TOKEN.exec(node)
    if (!m) return node
    const id = assets[Number(m[1])]
    if (!id) throw new Error(`워크플로가 ${node}을(를) 쓰는데 입력 파일이 부족해요.`)
    return { __type: 'core/ASSET', info: { id } }
  }
  if (Array.isArray(node)) return node.map((n) => substituteInputs(n, assets))
  if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, substituteInputs(v, assets)]))
  return node
}

/** /api/billing/balance 응답(센트) → 크레딧. 이전 앱 creditValues.ts와 같은 필드 우선순위. */
export function comfyBalanceCredits(body: Record<string, unknown>): number | null {
  let cents: number | null = null
  for (const f of ['effective_balance_micros', 'amount_micros', 'prepaid_balance_micros', 'cloud_credit_balance_micros']) {
    const v = num(body[f])
    if (v == null) continue
    cents = v
    if (v !== 0) break
  }
  return cents == null ? null : Math.round(cents * (CREDITS_PER_USD / 100))
}

export class ComfyProvider implements Provider {
  readonly id = 'comfy' as const
  private readonly key: () => string | null
  private readonly fetchImpl: FetchLike

  constructor(key: () => string | null, fetchImpl: FetchLike = fetch) {
    this.key = key
    this.fetchImpl = fetchImpl
  }

  private k(): string {
    const k = this.key()
    if (!k) throw new Error('ComfyCloud API 키가 없어요.')
    return k
  }

  configured(): boolean {
    return !!this.key()
  }

  supports(req: GenerationRequest): boolean {
    if (req.model !== 'comfy-workflow') return false
    const wf = req.params?.workflow
    if (wf && typeof wf === 'object' && !Array.isArray(wf)) return true
    const p = req.params?.workflowPath
    return typeof p === 'string' && p.toLowerCase().endsWith('.json') && existsSync(p)
  }

  /** params.workflow(객체) 또는 params.workflowPath(API 형식 JSON 파일) */
  private async workflowOf(req: GenerationRequest): Promise<Record<string, unknown>> {
    const wf = req.params?.workflow
    if (wf && typeof wf === 'object' && !Array.isArray(wf)) return wf as Record<string, unknown>
    const path = req.params?.workflowPath
    if (typeof path !== 'string') throw new Error('워크플로(params.workflow 또는 workflowPath)가 필요해요.')
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('워크플로 파일이 JSON 객체가 아니에요.')
    // UI 형식(nodes/links 배열)은 서비스가 거절한다 — 먼저 알려 준다
    if (Array.isArray((parsed as Record<string, unknown>).nodes)) throw new Error('UI 형식 워크플로예요. ComfyUI에서 "Export (API)"로 저장한 파일을 써 주세요.')
    return parsed as Record<string, unknown>
  }

  async balance(): Promise<Balance | null> {
    const body = await requestJson<Record<string, unknown>>(this.fetchImpl, `${BASE}/api/billing/balance`, { headers: { 'X-API-Key': this.k() }, timeoutMs: 15000 })
    const credits = comfyBalanceCredits(body ?? {})
    if (credits == null) return null
    return { amount: credits, unit: 'credits', usd: credits / CREDITS_PER_USD, checkedAt: Date.now() }
  }

  async estimate(): Promise<Estimate> {
    return { cost: null, note: 'ComfyCloud는 작업 전에 비용을 알려주지 않아요. 실행 후 잔액 차이로 기록해요.' }
  }

  private async uploadAsset(path: string): Promise<string> {
    const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
    const form = new FormData()
    form.append('file', new Blob([await readFile(path)], { type }), basename(path))
    form.append('content_type', type)
    form.append('file_path', basename(path))
    const res = await this.fetchImpl(`${BASE}/api/v2/assets`, { method: 'POST', headers: { Authorization: `Bearer ${this.k()}` }, body: form, signal: AbortSignal.timeout(180000) })
    const text = await res.text()
    if (!res.ok) throw new Error(`입력 파일 업로드 실패 (HTTP ${res.status})`)
    const id = (JSON.parse(text) as { id?: string }).id
    if (!id) throw new Error('업로드 응답에 자산 id가 없어요')
    return id
  }

  async submit(req: GenerationRequest): Promise<{ remoteId: string }> {
    if (!this.supports(req)) throw new Error('params.workflow 또는 workflowPath(API 형식 워크플로 JSON)가 필요해요.')
    const source = await this.workflowOf(req)
    const assets: string[] = []
    for (const i of req.inputs ?? []) {
      if (!i.path) throw new Error('ComfyCloud 입력은 로컬 파일 경로로 주세요(업로드 후 $INPUT_n으로 참조).')
      assets.push(await this.uploadAsset(i.path))
    }
    const workflow = substituteInputs(source, assets)
    const job = await requestJson<V2Job>(this.fetchImpl, `${BASE}/api/v2/jobs`, {
      headers: { Authorization: `Bearer ${this.k()}`, 'Idempotency-Key': crypto.randomUUID() },
      body: { workflow, extra_data: { api_key_comfy_org: this.k() } }
    })
    if (!job.id) throw new Error('응답에 작업 id가 없어요')
    return { remoteId: job.id }
  }

  async status(remoteId: string): Promise<RemoteStatus> {
    const j = await requestJson<V2Job>(this.fetchImpl, `${BASE}/api/v2/jobs/${encodeURIComponent(remoteId)}`, { headers: { Authorization: `Bearer ${this.k()}` }, timeoutMs: 15000 })
    const progress = typeof j.progress?.value === 'number' ? j.progress.value : null
    switch (j.status) {
      case 'queued':
        return { state: 'queued', progress }
      case 'running':
      case 'canceling':
        return { state: 'running', progress }
      case 'succeeded': {
        const outs: ProviderOutput[] = (j.outputs ?? [])
          .filter((o) => o.url)
          .map((o) => ({ kind: kindOf(o), url: o.url!, mime: o.content_type, expiresAt: null, meta: { name: o.name, assetId: o.id } }))
        return { state: 'succeeded', outputs: outs }
      }
      case 'canceled':
        return { state: 'canceled' }
      case 'expired':
        return { state: 'failed', error: '작업이 만료됐어요' }
      case 'failed': {
        const e = j.error
        return { state: 'failed', error: typeof e === 'string' ? e : e?.message ?? '실행 실패' }
      }
      default:
        return { state: 'running', progress }
    }
  }

  async cancel(remoteId: string): Promise<void> {
    await requestJson(this.fetchImpl, `${BASE}/api/v2/jobs/${encodeURIComponent(remoteId)}/cancel`, { method: 'POST', headers: { Authorization: `Bearer ${this.k()}` } })
  }

  /** 자산 content URL → 지금 열 수 있는 서명 URL(약 6시간). 서명 URL은 인증 없이 받는다. */
  async resolveOutput(url: string): Promise<string> {
    const res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.k()}` }, redirect: 'manual', signal: AbortSignal.timeout(15000) })
    const loc = res.headers.get('location')
    if (res.status >= 300 && res.status < 400 && loc) return loc
    if (res.ok) return url
    throw new Error(`결과 링크를 받지 못했어요 (HTTP ${res.status})`)
  }
}
