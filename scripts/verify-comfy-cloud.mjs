// Read-only live check: native Codex discovers the app-wide Comfy Cloud server
// in two project threads. No model turn or generation is submitted.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const appHome = path.join(os.homedir(), '.agentcodegui')
const runHome = process.argv[2]
const exe = process.argv[3]
if (!runHome || !exe) throw new Error('Usage: node scripts/verify-comfy-cloud.mjs <account-home> <codex.exe>')
const registry = JSON.parse(fs.readFileSync(path.join(appHome, 'mcp.json'), 'utf8'))
const spec = registry.servers?.['comfy-cloud']
if (spec?.url !== 'https://cloud.comfy.org/mcp' || registry.disabled?.includes('comfy-cloud')) {
  throw new Error('The app-wide Comfy Cloud server is missing or disabled')
}
const child = spawn(exe, ['app-server'], {
  env: { ...process.env, CODEX_HOME: runHome }, windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe']
})
let seq = 0, buffer = ''
const pending = new Map()
child.stdout.on('data', chunk => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    const p = pending.get(msg.id)
    if (p) {
      clearTimeout(p.timer); pending.delete(msg.id)
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result)
    }
  }
})
// Native logs can contain authentication details; do not echo them.
child.stderr.resume()
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout: ' + method)) }, 45000)
  pending.set(id, { resolve, reject, timer })
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
})
const results = []
try {
  await rpc('initialize', { clientInfo: { name: 'comfy-connection-check', version: '1' }, capabilities: { experimentalApi: true } })
  console.log('Native Codex initialized')
  for (const cwd of ['E:/ProjectAnalysis', root]) {
    const config = {
      mcp_servers: { 'comfy-cloud': { enabled: true, url: spec.url, http_headers: spec.headers ?? {}, startup_timeout_sec: 30 } },
      features: { apps: false, mcp_oauth_refresh_coordination: true }
    }
    const { thread } = await rpc('thread/start', { cwd, config, approvalPolicy: 'never', sandbox: 'read-only' })
    console.log('Verification thread started: ' + cwd)
    let row
    for (let n = 0; n < 80; n++) {
      const rows = (await rpc('mcpServerStatus/list', { threadId: thread.id })).data
      if (n === 0) console.log(JSON.stringify({ servers: rows?.map(s => ({ name: s.name, runtimeStatus: s.runtimeStatus, authStatus: s.authStatus, toolCount: Object.keys(s.tools ?? {}).length })) }))
      row = rows?.find(s => s.name === 'comfy-cloud' || s.name === 'local:comfy-cloud')
      if (Object.keys(row?.tools ?? {}).length || row?.runtimeStatus === 'failed' || row?.runtimeStatus === 'authenticationRequired') break
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    const result = { cwd, runtimeStatus: row?.runtimeStatus, authStatus: row?.authStatus, tools: Object.keys(row?.tools ?? {}), generatedTurns: 0 }
    results.push(result)
    console.log(JSON.stringify(result))
    if (!result.tools.length) throw new Error('Comfy Cloud tools did not load')
  }
  const dir = path.join(root, '.dev-home', 'comfy-verification')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'connection-results.json'), JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2))
} finally {
  for (const p of pending.values()) clearTimeout(p.timer)
  child.kill()
}
