// API 키 보관함 — Windows DPAPI(현재 사용자 범위)로 암호화해 <home>/studio/secrets.json에 둔다.
//  - 평문은 디스크에도, 명령줄 인자에도 남기지 않는다(PowerShell에 stdin으로만 넘긴다).
//  - DPAPI를 쓸 수 없는 환경에서는 저장을 거부한다(평문 저장 대체 경로 없음).
//  - 저장소 밖(git)으로 나갈 일이 없도록 앱 데이터 폴더에만 쓴다.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ProviderId } from './types.ts'

const PS = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

const ENCRYPT = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security;
$b=[Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd());
[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser')))`
const DECRYPT = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security;
$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());
[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser')))`

function runPs(script: string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') return reject(new Error('DPAPI는 Windows에서만 쓸 수 있어요.'))
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    const t = setTimeout(() => child.kill(), 15000)
    child.on('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(t)
      if (code === 0) resolve(out)
      else reject(new Error(`DPAPI 처리 실패(${code}): ${err.trim().split('\n')[0] ?? ''}`))
    })
    child.stdin.end(input, 'utf8')
  })
}

interface SecretFile {
  version: 1
  keys: Partial<Record<ProviderId, { dpapi: string; updatedAt: number; hint: string }>>
}

/** 키 원문의 끝 4자리만 남긴 표시용 힌트 */
function hintOf(value: string): string {
  const v = value.trim()
  return v.length <= 8 ? '••••' : `••••${v.slice(-4)}`
}

export class SecretStore {
  private readonly file: string
  private readonly cache = new Map<ProviderId, string>()

  constructor(file: string) {
    this.file = file
  }

  private read(): SecretFile {
    if (!existsSync(this.file)) return { version: 1, keys: {} }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as SecretFile
      return raw && raw.version === 1 && raw.keys ? raw : { version: 1, keys: {} }
    } catch {
      return { version: 1, keys: {} }
    }
  }

  private write(f: SecretFile): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(f, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }

  list(): { provider: ProviderId; hint: string; updatedAt: number }[] {
    return Object.entries(this.read().keys).map(([provider, v]) => ({ provider: provider as ProviderId, hint: v!.hint, updatedAt: v!.updatedAt }))
  }

  has(provider: ProviderId): boolean {
    return this.cache.has(provider) || !!this.read().keys[provider]
  }

  async set(provider: ProviderId, value: string): Promise<void> {
    const v = value.trim()
    if (!v) throw new Error('빈 키는 저장하지 않아요.')
    const dpapi = await runPs(ENCRYPT, v)
    const f = this.read()
    f.keys[provider] = { dpapi, updatedAt: Date.now(), hint: hintOf(v) }
    this.write(f)
    this.cache.set(provider, v)
  }

  remove(provider: ProviderId): boolean {
    const f = this.read()
    if (!f.keys[provider]) return false
    delete f.keys[provider]
    this.write(f)
    this.cache.delete(provider)
    return true
  }

  /** 복호화한 키 — 게이트웨이 프로세스 메모리에만 머문다 */
  async get(provider: ProviderId): Promise<string | null> {
    const hit = this.cache.get(provider)
    if (hit) return hit
    const rec = this.read().keys[provider]
    if (!rec) return null
    const v = (await runPs(DECRYPT, rec.dpapi)).trim()
    this.cache.set(provider, v)
    return v
  }

  /** 시작 시 한 번 — 저장된 키를 메모리로 올려 configured()가 동기로 답하게 한다 */
  async preload(): Promise<{ provider: ProviderId; ok: boolean; error?: string }[]> {
    const out: { provider: ProviderId; ok: boolean; error?: string }[] = []
    for (const { provider } of this.list()) {
      try {
        await this.get(provider)
        out.push({ provider, ok: true })
      } catch (e) {
        out.push({ provider, ok: false, error: (e as Error).message })
      }
    }
    return out
  }

  /** 메모리에 올라온 키(동기) — 어댑터가 쓴다 */
  peek(provider: ProviderId): string | null {
    return this.cache.get(provider) ?? null
  }
}
