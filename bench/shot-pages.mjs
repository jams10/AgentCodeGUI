#!/usr/bin/env node
/* 페이지 헤더 스크린샷 — smoke-pages와 같은 격리 부팅, 2페이지 6칸 상태에서 창 전체 + 헤더 크롭을 저장 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from './lib.mjs'
import { makeMultiFixture } from './fixture.mjs'

const dbg = path.join(REPO, 'target', 'debug', 'agentcodegui.exe')
const EXE = fs.existsSync(dbg) ? dbg : resolveTauriExe(null)
const HOME = path.join(REPO, '.bench-home-pages')
const OUT = path.join(process.env.TEMP || REPO, 'shots')
fs.mkdirSync(OUT, { recursive: true })
fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, '3.2.5', { panels: 4, itemsPerPanel: 6 })
const child = spawn(EXE, [], { env: { ...process.env, CCG_HOME: HOME, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9392' }, stdio: 'ignore' })
const cdp = await connectMainPage(9392, { timeoutMs: 90_000 })
try {
  for (let i = 0; i < 300; i++) {
    const up = await cdp.eval(`(async()=>{try{return !!(await window.api.app.getVersion())}catch{return false}})()`, { awaitPromise: true }).catch(() => false)
    if (up) break
    await sleep(100)
  }
  for (let i = 0; i < 100; i++) { if (await cdp.eval(`document.querySelectorAll('.ma-pages .ma-count-btn').length === 2`)) break; await sleep(200) }
  await sleep(4000)
  await cdp.eval(`(() => { for (const e of document.querySelectorAll('.set-dialog-overlay, .pn-overlay')) e.remove(); document.querySelectorAll('.ma-pages .ma-count-btn')[1].click() })()`)
  await sleep(500)
  await cdp.eval(`document.querySelector('.ma-count:not(.ma-pages) .ma-count-btn[data-count="6"]').click()`)
  await sleep(800)
  const shot = async (name, clip) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) })
    const f = path.join(OUT, name + '.png')
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'))
    console.log('shot', f)
  }
  const vw = await cdp.eval('({ w: innerWidth, h: innerHeight })')
  await shot('tauri-page2-full')
  await shot('tauri-page2-header', { x: Math.max(0, vw.w - 520), y: 0, width: 520, height: 40 })
} finally {
  killTree(child.pid)
}
