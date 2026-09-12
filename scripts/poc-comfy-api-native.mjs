// Real pinned Codex, loopback MCP, fake key + revoked OAuth. No user auth/credits.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const exe = process.argv[2]
if (!exe) throw new Error('Pass codex.exe')
const dir = path.resolve(import.meta.dirname, '../.dev-home/comfy-api-verification')
fs.mkdirSync(dir, { recursive: true })
const home = fs.mkdtempSync(path.join(dir, 'native-'))
const fakeKey = 'comfyui-fixture-only', stats = { oauthRequests: 0, calls: 0, authenticated: 0 }
let base
const server = http.createServer(async (req, res) => {
  let data = ''; for await (const chunk of req) data += chunk
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.url !== '/mcp') { stats.oauthRequests++; return send(400, { error: 'invalid_grant', error_description: 'revoked fixture' }) }
  if (req.headers['x-api-key'] !== fakeKey) return send(401, {})
  stats.authenticated++
  if (req.method !== 'POST') return send(405, {})
  const rpc = JSON.parse(data)
  if (rpc.id == null) { res.writeHead(202); return res.end() }
  let result = {}
  if (rpc.method === 'initialize') result = { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'comfy-api-fixture', version: '1' } }
  if (rpc.method === 'tools/list') result = { tools: [{ name: 'ping', description: 'Read-only fixture', inputSchema: { type: 'object', properties: {} } }] }
  if (rpc.method === 'tools/call') { stats.calls++; result = { content: [{ type: 'text', text: 'pong' }] } }
  return send(200, { jsonrpc: '2.0', id: rpc.id, result })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
base = `http://127.0.0.1:${server.address().port}`
const url = base + '/mcp'
const credentialKey = 'comfy-cloud|' + createHash('sha256').update(JSON.stringify({ type: 'http', url, headers: {} })).digest('hex').slice(0, 16)
fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ [credentialKey]: { server_name: 'comfy-cloud', server_url: url, issuer: base, client_id: 'fixture', access_token: 'expired', refresh_token: 'revoked', expires_at: 1, scopes: [] } }))
async function connect() {
  const started = Date.now()
  const child = spawn(exe, ['app-server'], { env: { ...process.env, CODEX_HOME: home, COMFY_API_KEY: fakeKey }, windowsHide: true, stdio: ['pipe','pipe','pipe'] })
  child.stderr.resume() // Native diagnostics never enter result files.
  let seq = 0, buffer = ''; const pending = new Map()
  child.stdout.on('data', chunk => {
    buffer += chunk; let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      let msg; try { msg = JSON.parse(line) } catch { continue }
      const p = pending.get(msg.id)
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.error ? p.reject(new Error('Native RPC failed')) : p.resolve(msg.result) }
    }
  })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error('Native RPC timeout: ' + method)) }, 30000)
    pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({id,method,params}) + '\n')
  })
  try {
    await rpc('initialize', { clientInfo: { name: 'comfy-key-test', version: '1' }, capabilities: { experimentalApi: true } })
    const { thread } = await rpc('thread/start', { cwd: home, approvalPolicy: 'never', sandbox: 'read-only', config: {
      features: { apps: false, mcp_oauth_refresh_coordination: true }, mcp_oauth_credentials_store: 'file',
      mcp_servers: { 'comfy-cloud': { url, bearer_token_env_var: 'COMFY_API_KEY', env_http_headers: { 'X-API-Key': 'COMFY_API_KEY' }, enabled: true, startup_timeout_sec: 15 } }
    } })
    let row
    for (let n = 0; n < 30; n++) {
      row = (await rpc('mcpServerStatus/list', { threadId: thread.id })).data?.find(s => s.name === 'comfy-cloud')
      if (row?.runtimeStatus && row.runtimeStatus !== 'starting') break
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert.equal(row?.runtimeStatus, 'connected')
    const pong = await rpc('mcpServer/tool/call', { threadId: thread.id, server: 'comfy-cloud', tool: 'ping', arguments: {} })
    assert.equal(pong.content[0].text, 'pong')
    return { state: row.runtimeStatus, elapsedMs: Date.now() - started }
  } finally {
    for (const p of pending.values()) clearTimeout(p.timer)
    await new Promise(resolve => { child.once('exit', resolve); child.kill() })
  }
}
try {
  const runs = [await connect(), await connect()]
  assert.equal(stats.oauthRequests, 0); assert.equal(stats.calls, 2)
  const result = { runs, ...stats, realCredentials: false, generatedAssets: 0 }
  fs.writeFileSync(path.join(dir, 'native-results.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally { server.closeAllConnections(); server.close() }
