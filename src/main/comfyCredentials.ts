import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { codexBin } from './codex/versions'
import { ComfyRefreshError, isRevokedComfyAuth, waitForComfyConnection } from './comfyRefresh'

export const COMFY_MCP_URL = 'https://cloud.comfy.org/mcp'
const exec = promisify(execFile)
type Credential = { accessToken: string; expiresAt: number | null }
const decoded = new Map<string, { signature: string; credential: Credential | null }>()

// Read exactly the native Codex MCP keyring entry. Secrets stay in main-process
// memory; no values go in argv, logs, renderer IPC, or a plaintext export file.
async function nativeKeyringPassword(account: string): Promise<string> {
  if (process.platform === 'darwin') {
    return (await exec('/usr/bin/security', ['find-generic-password', '-s', 'codex', '-a', account, '-w'], { timeout: 10_000 })).stdout.trim()
  }
  if (process.platform !== 'win32') throw new Error('Unsupported native credential store')
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CreditCredentialReader {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct Credential {
  public uint Flags, Type; public string TargetName, Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public uint BlobSize; public IntPtr Blob; public uint Persist, AttributeCount;
  public IntPtr Attributes; public string TargetAlias, UserName;
 }
 [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
 [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
 public static string Load(string target) {
  IntPtr pointer;
  if (!Read(target, 1, 0, out pointer)) throw new InvalidOperationException("Credential unavailable");
  try {
   var c=(Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
   return Marshal.PtrToStringUni(c.Blob, (int)c.BlobSize / 2);
  } finally { CredFree(pointer); }
 }
}
'@
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Write([CreditCredentialReader]::Load($env:CCG_CREDIT_CREDENTIAL_TARGET))`
  const shell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return (await exec(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
    env: { ...process.env, CCG_CREDIT_CREDENTIAL_TARGET: `${account}.codex` }
  })).stdout
}

export function comfyCredentialSignature(home: string): string {
  return ['secrets/mcp_oauth.age', '.credentials.json'].map(file => {
    try { const s = fs.statSync(path.join(home, file)); return `${s.mtimeMs}:${s.size}` } catch { return '-' }
  }).join('|')
}

export async function readNativeComfyCredential(home: string): Promise<Credential | null> {
  const signature = comfyCredentialSignature(home)
  const previous = decoded.get(home)
  if (previous?.signature === signature) return previous.credential
  let credential: Credential | null = null
  const encryptedFile = path.join(home, 'secrets', 'mcp_oauth.age')
  if (fs.existsSync(encryptedFile)) {
    // Codex 0.153.4: secrets/src/lib.rs hashes Rust's canonicalized CODEX_HOME.
    const real = fs.realpathSync.native(home)
    const canonical = process.platform === 'win32' ? path.toNamespacedPath(real) : real
    const account = 'secrets|' + createHash('sha256').update(canonical).digest('hex').slice(0, 16)
    const password = await nativeKeyringPassword(account)
    const { Decrypter } = await import('age-encryption')
    const decrypter = new Decrypter()
    decrypter.addPassphrase(password)
    const file = fs.readFileSync(encryptedFile)
    if (file.length > 2_000_000) throw new Error('Unexpected credential store size')
    const body = JSON.parse(await decrypter.decrypt(file, 'text'))
    if (body.version !== 1 || !body.secrets || typeof body.secrets !== 'object') throw new Error('Unknown credential format')
    for (const value of Object.values(body.secrets)) {
      if (typeof value !== 'string') continue
      const entry = JSON.parse(value)
      if (entry.url !== COMFY_MCP_URL || !['comfy-cloud', 'local:comfy-cloud'].includes(entry.server_name)) continue
      if (typeof entry.token_response?.access_token === 'string') {
        credential = { accessToken: entry.token_response.access_token, expiresAt: typeof entry.expires_at === 'number' ? entry.expires_at : null }
      }
    }
  } else {
    // Codex's supported file fallback, for installations without a native keyring.
    try {
      const body = JSON.parse(fs.readFileSync(path.join(home, '.credentials.json'), 'utf8'))
      for (const entry of Object.values(body) as Record<string, unknown>[]) {
        if (entry?.server_url === COMFY_MCP_URL && entry.server_name === 'comfy-cloud' && typeof entry.access_token === 'string') {
          credential = { accessToken: entry.access_token, expiresAt: typeof entry.expires_at === 'number' ? entry.expires_at : null }
        }
      }
    } catch { /* no file credential */ }
  }
  decoded.set(home, { signature, credential })
  return credential
}

const refreshing = new Map<string, Promise<void>>()
/** Let Codex itself refresh/persist OAuth under its native store locks. No model
 * turn is started, and the app never rewrites Codex's credential files. */
export function refreshNativeComfyCredential(home: string): Promise<void> {
  const existing = refreshing.get(home)
  if (existing) return existing
  const promise = (async () => {
    const child = spawn(codexBin(), ['--enable', 'mcp_oauth_refresh_coordination', 'app-server'], {
      shell: process.platform === 'win32', windowsHide: true,
      env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], cwd: home
    })
    let seq = 0, buffer = '', stopped = false, revoked = false, connected = false, diagnosticTail = ''
    const stop = async (): Promise<void> => {
      if (child.exitCode !== null) return
      if (child.pid && process.platform === 'win32') {
        try { await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }) } catch { /* already exited */ }
      } else child.kill()
    }
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
    const fail = (error = new ComfyRefreshError(revoked ? 'auth-required' : 'unavailable', revoked ? 'revoked' : 'process')): void => {
      stopped = true; for (const p of pending.values()) p.reject(error); pending.clear()
    }
    child.on('error', () => fail()); child.on('exit', () => fail())
    child.stdin.on('error', () => fail())
    child.stderr.on('data', chunk => {
      diagnosticTail = (diagnosticTail + chunk.toString()).slice(-4096)
      revoked ||= isRevokedComfyAuth(diagnosticTail)
    })
    const deadline = setTimeout(() => fail(new ComfyRefreshError('unavailable', 'timeout')), 55_000)
    child.stdout.on('data', chunk => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        try {
          const msg = JSON.parse(line), p = pending.get(msg.id)
          if (p) { pending.delete(msg.id); msg.error ? p.reject(new ComfyRefreshError(revoked ? 'auth-required' : 'unavailable', revoked ? 'revoked' : 'connection')) : p.resolve(msg.result) }
        } catch { /* native diagnostics are not forwarded */ }
      }
    })
    const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
      if (stopped) { reject(new ComfyRefreshError('unavailable', 'process')); return }
      const id = ++seq; pending.set(id, { resolve, reject }); child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
    })
    try {
      await rpc('initialize', { clientInfo: { name: 'comfy-credit-refresh', version: '1' }, capabilities: { experimentalApi: true } })
      const { thread } = await rpc('thread/start', { cwd: home, approvalPolicy: 'never', sandbox: 'read-only', config: {
        features: { apps: false, mcp_oauth_refresh_coordination: true }, mcp_servers: { 'comfy-cloud': { url: COMFY_MCP_URL, enabled: true, startup_timeout_sec: 30 } }
      } })
      await waitForComfyConnection(() => rpc('mcpServerStatus/list', { threadId: thread.id }), () => revoked)
      connected = true
    } finally {
      clearTimeout(deadline); fail(); decoded.delete(home)
      if (connected || revoked) await stop()
      // A rotating refresh request may have outlived MCP's startup timeout.
      // Give native Codex's bounded transaction time to persist its response.
      else setTimeout(() => { void stop() }, 75_000).unref()
    }
  })().finally(() => refreshing.delete(home))
  refreshing.set(home, promise)
  return promise
}
