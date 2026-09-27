// 기록부 — 모든 생성 작업과 결과를 SQLite 하나에 남긴다.
// 이 프로세스(게이트웨이)만 쓴다. MCP 중계기·앱 화면은 게이트웨이 API를 거친다.
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { Balance, Cost, JobRecord, JobState, OutputRecord, ProviderId, ProviderOutput } from './types.ts'

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
    balanceBefore: parse<Balance>(r.balance_before)
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
  }

  close(): void {
    this.db.close()
  }

  createJob(j: Omit<JobRecord, 'id' | 'createdAt' | 'updatedAt' | 'cost' | 'remoteId' | 'progress' | 'error'>): JobRecord {
    const id = randomUUID()
    const t = this.now()
    this.db
      .prepare(
        `insert into jobs (id, created_at, updated_at, state, capability, model, provider, prompt, params, inputs, origin, estimate, fallback_reason, balance_before)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, t, t, j.state, j.capability, j.model, j.provider, j.prompt, json(j.params), json(j.inputs), json(j.origin), json(j.estimate), j.fallbackReason, json(j.balanceBefore))
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
