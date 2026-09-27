// Higgsfield API 어댑터 (https://docs.higgsfield.ai — 2026-09 확인)
//  - 인증: Authorization: Key <KEY_ID>:<KEY_SECRET>  (키 보관함에는 "KEY_ID:KEY_SECRET" 한 줄로 저장)
//  - 모델마다 경로가 따로다: POST /<vendor>/<model>/<variant>  → {request_id, status_url, cancel_url}
//  - 견적: POST /estimate/<같은 경로> (본문 동일) → {credits, usd}. 고정 요금이라 견적 = 청구액.
//  - 상태: GET /requests/{id}/status — queued · in_progress · completed · failed · nsfw · canceled
//  - 잔액 조회 API는 문서화되어 있지 않다 → balance()는 null(기록부 사용액으로 대신 보여준다).
//  - 결과 보관은 "최소 7일" — 영구 보관은 저장소 업로드가 맡는다.
//  - 3D(Tripo)는 CLI 전용이라 여기서 다루지 않는다.
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { requestJson, num, type FetchLike } from '../http.ts'
import type { Balance, Estimate, GenerationRequest, Provider, ProviderOutput, RemoteStatus } from '../types.ts'

const BASE = 'https://api.higgsfield.ai'
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** 친숙한 이름 → API 경로. 목록에 없는 모델은 'hf/<경로>'로 부른다. */
export const HIGGSFIELD_MODELS: Record<string, { path: string; capability: 'image' | 'video'; needsImage?: boolean }> = {
  soul: { path: 'higgsfield-ai/soul/standard', capability: 'image' },
  'seedance-2.0-t2v': { path: 'bytedance/seedance-2.0/text-to-video', capability: 'video' },
  'seedance-2.0-i2v': { path: 'bytedance/seedance-2.0/image-to-video', capability: 'video', needsImage: true },
  'kling-2.5-turbo-i2v': { path: 'kling-video/v2.5-turbo/pro/image-to-video', capability: 'video', needsImage: true }
}

const MIME: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.wav': 'audio/wav' }

function pathOf(req: GenerationRequest): string | null {
  if (req.model.startsWith('hf/')) return req.model.slice(3).replace(/^\/+/, '') || null
  const m = HIGGSFIELD_MODELS[req.model]
  return m && m.capability === req.capability ? m.path : null
}

interface StatusBody {
  status?: string
  error?: string
  images?: { url?: string }[]
  video?: { url?: string } | null
  audio?: { url?: string } | null
  audios?: { url?: string }[]
}

export class HiggsfieldProvider implements Provider {
  readonly id = 'higgsfield' as const
  readonly estimateIsExact = true
  private readonly key: () => string | null
  private readonly fetchImpl: FetchLike

  constructor(key: () => string | null, fetchImpl: FetchLike = fetch) {
    this.key = key
    this.fetchImpl = fetchImpl
  }

  private headers(): Record<string, string> {
    const k = this.key()
    if (!k) throw new Error('Higgsfield API 키가 없어요.')
    return { Authorization: `Key ${k}` }
  }

  configured(): boolean {
    return !!this.key()
  }

  supports(req: GenerationRequest): boolean {
    return (req.capability === 'image' || req.capability === 'video') && pathOf(req) != null
  }

  async balance(): Promise<Balance | null> {
    return null
  }

  /** 제출 본문 — 로컬 파일 입력은 업로드 URL을 받아 올린 뒤 공개 URL로 바꾼다 */
  private async body(req: GenerationRequest): Promise<Record<string, unknown>> {
    const b: Record<string, unknown> = { ...(req.params ?? {}) }
    if (req.prompt) b.prompt = req.prompt
    const imgs: string[] = []
    for (const i of req.inputs ?? []) {
      if (i.kind !== 'image') continue
      if (i.url) imgs.push(i.url)
      else if (i.path) imgs.push(await this.upload(i.path))
    }
    if (imgs.length === 1 && b.image_url === undefined) b.image_url = imgs[0]
    else if (imgs.length > 1 && b.image_urls === undefined) b.image_urls = imgs
    return b
  }

  private async upload(path: string): Promise<string> {
    const type = MIME[extname(path).toLowerCase()]
    if (!type) throw new Error(`Higgsfield가 받지 않는 파일 형식이에요: ${extname(path)}`)
    const r = await requestJson<{ public_url: string; upload_url: string; upload_headers?: Record<string, string> }>(this.fetchImpl, `${BASE}/files/generate-upload-url`, {
      headers: this.headers(),
      body: { content_type: type }
    })
    // 사전 서명 URL에는 API 인증 헤더를 붙이지 않는다
    const put = await this.fetchImpl(r.upload_url, { method: 'PUT', headers: r.upload_headers ?? { 'Content-Type': type }, body: await readFile(path), signal: AbortSignal.timeout(120000) })
    if (!put.ok) throw new Error(`입력 파일 업로드 실패 (HTTP ${put.status})`)
    return r.public_url
  }

  async estimate(req: GenerationRequest): Promise<Estimate> {
    const path = pathOf(req)
    if (!path) return { cost: null, note: '지원하지 않는 모델' }
    try {
      // 견적에는 입력 이미지가 필요 없는 경우가 많고, 업로드는 과금이 없지만 불필요하므로 URL 입력만 싣는다
      const b: Record<string, unknown> = { ...(req.params ?? {}) }
      if (req.prompt) b.prompt = req.prompt
      const url = req.inputs?.find((i) => i.kind === 'image' && i.url)?.url
      if (url && b.image_url === undefined) b.image_url = url
      const r = await requestJson<{ credits?: unknown; usd?: unknown }>(this.fetchImpl, `${BASE}/estimate/${path}`, { headers: this.headers(), body: b, timeoutMs: 15000 })
      const usd = num(r.usd)
      return usd == null ? { cost: null, note: '견적 응답에 금액이 없어요' } : { cost: { amount: usd, unit: 'usd', usd } }
    } catch (e) {
      return { cost: null, note: `견적 실패: ${(e as Error).message}` }
    }
  }

  async submit(req: GenerationRequest): Promise<{ remoteId: string }> {
    const path = pathOf(req)
    if (!path) throw new Error(`Higgsfield 모델 경로를 알 수 없어요: ${req.model}`)
    const r = await requestJson<{ request_id?: string }>(this.fetchImpl, `${BASE}/${path}`, { headers: this.headers(), body: await this.body(req) })
    if (!r.request_id) throw new Error('응답에 request_id가 없어요')
    return { remoteId: r.request_id }
  }

  async status(remoteId: string): Promise<RemoteStatus> {
    const r = await requestJson<StatusBody>(this.fetchImpl, `${BASE}/requests/${encodeURIComponent(remoteId)}/status`, { headers: this.headers(), timeoutMs: 15000 })
    switch (r.status) {
      case 'queued':
        return { state: 'queued' }
      case 'in_progress':
        return { state: 'running' }
      case 'completed': {
        const exp = Date.now() + RETENTION_MS
        const outs: ProviderOutput[] = []
        for (const i of r.images ?? []) if (i?.url) outs.push({ kind: 'image', url: i.url, expiresAt: exp })
        if (r.video?.url) outs.push({ kind: 'video', url: r.video.url, expiresAt: exp })
        if (r.audio?.url) outs.push({ kind: 'audio', url: r.audio.url, expiresAt: exp })
        for (const a of r.audios ?? []) if (a?.url) outs.push({ kind: 'audio', url: a.url, expiresAt: exp })
        return { state: 'succeeded', outputs: outs }
      }
      case 'nsfw':
        return { state: 'failed', error: '콘텐츠 정책에 걸려 생성되지 않았어요(과금 없음)' }
      case 'canceled':
        return { state: 'canceled' }
      case 'failed':
        return { state: 'failed', error: r.error || '생성 실패(과금 없음)' }
      default:
        return { state: 'running' }
    }
  }

  async cancel(remoteId: string): Promise<void> {
    await requestJson(this.fetchImpl, `${BASE}/requests/${encodeURIComponent(remoteId)}/cancel`, { method: 'POST', headers: this.headers() })
  }
}
