// 게이트웨이 핵심 — 견적 → 사용자 승인 → 제출 → 상태 추적 → 결과 기록.
//
// 규칙
//  - 어떤 경로(UI · AI)로 오든 비용이 드는 제출은 approve() 뒤에만 일어난다.
//  - 서비스는 라우팅 표의 순서대로 고르고, 키가 없거나 · 지원하지 않거나 · 잔액이 부족하면
//    다음 서비스로 넘어간다. 넘어간 이유는 작업 기록(fallbackReason)과 승인 카드에 남는다.
//  - 서비스가 비용을 알려주지 않으면, 같은 서비스에 동시에 도는 작업이 없을 때만 잔액 차이로 계산한다.
import type { Archiver } from './archive.ts'
import type { Ledger } from './ledger.ts'
import type { Route } from './routes.ts'
import { findRoute } from './routes.ts'
import { MODELS } from './models.ts'
import type { Balance, Cost, GenerationRequest, JobRecord, OutputRecord, Provider, ProviderId, StyleRecord } from './types.ts'

export class GatewayError extends Error {
  readonly code: string
  readonly details: unknown
  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.code = code
    this.details = details
  }
}

export type GatewayEvent = { type: 'job'; job: JobRecord; outputs?: OutputRecord[] } | { type: 'balance'; provider: ProviderId; balance: Balance } | { type: 'styles' } | { type: 'providers' }

export interface GatewayOptions {
  ledger: Ledger
  providers: Provider[]
  routes: Route[]
  pollMs?: number
  /** 이 시간 동안 끝나지 않으면 추적을 멈추고 실패로 기록한다(서비스 쪽 작업은 계속될 수 있음) */
  maxPollMs?: number
  onEvent?: (e: GatewayEvent) => void
  now?: () => number
  /** 결과 보관(곧 만료되는 서비스 URL을 옮겨 둔다) */
  archiver?: Archiver
}

/** 스타일 앞 문구 + 프롬프트 + 뒤 문구 */
export function composePrompt(st: Pick<StyleRecord, 'promptPrefix' | 'promptSuffix'>, prompt: string | undefined): string | undefined {
  const parts = [st.promptPrefix, prompt, st.promptSuffix].map((p) => p?.trim()).filter((p): p is string => !!p)
  return parts.length ? parts.join(', ') : undefined
}

/** 네거티브 프롬프트를 받는 모델인가 — 카탈로그에 그 옵션이 있을 때만 넣는다(모르는 파라미터로 서비스가 거절하지 않게) */
function modelTakesNegative(model: string): boolean {
  return !!MODELS.find((m) => m.id === model)?.options.some((o) => o.key === 'negative_prompt')
}

function sameUnit(a: { unit: string } | null | undefined, b: { unit: string } | null | undefined): boolean {
  return !!a && !!b && a.unit === b.unit
}

function fmt(c: { amount: number; unit: string }): string {
  return c.unit === 'usd' ? `$${c.amount.toFixed(2)}` : `${Math.round(c.amount)} 크레딧`
}

export class Gateway {
  private readonly ledger: Ledger
  private readonly providers: Map<ProviderId, Provider>
  private routes: Route[]
  private readonly pollMs: number
  private readonly maxPollMs: number
  private readonly onEvent: (e: GatewayEvent) => void
  private readonly now: () => number
  private readonly archiver: Archiver | null
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly waiters = new Map<string, Set<(j: JobRecord) => void>>()

  constructor(o: GatewayOptions) {
    this.ledger = o.ledger
    this.providers = new Map(o.providers.map((p) => [p.id, p]))
    this.routes = o.routes
    this.pollMs = o.pollMs ?? 4000
    this.maxPollMs = o.maxPollMs ?? 45 * 60 * 1000
    this.onEvent = o.onEvent ?? (() => {})
    this.now = o.now ?? Date.now
    this.archiver = o.archiver ?? null
  }

  setRoutes(routes: Route[]): void {
    this.routes = routes
  }

  /** 이 (기능, 모델)을 처리할 서비스 순서와 각 서비스의 준비 상태 */
  routeFor(capability: GenerationRequest['capability'], model: string): { id: ProviderId; configured: boolean }[] {
    const r = findRoute(this.routes, capability, model)
    return (r?.providers ?? []).map((id) => ({ id, configured: !!this.providers.get(id)?.configured() }))
  }

  providerList(): { id: ProviderId; configured: boolean }[] {
    return [...this.providers.values()].map((p) => ({ id: p.id, configured: p.configured() }))
  }

  // ── 잔액 ─────────────────────────────────────────────
  async balance(id: ProviderId): Promise<Balance | null> {
    const p = this.providers.get(id)
    if (!p || !p.configured()) return null
    const b = await p.balance()
    if (b) {
      this.ledger.recordBalance(id, b)
      this.onEvent({ type: 'balance', provider: id, balance: b })
    }
    return b
  }

  /** 키 확인 — 과금 없는 호출 한 번. 결과 문구를 돌려주고, 실패는 예외로 올린다. */
  async verify(id: ProviderId): Promise<string> {
    const p = this.providers.get(id)
    if (!p) throw new GatewayError('not_found', `${id} 서비스가 없어요`)
    if (!p.configured()) throw new GatewayError('no_key', 'API 키가 없어요')
    if (p.verify) return p.verify()
    const b = await this.balance(id)
    if (!b) return '인증 확인됨'
    return `인증 확인됨 · 잔액 ${b.unit === 'usd' ? '$' + b.amount.toFixed(2) : Math.round(b.amount).toLocaleString('ko-KR') + ' 크레딧'}`
  }

  async balances(): Promise<Record<string, Balance | null | { error: string }>> {
    const out: Record<string, Balance | null | { error: string }> = {}
    await Promise.all(
      [...this.providers.keys()].map(async (id) => {
        try {
          out[id] = await this.balance(id)
        } catch (e) {
          out[id] = { error: String((e as Error).message ?? e) }
        }
      })
    )
    return out
  }

  // ── 견적: 서비스를 고르고 승인 대기 작업을 만든다 ─────────────
  async quote(input: GenerationRequest): Promise<JobRecord> {
    // 스타일 — 앞/뒤 문구를 붙인 최종 프롬프트가 견적·승인 카드·기록에 그대로 남는다
    let req = input
    let styleId: string | null = null
    if (input.style) {
      const st = this.ledger.style(input.style)
      if (!st) throw new GatewayError('no_style', `'${input.style}' 스타일을 찾지 못했어요.`)
      styleId = st.id
      // 스타일 적용 전 원문도 남긴다(서비스에는 가지 않는 origin) — 다시 만들 때 문구가 두 번 붙지 않게
      req = { ...input, prompt: composePrompt(st, input.prompt), origin: { ...(input.origin ?? {}), userPrompt: input.prompt ?? '' } }
      if (st.negative && modelTakesNegative(input.model) && input.params?.negative_prompt == null) req.params = { ...(input.params ?? {}), negative_prompt: st.negative }
    }
    const route = findRoute(this.routes, req.capability, req.model)
    const order: ProviderId[] = req.provider ? [req.provider] : route?.providers ?? []
    if (!order.length) throw new GatewayError('no_route', `'${req.capability}/${req.model}'을(를) 처리할 서비스가 라우팅 표에 없어요.`)

    const skipped: string[] = []
    for (const id of order) {
      const p = this.providers.get(id)
      if (!p) {
        skipped.push(`${id}: 연결되지 않음`)
        continue
      }
      if (!p.configured()) {
        skipped.push(`${id}: API 키 없음`)
        continue
      }
      if (!p.supports(req)) {
        skipped.push(`${id}: 이 모델을 지원하지 않음`)
        continue
      }
      let r = req
      if (p.prepare) {
        try {
          r = await p.prepare(req)
        } catch (e) {
          throw new GatewayError('bad_request', `${id}: ${(e as Error).message}`)
        }
      }
      const est = await p.estimate(r)
      if (est.invalid) throw new GatewayError('bad_request', `${id}: ${est.invalid}`)
      let bal: Balance | null = null
      try {
        bal = await this.balance(id)
      } catch (e) {
        skipped.push(`${id}: 잔액 조회 실패(${(e as Error).message})`)
        continue
      }
      if (est.cost && bal && sameUnit(est.cost, bal) && bal.amount < est.cost.amount) {
        skipped.push(`${id}: 잔액 부족(${fmt(bal)} < 예상 ${fmt(est.cost)})`)
        continue
      }
      const job = this.ledger.createJob({
        state: 'awaiting_approval',
        capability: req.capability,
        model: req.model,
        provider: id,
        prompt: r.prompt ?? null,
        params: r.params ?? null,
        inputs: req.inputs ?? null,
        origin: req.origin ?? null,
        estimate: est.cost,
        fallbackReason: skipped.length ? skipped.join(' · ') : null,
        balanceBefore: bal,
        styleId
      })
      this.emit(job)
      return job
    }
    throw new GatewayError('no_provider', `쓸 수 있는 서비스가 없어요 — ${skipped.join(' · ')}`, { skipped })
  }

  // ── 승인 전 고치기: 옵션 · 프롬프트를 바꾸고 같은 서비스로 다시 견적(무료) ─────────
  // 작업 id는 그대로 — AI(MCP generate)가 기다리는 작업이 끊기지 않는다.
  // 스타일이 붙은 작업은 프롬프트에 스타일 문구가 합쳐져 있어서 프롬프트는 고치지 않는다(옵션만).
  async revise(id: string, patch: { prompt?: string; params?: Record<string, unknown> }): Promise<JobRecord> {
    const job = this.must(id)
    if (job.state !== 'awaiting_approval') throw new GatewayError('bad_state', `고칠 수 없는 상태예요: ${job.state}`)
    if (patch.prompt !== undefined && job.styleId) throw new GatewayError('bad_request', '스타일이 적용된 작업은 프롬프트를 여기서 고칠 수 없어요 — 채팅으로 다시 요청해 주세요')
    const p = this.providers.get(job.provider)
    if (!p) throw new GatewayError('no_provider', `서비스를 찾지 못했어요: ${job.provider}`)
    const prompt = patch.prompt !== undefined ? patch.prompt.trim() || null : job.prompt
    const params = patch.params !== undefined ? patch.params : job.params
    const req: GenerationRequest = { capability: job.capability, model: job.model, prompt: prompt ?? undefined, params: params ?? undefined, inputs: job.inputs ?? undefined }
    const est = await p.estimate(req)
    if (est.invalid) throw new GatewayError('bad_request', `${job.provider}: ${est.invalid}`)
    const next = this.ledger.revise(id, { prompt: patch.prompt !== undefined ? prompt : undefined, params: patch.params !== undefined ? params : undefined, estimate: est.cost })
    this.emit(next)
    return next
  }

  // ── 승인 · 거절 · 취소 ─────────────────────────────────
  async approve(id: string): Promise<JobRecord> {
    const job = this.must(id)
    if (job.state !== 'awaiting_approval') throw new GatewayError('bad_state', `승인할 수 없는 상태예요: ${job.state}`)
    const p = this.providers.get(job.provider)
    if (!p || !p.configured()) throw new GatewayError('provider_unavailable', `${job.provider}를 지금 쓸 수 없어요.`)
    this.emit(this.ledger.update(id, { state: 'submitting' }))
    try {
      const { remoteId } = await p.submit(this.requestOf(job))
      const running = this.ledger.update(id, { state: 'running', remoteId, progress: 0 })
      this.emit(running)
      this.schedule(id, this.now())
      return running
    } catch (e) {
      const failed = this.ledger.update(id, { state: 'failed', error: `제출 실패: ${(e as Error).message}` })
      this.emit(failed)
      return failed
    }
  }

  reject(id: string): JobRecord {
    const job = this.must(id)
    if (job.state !== 'awaiting_approval') throw new GatewayError('bad_state', `거절할 수 없는 상태예요: ${job.state}`)
    const j = this.ledger.update(id, { state: 'rejected' })
    this.emit(j)
    return j
  }

  async cancel(id: string): Promise<JobRecord> {
    const job = this.must(id)
    if (job.state === 'awaiting_approval') return this.reject(id)
    if (job.state !== 'running' && job.state !== 'submitting') throw new GatewayError('bad_state', `취소할 수 없는 상태예요: ${job.state}`)
    const p = this.providers.get(job.provider)
    if (job.remoteId && p?.cancel) await p.cancel(job.remoteId)
    this.stopTimer(id)
    const j = this.ledger.update(id, { state: 'canceled' })
    this.emit(j)
    return j
  }

  /** 끝날 때까지(또는 시간 초과까지) 기다린다 — AI 도구가 결과를 받아 갈 때 쓴다 */
  waitFor(id: string, timeoutMs: number): Promise<JobRecord> {
    const cur = this.must(id)
    if (this.done(cur)) return Promise.resolve(cur)
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set()
      const t = setTimeout(() => {
        set.delete(fin)
        resolve(this.must(id))
      }, timeoutMs)
      const fin = (j: JobRecord): void => {
        clearTimeout(t)
        resolve(j)
      }
      set.add(fin)
      this.waiters.set(id, set)
    })
  }

  /** 게이트웨이 재시작 뒤 — 돌던 작업의 추적을 이어 간다 */
  resume(): void {
    for (const j of this.ledger.jobs({ state: 'running', limit: 500 })) this.schedule(j.id, j.updatedAt, 0)
    for (const j of this.ledger.jobs({ state: 'submitting', limit: 500 })) {
      // 제출 응답을 받기 전에 꺼졌다 — 서비스에 작업이 생겼는지 알 수 없다. 조용히 재제출하지 않는다.
      this.emit(this.ledger.update(j.id, { state: 'failed', error: '제출 중 게이트웨이가 종료되어 결과를 확인할 수 없어요. 서비스 기록을 확인해 주세요.' }))
    }
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  outputs(id: string): OutputRecord[] {
    return this.ledger.outputs(id)
  }

  // ── 내부 ────────────────────────────────────────────
  private must(id: string): JobRecord {
    const j = this.ledger.job(id)
    if (!j) throw new GatewayError('not_found', `작업을 찾지 못했어요: ${id}`)
    return j
  }

  private done(j: JobRecord): boolean {
    return j.state === 'succeeded' || j.state === 'failed' || j.state === 'canceled' || j.state === 'rejected'
  }

  private requestOf(j: JobRecord): GenerationRequest {
    return { capability: j.capability, model: j.model, prompt: j.prompt ?? undefined, params: j.params ?? undefined, inputs: j.inputs ?? undefined, origin: j.origin ?? undefined, provider: j.provider }
  }

  private emit(job: JobRecord, outputs?: OutputRecord[]): void {
    this.onEvent({ type: 'job', job, outputs })
    if (this.done(job)) {
      const set = this.waiters.get(job.id)
      if (set) {
        this.waiters.delete(job.id)
        for (const f of set) f(job)
      }
    }
  }

  private stopTimer(id: string): void {
    const t = this.timers.get(id)
    if (t) clearTimeout(t)
    this.timers.delete(id)
  }

  private schedule(id: string, startedAt: number, delay = this.pollMs): void {
    this.stopTimer(id)
    this.timers.set(
      id,
      setTimeout(() => void this.poll(id, startedAt), delay)
    )
  }

  private async poll(id: string, startedAt: number): Promise<void> {
    this.timers.delete(id)
    const job = this.ledger.job(id)
    if (!job || job.state !== 'running' || !job.remoteId) return
    const p = this.providers.get(job.provider)
    if (!p) return
    let st
    try {
      st = await p.status(job.remoteId)
    } catch {
      // 일시 오류 — 시간 초과 전까지 다시 묻는다
      if (this.now() - startedAt > this.maxPollMs) this.emit(this.ledger.update(id, { state: 'failed', error: '상태 확인 시간 초과' }))
      else this.schedule(id, startedAt)
      return
    }
    if (st.state === 'queued' || st.state === 'running') {
      if (st.progress != null && st.progress !== job.progress) this.emit(this.ledger.update(id, { progress: st.progress }))
      if (this.now() - startedAt > this.maxPollMs) {
        this.emit(this.ledger.update(id, { state: 'failed', error: '상태 확인 시간 초과 — 서비스에서는 계속 진행 중일 수 있어요' }))
        return
      }
      this.schedule(id, startedAt)
      return
    }
    if (st.state === 'succeeded') {
      const added = this.ledger.addOutputs(id, st.outputs ?? [])
      const cost = st.cost ?? (p.estimateIsExact && job.estimate ? job.estimate : await this.costFromBalance(job))
      const warn = await this.archiveOutputs(p, added)
      const outputs = this.ledger.outputs(id)
      this.emit(this.ledger.update(id, { state: 'succeeded', progress: 1, cost, error: warn.length ? `결과 보관 실패: ${warn.join(' · ')}` : null }), outputs)
      return
    }
    this.emit(this.ledger.update(id, { state: st.state === 'canceled' ? 'canceled' : 'failed', error: st.error ?? null }))
  }

  /** 곧 사라질 결과를 보관한다 — 실패해도 작업은 성공으로 두고 경고만 남긴다 */
  private async archiveOutputs(p: Provider, outputs: OutputRecord[]): Promise<string[]> {
    const a = this.archiver
    if (!a) return []
    const warn: string[] = []
    for (const o of outputs) {
      if (!a.wants(o, this.now())) continue
      try {
        const url = p.resolveOutput ? await p.resolveOutput(o.url) : o.url
        this.ledger.setStorageKey(o.id, await a.archive(o, url))
      } catch (e) {
        warn.push(`${o.kind} — ${(e as Error).message}`)
      }
    }
    return warn
  }

  /** 서비스가 비용을 알려주지 않을 때 — 같은 서비스에 다른 작업이 돌고 있으면 섞이므로 계산하지 않는다 */
  private async costFromBalance(job: JobRecord): Promise<Cost | null> {
    if (!job.balanceBefore) return null
    const others = this.ledger.jobs({ provider: job.provider, state: 'running', limit: 5 }).filter((j) => j.id !== job.id)
    if (others.length) return null
    let after: Balance | null = null
    try {
      after = await this.balance(job.provider)
    } catch {
      return null
    }
    if (!after || !sameUnit(after, job.balanceBefore)) return null
    const spent = job.balanceBefore.amount - after.amount
    if (!(spent > 0)) return null
    const rate = job.balanceBefore.usd != null && job.balanceBefore.amount ? job.balanceBefore.usd / job.balanceBefore.amount : null
    return { amount: spent, unit: after.unit, usd: after.unit === 'usd' ? spent : rate != null ? spent * rate : null }
  }
}
