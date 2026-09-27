// 결과 보관 — 서비스 URL이 사라지기 전에 결과를 옮겨 둔다.
// 지금은 로컬 보관(앱 데이터 폴더)만 있다. 클라우드 저장소(R2)를 붙이면 같은 인터페이스로 교체한다.
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { OutputRecord } from './types.ts'

export interface Archiver {
  /** 보관할 결과인가 */
  wants(o: OutputRecord, now: number): boolean
  /** url에서 받아 보관하고 저장 키를 돌려준다(project가 있으면 그 프로젝트 폴더에) */
  archive(o: OutputRecord, url: string, ctx?: { project?: string | null }): Promise<string>
  /** 보관본을 지운다(없으면 그냥 넘어간다) */
  remove?(storageKey: string): Promise<void>
  /** 저장 키 → 이 PC의 파일 경로(로컬 보관이 아니면 null) */
  localPath?(storageKey: string): string | null
}

const EXT: Record<string, string> = { image: '.png', video: '.mp4', model: '.glb', audio: '.wav', other: '.bin' }
const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'model/gltf-binary': '.glb',
  'audio/wav': '.wav',
  'audio/mpeg': '.mp3'
}

/**
 * 모든 결과를 완료 즉시 로컬로 받는다. 서비스마다 보관 기간이 짧거나(Tripo 5분 링크 · Comfy 파트너 노드 24시간)
 * 정책이 분명하지 않아서, 클라우드 저장소(R2)를 붙이기 전까지는 전부 이 PC에 둔다.
 * 확장자: 주소에 있으면 그것, 없으면(Comfy …/content) 응답 형식 → 결과 종류 순.
 *
 * 보관 위치(저장 키):
 *  - proj:<프로젝트>/<작업>/<결과>.<ext>  → 그 프로젝트 폴더의 assets/ (예: E:\AgentStudio\ArtProjects\Test\assets\)
 *  - lib:<작업>/<결과>.<ext>              → 프로젝트 없는 결과(예: E:\AgentStudio\Library\)
 *  - local:<작업>/<결과>.<ext>            → 예전 보관 위치(<데이터 폴더>/studio/outputs) — 읽기 · 지우기만
 */
export class LocalArchiver implements Archiver {
  private readonly legacy: string
  private readonly library: string
  private readonly projectAssets: (id: string) => string | null

  constructor(opts: string | { legacyDir: string; libraryDir: string; projectAssets?: (id: string) => string | null }) {
    const o = typeof opts === 'string' ? { legacyDir: opts, libraryDir: opts } : opts
    this.legacy = resolve(o.legacyDir)
    this.library = resolve(o.libraryDir)
    this.projectAssets = o.projectAssets ?? (() => null)
  }

  wants(o: OutputRecord): boolean {
    return o.storageKey == null
  }

  /** 저장 키 → (기준 폴더, 상대 경로). 모르는 키 · 기준 폴더 밖은 null */
  private locate(key: string): { base: string; abs: string } | null {
    let base: string | null = null
    let rel = ''
    if (key.startsWith('local:')) (base = this.legacy), (rel = key.slice(6))
    else if (key.startsWith('lib:')) (base = this.library), (rel = key.slice(4))
    else if (key.startsWith('proj:')) {
      const rest = key.slice(5)
      const cut = rest.indexOf('/')
      if (cut <= 0) return null
      const dir = this.projectAssets(rest.slice(0, cut))
      if (dir) (base = resolve(dir)), (rel = rest.slice(cut + 1))
    }
    if (!base) return null
    const abs = resolve(base, rel)
    return abs.startsWith(base + sep) ? { base, abs } : null
  }

  localPath(storageKey: string): string | null {
    return this.locate(storageKey)?.abs ?? null
  }

  async remove(storageKey: string): Promise<void> {
    if (!/^(local|lib|proj):/.test(storageKey)) return
    const at = this.locate(storageKey)
    if (!at) throw new Error('보관 폴더 밖의 경로예요')
    await rm(at.abs, { force: true })
    // 작업 폴더가 비면 폴더도 지운다
    const folder = dirname(at.abs)
    if (folder !== at.base && (await readdir(folder).catch(() => ['x'])).length === 0) await rmdir(folder).catch(() => {})
  }

  async archive(o: OutputRecord, url: string, ctx: { project?: string | null } = {}): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
    if (!res.ok || !res.body) throw new Error(`결과 다운로드 실패 (HTTP ${res.status})`)
    const fromUrl = url.startsWith('file:') ? '' : extname(new URL(url).pathname).toLowerCase()
    const type = (res.headers.get('content-type') ?? o.mime ?? '').split(';')[0].trim().toLowerCase()
    const ext = /^\.[a-z0-9]{2,5}$/.test(fromUrl) ? fromUrl : MIME_EXT[type] ?? EXT[o.kind] ?? '.bin'
    const projDir = ctx.project ? this.projectAssets(ctx.project) : null
    const base = projDir ? resolve(projDir) : this.library
    const rel = `${o.jobId}/${o.id}${ext}`
    const dest = join(base, rel)
    await mkdir(join(base, o.jobId), { recursive: true })
    const tmp = `${dest}.part`
    try {
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp))
      await rename(tmp, dest)
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
    return projDir ? `proj:${ctx.project}/${rel}` : `lib:${rel}`
  }
}
