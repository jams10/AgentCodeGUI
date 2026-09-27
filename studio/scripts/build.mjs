// AgentStudio 빌드 진입점.
// 원본 scripts/tauri-build.mjs를 그대로 부르고, 포크 정체성만 얹는다:
//   - studio/tauri.studio.conf.json을 Tauri --config로 병합(앱 이름·식별자·업데이트 주소)
//   - CCG_DEFAULT_HOME_DIR로 기본 데이터 폴더를 ~/.agentstudio로 바꾼다
// 사용: node studio/scripts/build.mjs [원본 tauri-build.mjs 인자…]   예) build --unsigned
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const overlay = join(REPO, 'studio', 'tauri.studio.conf.json')
const args = process.argv.slice(2)
if (args.length === 0) args.push('build', '--unsigned')

const r = spawnSync(process.execPath, [join(REPO, 'scripts', 'tauri-build.mjs'), ...args, '--config', overlay], {
  cwd: REPO,
  stdio: 'inherit',
  env: { ...process.env, CCG_DEFAULT_HOME_DIR: '.agentstudio' }
})
process.exit(r.status ?? 1)
