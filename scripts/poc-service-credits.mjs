// Offline billing contract checks. No real credentials or generation requests.
import esbuild from 'esbuild'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const dir = path.join(root, '.dev-home', 'credit-verification')
fs.mkdirSync(dir, { recursive: true })
const fixtures = globalThis.__creditTest = { keys: { TRIPO_API_KEY: 'test-tripo' }, token: 'test-comfy', expiresAt: null, refreshed: 0, refreshFails: false, delays: [] }
const stubs = {
  'node:timers/promises': 'export const setTimeout=async ms=>{globalThis.__creditTest.delays.push(ms)};',
  './secrets': 'export const secretValues=()=>globalThis.__creditTest.keys; export const expandSecretRefs=(v,keys)=>v.replace(/\\$\\{(\\w+)\\}/g,(s,k)=>keys[k]??s);',
  './mcp': 'export const appServers=()=>globalThis.__creditTest.servers??{};',
  './mcpOAuth': 'export const comfyAppAccessToken=()=>null;',
  './lang': 'export const t=(ko,en)=>en;',
  './codex/auth': 'export const codexListAccounts=async()=>[{email:"one",isDefault:true},{email:"two"}]; export const codexAccountRunDir=email=>email;',
  './comfyCredentials': `export const COMFY_MCP_URL='https://cloud.comfy.org/mcp';
    export const comfyCredentialSignature=()=>globalThis.__creditTest.token;
    export const readNativeComfyCredential=async()=>({accessToken:globalThis.__creditTest.token,expiresAt:globalThis.__creditTest.expiresAt});
    export const refreshNativeComfyCredential=async()=>{if(globalThis.__creditTest.refreshFails)throw new Error('Transient startup failure');globalThis.__creditTest.refreshed++;globalThis.__creditTest.expiresAt=null;};`
}
const bundle = path.join(dir, 'offline.mjs')
await esbuild.build({
  stdin: { contents: `export * from './src/main/serviceCredits'; export * from './src/main/creditValues'`, resolveDir: root },
  bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent',
  plugins: [{ name: 'credit-fixtures', setup(build) {
    build.onResolve({ filter: /.*/ }, args => stubs[args.path] ? { path: args.path, namespace: 'credit-test' } : null)
    build.onLoad({ filter: /.*/, namespace: 'credit-test' }, args => ({ contents: stubs[args.path], loader: 'js' }))
  } }]
})
const { getServiceCredits, comfyCreditValues, tripoCreditValues, creditNumber } = await import(pathToFileURL(bundle).href)
let checks = 0
function check(name, fn) { fn(); checks++; console.log('ok ' + name) }
check('invalid, missing and boolean balances remain unknown', () => {
  for (const v of [null, undefined, '', ' ', false, true, Infinity, 'NaN', {}, []]) assert.equal(creditNumber(v), null)
  assert.equal(tripoCreditValues({ code: 0, data: {} }), null)
  assert.equal(tripoCreditValues({ code: 9, data: { balance: 20 } }), null)
})
check('Tripo zero is real; frozen credits are reported separately', () => assert.deepEqual(tripoCreditValues({ code: 0, data: { balance: '0', frozen: '30' } }), { balance: 0, frozen: 30 }))
check('Comfy matches the user screenshot and official Cloud badge: 74,502 credits', () => assert.equal(comfyCreditValues({ effective_balance_micros: 35308.8688168805 }, {}), 74502))
check('Comfy zero aggregate does not mask funded components', () => assert.equal(comfyCreditValues({ effective_balance_micros: 0, amount_micros: '0', prepaid_balance_micros: '1000000' }, {}), 2110000))
check('Comfy unknown and migration responses are not shown as zero', () => {
  assert.equal(comfyCreditValues({}, { subscription_status: 'active' }), null)
  assert.equal(comfyCreditValues({ amount_micros: 0 }, { subscription_status: false, has_funds: 'false' }), null)
  assert.equal(comfyCreditValues({ amount_micros: 0 }, { subscription_status: 'FREE' }), 0)
  assert.equal(comfyCreditValues({ amount_micros: -1_000_000 }, {}), -2110000)
})

const originalFetch = globalThis.fetch, originalNow = Date.now
let now = originalNow(), fetches = 0, status = 200, tripoBalance = 100, comfyBalance = 1_000_000
const plans = new Map(), counts = new Map()
Date.now = () => now
globalThis.fetch = async url => {
  fetches++
  const endpoint = new URL(url).pathname
  counts.set(endpoint, (counts.get(endpoint) ?? 0) + 1)
  const next = plans.get(endpoint)?.shift() ?? status
  if (next === 'timeout') { now += 15_000; throw new Error('Upstream timeout') }
  if (next === 'network') throw new TypeError('Upstream connection reset')
  if (next !== 200) return new Response(JSON.stringify({ error: 'Do not expose upstream-secret-value' }), { status: next })
  const body = String(url).includes('tripo3d') ? { code: 0, data: { balance: tripoBalance, frozen: 20 } }
    : String(url).endsWith('/balance') ? { amount_micros: comfyBalance }
      : String(url).endsWith('/status') ? { subscription_status: 'active', subscription_tier: 'CREATOR' }
        : { name: 'Test workspace' }
  return new Response(JSON.stringify(body))
}
try {
  const values = await Promise.all(Array.from({ length: 8 }, () => getServiceCredits('tripo', true)))
  check('simultaneous windows share one provider request', () => { assert.equal(fetches, 1); assert(values.every(v => v.balance === 100)) })
  await getServiceCredits('tripo'); await getServiceCredits('tripo', true)
  check('cache and manual-refresh floor prevent excessive polling', () => assert.equal(fetches, 1))
  now += 6001; status = 503
  const stale = await getServiceCredits('tripo', true)
  check('network error retains last success with timestamp and stale flag', () => {
    assert.equal(stale.balance, 100); assert(stale.stale); assert.equal(stale.state, 'unavailable'); assert.equal(stale.checkedAt, values[0].checkedAt)
    assert(!JSON.stringify(stale).includes('upstream-secret-value'))
  })
  now += 6001; status = 401
  const denied = await getServiceCredits('tripo', true)
  check('revoked credential clears the previously displayed balance', () => { assert.equal(denied.balance, null); assert.equal(denied.state, 'auth-required') })
  fixtures.keys.TRIPO_API_KEY = 'different-key'; status = 503
  const changed = await getServiceCredits('tripo', true)
  check('a new key never inherits another account’s cached balance', () => assert.equal(changed.balance, null))
  delete fixtures.keys.TRIPO_API_KEY
  const before = fetches, missing = await getServiceCredits('tripo', true)
  check('disconnected service does not issue unauthenticated requests', () => { assert.equal(fetches, before); assert.equal(missing.state, 'unconfigured') })
  status = 200
  const comfy = await getServiceCredits('comfy-cloud', true, 'one')
  check('Comfy returns workspace and plan alongside credit balance', () => { assert.equal(comfy.balance, 2110000); assert.equal(comfy.account, 'Test workspace'); assert.equal(comfy.plan, 'CREATOR') })
  status = 503
  const second = await getServiceCredits('comfy-cloud', true, 'two')
  check('different Codex accounts cannot share Comfy cached values', () => assert.equal(second.balance, null))
  status = 200; fixtures.token = 'new-comfy-token'; fixtures.expiresAt = 1
  await getServiceCredits('comfy-cloud', true, 'one')
  check('expired OAuth is renewed by native Codex before reading balance', () => assert.equal(fixtures.refreshed, 1))
  const balancePath = '/api/billing/balance'
  now += 6001; plans.set(balancePath, [500, 200])
  let calls = counts.get(balancePath), waits = fixtures.delays.length
  const recovered = await getServiceCredits('comfy-cloud', true, 'one')
  check('Comfy HTTP 500 recovers automatically without relogin', () => {
    assert.equal(recovered.state, 'ready'); assert.equal(recovered.balance, comfy.balance)
    assert.equal(counts.get(balancePath) - calls, 2); assert.equal(fixtures.refreshed, 1)
    assert.deepEqual(fixtures.delays.slice(waits), [500])
  })
  now += 6001; plans.set(balancePath, [500, 502, 503, 200])
  calls = counts.get(balancePath); waits = fixtures.delays.length
  const outage = await getServiceCredits('comfy-cloud', true, 'one')
  check('persistent server failure stops after three attempts and preserves last known balance', () => {
    assert.equal(counts.get(balancePath) - calls, 3)
    assert.deepEqual(fixtures.delays.slice(waits), [500, 1500])
    assert.equal(outage.state, 'unavailable'); assert.equal(outage.balance, recovered.balance)
    assert(outage.stale); assert.equal(outage.checkedAt, recovered.checkedAt)
    assert.match(outage.note, /ComfyCloud.*temporarily.*503/)
    assert(!JSON.stringify(outage).includes('upstream-secret-value'))
  })
  calls = fetches; now += 3000
  await getServiceCredits('comfy-cloud', false, 'one')
  check('failed requests still have a short cache to prevent request floods', () => assert.equal(fetches, calls))
  now += 3001
  const reopened = await getServiceCredits('comfy-cloud', false, 'one')
  check('reopening the balance view does not retain a recovered server error for 60 seconds', () => {
    assert.equal(reopened.state, 'ready'); assert.equal(reopened.stale, false); assert.equal(reopened.note, null)
    assert(fetches > calls)
  })
  now += 6001; plans.set(balancePath, ['network', 200]); calls = counts.get(balancePath)
  const transport = await getServiceCredits('comfy-cloud', true, 'one')
  check('a transient network failure can recover within the same request', () => {
    assert.equal(transport.state, 'ready'); assert.equal(counts.get(balancePath) - calls, 2)
  })
  now += 6001; plans.set(balancePath, ['timeout', 200]); calls = counts.get(balancePath)
  const timedOut = await getServiceCredits('comfy-cloud', true, 'one')
  check('the overall request deadline prevents retries after a timeout', () => {
    assert.equal(timedOut.state, 'unavailable'); assert.equal(counts.get(balancePath) - calls, 1)
  })
  now += 6001; plans.set(balancePath, [401, 200]); calls = counts.get(balancePath)
  const unauthorized = await getServiceCredits('comfy-cloud', true, 'one')
  check('HTTP 401 clears the balance without repeating a rejected authentication', () => {
    assert.equal(unauthorized.state, 'auth-required'); assert.equal(unauthorized.balance, null)
    assert.equal(counts.get(balancePath) - calls, 1)
  })
  now += 6001; plans.set(balancePath, [429, 200]); calls = counts.get(balancePath)
  const limited = await getServiceCredits('comfy-cloud', true, 'one')
  check('rate limits are not retried as transient server failures', () => {
    assert.equal(limited.state, 'unavailable'); assert.equal(counts.get(balancePath) - calls, 1)
  })
  fixtures.token = 'slow-comfy'; fixtures.expiresAt = 1; fixtures.refreshFails = true
  const delayed = await getServiceCredits('comfy-cloud', true, 'one')
  check('temporary OAuth startup failure does not request another login', () => assert.equal(delayed.state, 'unavailable'))
  check('renderer payloads never contain keys or bearer tokens', () => {
    for (const v of [comfy, stale, denied, changed]) assert(!JSON.stringify(v).includes('test-comfy') && !JSON.stringify(v).includes('test-tripo'))
  })
  const beforeKeyRefresh = fixtures.refreshed
  fixtures.keys.COMFY_API_KEY = 'comfyui-billing-fixture'
  const unwired = await getServiceCredits('comfy-cloud', true)
  check('a vault key not registered for chat is reported as unconfigured', () => assert.equal(unwired.state, 'unconfigured'))
  fixtures.servers = { 'comfy-cloud': {type:'http',url:'https://cloud.comfy.org/mcp',headers:{'X-API-Key':'${COMFY_API_KEY}'}} }
  status = 200; plans.clear()
  const keyBalance = await getServiceCredits('comfy-cloud', true)
  check('registered API key bypasses revoked OAuth and account selection', () => {
    assert.equal(keyBalance.state,'ready'); assert.equal(fixtures.refreshed,beforeKeyRefresh)
  })
  now += 6001
  const priorMock = globalThis.fetch
  let releaseMetadata
  const metadataGate = new Promise(resolve => { releaseMetadata=resolve })
  globalThis.fetch = async (url, options) => {
    assert.equal(options.headers['X-API-Key'],fixtures.keys.COMFY_API_KEY)
    assert.equal(options.headers.Authorization,undefined)
    if (!String(url).endsWith('/balance')) await metadataGate
    return priorMock(url,options)
  }
  const began = performance.now()
  const quickBalance = await getServiceCredits('comfy-cloud', true)
  releaseMetadata()
  check('slow optional workspace/status does not block a known balance', () => {
    assert.equal(quickBalance.state,'ready'); assert(performance.now()-began < 1500)
  })
  globalThis.fetch = priorMock
  delete fixtures.keys.COMFY_API_KEY
  const missingKey = await getServiceCredits('comfy-cloud',true)
  check('missing configured key never falls back to an unrelated OAuth account', () => assert.equal(missingKey.state,'unconfigured'))
  fs.writeFileSync(path.join(dir, 'offline-results.json'), JSON.stringify({ passed: checks, generatedAssets: 0 }, null, 2))
} finally { globalThis.fetch = originalFetch; Date.now = originalNow; delete globalThis.__creditTest }
