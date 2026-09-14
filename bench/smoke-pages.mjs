#!/usr/bin/env node
/* ★3.3 페이지 [1][2] 스모크 — 격리 홈(2.6.2 픽스처 → v3 이관)으로 debug/release exe를 띄워
 * 페이지 전환·페이지별 다이얼·번호·Ctrl+Tab·n1 크롬·저장본(boards/*.json)을 실측한다.
 *   node bench/smoke-pages.mjs [--exe=path]   (기본: target/debug/agentcodegui.exe, 없으면 release) */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe } from './lib.mjs'
import { makeMultiFixture } from './fixture.mjs'

const arg = (process.argv.find((a) => a.startsWith('--exe=')) ?? '').split('=').slice(1).join('=')
const dbg = path.join(REPO, 'target', 'debug', 'agentcodegui.exe')
const EXE = arg ? path.resolve(arg) : fs.existsSync(dbg) ? dbg : resolveTauriExe(null)
const HOME = path.join(REPO, '.bench-home-pages')
const PORT = 9391
const log = (...a) => console.log(...a)

fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, '3.2.5', { panels: 4, itemsPerPanel: 6 })
const child = spawn(EXE, [], {
  env: { ...process.env, CCG_HOME: HOME, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ['ignore', 'pipe', 'pipe']
})
let errs = ''
child.stderr.on('data', (d) => (errs += d.toString()))
const cdp = await connectMainPage(PORT, { timeoutMs: 90_000 })
const fails = []
const check = (name, ok, detail) => { log((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' — ' + detail : '')); if (!ok) fails.push(name) }
try {
  log('exe:', EXE)
  log('url:', await cdp.eval('location.href'))
  for (let i = 0; i < 300; i++) {
    const up = await cdp.eval(`(async()=>{try{return !!(await window.api.app.getVersion())}catch{return false}})()`, { awaitPromise: true }).catch(() => false)
    if (up) break
    await sleep(100)
  }
  await cdp.eval(`(() => {
    window.__dump = () => ({
      pages: [...document.querySelectorAll('.ma-pages .ma-count-btn')].map(b => (b.classList.contains('on') ? b.textContent.trim() + '*' : b.textContent.trim()) + (b.querySelector('.ma-page-dot') ? '(' + b.querySelector('.ma-page-dot').className.replace('ma-page-dot ', '') + ')' : '')),
      dial: [...document.querySelectorAll('.ma-count:not(.ma-pages) .ma-count-btn.on')].map(b => b.dataset.count),
      panels: [...document.querySelectorAll('.ma-grid > .ma-panel')].map(p => p.dataset.slot + ':' + (p.querySelector('.ma-p-num')?.textContent ?? '?')),
      ide: !!document.querySelector('section.multi.ide'),
      head: !!document.querySelector('.ma-head'),
      focused: document.querySelector('.ma-panel.focused')?.dataset.slot ?? null,
      fold: document.querySelector('.ma-fold .cnt')?.textContent ?? null,
      overlays: [...document.querySelectorAll('.pn-overlay, .set-dialog-overlay')].map(e => e.className + ' :: ' + e.textContent.trim().slice(0, 90))
    })
    window.__clearOverlays = () => { let n = 0; for (const e of document.querySelectorAll('.set-dialog-overlay')) { e.remove(); n++ } return n }
    window.__click = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n]; if (!e) return false; e.click(); return true }
    window.__key = (key, o = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...o }))
    return true })()`)
  for (let i = 0; i < 300; i++) { const d = await cdp.eval('__dump()'); if (d.pages.length && !d.overlays.length) break; await cdp.eval(`__click('.pn-x')`); await sleep(200) }
  const d0 = await cdp.eval('__dump()')
  log('boot:', JSON.stringify(d0))
  check('legacy fixture lands on page 1 with 4 panels', d0.pages[0] === '1*' && d0.panels.length === 4 && d0.dial[0] === '4', JSON.stringify(d0.panels))

  // 2페이지로
  await cdp.eval(`__click('.ma-pages .ma-count-btn', 1)`)
  await sleep(500)
  let d1 = await cdp.eval('__dump()')
  if (d1.overlays.length) {
    // 격리 홈엔 엔진/계정이 없어 부팅 뒤 게이트가 뜬다 — 키보드 핸들러가 양보하는 게 맞는 동작이므로
    // (환경 요인) 정체만 기록하고 걷어낸 뒤 계속한다
    log('overlay after boot (removed for the run):', JSON.stringify(d1.overlays))
    await sleep(3000)
    await cdp.eval('__clearOverlays()')
    await sleep(300)
    d1 = await cdp.eval('__dump()')
  }
  log('page2:', JSON.stringify(d1))
  check('page 2 shows slots 6.. numbered from 1, count falls back to 4', d1.pages[1] === '2*' && d1.panels.join() === '6:1,7:2,8:3,9:4' && d1.dial[0] === '4')

  // 2페이지 다이얼 6
  await cdp.eval(`__click('.ma-count:not(.ma-pages) .ma-count-btn[data-count="6"]')`)
  await sleep(500)
  const d2 = await cdp.eval('__dump()')
  check('page 2 dial 6 → six panels', d2.panels.length === 6 && d2.dial[0] === '6', JSON.stringify(d2.panels))

  // Ctrl+Tab → 1페이지, 자리 수는 4 그대로
  await cdp.eval(`__key('Tab', { ctrlKey: true })`)
  await sleep(500)
  const d3 = await cdp.eval('__dump()')
  check('Ctrl+Tab back to page 1 keeps its own count', d3.pages[0] === '1*' && d3.panels.length === 4 && d3.dial[0] === '4', JSON.stringify(d3))

  // 1페이지 다이얼 1 → n1(IDE 크롬): 페이지 세그먼트가 패널 헤더(TopBar)에 살아 있어야 한다
  await cdp.eval(`__click('.ma-count:not(.ma-pages) .ma-count-btn[data-count="1"]')`)
  await sleep(600)
  const d4 = await cdp.eval('__dump()')
  check('page 1 dial 1 → IDE chrome with page segment still present', d4.ide && !d4.head && d4.pages.length === 2 && d4.panels.length === 1, JSON.stringify(d4))
  // n1에서 2페이지로 → 2페이지는 6칸 그리드
  await cdp.eval(`__click('.ma-pages .ma-count-btn', 1)`)
  await sleep(600)
  const d5 = await cdp.eval('__dump()')
  check('from IDE page 1 to grid page 2', !d5.ide && d5.head && d5.panels.length === 6 && d5.pages[1] === '2*', JSON.stringify(d5))
  // 2페이지 4번 패널 포커스 → Ctrl+Shift+Tab → 포커스 해제(숨은 패널이 Esc를 쥐지 않게)
  await cdp.eval(`(() => { const ps = document.querySelectorAll('.ma-grid > .ma-panel'); ps[ps.length - 1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })()`)
  await sleep(200)
  const f1 = (await cdp.eval('__dump()')).focused
  await cdp.eval(`__key('Tab', { ctrlKey: true, shiftKey: true })`)
  await sleep(500)
  const d6 = await cdp.eval('__dump()')
  check('focus dropped when leaving the page', f1 != null && Number(f1) >= 6 && d6.focused !== f1 && d6.pages[0] === '1*', `before=${f1} after=${d6.focused}`)
  // 되돌아가 초안 왕복
  await cdp.eval(`__click('.ma-pages .ma-count-btn', 1)`)
  await sleep(400)
  await cdp.eval(`(() => { const ta = document.querySelector('.ma-grid > .ma-panel .composer textarea'); ta.focus(); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(ta, 'draft on page two'); ta.dispatchEvent(new Event('input', { bubbles: true })); return ta.value })()`)
  await sleep(300)
  await cdp.eval(`__key('Tab', { ctrlKey: true })`)
  await sleep(300)
  await cdp.eval(`__key('Tab', { ctrlKey: true })`)
  await sleep(500)
  const draft = await cdp.eval(`document.querySelector('.ma-grid > .ma-panel .composer textarea')?.value ?? null`)
  check('draft survives a page round trip', draft === 'draft on page two', JSON.stringify(draft))

  // 저장본 — boards/<id>.json (600ms 커밋 + 700ms 저장 디바운스)
  await sleep(2500)
  const bdir = path.join(HOME, 'boards')
  const boards = fs.readdirSync(bdir).filter((f) => f.endsWith('.json') && f !== 'index.json').map((f) => JSON.parse(fs.readFileSync(path.join(bdir, f), 'utf8')))
  const b = boards.find((x) => x.id !== 'default')
  log('board:', JSON.stringify({ id: b?.id, count: b?.count, count2: b?.count2, page: b?.page, order: b?.order, slots: b?.slots?.length, promo: b?.promo ?? null }))
  check('board persisted with count=1, count2=6, page=1, 12-slot order', !!b && b.count === 1 && b.count2 === 6 && b.page === 1 && Array.isArray(b.order) && b.order.length === 12 && b.slots.length === 12)
} finally {
  killTree(child.pid)
  if (errs.trim()) log('stderr tail:', errs.trim().split('\n').slice(-5).join('\n'))
}
log(fails.length ? `FAILED: ${fails.join(', ')}` : 'ALL PASS')
process.exit(fails.length ? 1 : 0)
