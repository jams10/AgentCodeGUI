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
 */
export class LocalArchiver implements Archiver {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
  }

  wants(o: OutputRecord): boolean {
    return o.storageKey == null
  }

  async archive(o: OutputRecord, url: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) })
    if (!res.ok || !res.body) throw new Error(`결과 다운로드 실패 (HTTP ${res.status})`)
    const fromUrl = extname(new URL(url).pathname).toLowerCase()
    const type = (res.headers.get('content-type') ?? o.mime ?? '').split(';')[0].trim().toLowerCase()
    const ext = /^\.[a-z0-9]{2,5}$/.test(fromUrl) ? fromUrl : MIME_EXT[type] ?? EXT[o.kind] ?? '.bin'
    const rel = join(o.jobId, `${o.id}${ext}`)
    const dest = join(this.dir, rel)
    await mkdir(join(this.dir, o.jobId), { recursive: true })
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
