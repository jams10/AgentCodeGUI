// Native worker, real DPAPI, reused service logic, mocked provider HTTP.
// No user account store and no paid generation requests are used.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
const root = path.resolve(import.meta.dirname, '..')
const dir = path.join(root, '.dev-home/fork-verification')
fs.mkdirSync(dir, { recursive: true })
const home = fs.mkdtempSync(path.join(dir, 'home-'))
const runtime = path.join(root, 'src-tauri/custom-runtime')
const exe = process.argv[2] || path.join(root, 'target/debug/agentcodegui.exe')
assert(fs.existsSync(exe), 'Build the native app first')
const mock = path.join(home, 'http.cjs')
fs.writeFileSync(mock, `globalThis.fetch=async(url)=>{
 if(String(url)==='https://openapi.tripo3d.ai/v3/account/balance')return {ok:true,status:200,json:async()=>({code:0,data:{balance:120,frozen:0}})};
 if(String(url).startsWith('https://openapi.tripo3d.ai/v3/tasks/'))return {ok:true,status:200,json:async()=>({code:0,data:{task_id:String(url).split('/').pop(),credits_consumed:0}})};
 throw Error('Unexpected provider request in offline test');
};`)
const child = spawn(process.execPath, ['--require', mock, path.join(runtime, 'service.cjs')], {
  cwd: runtime, windowsHide: true,
  env: { ...process.env, CCG_HOME: home, CCG_NO_NET: '1', CCG_CUSTOM_ROOT: runtime, CCG_CUSTOM_EXE: exe },
  stdio: ['pipe', 'pipe', 'pipe']
})
const pending = new Map(), events = []
let serial = 0, errors = '', checks = 0
child.stderr.on('data', data => { errors += data })
readline.createInterface({ input: child.stdout }).on('line', line => {
  const value = JSON.parse(line)
  if (value.id) pending.get(value.id)?.(value)
  else events.push(value)
})
function call(channel, arg) {
  const id = String(++serial)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Worker timeout: ' + channel + ' ' + errors)) }, 20_000)
    pending.set(id, reply => { clearTimeout(timer); pending.delete(id); reply.error ? reject(new Error(reply.error)) : resolve(reply.value) })
    child.stdin.write(JSON.stringify({ id, channel, args: arg === undefined ? [] : [arg] }) + '\n')
  })
}
function check(name, fn) { fn(); checks++; console.log('ok ' + name) }
try {
  const keys = await call('secrets:set', { name: 'FORK_TEST_KEY', value: 'fixture-private-value', env: true })
  check('native vault returns metadata only', () => { assert.equal(keys[0].tail, 'alue'); assert(!JSON.stringify(keys).includes('fixture-private-value')) })
  const store = JSON.parse(fs.readFileSync(path.join(home, 'secrets.json'), 'utf8'))
  check('real DPAPI encryption stored', () => { assert.equal(store.items[0].enc, true); assert(!JSON.stringify(store).includes('fixture-private-value')) })
  const tripo = await call('tripo:register', 'fixture-tripo-key')
  check('bundled Tripo registration survives native runtime layout', () => { assert(tripo.cliAvailable && tripo.registered && tripo.keySaved) })
  const tripoCheck = await call('tripo:check')
  check('Tripo authentication uses vault key', () => assert(tripoCheck.ok))
  const credits = await call('credits:get', { service: 'tripo', fresh: true })
  check('provider balance is parsed', () => assert.equal(credits.balance, 120))
  const comfy = await call('comfy:register', 'comfyui-fixture-comfy-key')
  check('ComfyCloud API registration retained', () => assert(comfy.keySaved && comfy.registered))
  const credOne = path.join(home, 'oauth-source.json'), credTwo = path.join(home, 'account2/.credentials.json')
  fs.mkdirSync(path.dirname(credTwo), {recursive:true})
  fs.writeFileSync(credOne, JSON.stringify({mcpOAuth:{fixture:{serverName:'fixture',serverUrl:'https://example.invalid/mcp',accessToken:'fixture-refreshed-token',expiresAt:Date.now()+3600000}}}))
  fs.writeFileSync(credTwo, '{}')
  await call('custom:harvest-oauth', {path:credOne})
  await call('custom:spawn', {engine:'claude',cwd:home,configDir:path.dirname(credTwo)})
  check('refreshed MCP OAuth token is shared with the next Claude account',()=>assert.equal(JSON.parse(fs.readFileSync(credTwo,'utf8')).mcpOAuth.fixture.accessToken,'fixture-refreshed-token'))
  check('shared OAuth token remains encrypted',()=>assert(!fs.readFileSync(path.join(home,'mcp-oauth.json'),'utf8').includes('fixture-refreshed-token')))
  const prepared = await call('custom:spawn', { engine: 'codex', cwd: home })
  check('Codex receives MCP configuration and env credentials', () => {
    assert.equal(prepared.env.FORK_TEST_KEY, 'fixture-private-value')
    assert.equal(prepared.config.mcp_servers.tripo.tool_timeout_sec, 1800)
    assert.equal(prepared.config.mcp_servers['comfy-cloud'].bearer_token_env_var, 'COMFY_API_KEY')
    assert(!JSON.stringify(prepared.config.mcp_servers['comfy-cloud']).includes('comfyui-fixture-comfy-key'))
  })
  await call('mcp:set-enabled', { name: 'tripo', enabled: false })
  const disabled = await call('custom:spawn', { engine: 'codex', cwd: home })
  check('disabled custom MCP stays disabled after refresh', () => assert.equal(disabled.config.mcp_servers.tripo.enabled, false))
  const form = await call('custom:mcp-form', { mode: 'form', serverName: 'test', message: 'Consent', requestedSchema: { type: 'object', properties: { agree: { type: 'boolean', default: true } }, required: ['agree'] } })
  check('MCP form requires explicit selection', () => { assert.equal(form.questions[0].allowCustom, false); assert.equal(form.questions[0].options.length, 2) })
  const answer = await call('custom:mcp-answer', { id: form.id, answers: [[form.questions[0].options[1].label]] })
  check('MCP false answer is not promoted to true', () => assert.deepEqual(answer, { action: 'accept', content: { agree: false } }))
  await call('custom:capture', { chat: 'c1', event: { type: 'session', runId: 'r1', cwd: home } })
  await call('custom:capture', { chat: 'c1', event: { type: 'custom-tool-start', runId: 'r1', id: 't1', name: 'mcp__tripo__make', input: { prompt: 'test asset', api_key: 'never-store-me' } } })
  await call('custom:capture', { chat: 'c1', event: { type: 'custom-tool-end', runId: 'r1', id: 't1', result: { code: 0, data: { task_id: 'fixture-job', status: 'completed', model_file: path.join(home, 'model.glb'), padding: 'x'.repeat(5000), credits_consumed: 0 } }, failed: false } })
  const records = events.filter(e => e.event === 'custom:generation' && e.payload.event.type === 'generation').map(e => e.payload.event.record)
  check('raw generation capture survives long provider output', () => {
    assert(records.some(r => r.status === 'completed' && r.jobIds.includes('fixture-job') && r.usage.credits === 0))
    assert(!JSON.stringify(records).includes('never-store-me'))
  })
  const paths = await call('work:inspect-paths', { cwd: home, paths: ['secrets.json', home] })
  check('work paths are resolved by native service', () => assert.equal(paths.length, 2))
  fs.writeFileSync(path.join(dir, 'services.json'), JSON.stringify({ checks, paidRequests: 0, nativeCrypto: true }, null, 2))
  console.log(`${checks} native service checks passed`)
} finally {
  child.stdin.end()
  const kill = setTimeout(() => child.kill(), 2000)
  await new Promise(resolve => child.once('exit', resolve))
  clearTimeout(kill)
}
