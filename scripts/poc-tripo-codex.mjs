// Real Codex app-server integration; starts/resumes empty threads, never a turn.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const scratch = path.join(root, '.dev-home', 'tripo-verification')
fs.mkdirSync(scratch, { recursive: true })
const runHome = fs.mkdtempSync(path.join(scratch, 'codex-'))
const exe = process.argv[2]
if (!exe) throw new Error('Usage: node scripts/poc-tripo-codex.mjs <codex.exe>')
const env = { ...process.env, CODEX_HOME: runHome }
delete env.OPENAI_API_KEY; delete env.TRIPO_API_KEY
const child = spawn(exe, ['app-server'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
let seq = 0, buffer = ''; const pending = new Map()
child.stdout.on('data', chunk => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
    const msg = JSON.parse(line)
    const wait = pending.get(msg.id)
    if (wait) { clearTimeout(wait.timer); pending.delete(msg.id); msg.error ? wait.reject(new Error(JSON.stringify(msg.error))) : wait.resolve(msg.result) }
  }
})
child.stderr.resume()
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timeout: ' + method)) }, 45000)
  pending.set(id, { resolve, reject, timer })
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
})
const spec = { command: path.join(root, 'node_modules/electron/dist/electron.exe'), args: [path.join(root, 'out/main/tripoMcpBridge.js'), path.join(root, 'node_modules/tripo-cli/dist/cli.js')],
  env: { ELECTRON_RUN_AS_NODE: '1', TRIPO_API_KEY: '', TRIPO_HOME: path.join(runHome, 'tripo') }, startup_timeout_sec: 30, tool_timeout_sec: 1800, enabled: true }
const config = { mcp_servers: { tripo: spec }, features: { apps: false } }
try {
  await rpc('initialize', { clientInfo: { name: 'tripo-test', version: '1' }, capabilities: { experimentalApi: true } })
  const { thread } = await rpc('thread/start', { cwd: root, config, approvalPolicy: 'never', sandbox: 'read-only' })
  let rows
  for (let n = 0; n < 20; n++) {
    rows = (await rpc('mcpServerStatus/list', { threadId: thread.id })).data
    if (Object.keys(rows?.find(s => s.name === 'tripo')?.tools ?? {}).length === 5) break
    await new Promise(r => setTimeout(r, 500))
  }
  const tripo = rows?.find(s => s.name === 'tripo')
  assert(tripo, 'Tripo is registered in the real Codex thread')
  assert.equal(Object.keys(tripo.tools ?? {}).length, 5, JSON.stringify(tripo))
  console.log('ok real Codex thread discovers all 5 Tripo tools')
  const off = await rpc('thread/start', { cwd: root, config: { mcp_servers: { tripo: { ...spec, enabled: false } } } })
  const disabled = (await rpc('mcpServerStatus/list', { threadId: off.thread.id })).data?.find(s => s.name === 'tripo')
  assert(!disabled || disabled.runtimeStatus === 'disabled')
  console.log('ok disabled preset does not start in a new thread')
  fs.writeFileSync(path.join(scratch, 'codex-results.json'), JSON.stringify({ codex: exe, tools: Object.keys(tripo.tools), runtimeStatus: tripo.runtimeStatus, disabledThreadStatus: disabled?.runtimeStatus ?? 'absent', generatedTurns: 0, userCredentials: false, resumedThread: 'not tested: Codex persists rollout only after first turn' }, null, 2))
} finally { child.kill() }
