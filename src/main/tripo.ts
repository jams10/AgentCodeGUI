import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { APP_HOME } from './engine/versions'
import { appServers, listMcpServers, setMcpEnabled, upsertAppServer } from './mcp'
import { listSecrets, secretValues, setSecret } from './secrets'
import { t } from './lang'
import type { McpServerSpec, TripoStatus, TripoConnectionResult } from '@shared/protocol'

export const TRIPO_SERVER = 'tripo'
export const TRIPO_KEY = 'TRIPO_API_KEY'
export const TRIPO_CLI_VERSION = '0.3.1'

// The official CLI ships with the app. Electron supplies Node, including on machines
// without node/npm on PATH. electron-builder already unpacks node_modules.
export function tripoCliPath(): string {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
  return path.join(root, 'node_modules', 'tripo-cli', 'dist', 'cli.js')
}

export function tripoBridgePath(): string {
  const root = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked') : app.getAppPath()
  return path.join(root, 'out', 'main', 'tripoMcpBridge.js')
}

export function tripoServerSpec(): McpServerSpec {
  return {
    type: 'stdio', command: process.execPath, args: [tripoBridgePath(), tripoCliPath()],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      TRIPO_API_KEY: '${TRIPO_API_KEY:-}',
      TRIPO_HOME: path.join(APP_HOME, 'tools', 'tripo'),
      TRIPO_REGION: 'ov',
      TRIPO_API_BASE_URL: 'https://openapi.tripo3d.ai',
      CCG_TRIPO_BUILTIN: '1'
    }
  }
}

export function isBuiltinTripo(spec: McpServerSpec | undefined): boolean {
  return spec?.type === 'stdio' && spec.env?.CCG_TRIPO_BUILTIN === '1'
}

export function tripoStatus(): TripoStatus {
  const key = listSecrets().find((s) => s.name === TRIPO_KEY)
  const server = appServers()[TRIPO_SERVER]
  const builtin = isBuiltinTripo(server)
  return {
    keySaved: !!secretValues()[TRIPO_KEY], keyTail: key?.tail ?? '',
    registered: builtin,
    enabled: builtin && !!listMcpServers('').find((s) => s.origin === 'app' && s.name === TRIPO_SERVER)?.enabled,
    nameConflict: !!server && !builtin,
    cliAvailable: fs.existsSync(tripoCliPath()) && fs.existsSync(tripoBridgePath()), cliVersion: TRIPO_CLI_VERSION
  }
}

// Check everything before mutating the vault, so a conflicting custom server or a
// missing packaged CLI cannot leave a half-configured integration.
export function registerTripo(apiKey?: string): TripoStatus {
  const state = tripoStatus()
  if (state.nameConflict) throw new Error(t('tripo 이름의 사용자 MCP 서버가 있어요. MCP에서 이름을 변경한 뒤 다시 등록해 주세요.', 'A custom MCP server named tripo already exists. Rename it in MCP settings first.'))
  if (!state.cliAvailable) throw new Error(t('앱에 포함된 Tripo CLI를 찾지 못했어요. 앱을 다시 빌드하거나 설치해 주세요.', 'The bundled Tripo CLI is missing. Rebuild or reinstall the app.'))
  if (apiKey !== undefined) {
    if (typeof apiKey !== 'string' || !apiKey.trim() || /\s/.test(apiKey.trim())) {
      throw new Error(t('공백 없는 Tripo API 키를 입력해 주세요.', 'Enter a Tripo API key without whitespace.'))
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error(t('키를 암호화할 수 없어 저장하지 않았어요.', 'Key encryption is unavailable; the key was not saved.'))
    setSecret(TRIPO_KEY, apiKey, { note: 'Tripo 3D generation', env: true })
  }
  upsertAppServer(TRIPO_SERVER, tripoServerSpec())
  setMcpEnabled(TRIPO_SERVER, true)
  return tripoStatus()
}

// Refresh only our marked preset after moving/updating the app. Never enable a
// disabled integration or overwrite a user-authored server on startup.
export function refreshTripoRegistration(): void {
  if (isBuiltinTripo(appServers()[TRIPO_SERVER])) upsertAppServer(TRIPO_SERVER, tripoServerSpec())
}

/** Read-only authentication check. No generation, polling, or paid API request. */
export async function checkTripoConnection(): Promise<TripoConnectionResult> {
  const key = secretValues()[TRIPO_KEY]
  if (!key) return { ok: false, error: t('Tripo API 키를 먼저 저장해 주세요.', 'Save your Tripo API key first.') }
  try {
    const response = await fetch('https://openapi.tripo3d.ai/v3/account/balance', {
      headers: { Authorization: `Bearer ${key}` }, redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) return { ok: false, error: response.status === 401 || response.status === 403
      ? t('Tripo가 키 인증을 거절했어요. 국제 사이트에서 발급한 API 키를 확인해 주세요.', 'Tripo rejected the API key. Check your international-site API key.')
      : t(`Tripo 연결 확인 실패 (HTTP ${response.status}).`, `Tripo connection check failed (HTTP ${response.status}).`) }
    const body = await response.json() as { code?: number; data?: { balance?: unknown; frozen?: unknown } }
    // Do not echo upstream errors or arbitrary response bodies into the UI/logs.
    const balance = body.data?.balance
    if (body.code !== 0 || balance == null || (typeof balance !== 'number' && typeof balance !== 'string') || !String(balance).trim() || !Number.isFinite(Number(balance))) {
      return { ok: false, error: t('Tripo 잔액 응답을 확인하지 못했어요.', 'Could not validate the Tripo balance response.') }
    }
    return { ok: true, balance: Number(balance) }
  } catch {
    return { ok: false, error: t('Tripo 연결이 실패했거나 15초를 초과했어요. 네트워크를 확인해 주세요.', 'Tripo could not be reached within 15 seconds. Check your network.') }
  }
}
