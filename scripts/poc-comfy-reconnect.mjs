import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
const dir=path.resolve('.dev-home/credit-verification'); fs.mkdirSync(dir,{recursive:true})
await build({entryPoints:['src/main/comfyRefresh.ts'],bundle:true,platform:'node',format:'esm',outfile:path.join(dir,'reconnect-test.mjs')})
const { waitForComfyConnection, ComfyRefreshError, isRevokedComfyAuth }=await import(pathToFileURL(path.join(dir,'reconnect-test.mjs')))
const row=status=>({data:[{name:'comfy-cloud',runtimeStatus:status}]})
let polls=0
await waitForComfyConnection(async()=>++polls>12?row('connected'):row('starting'),()=>false,{intervalMs:0})
assert.equal(polls,13)
await waitForComfyConnection(async()=>({data:[{name:'local:comfy-cloud',runtimeStatus:'connected'}]}),()=>false)
let absent=true
await waitForComfyConnection(async()=>{if(absent){absent=false;return {data:[]}}return row('connected')},()=>false,{intervalMs:0})
await assert.rejects(waitForComfyConnection(async()=>row('starting'),()=>false,{timeoutMs:1,intervalMs:1}),e=>e instanceof ComfyRefreshError&&e.kind==='unavailable'&&e.reason==='timeout')
await assert.rejects(waitForComfyConnection(async()=>row('failed'),()=>false),e=>e.kind==='unavailable')
await assert.rejects(waitForComfyConnection(async()=>row('authenticationRequired'),()=>false),e=>e.kind==='auth-required')
await assert.rejects(waitForComfyConnection(async()=>row('failed'),()=>true),e=>e.kind==='auth-required')
assert(isRevokedComfyAuth('invalid_grant: refresh token reuse detected'))
assert(!isRevokedComfyAuth('failed to initialize sqlite: database locked'))
assert(!isRevokedComfyAuth('connection timed out'))
fs.writeFileSync(path.join(dir,'reconnect-results.json'),JSON.stringify({checks:10,paidRequests:0},null,2))
console.log('10 reconnection checks passed: slow/missing startup, aliases, network errors, revoked auth')
