// Tripo 3D API v3 어댑터 (https://developers.tripo3d.ai — 2026-09 확인)
//  - 인증: Authorization: Bearer <API 키>. Studio(웹) 구독과는 별개인 API 크레딧 계정의 키.
//  - 생성: POST /v3/generation/{text-to-model | image-to-model | multiview-to-model} → {code:0, data:{task_id}}
//  - 상태: GET /v3/tasks/{id} — queued · running · success · failed · cancelled · banned · expired
//          성공 시 output.model_url / rendered_image_url, 실제 비용 credits_consumed(1 크레딧 = $0.01)
//  - 결과 URL은 5분 뒤 만료 → 게이트웨이가 완료 즉시 보관한다(expiresAt을 짧게 표시).
//  - 입력 이미지: 공개 URL 그대로, 로컬 파일은 POST /v3/files(multipart)로 file_token을 받는다.
//  - 실패 · 취소된 작업은 과금되지 않는다(작업 생성 때 동결 → 성공 시 차감).
import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { requestJson, num, type FetchLike } from '../http.ts'
import type { Balance, Estimate, GenerationRequest, Provider, ProviderOutput, RemoteStatus } from '../types.ts'

const BASE = 'https://openapi.tripo3d.ai/v3'
const USD_PER_CREDIT = 0.01
const URL_TTL_MS = 5 * 60 * 1000

const ENDPOINT: Record<string, string> = {
  'tripo-text-to-3d': 'generation/text-to-model',
  'tripo-image-to-3d': 'generation/image-to-model',
  'tripo-multiview-to-3d': 'generation/multiview-to-model'
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }

interface Envelope<T> {
  code?: number
  message?: string
  suggestion?: string
  data?: T
}

/** 공개 요금표로 계산한 예상 크레딧(2026-09) — 실제 비용은 완료 응답의 credits_consumed로 기록한다 */
export function tripoEstimateCredits(model: string, p: Record<string, unknown> = {}): number {
  const texture = p.texture !== false || p.pbr === true
  let c = model === 'tripo-text-to-3d' ? (texture ? 20 : 10) : texture ? 30 : 20
  if (p.texture_quality === 'detailed') c += 10
  if (p.texture_quality === 'extreme') c += 20
  if (p.geometry_quality === 'detailed') c += 20
  if (p.quad === true) c += 5
  if (p.smart_low_poly === true) c += 10
  if (p.generate_parts === true) c += 20
  return c
}

function unwrap<T>(e: Envelope<T>): T {
  if (e.code !== 0 || e.data === undefined) throw new Error(`Tripo 오류 ${e.code ?? '?'}: ${e.message ?? '알 수 없는 응답'}${e.suggestion ? ` (${e.suggestion})` : ''}`)
  return e.data
}

export class TripoProvider implements Provider {
  readonly id = 'tripo' as const
  private readonly key: () => string | null
  private readonly fetchImpl: FetchLike

  constructor(key: () => string | null, fetchImpl: FetchLike = fetch) {
    this.key = key
    this.fetchImpl = fetchImpl
  }

  private headers(): Record<string, string> {
    const k = this.key()
    if (!k) throw new Error('Tripo API 키가 없어요.')
    return { Authorization: `Bearer ${k}` }
  }

  configured(): boolean {
    return !!this.key()
  }

  supports(req: GenerationRequest): boolean {
    if (req.capability !== 'model3d' || !ENDPOINT[req.model]) return false
    const imgs = (req.inputs ?? []).filter((i) => i.kind === 'image')
    if (req.model === 'tripo-text-to-3d') return !!req.prompt
    if (req.model === 'tripo-image-to-3d') return imgs.length === 1 || typeof req.params?.input === 'string'
    return imgs.length >= 2
  }

  async balance(): Promise<Balance | null> {
    const d = unwrap(await requestJson<Envelope<{ balance?: unknown; frozen?: unknown }>>(this.fetchImpl, `${BASE}/account/balance`, { headers: this.headers(), timeoutMs: 15000 }))
    const b = num(d.balance)
    if (b == null) return null
    return { amount: b, unit: 'credits', usd: b * USD_PER_CREDIT, checkedAt: Date.now() }
  }

  async estimate(req: GenerationRequest): Promise<Estimate> {
    const c = tripoEstimateCredits(req.model, req.params)
    return { cost: { amount: c, unit: 'credits', usd: c * USD_PER_CREDIT }, note: '공개 요금표 기준 예상치 — 실제 차감액은 완료 후 기록' }
  }

  /** 입력 이미지 하나 → Tripo input 값(URL 또는 file_token) */
  private async inputOf(i: NonNullable<GenerationRequest['inputs']>[number]): Promise<string> {
    if (i.url) return i.url
    if (!i.path) throw new Error('입력 이미지에 url 또는 path가 필요해요.')
    const type = MIME[extname(i.path).toLowerCase()]
    if (!type) throw new Error(`Tripo가 받지 않는 이미지 형식이에요: ${extname(i.path)} (PNG · JPEG · WebP)`)
    const form = new FormData()
    form.append('file', new Blob([await readFile(i.path)], { type }), basename(i.path))
    const res = await this.fetchImpl(`${BASE}/files`, { method: 'POST', headers: this.headers(), body: form, signal: AbortSignal.timeout(120000) })
    const body = (await res.json().catch(() => ({}))) as Envelope<{ file_token?: string }>
    if (!res.ok) throw new Error(`입력 이미지 업로드 실패 (HTTP ${res.status}${body.message ? ` — ${body.message}` : ''})`)
    const token = unwrap(body).file_token
    if (!token) throw new Error('업로드 응답에 file_token이 없어요')
    return token
  }

  async submit(req: GenerationRequest): Promise<{ remoteId: string }> {
    if (!this.supports(req)) throw new Error(`Tripo가 처리할 수 없는 요청이에요: ${req.model}`)
    const body: Record<string, unknown> = { ...(req.params ?? {}) }
    const imgs = (req.inputs ?? []).filter((i) => i.kind === 'image')
    if (req.model === 'tripo-text-to-3d') body.prompt = req.prompt
    else if (req.model === 'tripo-image-to-3d') {
      if (imgs[0]) body.input = await this.inputOf(imgs[0])
    } else {
      const views = ['front', 'left', 'back', 'right']
      body.inputs = await Promise.all(imgs.map(async (i, n) => ({ [i.view ?? views[n] ?? `view${n}`]: await this.inputOf(i) })))
    }
    const d = unwrap(await requestJson<Envelope<{ task_id?: string }>>(this.fetchImpl, `${BASE}/${ENDPOINT[req.model]}`, { headers: this.headers(), body }))
    if (!d.task_id) throw new Error('응답에 task_id가 없어요')
    return { remoteId: d.task_id }
  }

  async status(remoteId: string): Promise<RemoteStatus> {
    const d = unwrap(
      await requestJson<Envelope<{ status?: string; progress?: unknown; output?: { model_url?: string; rendered_image_url?: string; model_urls?: unknown }; credits_consumed?: unknown; error_message?: string }>>(
        this.fetchImpl,
        `${BASE}/tasks/${encodeURIComponent(remoteId)}`,
        { headers: this.headers(), timeoutMs: 15000 }
      )
    )
    const progress = num(d.progress)
    const p = progress == null ? null : progress / 100
    switch (d.status) {
      case 'queued':
        return { state: 'queued', progress: p }
      case 'running':
        return { state: 'running', progress: p }
      case 'success': {
        const exp = Date.now() + URL_TTL_MS
        const outs: ProviderOutput[] = []
        if (d.output?.model_url) outs.push({ kind: 'model', url: d.output.model_url, mime: 'model/gltf-binary', expiresAt: exp })
        if (Array.isArray(d.output?.model_urls)) for (const u of d.output!.model_urls as unknown[]) if (typeof u === 'string') outs.push({ kind: 'model', url: u, expiresAt: exp })
        if (d.output?.rendered_image_url) outs.push({ kind: 'image', url: d.output.rendered_image_url, expiresAt: exp, meta: { preview: true } })
        const credits = num(d.credits_consumed)
        return { state: 'succeeded', outputs: outs, cost: credits == null ? null : { amount: credits, unit: 'credits', usd: credits * USD_PER_CREDIT } }
      }
      case 'cancelled':
        return { state: 'canceled' }
      case 'banned':
        return { state: 'failed', error: '콘텐츠 정책에 걸려 생성되지 않았어요(과금 없음)' }
      case 'expired':
        return { state: 'failed', error: '작업이 만료됐어요' }
      case 'failed':
        return { state: 'failed', error: d.error_message || '생성 실패(과금 없음)' }
      default:
        return { state: 'running', progress: p }
    }
  }
}
