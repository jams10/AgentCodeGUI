// 결과 보관 — 서비스 URL이 사라지기 전에 결과를 옮겨 둔다.
// 지금은 로컬 보관(앱 데이터 폴더)만 있다. 클라우드 저장소(R2)를 붙이면 같은 인터페이스로 교체한다.
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { OutputRecord } from './types.ts'

export interface Archiver {
  /** 보관할 결과인가 */
  wants(o: OutputRecord, now: number): boolean
  /** url에서 받아 보관하고 저장 키를 돌려준다 */
  archive(o: OutputRecord, url: string): Promise<string>
}

const EXT: Record<string, string> = { image: '.png', video: '.mp4', model: '.glb', audio: '.wav', other: '.bin' }

/** 곧 만료되는 결과만 로컬로 받는다(기본 1시간 이내 만료) */
export class LocalArchiver implements Archiver {
  private readonly dir: string
  private readonly withinMs: number

  constructor(dir: string, withinMs = 60 * 60 * 1000) {
    this.dir = dir
    this.withinMs = withinMs
  }

  wants(o: OutputRecord, now: number): boolean {
    return o.storageKey == null && o.expiresAt != null && o.expiresAt - now < this.withinMs
  }

  async archive(o: OutputRecord, url: string): Promise<string> {
    const clean = new URL(url).pathname
    const ext = /^\.[a-z0-9]{2,5}$/i.test(extname(clean)) ? extname(clean).toLowerCase() : EXT[o.kind] ?? '.bin'
    const rel = join(o.jobId, `${o.id}${ext}`)
    const dest = join(this.dir, rel)
    await mkdir(join(this.dir, o.jobId), { recursive: true })
    const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
    if (!res.ok || !res.body) throw new Error(`결과 다운로드 실패 (HTTP ${res.status})`)
    const tmp = `${dest}.part`
    try {
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(tmp))
      await rename(tmp, dest)
    } catch (e) {
      await rm(tmp, { force: true })
      throw e
    }
    return `local:${rel.replaceAll('\\', '/')}`
  }
}
