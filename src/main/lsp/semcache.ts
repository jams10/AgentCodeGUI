import crypto from 'node:crypto'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { APP_HOME } from '../engine/versions'
import type { LspSemanticTokens } from '@shared/protocol'

/* ============================================================
 * 시맨틱 토큰 디스크 캐시 — "켤 때마다 0에서 다시 분석"을 없애는 핵심.
 *
 * LSP 서버 인덱스는 프로세스 안에만 살아서 앱을 끄면 사라지고, 다음 실행 때
 * 서버를 다시 띄워 재인덱싱한다(C#/OmniSharp는 분 단위). 그동안 뷰어는 색이
 * 안 칠해진 채로 기다린다.
 *
 * 그래서 한 번 받은 시맨틱 토큰을 파일 내용 해시로 디스크에 캐시해 둔다:
 *  - 파일을 열면 캐시에서 즉시 색칠(서버를 안 기다림)
 *  - 서버가 ready되면 라이브 토큰을 다시 받아 다르면 갱신 + 캐시 재기록
 *
 * 레이아웃 — 프로젝트(cwd)별 버킷으로 묶는다:
 *   semcache/<basename>-<cwd해시>/   ← 프로젝트 버킷
 *     .root                          ← 원본 cwd 경로(죽은 프로젝트 GC용)
 *     7e/7efc….json                  ← 파일 해시(앞 2글자 = 샤딩 폴더)
 * 프로젝트 단위로 비우기/GC가 되고, 프로젝트를 지우거나 옮기면 그 버킷을
 * 통째로 회수할 수 있다(.root 경로가 사라진 버킷 = 죽은 캐시).
 *
 * 파일 키 = CACHE_VERSION + serverId + 파일 절대경로 + 내용. 내용이 같으면
 * 캐시는 유효하다(내용이 바뀌면 키가 바뀌어 자동 미스). 절대경로가 키에 있어
 * 같은 내용의 다른 파일은 충돌하지 않는다 — 버킷은 수명 관리용일 뿐 충돌
 * 방어는 파일 키가 한다.
 * ============================================================ */

const DIR = path.join(APP_HOME, 'lsp', 'semcache')
// 토큰 직렬화 형태(LspSemanticTokens)나 해석 방식이 바뀌면 올려서 옛 캐시를 버린다
const CACHE_VERSION = 1
// 디스크에 남기는 최대 파일 수(전 프로젝트 합산) — 넘으면 오래된 것부터 정리
const MAX_FILES = 4000
const MISC_BUCKET = '_misc' // cwd를 모르고 들어온 파일(라이브러리 정의 이동 등)

function sanitize(s: string): string {
  return s.replace(/[^\w.\-]/g, '_')
}

/** 이 프로젝트의 캐시를 담을 버킷 폴더. cwd가 없으면 _misc로 모은다. */
function bucketDir(cwd: string): string {
  if (!cwd) return path.join(DIR, MISC_BUCKET)
  const root = path.resolve(cwd)
  const hash = crypto.createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16)
  return path.join(DIR, `${sanitize(path.basename(root)) || 'root'}-${hash}`)
}

function keyFor(serverId: string, absPath: string, content: string): string {
  const h = crypto.createHash('sha1')
  h.update(`v${CACHE_VERSION}\0${serverId}\0${absPath.toLowerCase()}\0`)
  h.update(content)
  return h.digest('hex')
}

// 버킷 안에서도 한 폴더에 수천 파일이 몰리지 않게 앞 2글자로 다시 쪼갠다
function fileFor(cwd: string, key: string): string {
  return path.join(bucketDir(cwd), key.slice(0, 2), key + '.json')
}

/** 죽은 프로젝트 GC가 쓸 원본 경로 마커 — 버킷을 처음 만들 때 한 번만 남긴다. */
async function ensureRootMarker(cwd: string): Promise<void> {
  if (!cwd) return
  try {
    await fsp.writeFile(path.join(bucketDir(cwd), '.root'), path.resolve(cwd), { flag: 'wx' })
  } catch {
    /* 이미 있음(EEXIST) 또는 실패 — 무시 */
  }
}

/** 캐시된 토큰을 읽는다 — 없거나 깨졌으면 null. 서버를 띄우지 않는다. */
export async function getCached(
  cwd: string,
  serverId: string,
  absPath: string,
  content: string
): Promise<LspSemanticTokens | null> {
  try {
    const raw = await fsp.readFile(fileFor(cwd, keyFor(serverId, absPath, content)), 'utf8')
    const o = JSON.parse(raw) as LspSemanticTokens
    if (Array.isArray(o?.data) && Array.isArray(o?.types) && Array.isArray(o?.mods)) return o
  } catch {
    /* 캐시 미스/손상 — 라이브로 폴백 */
  }
  return null
}

/** 라이브로 받은 토큰을 캐시에 기록한다(베스트에포트 — 실패해도 무시). */
export async function setCached(
  cwd: string,
  serverId: string,
  absPath: string,
  content: string,
  tokens: LspSemanticTokens
): Promise<void> {
  try {
    const f = fileFor(cwd, keyFor(serverId, absPath, content))
    await fsp.mkdir(path.dirname(f), { recursive: true })
    await ensureRootMarker(cwd)
    await fsp.writeFile(f, JSON.stringify(tokens))
    if (Math.random() < 0.03) void prune() // 가끔만 — 매 쓰기마다 전체 스캔하지 않게
  } catch {
    /* 캐시는 보조 수단 */
  }
}

/** 원본 폴더가 사라진 프로젝트 버킷을 통째로 지운다(프로젝트 열 때 호출). */
export async function gcDeadBuckets(): Promise<void> {
  try {
    const buckets = await fsp.readdir(DIR).catch(() => [])
    for (const b of buckets) {
      if (b === MISC_BUCKET) continue
      const dir = path.join(DIR, b)
      let root: string
      try {
        root = (await fsp.readFile(path.join(dir, '.root'), 'utf8')).trim()
      } catch {
        continue // 마커 없는(옛/외부) 버킷은 건드리지 않는다
      }
      const alive = await fsp.stat(root).then(() => true).catch(() => false)
      if (!alive) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  } catch {
    /* GC는 베스트에포트 */
  }
}

/** 전체 파일 수가 상한을 넘으면 mtime 오래된 것부터 20%를 지운다. */
async function prune(): Promise<void> {
  try {
    const files: { p: string; mtimeMs: number }[] = []
    const buckets = await fsp.readdir(DIR).catch(() => [])
    for (const b of buckets) {
      const bd = path.join(DIR, b)
      const shards = await fsp.readdir(bd).catch(() => [])
      for (const shard of shards) {
        if (shard === '.root') continue
        const sd = path.join(bd, shard)
        const names = await fsp.readdir(sd).catch(() => [])
        for (const n of names) {
          const p = path.join(sd, n)
          const st = await fsp.stat(p).catch(() => null)
          if (st?.isFile()) files.push({ p, mtimeMs: st.mtimeMs })
        }
      }
    }
    if (files.length <= MAX_FILES) return
    files.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const drop = files.slice(0, Math.ceil(files.length * 0.2))
    await Promise.all(drop.map((f) => fsp.rm(f.p, { force: true }).catch(() => {})))
  } catch {
    /* 정리는 베스트에포트 */
  }
}
