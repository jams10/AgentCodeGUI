// 게이트웨이 로컬 HTTP API — 127.0.0.1에서만 열고, 매 실행마다 새 토큰을 요구한다.
// 접속 정보(port · token · pid)는 <home>/studio/gateway.json에 쓴다. 앱과 MCP 중계기가 이 파일을 읽는다.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import type { ModelInfo } from './models.ts'
import { pathToFileURL } from 'node:url'
import { Gateway, GatewayError, type GatewayEvent } from './gateway.ts'
import type { Ledger } from './ledger.ts'
import type { KeyStore } from './secrets.ts'
import type { GenerationRequest, JobRecord, JobState, Provider, ProviderId, StyleInput } from './types.ts'

export const VERSION = '0.1.0'
const MAX_BODY = 4 * 1024 * 1024
const CONTENT_TYPE: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.glb': 'model/gltf-binary', '.fbx': 'application/octet-stream', '.wav': 'audio/wav' }
const STATES: JobState[] = ['awaiting_approval', 'rejected', 'submitting', 'running', 'succeeded', 'failed', 'canceled']

export interface ServerDeps {
  gateway: Gateway
  ledger: Ledger
  secrets: KeyStore | null
  providers: Provider[]
  infoFile: string | null
  /** 로컬 보관 폴더 — 'local:' 저장 키의 기준 */
  outputsDir?: string | null
  /** 화면용 모델 카탈로그 */
  models?: ModelInfo[]
  port?: number
}

/** 앱 화면의 출처 — Windows 설치본(http(s)://tauri.localhost), 기타 플랫폼(tauri://localhost), 개발 서버(localhost:5273) */
export function isAppOrigin(origin: string): boolean {
  return /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost|http:\/\/localhost:5273)$/.test(origin)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new GatewayError('too_large', '요청 본문이 너무 커요'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve(null)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new GatewayError('bad_json', 'JSON 형식이 아니에요'))
      }
    })
    req.on('error', reject)
  })
}

/** 요청 본문 → GenerationRequest (형식만 확인 — 모델·파라미터 해석은 어댑터 몫) */
function asRequest(b: unknown): GenerationRequest {
  const o = (b ?? {}) as Record<string, unknown>
  if (!['image', 'video', 'model3d', 'audio'].includes(o.capability as string)) throw new GatewayError('bad_request', 'capability는 image · video · model3d · audio 중 하나여야 해요')
  if (typeof o.model !== 'string' || !o.model) throw new GatewayError('bad_request', 'model이 필요해요')
  return {
    capability: o.capability as GenerationRequest['capability'],
    model: o.model,
    prompt: typeof o.prompt === 'string' ? o.prompt : undefined,
    inputs: Array.isArray(o.inputs) ? (o.inputs as GenerationRequest['inputs']) : undefined,
    params: o.params && typeof o.params === 'object' ? (o.params as Record<string, unknown>) : undefined,
    origin: o.origin && typeof o.origin === 'object' ? (o.origin as GenerationRequest['origin']) : undefined,
    provider: typeof o.provider === 'string' ? (o.provider as ProviderId) : undefined,
    style: typeof o.style === 'string' && o.style.trim() ? o.style.trim() : undefined
  }
}

const KEY_PROVIDERS: ProviderId[] = ['comfy', 'tripo', 'higgsfield']

/** 키 모양 확인 — 서비스에 보내기 전에 흔한 실수(공백 · 빈 값 · 형식)를 잡는다. 문제가 없으면 null. */
export function keyProblem(p: ProviderId, key: string): string | null {
  if (!key) return '키를 입력해 주세요'
  if (key.length > 500) return '키가 너무 길어요'
  if (/\s/.test(key)) return '키에 공백이 들어 있어요 — 앞뒤 공백 · 줄바꿈 없이 붙여 넣어 주세요'
  if (p === 'higgsfield' && !/^[^:]+:[^:]+$/.test(key)) return 'Higgsfield 키는 "KEY_ID:KEY_SECRET" 형식이에요(콜론으로 이어 붙이기)'
  if (key.length < 8) return '키가 너무 짧아요'
  return null
}

const MAX_STYLE_TEXT = 2000
/** 스타일 본문 검증 — 이름은 필수(만들 때), 나머지는 선택. 너무 긴 값은 거절한다. */
function asStyle(b: unknown, creating: boolean): Partial<StyleInput> {
  const o = (b ?? {}) as Record<string, unknown>
  const out: Partial<StyleInput> = {}
  if (o.name !== undefined || creating) {
    if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 60) throw new GatewayError('bad_request', '스타일 이름은 1~60자여야 해요')
    out.name = o.name.trim()
  }
  for (const k of ['description', 'promptPrefix', 'promptSuffix', 'negative'] as const) {
    const v = o[k]
    if (v === undefined) continue
    if (v !== null && (typeof v !== 'string' || v.length > MAX_STYLE_TEXT)) throw new GatewayError('bad_request', `${k} 값이 올바르지 않아요`)
    out[k] = typeof v === 'string' && v.trim() ? v.trim() : null
  }
  return out
}

export interface RunningServer {
  server: Server
  port: number
  token: string
  broadcast: (e: GatewayEvent) => void
  close: () => Promise<void>
}

export async function startServer(d: ServerDeps): Promise<RunningServer> {
  const token = randomBytes(24).toString('hex')
  const streams = new Set<ServerResponse>()
  const byId = new Map(d.providers.map((p) => [p.id, p]))

  const broadcast = (e: GatewayEvent): void => {
    const line = `data: ${JSON.stringify(e)}\n\n`
    for (const s of streams) s.write(line)
  }
  const broadcastJob = (job: JobRecord): void => broadcast({ type: 'job', job })

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, version: VERSION })
      // 출처 확인 — 앱 화면(Tauri 웹뷰 · 개발 서버)만 허용하고 다른 웹 페이지는 막는다. 토큰은 별도로 필수.
      const origin = req.headers.origin
      if (origin) {
        if (!isAppOrigin(origin)) return send(res, 403, { error: 'forbidden' })
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '600' })
          return res.end()
        }
      }
      const seg = path.split('/').filter(Boolean)
      // 결과 파일만은 <img>/<video>가 헤더를 못 싣으므로 ?t=<토큰>도 받는다(127.0.0.1 · 실행마다 새 토큰)
      const isContent = req.method === 'GET' && seg[0] === 'outputs' && seg[2] === 'content'
      const authed = req.headers.authorization === `Bearer ${token}` || (isContent && url.searchParams.get('t') === token)
      if (!authed) return send(res, 401, { error: 'unauthorized' })
      const gw = d.gateway

      if (isContent && seg[1]) {
        const o = d.ledger.output(seg[1])
        if (!o) return send(res, 404, { error: 'not_found' })
        if (o.storageKey?.startsWith('local:') && d.outputsDir) {
          const abs = resolve(d.outputsDir, o.storageKey.slice('local:'.length))
          if (!abs.startsWith(resolve(d.outputsDir)) || !existsSync(abs)) return send(res, 404, { error: 'not_found' })
          res.writeHead(200, { 'Content-Type': o.mime ?? CONTENT_TYPE[extname(abs).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': statSync(abs).size, 'Cache-Control': 'private, max-age=3600' })
          createReadStream(abs).pipe(res)
          return
        }
        const p = byId.get(o.provider)
        const target = p?.resolveOutput ? await p.resolveOutput(o.url) : o.url
        res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' })
        return res.end()
      }
      if (req.method === 'GET' && path === '/models') {
        return send(
          res,
          200,
          (d.models ?? []).map((m) => {
            const providers = gw.routeFor(m.capability, m.id)
            return { ...m, providers, available: providers.some((x) => x.configured) }
          })
        )
      }
      // ── API 키 (설정 화면) — 원문은 받기만 하고 절대 돌려주지 않는다(끝 4자리 힌트만) ──
      if (seg[0] === 'keys') {
        if (!d.secrets) return send(res, 503, { error: 'no_keystore', message: '키 보관함을 쓸 수 없어요' })
        if (req.method === 'GET' && seg.length === 1) {
          const hints = new Map(d.secrets.list().map((k) => [k.provider, k]))
          return send(res, 200, KEY_PROVIDERS.map((p) => ({ provider: p, configured: hints.has(p), hint: hints.get(p)?.hint ?? null, updatedAt: hints.get(p)?.updatedAt ?? null })))
        }
        const p = seg[1] as ProviderId
        if (!KEY_PROVIDERS.includes(p)) return send(res, 404, { error: 'not_found' })
        if (req.method === 'POST' && seg.length === 2) {
          const b = ((await readBody(req)) ?? {}) as { key?: unknown }
          const key = typeof b.key === 'string' ? b.key.trim() : ''
          const bad = keyProblem(p, key)
          if (bad) throw new GatewayError('bad_request', bad)
          await d.secrets.set(p, key)
          broadcast({ type: 'providers' })
          return send(res, 200, { ok: true, hint: d.secrets.list().find((k) => k.provider === p)?.hint ?? null })
        }
        if (req.method === 'POST' && seg[2] === 'delete') {
          const removed = d.secrets.remove(p)
          broadcast({ type: 'providers' })
          return send(res, 200, { ok: removed })
        }
        if (req.method === 'POST' && seg[2] === 'test') {
          try {
            return send(res, 200, { ok: true, message: await gw.verify(p) })
          } catch (e) {
            return send(res, 200, { ok: false, message: (e as Error).message })
          }
        }
      }
      // ── 스타일 ──
      if (req.method === 'GET' && path === '/styles') return send(res, 200, d.ledger.styles())
      if (req.method === 'POST' && path === '/styles') {
        const s = asStyle(await readBody(req), true) as StyleInput
        if (d.ledger.style(s.name)) throw new GatewayError('bad_request', `'${s.name}' 스타일이 이미 있어요`)
        const created = d.ledger.createStyle(s)
        broadcast({ type: 'styles' })
        return send(res, 201, created)
      }
      if (req.method === 'POST' && seg[0] === 'styles' && seg[1] && seg.length === 2) {
        const patch = asStyle(await readBody(req), false)
        if (patch.name) {
          const same = d.ledger.style(patch.name)
          if (same && same.id !== seg[1]) throw new GatewayError('bad_request', `'${patch.name}' 스타일이 이미 있어요`)
        }
        const s = d.ledger.updateStyle(seg[1], patch)
        if (s) broadcast({ type: 'styles' })
        return s ? send(res, 200, s) : send(res, 404, { error: 'not_found' })
      }
      if (req.method === 'POST' && seg[0] === 'styles' && seg[1] && seg[2] === 'delete') {
        const gone = d.ledger.deleteStyle(seg[1])
        if (gone) broadcast({ type: 'styles' })
        return gone ? send(res, 200, { ok: true }) : send(res, 404, { error: 'not_found' })
      }
      if (req.method === 'POST' && seg[0] === 'jobs' && seg[1] && seg[2] === 'style') {
        const b = ((await readBody(req)) ?? {}) as { styleId?: unknown }
        const sid = typeof b.styleId === 'string' && b.styleId ? b.styleId : null
        if (sid && !d.ledger.style(sid)) throw new GatewayError('not_found', '스타일을 찾지 못했어요')
        const j = d.ledger.setJobStyle(seg[1], sid)
        if (!j) return send(res, 404, { error: 'not_found' })
        broadcastJob(j)
        broadcast({ type: 'styles' }) // 스타일별 개수가 바뀐다
        return send(res, 200, j)
      }
      if (req.method === 'GET' && path === '/outputs') {
        return send(res, 200, d.ledger.recentOutputs(Number(url.searchParams.get('limit') ?? 200)))
      }

      if (req.method === 'GET' && path === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
        res.write(': ok\n\n')
        streams.add(res)
        req.on('close', () => streams.delete(res))
        return
      }
      if (req.method === 'GET' && path === '/providers') {
        const hints = new Map((d.secrets?.list() ?? []).map((k) => [k.provider, k.hint]))
        return send(res, 200, gw.providerList().map((p) => ({ ...p, keyHint: hints.get(p.id) ?? null, lastBalance: d.ledger.lastBalance(p.id) })))
      }
      if (req.method === 'GET' && path === '/balances') return send(res, 200, await gw.balances())
      if (req.method === 'GET' && path === '/spend') {
        const since = Number(url.searchParams.get('since') ?? 0)
        return send(res, 200, d.ledger.spend(Number.isFinite(since) ? since : 0))
      }
      if (req.method === 'GET' && path === '/jobs') {
        const st = url.searchParams.get('state') as JobState | null
        return send(res, 200, d.ledger.jobs({ limit: Number(url.searchParams.get('limit') ?? 100), state: st && STATES.includes(st) ? st : undefined }))
      }
      if (req.method === 'POST' && path === '/jobs') return send(res, 201, await gw.quote(asRequest(await readBody(req))))
      if (seg[0] === 'jobs' && seg[1]) {
        const id = seg[1]
        if (req.method === 'GET' && seg.length === 2) {
          const job = d.ledger.job(id)
          return job ? send(res, 200, { job, outputs: d.ledger.outputs(id) }) : send(res, 404, { error: 'not_found' })
        }
        if (req.method === 'GET' && seg[2] === 'wait') {
          const t = Math.max(0, Math.min(30 * 60 * 1000, Number(url.searchParams.get('timeout') ?? 60000)))
          const job = await gw.waitFor(id, t)
          return send(res, 200, { job, outputs: d.ledger.outputs(id) })
        }
        if (req.method === 'POST' && seg[2] === 'approve') return send(res, 200, await gw.approve(id))
        if (req.method === 'POST' && seg[2] === 'revise') {
          const b = ((await readBody(req)) ?? {}) as { prompt?: unknown; params?: unknown }
          const params = b.params && typeof b.params === 'object' && !Array.isArray(b.params) ? (b.params as Record<string, unknown>) : undefined
          return send(res, 200, await gw.revise(id, { prompt: typeof b.prompt === 'string' ? b.prompt : undefined, params }))
        }
        if (req.method === 'POST' && seg[2] === 'reject') return send(res, 200, gw.reject(id))
        if (req.method === 'POST' && seg[2] === 'cancel') return send(res, 200, await gw.cancel(id))
      }
      if (req.method === 'GET' && seg[0] === 'outputs' && seg[1] && seg[2] === 'url') {
        const o = d.ledger.output(seg[1])
        if (!o) return send(res, 404, { error: 'not_found' })
        // 보관본이 있으면 그것을(서비스 링크는 만료될 수 있다)
        if (o.storageKey?.startsWith('local:') && d.outputsDir) {
          const abs = resolve(d.outputsDir, o.storageKey.slice('local:'.length))
          if (!abs.startsWith(resolve(d.outputsDir))) return send(res, 400, { error: 'bad_storage_key' })
          return send(res, 200, { url: pathToFileURL(abs).href, localPath: abs, stored: true })
        }
        const p = byId.get(o.provider)
        return send(res, 200, { url: p?.resolveOutput ? await p.resolveOutput(o.url) : o.url, stored: false, expiresAt: o.expiresAt })
      }
      return send(res, 404, { error: 'not_found' })
    } catch (e) {
      if (e instanceof GatewayError) {
        const status = e.code === 'not_found' ? 404 : e.code === 'bad_state' ? 409 : 400
        return send(res, status, { error: e.code, message: e.message, details: e.details ?? null })
      }
      return send(res, 500, { error: 'internal', message: (e as Error).message })
    }
  })

  await new Promise<void>((resolve) => server.listen(d.port ?? 0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  if (d.infoFile) {
    mkdirSync(dirname(d.infoFile), { recursive: true })
    writeFileSync(d.infoFile, JSON.stringify({ port, token, pid: process.pid, version: VERSION, startedAt: Date.now() }), { encoding: 'utf8', mode: 0o600 })
  }
  const close = async (): Promise<void> => {
    for (const s of streams) s.end()
    await new Promise<void>((r) => server.close(() => r()))
    if (d.infoFile) rmSync(d.infoFile, { force: true })
  }
  return { server, port, token, broadcast, close }
}
