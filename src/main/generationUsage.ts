import type { GenerationRecord } from '@shared/protocol'
import { secretValues } from './secrets'
import { creditNumber } from './creditValues'

/** tripo_make omits credits; fetch the completed task's reported charge once. */
export async function reportedGenerationUsage(record: GenerationRecord): Promise<GenerationRecord['usage'] | null> {
  if (record.service !== 'Tripo' || record.status !== 'completed' || record.jobIds.length !== 1 || record.usage.credits != null) return null
  const key = secretValues().TRIPO_API_KEY
  if (!key) return null
  try {
    const response = await fetch('https://openapi.tripo3d.ai/v3/tasks/' + encodeURIComponent(record.jobIds[0]), {
      headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) return null
    const body = await response.json() as { code?: unknown; data?: { task_id?: unknown; credits_consumed?: unknown } } | null
    if (body?.code !== 0 || body?.data?.task_id !== record.jobIds[0]) return null
    const credits = creditNumber(body.data?.credits_consumed)
    return credits == null || credits < 0 ? null : { ...record.usage, credits }
  } catch { return null }
}
