// 이미지 분석 — 사진을 보고 캐릭터 시트 칸(얼굴 · 체형 · 코스튬)을 글로 채운다.
// 분석 엔진은 프로젝트 설정에서 고른다. 지금은 GPT(앱이 설치한 Codex + 앱에 연결한 ChatGPT 계정 — 생성 비용 없음).
// 새 엔진(Grok 등)은 AnalyzeEngine을 하나 더 만들어 ENGINES에 넣으면 된다.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export type AnalyzeKind = 'face' | 'body' | 'costume'

export interface AnalyzeEngine {
  id: string
  name: string
  /** 쓸 수 없으면 이유, 쓸 수 있으면 null */
  unavailable(): string | null
  run(input: { prompt: string; images: string[]; schema: object; model?: string }): Promise<Record<string, unknown>>
}

// ── 칸 정의 — 캐릭터 시트의 칸 id와 같다. 설명은 모델에게 주는 작성 기준 ──
const FIELDS: Record<AnalyzeKind, [string, string][]> = {
  face: [
    ['gender', '성별 (예: 여성)'],
    ['age', '나이대 (예: 20대 후반)'],
    ['faceShape', '얼굴형 — 윤곽 · 폭 · 턱 끝 모양'],
    ['eyes', '눈 — 모양 · 크기 · 쌍꺼풀 · 눈꼬리 · 눈동자 색'],
    ['eyebrows', '눈썹 — 굵기 · 모양 · 색'],
    ['nose', '코 — 콧대 · 콧방울 · 길이'],
    ['mouth', '입 · 입술 — 폭 · 두께 · 입꼬리 모양(표정 말고 생김새)'],
    ['jaw', '턱 · 광대'],
    ['skinTone', '피부 톤 · 질감 · 점이나 주근깨'],
    ['hair', '헤어 — 색 · 길이 · 결 · 가르마 · 앞머리'],
    ['firstImpression', '첫인상 — 얼굴 구조 · 헤어 · 옷차림이 주는 인상 (예: 둥근 얼굴과 짙은 눈썹으로 단단하고 친근한 인상). 표정이 주는 인상은 빼요'],
    ['personality', '성격 · 감정 표현 방식 — 사진의 인상으로 짐작한 캐릭터 설정 (예: 무뚝뚝한 편이라 기뻐도 크게 웃지 않고 눈으로 웃는다). 한두 문장']
  ],
  body: [
    ['proportion', '등신 · 신체 비율 (예: 7.5등신, 다리가 긴 편)'],
    ['bodyDescription', '체형 요약'],
    ['frame', '골격'],
    ['neck', '목'],
    ['shoulderDescription', '어깨'],
    ['chestDescription', '가슴 · 흉곽'],
    ['waistDescription', '허리'],
    ['hipDescription', '골반 · 엉덩이'],
    ['armDescription', '팔'],
    ['legDescription', '다리'],
    ['muscleDescription', '근육'],
    ['fatDescription', '체지방']
  ],
  costume: [
    ['costume', '의상 — 상의 · 하의 · 겉옷을 각각 색 / 소재 / 핏과 함께'],
    ['accessories', '액세서리 · 소지품'],
    ['shoes', '신발'],
    ['heldItem', '손에 든 물건 (없으면 빈 값)']
  ]
}

const RULES: Record<AnalyzeKind, string> = {
  face: '사진 속 인물의 얼굴을 캐릭터 설정용으로 묘사해요. 생김새 칸(얼굴형 · 눈 · 눈썹 · 코 · 입 · 턱 · 피부 · 헤어)에는 표정 · 감정 · 화장 효과 · 조명을 적지 않고 타고난 생김새만 적어요. 첫인상 · 성격 칸은 사진이 주는 인상으로 짐작해 게임 캐릭터 설정처럼 적어요 — 실제 인물을 평가하거나 단정하는 말투는 쓰지 않아요.',
  body: '사진 속 인물의 체형을 캐릭터 설정용으로 묘사해요. 옷 위로 보이는 실루엣을 기준으로 적고, 숫자 치수 · 신체 사이즈 표기 · 성적인 표현은 쓰지 않아요.',
  costume: '사진 속 옷차림을 캐릭터 코스튬 설정용으로 묘사해요. 각 물품의 색 · 소재 · 핏 · 길이 · 특징적인 디테일을 적고, 브랜드 이름과 로고 글자는 적지 않아요.'
}

export function analyzeFields(kind: AnalyzeKind): string[] {
  return FIELDS[kind].map(([id]) => id)
}

export function analyzePrompt(kind: AnalyzeKind): string {
  return [
    RULES[kind],
    '각 칸은 한국어로 짧게(한두 구절) 적어요. 사진에서 보이지 않거나 판단할 수 없는 칸은 빈 문자열로 둬요. JSON으로만 답해요.',
    '',
    ...FIELDS[kind].map(([id, d]) => `- ${id}: ${d}`)
  ].join('\n')
}

export function analyzeSchema(kind: AnalyzeKind): object {
  const ids = analyzeFields(kind)
  return { type: 'object', additionalProperties: false, required: ids, properties: Object.fromEntries(ids.map((id) => [id, { type: 'string' }])) }
}

/** 응답에서 칸 값만 골라 문자열로 */
export function pickFields(kind: AnalyzeKind, raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of analyzeFields(kind)) if (typeof raw[id] === 'string' && raw[id].trim()) out[id] = (raw[id] as string).trim()
  return out
}

// ── GPT(Codex) ─────────────────────────────────────────────
/** 앱이 설치한 Codex 중 가장 새 버전 — 없으면 PATH의 codex */
export function findCodex(appHome: string): string | null {
  if (process.env.CCG_CODEX_BIN) return process.env.CCG_CODEX_BIN
  const root = join(appHome, 'codex-engines')
  if (existsSync(root)) {
    const vers = readdirSync(root).filter((v) => /^\d+\.\d+\.\d+/.test(v)).sort((a, b) => cmpVer(b, a))
    for (const v of vers) {
      const vendor = join(root, v, 'node_modules', '@openai')
      if (!existsSync(vendor)) continue
      for (const pkg of readdirSync(vendor).filter((p) => p.startsWith('codex-'))) {
        const vd = join(vendor, pkg, 'vendor')
        if (!existsSync(vd)) continue
        for (const triple of readdirSync(vd)) {
          const exe = join(vd, triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
          if (existsSync(exe)) return exe
        }
      }
    }
  }
  return null
}

/** 앱에 연결한 ChatGPT 계정의 CODEX_HOME — 로그인 정보(auth.json)가 있는 가장 최근 계정 */
export function findCodexHome(appHome: string): string | null {
  const acc = join(appHome, 'codex', 'accounts')
  if (existsSync(acc)) {
    const homes = readdirSync(acc)
      .map((d) => join(acc, d))
      .filter((d) => existsSync(join(d, 'auth.json')))
      .sort((a, b) => statSync(join(b, 'auth.json')).mtimeMs - statSync(join(a, 'auth.json')).mtimeMs)
    if (homes[0]) return homes[0]
  }
  const own = process.env.CODEX_HOME || join(homedir(), '.codex')
  return existsSync(join(own, 'auth.json')) ? own : null
}

function cmpVer(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0)
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

export class CodexEngine implements AnalyzeEngine {
  readonly id = 'codex'
  readonly name = 'GPT (ChatGPT 계정 · Codex)'
  private appHome: string
  private timeoutMs: number
  constructor(appHome: string, timeoutMs = 180_000) {
    this.appHome = appHome
    this.timeoutMs = timeoutMs
  }

  unavailable(): string | null {
    if (!findCodex(this.appHome)) return 'Codex(GPT 엔진)가 설치되어 있지 않아요 — 설정에서 GPT 계정을 연결하면 설치돼요'
    if (!findCodexHome(this.appHome)) return 'ChatGPT 계정이 연결되어 있지 않아요 — 설정 → 계정에서 연결해 주세요'
    return null
  }

  run({ prompt, images, schema, model }: { prompt: string; images: string[]; schema: object; model?: string }): Promise<Record<string, unknown>> {
    const why = this.unavailable()
    if (why) return Promise.reject(new Error(why))
    const exe = findCodex(this.appHome) as string
    const work = mkdtempSync(join(tmpdir(), 'studio-analyze-'))
    const schemaFile = join(work, 'schema.json')
    const outFile = join(work, 'out.json')
    writeFileSync(schemaFile, JSON.stringify(schema))
    // 읽기 전용 · 기록 없음 · 빈 작업 폴더 — 분석만 하고 파일이나 명령은 건드리지 않는다
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-C', work, '--output-schema', schemaFile, '-o', outFile]
    if (model) args.push('-m', model)
    for (const img of images) args.push('-i', img)
    args.push('-')
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { cwd: work, env: { ...process.env, CODEX_HOME: findCodexHome(this.appHome) as string }, windowsHide: true })
      let err = ''
      child.stderr.on('data', (c: Buffer) => (err = (err + c.toString('utf8')).slice(-4000)))
      child.stdout.on('data', (c: Buffer) => (err = (err + c.toString('utf8')).slice(-4000)))
      const timer = setTimeout(() => child.kill(), this.timeoutMs)
      const done = (e: Error | null, v?: Record<string, unknown>): void => {
        clearTimeout(timer)
        rmSync(work, { recursive: true, force: true })
        if (e) reject(e)
        else resolve(v as Record<string, unknown>)
      }
      child.on('error', (e) => done(new Error(`GPT 분석을 시작하지 못했어요: ${e.message}`)))
      child.on('close', (code) => {
        try {
          const text = existsSync(outFile) ? readFileSync(outFile, 'utf8').trim() : ''
          if (!text) return done(new Error(`GPT 분석 실패(코드 ${code}) — ${lastLine(err) || '응답이 없어요'}`))
          const m = text.match(/\{[\s\S]*\}/)
          done(null, JSON.parse(m ? m[0] : text) as Record<string, unknown>)
        } catch (e) {
          done(new Error(`GPT 분석 응답을 읽지 못했어요: ${(e as Error).message}`))
        }
      })
      child.stdin.end(prompt, 'utf8')
    })
  }
}

function lastLine(s: string): string {
  return s.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^tokens used|^\d[\d,]*$/.test(l)).slice(-2).join(' ')
}

/** 분석 엔진 목록 — 프로젝트 설정의 analysisEngine과 id가 같다 */
export function makeEngines(appHome: string): AnalyzeEngine[] {
  return [new CodexEngine(appHome)]
}
