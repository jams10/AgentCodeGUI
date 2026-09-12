import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkPathInfo } from '@shared/protocol'

export function resolveWorkPath(cwd: string, value: string): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 32_000 || /[\0\r\n]/.test(value)) return null
  let p = value.trim().replace(/^<|>$/g, '')
  try { p = decodeURI(p) } catch { /* literal percent in a filename */ }
  if (/^file:/i.test(p)) { try { p = fileURLToPath(p) } catch { return null } }
  if (/^[a-z][a-z\d+.-]*:/i.test(p) && !/^[A-Za-z]:[\\/]/.test(p)) return null
  if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1)
  p = p.replace(/:\d+(?::\d+)?$/, '')
  if (!path.isAbsolute(p) && !cwd) return null
  return path.resolve(cwd || '.', p)
}

export async function inspectWorkPaths(cwd: string, values: string[]): Promise<WorkPathInfo[]> {
  if (!Array.isArray(values)) return []
  const candidates = [...new Set(values.slice(0, 200).map(v => resolveWorkPath(cwd, v)).filter((v): v is string => !!v))]
  const found = await Promise.all(candidates.map(async p => {
    try {
      const stat = await fs.stat(p)
      if (!stat.isDirectory() && !stat.isFile()) return null
      return { path: p, folder: stat.isDirectory() ? p : path.dirname(p), kind: stat.isDirectory() ? 'directory' : 'file' } as WorkPathInfo
    } catch { return null }
  }))
  return found.filter((p): p is WorkPathInfo => !!p)
}
