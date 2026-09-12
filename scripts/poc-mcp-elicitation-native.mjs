// Real pinned Codex + loopback MCP elicitation. No account, API key, or paid tools.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { transform } from 'esbuild'

const exe = process.argv[2]
if (!exe) throw new Error('Pass codex.exe')
const dir = path.resolve(import.meta.dirname, '../.dev-home/mcp-elicitation-verification')
fs.mkdirSync(dir, { recursive: true })
const results = []
const policyCode = await transform(fs.readFileSync(path.resolve(import.meta.dirname, '../src/main/codex/policy.ts'), 'utf8'), { loader: 'ts', format: 'esm' })
const { codexPolicy } = await import('data:text/javascript;base64,' + Buffer.from(policyCode.code).toString('base64'))
async function test(policy, handler) {
  const home = fs.mkdtempSync(path.join(dir, 'native-'))
  const stats = { policy, handler, clientRequests: [], mcpReplies: [], capabilities: null }
  let waiting, elicitationId = 0
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return }
    let body = ''; for await (const b of req) body += b
    const msg = JSON.parse(body)
    const send = result => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })) }
    if (!msg.method && msg.id != null) {
      stats.mcpReplies.push(msg.result ?? { error: msg.error })
      res.writeHead(202); res.end()
      if (waiting) {
        waiting.res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: waiting.id, result: { content: [{ type: 'text', text: JSON.stringify(msg.result ?? msg.error) }] } })}\n\n`)
        waiting = null
      }
      return
    }
    if (msg.id == null) { res.writeHead(202); res.end(); return }
    if (msg.method === 'initialize') {
      stats.capabilities = msg.params.capabilities
      return send({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'elicitation-fixture', version: '1' } })
    }
    if (msg.method === 'tools/list') return send({ tools: [{ name: 'ask', description: 'Zero cost approval fixture', inputSchema: { type: 'object', properties: {} } }] })
    if (msg.method === 'tools/call') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
      waiting = { res, id: msg.id }
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'fixture-' + ++elicitationId, method: 'elicitation/create', params: { mode: 'form', message: 'Zero cost fixture: explicitly allow this simulated batch?', requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Confirm simulated batch' } }, required: ['confirm'] } } })}\n\n`)
      return
    }
    send({})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const child = spawn(exe, ['app-server'], { env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  let seq = 0, buffer = ''
  const pending = new Map()
  const write = message => child.stdin.write(JSON.stringify(message) + '\n')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      let msg; try { msg = JSON.parse(line) } catch { continue }
      if (msg.id != null && msg.method) {
        stats.clientRequests.push({ method: msg.method, params: msg.params })
        if (handler === 'unsupported') write({ id: msg.id, error: { code: -32000, message: `unsupported client request: ${msg.method}` } })
        else write({ id: msg.id, result: { action: handler, content: handler === 'accept' ? { confirm: true } : null } })
        continue
      }
      const p = pending.get(msg.id)
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
    }
  })
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error('RPC timeout: ' + method)) }, 20000)
    pending.set(id, { resolve, reject, timer }); write({ id, method, params })
  })
  try {
    await rpc('initialize', { clientInfo: { name: 'elicitation-fixture', version: '1' }, capabilities: { experimentalApi: true } })
    const { thread } = await rpc('thread/start', { cwd: home, approvalPolicy: policy, sandbox: 'read-only', config: { features: { apps: false }, mcp_servers: { fixture: { url: `http://127.0.0.1:${server.address().port}/mcp`, enabled: true } } } })
    for (let n = 0; n < 30; n++) {
      const row = (await rpc('mcpServerStatus/list', { threadId: thread.id })).data?.find(s => s.name === 'fixture')
      if (row?.runtimeStatus === 'connected') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    stats.result = await rpc('mcpServer/tool/call', { threadId: thread.id, server: 'fixture', tool: 'ask', arguments: {} })
  } catch (error) { stats.error = error.message }
  finally {
    for (const p of pending.values()) clearTimeout(p.timer)
    await new Promise(resolve => { child.once('exit', resolve); child.kill() })
    server.closeAllConnections(); server.close()
  }
  return stats
}
for (const [policy, handler] of [['never', 'unsupported'], ['never', 'accept'], ['on-request', 'unsupported'], ['on-request', 'accept'], ['on-request', 'decline'], [codexPolicy('auto').approvalPolicy, 'accept'], [codexPolicy('bypass').approvalPolicy, 'cancel']]) {
  const result = await test(policy, handler)
  results.push(result)
  fs.writeFileSync(path.join(dir, 'native-results.json'), JSON.stringify({ generatedAssets: 0, results }, null, 2))
  console.log(JSON.stringify({ policy, handler, requests: result.clientRequests.map(x => x.method), replies: result.mcpReplies, error: result.error }))
}
assert.equal(results.filter(r => r.error).length, 0)
assert.equal(results[0].clientRequests.length, 0)
assert.deepEqual(results[2].mcpReplies, [{ action: 'decline' }])
assert.deepEqual(results[5].mcpReplies, [{ action: 'accept', content: { confirm: true } }])
assert.deepEqual(results[6].mcpReplies, [{ action: 'cancel' }])
