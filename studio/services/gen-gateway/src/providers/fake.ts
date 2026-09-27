// 테스트용 가짜 서비스 — 네트워크·과금 없음. 잔액·비용·실패를 조절해 게이트웨이 규칙을 검증한다.
import type { Balance, Estimate, GenerationRequest, Provider, ProviderId, RemoteStatus } from '../types.ts'

export interface FakeOptions {
  id?: ProviderId
  configured?: boolean
  balance?: number | null
  unit?: 'credits' | 'usd'
  price?: number | null
  models?: string[]
  /** 몇 번 물어보면 끝나나 */
  steps?: number
  fail?: string
  /** 서비스가 실제 비용을 알려주나 */
  reportsCost?: boolean
  estimateIsExact?: boolean
}

export class FakeProvider implements Provider {
  readonly id: ProviderId
  readonly estimateIsExact: boolean
  opts: Required<Omit<FakeOptions, 'fail' | 'id' | 'estimateIsExact'>> & { fail?: string }
  submitted: GenerationRequest[] = []
  private readonly jobs = new Map<string, { left: number }>()
  private seq = 0

  constructor(o: FakeOptions = {}) {
    this.id = o.id ?? 'fake'
    this.estimateIsExact = o.estimateIsExact ?? false
    this.opts = {
      configured: o.configured ?? true,
      balance: o.balance === undefined ? 100 : o.balance,
      unit: o.unit ?? 'credits',
      price: o.price === undefined ? 10 : o.price,
      models: o.models ?? ['m'],
      steps: o.steps ?? 1,
      reportsCost: o.reportsCost ?? true,
      fail: o.fail
    }
  }

  configured(): boolean {
    return this.opts.configured
  }
  supports(req: GenerationRequest): boolean {
    return this.opts.models.includes(req.model)
  }
  async balance(): Promise<Balance | null> {
    const b = this.opts.balance
    return b == null ? null : { amount: b, unit: this.opts.unit, usd: this.opts.unit === 'usd' ? b : b / 100, checkedAt: Date.now() }
  }
  async estimate(): Promise<Estimate> {
    const p = this.opts.price
    return { cost: p == null ? null : { amount: p, unit: this.opts.unit, usd: this.opts.unit === 'usd' ? p : p / 100 } }
  }
  async submit(req: GenerationRequest): Promise<{ remoteId: string }> {
    this.submitted.push(req)
    const id = `r${++this.seq}`
    this.jobs.set(id, { left: this.opts.steps })
    return { remoteId: id }
  }
  async status(remoteId: string): Promise<RemoteStatus> {
    const j = this.jobs.get(remoteId)
    if (!j) return { state: 'failed', error: 'unknown job' }
    if (--j.left > 0) return { state: 'running', progress: 0.5 }
    if (this.opts.fail) return { state: 'failed', error: this.opts.fail }
    const p = this.opts.price ?? 0
    if (this.opts.balance != null) this.opts.balance -= p
    return {
      state: 'succeeded',
      outputs: [{ kind: 'image', url: `https://fake.local/${remoteId}.png` }],
      cost: this.opts.reportsCost && this.opts.price != null ? { amount: p, unit: this.opts.unit, usd: this.opts.unit === 'usd' ? p : p / 100 } : undefined
    }
  }
  async cancel(): Promise<void> {}
}
