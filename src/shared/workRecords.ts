import type { GenerationRecord } from './protocol'

export function mergeGeneration(records: GenerationRecord[], next: GenerationRecord, followup = false): GenerationRecord[] {
  const index = records.findIndex(r => r.id === next.id || (followup && r.service === next.service && r.jobIds.some(id => next.jobIds.includes(id))))
  if (index < 0) return followup ? records : [...records, next]
  const old = records[index]
  const usage = { ...old.usage }
  for (const key of Object.keys(usage) as Array<keyof typeof usage>) if (next.usage[key] != null) usage[key] = next.usage[key]
  const terminal = old.status === 'completed' || old.status === 'error'
  const status = (next.status === 'unknown' && (followup || terminal || old.status === 'submitted')) || (terminal && (next.status === 'running' || next.status === 'submitted')) ? old.status : next.status
  const merged = { ...old, ...(!followup ? next : {}), status, usage, model: old.model ?? next.model,
    updatedAt: Math.max(old.updatedAt, next.updatedAt), jobIds: [...new Set([...old.jobIds, ...next.jobIds])], outputs: [...new Set([...old.outputs, ...next.outputs])] }
  const out = records.slice(); out[index] = merged; return out
}

/** Old snapshots have no records; corrupt records must not break chat restoration. */
export function restoreGenerations(raw: unknown): GenerationRecord[] {
  if (!Array.isArray(raw)) return []
  const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const num = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
  return raw.filter(r => r && typeof r.id === 'string' && typeof r.service === 'string').map(r => ({
    id: r.id, service: r.service, tool: typeof r.tool === 'string' ? r.tool : '',
    startedAt: num(r.startedAt) ?? 0, updatedAt: num(r.updatedAt) ?? 0,
    status: ['submitted', 'completed', 'error'].includes(r.status) ? r.status : 'unknown',
    prompt: typeof r.prompt === 'string' ? r.prompt : null, model: typeof r.model === 'string' ? r.model : null,
    parameters: typeof r.parameters === 'string' ? r.parameters : '{}', truncated: r.truncated === true,
    jobIds: strings(r.jobIds), outputs: strings(r.outputs), durationMs: num(r.durationMs),
    usage: { credits: num(r.usage?.credits), tokens: num(r.usage?.tokens), inputTokens: num(r.usage?.inputTokens), outputTokens: num(r.usage?.outputTokens), usd: num(r.usage?.usd) }
  }))
}
