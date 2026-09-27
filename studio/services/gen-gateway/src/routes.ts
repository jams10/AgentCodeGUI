// 라우팅 표 — (기능, 모델) → 서비스 우선순위.
// 사용자 파일(<home>/studio/routes.json)이 있으면 그것을, 없으면 아래 기본값을 쓴다.
// 대체(fallback)는 "같은 모델로 확인된 조합"끼리만 한 줄에 묶는다 — 다른 모델로 몰래 바뀌지 않게.
import { existsSync, readFileSync } from 'node:fs'
import type { Capability, ProviderId } from './types.ts'

export interface Route {
  capability: Capability
  /** '*'는 그 기능의 나머지 모든 모델 */
  model: string
  providers: ProviderId[]
  note?: string
}

export const DEFAULT_ROUTES: Route[] = [
  { capability: 'image', model: 'comfy-workflow', providers: ['comfy'], note: 'ComfyCloud 워크플로(API 형식 JSON)를 그대로 실행' },
  { capability: 'video', model: 'comfy-workflow', providers: ['comfy'] },
  { capability: 'model3d', model: 'comfy-workflow', providers: ['comfy'] },
  // Higgsfield의 텍스트→3D도 Tripo 모델이지만 CLI 전용이고 REST API에는 없다(2026-09 확인) — 대체 경로로 넣지 않는다.
  { capability: 'model3d', model: 'tripo-text-to-3d', providers: ['tripo'] },
  { capability: 'image', model: 'soul', providers: ['higgsfield'] },
  { capability: 'video', model: 'seedance-2.0-t2v', providers: ['higgsfield'] },
  { capability: 'video', model: 'seedance-2.0-i2v', providers: ['higgsfield'] },
  { capability: 'video', model: 'kling-2.5-turbo-i2v', providers: ['higgsfield'] },
  // 'hf/<경로>'로 카탈로그의 다른 Higgsfield 모델을 그대로 부른다
  { capability: 'image', model: 'hf/*', providers: ['higgsfield'] },
  { capability: 'video', model: 'hf/*', providers: ['higgsfield'] },
  { capability: 'model3d', model: 'tripo-image-to-3d', providers: ['tripo'] },
  { capability: 'model3d', model: 'tripo-multiview-to-3d', providers: ['tripo'] }
]

const CAPS: Capability[] = ['image', 'video', 'model3d', 'audio']
const PROVIDERS: ProviderId[] = ['comfy', 'tripo', 'higgsfield', 'fake']

/** 사용자 파일을 검증해 읽는다. 잘못된 줄은 버리고, 파일 전체가 이상하면 기본값을 쓴다. */
export function loadRoutes(file: string | null): { routes: Route[]; source: 'user' | 'default'; warnings: string[] } {
  const warnings: string[] = []
  if (!file || !existsSync(file)) return { routes: DEFAULT_ROUTES, source: 'default', warnings }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    warnings.push(`routes.json을 읽지 못해 기본값을 씁니다: ${(e as Error).message}`)
    return { routes: DEFAULT_ROUTES, source: 'default', warnings }
  }
  const list = Array.isArray(raw) ? raw : (raw as { routes?: unknown })?.routes
  if (!Array.isArray(list)) {
    warnings.push('routes.json 형식이 올바르지 않아 기본값을 씁니다.')
    return { routes: DEFAULT_ROUTES, source: 'default', warnings }
  }
  const routes: Route[] = []
  list.forEach((r, i) => {
    const o = r as Partial<Route>
    const providers = Array.isArray(o.providers) ? o.providers.filter((p): p is ProviderId => PROVIDERS.includes(p as ProviderId)) : []
    if (!CAPS.includes(o.capability as Capability) || typeof o.model !== 'string' || !o.model || !providers.length) {
      warnings.push(`routes.json ${i + 1}번째 줄을 건너뜁니다.`)
      return
    }
    routes.push({ capability: o.capability as Capability, model: o.model, providers, note: typeof o.note === 'string' ? o.note : undefined })
  })
  return routes.length ? { routes, source: 'user', warnings } : { routes: DEFAULT_ROUTES, source: 'default', warnings: [...warnings, '유효한 줄이 없어 기본값을 씁니다.'] }
}

/** 정확히 같은 모델 → 'prefix/*' 접두 일치 → '*' 순으로 찾는다 */
export function findRoute(routes: Route[], capability: Capability, model: string): Route | null {
  const same = routes.filter((r) => r.capability === capability)
  return (
    same.find((r) => r.model === model) ??
    same.find((r) => r.model.endsWith('/*') && model.startsWith(r.model.slice(0, -1))) ??
    same.find((r) => r.model === '*') ??
    null
  )
}
