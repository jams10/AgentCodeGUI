// 아트 프로젝트 — 프로젝트 하나 = 폴더 하나(기본 E:\AgentStudio\ArtProjects\<이름>).
//   project.json        앱 설정(공통 제작 규칙 · 피할 것 · 비율 · 기본 모델 · 영상 설정)
//   CLAUDE.md · AGENTS.md  AI가 채팅을 시작할 때 자동으로 읽는 프로젝트 지침(설정 요약 + 작업 규칙)
//   characters/         캐릭터 시트 파일
//   assets/             생성 결과(게이트웨이가 완료 즉시 보관)
//   exports/            스프라이트 시트 등 최종 산출물
// 분위기(테마)는 따로 두지 않는다 — 의상 · 소품 · 배경 묘사로 직접 만든다. 게이트웨이는 요청을 프로젝트로 분류하고
// "피할 것"만 붙인다(네거티브를 받는 모델은 negative_prompt로).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { GenerationRequest } from './types.ts'

/** 캐릭터 제작 공통 규칙 시작값 — 프로젝트 설정에서 고친다(한 줄에 하나) */
export const DEFAULT_RULES = [
  '완전히 가상의 인물 한 명. 설정한 외모를 임의로 미화하거나 과장하지 않는다.',
  '첫인상을 표현하려고 미소 · 분노 · 피로 같은 상태를 추가하지 않는다.',
  '중립적인 정면 조명, 실제 피부 질감, 고른 노출. 과도한 보정 · 광각 왜곡 · 극적인 역광 없음.',
  '스캔라인 · 노이즈 · VHS 번짐 같은 화면 효과는 넣지 않는다(나중에 일괄 후처리).',
  '글자 · 이름표 · 치수선 · UI · 체력바 · 테두리 · 콜라주 · 추가 인물 없음.'
].join('\n')

export interface ProjectSettings {
  /** 캐릭터 제작 공통 규칙(한 줄에 하나) — 캐릭터 시트 프롬프트와 AI 지침에 들어간다 */
  rules: string
  /** 모든 생성에서 피할 것 — 네거티브를 받는 모델은 negative_prompt로, 나머지는 금지 문구로 */
  avoid: string
  portraitRatio: string
  fullRatio: string
  background: string
  model: string
  quality: string
  videoSeconds: number
  videoResolution: string
}

export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  settings: ProjectSettings
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  rules: DEFAULT_RULES,
  avoid: '',
  portraitRatio: '4:5',
  fullRatio: '2:3',
  background: '밝은 회색 단색 배경',
  model: 'gpt-image-2.5-sunburst',
  quality: 'medium',
  videoSeconds: 4,
  videoResolution: '480p'
}

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
      return { id, name: j.name || id, createdAt: j.createdAt ?? 0, updatedAt: j.updatedAt ?? 0, settings: normalize(j.settings ?? {}) }
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
  return { ...(s as unknown as ProjectSettings), rules: typeof s.rules === 'string' ? s.rules : DEFAULT_RULES }
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
    `- 기본 비율: 상반신 ${s.portraitRatio} · 전신 ${s.fullRatio}, 배경: ${s.background}`,
    `- 기본 이미지 모델: ${s.model} (품질 ${s.quality}) · 영상: ${s.videoSeconds}초 ${s.videoResolution}`,
    '',
    '## 폴더',
    '- `characters/` 캐릭터 시트(JSON) — 캐릭터 외형 · 기준 이미지 · 상태 진행 기록. 캐릭터 작업 전에 해당 파일을 읽어요.',
    '- `assets/` 생성 결과(자동 보관) · `exports/` 스프라이트 시트 등 최종 산출물',
    '',
    '## 캐릭터 제작 공통 규칙',
    ...s.rules.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `- ${l}`),
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
