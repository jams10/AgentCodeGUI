#!/usr/bin/env node
/* 12패널(2페이지×6) 동시 스트리밍 부하 — 가짜 CLI(ccg-fakecli)로 12턴을 동시에 돌리며
 * 렌더러 프레임 작업시간(ftgauge)·롱태스크·페이지 전환 지연·입력 지연·프로세스 메모리를 잰다.
 *   node bench/load-pages.mjs [--tag=NAME] [--secs=15] [--hz=25] [--exe=PATH]
 * 결과: bench/results/load-pages-<tag>.json  (전/후 비교용) */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { connectMainPage, killTree, sleep, REPO, resolveTauriExe, procTreeMem } from './lib.mjs'
import { makeMultiFixture } from './fixture.mjs'
import { COLLECT, HARVEST, cpuMark, cpuSince } from './ftgauge.mjs'

const argv = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) ?? `--${k}=${d}`).split('=').slice(1).join('=')
const TAG = argv('tag', 'run')
const SECS = Number(argv('secs', 15))
const HZ = Number(argv('hz', 25))
const exeArg = argv('exe', '')
const dbg = path.join(REPO, 'target', 'debug', 'agentcodegui.exe')
const EXE = exeArg ? path.resolve(exeArg) : fs.existsSync(dbg) ? dbg : resolveTauriExe(null)
const FAKE = fs.existsSync(path.join(REPO, 'target', 'debug', 'ccg-fakecli.exe')) ? path.join(REPO, 'target', 'debug', 'ccg-fakecli.exe') : path.join(REPO, 'target', 'release', 'ccg-fakecli.exe')
const HOME = path.join(REPO, '.bench-home-load')
const PORT = 9393
const log = (...a) => console.log(...a)

// ── 격리 홈: 2.6.2 멀티 픽스처(1페이지 6칸) + 가짜 엔진 ──────────────────────
fs.rmSync(HOME, { recursive: true, force: true })
makeMultiFixture(HOME, '3.2.5', { panels: 6, itemsPerPanel: 4 })
for (const n of ['engines', 'codex-engines']) { try { fs.rmSync(path.join(HOME, n), { recursive: true, force: true }) } catch {} }
const ed = path.join(HOME, 'engines', 'fake', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64')
fs.mkdirSync(ed, { recursive: true })
fs.copyFileSync(FAKE, path.join(ed, 'claude.exe'))
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ activeVersion: 'fake' }))
// 계정 스토어는 version 3이어야 등록으로 읽힌다(ccg-auth parse_store) + 폴더 슬러그는 account_slug 규칙
const slugOf = (email) => { const safe = email.toLowerCase().replace(/[^a-z0-9._-]+/g, '_'); let h = 0; for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) >>> 0; return `${safe}-${h.toString(36)}` }
// 가짜 계정의 credEnc — DPAPI 직접 스킴(접두사 없음 = safe_storage의 폴백 갈래). 스냅샷 = { creds: <.credentials.json 문자열>, account }
import { spawnSync as _spawnSync } from 'node:child_process'
const dpapiB64 = (plain) => {
  const b64 = Buffer.from(plain, 'utf8').toString('base64')
  const ps = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${b64}'); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))`
  const r = _spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error('dpapi: ' + r.stderr)
  return r.stdout.trim()
}
const fakeCredEnc = (email) => {
  const creds = JSON.stringify({ claudeAiOauth: { accessToken: 'A-' + email, refreshToken: 'R-' + email, expiresAt: Date.now() + 86400000 * 30, scopes: ['user:inference'], subscriptionType: 'max' } })
  return dpapiB64(JSON.stringify({ creds, account: { emailAddress: email, uuid: 'u-' + email } }))
}
fs.writeFileSync(path.join(HOME, 'accounts.json'), JSON.stringify({ version: 3, defaultEmail: 'f@e.com', accounts: [{ email: 'f@e.com', credEnc: fakeCredEnc('f@e.com'), subscriptionType: 'max' }] }))
fs.mkdirSync(path.join(HOME, 'accounts', slugOf('f@e.com')), { recursive: true })
const WORK = path.join(HOME, 'work')
fs.mkdirSync(WORK, { recursive: true })

// ── 가짜 CLI 대본: init → 텍스트 델타 HZ/s × SECS+5s → 최종 assistant → result ─
const words = ['const', 'value', '=', 'await', 'fetch(url)', '**bold**', '`code`', '\n', '- item', '함수를', '고쳤습니다.', '\n\n## 단계', '테스트', '추가', '완료', '\n```ts\nlet x = 1\n```\n']
const lines = [
  { afterMs: 50, emit: { type: 'control_response', response: { subtype: 'success', request_id: 'init-1', response: {} } } },
  { emit: { type: 'system', subtype: 'init', session_id: 'N1', model: 'claude-haiku', cwd: WORK, tools: [], apiKeySource: 'none' } },
  { afterMs: 80, emit: { type: 'stream_event', session_id: 'N1', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } } }
]
let full = ''
const nDelta = Math.round(HZ * (SECS + 5))
for (let i = 0; i < nDelta; i++) {
  const t = words[i % words.length] + ' '
  full += t
  lines.push({ afterMs: Math.round(1000 / HZ), emit: { type: 'stream_event', session_id: 'N1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } } })
}
lines.push({ emit: { type: 'assistant', session_id: 'N1', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: full }], usage: { input_tokens: 3 } } } })
lines.push({ emit: { type: 'result', subtype: 'success', is_error: false, result: full, session_id: 'N1', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } })
const SCRIPT = path.join(HOME, 'stream.jsonl')
fs.writeFileSync(SCRIPT, lines.map((x) => JSON.stringify(x)).join('\n') + '\n')

const child = spawn(EXE, [], {
  env: { ...process.env, CCG_HOME: HOME, CCG_FAKECLI_SCRIPT: SCRIPT, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ['ignore', 'pipe', 'pipe']
})
let errs = ''
child.stderr.on('data', (d) => (errs += d.toString()))
const cdp = await connectMainPage(PORT, { timeoutMs: 90_000 })
const out = { at: new Date().toISOString(), tag: TAG, exe: EXE, secs: SECS, hz: HZ }
try {
  for (let i = 0; i < 300; i++) {
    const up = await cdp.eval(`(async()=>{try{return !!(await window.api.app.getVersion())}catch{return false}})()`, { awaitPromise: true }).catch(() => false)
    if (up) break
    await sleep(100)
  }
  await cdp.eval(`(() => {
    window.__dump = () => ({
      page: document.querySelector('.ma-pages .ma-count-btn.on')?.textContent ?? null,
      panels: document.querySelectorAll('.ma-grid > .ma-panel').length,
      busy: [...document.querySelectorAll('.ma-grid > .ma-panel .ma-status')].filter(e => /작업|분석|Working|Analyzing/.test(e.textContent)).length,
      dots: [...document.querySelectorAll('.ma-page-dot')].map(e => e.className),
      overlays: document.querySelectorAll('.set-dialog-overlay, .pn-overlay').length
    })
    window.__clear = () => { for (const e of document.querySelectorAll('.set-dialog-overlay, .pn-overlay')) e.remove() }
    window.__click = (sel, n = 0) => { const e = document.querySelectorAll(sel)[n]; if (!e) return false; e.click(); return true }
    window.__sendAll = (text) => { let n = 0; for (const p of document.querySelectorAll('.ma-grid > .ma-panel')) { const ta = p.querySelector('.composer textarea'); if (!ta) continue
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, text); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus()
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); n++ } return n }
    window.__switch = async (idx) => { const btn = document.querySelectorAll('.ma-pages .ma-count-btn')[idx]; const want = idx === 0 ? '0' : '6'
      const t0 = performance.now(); btn.click()
      await new Promise((res) => { const c = () => { if (document.querySelector('.ma-grid > .ma-panel[data-slot="' + want + '"]')) res(); else requestAnimationFrame(c) }; c() })
      const tDom = performance.now(); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return { dom: Math.round(tDom - t0), painted: Math.round(performance.now() - t0) } }
    window.__type = async (ch) => { const ta = document.querySelector('.ma-grid > .ma-panel .composer textarea'); ta.focus()
      const t0 = performance.now(); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, ta.value + ch); ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return Math.round((performance.now() - t0) * 10) / 10 }
    return true })()`)
  for (let i = 0; i < 200; i++) { const d = await cdp.eval('__dump()'); if (d.page && d.panels === 6) break; await sleep(200) }
  await sleep(3000)
  await cdp.eval('__clear()')
  log('boot:', JSON.stringify(await cdp.eval('__dump()')))

  // 12턴 발사: 1페이지 6 → 2페이지(다이얼 6) 6 → 1페이지로 복귀
  const s1 = await cdp.eval(`__sendAll('go')`)
  await cdp.eval(`__click('.ma-pages .ma-count-btn', 1)`); await sleep(500)
  await cdp.eval(`__click('.ma-count:not(.ma-pages) .ma-count-btn[data-count="6"]')`); await sleep(500)
  const s2 = await cdp.eval(`__sendAll('go')`)
  await sleep(300)
  await cdp.eval(`__click('.ma-pages .ma-count-btn', 0)`); await sleep(500)
  log('sent:', s1, '+', s2)
  for (let i = 0; i < 100; i++) { const d = await cdp.eval('__dump()'); if (d.busy >= 6) break; await sleep(100) }
  await sleep(1500)
  log('streaming:', JSON.stringify(await cdp.eval('__dump()')))

  // 측정 창 (+ --profile: V8 CPU 프로파일을 같이 떠서 self-time 상위 함수를 요약)
  const PROFILE = process.argv.includes('--profile')
  if (PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start') }
  const cpu0 = cpuMark()
  await cdp.eval(COLLECT)
  const t0 = Date.now()
  const switches = []
  const types = []
  while (Date.now() - t0 < SECS * 1000) {
    await sleep(2500)
    switches.push(await cdp.eval('__switch(1)', { awaitPromise: true }))
    await sleep(800)
    switches.push(await cdp.eval('__switch(0)', { awaitPromise: true }))
    await sleep(400)
    for (const ch of 'abc') types.push(await cdp.eval(`__type(${JSON.stringify(ch)})`, { awaitPromise: true }))
  }
  const ft = await cdp.eval(HARVEST)
  // --shot: 측정 창 **뒤**(아직 스트리밍 중) 창 전체 스크린샷 — 캡처 비용이 측정에 안 섞이게(머리/꼬리 분할 렌더의 시각 확인용)
  if (process.argv.includes('--shot')) {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const f = path.join(process.env.TEMP || REPO, 'shots', `load-${TAG}-streaming.png`)
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); log('shot', f)
  }
  if (PROFILE) {
    const { profile } = await cdp.send('Profiler.stop')
    fs.writeFileSync(path.join(REPO, 'bench', 'results', `load-pages-${TAG}.cpuprofile`), JSON.stringify(profile))
    // self time per (function, url:line) — 샘플 간격 합산
    const byId = new Map(profile.nodes.map((n) => [n.id, n]))
    const self = new Map()
    const dt = profile.timeDeltas
    for (let i = 0; i < profile.samples.length; i++) {
      const n = byId.get(profile.samples[i]); if (!n) continue
      const cf = n.callFrame
      const key = (cf.functionName || '(anon)') + ' @ ' + (cf.url ? cf.url.split('/').pop() : '') + ':' + cf.lineNumber
      self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0))
    }
    const total = [...self.values()].reduce((a, c) => a + c, 0)
    out.profileTop = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, v]) => ({ fn: k, ms: Math.round(v / 1000), pct: Math.round(v / total * 1000) / 10 }))
    out.profileTotalMs = Math.round(total / 1000)
    // 카테고리 합 — (idle/program/gc는 V8 메타 노드)
    const cat = {}
    for (const [k, v] of self) { const c = k.startsWith('(idle)') ? 'idle' : k.startsWith('(program)') ? 'program' : k.startsWith('(garbage') ? 'gc' : 'js'; cat[c] = (cat[c] ?? 0) + v }
    out.profileCat = Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, Math.round(v / 1000)]))
  }
  out.cpuPct = cpuSince(cpu0)
  out.frames = ft
  out.switchMs = switches
  out.typeMs = types
  out.heapMB = await cdp.eval('performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null')
  out.mem = procTreeMem(child.pid)
  log('during:', JSON.stringify(await cdp.eval('__dump()')))
  // 끝까지 기다렸다가 완료 확인
  for (let i = 0; i < 400; i++) { const d = await cdp.eval('__dump()'); if (d.busy === 0) break; await sleep(250) }
  // 숨은 페이지(2페이지)의 실행이 다 끝나면 페이지 점도 꺼져야 한다 — 최대 40s
  const tDot = Date.now()
  for (let i = 0; i < 160; i++) { const d = await cdp.eval('__dump()'); if (!d.dots.length) break; await sleep(250) }
  out.after = { ...(await cdp.eval('__dump()')), dotClearedMs: Date.now() - tDot }
  if (process.argv.includes('--shot')) {
    await sleep(1500)
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const f = path.join(process.env.TEMP || REPO, 'shots', `load-${TAG}-done.png`)
    fs.writeFileSync(f, Buffer.from(r.data, 'base64')); log('shot', f)
  }
} finally {
  killTree(child.pid)
  if (errs.trim()) log('stderr tail:', errs.trim().split('\n').slice(-4).join('\n'))
}
const f = path.join(REPO, 'bench', 'results', `load-pages-${TAG}.json`)
fs.writeFileSync(f, JSON.stringify(out, null, 1))
const fr = out.frames ?? {}
log(`\n== ${TAG} ==`)
log(`frame work p50/p95/p99/max: ${fr.workP50}/${fr.workP95}/${fr.workP99}/${fr.workMax} ms  over16.6: ${fr.over166Pct}%  over33: ${fr.over33Pct}%  longTask: ${fr.longTaskMs} ms  fps: ${fr.avgFps}  dropped: ${fr.droppedPct}%`)
log(`page switch (dom/painted ms): ${JSON.stringify(out.switchMs)}`)
log(`typing latency ms: ${JSON.stringify(out.typeMs)}`)
log(`cpu(machine)%: ${out.cpuPct}  heapMB: ${out.heapMB}  tree WS MB: ${out.mem?.totalWsMB} priv MB: ${out.mem?.totalPrivMB}`)
log(`after: ${JSON.stringify(out.after)}`)
if (out.profileTop) { log('profile cat ms:', JSON.stringify(out.profileCat)); for (const r of out.profileTop.slice(0, 30)) log(`  ${String(r.pct).padStart(5)}%  ${String(r.ms).padStart(6)}ms  ${r.fn}`) }
log('saved:', f)
