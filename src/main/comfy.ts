import { safeStorage } from 'electron'
import { appServers, listMcpServers, setMcpEnabled, upsertAppServer } from './mcp'
import { listSecrets, secretValues, setSecret } from './secrets'
import { COMFY_KEY, COMFY_KEY_REF, COMFY_SERVER, COMFY_URL, comfyApiSpec, comfyKeyHeader } from './comfyConfig'
import { getServiceCredits } from './serviceCredits'
import { t } from './lang'
import type { ComfyStatus, ComfyConnectionResult } from '@shared/protocol'

export function comfyStatus(): ComfyStatus {
  const server = appServers()[COMFY_SERVER]
  const compatible = !server || (server.type === 'http' && server.url === COMFY_URL)
  const registered = comfyKeyHeader(server) === COMFY_KEY_REF
  const key = listSecrets().find(s => s.name === COMFY_KEY)
  return { keySaved: !!secretValues()[COMFY_KEY], keyTail: key?.tail ?? '', registered,
    enabled: registered && !!listMcpServers('').find(s => s.origin === 'app' && s.name === COMFY_SERVER)?.enabled,
    nameConflict: !compatible, authMode: registered ? 'api-key' : server ? 'oauth-or-custom' : 'unconfigured' }
}

export function registerComfy(apiKey?: string): ComfyStatus {
  if (comfyStatus().nameConflict) throw new Error(t('comfy-cloud 이름의 다른 서버가 있어요. MCP에서 이름을 변경해 주세요.', 'A different server uses the comfy-cloud name. Rename it in MCP settings.'))
  const key = apiKey?.trim() ?? secretValues()[COMFY_KEY]
  if (!key || !key.startsWith('comfyui-') || /\s/.test(key)) throw new Error(t('Comfy Platform에서 발급한 comfyui-로 시작하는 API 키를 입력해 주세요.', 'Enter a Comfy Platform API key starting with comfyui-.'))
  if (!safeStorage.isEncryptionAvailable()) throw new Error(t('키를 암호화할 수 없어 저장하지 않았어요.', 'Key encryption is unavailable; the key was not saved.'))
  setSecret(COMFY_KEY, key, { env: true, note: 'Comfy Cloud generation and credits' })
  const previous = appServers()[COMFY_SERVER]
  // Preserve unrelated custom headers; remove the superseded OAuth/Bearer header.
  const headers = previous?.type === 'http' ? Object.fromEntries(Object.entries(previous.headers ?? {}).filter(([name]) => !/^(authorization|x-api-key)$/i.test(name))) : {}
  upsertAppServer(COMFY_SERVER, { ...comfyApiSpec(), headers: { ...headers, 'X-API-Key': COMFY_KEY_REF } })
  setMcpEnabled(COMFY_SERVER, true)
  return comfyStatus()
}

/** Check the remote MCP protocol, not only billing. Never invoke a generation tool. */
export async function checkComfyMcp(key: string, endpoint = COMFY_URL): Promise<ComfyConnectionResult['mcp']> {
  const started = Date.now(), signal = AbortSignal.timeout(15_000)
  let session: string | null = null, protocol = '2024-11-05', seq = 0, initialized = false
  const rpc = async (method: string, params: unknown, notification = false): Promise<any> => {
    const id = ++seq
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-API-Key': key,
        ...(session ? { 'Mcp-Session-Id': session } : {}), ...(initialized ? { 'MCP-Protocol-Version': protocol } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id } : {}), method, params }) })
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`HTTP ${response.status}`) }
    session = response.headers.get('mcp-session-id') ?? session
    if (notification) { await response.body?.cancel().catch(() => {}); return }
    // Stop on our response even if an SSE connection remains open.
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Empty MCP response')
    const decoder = new TextDecoder(); let body = ''
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        body += decoder.decode(value, { stream: true })
        if (body.length > 4_000_000) throw new Error('MCP response too large')
        const candidates = response.headers.get('content-type')?.includes('text/event-stream')
          ? body.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5)) : [body]
        for (const candidate of candidates) {
          let message; try { message = JSON.parse(candidate) } catch { continue }
          if (message.id !== id) continue
          if (message.error) throw new Error('MCP protocol error')
          return message.result
        }
      }
      throw new Error('Missing MCP response')
    } finally { await reader.cancel().catch(() => {}) }
  }
  try {
    const init = await rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'AgentCodeGUI-connection-check', version: '1' } })
    if (typeof init?.protocolVersion === 'string') protocol = init.protocolVersion
    initialized = true
    await rpc('notifications/initialized', {}, true)
    const names = new Set<string>(); let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await rpc('tools/list', cursor ? { cursor } : {})
      if (!Array.isArray(result?.tools)) throw new Error('Invalid tool list')
      for (const tool of result.tools) if (typeof tool.name === 'string') names.add(tool.name)
      cursor = result.nextCursor
      if (!cursor) {
        if (!names.size) throw new Error('No MCP tools')
        return { ok: true, toolCount: names.size, elapsedMs: Date.now() - started }
      }
    }
    throw new Error('Tool pagination limit')
  } catch (error) {
    const code = /^HTTP \d{3}$/.test(String((error as Error)?.message)) ? (error as Error).message : 'MCP connection failed'
    return { ok: false, toolCount: 0, elapsedMs: Date.now() - started, error: code }
  }
}

export async function checkComfyConnection(): Promise<ComfyConnectionResult> {
  const status = comfyStatus(), key = secretValues()[COMFY_KEY]
  if (!status.registered || !status.enabled || !key) throw new Error(t('ComfyCloud API 키를 저장하고 연결을 켜 주세요.', 'Save the ComfyCloud API key and enable the connection.'))
  const [mcp, credits] = await Promise.all([checkComfyMcp(key), getServiceCredits('comfy-cloud', true)])
  return { mcp, credits }
}
