// 게이트웨이 로컬 HTTP API — 127.0.0.1에서만 열고, 매 실행마다 새 토큰을 요구한다.
// 접속 정보(port · token · pid)는 <home>/studio/gateway.json에 쓴다. 앱과 MCP 중계기가 이 파일을 읽는다.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Gateway, GatewayError, type GatewayEvent } from './gateway.ts'
import type { Ledger } from './ledger.ts'
import type { SecretStore } from './secrets.ts'
import type { GenerationRequest, JobState, Provider, ProviderId } from './types.ts'

export const VERSION = '0.1.0'
const MAX_BODY = 4 * 1024 * 1024
const STATES: JobState[] = ['awaiting_approval', 'rejected', 'submitting', 'running', 'succeeded', 'failed', 'canceled']

export interface ServerDeps {
  gateway: Gateway
  ledger: Ledger
  secrets: SecretStore | null
  providers: Provider[]
  infoFile: string | null
  /** 로컬 보관 폴더 — 'local:' 저장 키의 기준 */
  outputsDir?: string | null
  port?: number
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
    provider: typeof o.provider === 'string' ? (o.provider as ProviderId) : undefined
  }
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

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname
      if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true, version: VERSION })
      // 브라우저 교차 출처 요청 차단 + 토큰 확인
      if (req.headers.origin) return send(res, 403, { error: 'forbidden' })
      if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' })

      const seg = path.split('/').filter(Boolean)
      const gw = d.gateway

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
