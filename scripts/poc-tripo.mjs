// Offline integration checks: real app modules, official CLI + Electron stdio,
// and a loopback balance endpoint. No account key or paid generation is used.
import esbuild from 'esbuild'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import http from 'node:http'

const root = path.resolve(import.meta.dirname, '..')
const scratch = path.join(root, '.dev-home', 'tripo-verification')
fs.mkdirSync(scratch, { recursive: true })
const appHome = fs.mkdtempSync(path.join(scratch, 'unit-'))
globalThis.__tripoEncrypt = true
const bundle = path.join(appHome, 'modules.mjs')
await esbuild.build({
  stdin: { contents: `export * as tripo from './src/main/tripo'; export * as mcp from './src/main/mcp'; export * as keys from './src/main/secrets'`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', outfile: bundle,
  alias: { '@shared': path.join(root, 'src/shared') }, logLevel: 'silent',
  plugins: [{ name: 'isolate-app', setup(build) {
    const stubs = {
      electron: `export const app={isPackaged:false,getAppPath:()=>${JSON.stringify(root)}}; export const safeStorage={isEncryptionAvailable:()=>globalThis.__tripoEncrypt,encryptString:s=>Buffer.from('test-encoded:'+Buffer.from(s).toString('base64')),decryptString:b=>Buffer.from(b.toString().slice(13),'base64').toString()};`,
      './engine/versions': `export const APP_HOME=${JSON.stringify(appHome)};`,
      './lang': `export const t=(ko,en)=>en;`,
      './mcpOAuth': `export const mcpOAuthState=()=>null;`
    }
    build.onResolve({ filter: /^(electron|\.\/(engine\/versions|lang|mcpOAuth))$/ }, ({ path: p }) => ({ path: p, namespace: 'isolated' }))
    build.onLoad({ filter: /.*/, namespace: 'isolated' }, ({ path: p }) => ({ contents: stubs[p], loader: 'js' }))
  } }]
})
const { tripo, mcp, keys } = await import(pathToFileURL(bundle).href)
let count = 0
const check = (name, fn) => { fn(); count++; console.log('ok ' + name) }
const fakeKey = 'tsk_test_not_a_real_key_7391'
check('initial status contains no credential', () => assert.equal(tripo.tripoStatus().keySaved, false))
check('register without key exposes MCP, not authenticated status', () => {
  const state = tripo.registerTripo()
  assert(state.registered && state.enabled && !state.keySaved)
})
check('save key uses vault; registry contains references; UI sees only tail', () => {
  const state = tripo.registerTripo(fakeKey)
  assert(state.keySaved && state.keyTail === '7391')
  assert(!JSON.stringify(state).includes(fakeKey))
  assert(!fs.readFileSync(path.join(appHome, 'mcp.json'), 'utf8').includes(fakeKey))
  assert(!fs.readFileSync(path.join(appHome, 'secrets.json'), 'utf8').includes(fakeKey))
  assert.equal(mcp.resolvedAppServers().tripo.env.TRIPO_API_KEY, fakeKey)
})
check('Codex receives stdio + generation timeout; disable remains explicit', () => {
  assert.equal(mcp.codexAppMcpConfig().mcp_servers.tripo.tool_timeout_sec, 1800)
  mcp.setMcpEnabled('tripo', false)
  tripo.refreshTripoRegistration()
  assert.equal(tripo.tripoStatus().enabled, false)
  assert.equal(mcp.codexAppMcpConfig().mcp_servers.tripo.enabled, false)
  tripo.registerTripo()
})
check('custom server conflict cannot change the saved key or server', () => {
  mcp.upsertAppServer('tripo', { type: 'stdio', command: 'custom-server' })
  assert.throws(() => tripo.registerTripo('tsk_replacement'), /custom MCP server/)
  assert.equal(keys.secretValues().TRIPO_API_KEY, fakeKey)
  assert.equal(mcp.appServers().tripo.command, 'custom-server')
  mcp.removeAppServer('tripo')
  tripo.registerTripo()
})
check('unavailable encryption and invalid key cannot mutate vault', () => {
  globalThis.__tripoEncrypt = false
  assert.throws(() => tripo.registerTripo('tsk_replacement'), /encryption/)
  globalThis.__tripoEncrypt = true
  assert.throws(() => tripo.registerTripo('tsk_bad\nheader'), /whitespace/)
  assert.equal(keys.secretValues().TRIPO_API_KEY, fakeKey)
})
const nativeFetch = globalThis.fetch
let fetches = 0
globalThis.fetch = async (url, opts) => {
  fetches++
  assert.equal(url, 'https://openapi.tripo3d.ai/v3/account/balance')
  assert.equal(opts.headers.Authorization, `Bearer ${fakeKey}`)
  assert.equal(opts.redirect, 'error')
  return new Response(JSON.stringify({ code: 0, data: { balance: '0', frozen: 0 } }))
}
assert.deepEqual(await tripo.checkTripoConnection(), { ok: true, balance: 0 })
check('zero credits is authenticated; test uses only read-only balance', () => assert.equal(fetches, 1))
globalThis.fetch = async () => new Response(JSON.stringify({ secret: fakeKey }), { status: 401 })
const rejected = await tripo.checkTripoConnection()
check('401 returns safe error without API response body', () => { assert.equal(rejected.ok, false); assert(!JSON.stringify(rejected).includes(fakeKey)) })
globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { balance: null } }))
assert.equal((await tripo.checkTripoConnection()).ok, false)
keys.removeSecret('TRIPO_API_KEY')
globalThis.fetch = () => { throw new Error('Must not call network without key') }
check('deleted key is absent from status', () => assert.equal(tripo.tripoStatus().keySaved, false))
assert.equal((await tripo.checkTripoConnection()).ok, false)
globalThis.fetch = nativeFetch

// Same executable + args + env strategy used by the built app, not a global node.
const requests = []
const api = http.createServer((req, res) => {
  requests.push({ method: req.method, url: req.url })
  assert.equal(req.headers.authorization, `Bearer ${fakeKey}`)
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ code: 0, data: { balance: 37, frozen: 0 } }))
})
await new Promise(r => api.listen(0, '127.0.0.1', r))
const electronPath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const child = spawn(electronPath, [tripo.tripoBridgePath(), tripo.tripoCliPath()], { windowsHide: true,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TRIPO_API_KEY: fakeKey, TRIPO_HOME: path.join(appHome, 'cli'), TRIPO_API_BASE_URL: `http://127.0.0.1:${api.address().port}` },
  stdio: ['pipe', 'pipe', 'pipe'] })
const pending = new Map(); let seq = 0; let buffer = ''
child.stdout.on('data', chunk => {
  buffer += chunk
  let end
  while ((end = buffer.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1)
    const waiter = pending.get(msg.id)
    if (waiter) { pending.delete(msg.id); clearTimeout(waiter.timer); msg.error ? waiter.reject(new Error(msg.error.message)) : waiter.resolve(msg.result) }
  }
})
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq
  const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP timeout: ' + method)) }, 15000)
  pending.set(id, { resolve, reject, timer })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
try {
  const hello = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tripo-test', version: '1' } })
  check('official CLI starts under Electron Node mode', () => assert.equal(hello.serverInfo.version, '0.3.1'))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const { tools } = await rpc('tools/list')
  check('all five official tools are discoverable', () => assert.deepEqual(tools.map(t => t.name).sort(), ['tripo_balance', 'tripo_history', 'tripo_make', 'tripo_task_get', 'tripo_task_wait']))
  assert.deepEqual(await rpc('resources/list'), { resources: [] })
  assert.deepEqual(await rpc('resources/templates/list'), { resourceTemplates: [] })
  assert.deepEqual(await rpc('prompts/list'), { prompts: [] })
  await assert.rejects(rpc('unknown/method'), /Method not found/)
  count++; console.log('ok compatibility shim answers optional and unknown inventory requests')
  const result = await rpc('tools/call', { name: 'tripo_balance', arguments: {} })
  check('MCP calls authenticated balance through local test endpoint', () => assert.equal(JSON.parse(result.content[0].text).balance, 37))
  check('no generation requested', () => assert.deepEqual(requests, [{ method: 'GET', url: '/v3/account/balance' }]))
  fs.writeFileSync(path.join(scratch, 'unit-results.json'), JSON.stringify({ passed: count, tools: tools.map(t => t.name), network: 'loopback only', generatedAssets: 0, actualTripoAuthentication: 'not tested (no user key)' }, null, 2))
} finally { child.kill(); api.close() }
console.log(`Passed ${count} checks.`)
