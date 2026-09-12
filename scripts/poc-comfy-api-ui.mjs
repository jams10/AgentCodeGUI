// Hidden, isolated built Electron app. Real renderer/preload/IPC/Windows DPAPI.
// Provider responses are fixtures; no actual service call or user vault access.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
const root = path.resolve(import.meta.dirname, '..')
const dir = path.join(root, '.dev-home/comfy-api-verification')
const home = fs.mkdtempSync(path.join(dir, 'ui-'))
const key = 'comfyui-ui-fixture-1859'
const bootstrap = path.join(home, 'bootstrap.cjs')
const oldPreload = path.join(home, 'old-preload.mjs')
const preloadText = fs.readFileSync(path.join(root,'out/preload/index.mjs'),'utf8')
assert(preloadText.includes('  comfy: {'))
fs.writeFileSync(oldPreload,preloadText.replace(/  comfy: \{[\s\S]*?\n  \},\n(?=  tripo:)/,''))
const req = createRequire(path.join(root, 'package.json'))
const electron = req('electron')
fs.writeFileSync(bootstrap, `
const {BrowserWindow}=require('electron');
setInterval(()=>{if(require('node:fs').existsSync(process.env.CCG_TEST_QUIT_FILE))require('electron').app.quit()},100);
BrowserWindow.prototype.show=function(){}; BrowserWindow.prototype.showInactive=function(){}; BrowserWindow.prototype.focus=function(){};
global.fetch=async(url,opts={})=>{
 if(!String(url).startsWith('https://cloud.comfy.org/')) throw new Error('Offline UI fixture');
 if(opts.headers?.['X-API-Key']!==${JSON.stringify(key)}) return new Response(null,{status:401});
 if(String(url).endsWith('/mcp')) {
  const r=JSON.parse(opts.body); if(!r.id)return new Response(null,{status:202});
  if(!['initialize','tools/list'].includes(r.method)) throw new Error('Unexpected provider mutation');
  const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion}: {tools:[{name:'get_catalog_overview'},{name:'get_job_status'}]};
  return new Response(JSON.stringify({jsonrpc:'2.0',id:r.id,result}),{headers:{'Content-Type':'application/json'}});
 }
 const value=String(url).endsWith('/balance')?{effective_balance_micros:35308.8688168805}:String(url).endsWith('/status')?{subscription_status:'active',subscription_tier:'CREATOR'}:{name:'Fixture workspace'};
 return new Response(JSON.stringify(value));
};
const original=${JSON.stringify(path.join(root,'out/main/index.js'))};
if(process.env.CCG_TEST_OLD_PRELOAD==='1') {
 const Module=require('node:module'),fs=require('node:fs'),path=require('node:path');
 const patched=fs.readFileSync(original,'utf8').replace(/path\\.join\\(__dirname(?:\\$\\d+)?, "\\.\\.\\/preload\\/index\\.mjs"\\)/g,()=>JSON.stringify(${JSON.stringify(oldPreload)}));
 const mod=new Module(original,module);mod.filename=original;mod.paths=Module._nodeModulePaths(path.dirname(original));mod._compile(patched,original);
} else require(original);
`)
async function launch(round) {
  const port = 9347 + round
  const stopFile=path.join(home,'quit-'+round)
  const env = {...process.env,CCG_HOME:home,CCG_TEST_QUIT_FILE:stopFile,CCG_TEST_OLD_PRELOAD:round===-1?'1':'0'}; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = spawn(electron,[bootstrap,`--remote-debugging-port=${port}`],{cwd:root,env,windowsHide:true,stdio:['pipe','ignore','ignore']})
  let ws
  try {
    let target
    for(let n=0;n<100;n++) {
      try { target=(await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t=>t.type==='page'&&!/toast|tray|devtools/.test(t.url)); if(target)break }catch{}
      if(child.exitCode!==null)throw new Error('Isolated Electron exited')
      await new Promise(r=>setTimeout(r,100))
    }
    if(!target)throw new Error('Isolated UI unavailable')
    ws=new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject})
    let seq=0;const pending=new Map()
    ws.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.reject(new Error('CDP failed')):p.resolve(m.result)}}
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method+' round '+round))},15000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}))})
    const ev=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description??'UI expression failed');return r.result.value}
    const wait=expression=>ev(`new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(${expression})return resolve(true);if(Date.now()-start>9000)return reject(new Error('UI timeout'));setTimeout(poll,80)};poll()})`)
    const click=async(selector,text)=>{
      // Hidden windows can have no OS hit-test surface. Exercise real DOM events
      // and disabled states; this is not a native pointer/layout regression test.
      await ev(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text?`e.textContent.trim()===${JSON.stringify(text)}`:'true'});if(!e||e.disabled)throw new Error('Control unavailable');e.click();return true})()`)
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
    await wait(`document.querySelector('.sb-foot')`)
    await ev(`document.querySelector('.sd-cancel')?.click();document.querySelector('.pn-go')?.click();true`)
    await wait(`!document.querySelector('.sd-cancel')&&!document.querySelector('.pn-go')`)
    await ev(`document.querySelector('.ob-skip')?.click();true`)
    if(!await ev(`!!document.querySelector('.set-ni')`))await click('.sb-foot')
    await wait(`document.querySelector('.set-ni')`);await click('.set-ni','ComfyCloud')
    await wait(`document.querySelector('#comfy-api-key')`)
    if(round===-1 && process.argv.includes('--reproduce-old-input')) {
      const state=await ev(`({bridgeReady:!!window.api.comfy,disabled:document.querySelector('#comfy-api-key').disabled})`)
      assert.equal(state.bridgeReady,false);assert.equal(state.disabled,true)
      console.log('reproduced old preload input lock: '+JSON.stringify(state))
      fs.writeFileSync(path.join(dir,'old-input-reproduction.json'),JSON.stringify(state,null,2))
      return
    }
    const typeKey=async()=>{
      const p=await ev(`(()=>{const e=document.querySelector('#comfy-api-key');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:document.elementFromPoint(x,y)===e,disabled:e.disabled}})()`)
      assert(p.hit&&!p.disabled,'Input must be enabled and receive the pointer')
      await send('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1})
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.x,y:p.y,button:'left',clickCount:1})
      assert.equal(await ev(`document.activeElement?.id`),'comfy-api-key')
      await send('Input.insertText',{text:key})
      assert.equal(await ev(`document.querySelector('#comfy-api-key').value`),key)
    }
    if(round===-1) {
      assert.equal(await ev(`!!window.api.comfy`),false)
      await typeKey()
      await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
      await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13})
      await wait(`document.querySelector('[role="alert"]')?.textContent.includes('트레이')`)
      assert.equal(fs.existsSync(path.join(home,'secrets.json')),false)
      console.log('ok old preload: pointer focus and typing; clear restart message; no false save')
      return
    }
    if(round===0) {
      await typeKey()
      console.log('ok current preload: pointer focus and text entry')
      await wait(`[...document.querySelectorAll('[data-testid="comfy-settings"] button')].some(e=>e.textContent==='키 저장 · 연결 확인'&&!e.disabled)`)
      await click('[data-testid="comfy-settings"] button','키 저장 · 연결 확인')
    } else {
      try { await wait(`document.querySelector('#comfy-api-key')?.placeholder==='••••1859'`) }
      catch { throw new Error('Restart UI state: '+JSON.stringify(await ev(`(async()=>({state:await window.api.comfy.status(),placeholder:document.querySelector('#comfy-api-key')?.placeholder,text:document.querySelector('[data-testid="comfy-settings"]')?.textContent}))()`))) }
      await click('[data-testid="comfy-settings"] button','저장한 키 연결 확인')
    }
    await wait(`document.querySelector('[data-testid="comfy-check"]')?.textContent.includes('74,502')`)
    console.log('ok provider check round '+round)
    const state=await ev('window.api.comfy.status()')
    assert(state.enabled&&state.registered&&state.keySaved);assert(!JSON.stringify(state).includes(key))
    assert.equal(await ev(`document.querySelector('#comfy-api-key').value`),'')
    const vault=fs.readFileSync(path.join(home,'secrets.json'),'utf8')
    assert(JSON.parse(vault).items.find(i=>i.name==='COMFY_API_KEY').enc);assert(!vault.includes(key))
    assert(!fs.readFileSync(path.join(home,'mcp.json'),'utf8').includes(key))
    // Hidden Chromium can stall screenshot capture after pointer focus. Image
    // capture is separate from this input/IPC/persistence regression check.
    await click('.set-ni','MCP');await wait(`[...document.querySelectorAll('.sc2.row2.mcp .emt')].some(e=>e.textContent==='comfy-cloud')`)
    assert.equal(await ev(`(async()=>(await window.api.mcp.list('')).find(s=>s.name==='comfy-cloud'&&s.origin==='app').oauth)()`),null)
    if(round===1)await ev(`window.api.secrets.remove('COMFY_API_KEY')`)
    console.log('ok hidden UI round '+round+': saved key, tools, credits, no OAuth badge')
  } finally {
    ws?.close()
    // A normal app quit flushes Chromium's encryption-key Local State. SIGKILL
    // of a brand-new test profile before that flush is not a normal restart.
    await new Promise((resolve,reject)=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill();reject(new Error('Graceful test quit timed out'))},8000);child.once('exit',()=>{clearTimeout(timer);resolve()});fs.writeFileSync(stopFile,'quit')})
  }
}
await launch(-1)
if(!process.argv.includes('--reproduce-old-input')) {
  await launch(0);await launch(1)
  fs.writeFileSync(path.join(dir,'ui-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),restartCycles:2,oldPreloadInput:true,chromiumPointerAndTextInput:true,encryption:'Windows DPAPI',provider:'mocked',realCredentials:false,generatedAssets:0,fakeKeyRemoved:true},null,2))
}
