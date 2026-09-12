// Offline app integration: fake vault encryption and mocked HTTP only.
import esbuild from 'esbuild'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const root = path.resolve(import.meta.dirname, '..')
const dir = path.join(root, '.dev-home/comfy-api-verification')
fs.mkdirSync(dir, { recursive: true })
const home = fs.mkdtempSync(path.join(dir, 'unit-'))
globalThis.__comfyEncryption = true
const bundle = path.join(home, 'modules.mjs')
await esbuild.build({
  stdin: { contents: `export * as comfy from './src/main/comfy'; export * as mcp from './src/main/mcp'; export * as keys from './src/main/secrets'`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent',
  plugins: [{ name: 'isolate', setup(build) {
    const stubs = {
      electron: `export const app={isPackaged:false,getAppPath:()=>${JSON.stringify(root)}}; export const safeStorage={isEncryptionAvailable:()=>globalThis.__comfyEncryption,encryptString:s=>Buffer.from(Buffer.from(s).toString('base64')),decryptString:b=>Buffer.from(b.toString(),'base64').toString()};`,
      './engine/versions': `export const APP_HOME=${JSON.stringify(home)};`,
      './lang': 'export const t=(ko,en)=>en;',
      './mcpOAuth': 'export const mcpOAuthState=()=>({connected:true});',
      './serviceCredits': 'export const getServiceCredits=async()=>({state:"ready",balance:100});'
    }
    build.onResolve({ filter: /.*/ }, args => stubs[args.path] ? { path: args.path, namespace: 'fixture' } : null)
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: stubs[args.path], loader: 'js' }))
  } }]
})
const { comfy, mcp, keys } = await import(pathToFileURL(bundle).href)
let checks = 0
const check = (name, fn) => { fn(); checks++; console.log('ok ' + name) }
const key = 'comfyui-test-only-1937'
check('missing and malformed keys do not mutate registry', () => {
  assert.throws(() => comfy.registerComfy()); assert.throws(() => comfy.registerComfy('other-key'))
  assert.equal(comfy.comfyStatus().registered, false)
})
check('OAuth entry becomes shared API reference; unrelated settings survive', () => {
  mcp.upsertAppServer('other', { type: 'http', url: 'https://example.invalid' })
  mcp.upsertAppServer('comfy-cloud', { type: 'http', url: 'https://cloud.comfy.org/mcp', headers: { Authorization: 'Bearer old-token', 'X-Custom': 'preserved' } })
  const result = comfy.registerComfy(key)
  assert(result.registered && result.enabled && result.keySaved)
  const spec = mcp.appServers()['comfy-cloud']
  assert.equal(spec.headers.Authorization, undefined); assert.equal(spec.headers['X-Custom'], 'preserved')
  assert(mcp.appServers().other); assert(!JSON.stringify(result).includes(key))
  for (const file of ['mcp.json','secrets.json']) assert(!fs.readFileSync(path.join(home,file),'utf8').includes(key))
})
check('Claude and Codex use the same vault key; native config contains no key text', () => {
  assert.equal(mcp.resolvedAppServers()['comfy-cloud'].headers['X-API-Key'], key)
  const config = mcp.codexAppMcpConfig(), spec = config.mcp_servers['comfy-cloud']
  assert.equal(spec.bearer_token_env_var, 'COMFY_API_KEY')
  assert.equal(spec.env_http_headers['X-API-Key'], 'COMFY_API_KEY')
  assert.equal(keys.secretEnv().COMFY_API_KEY, key)
  assert(!JSON.stringify(config).includes(key))
  assert.equal(mcp.listMcpServers('').find(s => s.name === 'comfy-cloud' && s.origin === 'app').oauth, null)
})
check('rotation changes process fingerprint; disable remains explicit', () => {
  const previous = mcp.mcpSpawnFingerprint(); comfy.registerComfy('comfyui-rotated-fixture')
  assert.notEqual(mcp.mcpSpawnFingerprint(), previous)
  mcp.setMcpEnabled('comfy-cloud', false)
  assert.equal(comfy.comfyStatus().enabled, false)
  assert.equal(mcp.codexAppMcpConfig().mcp_servers['comfy-cloud'].enabled, false)
  comfy.registerComfy(key)
})
check('conflicting server and unavailable encryption cannot replace a key', () => {
  globalThis.__comfyEncryption = false
  assert.throws(() => comfy.registerComfy('comfyui-replacement'), /encryption/)
  globalThis.__comfyEncryption = true
  mcp.upsertAppServer('comfy-cloud', { type: 'http', url: 'https://example.invalid/mcp' })
  assert.throws(() => comfy.registerComfy('comfyui-replacement'), /different server/)
  assert.equal(keys.secretValues().COMFY_API_KEY, key)
  mcp.removeAppServer('comfy-cloud'); comfy.registerComfy()
})
const originalFetch = globalThis.fetch, methods = []
let cancellations = 0
globalThis.fetch = async (url, options) => {
  assert.equal(url, 'https://cloud.comfy.org/mcp'); assert.equal(options.headers['X-API-Key'], key)
  const req = JSON.parse(options.body); methods.push(req.method)
  if (!req.id) return new Response(null, { status: 202 })
  const result = req.method === 'initialize' ? { protocolVersion: '2024-11-05' }
    : req.params.cursor ? { tools: [{name:'second'}] } : { tools: [{name:'first'}], nextCursor: 'page2' }
  // A fragmented SSE response which never closes, like a long-lived server.
  const text = 'data: ' + JSON.stringify({jsonrpc:'2.0',id:req.id,result}) + '\n\n'
  const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text.slice(0,20))); c.enqueue(new TextEncoder().encode(text.slice(20))) }, cancel() { cancellations++ } })
  return new Response(stream, { headers: { 'Content-Type':'text/event-stream', 'Mcp-Session-Id':'fixture-session' } })
}
try {
  const result = await comfy.checkComfyConnection()
  check('protocol check handles open SSE and pagination without generating', () => {
    assert.equal(result.mcp.ok, true); assert.equal(result.mcp.toolCount, 2)
    assert.equal(cancellations, 3); assert(!methods.includes('tools/call'))
  })
  globalThis.fetch = async () => new Response(JSON.stringify({secret:key}), { status:401 })
  const denied = await comfy.checkComfyMcp(key)
  check('HTTP rejection is separate from billing and redacts upstream text', () => {
    assert.equal(denied.ok, false); assert.equal(denied.error,'HTTP 401'); assert(!JSON.stringify(denied).includes(key))
  })
  keys.removeSecret('COMFY_API_KEY')
  await assert.rejects(comfy.checkComfyConnection(), /Save the ComfyCloud API key/)
  check('deleting key disables a usable connection', () => assert.equal(comfy.comfyStatus().keySaved, false))
  fs.writeFileSync(path.join(dir,'offline-results.json'), JSON.stringify({passed:checks,realCredentials:false,generatedAssets:0},null,2))
} finally { globalThis.fetch=originalFetch; delete globalThis.__comfyEncryption }
