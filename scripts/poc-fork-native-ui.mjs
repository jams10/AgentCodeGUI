// Real Tauri renderer / IPC / DPAPI / legacy chat migration; isolated fake data.
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { connectMainPage, sleep } from '../bench/lib.mjs'

const root = path.resolve(import.meta.dirname, '..')
const home = path.join(root, '.dev-home/fork-verification', 'native-ui-' + Date.now())
const exe = path.resolve(process.argv[2] || path.join(root, 'target/debug/agentcodegui.exe'))
let port = 9397
const json = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2)) }
const fixture = path.join(home, '한글 작업 폴더')
fs.mkdirSync(fixture, { recursive: true })
fs.writeFileSync(path.join(fixture, 'model.glb'), 'fixture')
const record = { id: 'fixture-gen', runId: 'r1', toolId: 't1', service: 'Tripo', tool: 'mcp__tripo__generate', model: 'v3.1', prompt: '커스텀 기록 복원 검증', parameters: '{}', status: 'completed', startedAt: Date.now(), updatedAt: Date.now(), durationMs: 1200, outputs: [path.join(fixture, 'model.glb')], jobIds: ['fixture-job'], usage: { credits: 0, tokens: null, inputTokens: null, outputTokens: null, usd: null } }
const snapshot = { status: 'done', messages: [{ kind: 'msg', id: 'm1', role: 'assistant', text: '저장된 결과: `' + fixture + '`', animate: false, time: '10:00' }], todos: [], files: [], diffs: {}, subagents: [], bgTasks: [], session: null, result: null, spentUsd: 0, tokenTotals: {}, seq: 3, shownNotices: [], generations: [record], workFolders: [fixture] }
json(path.join(home, 'profile.json'), { nickname: 'Fork verification', color: '#0EA5E9' })
json(path.join(home, 'engine-auto-update.json'), { enabled: false })
json(path.join(home, 'ui-prefs.json'), { 'workspace.mode': 'single', 'whatsnew.seenVersion': '3.2.5', 'ui.lang': 'ko', 'sidebar.autohide': false })
json(path.join(home, 'chats/index.json'), { version: 1, order: ['fork-fixture'], activeChatId: 'fork-fixture' })
json(path.join(home, 'chats/fork-fixture.json'), { id: 'fork-fixture', title: '커스텀 복원 검증', custom: true, manualCwd: fixture, picker: { model: 'haiku', effort: 'minimal', mode: 'bypass' }, updatedAt: Date.now(), snapshot })
let child, cdp, dismissTimer, checks = 0
const errors = []
const check = (name, condition) => { assert(condition, name); checks++; console.log('ok ' + name) }
const ev = expression => cdp.eval(expression, { awaitPromise: true })
const wait = expression => ev(`new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(${expression})return resolve(true);if(Date.now()-start>12000)return reject(new Error('UI timeout: '+${JSON.stringify(expression)}));setTimeout(poll,100)};poll()})`)
async function click(selector, text) {
  let point
  for(let attempt=0;attempt<40;attempt++){
    point = await ev(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text === undefined ? 'true' : `e.textContent.trim()===${JSON.stringify(text)}`});if(!el)throw new Error('Missing control '+${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!el.contains(document.elementFromPoint(x,y)))return null;return {x,y}})()`)
    if(point) break
    await sleep(100)
  }
  if(!point) throw new Error('Control remained covered: '+selector+' '+text)
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await sleep(180)
}
async function launch() {
  child = spawn(exe, [], { cwd: path.dirname(exe), env: { ...process.env, CCG_HOME: home, CCG_CDP_PORT: String(port), CCG_CUSTOM_DIAGNOSTICS: '1', CCG_NO_NET: '1', CCG_NO_BOOT_ENGINE_UPDATE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', data => fs.appendFileSync(path.join(home, 'native.log'), data))
  cdp = await connectMainPage(port, {timeoutMs: 60000})
  cdp.listeners.push(msg => { if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || 'renderer exception') })
  await cdp.send('Runtime.enable')
  for (let n = 0; n < 100; n++) {
    if (await ev(`!!(window.api && document.querySelector('.sb-foot'))`).catch(() => false)) break
    await sleep(150)
  }
  await wait(`window.api && document.querySelector('.sb-foot')`)
  await ev(`document.querySelector('.sd-cancel')?.click();document.querySelector('.pn-go')?.click();true`)
  dismissTimer = setInterval(() => { if(cdp && !cdp.dead) void ev(`document.querySelector('.sd-cancel')?.click();true`).catch(()=>{}) },250)
  await sleep(300)
}
function stop() {
  clearInterval(dismissTimer)
  cdp?.close()
  if (child?.pid) { const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, encoding:'utf8' }); if(killed.status!==0) console.log('kill result',killed.status,killed.stderr); }
  child = null
}
try {
  await launch()
  check('native app reports upstream version 3.2.5',await ev(`window.api.app.getVersion()`)==='3.2.5')
  console.log('custom IPC probe', await ev(`window.api.work.inspectPaths(${JSON.stringify(fixture)},[${JSON.stringify(fixture)}]).then(v=>({paths:v.length}),e=>({error:e.message}))`))
  check('legacy snapshot migrated with generation records', (await ev(`window.api.loadChat('fork-fixture')`)).snapshot.generations[0].prompt === record.prompt)
  await wait(`document.querySelector('.work-history-toggle')?.textContent.includes('1')`)
  await click('.work-history-toggle')
  await wait(`document.querySelector('.wh-record') && document.querySelector('.wh-folder')`)
  check('restored records, reported zero and local folders render', await ev(`document.querySelector('.wh-panel').textContent.includes('커스텀 기록 복원 검증') && document.querySelector('.wh-record-meta').textContent.includes('0')`))
  fs.writeFileSync(path.join(home, 'work-history.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await click('.wh-head button[aria-label]')
  await wait(`!document.querySelector('.wh-shade')`)
  await sleep(300)
  await wait(`document.querySelector('.work-path-link')`)
  check('existing local markdown path becomes a working folder control', true)
  await click('.sb-foot')
  await wait(`document.querySelector('.set-ni')`)
  await click('.set-ni', 'Tripo')
  await wait(`document.querySelector('#tripo-api-key')`)
  await wait(`[...document.querySelectorAll('[data-testid="tripo-settings"] button')].some(e=>e.textContent==='MCP 등록'&&!e.disabled)`)
  await click('[data-testid="tripo-settings"] button', 'MCP 등록')
  await wait(`document.querySelector('[role="status"]')?.textContent.includes('MCP를 등록')`)
  check('Tripo UI registers packaged official CLI', (await ev('window.api.tripo.status()')).cliAvailable)
  await click('.set-ni', 'ComfyCloud')
  await wait(`document.querySelector('[data-testid="comfy-settings"]')`)
  check('ComfyCloud custom settings remain available', !(await ev('window.api.comfy.status()')).keySaved)
  await ev(`window.api.secrets.set('FORK_UI_KEY','fixture-only-private-value',{env:true})`)
  await click('.set-ni', 'Keys')
  await wait(`document.querySelector('.set-main').textContent.includes('FORK_UI_KEY')`)
  const vault = fs.readFileSync(path.join(home, 'secrets.json'), 'utf8')
  check('native IPC encrypts keys and renderer gets metadata only', JSON.parse(vault).items[0].enc && !vault.includes('fixture-only-private-value') && !JSON.stringify(await ev('window.api.secrets.list()')).includes('fixture-only-private-value'))
  await ev(`window.api.mcp.upsert('fork-ui-probe',{type:'stdio',command:'node',args:['--version']})`)
  await click('.set-ni', 'MCP')
  await wait(`[...document.querySelectorAll('.sc2.row2.mcp .emt')].some(e=>e.textContent==='fork-ui-probe')`)
  await ev(`window.api.mcp.setEnabled('fork-ui-probe',false)`)
  check('custom MCP management uses app registry through native IPC', (await ev(`window.api.mcp.list(${JSON.stringify(fixture)})`)).some(row => row.name === 'fork-ui-probe' && !row.enabled))
  fs.writeFileSync(path.join(home, 'mcp-settings.png'), Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  await ev(`window.api.secrets.remove('FORK_UI_KEY')`)
  check('strict custom errors reach the renderer', await ev(`window.api.mcp.upsert('',{type:'stdio',command:''}).then(()=>false,()=>true)`))
  await sleep(1500)
  stop()
  await sleep(2500)
  port++
  await launch()
  check('native restart preserves custom snapshot', (await ev(`window.api.loadChat('fork-fixture')`)).snapshot.generations[0].jobIds[0] === 'fixture-job')
  check('native restart preserves disabled MCP state', (await ev(`window.api.mcp.list(${JSON.stringify(fixture)})`)).some(row => row.name === 'fork-ui-probe' && !row.enabled))
  check('renderer has no uncaught exceptions', errors.length === 0)
  json(path.join(home, 'results.json'), { passed: checks, version: '3.2.5', exe, home, realCredentials: false, generatedAssets: 0, errors })
  console.log(JSON.stringify({ passed: checks, home }))
} catch (error) {
  if(cdp) {
    try { fs.writeFileSync(path.join(home, 'failure.png'), Buffer.from((await cdp.send('Page.captureScreenshot', {format:'png'})).data,'base64')); console.log(await ev(`document.body.innerText.slice(-3000)`)); } catch {}
  }
  console.log(home); throw error
} finally { stop() }
