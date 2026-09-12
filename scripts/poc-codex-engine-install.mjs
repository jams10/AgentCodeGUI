/**
 * PoC — Codex CLI 설치 검증(플랫폼 패키지 누락 재시도) · 반쪽 설치본 배제 · 로그인 실패 표면화.
 *
 * 사고(2026-09-10): 부팅 자동 업데이트가 0.154.0을 깔 때 npm이 캐시된 옛 패키지 목록으로
 * 선택적 의존성 @openai/codex-win32-x64(0.15x부터 실행 파일이 여기로 갈라짐)를 못 풀고
 * 조용히 건너뛰어(exit 0) 실행 파일 없는 반쪽 설치본이 활성이 됐고, 정리가 멀쩡한 옛 버전을
 * 지웠다. `codex login`은 "Missing optional dependency"로 즉사했지만 앱은 그 출력을 삼켜
 * '계정 추가 버튼이 아무 일도 안 함'으로 보였다.
 *
 * 검증(실 모듈 esbuild 번들 — electron·homedir·lang만 스텁, npm은 실제 실행이라 네트워크 필요):
 *  A. 반쪽 폴더(package.json만) → 설치 목록 제외 · 활성 거부 · codexBin 전역 폴백
 *  B. 첫 npm이 선택적 의존성을 건너뛰게(npm_config_omit=optional) 한 뒤 codexInstall →
 *     재시도 경로(--prefer-online, 플랫폼 패키지 명시)로 실행 파일 확보 → ok · `codex --version`
 *  C. 존재하지 않는 버전 → 실패 보고 + 폴더 잔재 없음
 *  D. 로그인 — 실행 파일이 사라진 활성 버전으로 codexLogin → 사유가 담긴 reject
 *     (전역 codex가 PATH에 있으면 실제 로그인 브라우저가 열리므로 건너뜀)
 *
 * 실행: node scripts/poc-codex-engine-install.mjs
 */
import esbuild from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
let failed = 0
const check = (name, cond, detail) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || detail == null ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!cond) failed++
}
const VER = '0.154.0'
const isWin = process.platform === 'win32'

// ── 샌드박스 홈 ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-cx-'))
const HOME = path.join(TMP, 'home')
const ENGINES = path.join(HOME, '.agentcodegui', 'codex-engines')
fs.mkdirSync(ENGINES, { recursive: true })

const stubs = {
  electron: `
    const rev = (s) => s.split('').reverse().join('')
    export const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('enc:' + rev(s), 'utf8'),
      decryptString: (b) => { const s = b.toString('utf8'); if (!s.startsWith('enc:')) throw new Error('bad'); return rev(s.slice(4)) }
    }`,
  '../lang': `export const t = (ko) => ko; export const isEn = () => false`,
  os: `import * as real from 'node:os'
    const o = { ...real, homedir: () => ${JSON.stringify(HOME)} }
    export default o
    export const homedir = o.homedir
    export const tmpdir = real.tmpdir
    export const platform = real.platform`
}
const stubPlugin = {
  name: 'poc-stubs',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'poc-stub' }))
    build.onResolve({ filter: /^\.\.\/lang$/ }, (args) => ({ path: args.path, namespace: 'poc-stub' }))
    build.onResolve({ filter: /^(node:)?os$/ }, (args) => (args.namespace === 'poc-stub' ? undefined : { path: 'os', namespace: 'poc-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'poc-stub' }, (args) => ({ contents: stubs[args.path], loader: 'js', resolveDir: path.join(root, 'src/main/codex') }))
  }
}
const entry = path.join(root, '.poc-cx-entry.ts')
const bundle = path.join(root, '.poc-cx-install.mjs')
fs.writeFileSync(entry, `export * as versions from './src/main/codex/versions'\nexport * as auth from './src/main/codex/auth'`)
await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: bundle,
  alias: { '@shared': path.join(root, 'src/shared') },
  plugins: [stubPlugin],
  logLevel: 'silent'
})
const { versions, auth } = await import(pathToFileURL(bundle).href)
fs.rmSync(bundle, { force: true })
fs.rmSync(entry, { force: true })

const exeOf = (v) => versions.codexExeAt(v)

// ══════════════ A. 반쪽 설치본 배제 ══════════════
console.log('\n── A. half-installed folder ──')
const HALF = '9.9.9'
const halfPkg = path.join(ENGINES, HALF, 'node_modules', '@openai', 'codex')
fs.mkdirSync(halfPkg, { recursive: true })
fs.writeFileSync(path.join(halfPkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: HALF }))
check('A1 실행 파일 없음 → codexExeAt null', exeOf(HALF) == null)
check('A2 설치 목록에서 제외', !versions.codexListInstalled().includes(HALF), versions.codexListInstalled())
let threw = null
try {
  versions.codexSetActive(HALF)
} catch (e) {
  threw = e.message
}
check('A3 활성 지정 거부', !!threw, threw)
fs.writeFileSync(path.join(HOME, '.agentcodegui', 'codex-config.json'), JSON.stringify({ activeVersion: HALF }))
check('A4 활성 포인터가 반쪽을 가리켜도 codexBin은 전역 폴백', versions.codexBin() === 'codex', versions.codexBin())
const stA = await versions.codexEngineState()
check('A5 엔진 상태: active null · installed 비움', stA.active === null && stA.installed.length === 0, stA)

// ══════════════ B. 선택적 의존성 누락 → 재시도로 복구 ══════════════
console.log('\n── B. install with optional deps skipped → retry path ──')
const lines = []
process.env.npm_config_omit = 'optional' // 첫 npm이 플랫폼 패키지를 건너뛰게(사고 재현)
const t0 = Date.now()
const rB = await versions.codexInstall(VER, (p) => {
  if (p.line) lines.push(p.line)
})
delete process.env.npm_config_omit
const cmdLines = lines.filter((l) => l.startsWith('$'))
const retryLine = cmdLines.find((l) => l.startsWith('$ npm install @openai/codex-') && l.includes('--prefer-online'))
check(`B1 설치 ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`, rB.ok === true, rB)
check('B2 재시도 경로를 탔다(플랫폼 패키지 명시 + --prefer-online)', !!retryLine, cmdLines)
check('B3 실행 파일 존재', !!exeOf(VER), exeOf(VER))
check('B4 설치 목록에 등장', versions.codexListInstalled().includes(VER), versions.codexListInstalled())
versions.codexSetActive(VER)
const bin = versions.codexBin()
check('B5 codexBin = 설치본 .bin', bin !== 'codex' && bin.includes(VER), bin)
const ver = spawnSync(bin, ['--version'], { shell: isWin, encoding: 'utf8', windowsHide: true })
check('B6 `codex --version` 실행', (ver.stdout || '').includes(VER), { stdout: ver.stdout, stderr: (ver.stderr || '').slice(0, 200), status: ver.status })
const rootPkg = JSON.parse(fs.readFileSync(path.join(ENGINES, VER, 'package.json'), 'utf8'))
check('B7 루트 package.json에 플랫폼 별칭 의존성 기록', Object.keys(rootPkg.dependencies || {}).some((k) => k.startsWith('@openai/codex-')), rootPkg.dependencies)

// ══════════════ C. 없는 버전 → 실패 + 잔재 없음 ══════════════
console.log('\n── C. nonexistent version ──')
const NOPE = '0.0.0-poc-none'
const rC = await versions.codexInstall(NOPE, () => {})
check('C1 실패 보고', rC.ok === false && !!rC.error, rC)
check('C2 폴더 잔재 없음', !fs.existsSync(path.join(ENGINES, NOPE)))
check('C3 설치 목록 불변', JSON.stringify(versions.codexListInstalled()) === JSON.stringify([VER]), versions.codexListInstalled())

// ══════════════ D. 로그인 실패 표면화 ══════════════
console.log('\n── D. login failure surfaces a reason ──')
const globalCodex = spawnSync(isWin ? 'where' : 'which', ['codex'], { encoding: 'utf8', windowsHide: true }).status === 0
if (globalCodex) {
  console.log('skip D — 전역 codex가 PATH에 있어 실제 로그인(브라우저)이 열린다')
} else {
  // 실행 파일만 지워 사고 상태(활성 버전이 반쪽)를 만든다 → codexBin 전역 폴백 → 스폰 실패가 사유로
  fs.rmSync(path.join(ENGINES, VER, 'node_modules', '@openai', 'codex-win32-x64'), { recursive: true, force: true })
  fs.rmSync(path.join(ENGINES, VER, 'node_modules', '@openai', 'codex', 'vendor'), { recursive: true, force: true })
  check('D0 실행 파일 제거됨', exeOf(VER) == null)
  const wc = { isDestroyed: () => false, send: () => {} }
  let err = null
  let list = null
  try {
    list = await auth.codexLogin(wc)
  } catch (e) {
    err = e.message
  }
  check('D1 계정 없이 끝난 로그인은 reject', err != null, { err, list })
  check('D2 사유 문구 포함(앞머리 + CLI 출력)', !!err && err.startsWith('OpenAI 로그인이 완료되지 않았어요') && err.includes(' — '), err)
  check('D3 임시 login 폴더 정리', !fs.existsSync(path.join(HOME, '.agentcodegui', 'codex', 'login')))
  check('D4 계정 스토어 무변경', (await auth.codexListAccounts()).length === 0)
}

// ── 정리 ──
try {
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
} catch {
  /* ignore */
}
console.log(`\n${failed === 0 ? 'ALL OK' : failed + ' FAILED'}`)
process.exit(failed ? 1 : 0)
