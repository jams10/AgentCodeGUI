/**
 * PoC — 설정 → MCP / Keys 탭 실앱(격리 홈) CDP 실측.
 *
 * 전제: 격리 인스턴스가 떠 있다 —
 *   CCG_HOME=<repo>/.dev-home electron out/main/index.js --remote-debugging-port=9333
 * 하는 일: 설정 열기 → MCP 탭(플러그인 행 '연결됨'·앱 서버 추가/편집/토글/검증/가져오기/삭제·
 * 프로젝트 허용 토글) → Keys 탭(추가/env 토글/값 변경/예약 이름/삭제) → 스크린샷 → 앱 종료.
 * 디스크(.dev-home/mcp.json·secrets.json)와 화면을 함께 대조한다.
 *
 * 실행: node scripts/poc-mcp-ui-cdp.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const HOME = path.join(root, '.dev-home')
const PORT = 9333
let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail == null ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!cond) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── CDP 연결 ──
let targets = null
for (let i = 0; i < 120 && !targets; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    // 메인 창 — 빌드(file://…/index.html)든 dev 서버(http://localhost:5173/)든, devtools:// 창만 제외
    const page = list.find((t) => t.type === 'page' && !/^devtools:/.test(t.url) && !/toast|tray/.test(t.url))
    if (page) targets = { page, list }
  } catch {
    /* 아직 */
  }
  if (!targets) await sleep(500)
}
if (!targets) {
  console.log('FAIL 앱 CDP 포트에 닿지 못함')
  process.exit(1)
}
const ws = new WebSocket(targets.page.webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.onopen = r
  ws.onerror = j
})
let seq = 0
const pending = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.id && pending.has(d.id)) {
    const { res, rej } = pending.get(d.id)
    pending.delete(d.id)
    d.error ? rej(new Error(d.error.message)) : res(d.result)
  }
}
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq
    pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
  })
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(HOME, name), Buffer.from(r.data, 'base64'))
}

// 페이지 헬퍼 — React 제어 입력은 네이티브 setter + input 이벤트로
await ev(`window.__poc = {
  qa: (s) => [...document.querySelectorAll(s)],
  txt: (s) => [...document.querySelectorAll(s)].map((e) => e.textContent.trim()),
  click: (s, text) => { const el = [...document.querySelectorAll(s)].find((e) => text == null || e.textContent.trim() === text || e.textContent.trim().includes(text)); if (!el) throw new Error('no el ' + s + ' ' + text); el.click(); return true },
  set: (s, v, idx = 0) => { const el = [...document.querySelectorAll(s)][idx]; if (!el) throw new Error('no input ' + s + ' #' + idx); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); return true },
  wait: (fn, ms = 8000) => new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let r = null; try { r = fn() } catch {} if (r) return res(true); if (Date.now() - t0 > ms) return rej(new Error('timeout: ' + fn.toString().slice(0, 80))); setTimeout(tick, 100) }; tick() }),
  rows: () => [...document.querySelectorAll('.set-inner .sc2.row2.mcp')].map((r) => ({ name: r.querySelector('.emt')?.textContent.trim(), badges: [...r.querySelectorAll('.set-badge')].map((b) => b.textContent.trim()), acts: [...r.querySelectorAll('.mcp-acts button')].map((b) => b.textContent.trim()), toggle: !!r.querySelector('.sw2'), on: r.querySelector('.sw2')?.classList.contains('on') ?? null, off: r.classList.contains('off'), na: r.classList.contains('na') })),
  keys: () => [...document.querySelectorAll('.set-inner .sc2.row2')].filter((r) => r.querySelector('.mcp-acts')).map((r) => ({ name: r.querySelector('.emt')?.textContent.trim(), badges: [...r.querySelectorAll('.set-badge')].map((b) => b.textContent.trim()), meta: r.querySelector('.meta')?.textContent.trim(), on: r.querySelector('.sw2')?.classList.contains('on'), disabled: r.querySelector('.sw2')?.disabled }))
}; true`)
const wait = (js, ms) => ev(`__poc.wait(() => (${js}), ${ms ?? 8000})`)
const mcpJson = () => JSON.parse(fs.readFileSync(path.join(HOME, 'mcp.json'), 'utf8'))

// ── 설정 → MCP ──
await wait(`document.querySelector('.sb-foot')`, 30000)
await ev(`__poc.click('.sb-foot')`)
await wait(`document.querySelector('nav.set-nav')`)
await ev(`__poc.click('nav.set-nav button', 'MCP')`)
await wait(`document.querySelector('.set-inner .set-h1')?.textContent === 'MCP'`)
await wait(`!document.querySelector('.set-inner .set-spin') && document.querySelector('.set-inner .sc2')`)
await sleep(300)
let rows = await ev(`__poc.rows()`)
let secs = await ev(`__poc.txt('.set-inner .set-sec')`)
console.log('sections:', secs)
console.log('rows:', rows)
const plug = rows.find((r) => r.name === 'plugin:comfy-cloud:comfy-cloud')
check('M1 플러그인 행 — http · 시작 시 터미널 토큰 가져와 연결됨 · 연결 해제 버튼 · 토글', !!plug && plug.badges.includes('http') && plug.badges.includes('연결됨') && plug.acts.includes('연결 해제') && plug.toggle, plug)
check('M1b 앱 서버 비어 있음 안내', (await ev(`__poc.txt('.set-inner .sc2.hint')`)).some((s) => s.includes('아직 등록한 서버가 없어요')))
await shot('shot-mcp-1.png')

// 서버 추가 (stdio)
await ev(`__poc.click('.set-sec .set-chipbtn', '서버 추가')`)
await wait(`document.querySelector('.sc2.form')`)
await ev(`__poc.set('.sc2.form input.set-input', 'poctest', 0)`)
await ev(`__poc.set('.sc2.form input.set-input', 'npx', 1)`)
await ev(`__poc.set('.sc2.form input.set-input', '-y some-mcp "a b"', 2)`)
await ev(`__poc.set('.sc2.form textarea.set-input', 'API_KEY=\${POC_KEY}', 0)`)
await ev(`__poc.click('.sc2.form .set-acts button', '저장')`)
await wait(`__poc.rows().some((r) => r.name === 'poctest')`)
let j = mcpJson()
check('M2 stdio 서버 추가 → 행 + mcp.json(인자 따옴표 묶음·env 원문)', JSON.stringify(j.servers?.poctest) === JSON.stringify({ type: 'stdio', command: 'npx', args: ['-y', 'some-mcp', 'a b'], env: { API_KEY: '${POC_KEY}' } }), j.servers?.poctest)
rows = await ev(`__poc.rows()`)
const pt = rows.find((r) => r.name === 'poctest')
check('M2b 행 — stdio 배지·oauth 없음·편집/삭제·토글 켬', pt && pt.badges.includes('stdio') && !pt.acts.includes('연결') && pt.acts.includes('편집') && pt.acts.includes('삭제') && pt.on === true, pt)
check('M2c 저장 메시지', (await ev(`__poc.txt('.set-msg')`)).some((s) => s.includes('poctest 저장됨')))

// 편집 → http
await ev(`__poc.click('.sc2.row2.mcp .mcp-acts button', '편집')`)
await wait(`document.querySelector('.sc2.form') && document.querySelector('.sc2.form input.set-input').value === 'poctest'`)
await ev(`__poc.click('.sc2.form .set-chips button', 'http')`)
await ev(`__poc.set('.sc2.form input.set-input', 'https://example.com/mcp', 1)`)
await ev(`__poc.set('.sc2.form textarea.set-input', 'Authorization: Bearer \${POC_KEY}', 0)`)
await ev(`__poc.click('.sc2.form .set-acts button', '저장')`)
await wait(`__poc.rows().some((r) => r.name === 'poctest' && r.badges.includes('http'))`)
j = mcpJson()
check('M3 편집 → http/헤더로 교체', JSON.stringify(j.servers?.poctest) === JSON.stringify({ type: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${POC_KEY}' } }), j.servers?.poctest)
rows = await ev(`__poc.rows()`)
const pt2 = rows.find((r) => r.name === 'poctest')
check('M3b 행 — 로그인 필요 배지 + 연결 버튼', pt2 && pt2.badges.includes('로그인 필요') && pt2.acts.includes('연결'), pt2)

// 토글 끔/켬
await ev(`(() => { const r = __poc.qa('.sc2.row2.mcp').find((x) => x.querySelector('.emt')?.textContent.trim() === 'poctest'); r.querySelector('.sw2').click(); return true })()`)
await wait(`__poc.rows().find((r) => r.name === 'poctest')?.on === false`)
await sleep(200)
check('M4 토글 끔 → mcp.json disabled', mcpJson().disabled?.includes('poctest'))
await ev(`(() => { const r = __poc.qa('.sc2.row2.mcp').find((x) => x.querySelector('.emt')?.textContent.trim() === 'poctest'); r.querySelector('.sw2').click(); return true })()`)
await wait(`__poc.rows().find((r) => r.name === 'poctest')?.on === true`)
await sleep(200)
check('M4b 되켬', !mcpJson().disabled?.includes('poctest'))

// 검증 오류 — 폼 안 메시지
await ev(`__poc.click('.set-sec .set-chipbtn', '서버 추가')`)
await wait(`document.querySelector('.sc2.form')`)
await ev(`__poc.set('.sc2.form input.set-input', 'bad name!', 0)`)
await ev(`__poc.set('.sc2.form input.set-input', 'x', 1)`)
await ev(`__poc.click('.sc2.form .set-acts button', '저장')`)
await wait(`document.querySelector('.sc2.form .set-msg.err')`)
check('M5 이름 검증 오류가 폼 안에 표시', (await ev(`__poc.txt('.sc2.form .set-msg.err')`))[0]?.includes('이름'), await ev(`__poc.txt('.sc2.form .set-msg.err')`))
await ev(`__poc.click('.sc2.form .set-acts button', '취소')`)
await wait(`!document.querySelector('.sc2.form')`)

// 터미널에서 가져오기 — 후보(dogwalk-repo의 blender) → 가져오기 → 행
await ev(`__poc.click('.set-sec .set-chipbtn', '터미널에서 가져오기')`)
await wait(`document.querySelector('.mcp-cand') || [...document.querySelectorAll('.sc2.form .meta')].some((e) => e.textContent.includes('서버가 없어요'))`)
const cands = await ev(`__poc.qa('.mcp-cand').map((c) => ({ name: c.querySelector('.emt')?.textContent.trim(), badges: [...c.querySelectorAll('.set-badge')].map((b) => b.textContent.trim()), btn: c.querySelector('button')?.textContent.trim() }))`)
console.log('candidates:', cands)
const bl = cands.find((c) => c.name === 'blender')
check('M6 가져오기 후보 — 터미널 프로젝트의 blender', !!bl && bl.badges.includes('터미널 프로젝트') && bl.btn === '가져오기', cands)
if (bl) {
  await ev(`(() => { const c = __poc.qa('.mcp-cand').find((x) => x.querySelector('.emt')?.textContent.trim() === 'blender'); c.querySelector('button').click(); return true })()`)
  await wait(`__poc.rows().some((r) => r.name === 'blender')`)
  check('M6b 가져오기 → 앱 행 + mcp.json', !!mcpJson().servers?.blender && (await ev(`__poc.qa('.mcp-cand').find((x) => x.querySelector('.emt')?.textContent.trim() === 'blender')?.querySelector('button')?.textContent.trim()`)) === '다시 가져오기')
}
await ev(`__poc.click('.sc2.form .aphead button', '닫기')`)
await shot('shot-mcp-2.png')

// 프로젝트 허용 토글
const prefRow = `__poc.qa('.set-inner .sc2.row2').find((r) => r.textContent.includes('자동 허용'))`
check('M7 프로젝트 허용 기본 켬', await ev(`${prefRow}?.querySelector('.sw2').classList.contains('on')`))
await ev(`${prefRow}.querySelector('.sw2').click()`)
await wait(`!${prefRow}.querySelector('.sw2').classList.contains('on')`)
await sleep(200)
check('M7b 끔 → mcp.json allowProjectMcp false', mcpJson().allowProjectMcp === false)
await ev(`${prefRow}.querySelector('.sw2').click()`)
await wait(`${prefRow}.querySelector('.sw2').classList.contains('on')`)
await sleep(200)
check('M7c 되켬', mcpJson().allowProjectMcp !== false)

// 삭제
for (const nm of ['poctest', 'blender']) {
  await ev(`(() => { const r = __poc.qa('.sc2.row2.mcp').find((x) => x.querySelector('.emt')?.textContent.trim() === '${nm}'); if (!r) return false; [...r.querySelectorAll('.mcp-acts button')].find((b) => b.textContent.trim() === '삭제').click(); return true })()`)
  await wait(`!__poc.rows().some((r) => r.name === '${nm}')`)
}
check('M8 삭제 → mcp.json에서 제거', !mcpJson().servers?.poctest && !mcpJson().servers?.blender)

// ── Keys ──
await ev(`__poc.click('nav.set-nav button', 'Keys')`)
await wait(`document.querySelector('.set-inner .set-h1')?.textContent === 'Keys'`)
await wait(`!document.querySelector('.set-inner .set-spin')`)
await ev(`__poc.set('.sc2.form input.set-input', 'poc_key', 0)`)
check('K1 이름 자동 대문자·규칙', (await ev(`document.querySelector('.sc2.form input.set-input').value`)) === 'POC_KEY')
await ev(`__poc.set('.sc2.form input.set-input', 'secret-1234', 1)`)
await ev(`__poc.set('.sc2.form input.set-input', 'poc note', 2)`)
await ev(`__poc.click('.sc2.form .set-acts button', '저장')`)
await wait(`__poc.keys().some((k) => k.name === 'POC_KEY')`)
let keys = await ev(`__poc.keys()`)
let k = keys.find((x) => x.name === 'POC_KEY')
check('K2 키 추가 → 행(끝 4자리·메모·env 주입 배지·토글 켬)', k && k.meta.includes('••••1234') && k.meta.includes('poc note') && k.badges.includes('환경변수 주입') && k.on === true, k)
const sec = JSON.parse(fs.readFileSync(path.join(HOME, 'secrets.json'), 'utf8'))
check('K2b secrets.json — 암호화(원문 없음)·env true', sec.items?.[0]?.name === 'POC_KEY' && sec.items[0].enc === true && !JSON.stringify(sec).includes('secret-1234') && sec.items[0].env === true, sec)
check('K2c 폼 초기화', (await ev(`document.querySelector('.sc2.form input.set-input').value`)) === '')
await ev(`(() => { const r = __poc.qa('.set-inner .sc2.row2').find((x) => x.querySelector('.emt')?.textContent.trim() === 'POC_KEY'); r.querySelector('.sw2').click(); return true })()`)
await wait(`__poc.keys().find((x) => x.name === 'POC_KEY')?.on === false`)
await sleep(200)
check('K3 env 토글 끔 → 참조만 배지 + 파일', (await ev(`__poc.keys()`)).find((x) => x.name === 'POC_KEY').badges.includes('참조만') && JSON.parse(fs.readFileSync(path.join(HOME, 'secrets.json'), 'utf8')).items[0].env === false)
// 값 변경
await ev(`(() => { const r = __poc.qa('.set-inner .sc2.row2').find((x) => x.querySelector('.emt')?.textContent.trim() === 'POC_KEY'); [...r.querySelectorAll('.mcp-acts button')].find((b) => b.textContent.trim() === '값 변경').click(); return true })()`)
await wait(`document.querySelector('.sc2.form input.set-input').disabled && document.querySelector('.sc2.form input.set-input').value === 'POC_KEY'`)
await ev(`__poc.set('.sc2.form input.set-input', 'abcd9999', 1)`)
await ev(`__poc.click('.sc2.form .set-acts button', '저장')`)
await wait(`__poc.keys().find((x) => x.name === 'POC_KEY')?.meta.includes('••••9999')`)
k = (await ev(`__poc.keys()`)).find((x) => x.name === 'POC_KEY')
check('K4 값 변경 → 끝자리 갱신, env/메모 유지', k.meta.includes('••••9999') && k.meta.includes('poc note') && k.on === false, k)
// 예약 이름
await ev(`__poc.set('.sc2.form input.set-input', 'ANTHROPIC_API_KEY', 0)`)
await ev(`__poc.set('.sc2.form input.set-input', 'sk-ant-x', 1)`)
await ev(`__poc.click('.sc2.form .set-acts button', '저장')`)
await wait(`__poc.keys().some((x) => x.name === 'ANTHROPIC_API_KEY')`)
const ak = (await ev(`__poc.keys()`)).find((x) => x.name === 'ANTHROPIC_API_KEY')
check('K5 예약 이름 → 참조 전용 배지 + 토글 비활성', ak && ak.badges.includes('참조 전용') && ak.disabled === true, ak)
await shot('shot-keys.png')
for (const nm of ['POC_KEY', 'ANTHROPIC_API_KEY']) {
  await ev(`(() => { const r = __poc.qa('.set-inner .sc2.row2').find((x) => x.querySelector('.emt')?.textContent.trim() === '${nm}'); [...r.querySelectorAll('.mcp-acts button')].find((b) => b.textContent.trim() === '삭제').click(); return true })()`)
  await wait(`!__poc.keys().some((x) => x.name === '${nm}')`)
}
check('K6 삭제 → 빈 안내', (await ev(`__poc.txt('.set-inner .sc2.hint')`)).some((s) => s.includes('저장된 키가 없어요')) && JSON.parse(fs.readFileSync(path.join(HOME, 'secrets.json'), 'utf8')).items.length === 0)

// 검색 레일에 Keys 노출
await ev(`__poc.click('nav.set-nav button', 'MCP')`)
check('N1 레일 항목 MCP·Keys', (await ev(`__poc.txt('nav.set-nav button')`)).includes('Keys'))

// ── 종료 ──
ws.close()
try {
  const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
  const bws = new WebSocket(ver.webSocketDebuggerUrl)
  await new Promise((r) => (bws.onopen = r))
  bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  await sleep(500)
} catch {
  /* 이미 닫힘 */
}
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILED'} — screenshots in .dev-home/shot-*.png`)
process.exit(failed ? 1 : 0)
