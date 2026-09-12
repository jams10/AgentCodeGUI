import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { EngineEvent, GenerationRecord } from '@shared/protocol'

type Obj = Record<string, unknown>
const object = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const SECRET = /(?:^|_)(?:authorization|headers|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|client_secret|bearer_token|cookie)$/i
const MAX_TEXT = 128_000
function clean(v: unknown, depth = 0): unknown {
  if (depth > 20) return '[depth limit]'
  if (typeof v === 'string') return /^data:.*;base64,/i.test(v) ? '[image data]' : v.slice(0, MAX_TEXT)
  if (Array.isArray(v)) return v.slice(0, 500).map(x => clean(x, depth + 1))
  if (object(v)) return Object.fromEntries(Object.entries(v).slice(0, 500).map(([k, x]) => [k, SECRET.test(k) ? '[redacted]' : clean(x, depth + 1)]))
  return v
}
function unpack(v: unknown): unknown {
  if (typeof v !== 'string') return v
  if (v.length > 2_000_000) return null
  try { return JSON.parse(v) } catch {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(v)
    if (fenced) { try { return JSON.parse(fenced[1]) } catch { /* text-only response */ } }
    return null
  }
}
function visit(v: unknown, fn: (o: Obj, context: string) => void, context = '', depth = 0): void {
  if (depth > 20) return
  if (typeof v === 'string') { const parsed = unpack(v); if (parsed) visit(parsed, fn, context, depth + 1); return }
  if (Array.isArray(v)) { for (const x of v.slice(0, 500)) visit(x, fn, context, depth + 1); return }
  if (!object(v)) return
  fn(v, context)
  for (const [key, x] of Object.entries(v)) {
    if (SECRET.test(key) || /^(?:estimated|estimate|pricing|quote|input|arguments|parameters|request)$/i.test(key)) continue
    visit(x, fn, context + '/' + key, depth + 1)
  }
}
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v :
  typeof v === 'string' && /^\d+(?:\.\d+)?$/.test(v) && Number.isFinite(Number(v)) ? Number(v) : null
const text = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null
const emptyUsage = (): GenerationRecord['usage'] => ({ credits: null, tokens: null, inputTokens: null, outputTokens: null, usd: null })

export function generationService(server: string, tool: string): string | null {
  const name = (server + ' ' + tool).toLowerCase()
  if (/tripo/.test(name)) return 'Tripo'
  if (/comfy[-_ ]?(?:cloud)?/.test(name)) return 'ComfyCloud'
  if (/higgsfield/.test(name)) return 'Higgsfield'
  if (/imagegen|image_gen/.test(name)) return 'ImageGen'
  return null
}
const isGeneration = (tool: string): boolean => /(?:^|[_:.])(?:make|generate|imagegen|partner_generate|run_template|submit_workflow|submit_batch|text2image|image2image|text2video|image2video)(?:$|[_:.])/i.test(tool)
const isFollowup = (tool: string): boolean => /(?:task_get|task_wait|get_output|get_job|job_status|task_status|get_task|poll_job)/i.test(tool)

/** Main-process capture, before display summaries discard tool inputs/results. */
export class GenerationCapture {
  private pending = new Map<string, { record: GenerationRecord; followup: boolean; runId: string }>()
  private cwd = ''
  constructor(private send: (event: EngineEvent) => void, private enrich?: (record: GenerationRecord) => Promise<GenerationRecord['usage'] | null>) {}
  observe(e: EngineEvent): void {
    if (e.type === 'session') {
      this.cwd = e.cwd
      if (e.cwd) this.send({ type: 'work-folder', runId: e.runId, path: e.cwd })
    } else if (e.type === 'file-change' && this.cwd) {
      this.send({ type: 'work-folder', runId: e.runId, path: path.dirname(path.resolve(this.cwd, e.file.path)) })
    } else if (e.type === 'status' && (e.status === 'done' || e.status === 'error')) {
      for (const p of this.pending.values()) {
        if (p.runId === e.runId && !p.followup) this.send({ type: 'generation', runId: e.runId, record: { ...p.record, status: 'unknown', updatedAt: Date.now() } })
      }
    }
  }
  start(runId: string, id: string, tool: string, input: unknown, server = ''): void {
    const service = generationService(server, tool)
    if (!service || (!isGeneration(tool) && !isFollowup(tool)) || this.pending.has(id)) return
    const args = clean(unpack(input) ?? input ?? {})
    let prompt: string | null = null, model: string | null = null
    const jobIds: string[] = []
    visit(args, o => {
      prompt ??= text(o.prompt) ?? text(o.positive_prompt) ?? text(o.text_prompt)
      if (service === 'Tripo') prompt ??= text(o.input)
      model ??= text(o.model) ?? text(o.model_name) ?? text(o.model_version) ?? text(o.version)
      for (const k of ['task_id', 'job_id', 'prompt_id', 'taskId', 'jobId']) { const v = text(o[k]); if (v) jobIds.push(v) }
    })
    const serialized = JSON.stringify(args, null, 2) ?? '{}'
    const record: GenerationRecord = { id: randomUUID(), service, tool, startedAt: Date.now(), updatedAt: Date.now(),
      status: 'running', prompt: (prompt as string | null)?.slice(0, MAX_TEXT) ?? null, model, parameters: serialized.slice(0, MAX_TEXT),
      truncated: serialized.length > MAX_TEXT, jobIds: [...new Set(jobIds)], outputs: [], usage: emptyUsage(), durationMs: null }
    const followup = !isGeneration(tool)
    this.pending.set(id, { record, followup, runId })
    if (this.pending.size > 256) this.pending.delete(this.pending.keys().next().value!)
    if (!followup) this.send({ type: 'generation', runId, record })
  }
  finish(runId: string, id: string, result: unknown, failed: boolean): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    const { record, followup } = pending
    const jobIds = new Set(record.jobIds), outputs = new Set<string>()
    const usage = emptyUsage()
    let status: GenerationRecord['status'] = failed && !followup ? 'error' : 'unknown'
    visit(result, (o, context) => {
      if (!followup && (o.isError === true || o.is_error === true || o.error != null || (typeof o.code === 'number' && o.code !== 0))) status = 'error'
      const state = String(o.status ?? o.state ?? '').toLowerCase()
      if (status !== 'error') {
        if (/^(failed|failure|error|cancelled|canceled)$/.test(state)) status = 'error'
        else if (/^(success|succeeded|completed|complete|done)$/.test(state)) status = 'completed'
        else if (/^(queued|pending|running|processing|submitted)$/.test(state) && status !== 'completed') status = 'submitted'
      }
      for (const k of ['task_id', 'job_id', 'prompt_id', 'taskId', 'jobId']) { const v = text(o[k]); if (v) jobIds.add(v) }
      record.model ??= text(o.model) ?? text(o.model_name) ?? text(o.model_version)
      const take = (field: keyof typeof usage, keys: string[]): void => {
        for (const key of keys) { const n = number(o[key]); if (n != null && usage[field] == null) usage[field] = n }
      }
      take('credits', ['credits_used', 'credits_consumed', 'cost_credits', 'actual_credits', 'credits_charged'])
      take('tokens', ['total_tokens', 'tokens_used'])
      take('inputTokens', ['input_tokens', 'prompt_tokens'])
      take('outputTokens', ['output_tokens', 'completion_tokens'])
      take('usd', ['cost_usd', 'actual_cost_usd'])
      if (/\/(?:usage|billing|cost)$/.test(context)) take('credits', ['credits'])
      for (const [key, value] of Object.entries(o)) {
        const outputField = /^(?:output_dir|model_file|preview|output_url|output_path|download_url|local_path|file_path|artifact_url|image_url|video_url|model_url|pbr_model|base_model|rendered_image)$/.test(key)
        const inOutputs = /\/(?:output|outputs|artifacts|assets|files)(?:\/|$)/.test(context)
        for (const v of Array.isArray(value) ? value : [value]) {
          if (typeof v !== 'string' || v.length > 16_000 || /^data:/i.test(v)) continue
          if ((outputField || inOutputs) && /^(?:https?:\/\/|[A-Za-z]:[\\/]|\/)/.test(v)) outputs.add(v)
        }
      }
    })
    if (!failed && status === 'unknown') status = outputs.size ? 'completed' : jobIds.size ? 'submitted' : 'unknown'
    // Multiple job charges are not an aggregate. Avoid presenting the first
    // nested task's usage as the cost of an entire batch/chain.
    const completed = { ...record, updatedAt: Date.now(), status, jobIds: [...jobIds], outputs: [...outputs],
      usage: jobIds.size > 1 ? emptyUsage() : usage, durationMs: Date.now() - record.startedAt }
    this.send({ type: 'generation', runId, followup, record: completed })
    if (!followup && this.enrich) void this.enrich(completed).then(reported => {
      if (reported) this.send({ type: 'generation', runId, record: { ...completed, usage: reported, updatedAt: Date.now() } })
    }).catch(() => { /* an optional usage lookup cannot fail the generation */ })
  }
}
