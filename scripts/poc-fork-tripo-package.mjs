// Run against an installed directory outside the checkout: parent node_modules
// must not mask a missing dependency in the installer.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const installed = path.resolve(process.argv[2])
const runtime = path.join(installed, 'custom-runtime')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ccg-tripo-package-'))
const child = spawn(path.join(installed, 'node.exe'), [path.join(runtime, 'out/main/tripoMcpBridge.js'), path.join(runtime, 'node_modules/tripo-cli/dist/cli.js')], {
  cwd: installed, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, TRIPO_API_KEY: '', TRIPO_HOME: home, TRIPO_REGION: 'ov' }
})
child.stderr.resume()
const pending = new Map()
readline.createInterface({ input: child.stdout }).on('line', line => {
  let response
  try { response = JSON.parse(line) } catch { return }
  pending.get(response.id)?.(response)
})
let id = 0
const request = (method, params) => new Promise((resolve, reject) => {
  const key = ++id
  const timer = setTimeout(() => { pending.delete(key); reject(new Error('Installed MCP timeout: ' + method)) }, 15000)
  pending.set(key, response => { clearTimeout(timer); pending.delete(key); response.error ? reject(new Error('MCP request failed: ' + method)) : resolve(response.result) })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n')
})
try {
  await request('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'fork-package-test', version: '1' }, capabilities: {} })
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const inventory = await request('tools/list', {})
  assert.equal(inventory.tools.length, 5)
  assert.deepEqual(await request('resources/templates/list', {}), { resourceTemplates: [] })
  console.log(JSON.stringify({ installedTripoTools: inventory.tools.map(tool => tool.name), bridgeCompatible: true, generatedAssets: 0 }))
} finally { child.stdin.end(); child.kill() }
