import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { APP_HOME } from './engine/versions'
import { ancestorDirs } from './paths'
import { writeFileAtomic } from './atomicWrite'
import { expandDeep, secretEnv, secretValues } from './secrets'
import { COMFY_KEY, COMFY_KEY_REF, COMFY_URL, comfyKeyHeader } from './comfyConfig'
import { mcpOAuthState, type McpUrlSpec } from './mcpOAuth'
import { t } from './lang'
import type { McpServerInfo, McpOrigin, McpTransport, McpServerSpec, McpImportCandidate, McpPrefs } from '@shared/protocol'

/* ============================================================
 * MCP 서버 — 앱이 직접 갖는 레지스트리 + 실행 환경이 보는 서버 열거.
 *
 * 앱의 모든 실행은 계정별 격리 config 폴더(CLAUDE_CONFIG_DIR)로 돌기 때문에, 터미널에서
 * `claude mcp add`로 ~/.claude.json에 넣은 서버(전역·프로젝트별)는 앱 실행에 전혀
 * 보이지 않았다. 그래서 앱 홈(mcp.json)에 서버를 등록하고, 스폰마다 SDK `mcpServers`
 * 옵션으로 주입한다 — 계정·프로젝트·창을 가리지 않고 모든 대화에서 쓰인다.
 *  - servers: 앱 등록 서버(원문 — ${KEY}는 실행 직전 보관함으로 치환)
 *  - disabled: 끈 서버 이름(모든 범위 공통, SDK deniedMcpServers로 적용)
 *  - allowProjectMcp: 프로젝트 .mcp.json을 묻지 않고 허용(enableAllProjectMcpServers)
 * 터미널 설정은 읽기만 한다(가져오기 후보) — ~/.claude.json은 절대 쓰지 않는다.
 * ============================================================ */
const STORE_PATH = path.join(APP_HOME, 'mcp.json')

// 터미널 Claude Code의 설정 위치(가져오기 후보용):
//   ~/.claude.json  → mcpServers           (user / 전역)
//                   → projects[dir].mcpServers (local / 프로젝트 전용)
//   <dir>/.mcp.json → mcpServers           (project / 저장소 공유)
const USER_CONFIG = path.join(os.homedir(), '.claude.json')
// 플러그인 — 계정 폴더의 plugins가 정션으로 가리키는 공유 원본(auth.ts SHARED_DIRS)
const PLUGINS_DIR = path.join(os.homedir(), '.agentcodegui', 'shared', 'plugins')

interface StoreFile {
  disabled?: string[]
  servers?: Record<string, McpServerSpec>
  allowProjectMcp?: boolean
}

function readStore(): StoreFile {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
    return j && typeof j === 'object' ? (j as StoreFile) : {}
  } catch {
    return {}
  }
}
function writeStore(s: StoreFile): void {
  fs.mkdirSync(APP_HOME, { recursive: true })
  writeFileAtomic(STORE_PATH, JSON.stringify(s, null, 2))
}

/** Names the user has disabled. Keyed by name, matching deniedMcpServers' serverName. */
function readDisabled(): Set<string> {
  const list = readStore().disabled
  return new Set(Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : [])
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 임의의 mcpServers 항목(터미널·플러그인·.mcp.json 포맷)을 앱 원문 스펙으로 정규화. */
export function normalizeSpec(cfg: unknown): McpServerSpec | null {
  if (!cfg || typeof cfg !== 'object') return null
  const c = cfg as Record<string, unknown>
  if (typeof c.command === 'string' && c.command.trim()) {
    const args = Array.isArray(c.args) ? c.args.filter((a): a is string => typeof a === 'string') : []
    const env = c.env && typeof c.env === 'object' ? Object.fromEntries(Object.entries(c.env as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) : {}
    return { type: 'stdio', command: c.command.trim(), ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env: env as Record<string, string> } : {}) }
  }
  if (typeof c.url === 'string' && c.url.trim()) {
    const headers = c.headers && typeof c.headers === 'object' ? Object.fromEntries(Object.entries(c.headers as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) : {}
    return { type: c.type === 'sse' ? 'sse' : 'http', url: c.url.trim(), ...(Object.keys(headers).length ? { headers: headers as Record<string, string> } : {}) }
  }
  return null
}

// derive a transport + one-line summary (command line or URL) from a spec
function describe(spec: McpServerSpec | null): { transport: McpTransport; detail: string } {
  if (!spec) return { transport: 'unknown', detail: '' }
  if (spec.type === 'stdio') return { transport: 'stdio', detail: `${spec.command} ${(spec.args ?? []).join(' ')}`.trim() }
  return { transport: spec.type, detail: spec.url }
}

// Claude Code keys ~/.claude.json projects by absolute path. The app's cwd may use
// different separators/casing than what's stored — and the user may have registered
// servers from the repo root while the app opened a subfolder — so match loosely
// against cwd and each parent. The nearest entry that actually has servers wins.
function findProjectEntry(projects: unknown, cwd: string): { dir: string; entry: Record<string, unknown> } | null {
  if (!projects || typeof projects !== 'object' || !cwd) return null
  const map = projects as Record<string, Record<string, unknown>>
  const norm = (s: string): string => s.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  const byNorm = new Map<string, { dir: string; entry: Record<string, unknown> }>()
  for (const k of Object.keys(map)) if (!byNorm.has(norm(k))) byNorm.set(norm(k), { dir: k, entry: map[k] })
  for (const dir of ancestorDirs(cwd)) {
    const hit = byNorm.get(norm(dir))
    if (hit && hit.entry.mcpServers && typeof hit.entry.mcpServers === 'object' && Object.keys(hit.entry.mcpServers).length > 0) return hit
  }
  return null
}

/** cwd와 그 부모들의 .mcp.json — 가까운 파일이 이름 충돌에서 이긴다(엔진과 같은 규칙). */
function projectMcpJson(cwd: string): { name: string; spec: McpServerSpec; source: string }[] {
  const out: { name: string; spec: McpServerSpec; source: string }[] = []
  if (!cwd || !cwd.trim()) return out
  const seen = new Set<string>()
  for (const dir of ancestorDirs(cwd)) {
    const file = path.join(dir, '.mcp.json')
    const proj = readJson(file)
    if (!proj || !proj.mcpServers || typeof proj.mcpServers !== 'object') continue
    for (const [name, cfg] of Object.entries(proj.mcpServers as Record<string, unknown>)) {
      if (seen.has(name)) continue
      seen.add(name)
      const spec = normalizeSpec(cfg)
      if (spec) out.push({ name, spec, source: file })
    }
  }
  return out
}

/** 설치된 플러그인이 번들한 MCP 서버 — CLI 이름 규칙 plugin:<플러그인>:<서버>. */
function pluginServers(): { name: string; spec: McpServerSpec; source: string }[] {
  const out: { name: string; spec: McpServerSpec; source: string }[] = []
  const reg = readJson(path.join(PLUGINS_DIR, 'installed_plugins.json'))
  const plugins = reg?.plugins
  if (!plugins || typeof plugins !== 'object') return out
  for (const [key, entries] of Object.entries(plugins as Record<string, unknown>)) {
    const pluginName = key.split('@')[0]
    const list = Array.isArray(entries) ? entries : [entries]
    for (const e of list) {
      const installPath = (e as { installPath?: unknown })?.installPath
      if (typeof installPath !== 'string') continue
      const sources: { file: string; servers: unknown }[] = []
      const manifest = readJson(path.join(installPath, '.claude-plugin', 'plugin.json'))
      if (manifest?.mcpServers) {
        // 매니페스트의 mcpServers는 객체이거나 플러그인 상대 경로의 JSON 파일
        const m = manifest.mcpServers
        if (typeof m === 'string') {
          const f = path.join(installPath, m)
          sources.push({ file: f, servers: readJson(f)?.mcpServers ?? readJson(f) })
        } else sources.push({ file: path.join(installPath, '.claude-plugin', 'plugin.json'), servers: m })
      }
      const mcpFile = path.join(installPath, '.mcp.json')
      const mcp = readJson(mcpFile)
      if (mcp?.mcpServers) sources.push({ file: mcpFile, servers: mcp.mcpServers })
      const seen = new Set<string>()
      for (const s of sources) {
        if (!s.servers || typeof s.servers !== 'object') continue
        for (const [srv, cfg] of Object.entries(s.servers as Record<string, unknown>)) {
          const name = `plugin:${pluginName}:${srv}`
          if (seen.has(name)) continue
          seen.add(name)
          const spec = normalizeSpec(cfg)
          if (spec) out.push({ name, spec, source: s.file })
        }
      }
      break // 같은 플러그인의 여러 scope 항목은 첫 설치본만
    }
  }
  return out
}

// ── 앱 등록 서버 ──────────────────────────────────────────────
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

export function appServers(): Record<string, McpServerSpec> {
  const s = readStore().servers
  const out: Record<string, McpServerSpec> = {}
  if (s && typeof s === 'object') {
    for (const [name, cfg] of Object.entries(s)) {
      const spec = normalizeSpec(cfg)
      if (spec) out[name] = spec
    }
  }
  return out
}

/** 앱 등록 서버 추가/편집. prevName이 있으면 이름 변경(이전 항목 제거). */
export function upsertAppServer(name: string, spec: McpServerSpec, prevName?: string): void {
  const nm = name.trim()
  if (!NAME_RE.test(nm)) throw new Error(t('이름은 영문·숫자로 시작하고 영문·숫자·_ . - 만 쓸 수 있어요.', 'Name must start with a letter/digit and use only letters, digits, _ . -'))
  if (nm.startsWith('plugin:')) throw new Error(t('plugin: 접두는 플러그인 서버 전용이에요.', 'The plugin: prefix is reserved for plugin servers.'))
  const norm = normalizeSpec(spec)
  if (!norm) throw new Error(t('명령(stdio) 또는 URL(http/sse)이 필요해요.', 'A command (stdio) or URL (http/sse) is required.'))
  if (norm.type !== 'stdio') {
    try {
      const u = new URL(norm.url)
      if (!/^https?:$/.test(u.protocol)) throw new Error('scheme')
    } catch {
      throw new Error(t('URL은 http(s)://로 시작해야 해요.', 'URL must start with http(s)://'))
    }
  }
  const store = readStore()
  const servers = { ...(store.servers ?? {}) }
  if (prevName && prevName !== nm) delete servers[prevName]
  servers[nm] = norm
  store.servers = servers
  // 이름이 바뀌면 끔 상태도 따라간다
  if (prevName && prevName !== nm && store.disabled?.includes(prevName)) {
    store.disabled = [...new Set([...store.disabled.filter((d) => d !== prevName), nm])].sort()
  }
  writeStore(store)
}

export function removeAppServer(name: string): void {
  const store = readStore()
  if (store.servers) delete store.servers[name]
  if (store.disabled) store.disabled = store.disabled.filter((d) => d !== name)
  writeStore(store)
}

export function mcpPrefs(): McpPrefs {
  const s = readStore()
  return { allowProjectMcp: s.allowProjectMcp !== false } // 기본 허용 — "왜 안 붙지"가 이 기능의 존재 이유
}
export function setMcpPrefs(p: Partial<McpPrefs>): McpPrefs {
  const store = readStore()
  if (typeof p.allowProjectMcp === 'boolean') store.allowProjectMcp = p.allowProjectMcp
  writeStore(store)
  return mcpPrefs()
}

// ── 열거 ───────────────────────────────────────────────────────
function urlSpecOf(spec: McpServerSpec, values: Record<string, string>): McpUrlSpec | null {
  if (spec.type === 'stdio') return null
  const r = expandDeep(spec, values)
  return { type: r.type, url: r.url, ...(r.headers ? { headers: r.headers } : {}) }
}

function row(name: string, origin: McpOrigin, spec: McpServerSpec | null, disabled: Set<string>, applied: boolean, values: Record<string, string>, source?: string): McpServerInfo {
  const { transport, detail } = describe(spec)
  const u = spec ? urlSpecOf(spec, values) : null
  return {
    name,
    scope: origin === 'project' || origin === 'local' ? 'local' : 'global',
    origin,
    transport,
    detail,
    enabled: !disabled.has(name),
    applied,
    oauth: u && !comfyKeyHeader(spec ?? undefined) ? mcpOAuthState(name, u) : null,
    ...(spec ? { spec } : {}), // 원문(${KEY} 미치환) — 앱 행은 편집 폼, 터미널 행은 가져오기 재료
    ...(source ? { source } : {})
  }
}

/** 실행 환경에서 보이는 서버 전부: 앱 등록 → 플러그인 → 프로젝트(.mcp.json) → 터미널(미적용). */
export function listMcpServers(cwd: string): McpServerInfo[] {
  const disabled = readDisabled()
  const values = secretValues()
  const prefs = mcpPrefs()
  const out: McpServerInfo[] = []
  const appNames = new Set<string>()

  for (const [name, spec] of Object.entries(appServers())) {
    appNames.add(name)
    out.push(row(name, 'app', spec, disabled, true, values))
  }
  for (const p of pluginServers()) out.push(row(p.name, 'plugin', p.spec, disabled, true, values, p.source))
  for (const p of projectMcpJson(cwd)) {
    if (appNames.has(p.name)) continue // 앱 등록이 같은 이름을 덮는다(SDK mcpServers 우선)
    out.push(row(p.name, 'project', p.spec, disabled, prefs.allowProjectMcp, values, p.source))
  }
  // 터미널 ~/.claude.json — 앱 실행(격리 config)엔 안 실린다. 가져오기 안내용으로만 표시.
  const userCfg = readJson(USER_CONFIG)
  if (userCfg) {
    if (userCfg.mcpServers && typeof userCfg.mcpServers === 'object') {
      for (const [name, cfg] of Object.entries(userCfg.mcpServers as Record<string, unknown>)) {
        if (appNames.has(name)) continue
        out.push(row(name, 'user', normalizeSpec(cfg), disabled, false, values, USER_CONFIG))
      }
    }
    const hit = findProjectEntry(userCfg.projects, cwd)
    if (hit) {
      for (const [name, cfg] of Object.entries(hit.entry.mcpServers as Record<string, unknown>)) {
        if (appNames.has(name)) continue
        out.push(row(name, 'local', normalizeSpec(cfg), disabled, false, values, hit.dir))
      }
    }
  }

  const rank: Record<McpOrigin, number> = { app: 0, plugin: 1, project: 2, user: 3, local: 4 }
  return out.sort((a, b) => rank[a.origin] - rank[b.origin] || a.name.localeCompare(b.name))
}

/** 터미널 설정 전체(전역 + 모든 프로젝트 항목 + cwd의 .mcp.json)에서 가져올 수 있는 서버. */
export function importCandidates(cwd: string): McpImportCandidate[] {
  const have = appServers()
  const out: McpImportCandidate[] = []
  const push = (name: string, origin: McpOrigin, source: string, cfg: unknown): void => {
    const spec = normalizeSpec(cfg)
    if (!spec) return
    // 같은 이름·같은 설정이 여러 프로젝트에 중복되면 하나만
    if (out.some((c) => c.name === name && JSON.stringify(c.spec) === JSON.stringify(spec))) return
    out.push({ name, origin, source, spec, exists: !!have[name] })
  }
  const userCfg = readJson(USER_CONFIG)
  if (userCfg) {
    if (userCfg.mcpServers && typeof userCfg.mcpServers === 'object') {
      for (const [name, cfg] of Object.entries(userCfg.mcpServers as Record<string, unknown>)) push(name, 'user', USER_CONFIG, cfg)
    }
    if (userCfg.projects && typeof userCfg.projects === 'object') {
      for (const [dir, entry] of Object.entries(userCfg.projects as Record<string, Record<string, unknown>>)) {
        const m = entry?.mcpServers
        if (!m || typeof m !== 'object') continue
        for (const [name, cfg] of Object.entries(m as Record<string, unknown>)) push(name, 'local', dir, cfg)
      }
    }
  }
  for (const p of projectMcpJson(cwd)) push(p.name, 'project', p.source, p.spec)
  return out
}

export function importAppServers(items: { name: string; spec: McpServerSpec }[]): void {
  for (const it of items) upsertAppServer(it.name, it.spec)
}

/** Turn an MCP server on/off by name. Persisted to the app home folder. */
export function setMcpEnabled(name: string, enabled: boolean): void {
  const store = readStore()
  const set = readDisabled()
  if (enabled) set.delete(name)
  else set.add(name)
  store.disabled = [...set].sort()
  writeStore(store)
}

// ── 엔진 주입 ──────────────────────────────────────────────────
/**
 * The disabled servers as an SDK `deniedMcpServers` list ([{ serverName }, …]), or
 * null when nothing is disabled. Fed into a run's inline `settings` (the highest
 * priority flag layer); the denylist spans every scope, so a turned-off server is
 * blocked for that run without ever editing the user's ~/.claude.json.
 */
export function deniedMcpServers(): { serverName: string }[] | null {
  const set = readDisabled()
  if (set.size === 0) return null
  return [...set].map((serverName) => ({ serverName }))
}

/** 앱 등록 서버를 실행용으로 — 끈 것은 빼고, ${KEY}는 보관함 값으로 치환. 없으면 null. */
export function resolvedAppServers(): Record<string, McpServerSpec> | null {
  const disabled = readDisabled()
  const values = secretValues()
  const out: Record<string, McpServerSpec> = {}
  for (const [name, spec] of Object.entries(appServers())) {
    if (disabled.has(name)) continue
    out[name] = expandDeep(spec, values)
  }
  return Object.keys(out).length ? out : null
}

/** 실행 settings(플래그 계층)에 얹을 MCP 관련 항목. */
export function mcpRunSettings(): Record<string, unknown> {
  return mcpPrefs().allowProjectMcp ? { enableAllProjectMcpServers: true } : {}
}

/** Codex thread/start + thread/resume accept config overrides, independently of
 * Claude's SDK mcpServers. Keep disabled entries explicit so resume/config merging
 * cannot silently bring a previously registered server back. */
export function codexAppMcpConfig(): Record<string, unknown> {
  const disabled = readDisabled()
  const values = secretValues()
  const servers: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(appServers())) {
    const spec = expandDeep(raw, values)
    const common = { enabled: !disabled.has(name), startup_timeout_sec: 30 }
    if (spec.type === 'stdio') {
      const builtinTripo = spec.env?.CCG_TRIPO_BUILTIN === '1'
      // The bundled Tripo tool can wait for a full generation + download.
      servers[name] = { ...common, command: spec.command, args: spec.args ?? [], env: spec.env ?? {},
        ...(builtinTripo ? { tool_timeout_sec: 1800 } : {}) }
    } else if (spec.type === 'http') {
      const vaultComfy = comfyKeyHeader(raw) === COMFY_KEY_REF
      // Keep the key out of Codex thread config/history; engines inherit secretEnv.
      const headers = Object.fromEntries(Object.entries(spec.headers ?? {}).filter(([key]) => !vaultComfy || !/^(authorization|x-api-key)$/i.test(key)))
      servers[name] = { ...common, url: spec.url, http_headers: headers,
        // Codex 0.153.4 consults stored OAuth before custom X-API-Key headers.
        // An explicit bearer source bypasses that stale OAuth path. Comfy accepts
        // the same platform key via Bearer and X-API-Key (official MCP guide).
        ...(vaultComfy ? { bearer_token_env_var: COMFY_KEY, env_http_headers: { 'X-API-Key': COMFY_KEY } } : {}),
        ...(spec.url === COMFY_URL ? { tool_timeout_sec: 180 } : {}) }
    }
    // Codex does not support legacy SSE. Those remain available in Claude.
  }
  return Object.keys(servers).length ? { mcp_servers: servers } : {}
}

/**
 * 스폰 시점에 굳는 MCP·보관함 상태의 지문 — 상주 CLI 주입 게이트(optsMatch)가 이 값을
 * 비교해, 서버 등록/토글/키 변경을 옵션 불일치(새 스폰)로 다뤄 다음 메시지부터 반영한다.
 */
export function mcpSpawnFingerprint(): string {
  const payload = JSON.stringify({ s: resolvedAppServers(), d: deniedMcpServers(), p: mcpRunSettings(), e: secretEnv() })
  return createHash('sha256').update(payload).digest('hex').slice(0, 16)
}

/** OAuth 연결/해제용 — 이름으로 http/sse 스펙(치환 후)을 찾는다. 앱 → 플러그인 → 프로젝트 → 터미널. */
export function findUrlSpec(name: string, cwd: string): McpUrlSpec | null {
  const values = secretValues()
  const app = appServers()[name]
  if (app) return urlSpecOf(app, values)
  const plugin = pluginServers().find((p) => p.name === name)
  if (plugin) return urlSpecOf(plugin.spec, values)
  const proj = projectMcpJson(cwd).find((p) => p.name === name)
  if (proj) return urlSpecOf(proj.spec, values)
  const userCfg = readJson(USER_CONFIG)
  const u = normalizeSpec((userCfg?.mcpServers as Record<string, unknown> | undefined)?.[name])
  if (u) return urlSpecOf(u, values)
  const hit = userCfg ? findProjectEntry(userCfg.projects, cwd) : null
  const l = normalizeSpec((hit?.entry.mcpServers as Record<string, unknown> | undefined)?.[name])
  return l ? urlSpecOf(l, values) : null
}
