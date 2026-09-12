// Hidden Electron window using production WorkBar, Markdown and preload.
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
const root = path.resolve(import.meta.dirname, '..'), dir = path.join(root, '.dev-home/work-records-verification')
const records = JSON.parse(fs.readFileSync(path.join(dir, 'records.json'), 'utf8'))
const page = `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/renderer/src/styles.css'))}"><style>body{background:#101010;padding:24px;overflow:auto}#root{width:100%;height:100%;display:flex;flex-direction:column}.content{flex:1;overflow:auto}.workbar-wrap{flex:none}</style></head><body><div id="root"></div><script type="module" src="./ui.js"></script></body></html>`
fs.writeFileSync(path.join(dir, 'ui.html'), page)
await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {WorkBar} from './src/renderer/src/components/Chat'; import {Markdown} from './src/renderer/src/components/Markdown';
const cwd=${JSON.stringify(root)}; const records=${JSON.stringify(records)};
createRoot(document.getElementById('root')).render(<><div className="content"><Markdown cwd={cwd} text={'작업 폴더: '+String.fromCharCode(96)+cwd+String.fromCharCode(96)}/></div><WorkBar cwd={cwd} generations={records} workFolders={[cwd]} files={[]} todos={[]} subagents={[]} usage={{fiveHour:null,weekly:null,weeklyFable:null,extraCredit:null}} contextTokens={2000} contextWindow={200000} model="sonnet" onOpenFile={()=>{}} onOpenSubagent={()=>{}} /></>);`, resolveDir: root, loader: 'tsx' },
  bundle: true, format: 'esm', platform: 'browser', outfile: path.join(dir, 'ui.js'), alias: { '@shared': path.join(root, 'src/shared') }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.glob': '__fixtureGlob' }, banner: { js: 'const __fixtureGlob=()=>({});' }, jsx: 'automatic' })
await build({ entryPoints: ['src/main/workPaths.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(dir, 'paths.cjs') })
const main = `const {app,BrowserWindow,ipcMain}=require('electron'); const fs=require('node:fs'); const path=require('node:path'); const assert=require('node:assert/strict');
const dir=${JSON.stringify(dir)},root=${JSON.stringify(root)};
app.setPath('userData',path.join(dir,'ui-userdata'));
const balances=JSON.parse(fs.readFileSync(path.join(root,'.dev-home/credit-verification/live-results.json'),'utf8')).values;
let calls=[],creditCalls=0; const {inspectWorkPaths}=require(path.join(dir,'paths.cjs'));
ipcMain.handle('work:inspect-paths',(_e,a)=>inspectWorkPaths(a.cwd,a.paths));
ipcMain.handle('work:open-folder',async(_e,a)=>{const [p]=await inspectWorkPaths(a.cwd,[a.path]);assert(p);calls.push(p.folder);});
ipcMain.handle('credits:get',(_e,a)=>{creditCalls++; return balances.find(b=>b.service===a.service)});
app.whenReady().then(async()=>{let win;try{
 win=new BrowserWindow({width:900,height:850,show:false,webPreferences:{preload:path.join(root,'out/preload/index.mjs'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{if(event.level==='error'||event.level===3)console.error(event.message)});
 win.webContents.on('preload-error',(_e,_p,error)=>console.error(error));
 const js=s=>win.webContents.executeJavaScript(s); const wait=async(s)=>{for(let i=0;i<100;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,50));}throw Error('UI timed out: '+s)};
 await win.loadFile(path.join(dir,'ui.html')); await wait('!!document.querySelector(".work-path-link")');
 await js('document.querySelector(".work-path-link").click()'); await wait('true'); await new Promise(r=>setTimeout(r,100)); assert.deepEqual(calls,[root]);
 await js('document.querySelector(".work-history-toggle").click()'); await wait('!!document.querySelector(".wh-folder")');
 assert.equal(await js('document.querySelectorAll(".wh-record").length'),4);
 await js('document.querySelector(".wh-folder").click()'); await new Promise(r=>setTimeout(r,100)); assert.equal(calls.length,2);
 await js('document.querySelector(".wh-search").value=""; document.querySelector(".wh-record:last-child").open=true');
 assert((await js('document.querySelector(".wh-panel").textContent')).includes('A small red robot'));
 win.setSize(901,851); await new Promise(r=>setTimeout(r,100)); win.setSize(900,850); await new Promise(r=>setTimeout(r,100));
 fs.writeFileSync(path.join(dir,'work-history-wide.png'),(await win.webContents.capturePage()).toPNG());
 win.setSize(390,740); await new Promise(r=>setTimeout(r,150));
 assert(await js('document.querySelector(".wh-panel").getBoundingClientRect().right <= innerWidth'));
 assert(await js('document.querySelector(".wh-body").scrollWidth <= document.querySelector(".wh-body").clientWidth+1'));
 fs.writeFileSync(path.join(dir,'work-history-narrow.png'),(await win.webContents.capturePage()).toPNG());
 await js('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))'); await wait('!document.querySelector(".wh-panel")');
 assert(await js('document.activeElement === document.querySelector(".work-history-toggle")'));
 win.setSize(900,850); await js('[...document.querySelectorAll(".wb-chip")].find(x=>x.textContent.includes("컨텍스트")).click()');
 await wait('document.querySelector("[data-testid=credits-comfy-cloud] strong")?.textContent==="74,502"');
 assert.equal(await js('document.querySelector("[data-testid=credits-tripo] strong").textContent'),'24,870');
 await js('document.querySelector("[data-testid=credits-comfy-cloud] button").click()'); await new Promise(r=>setTimeout(r,100)); assert(creditCalls>=3);
 fs.writeFileSync(path.join(dir,'service-credits.png'),(await win.webContents.capturePage()).toPNG());
 fs.writeFileSync(path.join(dir,'ui-results.json'),JSON.stringify({folderClicks:calls.length,creditCalls,comfy:74502,tripo:24870,narrowWidth:390,visibleWindows:0,paidRequests:0},null,2));
 console.log('UI verified: folder clicks, saved records, prompt details, narrow layout, Escape/focus, 74,502 / 24,870 credits, refresh'); app.exit(0);
}catch(e){console.error(e);app.exit(1)}});`
fs.writeFileSync(path.join(dir, 'ui-main.cjs'), main)
const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(dir, 'ui-main.cjs')], { windowsHide: true, stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 1))
