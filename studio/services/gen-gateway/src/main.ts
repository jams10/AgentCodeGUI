// 게이트웨이 조립 — 경로 · 키 보관함 · 서비스 어댑터 · 기록부 · 서버를 묶는다.
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { LocalArchiver } from './archive.ts'
import { Gateway, type GatewayEvent } from './gateway.ts'
import { Ledger } from './ledger.ts'
import { loadRoutes } from './routes.ts'
import { SecretStore } from './secrets.ts'
import { startServer, type RunningServer } from './server.ts'
import { ComfyProvider } from './providers/comfy.ts'
import { HiggsfieldProvider } from './providers/higgsfield.ts'
import { TripoProvider } from './providers/tripo.ts'
import type { Provider } from './types.ts'

/** 앱과 같은 데이터 폴더 — CCG_HOME이 있으면 그것, 없으면 ~/.agentstudio */
export function appHome(): string {
  const h = process.env.CCG_HOME
  return h ? resolve(h) : join(homedir(), '.agentstudio')
}

export function paths(home = appHome()) {
  const dir = join(home, 'studio')
  return { dir, db: join(dir, 'gateway.db'), secrets: join(dir, 'secrets.json'), routes: join(dir, 'routes.json'), info: join(dir, 'gateway.json'), outputs: join(dir, 'outputs') }
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
  const { routes, source, warnings } = loadRoutes(p.routes)
  for (const w of warnings) log(w)
  const ledger = new Ledger(p.db)
  const providers = makeProviders(secrets)
  let emit: (e: GatewayEvent) => void = () => {}
  // 클라우드 저장소 연결 전까지는 곧 만료되는 결과(Tripo 5분 링크 등)만 앱 데이터 폴더에 보관한다
  const gateway = new Gateway({ ledger, providers, routes, onEvent: (e) => emit(e), archiver: new LocalArchiver(p.outputs) })
  gateway.resume()
  let server: RunningServer | null = null
  if (opts.serve) {
    server = await startServer({ gateway, ledger, secrets, providers, infoFile: p.info, outputsDir: p.outputs })
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
