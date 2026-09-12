// Start an isolated app first (CCG_HOME=.dev-home/tripo-verification/ui, CDP 9334).
// Real renderer/preload/IPC/DPAPI; fake key only, no generation or network check.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
const root = path.resolve(import.meta.dirname, '..')
const home = path.join(root, '.dev-home/tripo-verification/ui')
const targets = await (await fetch('http://127.0.0.1:9334/json')).json()
const target = targets.find(t => t.type === 'page' && !/toast|tray|devtools/.test(t.url))
if (!target) throw new Error('Isolated UI not found')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0; const pending = new Map()
ws.onmessage = event => {
  const msg = JSON.parse(event.data); const p = pending.get(msg.id)
  if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result) }
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq; const timer = setTimeout(() => reject(new Error('CDP timeout')), 20000)
  pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }))
})
const ev = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'JS failed')
  return result.result.value
}
const wait = expression => ev(`new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(${expression})return resolve(true);if(Date.now()-start>8000)return reject(new Error('UI timeout'));setTimeout(poll,100)};poll()})`)
const click = async (selector, text) => {
  const point = await ev(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text === undefined ? 'true' : `e.textContent.trim()===${JSON.stringify(text)}`});if(!el)throw new Error('Missing control');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!el.contains(document.elementFromPoint(x,y)))throw new Error('Control is covered by another dialog');return {x,y}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
}
const key = 'tsk_ui_fake_key_1859'
try {
  await wait(`document.querySelector('.sb-foot')`)
  // First-run dialogs are unrelated to settings. Dismiss them before testing the
  // actual controls with hit-tested pointer events (do not install an engine).
  await ev(`document.querySelector('.sd-cancel')?.click(); document.querySelector('.pn-go')?.click(); true`)
  await wait(`!document.querySelector('.sd-cancel') && !document.querySelector('.pn-go')`)
  if (!await ev(`!!document.querySelector('.set-ni')`)) await click('.sb-foot')
  await wait(`document.querySelector('.set-ni')`)
  await click('.set-ni', 'Tripo')
  await wait(`document.querySelector('#tripo-api-key')`)
  await wait(`[...document.querySelectorAll('[data-testid="tripo-settings"] button')].some(e=>e.textContent==='MCP 등록'&&!e.disabled)`)
  await click('[data-testid="tripo-settings"] button', 'MCP 등록')
  await wait(`document.querySelector('[role="status"]')?.textContent.includes('MCP를 등록')`)
  assert.equal((await ev('window.api.tripo.status()')).keySaved, false)
  console.log('ok UI registers official MCP without pretending to authenticate')
  await ev(`(()=>{const el=document.querySelector('#tripo-api-key');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(key)});el.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
  await wait(`[...document.querySelectorAll('[data-testid="tripo-settings"] button')].some(e=>e.textContent==='키 저장 · MCP 등록'&&!e.disabled)`)
  await click('[data-testid="tripo-settings"] button', '키 저장 · MCP 등록')
  await wait(`document.querySelector('#tripo-api-key')?.value==='' && document.querySelector('#tripo-api-key')?.placeholder==='••••1859'`)
  const state = await ev('window.api.tripo.status()')
  assert(state.keySaved && state.registered && state.enabled)
  assert(!JSON.stringify(state).includes(key))
  const vaultText = fs.readFileSync(path.join(home, 'secrets.json'), 'utf8')
  const entry = JSON.parse(vaultText).items.find(i => i.name === 'TRIPO_API_KEY')
  assert(entry.enc === true && !vaultText.includes(key))
  assert(!fs.readFileSync(path.join(home, 'mcp.json'), 'utf8').includes(key))
  console.log('ok real UI/IPC saves with Windows DPAPI and clears key input')
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(home, 'tripo-settings.png'), Buffer.from(shot.data, 'base64'))
  await click('.set-ni', 'MCP')
  await wait(`[...document.querySelectorAll('.sc2.row2.mcp .emt')].some(e=>e.textContent==='tripo')`)
  console.log('ok registered Tripo appears in MCP management')
  await click('.set-ni', 'Keys')
  await wait(`[...document.querySelectorAll('.sc2.row2 .emt')].some(e=>e.textContent==='TRIPO_API_KEY')`)
  console.log('ok key appears in shared Keys management')
  // Clean the fake credential, leaving no test key in any persistent UI home.
  await ev('window.api.secrets.remove("TRIPO_API_KEY")')
  await click('.set-ni', 'Tripo')
  await wait(`document.querySelector('#tripo-api-key')?.placeholder==='tsk_…'`)
  assert.equal((await ev('window.api.tripo.status()')).keySaved, false)
  fs.writeFileSync(path.join(home, 'ui-results.json'), JSON.stringify({ passed: 5, encryption: 'real Windows DPAPI', fakeKeyRemoved: true, actualTripoAuthentication: 'not tested', generatedAssets: 0 }, null, 2))
} finally { ws.close() }
