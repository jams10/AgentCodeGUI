// Two native Codex processes share one expiring OAuth credential. A loopback
// server enforces single-use refresh tokens; no real account is touched.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const exe = process.argv[2]
const nativeStore = process.argv.includes('--native-store')
if (!exe) throw new Error('Pass the native codex.exe path')
const root = path.resolve(import.meta.dirname, '..')
const scratch = path.join(root, '.dev-home/credit-verification')
fs.mkdirSync(scratch, { recursive: true })
const home = fs.mkdtempSync(path.join(scratch, 'refresh-'))
let refreshCount = 0, rejectedReuse = 0, base
const validAccess = new Map()
const server = http.createServer(async (req, res) => {
  let data = ''; for await (const chunk of req) data += chunk
  const send = (status, body, extra = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...extra }); res.end(JSON.stringify(body)) }
  if (req.url.includes('oauth-protected-resource')) return send(200, { resource: base + '/mcp', authorization_servers: [base] })
  if (req.url.includes('oauth-authorization-server') || req.url.includes('openid-configuration')) {
    return send(200, { issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] })
  }
  if (req.url === '/register') return send(201, { ...JSON.parse(data), client_id: 'test-client', token_endpoint_auth_method: 'none' })
  if (req.url.startsWith('/authorize?')) {
    const query = new URL(req.url, base).searchParams, callback = new URL(query.get('redirect_uri'))
    assert(['127.0.0.1', 'localhost'].includes(callback.hostname))
    callback.searchParams.set('code', 'fixture-code'); callback.searchParams.set('state', query.get('state'))
    res.writeHead(302, { Location: callback.href }); return res.end()
  }
  if (req.url === '/token') {
    const form = new URLSearchParams(data)
    if (form.get('grant_type') === 'authorization_code') return send(200, { access_token: 'expired', refresh_token: 'refresh-0', token_type: 'Bearer', expires_in: 1 })
    if (form.get('refresh_token') !== 'refresh-' + refreshCount) { rejectedReuse++; return send(400, { error: 'invalid_grant', error_description: 'refresh token reuse detected' }) }
    refreshCount++
    const generation = refreshCount
    validAccess.set('Bearer access-' + generation, Date.now() + 35_000)
    await new Promise(resolve => setTimeout(resolve, 250))
    return send(200, { access_token: 'access-' + generation, refresh_token: 'refresh-' + generation, token_type: 'Bearer', expires_in: 35 })
  }
  if (req.url !== '/mcp') return send(404, {})
  if ((validAccess.get(req.headers.authorization) ?? 0) <= Date.now()) return send(401, {}, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` })
  if (req.method !== 'POST') return send(405, {})
  const rpc = JSON.parse(data)
  if (rpc.method === 'initialize') return send(200, { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'refresh-test', version: '1' } } })
  if (rpc.method === 'tools/list') return send(200, { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'ping', description: 'Read-only test', inputSchema: { type: 'object', properties: {} } }] } })
  if (rpc.method === 'tools/call') return send(200, { jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: 'pong' }] } })
  if (rpc.id == null) { res.writeHead(202); return res.end() }
  return send(200, { jsonrpc: '2.0', id: rpc.id, result: {} })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
base = `http://127.0.0.1:${server.address().port}`
const url = base + '/mcp'
const key = 'refresh-test|' + createHash('sha256').update(JSON.stringify({ type: 'http', url, headers: {} })).digest('hex').slice(0, 16)
if (!nativeStore) fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ [key]: {
  server_name: 'refresh-test', server_url: url, issuer: base, client_id: 'test-client',
  access_token: 'expired', refresh_token: 'refresh-0', expires_at: 1, scopes: []
} }))
const clients = []
async function connect(warm = false) {
  const child = spawn(exe, ['--enable', 'mcp_oauth_refresh_coordination', 'app-server'], { env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  clients.push(child)
  child.stderr.on('data', chunk => fs.appendFileSync(path.join(home, 'test-stderr.log'), chunk))
  let seq = 0, buffer = ''; const pending = new Map()
  child.on('exit', code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Native process exited: ' + code)) }; pending.clear() })
  child.stdout.on('data', chunk => {
    buffer += chunk; let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      let msg; try { msg = JSON.parse(line) } catch { continue }
      const p = pending.get(msg.id)
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
    }
  })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error('Native RPC timed out: ' + method + ' (' + home + ')')) }, 40000)
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  try {
    await rpc('initialize', { clientInfo: { name: 'refresh-coordination-test', version: '1' }, capabilities: { experimentalApi: true } })
    const { thread } = await rpc('thread/start', { cwd: home, config: {
      features: { apps: false, mcp_oauth_refresh_coordination: true }, mcp_oauth_credentials_store: nativeStore ? 'auto' : 'file',
      mcp_servers: warm ? {} : { 'refresh-test': { url, enabled: true, startup_timeout_sec: 25 } }
    } })
    if (warm) return 'warmed'
    let row
    for (let i = 0; i < 12; i++) {
      row = (await rpc('mcpServerStatus/list', { threadId: thread.id })).data?.find(r => r.name === 'refresh-test')
      if (row?.runtimeStatus !== 'starting') break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return { state: row?.runtimeStatus, ping: () => rpc('mcpServer/tool/call', { threadId: thread.id, server: 'refresh-test', tool: 'ping', arguments: {} }) }
  } finally { for (const p of pending.values()) clearTimeout(p.timer) }
}
try {
  // Initialize the shared SQLite schema before racing two native startups.
  await connect(true)
  const warm = clients.pop()
  await new Promise(resolve => { warm.once('exit', resolve); warm.kill() })
  if (nativeStore) {
    // Native OAuth login persists fake credentials in the real OS-backed store.
    // The authorize/callback HTTP round trip stays entirely on loopback.
    await new Promise((resolve, reject) => {
      const login = spawn(exe, ['-c', `mcp_servers.refresh-test.url="${url}"`, 'mcp', 'login', 'refresh-test'], { env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = '', errors = '', opened = false
      const timer = setTimeout(() => { login.kill(); reject(new Error('Fixture OAuth login timed out')) }, 40000)
      login.stdout.on('data', data => {
        output += data
        const link = output.split(/\s+/).find(s => s.startsWith(base + '/authorize?'))
        if (link && !opened) { opened = true; void fetch(link).catch(reject) }
      })
      login.stderr.on('data', d => { errors += d }); login.on('error', reject)
      login.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Fixture OAuth login failed: ' + errors)) })
    })
    assert(fs.existsSync(path.join(home, 'secrets/mcp_oauth.age')), 'Native encrypted credential file must exist')
  }
  const sessions = await Promise.all([connect(), connect()])
  const states = sessions.map(s => s.state)
  assert(states.every(state => state === 'connected'))
  const initialRefreshCount = refreshCount
  for (let cycle = 0; cycle < 2; cycle++) {
    await new Promise(resolve => setTimeout(resolve, 6000)) // enter native's 30-second refresh window
    const pongs = await Promise.all(sessions.map(s => s.ping()))
    assert(pongs.every(r => r.content?.[0]?.text === 'pong'))
  }
  const result = { states, initialRefreshCount, refreshCount, rejectedReuse, renewalCycles: 2, nativeEncryptedStore: nativeStore, realCredentials: false, generatedTurns: 0 }
  console.log(JSON.stringify(result))
  assert(states.every(state => state === 'connected'))
  assert.equal(refreshCount, initialRefreshCount + 2)
  assert.equal(rejectedReuse, 0)
  fs.writeFileSync(path.join(scratch, nativeStore ? 'refresh-native-store-results.json' : 'refresh-coordination-results.json'), JSON.stringify(result, null, 2))
} finally { for (const child of clients) child.kill(); server.closeAllConnections(); server.close() }
