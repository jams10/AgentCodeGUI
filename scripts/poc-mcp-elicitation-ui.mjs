// Production question card, reducer, preload and adapter; isolated hidden Electron.
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
const root = path.resolve(import.meta.dirname, '..')
const dir = path.join(root, '.dev-home/mcp-elicitation-verification')
fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(dir, 'ui.html'), `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/renderer/src/styles.css'))}"></head><body><div id="root"></div><script type="module" src="./ui.js"></script></body></html>`)
await build({ stdin: { contents: `import React,{useReducer,useEffect} from 'react';import {createRoot} from 'react-dom/client';import {QuestionModal} from './src/renderer/src/components/Chat';import {reducer,initialSessionState} from './src/renderer/src/store/session';
function Fixture(){const [state,dispatch]=useReducer(reducer,{...initialSessionState,curRunId:'fixture-run'});useEffect(()=>{window.__fixtureReady=true;return window.api.onEngineEvent(event=>dispatch({type:'engine',event}));},[]);return <QuestionModal question={state.pendingQuestion} onAnswer={answers=>{window.api.respondQuestion({requestId:state.pendingQuestion.requestId,answers});dispatch({type:'answer-question',answers});}} onDismiss={()=>{window.api.respondQuestion({requestId:state.pendingQuestion.requestId,answers:null});dispatch({type:'clear-question'});}}/>;}createRoot(document.getElementById('root')).render(<Fixture/>);`, resolveDir: root, loader: 'tsx' }, bundle: true, format: 'esm', platform: 'browser', outfile: path.join(dir, 'ui.js'), alias: { '@shared': path.join(root, 'src/shared') }, define: { 'process.env.NODE_ENV': '"production"', 'import.meta.glob': '__fixtureGlob' }, banner: { js: 'const __fixtureGlob=()=>({});' }, jsx: 'automatic', logLevel: 'silent' })
const main = `const {app,BrowserWindow,ipcMain}=require('electron');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const dir=${JSON.stringify(dir)},root=${JSON.stringify(root)};app.setPath('userData',path.join(dir,'ui-userdata'));
app.whenReady().then(async()=>{try{
 const {CodexEngine}=await import(${JSON.stringify(pathToFileURL(path.join(dir,'adapter.mjs')).href)});
 const win=new BrowserWindow({width:900,height:800,show:false,webPreferences:{preload:path.join(root,'out/preload/index.mjs'),contextIsolation:true,sandbox:false,backgroundThrottling:false}});
 const replies=[],errors=[];const engine=new CodexEngine(e=>win.webContents.send('engine:event',e));engine.activeRunId='fixture-run';engine.activeThreadId='fixture-thread';engine.respondRpc=(id,result)=>replies.push({id,result});engine.respondRpcError=(id,message)=>errors.push({id,message});
 ipcMain.handle('claude:question-respond',(_e,res)=>engine.respondQuestion(res));
 const js=s=>win.webContents.executeJavaScript(s);const wait=async(s)=>{for(let i=0;i<100;i++){if(await js(s))return;await new Promise(r=>setTimeout(r,50));}throw Error('UI timed out: '+s)};
 await win.loadFile(path.join(dir,'ui.html'));await wait('window.__fixtureReady===true');
 const params={threadId:'fixture-thread',serverName:'comfy-cloud-fixture',mode:'form',message:'Generate 3 fixture images? Credits: 0.',requestedSchema:{type:'object',properties:{confirm:{type:'boolean',default:true}},required:['confirm']}};
 engine.onServerRequest(200,'mcpServer/elicitation/request',params);engine.onServerRequest(201,'mcpServer/elicitation/request',params);
 await wait('!!document.querySelector("[role=dialog]")');assert.equal(replies.length,0);assert.equal(await js('document.querySelectorAll(".qopt-free").length'),0);assert((await js('document.querySelector(".qhl").textContent')).includes('comfy-cloud-fixture'));
 win.setSize(901,801);await new Promise(r=>setTimeout(r,150));win.setSize(900,800);await new Promise(r=>setTimeout(r,150));
 fs.writeFileSync(path.join(dir,'approval-card.png'),(await win.webContents.capturePage()).toPNG());
 const click=async index=>{const p=await js('(()=>{const e=document.querySelectorAll("button.qopt")['+index+'];const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,hit:e.contains(document.elementFromPoint(x,y))};})()');assert(p.hit);win.webContents.sendInputEvent({type:'mouseDown',x:Math.round(p.x),y:Math.round(p.y),button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:Math.round(p.x),y:Math.round(p.y),button:'left',clickCount:1});};
 await click(0);await new Promise(r=>setTimeout(r,200));assert.deepEqual(replies[0],{id:200,result:{action:'accept',content:{confirm:true}}});
 await wait('!!document.querySelector("[role=dialog]")');await click(1);await new Promise(r=>setTimeout(r,200));assert.deepEqual(replies[1],{id:201,result:{action:'accept',content:{confirm:false}}});await wait('!document.querySelector("[role=dialog]")');
 engine.onServerRequest(202,'mcpServer/elicitation/request',params);await wait('!!document.querySelector("[role=dialog]")');await js('document.querySelector(".qmin").click()');await wait('!!document.querySelector(".q-mini")');assert.equal(replies.length,2);await js('document.querySelector(".qmx").click()');await new Promise(r=>setTimeout(r,150));assert.deepEqual(replies[2],{id:202,result:{action:'cancel',content:null}});
 engine.onServerRequest(203,'mcpServer/elicitation/request',params);await wait('!!document.querySelector("[role=dialog]")');engine.onNotification('serverRequest/resolved',{threadId:'fixture-thread',requestId:203});await wait('!document.querySelector("[role=dialog]")');assert.equal(replies.length,3);assert.equal(errors.length,0);
 fs.writeFileSync(path.join(dir,'ui-results.json'),JSON.stringify({visibleWindows:0,paidRequests:0,realPreload:true,realReducer:true,pointerApprove:true,pointerDecline:true,cancel:true,queue:true,noDefaultConsent:true,expiredDialogRemoved:true},null,2));console.log('UI passed: native pointer approve/decline, queued forms, cancel, expiry, no default consent');app.exit(0);
 }catch(error){console.error(error);app.exit(1)}});`
fs.writeFileSync(path.join(dir, 'ui-main.cjs'), main)
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(dir, 'ui-main.cjs')], { env, windowsHide: true, stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 1))
