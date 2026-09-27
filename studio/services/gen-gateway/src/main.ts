// 게이트웨이 조립 — 경로 · 키 보관함 · 서비스 어댑터 · 기록부 · 서버를 묶는다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LocalArchiver } from './archive.ts'
import { ProjectStore } from './projects.ts'
import { Gateway, type GatewayEvent } from './gateway.ts'
import { Ledger } from './ledger.ts'
import { FAKE_MODEL, MODELS, type ModelInfo } from './models.ts'
import { loadRoutes } from './routes.ts'
import { SecretStore } from './secrets.ts'
import { startServer, type RunningServer } from './server.ts'
import { ComfyProvider } from './providers/comfy.ts'
import { FakeProvider } from './providers/fake.ts'
import { HiggsfieldProvider } from './providers/higgsfield.ts'
import { TripoProvider } from './providers/tripo.ts'
import type { Provider } from './types.ts'

/** 앱과 같은 데이터 폴더 — CCG_HOME이 있으면 그것, 없으면 ~/.agentstudio */
export function appHome(): string {
  const h = process.env.CCG_HOME
  return h ? resolve(h) : join(homedir(), '.agentstudio')
}

/**
 * 에셋(생성 결과 · 아트 프로젝트) 루트 — 용량이 커서 앱 데이터 폴더와 따로 둔다.
 * CCG_STUDIO_ASSETS가 있으면 그것, 없으면 E:\AgentStudio(E 드라이브가 있을 때), 그것도 없으면 <데이터 폴더>/studio/assets.
 */
export function assetsRoot(home = appHome()): string {
  const env = process.env.CCG_STUDIO_ASSETS
  if (env) return resolve(env)
  if (process.platform === 'win32' && existsSync('E:\\')) return 'E:\\AgentStudio'
  return join(home, 'studio', 'assets')
}

export function paths(home = appHome()) {
  const dir = join(home, 'studio')
  return {
    dir,
    db: join(dir, 'gateway.db'),
    secrets: join(dir, 'secrets.json'),
    routes: join(dir, 'routes.json'),
    info: join(dir, 'gateway.json'),
    outputs: join(dir, 'outputs'),
    characters: join(dir, 'characters'),
    tools: join(dir, 'tools'),
    // 아트 프로젝트 폴더들 · 프로젝트 없는 결과
    projects: join(assetsRoot(home), 'ArtProjects'),
    library: join(assetsRoot(home), 'Library')
  }
}

export function makeProviders(secrets: SecretStore): Provider[] {
  return [
    new ComfyProvider(() => secrets.peek('comfy')),
    new TripoProvider(() => secrets.peek('tripo')),
    new HiggsfieldProvider(() => secrets.peek('higgsfield'))
  ]
}

export interface Runtime {
  gateway: Gateway
  ledger: Ledger
  secrets: SecretStore
  providers: Provider[]
  server: RunningServer | null
  stop: () => Promise<void>
}

export async function boot(opts: { serve: boolean; log?: (m: string) => void } = { serve: true }): Promise<Runtime> {
  const log = opts.log ?? ((m: string) => console.error(`[gen-gateway] ${m}`))
  const p = paths()
  mkdirSync(p.dir, { recursive: true }) // 첫 실행 — 데이터 폴더가 아직 없을 수 있다
  const secrets = new SecretStore(p.secrets)
  for (const r of await secrets.preload()) if (!r.ok) log(`${r.provider} 키를 복호화하지 못했어요: ${r.error}`)
  const loaded = loadRoutes(p.routes)
  const { source, warnings } = loaded
  let routes = loaded.routes
  for (const w of warnings) log(w)
  const ledger = new Ledger(p.db)
  const providers = makeProviders(secrets)
  let models: ModelInfo[] = MODELS
  // 개발용 — 과금 없는 가짜 서비스로 승인 카드 · 진행 · 완료 흐름을 화면에서 확인한다
  if (process.env.CCG_GATEWAY_FAKE === '1') {
    providers.push(new FakeProvider({ id: 'fake', steps: 6, balance: 500, price: 12, models: ['fake-demo'] }))
    routes = [...routes, { capability: 'image', model: 'fake-demo', providers: ['fake'] }]
    models = [FAKE_MODEL, ...MODELS]
    log('개발용 가짜 서비스(fake-demo)를 켰어요 — 실제 서비스 호출 · 과금 없음')
  }
  let emit: (e: GatewayEvent) => void = () => {}
  // 클라우드 저장소 연결 전까지는 곧 만료되는 결과(Tripo 5분 링크 등)만 앱 데이터 폴더에 보관한다
  const projects = new ProjectStore(p.projects)
  const archiver = new LocalArchiver({ legacyDir: p.outputs, libraryDir: p.library, projectAssets: (id) => (projects.get(id) ? projects.assetsDir(id) : null) })
  const gateway = new Gateway({ ledger, providers, routes, onEvent: (e) => emit(e), archiver, projects })
  gateway.resume()
  let server: RunningServer | null = null
  if (opts.serve) {
    // 내장 도구는 게이트웨이 옆 tools 폴더(개발: 저장소, 설치본: resources/gen-gateway/tools), 사용자 도구는 데이터 폴더
    const builtinTools = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools')
    server = await startServer({ gateway, ledger, secrets, providers, infoFile: p.info, outputsDir: p.outputs, models, charactersDir: p.characters, toolDirs: [builtinTools, p.tools] })
    emit = server.broadcast
    log(`127.0.0.1:${server.port}에서 대기 중 (라우팅: ${source === 'user' ? 'routes.json' : '기본값'}, 키: ${secrets.list().map((k) => k.provider).join(', ') || '없음'})`)
  }
  const stop = async (): Promise<void> => {
    gateway.stop()
    if (server) await server.close()
    ledger.close()
  }
  return { gateway, ledger, secrets, providers, server, stop }
}

/** 이미 떠 있는 게이트웨이의 접속 정보 — 살아 있지 않으면 null */
export async function runningInfo(home = appHome()): Promise<{ port: number; token: string; pid: number } | null> {
  const f = paths(home).info
  if (!existsSync(f)) return null
  try {
    const info = JSON.parse(readFileSync(f, 'utf8')) as { port: number; token: string; pid: number }
    const res = await fetch(`http://127.0.0.1:${info.port}/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok ? info : null
  } catch {
    return null
  }
}
