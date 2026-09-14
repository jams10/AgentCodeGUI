/**
 * Codex CLI 버전 관리 — Claude Code(engine/versions.ts)와 동일한 문법: npm 패키지
 * (@openai/codex)를 앱 홈 전용 폴더에 버전별로 설치하고 그 실행 파일로 돈다. 시스템
 * 전역 codex는 건드리지 않는다(설치본이 없으면 전역 codex로 폴백 — 번들이 없다는 점만
 * Claude와 다르다).
 */
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { writeFileAtomic } from '../atomicWrite'
import { t } from '../lang'
import type { EngineVersionEntry, EngineVersionState, EngineInstallProgress, EngineCleanupResult } from '@shared/protocol'

const PACKAGE = '@openai/codex'
const APP_HOME = path.join(os.homedir(), '.agentcodegui')
const ENGINES_DIR = path.join(APP_HOME, 'codex-engines')
const CONFIG_PATH = path.join(APP_HOME, 'codex-config.json')

interface Config {
  activeVersion: string | null
}

function readConfig(): Config {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return { activeVersion: typeof c.activeVersion === 'string' ? c.activeVersion : null }
  } catch {
    return { activeVersion: null }
  }
}
function writeConfig(c: Config): void {
  fs.mkdirSync(APP_HOME, { recursive: true })
  writeFileAtomic(CONFIG_PATH, JSON.stringify(c, null, 2))
}

function packageDir(version: string): string {
  return path.join(ENGINES_DIR, version, 'node_modules', ...PACKAGE.split('/'))
}

// 0.15x부터 네이티브 실행 파일은 플랫폼별 선택적 의존성(@openai/codex-<os>-<arch> — npm 별칭
// npm:@openai/codex@<v>-<os>-<arch>)으로 갈라졌다. bin/codex.js가 이 표로 찾고, 없으면 본
// 패키지의 vendor/(≤0.14x가 번들하던 자리)를 본다 — 여기서도 같은 순서로 검증한다.
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': `${PACKAGE}-linux-x64`,
  'aarch64-unknown-linux-musl': `${PACKAGE}-linux-arm64`,
  'x86_64-apple-darwin': `${PACKAGE}-darwin-x64`,
  'aarch64-apple-darwin': `${PACKAGE}-darwin-arm64`,
  'x86_64-pc-windows-msvc': `${PACKAGE}-win32-x64`,
  'aarch64-pc-windows-msvc': `${PACKAGE}-win32-arm64`
}
function platformTarget(): { pkg: string; triple: string; suffix: string } | null {
  const { arch } = process
  const plat = process.platform === 'android' ? 'linux' : process.platform
  const triple =
    plat === 'linux'
      ? arch === 'x64'
        ? 'x86_64-unknown-linux-musl'
        : arch === 'arm64'
          ? 'aarch64-unknown-linux-musl'
          : null
      : plat === 'darwin'
        ? arch === 'x64'
          ? 'x86_64-apple-darwin'
          : arch === 'arm64'
            ? 'aarch64-apple-darwin'
            : null
        : plat === 'win32'
          ? arch === 'x64'
            ? 'x86_64-pc-windows-msvc'
            : arch === 'arm64'
              ? 'aarch64-pc-windows-msvc'
              : null
          : null
  if (!triple) return null
  const pkg = PLATFORM_PACKAGE_BY_TARGET[triple]
  return { pkg, triple, suffix: pkg.slice(PACKAGE.length + 1) }
}

// 실제 네이티브 실행 파일 경로 — 플랫폼 패키지(신) → 본 패키지 vendor(구) 순. 없으면 null.
export function codexExeAt(version: string): string | null {
  const tgt = platformTarget()
  if (!tgt) return null
  const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const nm = path.join(ENGINES_DIR, version, 'node_modules')
  for (const base of [path.join(nm, ...tgt.pkg.split('/')), packageDir(version)]) {
    const p = path.join(base, 'vendor', tgt.triple, 'bin', exe)
    if (fs.existsSync(p)) return p
  }
  return null
}

function packageVersionAt(version: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir(version), 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

// 설치본 판정 = 패키지 + 실행 파일. 실행 파일 없는 반쪽 폴더(플랫폼 패키지 누락)는 설치본이
// 아니다 — 목록·활성·정리 모두에서 빠져, 부팅 자동 업데이트가 그걸 활성으로 삼거나 정리가
// 멀쩡한 옛 버전을 지우는 일이 없다(실측 2026-09-10: 0.154.0 반쪽 설치 → 활성 → 옛 버전 삭제
// → `codex login`이 "Missing optional dependency @openai/codex-win32-x64"로 즉사).
function installedVersionAt(version: string): string | null {
  const v = packageVersionAt(version)
  return v && codexExeAt(version) ? v : null
}

function compareDesc(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0)
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pb[i] ?? 0) - (pa[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function codexListInstalled(): string[] {
  let names: string[] = []
  try {
    names = fs
      .readdirSync(ENGINES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  return names.filter((v) => installedVersionAt(v) != null).sort(compareDesc)
}

// 전역 codex의 버전 — 설치본이 없을 때의 폴백 표시 (Claude의 '번들' 자리). 캐시 1회.
let globalVer: string | null | undefined
function globalCodexVersion(): Promise<string> {
  if (globalVer !== undefined) return Promise.resolve(globalVer ?? 'unknown')
  return new Promise((resolve) => {
    execFile('codex', ['--version'], { timeout: 8000, windowsHide: true, shell: true }, (_e, stdout) => {
      const m = (stdout ?? '').match(/\d+\.\d+\.\d+/)
      globalVer = m ? m[0] : null
      resolve(globalVer ?? 'unknown')
    })
  })
}

export async function codexEngineState(): Promise<EngineVersionState> {
  const installed = codexListInstalled()
  let active = readConfig().activeVersion
  if (active && !installed.includes(active)) active = null
  // bundled 자리에 전역 codex 버전 — 설치본이 없으면 이걸로 돈다(폴백)
  return { package: PACKAGE, bundled: await globalCodexVersion(), active, installed }
}

export function codexSetActive(version: string | null): void {
  if (version && installedVersionAt(version) == null) {
    throw new Error(t(`버전 ${version}이(가) 설치되어 있지 않습니다.`, `Version ${version} is not installed.`))
  }
  writeConfig({ activeVersion: version })
}

export async function codexListAvailable(): Promise<{ latest: string | null; versions: EngineVersionEntry[] }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(`https://registry.npmjs.org/${PACKAGE}`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(t(`레지스트리 응답 오류 (${res.status})`, `Registry responded with an error (${res.status})`))
    const j = (await res.json()) as {
      'dist-tags'?: Record<string, string>
      versions?: Record<string, unknown>
      time?: Record<string, string>
    }
    const latest = j['dist-tags']?.latest ?? null
    const time = j.time ?? {}
    const stable = Object.keys(j.versions ?? {}).filter((v) => !v.includes('-'))
    stable.sort(compareDesc)
    return {
      latest,
      versions: stable.map((v) => ({
        version: v,
        date: time[v] ?? null,
        latest: v === latest,
        // latest보다 높은 버전 = 프리뷰 채널 — 자동 업데이트 대상 아님 (UI '프리뷰' 배지)
        preview: latest != null && compareDesc(v, latest) < 0
      }))
    }
  } finally {
    clearTimeout(timer)
  }
}

// npm 한 번 — 출력을 진행 로그로 흘리고 종료 코드를 돌려준다(스폰 자체 실패는 error)
function runNpm(
  args: string[],
  cwd: string,
  version: string,
  onProgress: (p: EngineInstallProgress) => void
): Promise<{ code: number | null; error?: string }> {
  const isWin = process.platform === 'win32'
  const npmCmd = isWin ? 'npm.cmd' : 'npm'
  return new Promise((resolve) => {
    const spawnArgs = isWin ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args
    const child = spawn(npmCmd, spawnArgs, { cwd, env: process.env, windowsHide: true, shell: isWin })
    const onData = (buf: Buffer): void => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const t = line.trim()
        if (t) onProgress({ version, line: t })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (e) => {
      // 지역 t(line.trim())는 onData 안에만 있어 여기의 i18n t()를 가리지 않는다
      resolve({
        code: null,
        error: t(
          `npm 실행 실패: ${e.message}. npm(Node.js)이 설치돼 있고 PATH에 있는지 확인하세요.`,
          `Failed to run npm: ${e.message}. Make sure npm (Node.js) is installed and on your PATH.`
        )
      })
    })
    child.on('close', (code) => resolve({ code }))
  })
}

export async function codexInstall(
  version: string,
  onProgress: (p: EngineInstallProgress) => void
): Promise<{ ok: boolean; error?: string }> {
  const dir = path.join(ENGINES_DIR, version)
  const rmDir = (): Promise<void> =>
    fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {})
  const fail = async (error: string): Promise<{ ok: boolean; error?: string }> => {
    await rmDir() // 반쪽 폴더를 남기지 않는다 — 다음 시도가 옛 lock의 빈 항목을 물려받지 않게
    onProgress({ version, done: true, ok: false, error })
    return { ok: false, error }
  }
  try {
    // 이전 시도의 잔재(패키지는 있는데 실행 파일이 없는 폴더)는 먼저 비운다
    if (fs.existsSync(dir) && installedVersionAt(version) == null) await rmDir()
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: `agent-code-gui-codex-${version}`, version: '0.0.0', private: true }, null, 2)
    )
  } catch (e) {
    return { ok: false, error: t(`폴더 생성 실패: ${(e as Error).message}`, `Failed to create the folder: ${(e as Error).message}`) }
  }

  onProgress({ version, line: `$ npm install ${PACKAGE}@${version}` })
  const r = await runNpm(
    ['install', `${PACKAGE}@${version}`, '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=http'],
    dir,
    version,
    onProgress
  )
  if (r.error) return fail(r.error)
  if (r.code !== 0 || !packageVersionAt(version)) {
    return fail(t(`설치 실패 (npm 종료 코드 ${r.code})`, `Install failed (npm exit code ${r.code})`))
  }

  // 실행 파일 검증 — 플랫폼 패키지는 선택적 의존성이라 npm이 못 풀어도(캐시된 옛 패키지 목록에
  // 방금 나온 <v>-win32-x64가 없던 실측) 조용히 건너뛰고 0으로 끝난다. 없으면 그 패키지만
  // 콕 집어 --prefer-online(레지스트리 재조회)으로 한 번 더 받고, 그래도 없으면 실패로 보고한다.
  if (!codexExeAt(version)) {
    const tgt = platformTarget()
    if (tgt) {
      const spec = `${tgt.pkg}@npm:${PACKAGE}@${version}-${tgt.suffix}`
      onProgress({ version, line: `$ npm install ${spec} --prefer-online` })
      const r2 = await runNpm(
        ['install', spec, '--prefix', dir, '--prefer-online', '--no-audit', '--no-fund', '--loglevel=http'],
        dir,
        version,
        onProgress
      )
      if (r2.error) return fail(r2.error)
    }
    if (!codexExeAt(version)) {
      const pkg = tgt?.pkg ?? t('플랫폼 패키지', 'platform package')
      return fail(
        t(
          `설치 실패 — 실행 파일(${pkg})을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.`,
          `Install failed — could not download the executable (${pkg}). Please try again shortly.`
        )
      )
    }
  }
  onProgress({ version, done: true, ok: true })
  return { ok: true }
}

export async function codexUninstall(version: string): Promise<void> {
  // Windows: 백신/인덱서가 큰 node_modules(네이티브 exe 포함)를 순간 점유하면 rm이
  // EPERM으로 즉사한다 — 기본 maxRetries가 0이라 재시도를 명시해야 견딘다 (실측:
  // 부팅 게이트의 옛 버전 정리가 조용히 실패해 0.144.3 잔재가 남았다)
  await fsp.rm(path.join(ENGINES_DIR, version), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  if (readConfig().activeVersion === version) writeConfig({ activeVersion: null })
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  try {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) total += await dirSize(p)
      else if (e.isFile()) total += (await fsp.stat(p).catch(() => null))?.size ?? 0
    }
  } catch {
    /* unreadable entries just don't count */
  }
  return total
}

export async function codexCleanupOld(): Promise<EngineCleanupResult> {
  const installed = codexListInstalled()
  const kept = installed[0] ?? null
  const activeBefore = readConfig().activeVersion
  const removed: string[] = []
  let freedBytes = 0
  for (const v of installed.slice(1)) {
    freedBytes += await dirSize(path.join(ENGINES_DIR, v))
    await codexUninstall(v)
    removed.push(v)
  }
  const activeSwitched = activeBefore != null && removed.includes(activeBefore)
  if (activeSwitched) writeConfig({ activeVersion: kept })
  return { removed, kept, freedBytes, activeSwitched }
}

/**
 * 실행에 쓸 codex 명령 — 활성 설치본의 실행 파일, 없으면 전역 'codex'(PATH) 폴백.
 * Windows는 .cmd라 shell 경유 스폰이 전제 — 경로 공백이 깨지지 않게 따옴표로 감싼다
 * (비-Windows는 shell 없이 스폰하므로 원문 그대로).
 */
export function codexBin(): string {
  const { activeVersion } = readConfig()
  if (activeVersion) {
    const bin = path.join(
      ENGINES_DIR,
      activeVersion,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'codex.cmd' : 'codex'
    )
    // 실행 파일까지 있어야 그 설치본 — 반쪽 폴더면 전역으로 폴백(없으면 스폰 실패가 사유로 올라간다)
    if (fs.existsSync(bin) && codexExeAt(activeVersion)) return process.platform === 'win32' && /\s/.test(bin) ? `"${bin}"` : bin
  }
  return 'codex'
}
