// Blender로 3D 모델 열기 — 설치된 Blender를 찾아 빈 장면으로 띄우고 모델(.glb 등)을 불러온다.
// 찾는 순서: CCG_BLENDER 환경변수 → Program Files\Blender Foundation\*\ → 설치 기록(레지스트리, Steam 포함) → PATH.
// 여러 개면 `--version`으로 가장 높은 버전을 고른다(한 번 찾으면 기억한다).
import { execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function candidates(): Promise<string[]> {
  const out = new Set<string>()
  const env = process.env.CCG_BLENDER
  if (env) out.add(env)
  for (const root of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    const base = root && join(root, 'Blender Foundation')
    if (!base || !existsSync(base)) continue
    for (const d of readdirSync(base)) out.add(join(base, d, 'blender.exe'))
  }
  // 설치 기록의 InstallLocation — Steam 판도 여기에 남는다
  for (const hive of ['HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall']) {
    try {
      const { stdout } = await run('reg', ['query', hive, '/s', '/f', 'Blender', '/d'], { windowsHide: true, timeout: 10000 })
      for (const m of stdout.matchAll(/InstallLocation\s+REG_SZ\s+(.+)/g)) out.add(join(m[1].trim().replace(/^"|"$/g, ''), 'blender.exe'))
    } catch {
      /* 없는 키 · 권한 없음 */
    }
  }
  try {
    const { stdout } = await run('where', ['blender'], { windowsHide: true, timeout: 5000 })
    for (const l of stdout.split(/\r?\n/)) if (l.trim()) out.add(l.trim())
  } catch {
    /* PATH에 없음 */
  }
  return [...out].filter((p) => existsSync(p))
}

async function versionOf(exe: string): Promise<number[]> {
  try {
    const { stdout } = await run(exe, ['--version'], { windowsHide: true, timeout: 20000 })
    const m = /Blender\s+(\d+)\.(\d+)(?:\.(\d+))?/.exec(stdout)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : [0]
  } catch {
    return [-1] // 실행되지 않는 설치(지워진 파일 등)
  }
}

let found: Promise<{ exe: string; version: string } | null> | null = null

/** 쓸 수 있는 Blender — 없으면 null */
export function findBlender(): Promise<{ exe: string; version: string } | null> {
  found ??= (async () => {
    const list = await candidates()
    let best: { exe: string; v: number[] } | null = null
    for (const exe of list) {
      const v = await versionOf(exe)
      if (v[0] < 0) continue
      if (!best || cmp(v, best.v) > 0) best = { exe, v }
    }
    return best ? { exe: best.exe, version: best.v.join('.') } : null
  })()
  const p = found
  // 못 찾았으면 다음에 다시 찾는다(그사이 설치했을 수 있다)
  void p.then((r) => {
    if (!r && found === p) found = null
  })
  return p
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0)
  return 0
}

/** 빈 장면에 모델을 불러오고 화면에 꽉 차게 맞춘다. 파일 경로는 명령줄 인자(-- 뒤)로 넘겨 따옴표 문제를 피한다. */
const IMPORT_SCRIPT = [
  'import bpy, sys, os',
  "p = sys.argv[sys.argv.index('--') + 1]",
  'bpy.ops.wm.read_homefile(use_empty=True)',
  'ext = os.path.splitext(p)[1].lower()',
  "if ext in ('.glb', '.gltf'): bpy.ops.import_scene.gltf(filepath=p)",
  "elif ext == '.fbx': bpy.ops.import_scene.fbx(filepath=p)",
  "elif ext == '.obj': bpy.ops.wm.obj_import(filepath=p)",
  "elif ext == '.usdz' or ext == '.usd': bpy.ops.wm.usd_import(filepath=p)",
  'def frame():',
  '    for w in bpy.context.window_manager.windows:',
  '        for a in w.screen.areas:',
  "            if a.type != 'VIEW_3D': continue",
  "            r = next((r for r in a.regions if r.type == 'WINDOW'), None)",
  '            with bpy.context.temp_override(window=w, area=a, region=r):',
  '                bpy.ops.view3d.view_all()',
  "            a.spaces[0].shading.type = 'MATERIAL'",
  '    return None',
  'bpy.app.timers.register(frame, first_interval=0.8)'
].join('\n')

export const MODEL_EXTS = ['.glb', '.gltf', '.fbx', '.obj', '.usdz', '.usd']

/** Blender를 따로 띄운다(게이트웨이와 무관하게 계속 열려 있다) */
export async function openInBlender(file: string): Promise<{ exe: string; version: string }> {
  const b = await findBlender()
  if (!b) throw new Error('Blender를 찾지 못했어요. 설치했다면 CCG_BLENDER 환경변수에 blender.exe 경로를 넣어 주세요.')
  const child = spawn(b.exe, ['--python-expr', IMPORT_SCRIPT, '--', file], { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return b
}
