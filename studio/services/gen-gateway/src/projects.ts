// 아트 프로젝트 — 프로젝트 하나 = 폴더 하나(기본 E:\AgentStudio\ArtProjects\<이름>).
//   project.json        프로젝트 설정(이름 · 피할 것) — 모든 도구 공통
//   tools/<도구>.json   도구별 설정(예: 캐릭터 시트의 공통 규칙 · 출력 규격 · 기본 복장 · 분석 엔진)
//   CLAUDE.md · AGENTS.md  AI가 채팅을 시작할 때 자동으로 읽는 프로젝트 지침(설정 요약 + 작업 규칙)
//   characters/         캐릭터 시트 파일
//   assets/             생성 결과(게이트웨이가 완료 즉시 보관)
//   exports/            스프라이트 시트 등 최종 산출물
// 분위기(테마)는 따로 두지 않는다 — 의상 · 소품 · 배경 묘사로 직접 만든다. 게이트웨이는 요청을 프로젝트로 분류하고
// "피할 것"만 붙인다(네거티브를 받는 모델은 negative_prompt로).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { GenerationRequest } from './types.ts'

export interface ProjectSettings {
  /** 모든 생성에서 피할 것 — 네거티브를 받는 모델은 negative_prompt로, 나머지는 금지 문구로 */
  avoid: string
}

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  settings: ProjectSettings
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  avoid: ''
}

/**
 * 예전에 프로젝트 설정에 있던 캐릭터 시트 전용 값 — 이제 도구 설정(tools/character-sheet.json)에 있다.
 * 예전 project.json을 읽으면 이 값들을 도구 설정으로 옮긴다(도구 설정이 아직 없을 때만).
 */
const LEGACY_SHEET_KEYS = ['rules', 'portraitRatio', 'fullRatio', 'background', 'model', 'quality', 'videoSeconds', 'videoResolution', 'baseOutfit', 'analysisEngine', 'analysisModel']
const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,40}$/

/** 폴더 이름으로 쓸 수 있게 — Windows 금지 문자 · 끝의 점/공백 제거 */
export function folderName(name: string): string {
  const s = name.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[.\s]+$/g, '').trim().slice(0, 60)
  if (!s || /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) throw new Error('프로젝트 이름으로 쓸 수 없어요')
  return s
}

const MARK_BEGIN = '<!-- agentstudio:begin — 앱이 관리하는 구역. 이 아래 · 위에 자유롭게 적어도 되지만, 이 구역 안은 설정을 바꾸면 다시 써져요 -->'
const MARK_END = '<!-- agentstudio:end -->'

export class ProjectStore {
  readonly root: string

  constructor(root: string) {
    this.root = resolve(root)
  }

  dir(id: string): string {
    const d = resolve(this.root, id)
    if (!d.startsWith(this.root + sep) || relative(this.root, d).includes(sep)) throw new Error('프로젝트 경로가 올바르지 않아요')
    return d
  }
  assetsDir(id: string): string {
    return join(this.dir(id), 'assets')
  }
  charactersDir(id: string): string {
    return join(this.dir(id), 'characters')
  }

  list(): Project[] {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(this.root, d.name, 'project.json')))
      .map((d) => this.get(d.name))
      .filter((p): p is Project => !!p)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Project | null {
    try {
      const f = join(this.dir(id), 'project.json')
      if (!existsSync(f)) return null
      const j = JSON.parse(readFileSync(f, 'utf8')) as Partial<Project>
      const p: Project = { id, name: j.name || id, createdAt: j.createdAt ?? 0, updatedAt: j.updatedAt ?? 0, settings: normalize(j.settings ?? {}) }
      const raw = (j.settings ?? {}) as Record<string, unknown>
      const legacy = Object.fromEntries(LEGACY_SHEET_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]))
      if (Object.keys(legacy).length) {
        // 예전 형식 — 캐릭터 시트 값을 도구 설정으로 옮기고 project.json을 새 형식으로 다시 쓴다
        if (!this.toolSettings(id, 'character-sheet')) this.setToolSettings(id, 'character-sheet', legacy)
        this.write(p)
      }
      return p
    } catch {
      return null
    }
  }

  create(name: string, settings: Partial<ProjectSettings> = {}): Project {
    const id = folderName(name)
    const d = this.dir(id)
    if (existsSync(join(d, 'project.json'))) throw new Error(`'${id}' 프로젝트가 이미 있어요`)
    for (const sub of ['', 'characters', 'assets', 'exports']) mkdirSync(join(d, sub), { recursive: true })
    const now = Date.now()
    const p: Project = { id, name: name.trim(), createdAt: now, updatedAt: now, settings: normalize(settings) }
    this.write(p)
    return p
  }

  update(id: string, patch: { name?: string; settings?: Partial<ProjectSettings> }): Project {
    const p = this.get(id)
    if (!p) throw new Error('프로젝트를 찾지 못했어요')
    const next: Project = { ...p, name: patch.name?.trim() || p.name, updatedAt: Date.now(), settings: normalize({ ...p.settings, ...(patch.settings ?? {}) }) }
    this.write(next)
    return next
  }

  /** 도구 설정 — <프로젝트>/tools/<도구 id>.json. 없으면 null */
  toolSettings(id: string, toolId: string): Record<string, unknown> | null {
    if (!TOOL_ID.test(toolId)) throw new Error('도구 id가 올바르지 않아요')
    const f = join(this.dir(id), 'tools', `${toolId}.json`)
    if (!existsSync(f)) return null
    try {
      const v = JSON.parse(readFileSync(f, 'utf8')) as unknown
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  setToolSettings(id: string, toolId: string, value: Record<string, unknown>): Record<string, unknown> {
    if (!TOOL_ID.test(toolId)) throw new Error('도구 id가 올바르지 않아요')
    const d = join(this.dir(id), 'tools')
    mkdirSync(d, { recursive: true })
    const tmp = join(d, `${toolId}.json.tmp`)
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, join(d, `${toolId}.json`))
    return value
  }

  /** 작업 폴더(채팅의 cwd 등)가 어느 프로젝트 안인지 */
  projectOfPath(path: string | undefined | null): string | null {
    if (!path) return null
    const rel = relative(this.root, resolve(path))
    if (!rel || rel.startsWith('..') || resolve(this.root, rel) === this.root) return null
    const id = rel.split(sep)[0]
    return id && this.get(id) ? id : null
  }

  private write(p: Project): void {
    const d = this.dir(p.id)
    mkdirSync(d, { recursive: true })
    const tmp = join(d, 'project.json.tmp')
    writeFileSync(tmp, JSON.stringify(p, null, 2), 'utf8')
    renameSync(tmp, join(d, 'project.json'))
    // AI 지침 — Claude는 CLAUDE.md, Codex(GPT)는 AGENTS.md를 자동으로 읽는다. 앱이 관리하는 구역만 바꾼다
    for (const f of ['CLAUDE.md', 'AGENTS.md']) {
      const file = join(d, f)
      const old = existsSync(file) ? readFileSync(file, 'utf8') : ''
      const managed = `${MARK_BEGIN}\n${guide(p)}\n${MARK_END}`
      const a = old.indexOf(MARK_BEGIN)
      const b = old.indexOf(MARK_END)
      const text = a >= 0 && b > a ? old.slice(0, a) + managed + old.slice(b + MARK_END.length) : old ? `${old.trimEnd()}\n\n${managed}\n` : `${managed}\n`
      writeFileSync(file, text, 'utf8')
    }
  }
}

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof ProjectSettings)[]

/** 설정 정리 — 빈 값은 시작값으로, 모르는 값(예전 테마 설정 등)은 버린다 */
export function normalize(raw: Partial<ProjectSettings>): ProjectSettings {
  const s = { ...DEFAULT_SETTINGS } as Record<string, unknown>
  for (const k of KEYS) if (raw[k] !== undefined && raw[k] !== null) s[k] = raw[k]
  return s as unknown as ProjectSettings
}

/** 프로젝트 지침(CLAUDE.md / AGENTS.md 관리 구역) */
function guide(p: Project): string {
  const s = p.settings
  return [
    `# 아트 프로젝트 · ${p.name}`,
    '',
    '이 폴더는 AgentStudio의 아트 프로젝트예요. 이미지 · 영상 · 3D 생성은 `agentstudio-gen` MCP 도구로 요청해요(사용자가 앱의 승인 카드에서 승인해야 실행돼요).',
    '',
    '## 설정',
    '- 분위기는 따로 정하지 않아요 — 의상 · 소품 · 배경 · 조명 묘사로 만들어요.',
    s.avoid ? `- 피할 것(게이트웨이가 모든 이미지 · 영상 요청에 자동으로 붙여요): ${s.avoid}` : '',
    '',
    '## 폴더',
    '- `characters/` 캐릭터 시트(JSON) — 캐릭터 외형 · 기준 이미지 · 상태 진행 기록. 캐릭터 작업 전에 해당 파일을 읽어요.',
    '- `tools/` 도구 설정(JSON) — 예: `tools/character-sheet.json`에 캐릭터 제작 공통 규칙 · 출력 규격 · 공통 기본 복장이 있어요. 캐릭터 이미지를 만들 때는 이 값을 따라요.',
    '- `assets/` 생성 결과(자동 보관) · `references/` 올린 참고 사진 · `exports/` 스프라이트 시트 등 최종 산출물',
    '',
    '## 작업 규칙',
    '- 한 채팅에서는 한 가지 작업만 해요. 끝나면 결정한 내용을 이 파일이나 캐릭터 파일에 남기고 새 채팅에서 이어가요.',
    '- 기존 캐릭터의 새 이미지는 확정한 기준 이미지를 참조 입력(inputs의 outputId)으로 넣어 만들어요.',
    '- 스캔라인 · 노이즈 · VHS 같은 화면 효과는 생성 단계에서 넣지 않아요(스프라이트를 만들 때 일괄 처리).'
  ]
    .filter((l) => l !== '')
    .join('\n')
    .replace(/\n#/g, '\n\n#')
}

/**
 * 요청을 프로젝트로 분류하고 "피할 것"을 붙인다(이미지 · 영상만). 원래 프롬프트는 origin.userPrompt에 남긴다 — 다시 만들 때 두 번 붙지 않게.
 */
export function applyProject(req: GenerationRequest, p: Project, takesNegative: boolean): GenerationRequest {
  const origin = { ...(req.origin ?? {}), project: p.id }
  const s = p.settings
  if ((req.capability !== 'image' && req.capability !== 'video') || !s.avoid) return { ...req, origin }
  const base = req.prompt ?? ''
  let prompt = base
  let params = req.params
  if (takesNegative && params?.negative_prompt == null) params = { ...(params ?? {}), negative_prompt: s.avoid }
  else if (!takesNegative && !prompt.includes(s.avoid)) prompt = req.capability === 'image' ? `${prompt}

[피할 것] ${s.avoid}` : `${prompt} Avoid: ${s.avoid}`
  return { ...req, prompt: prompt || undefined, params, origin: { ...origin, userPrompt: req.origin?.userPrompt ?? base } }
}
