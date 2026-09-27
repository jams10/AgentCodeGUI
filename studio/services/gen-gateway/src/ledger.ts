// 기록부 — 모든 생성 작업과 결과를 SQLite 하나에 남긴다.
// 이 프로세스(게이트웨이)만 쓴다. MCP 중계기·앱 화면은 게이트웨이 API를 거친다.
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { Balance, Cost, JobRecord, JobState, OutputRecord, ProviderId, ProviderOutput, StyleInput, StyleRecord } from './types.ts'

const SCHEMA = `
create table if not exists jobs (
  id text primary key,
  created_at integer not null,
  updated_at integer not null,
  state text not null,
  capability text not null,
  model text not null,
  provider text not null,
  prompt text,
  params text,
  inputs text,
  origin text,
  estimate text,
  cost text,
  fallback_reason text,
  remote_id text,
  progress real,
  error text,
  balance_before text
);
create index if not exists jobs_created on jobs(created_at desc);
create index if not exists jobs_state on jobs(state);
create table if not exists outputs (
  id text primary key,
  job_id text not null references jobs(id),
  kind text not null,
  url text not null,
  mime text,
  expires_at integer,
  storage_key text,
  created_at integer not null
);
create index if not exists outputs_job on outputs(job_id);
create table if not exists balances (
  provider text not null,
  checked_at integer not null,
  amount real not null,
  unit text not null,
  usd real
);
create index if not exists balances_provider on balances(provider, checked_at desc);
create table if not exists styles (
  id text primary key,
  name text not null,
  description text,
  prompt_prefix text,
  prompt_suffix text,
  negative text,
  created_at integer not null,
  updated_at integer not null
);
`

type Row = Record<string, unknown>

const json = (v: unknown): string | null => (v == null ? null : JSON.stringify(v))
function parse<T>(v: unknown): T | null {
  if (typeof v !== 'string') return null
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

function toJob(r: Row): JobRecord {
  return {
    id: r.id as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    state: r.state as JobState,
    capability: r.capability as JobRecord['capability'],
    model: r.model as string,
    provider: r.provider as ProviderId,
    prompt: (r.prompt as string | null) ?? null,
    params: parse(r.params),
    inputs: parse(r.inputs),
    origin: parse(r.origin),
    estimate: parse<Cost>(r.estimate),
    cost: parse<Cost>(r.cost),
    fallbackReason: (r.fallback_reason as string | null) ?? null,
    remoteId: (r.remote_id as string | null) ?? null,
    progress: (r.progress as number | null) ?? null,
    error: (r.error as string | null) ?? null,
    balanceBefore: parse<Balance>(r.balance_before),
    styleId: (r.style_id as string | null) ?? null
  }
}

function toStyle(r: Row): StyleRecord {
  return {
    id: r.id as string,
    name: r.name as string,
    description: (r.description as string | null) ?? null,
    promptPrefix: (r.prompt_prefix as string | null) ?? null,
    promptSuffix: (r.prompt_suffix as string | null) ?? null,
    negative: (r.negative as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function toOutput(r: Row): OutputRecord {
  return {
    id: r.id as string,
    jobId: r.job_id as string,
    kind: r.kind as OutputRecord['kind'],
    url: r.url as string,
    mime: (r.mime as string | null) ?? null,
    expiresAt: (r.expires_at as number | null) ?? null,
    storageKey: (r.storage_key as string | null) ?? null,
    createdAt: r.created_at as number
  }
}

export class Ledger {
  readonly db: DatabaseSync
  private readonly now: () => number

  constructor(file: string, now: () => number = Date.now) {
    this.db = new DatabaseSync(file)
    this.now = now
    this.db.exec('pragma journal_mode = wal; pragma foreign_keys = on;')
    this.db.exec(SCHEMA)
    // 이전 기록부에는 style_id가 없다 — 한 번만 열을 더한다
    const cols = (this.db.prepare('pragma table_info(jobs)').all() as Row[]).map((c) => c.name)
    if (!cols.includes('style_id')) this.db.exec('alter table jobs add column style_id text')
  }

  close(): void {
    this.db.close()
  }

  createJob(j: Omit<JobRecord, 'id' | 'createdAt' | 'updatedAt' | 'cost' | 'remoteId' | 'progress' | 'error' | 'styleId'> & { styleId?: string | null }): JobRecord {
    const id = randomUUID()
    const t = this.now()
    this.db
      .prepare(
        `insert into jobs (id, created_at, updated_at, state, capability, model, provider, prompt, params, inputs, origin, estimate, fallback_reason, balance_before, style_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, t, t, j.state, j.capability, j.model, j.provider, j.prompt, json(j.params), json(j.inputs), json(j.origin), json(j.estimate), j.fallbackReason, json(j.balanceBefore), j.styleId ?? null)
    return this.job(id)!
  }

  job(id: string): JobRecord | null {
    const r = this.db.prepare('select * from jobs where id = ?').get(id) as Row | undefined
    return r ? toJob(r) : null
  }

  jobs(opts: { limit?: number; state?: JobState; provider?: ProviderId } = {}): JobRecord[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (opts.state) {
      where.push('state = ?')
      args.push(opts.state)
    }
    if (opts.provider) {
      where.push('provider = ?')
      args.push(opts.provider)
    }
    args.push(Math.max(1, Math.min(500, opts.limit ?? 100)))
    const sql = `select * from jobs ${where.length ? 'where ' + where.join(' and ') : ''} order by created_at desc limit ?`
    return (this.db.prepare(sql).all(...args) as Row[]).map(toJob)
  }

  update(id: string, patch: Partial<Pick<JobRecord, 'state' | 'cost' | 'remoteId' | 'progress' | 'error'>>): JobRecord {
    const sets: string[] = ['updated_at = ?']
    const args: (string | number | null)[] = [this.now()]
    if (patch.state !== undefined) (sets.push('state = ?'), args.push(patch.state))
    if (patch.cost !== undefined) (sets.push('cost = ?'), args.push(json(patch.cost)))
    if (patch.remoteId !== undefined) (sets.push('remote_id = ?'), args.push(patch.remoteId))
    if (patch.progress !== undefined) (sets.push('progress = ?'), args.push(patch.progress))
    if (patch.error !== undefined) (sets.push('error = ?'), args.push(patch.error))
    args.push(id)
    this.db.prepare(`update jobs set ${sets.join(', ')} where id = ?`).run(...args)
    const j = this.job(id)
    if (!j) throw new Error(`job not found: ${id}`)
    return j
  }

  addOutputs(jobId: string, outs: ProviderOutput[]): OutputRecord[] {
    const t = this.now()
    const stmt = this.db.prepare('insert into outputs (id, job_id, kind, url, mime, expires_at, storage_key, created_at) values (?, ?, ?, ?, ?, ?, null, ?)')
    for (const o of outs) stmt.run(randomUUID(), jobId, o.kind, o.url, o.mime ?? null, o.expiresAt ?? null, t)
    return this.outputs(jobId)
  }

  outputs(jobId: string): OutputRecord[] {
    return (this.db.prepare('select * from outputs where job_id = ? order by created_at').all(jobId) as Row[]).map(toOutput)
  }

  /** 최근 결과(작업 정보 포함) — 갤러리용 */
  recentOutputs(limit = 200): { output: OutputRecord; job: JobRecord }[] {
    const n = Math.max(1, Math.min(1000, limit))
    const rows = this.db
      .prepare(
        `select o.id as o_id, o.job_id, o.kind, o.url, o.mime, o.expires_at, o.storage_key, o.created_at as o_created, j.*
         from outputs o join jobs j on j.id = o.job_id order by o.created_at desc limit ?`
      )
      .all(n) as Row[]
    return rows.map((r) => ({
      output: toOutput({ id: r.o_id, job_id: r.job_id, kind: r.kind, url: r.url, mime: r.mime, expires_at: r.expires_at, storage_key: r.storage_key, created_at: r.o_created }),
      job: toJob(r)
    }))
  }

  setStorageKey(outputId: string, key: string): void {
    this.db.prepare('update outputs set storage_key = ? where id = ?').run(key, outputId)
  }

  output(id: string): (OutputRecord & { provider: ProviderId }) | null {
    const r = this.db.prepare('select o.*, j.provider from outputs o join jobs j on j.id = o.job_id where o.id = ?').get(id) as Row | undefined
    return r ? { ...toOutput(r), provider: r.provider as ProviderId } : null
  }

  recordBalance(provider: ProviderId, b: Balance): void {
    this.db.prepare('insert into balances (provider, checked_at, amount, unit, usd) values (?, ?, ?, ?, ?)').run(provider, b.checkedAt, b.amount, b.unit, b.usd)
  }

  lastBalance(provider: ProviderId): Balance | null {
    const r = this.db.prepare('select * from balances where provider = ? order by checked_at desc limit 1').get(provider) as Row | undefined
    return r ? { amount: r.amount as number, unit: r.unit as Balance['unit'], usd: (r.usd as number | null) ?? null, checkedAt: r.checked_at as number } : null
  }

  // ── 스타일 — 결과 분류 + 프롬프트 프리셋 ─────────────────
  styles(): (StyleRecord & { count: number })[] {
    const rows = this.db.prepare('select s.*, (select count(*) from jobs j where j.style_id = s.id) as n from styles s order by s.name collate nocase').all() as Row[]
    return rows.map((r) => ({ ...toStyle(r), count: Number(r.n ?? 0) }))
  }

  /** id 또는 이름(대소문자 무시)으로 찾는다 — AI가 이름으로 부를 수 있게 */
  style(idOrName: string): StyleRecord | null {
    const r = (this.db.prepare('select * from styles where id = ?').get(idOrName) ?? this.db.prepare('select * from styles where lower(name) = lower(?)').get(idOrName.trim())) as Row | undefined
    return r ? toStyle(r) : null
  }

  createStyle(s: StyleInput): StyleRecord {
    const id = randomUUID()
    const t = this.now()
    this.db
      .prepare('insert into styles (id, name, description, prompt_prefix, prompt_suffix, negative, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, s.name.trim(), s.description ?? null, s.promptPrefix ?? null, s.promptSuffix ?? null, s.negative ?? null, t, t)
    return this.style(id)!
  }

  updateStyle(id: string, s: Partial<StyleInput>): StyleRecord | null {
    const cur = this.style(id)
    if (!cur || cur.id !== id) return null
    const next = { ...cur, ...s }
    this.db
      .prepare('update styles set name = ?, description = ?, prompt_prefix = ?, prompt_suffix = ?, negative = ?, updated_at = ? where id = ?')
      .run(next.name.trim(), next.description ?? null, next.promptPrefix ?? null, next.promptSuffix ?? null, next.negative ?? null, this.now(), id)
    return this.style(id)
  }

  /** 스타일을 지워도 결과는 남는다(분류만 풀린다) */
  deleteStyle(id: string): boolean {
    this.db.prepare('update jobs set style_id = null where style_id = ?').run(id)
    return this.db.prepare('delete from styles where id = ?').run(id).changes > 0
  }

  setJobStyle(jobId: string, styleId: string | null): JobRecord | null {
    this.db.prepare('update jobs set style_id = ?, updated_at = ? where id = ?').run(styleId, this.now(), jobId)
    return this.job(jobId)
  }

  /** 기간 내 서비스별 실제 비용 합계(USD 환산 가능한 것만) — 사용량 패널 · 라이브러리용 */
  spend(sinceMs: number): { provider: ProviderId; jobs: number; usd: number; unknown: number }[] {
    const rows = this.db.prepare(`select provider, cost from jobs where state = 'succeeded' and created_at >= ?`).all(sinceMs) as Row[]
    const acc = new Map<ProviderId, { provider: ProviderId; jobs: number; usd: number; unknown: number }>()
    for (const r of rows) {
      const p = r.provider as ProviderId
      const a = acc.get(p) ?? { provider: p, jobs: 0, usd: 0, unknown: 0 }
      a.jobs++
      const c = parse<Cost>(r.cost)
      if (c?.usd != null) a.usd += c.usd
      else a.unknown++
      acc.set(p, a)
    }
    return [...acc.values()]
  }
}
