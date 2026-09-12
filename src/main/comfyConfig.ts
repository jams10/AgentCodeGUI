import type { McpServerSpec } from '@shared/protocol'

export const COMFY_SERVER = 'comfy-cloud'
export const COMFY_URL = 'https://cloud.comfy.org/mcp'
export const COMFY_KEY = 'COMFY_API_KEY'
export const COMFY_KEY_REF = '${COMFY_API_KEY}'

export function comfyKeyHeader(spec: McpServerSpec | undefined): string | undefined {
  return spec?.type === 'http' && spec.url === COMFY_URL
    ? Object.entries(spec.headers ?? {}).find(([name]) => name.toLowerCase() === 'x-api-key')?.[1] : undefined
}

export function comfyApiSpec(): Extract<McpServerSpec, { url: string }> {
  return { type: 'http', url: COMFY_URL, headers: { 'X-API-Key': COMFY_KEY_REF } }
}
