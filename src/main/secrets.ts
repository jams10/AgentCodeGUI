import path from 'node:path'
import fs from 'node:fs'
import { safeStorage } from 'electron'
import { APP_HOME } from './engine/versions'
import { writeFileAtomic } from './atomicWrite'
import { t } from './lang'
import type { SecretInfo } from '@shared/protocol'

// Keys — API 키·시크릿 보관함(설정 → Keys). MCP 서버가 요구하는 API 키(HIGGSFIELD_API_KEY,
// COMFY_API_KEY …)를 한 번 넣어두면 앱의 모든 대화·모든 계정 실행에서 쓰인다.
//  - 값은 apiConfig.ts와 같은 규칙으로 보관: safeStorage(Windows DPAPI) 암호화(enc:true),
//    암호화를 못 쓰는 환경만 평문(enc:false). 원문은 이 모듈 밖(특히 렌더러)으로 안 나간다.
//  - 쓰임 두 가지: ① env=true 항목은 엔진 자식 프로세스(Claude Code·Codex)의 환경변수로
//    주입 — 스킬·스크립트·stdio MCP 서버가 process.env에서 바로 읽는다. ② MCP 서버 설정
//    (env/args/headers/url/command)의 `${NAME}` / `${NAME:-기본값}`을 실행 직전에 치환한다
//    (Claude Code의 .mcp.json 변수 확장 문법과 동일 — 여기선 보관함 → process.env 순).
const STORE_PATH = path.join(APP_HOME, 'secrets.json')

interface StoredSecret {
  name: string
  value: string // base64(safeStorage 암호문) 또는 평문(enc:false)
  enc: boolean
  tail: string
  env: boolean
  note?: string
  updatedAt: number
}
interface StoreFile {
  version: 1
  items: StoredSecret[]
}

/** 환경변수 이름 규칙 — MCP 설정의 ${NAME} 참조와 env 주입 둘 다 이 형태여야 한다. */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

// env 주입이 실행 자체를 바꿔버리는 이름 — 과금 주체(API 키)·config 위치를 보관함 항목이
// 가로채지 못하게 환경변수 주입만 막는다(${NAME} 참조는 허용 — MCP 서버 env로 넘기는 용도).
const RESERVED_ENV = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_HOME',
  'PATH',
  'HOME',
  'USERPROFILE'
])
export function isReservedEnvName(name: string): boolean {
  return RESERVED_ENV.has(name.toUpperCase())
}

function read(): StoredSecret[] {
  try {
    const v = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')) as StoreFile
    return Array.isArray(v?.items) ? v.items.filter((s) => s && typeof s.name === 'string' && typeof s.value === 'string') : []
  } catch {
    return []
  }
}
function write(items: StoredSecret[]): void {
  fs.mkdirSync(APP_HOME, { recursive: true })
  const file: StoreFile = { version: 1, items }
  writeFileAtomic(STORE_PATH, JSON.stringify(file, null, 2))
}

function encode(raw: string): { value: string; enc: boolean } {
  if (safeStorage.isEncryptionAvailable()) return { value: safeStorage.encryptString(raw).toString('base64'), enc: true }
  return { value: raw, enc: false }
}
function decode(s: StoredSecret): string | null {
  if (!s.enc) return s.value
  try {
    return safeStorage.decryptString(Buffer.from(s.value, 'base64'))
  } catch {
    return null // 다른 OS 계정/머신에서 복사된 파일 — 복호화 불가면 없는 것으로
  }
}

function toInfo(s: StoredSecret): SecretInfo {
  const envLocked = isReservedEnvName(s.name)
  return { name: s.name, tail: s.tail, env: s.env && !envLocked, envLocked, note: s.note ?? '', updatedAt: s.updatedAt }
}

/** 렌더러용 목록 — 값 원문 없이 이름·끝 4자리·주입 여부만. 이름순. */
export function listSecrets(): SecretInfo[] {
  return read()
    .map(toInfo)
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 추가/변경. 같은 이름이면 값(과 주어진 옵션)만 갱신 — env/note를 생략하면 기존 값 유지. */
export function setSecret(name: string, value: string, opts: { env?: boolean; note?: string } = {}): SecretInfo[] {
  const nm = name.trim()
  if (!SECRET_NAME_RE.test(nm)) {
    throw new Error(
      t('이름은 환경변수 규칙(영문·숫자·밑줄, 숫자로 시작 불가)이어야 해요.', 'Name must follow env-var rules (letters, digits, underscore; not starting with a digit).')
    )
  }
  const raw = value.trim()
  if (!raw) throw new Error(t('값이 비어 있어요.', 'Value is empty.'))
  const items = read()
  const idx = items.findIndex((s) => s.name === nm)
  const prev = idx >= 0 ? items[idx] : null
  const { value: enc, enc: isEnc } = encode(raw)
  const next: StoredSecret = {
    name: nm,
    value: enc,
    enc: isEnc,
    tail: raw.slice(-4),
    env: opts.env ?? prev?.env ?? true,
    note: (opts.note ?? prev?.note ?? '').trim() || undefined,
    updatedAt: Date.now()
  }
  if (idx >= 0) items[idx] = next
  else items.push(next)
  write(items)
  return listSecrets()
}

export function removeSecret(name: string): SecretInfo[] {
  write(read().filter((s) => s.name !== name))
  return listSecrets()
}

export function setSecretEnv(name: string, env: boolean): SecretInfo[] {
  const items = read()
  const s = items.find((x) => x.name === name)
  if (s) {
    s.env = env && !isReservedEnvName(name)
    s.updatedAt = Date.now()
    write(items)
  }
  return listSecrets()
}

/** 모든 항목의 원문 맵 — ${NAME} 치환용(메인 전용). 복호화 실패 항목은 빠진다. */
export function secretValues(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of read()) {
    const v = decode(s)
    if (v != null) out[s.name] = v
  }
  return out
}

/** env=true 항목만 — 엔진 자식 프로세스 환경변수로 펼친다(예약 이름 제외). */
export function secretEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of read()) {
    if (!s.env || isReservedEnvName(s.name)) continue
    const v = decode(s)
    if (v != null) out[s.name] = v
  }
  return out
}

// `${NAME}` / `${NAME:-default}` 치환 — 보관함 → process.env 순으로 찾고, 어디에도 없으면
// 기본값, 그것도 없으면 원문 그대로 둔다(CLI가 자기 확장 규칙으로 한 번 더 볼 수 있게).
const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g
export function expandSecretRefs(input: string, values: Record<string, string> = secretValues()): string {
  return input.replace(REF_RE, (whole, name: string, def: string | undefined) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) return values[name]
    const env = process.env[name]
    if (typeof env === 'string') return env
    return def !== undefined ? def : whole
  })
}

/** 객체/배열 안의 모든 문자열에 expandSecretRefs — MCP 서버 설정 한 벌을 통째로 치환. */
export function expandDeep<T>(value: T, values: Record<string, string> = secretValues()): T {
  if (typeof value === 'string') return expandSecretRefs(value, values) as unknown as T
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, values)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandDeep(v, values)
    return out as T
  }
  return value
}
