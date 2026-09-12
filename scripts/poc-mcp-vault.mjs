/**
 * PoC — MCP 앱 레지스트리 · Keys 보관함 · MCP OAuth(앱 안 로그인 + 계정 공유) 검증.
 *
 * 사고: 앱은 계정별 격리 config(CLAUDE_CONFIG_DIR)로 실행돼 터미널 ~/.claude.json의 MCP
 * 서버도, /mcp 로 받은 OAuth 토큰(전역 .credentials.json → mcpOAuth)도 보지 못했다.
 * 헤드리스(-p) 실행은 OAuth를 못 열어 매번 "대화형 세션에서 인증하라"만 떴다.
 * 수정: 앱 홈 mcp.json 레지스트리(SDK mcpServers 주입) + secrets.json 보관함(${KEY} 치환·
 * env 주입) + mcp-oauth.json 토큰 보관소(계정 폴더에 물질화/되거둠) + 앱 안 OAuth 흐름.
 *
 * 검증(실 모듈을 esbuild로 묶고 electron·homedir만 스텁):
 *  A. Keys — 저장/끝4자리/env/예약 이름 잠금/${NAME}·${NAME:-기본} 치환/이름 규칙
 *  B. MCP 레지스트리 — 등록 원문 보존·실행용 치환·끄기(denied)·지문·열거(앱/플러그인/터미널 미적용)·
 *     가져오기 후보·프로젝트 허용 설정·이름 검증
 *  C. OAuth 보관소 — CLI 키 해시(실물 1e1ead924ea609a1)·터미널 토큰 가져오기·계정 폴더 물질화·
 *     신선도 병합(되거둠/강등 금지)·연결 해제·1회 가져오기 마커
 *  D. OAuth 흐름 — 가짜 인가 서버(401 resource_metadata → 메타데이터 → 동적 등록 → PKCE →
 *     콜백 → 교환)로 끝까지, 취소 경로
 *  E. (네트워크) Comfy Cloud 실서버 디스커버리 — 인가 서버·엔드포인트 발견
 *
 * 실행: node scripts/poc-mcp-vault.mjs
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail == null ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!cond) failed++
}

// ── 샌드박스 홈 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-mcp-'))
const HOME = path.join(TMP, 'home')
const APP = path.join(TMP, 'app')
const ACCT = path.join(HOME, '.agentcodegui', 'accounts', 'acct-1')
const PLUG = path.join(TMP, 'plug')
for (const d of [path.join(HOME, '.claude'), ACCT, path.join(HOME, '.agentcodegui', 'shared', 'plugins'), path.join(PLUG, '.claude-plugin'), APP]) fs.mkdirSync(d, { recursive: true })
const wjson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2))
const rjson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const NOW = Date.now()
const COMFY_KEY = 'comfy-cloud|1e1ead924ea609a1'
wjson(path.join(HOME, '.claude', '.credentials.json'), {
  claudeAiOauth: { accessToken: 'global-at', expiresAt: NOW + 3600e3 },
  mcpOAuth: { [COMFY_KEY]: { serverName: 'comfy-cloud', serverUrl: 'https://cloud.comfy.org/mcp', accessToken: 'AT1', refreshToken: 'RT1', expiresAt: NOW + 3600e3, clientId: 'c1' } }
})
wjson(path.join(ACCT, '.credentials.json'), { claudeAiOauth: { accessToken: 'acct-at', refreshToken: 'acct-rt', expiresAt: NOW + 3600e3 } })
wjson(path.join(HOME, '.claude.json'), {
  mcpServers: { ctx7: { type: 'http', url: 'https://mcp.context7.com/mcp' } },
  projects: { 'E:/Godot/proj': { mcpServers: { blender: { command: 'uvx', args: ['blender-mcp'] } } } }
})
wjson(path.join(HOME, '.agentcodegui', 'shared', 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'comfy-cloud@comfy-skills': [{ scope: 'user', installPath: PLUG }] } })
wjson(path.join(PLUG, '.claude-plugin', 'plugin.json'), { name: 'comfy-cloud', mcpServers: { 'comfy-cloud': { type: 'http', url: 'https://cloud.comfy.org/mcp' } } })

// ── 번들 (electron·homedir·APP_HOME·lang 스텁, 나머지는 실 모듈) ──
const opened = [] // shell.openExternal 호출 기록 — D절 드라이버가 브라우저 역할
globalThis.__pocOpen = async (url) => {
  opened.push(url)
  if (globalThis.__pocBrowser) await globalThis.__pocBrowser(url)
}
const stubs = {
  electron: `
    const rev = (s) => s.split('').reverse().join('')
    export const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + rev(s), 'utf8'),
      decryptString: (b) => { const s = b.toString('utf8'); if (!s.startsWith('enc:')) throw new Error('bad'); return rev(s.slice(4)) }
    }
    export const shell = { openExternal: (u) => globalThis.__pocOpen(u) }`,
  './engine/versions': `export const APP_HOME = ${JSON.stringify(APP)}`,
  './lang': `export const t = (ko) => ko; export const isEn = () => false`,
  os: `import * as real from 'node:os'
    const o = { ...real, homedir: () => ${JSON.stringify(HOME)} }
    export default o
    export const homedir = o.homedir
    export const tmpdir = real.tmpdir
    export const platform = real.platform`
}
const stubPlugin = {
  name: 'poc-stubs',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'poc-stub' }))
    build.onResolve({ filter: /^\.\/(engine\/versions|lang)$/ }, (args) => ({ path: args.path, namespace: 'poc-stub' }))
    build.onResolve({ filter: /^(node:)?os$/ }, (args) => (args.namespace === 'poc-stub' ? undefined : { path: 'os', namespace: 'poc-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'poc-stub' }, (args) => ({ contents: stubs[args.path], loader: 'js', resolveDir: path.join(root, 'src/main') }))
  }
}
const entry = path.join(root, '.poc-mcp-entry.ts')
const bundle = path.join(root, '.poc-mcp-vault.mjs')
fs.writeFileSync(
  entry,
  `export * as secrets from './src/main/secrets'
export * as mcp from './src/main/mcp'
export * as oauth from './src/main/mcpOAuth'`
)
await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: bundle, alias: { '@shared': path.join(root, 'src/shared') }, plugins: [stubPlugin], logLevel: 'silent' })
const { secrets, mcp, oauth } = await import(pathToFileURL(bundle).href)
fs.rmSync(bundle, { force: true })
fs.rmSync(entry, { force: true })

// ══════════════ A. Keys 보관함 ══════════════
console.log('\n── A. Keys ──')
let list = secrets.setSecret('MY_KEY', 'abcd1234', { note: 'poc' })
check('A1 저장 → 끝 4자리·env 기본 켬·메모', list.length === 1 && list[0].tail === '1234' && list[0].env === true && list[0].note === 'poc', list)
check('A1b 파일엔 원문이 없다(암호화)', !fs.readFileSync(path.join(APP, 'secrets.json'), 'utf8').includes('abcd1234'))
list = secrets.setSecret('ANTHROPIC_API_KEY', 'sk-ant-9999')
const anth = list.find((s) => s.name === 'ANTHROPIC_API_KEY')
check('A2 예약 이름 → envLocked, env false', anth && anth.envLocked && !anth.env, anth)
const env = secrets.secretEnv()
check('A2b secretEnv는 예약 이름 제외', env.MY_KEY === 'abcd1234' && !('ANTHROPIC_API_KEY' in env), env)
check('A2c secretValues엔 둘 다(${} 참조용)', secrets.secretValues().ANTHROPIC_API_KEY === 'sk-ant-9999')
check('A3 ${NAME} 치환', secrets.expandSecretRefs('Bearer ${MY_KEY}') === 'Bearer abcd1234')
check('A3b ${NAME:-기본} 미등록 → 기본값', secrets.expandSecretRefs('x=${NOPE:-dflt}') === 'x=dflt')
check('A3c 미등록·기본 없음 → 원문 유지', secrets.expandSecretRefs('${NOPE}') === '${NOPE}')
process.env.POC_ENV_ONLY = 'from-env'
check('A3d 보관함에 없으면 process.env 폴백', secrets.expandSecretRefs('${POC_ENV_ONLY}') === 'from-env')
check('A3e expandDeep — 중첩 객체/배열', JSON.stringify(secrets.expandDeep({ a: ['${MY_KEY}'], b: { c: '${MY_KEY}' } })) === '{"a":["abcd1234"],"b":{"c":"abcd1234"}}')
let threw = null
try {
  secrets.setSecret('1bad-name', 'v')
} catch (e) {
  threw = e.message
}
check('A4 이름 규칙 위반 → throw', !!threw, threw)
list = secrets.setSecretEnv('MY_KEY', false)
check('A5 env 토글 끔 → secretEnv 비움', list.find((s) => s.name === 'MY_KEY').env === false && !('MY_KEY' in secrets.secretEnv()))
secrets.setSecretEnv('MY_KEY', true)
list = secrets.setSecret('MY_KEY', 'zzzz5678')
check('A5b 값 변경 — env/메모 유지, 끝자리 갱신', list.find((s) => s.name === 'MY_KEY').tail === '5678' && list.find((s) => s.name === 'MY_KEY').note === 'poc')
list = secrets.removeSecret('ANTHROPIC_API_KEY')
check('A6 삭제', list.length === 1 && list[0].name === 'MY_KEY')

// ══════════════ B. MCP 레지스트리 ══════════════
console.log('\n── B. MCP registry ──')
mcp.upsertAppServer('comfy', { type: 'http', url: 'https://cloud.comfy.org/mcp', headers: { Authorization: 'Bearer ${MY_KEY}' } })
mcp.upsertAppServer('blender', { type: 'stdio', command: 'uvx', args: ['blender-mcp'], env: { KEY: '${MY_KEY}' } })
const raw = mcp.appServers()
check('B1 등록 원문은 ${MY_KEY} 그대로', raw.comfy.headers.Authorization === 'Bearer ${MY_KEY}' && raw.blender.env.KEY === '${MY_KEY}', raw)
const resolved = mcp.resolvedAppServers()
check('B2 실행용은 치환됨', resolved.comfy.headers.Authorization === 'Bearer zzzz5678' && resolved.blender.env.KEY === 'zzzz5678', resolved)
const fp1 = mcp.mcpSpawnFingerprint()
mcp.setMcpEnabled('blender', false)
check('B3 끄기 → 실행용에서 빠지고 denied 목록에', !mcp.resolvedAppServers().blender && JSON.stringify(mcp.deniedMcpServers()) === '[{"serverName":"blender"}]')
check('B4 지문이 바뀐다(주입 게이트 → 새 스폰)', mcp.mcpSpawnFingerprint() !== fp1)
mcp.setMcpEnabled('blender', true)
check('B4b 되켜면 지문 복귀', mcp.mcpSpawnFingerprint() === fp1)
secrets.setSecret('MY_KEY', 'abcd1234')
check('B4c 키 값 변경도 지문 변경', mcp.mcpSpawnFingerprint() !== fp1)

const rows = mcp.listMcpServers('E:/Godot/proj/sub')
const byName = Object.fromEntries(rows.map((r) => [r.name, r]))
check('B5 앱 행 — applied, spec 원문, oauth 상태(미연결)', byName.comfy?.origin === 'app' && byName.comfy.applied && byName.comfy.spec.headers.Authorization === 'Bearer ${MY_KEY}' && byName.comfy.oauth?.connected === false, byName.comfy)
check('B5b stdio 행은 oauth null', byName.blender?.oauth === null)
check('B5c 플러그인 행 plugin:comfy-cloud:comfy-cloud, applied', byName['plugin:comfy-cloud:comfy-cloud']?.origin === 'plugin' && byName['plugin:comfy-cloud:comfy-cloud'].applied, rows.map((r) => r.name))
check('B5d 터미널 전역 ctx7 — applied false, spec 동봉', byName.ctx7?.origin === 'user' && byName.ctx7.applied === false && byName.ctx7.spec?.url === 'https://mcp.context7.com/mcp')
check('B5e 터미널 프로젝트 blender는 앱 등록이 같은 이름이라 숨김', rows.filter((r) => r.name === 'blender').length === 1)
check('B5f 정렬: app → plugin → … ', rows[0].origin === 'app' && rows.findIndex((r) => r.origin === 'plugin') > rows.findLastIndex((r) => r.origin === 'app'))
const cands = mcp.importCandidates('')
check('B6 가져오기 후보 — 전역 ctx7 + 모든 프로젝트의 blender(exists 표시)', cands.some((c) => c.name === 'ctx7' && c.origin === 'user' && !c.exists) && cands.some((c) => c.name === 'blender' && c.origin === 'local' && c.exists), cands)
mcp.importAppServers([cands.find((c) => c.name === 'ctx7')])
check('B7 가져오기 → 앱 등록', !!mcp.appServers().ctx7)
threw = null
try {
  mcp.upsertAppServer('bad name!', { type: 'http', url: 'https://x' })
} catch (e) {
  threw = e.message
}
check('B8 이름 검증', !!threw, threw)
threw = null
try {
  mcp.upsertAppServer('plugin:x:y', { type: 'http', url: 'https://x' })
} catch (e) {
  threw = e.message
}
check('B8b plugin: 접두 금지', !!threw)
threw = null
try {
  mcp.upsertAppServer('nourl', { type: 'http', url: 'ftp://x' })
} catch (e) {
  threw = e.message
}
check('B8c URL 스킴 검증', !!threw)
mcp.upsertAppServer('comfy2', { type: 'http', url: 'https://cloud.comfy.org/mcp' }, 'comfy')
check('B8d 이름 변경 — 이전 항목 제거', !mcp.appServers().comfy && !!mcp.appServers().comfy2)
mcp.removeAppServer('comfy2')
check('B8e 삭제', !mcp.appServers().comfy2)
check('B9 프로젝트 .mcp.json 허용 기본 true → 설정 주입', mcp.mcpPrefs().allowProjectMcp === true && mcp.mcpRunSettings().enableAllProjectMcpServers === true)
mcp.setMcpPrefs({ allowProjectMcp: false })
check('B9b 끄면 설정 없음', JSON.stringify(mcp.mcpRunSettings()) === '{}')
mcp.setMcpPrefs({ allowProjectMcp: true })
const plugSpec = mcp.findUrlSpec('plugin:comfy-cloud:comfy-cloud', '')
check('B10 findUrlSpec — 플러그인 이름으로 url 스펙', plugSpec?.type === 'http' && plugSpec.url === 'https://cloud.comfy.org/mcp', plugSpec)
check('B10b findUrlSpec — stdio는 null', mcp.findUrlSpec('blender', '') === null)

// ══════════════ C. OAuth 보관소 ══════════════
console.log('\n── C. OAuth store ──')
check('C1 CLI 키 해시 일치(터미널 실물 레코드)', oauth.mcpOAuthKey('comfy-cloud', { type: 'http', url: 'https://cloud.comfy.org/mcp' }) === COMFY_KEY)
check('C1b headers 없음 = {} 로 해시', oauth.mcpOAuthKey('comfy-cloud', { type: 'http', url: 'https://cloud.comfy.org/mcp', headers: {} }) === COMFY_KEY)
const n = oauth.importGlobalMcpOAuth()
const st = oauth.mcpOAuthState('comfy-cloud', { type: 'http', url: 'https://cloud.comfy.org/mcp' })
check('C2 터미널 토큰 가져오기 → 연결됨·만료·리프레시', n === 1 && st.connected && st.expiresAt === NOW + 3600e3 && st.hasRefresh, { n, st })
check('C2b 보관소 파일엔 토큰 원문 없음(암호화)', !fs.readFileSync(path.join(APP, 'mcp-oauth.json'), 'utf8').includes('AT1'))
let acct = rjson(path.join(ACCT, '.credentials.json'))
check('C3 계정 폴더에 물질화 — mcpOAuth 얹고 claudeAiOauth 보존', acct.mcpOAuth?.[COMFY_KEY]?.accessToken === 'AT1' && acct.claudeAiOauth.accessToken === 'acct-at', acct)
check('C3b 플러그인 행 oauth — 같은 서버라도 키가 달라 미연결(플러그인 이름으로 따로 로그인)', mcp.listMcpServers('').find((r) => r.name === 'plugin:comfy-cloud:comfy-cloud').oauth.connected === false)
// CLI의 "인증 필요" 캐시(4h/15m TTL 동안 접속 자체를 건너뜀) — 토큰이 있는 서버의 표식만 걷는다
const cachePath = path.join(ACCT, 'mcp-needs-auth-cache.json')
wjson(cachePath, { 'comfy-cloud': { timestamp: NOW }, other: { timestamp: NOW } })
oauth.materializeMcpOAuth(path.join(ACCT, '.credentials.json'))
check('C3c 물질화가 needs-auth 캐시에서 토큰 있는 서버 표식만 제거', JSON.stringify(rjson(cachePath)) === JSON.stringify({ other: { timestamp: NOW } }), rjson(cachePath))
oauth.clearNeedsAuthCache(ACCT, ['other'])
check('C3d clearNeedsAuthCache 직접 호출', JSON.stringify(rjson(cachePath)) === '{}')
oauth.clearNeedsAuthCache(path.join(TMP, 'nope'), ['x']) // 파일 없음 — 조용히
check('C3e 캐시 파일 없어도 무해', true)
// CLI가 실행 중 리프레시한 시나리오 — 폴더 쪽이 더 신선
acct.mcpOAuth[COMFY_KEY] = { ...acct.mcpOAuth[COMFY_KEY], accessToken: 'AT2', expiresAt: NOW + 7200e3 }
wjson(path.join(ACCT, '.credentials.json'), acct)
oauth.harvestMcpOAuth(path.join(ACCT, '.credentials.json'))
check('C4 되거둠 — 보관소가 폴더의 신선한 토큰으로', oauth.mcpOAuthState('comfy-cloud', { type: 'http', url: 'https://cloud.comfy.org/mcp' }).expiresAt === NOW + 7200e3)
// 스냅샷 덮어쓰기로 폴더가 낡은 토큰으로 돌아간 시나리오 — 물질화가 강등하지 않고 신선한 쪽을 되돌린다
acct.mcpOAuth[COMFY_KEY] = { ...acct.mcpOAuth[COMFY_KEY], accessToken: 'AT0', expiresAt: NOW + 10e3 }
wjson(path.join(ACCT, '.credentials.json'), acct)
oauth.materializeMcpOAuth(path.join(ACCT, '.credentials.json'))
acct = rjson(path.join(ACCT, '.credentials.json'))
check('C5 물질화 — 낡은 폴더 토큰을 보관소의 신선한 것으로', acct.mcpOAuth[COMFY_KEY].accessToken === 'AT2')
// 폴더의 껍데기(토큰 없음)는 보관소를 못 덮는다
acct.mcpOAuth[COMFY_KEY] = { serverName: 'comfy-cloud', serverUrl: 'https://cloud.comfy.org/mcp', accessToken: '', expiresAt: NOW + 99999e3 }
wjson(path.join(ACCT, '.credentials.json'), acct)
oauth.harvestMcpOAuth(path.join(ACCT, '.credentials.json'))
check('C5b 껍데기 레코드는 되거둠에서 무시', oauth.mcpOAuthState('comfy-cloud', { type: 'http', url: 'https://cloud.comfy.org/mcp' }).connected === true)
oauth.disconnectMcpOAuth('comfy-cloud', { type: 'http', url: 'https://cloud.comfy.org/mcp' })
acct = rjson(path.join(ACCT, '.credentials.json'))
check('C6 연결 해제 — 보관소·계정 폴더 모두 제거, 전역은 불가침', !oauth.mcpOAuthState('comfy-cloud', { type: 'http', url: 'https://cloud.comfy.org/mcp' }).connected && !acct.mcpOAuth[COMFY_KEY] && !!rjson(path.join(HOME, '.claude', '.credentials.json')).mcpOAuth[COMFY_KEY])
oauth.importGlobalMcpOAuthOnce()
check('C7 1회 가져오기 — 마커 생성 + 가져옴', fs.existsSync(path.join(APP, '.mcp-oauth-imported')) && oauth.mcpOAuthState('comfy-cloud', { type: 'http', url: 'https://cloud.comfy.org/mcp' }).connected)
oauth.disconnectMcpOAuth('comfy-cloud', { type: 'http', url: 'https://cloud.comfy.org/mcp' })
oauth.importGlobalMcpOAuthOnce()
check('C7b 마커 있으면 다시 안 가져온다', !oauth.mcpOAuthState('comfy-cloud', { type: 'http', url: 'https://cloud.comfy.org/mcp' }).connected)

// ══════════════ D. OAuth 흐름 — 가짜 인가 서버 ══════════════
console.log('\n── D. OAuth flow (fake AS) ──')
const seen = { register: null, authorize: null, token: null }
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1')
  const base = `http://127.0.0.1:${fake.address().port}`
  const json = (code, v, hdr = {}) => {
    res.writeHead(code, { 'content-type': 'application/json', ...hdr })
    res.end(JSON.stringify(v))
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (u.pathname === '/mcp') return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
    if (u.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ['tools:read', 'tools:call'] })
    if (u.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, code_challenge_methods_supported: ['S256'] })
    if (u.pathname === '/register') {
      seen.register = JSON.parse(body)
      return json(201, { client_id: 'cid-poc', redirect_uris: seen.register.redirect_uris })
    }
    if (u.pathname === '/authorize') {
      seen.authorize = Object.fromEntries(u.searchParams)
      const ru = new URL(seen.authorize.redirect_uri)
      ru.searchParams.set('code', 'CODE-1')
      ru.searchParams.set('state', seen.authorize.state)
      res.writeHead(302, { location: ru.toString() })
      return res.end()
    }
    if (u.pathname === '/token') {
      seen.token = Object.fromEntries(new URLSearchParams(body))
      const chal = createHash('sha256').update(seen.token.code_verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      if (seen.token.code !== 'CODE-1' || chal !== seen.authorize.code_challenge || seen.token.client_id !== 'cid-poc') return json(400, { error: 'invalid_grant', error_description: 'pkce/code mismatch' })
      return json(200, { access_token: 'AT-new', refresh_token: 'RT-new', expires_in: 3600, scope: 'tools:read tools:call', token_type: 'Bearer' })
    }
    json(404, { error: 'nf' })
  })
})
await new Promise((r) => fake.listen(0, '127.0.0.1', r))
const fakeBase = `http://127.0.0.1:${fake.address().port}`
const fakeSpec = { type: 'http', url: `${fakeBase}/mcp` }
const events = []
const wc = { isDestroyed: () => false, send: (_ch, ev) => events.push(ev) }
// '브라우저' — 인가 URL을 열면 302를 따라 앱의 콜백까지 간다
globalThis.__pocBrowser = async (url) => {
  const r = await fetch(url, { redirect: 'follow' })
  globalThis.__pocCallbackStatus = r.status
}
const res = await oauth.connectMcpOAuth('fake', fakeSpec, wc)
check('D1 흐름 완료 ok', res.ok === true, res)
check('D1b 콜백 페이지 200', globalThis.__pocCallbackStatus === 200)
check('D2 동적 등록 — redirect_uri localhost, public client', seen.register?.redirect_uris?.[0]?.startsWith('http://localhost:') && seen.register.token_endpoint_auth_method === 'none' && seen.register.client_name === 'AgentCodeGUI', seen.register)
check('D3 인가 요청 — S256·state·scope·resource', seen.authorize?.code_challenge_method === 'S256' && !!seen.authorize.state && seen.authorize.scope === 'tools:read tools:call' && seen.authorize.resource === fakeSpec.url && seen.authorize.client_id === 'cid-poc', seen.authorize)
check('D4 토큰 교환 — code_verifier·redirect_uri·resource', seen.token?.grant_type === 'authorization_code' && seen.token.redirect_uri === seen.authorize.redirect_uri && seen.token.resource === fakeSpec.url, seen.token)
const fst = oauth.mcpOAuthState('fake', fakeSpec)
check('D5 저장 — 연결됨·만료≈1h·리프레시', fst.connected && fst.hasRefresh && Math.abs(fst.expiresAt - Date.now() - 3600e3) < 5000, fst)
acct = rjson(path.join(ACCT, '.credentials.json'))
const fkey = oauth.mcpOAuthKey('fake', fakeSpec)
check('D5b 계정 폴더에 즉시 물질화 — CLI 포맷 필드', acct.mcpOAuth?.[fkey]?.accessToken === 'AT-new' && acct.mcpOAuth[fkey].clientId === 'cid-poc' && acct.mcpOAuth[fkey].redirectUri === seen.authorize.redirect_uri && acct.mcpOAuth[fkey].serverName === 'fake' && acct.mcpOAuth[fkey].discoveryState?.authorizationServerUrl === fakeBase && acct.mcpOAuth[fkey].discoveryState.oauthMetadataFound === true, acct.mcpOAuth?.[fkey])
check('D6 이벤트 — url → done', events.map((e) => e.phase).join(',') === 'url,done' && events[0].url.startsWith(`${fakeBase}/authorize?`), events)
// 취소 경로 — 브라우저가 아무것도 안 하고, 앱이 취소
globalThis.__pocBrowser = async () => {}
events.length = 0
const pending = oauth.connectMcpOAuth('fake2', fakeSpec, wc)
await new Promise((r) => setTimeout(r, 300))
oauth.cancelMcpOAuth()
const cres = await pending
check('D7 취소 → ok false/cancelled + 이벤트', cres.ok === false && cres.error === 'cancelled' && events.map((e) => e.phase).join(',') === 'url,cancelled', { cres, events })
fake.close()

// ══════════════ E. 네트워크 — Comfy Cloud 실서버 디스커버리 ══════════════
console.log('\n── E. Comfy Cloud discovery (network) ──')
try {
  const d = await oauth.discoverMcpOAuth({ type: 'http', url: 'https://cloud.comfy.org/mcp' })
  check('E1 인가 서버 발견 + 메타데이터 + 동적 등록 엔드포인트', d.metaFound && !!d.meta.registration_endpoint && d.authServer.startsWith('https://cloud.comfy.org'), d)
} catch (e) {
  check('E1 (네트워크 불가 — 건너뜀)', true, String(e))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'}`)
process.exit(failed ? 1 : 0)
