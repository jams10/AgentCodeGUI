import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { safeStorage, shell, type WebContents } from 'electron'
import { APP_HOME } from './engine/versions'
import { writeFileAtomic } from './atomicWrite'
import { t } from './lang'
import { IPC } from '@shared/protocol'
import type { McpOAuthEvent, McpOAuthState } from '@shared/protocol'

/* ============================================================
 * MCP OAuth — http/sse MCP 서버(Comfy Cloud 등)의 로그인 토큰을 "앱이" 갖는다.
 *
 * 왜 필요한가: Claude Code는 MCP OAuth 토큰을 config 폴더의 .credentials.json →
 * mcpOAuth[key]에 둔다. 터미널에서 /mcp 로 로그인하면 전역 ~/.claude/.credentials.json에
 * 남지만, 이 앱은 계정마다 격리 config 폴더(CLAUDE_CONFIG_DIR)로 돌기 때문에 그 토큰을
 * 전혀 보지 못했다 — 게다가 헤드리스(-p) 실행은 OAuth 흐름을 못 열어 매번 "대화형 세션에서
 * 인증하라"는 안내만 떴다. 그래서:
 *  ① 앱 보관소(mcp-oauth.json, safeStorage 암호화)를 단일 원본으로 두고
 *  ② 계정 폴더를 물질화할 때마다 보관소 → 폴더 .credentials.json 에 병합(materialize),
 *     실행이 끝나면 CLI가 리프레시한 토큰을 폴더 → 보관소로 되거둔다(harvest)
 *  ③ OAuth 흐름(디스커버리 → 동적 클라이언트 등록 → PKCE → 브라우저 → 콜백 → 교환)을
 *     앱 안에서 직접 돌려 저장하고, 터미널 전역 토큰도 가져올 수 있다.
 *
 * 저장 포맷은 CLI 실물(claude.exe 문자열 실측)을 그대로 따른다:
 *  key = `${serverName}|${sha256(JSON.stringify({type,url,headers:headers||{}})).slice(0,16)}`
 *  record = { serverName, serverUrl, accessToken, refreshToken?, expiresAt?, clientId?,
 *             clientSecret?, redirectUri?, scope?, discoveryState? … }
 * (터미널이 저장해 둔 comfy-cloud 레코드로 해시 일치 확인: 1e1ead924ea609a1)
 * ============================================================ */

export interface McpOAuthRecord {
  serverName: string
  serverUrl: string
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  clientId?: string
  clientSecret?: string
  redirectUri?: string
  scope?: string
  issuer?: string
  discoveryState?: { authorizationServerUrl: string; resourceMetadataUrl?: string; oauthMetadataFound?: boolean }
  [extra: string]: unknown // CLI가 적는 다른 필드는 그대로 보존
}
type Store = Record<string, McpOAuthRecord>

export interface McpUrlSpec {
  type: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
}

const STORE_PATH = path.join(APP_HOME, 'mcp-oauth.json')
// 계정 폴더 위치는 auth.ts 규약(격리 dev의 CCG_HOME과 무관하게 실계정 공유)을 따른다
const ACCOUNTS_DIR = path.join(os.homedir(), '.agentcodegui', 'accounts')
const GLOBAL_CREDS = path.join(os.homedir(), '.claude', '.credentials.json')

/** CLI와 같은 키 — 서버 이름 + 설정(type/url/headers) 해시. headers는 치환 후 값으로. */
export function mcpOAuthKey(name: string, spec: McpUrlSpec): string {
  const s = JSON.stringify({ type: spec.type, url: spec.url, headers: spec.headers ?? {} })
  return `${name}|${createHash('sha256').update(s).digest('hex').slice(0, 16)}`
}

// ── 보관소 ────────────────────────────────────────────────────
function readStore(): Store {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as { enc?: boolean; data?: string }
    if (!j || typeof j.data !== 'string') return {}
    const raw = j.enc ? safeStorage.decryptString(Buffer.from(j.data, 'base64')) : j.data
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Store) : {}
  } catch {
    return {}
  }
}
function writeStore(store: Store): void {
  fs.mkdirSync(APP_HOME, { recursive: true })
  const raw = JSON.stringify(store)
  const file = safeStorage.isEncryptionAvailable()
    ? { enc: true, data: safeStorage.encryptString(raw).toString('base64') }
    : { enc: false, data: raw }
  writeFileAtomic(STORE_PATH, JSON.stringify(file))
}

function hasTokens(r: McpOAuthRecord | undefined): boolean {
  return !!(r && (r.accessToken || r.refreshToken))
}
// 신선도 — 토큰 없는 껍데기(취소·실패 흔적)는 0, 있으면 만료시각(모르면 1)
function score(r: McpOAuthRecord | undefined): number {
  if (!hasTokens(r)) return 0
  return typeof r!.expiresAt === 'number' ? Math.max(1, r!.expiresAt) : 1
}
/** from의 레코드 중 더 신선한 것만 into에 얹는다. 바뀐 게 있으면 true. */
function merge(into: Store, from: Store): boolean {
  let changed = false
  for (const [k, r] of Object.entries(from)) {
    if (!r || typeof r !== 'object') continue
    const cur = into[k]
    if (!cur || score(r) > score(cur)) {
      into[k] = r
      changed = true
    }
  }
  return changed
}

function readCreds(file: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}
function credsOAuth(cj: Record<string, unknown> | null): Store {
  const m = cj?.mcpOAuth
  return m && typeof m === 'object' ? (m as Store) : {}
}

/** 폴더 .credentials.json의 mcpOAuth 중 보관소보다 신선한 것을 거둔다(CLI 리프레시 반영). */
export function harvestMcpOAuth(credPath: string): void {
  try {
    const from = credsOAuth(readCreds(credPath))
    if (Object.keys(from).length === 0) return
    const store = readStore()
    if (merge(store, from)) writeStore(store)
  } catch {
    /* ignore */
  }
}

/**
 * CLI의 "인증 필요" 캐시 — 한 번 401로 끝난 http/sse 서버는 config 폴더의
 * mcp-needs-auth-cache.json에 {이름: {timestamp}}로 적히고, TTL 동안 다음 스폰이 접속을
 * 아예 건너뛴다(바이너리 실측: "Skipping connection (cached needs-auth)"). 토큰을 새로
 * 넣어도 이 표식이 남아 있으면 여전히 "인증 필요"로 뜨므로, 토큰을 물질화할 때 그 서버의
 * 표식을 지운다. 접속에 실패하면 CLI가 다시 적으니 지워서 잃는 것은 없다.
 */
export function clearNeedsAuthCache(configDir: string, serverNames: Iterable<string>): void {
  const file = path.join(configDir, 'mcp-needs-auth-cache.json')
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    if (!j || typeof j !== 'object') return
    let changed = false
    for (const name of serverNames) {
      if (name in j) {
        delete j[name]
        changed = true
      }
    }
    if (changed) fs.writeFileSync(file, JSON.stringify(j))
  } catch {
    /* 없음/손상 — 지울 것도 없다 */
  }
}

/** 보관소의 토큰을 폴더 .credentials.json의 mcpOAuth에 병합(폴더 쪽이 더 신선하면 유지).
 *  토큰이 있는 서버는 CLI의 "인증 필요" 캐시 표식도 걷어 다음 스폰이 실제로 접속하게 한다. */
export function materializeMcpOAuth(credPath: string): void {
  try {
    const cj = readCreds(credPath)
    if (!cj) return
    const store = readStore()
    if (Object.keys(store).length === 0) return
    const cur = { ...credsOAuth(cj) }
    const changed = merge(cur, store)
    if (changed) {
      cj.mcpOAuth = cur
      fs.writeFileSync(credPath, JSON.stringify(cj, null, 2))
    }
    clearNeedsAuthCache(
      path.dirname(credPath),
      Object.values(cur)
        .filter(hasTokens)
        .map((r) => r.serverName)
    )
  } catch {
    /* ignore */
  }
}

function accountCredFiles(): string[] {
  try {
    return fs
      .readdirSync(ACCOUNTS_DIR)
      .map((slug) => path.join(ACCOUNTS_DIR, slug, '.credentials.json'))
      .filter((p) => fs.existsSync(p))
  } catch {
    return []
  }
}
/** 등록된 모든 계정 폴더에 지금 바로 반영 — 다음 스폰을 기다리지 않게. */
function materializeAll(): void {
  for (const f of accountCredFiles()) materializeMcpOAuth(f)
}

/** 터미널 Claude Code(~/.claude/.credentials.json)에 남은 MCP 토큰 가져오기 → 보관소 총 연결 수 */
export function importGlobalMcpOAuth(): number {
  harvestMcpOAuth(GLOBAL_CREDS)
  materializeAll()
  return Object.values(readStore()).filter(hasTokens).length
}

// 앱 시작 시 1회 — 터미널에서 이미 로그인해 둔 서버(Comfy Cloud 등)가 첫 실행부터 붙게.
const IMPORT_MARK = path.join(APP_HOME, '.mcp-oauth-imported')
export function importGlobalMcpOAuthOnce(): void {
  try {
    if (fs.existsSync(IMPORT_MARK)) return
    importGlobalMcpOAuth()
    fs.mkdirSync(APP_HOME, { recursive: true })
    fs.writeFileSync(IMPORT_MARK, String(Date.now()))
  } catch {
    /* ignore */
  }
}

export function mcpOAuthState(name: string, spec: McpUrlSpec): McpOAuthState {
  const r = readStore()[mcpOAuthKey(name, spec)]
  return {
    connected: hasTokens(r),
    expiresAt: typeof r?.expiresAt === 'number' ? r.expiresAt : null,
    hasRefresh: !!r?.refreshToken
  }
}

/** Main-process use only. Reuse the configured Comfy login for billing reads. */
export function comfyAppAccessToken(): { accessToken: string; expiresAt: number | null } | null {
  const record = Object.values(readStore())
    .filter(r => r.serverUrl === 'https://cloud.comfy.org/mcp' && r.accessToken)
    .sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0]
  return record ? { accessToken: record.accessToken, expiresAt: record.expiresAt ?? null } : null
}

/** 연결 해제 — 보관소와 모든 계정 폴더에서 이 서버의 토큰을 지운다(터미널 전역은 불가침). */
export function disconnectMcpOAuth(name: string, spec: McpUrlSpec): void {
  const key = mcpOAuthKey(name, spec)
  const store = readStore()
  if (store[key]) {
    delete store[key]
    writeStore(store)
  }
  for (const f of accountCredFiles()) {
    try {
      const cj = readCreds(f)
      const m = credsOAuth(cj)
      if (!cj || !m[key]) continue
      delete m[key]
      cj.mcpOAuth = m
      fs.writeFileSync(f, JSON.stringify(cj, null, 2))
    } catch {
      /* ignore */
    }
  }
}

// ── OAuth 흐름 (RFC 9728 보호 리소스 메타데이터 → RFC 8414/OIDC 인가 서버 메타데이터 →
//    RFC 7591 동적 클라이언트 등록 → PKCE S256 인가 코드 → 로컬 콜백 → 토큰 교환) ──
interface AsMeta {
  authorization_endpoint: string
  token_endpoint: string
  registration_endpoint?: string
  scopes_supported?: string[]
}
interface Discovery {
  authServer: string
  meta: AsMeta
  metaFound: boolean
  resourceMetadataUrl?: string
  scopes?: string[]
}

async function getJson(url: string, init: RequestInit = {}, timeoutMs = 10000): Promise<{ status: number; json: Record<string, unknown> | null; headers: Headers }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    let json: Record<string, unknown> | null = null
    try {
      const text = await res.text()
      const v = JSON.parse(text)
      json = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
    } catch {
      /* JSON 아님 */
    }
    return { status: res.status, json, headers: res.headers }
  } finally {
    clearTimeout(timer)
  }
}

function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined
}

/** 디스커버리만 따로(진단·PoC용) — 인가 서버와 엔드포인트를 찾는다. */
export async function discoverMcpOAuth(spec: McpUrlSpec): Promise<Discovery> {
  return discover(spec)
}

async function discover(spec: McpUrlSpec): Promise<Discovery> {
  const serverUrl = spec.url
  const u = new URL(serverUrl)
  // 1) 보호 리소스 메타데이터 — 서버를 한 번 찔러 401의 WWW-Authenticate가 가리키는 주소가
  //    최우선, 그다음 well-known 후보(경로 삽입형·경로 뒤 붙임형·루트)
  const prCands: string[] = []
  try {
    const probe = await getJson(
      serverUrl,
      {
        method: 'POST',
        headers: { ...(spec.headers ?? {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'AgentCodeGUI', version: '1' } }
        })
      },
      8000
    )
    const m = probe.headers.get('www-authenticate')?.match(/resource_metadata="([^"]+)"/)
    if (m) prCands.push(m[1])
  } catch {
    /* 서버가 안 열려도 well-known으로 계속 */
  }
  const pathPart = u.pathname.replace(/\/$/, '')
  if (pathPart) prCands.push(`${u.origin}/.well-known/oauth-protected-resource${pathPart}`)
  prCands.push(`${serverUrl.replace(/\/$/, '')}/.well-known/oauth-protected-resource`)
  prCands.push(`${u.origin}/.well-known/oauth-protected-resource`)

  let authServer = u.origin
  let resourceMetadataUrl: string | undefined
  let scopes: string[] | undefined
  for (const c of [...new Set(prCands)]) {
    try {
      const r = await getJson(c, { headers: { accept: 'application/json' } }, 8000)
      const servers = strArr(r.json?.authorization_servers)
      if (r.status >= 200 && r.status < 300 && servers && servers.length) {
        authServer = servers[0]
        resourceMetadataUrl = c
        scopes = strArr(r.json?.scopes_supported)
        break
      }
    } catch {
      /* 다음 후보 */
    }
  }

  // 2) 인가 서버 메타데이터
  const a = new URL(authServer)
  const ap = a.pathname.replace(/\/$/, '')
  const asCands = ap
    ? [`${a.origin}/.well-known/oauth-authorization-server${ap}`, `${a.origin}/.well-known/openid-configuration${ap}`, `${a.origin}${ap}/.well-known/openid-configuration`]
    : [`${a.origin}/.well-known/oauth-authorization-server`, `${a.origin}/.well-known/openid-configuration`]
  for (const c of asCands) {
    try {
      const r = await getJson(c, { headers: { accept: 'application/json' } }, 8000)
      const j = r.json
      if (r.status >= 200 && r.status < 300 && typeof j?.authorization_endpoint === 'string' && typeof j?.token_endpoint === 'string') {
        return {
          authServer,
          metaFound: true,
          resourceMetadataUrl,
          scopes: scopes ?? strArr(j.scopes_supported),
          meta: {
            authorization_endpoint: j.authorization_endpoint,
            token_endpoint: j.token_endpoint,
            registration_endpoint: typeof j.registration_endpoint === 'string' ? j.registration_endpoint : undefined,
            scopes_supported: strArr(j.scopes_supported)
          }
        }
      }
    } catch {
      /* 다음 후보 */
    }
  }
  // 메타데이터가 없으면 관례 경로로(MCP 사양의 폴백)
  const base = authServer.replace(/\/$/, '')
  return {
    authServer,
    metaFound: false,
    resourceMetadataUrl,
    scopes,
    meta: { authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` }
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const DONE_HTML = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:#15161a;color:#e8e8ea;font:15px system-ui,sans-serif"><div style="text-align:center;max-width:420px;padding:24px"><div style="font-size:22px;font-weight:700;margin-bottom:10px">${title}</div><div style="color:#9a9ba3;line-height:1.6">${body}</div></div></body>`

interface Active {
  name: string
  cancel: (reason: string) => void
}
let active: Active | null = null

export function cancelMcpOAuth(): void {
  active?.cancel('cancelled')
}

async function postForm(url: string, body: URLSearchParams): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const r = await getJson(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() }, 15000)
  return { status: r.status, json: r.json }
}

/**
 * 브라우저 OAuth로 이 서버에 연결하고 토큰을 보관소 + 모든 계정 폴더에 저장한다.
 * 한 번에 하나만 진행(새 요청이 이전 것을 중단). 5분 제한. 진행 상황은 mcpOAuthEvent로.
 */
export async function connectMcpOAuth(name: string, spec: McpUrlSpec, wc: WebContents): Promise<{ ok: boolean; error?: string }> {
  active?.cancel('superseded')
  const send = (ev: McpOAuthEvent): void => {
    if (!wc.isDestroyed()) wc.send(IPC.mcpOAuthEvent, ev)
  }
  const fail = (error: string): { ok: false; error: string } => {
    send({ name, phase: 'error', error })
    return { ok: false, error }
  }

  let disc: Discovery
  try {
    disc = await discover(spec)
  } catch (e) {
    return fail(t(`서버 정보를 읽지 못했어요: ${String((e as Error)?.message ?? e)}`, `Could not read server metadata: ${String((e as Error)?.message ?? e)}`))
  }

  // 로컬 콜백 서버 — 포트는 OS가 고르고, redirect_uri는 CLI와 같은 localhost 형식
  const server = http.createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') resolve(addr.port)
      else reject(new Error('listen failed'))
    })
  }).catch((e) => {
    fail(t(`콜백 포트를 열지 못했어요: ${String(e)}`, `Could not open a callback port: ${String(e)}`))
    return null
  })
  if (port == null) return { ok: false, error: 'listen' }
  const redirectUri = `http://localhost:${port}/callback`

  const closeServer = (): void => {
    try {
      server.close()
    } catch {
      /* ignore */
    }
  }

  try {
    // 클라이언트 — 동적 등록(가능하면 매번 새로: redirect_uri의 포트가 매번 다르다),
    // 등록 엔드포인트가 없으면 이전에 저장된 client_id 재사용
    const key = mcpOAuthKey(name, spec)
    const prev = readStore()[key]
    let clientId: string | undefined
    let clientSecret: string | undefined
    const scopeStr = disc.scopes?.length ? disc.scopes.join(' ') : undefined
    if (disc.meta.registration_endpoint) {
      try {
        const r = await getJson(
          disc.meta.registration_endpoint,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              client_name: 'AgentCodeGUI',
              redirect_uris: [redirectUri],
              grant_types: ['authorization_code', 'refresh_token'],
              response_types: ['code'],
              token_endpoint_auth_method: 'none',
              ...(scopeStr ? { scope: scopeStr } : {})
            })
          },
          15000
        )
        if (typeof r.json?.client_id === 'string') {
          clientId = r.json.client_id
          clientSecret = typeof r.json.client_secret === 'string' ? r.json.client_secret : undefined
        }
      } catch {
        /* 등록 실패 — 저장된 client_id로 폴백 */
      }
    }
    if (!clientId && prev?.clientId) {
      clientId = prev.clientId
      clientSecret = prev.clientSecret
    }
    if (!clientId) {
      closeServer()
      return fail(
        t(
          '이 서버는 동적 클라이언트 등록을 지원하지 않아 앱에서 바로 연결할 수 없어요. 터미널에서 claude /mcp 로 연결한 뒤 "터미널에서 가져오기"를 눌러 주세요.',
          'This server does not support dynamic client registration, so the app cannot connect directly. Sign in with claude /mcp in a terminal, then use "Import from terminal".'
        )
      )
    }

    // PKCE + state → 인가 URL
    const verifier = b64url(randomBytes(48))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(24))
    const authUrl = new URL(disc.meta.authorization_endpoint)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('state', state)
    if (scopeStr) authUrl.searchParams.set('scope', scopeStr)
    authUrl.searchParams.set('resource', spec.url) // RFC 8707 — MCP 사양이 요구

    // 콜백 대기 (취소·5분 제한)
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => cancel('timeout'), 5 * 60 * 1000)
      const cancel = (reason: string): void => {
        clearTimeout(timer)
        if (active?.name === name) active = null
        reject(new Error(reason))
      }
      active = { name, cancel }
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', `http://localhost:${port}`)
        if (url.pathname !== '/callback') {
          res.writeHead(404).end()
          return
        }
        const err = url.searchParams.get('error')
        const st = url.searchParams.get('state')
        const c = url.searchParams.get('code')
        if (err || st !== state || !c) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
          res.end(DONE_HTML(t('연결 실패', 'Sign-in failed'), err ? `${err}: ${url.searchParams.get('error_description') ?? ''}` : t('상태 값이 맞지 않아요. 앱에서 다시 시도해 주세요.', 'State mismatch. Try again from the app.')))
          cancel(err ? `${err}: ${url.searchParams.get('error_description') ?? ''}` : 'state mismatch')
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(DONE_HTML(t('연결됐어요', 'Connected'), t('이 탭을 닫고 AgentCodeGUI로 돌아가세요.', 'You can close this tab and return to AgentCodeGUI.')))
        clearTimeout(timer)
        if (active?.name === name) active = null
        resolve(c)
      })
      send({ name, phase: 'url', url: authUrl.toString() })
      void shell.openExternal(authUrl.toString())
    }).finally(closeServer)

    // 토큰 교환 — resource를 거부하는 서버(invalid_target 등)는 빼고 한 번 더
    const form = (withResource: boolean): URLSearchParams => {
      const b = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId!, code_verifier: verifier })
      if (clientSecret) b.set('client_secret', clientSecret)
      if (withResource) b.set('resource', spec.url)
      return b
    }
    let tok = await postForm(disc.meta.token_endpoint, form(true))
    if (!(tok.status >= 200 && tok.status < 300 && typeof tok.json?.access_token === 'string')) {
      tok = await postForm(disc.meta.token_endpoint, form(false))
    }
    if (!(tok.status >= 200 && tok.status < 300 && typeof tok.json?.access_token === 'string')) {
      const desc = tok.json ? `${tok.json.error ?? tok.status}${tok.json.error_description ? ': ' + tok.json.error_description : ''}` : String(tok.status)
      return fail(t(`토큰 교환에 실패했어요 (${desc})`, `Token exchange failed (${desc})`))
    }
    const j = tok.json
    const expiresIn = typeof j.expires_in === 'number' ? j.expires_in : typeof j.expires_in === 'string' ? parseInt(j.expires_in, 10) : NaN
    const record: McpOAuthRecord = {
      ...(prev ?? {}),
      serverName: name,
      serverUrl: spec.url,
      accessToken: j.access_token as string,
      refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : prev?.refreshToken,
      expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
      clientId,
      clientSecret,
      redirectUri,
      scope: typeof j.scope === 'string' ? j.scope : scopeStr,
      discoveryState: {
        authorizationServerUrl: disc.authServer,
        ...(disc.resourceMetadataUrl ? { resourceMetadataUrl: disc.resourceMetadataUrl } : {}),
        oauthMetadataFound: disc.metaFound
      }
    }
    if (!record.clientSecret) delete record.clientSecret
    if (record.expiresAt === undefined) delete record.expiresAt
    const store = readStore()
    store[key] = record
    writeStore(store)
    materializeAll()
    send({ name, phase: 'done' })
    return { ok: true }
  } catch (e) {
    closeServer()
    const msg = String((e as Error)?.message ?? e)
    if (msg === 'cancelled' || msg === 'superseded') {
      send({ name, phase: 'cancelled' })
      return { ok: false, error: 'cancelled' }
    }
    if (msg === 'timeout') return fail(t('5분 안에 브라우저 승인이 없어 중단했어요.', 'No browser approval within 5 minutes — stopped.'))
    return fail(msg)
  }
}
