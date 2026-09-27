// 게이트웨이 규칙 검증 — 가짜 서비스만 쓴다(네트워크 · 과금 없음).
// 실행: node --test studio/services/gen-gateway/test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ledger } from '../src/ledger.ts'
import { Gateway, GatewayError } from '../src/gateway.ts'
import { FakeProvider } from '../src/providers/fake.ts'
import { findRoute, type Route } from '../src/routes.ts'
import type { Estimate, GenerationRequest } from '../src/types.ts'

const req: GenerationRequest = { capability: 'image', model: 'm', prompt: 'a chrome sphere', origin: { space: 'chat', source: 'agent' } }

function setup(providers: FakeProvider[], routes: Route[] = [{ capability: 'image', model: 'm', providers: providers.map((p) => p.id) }]) {
  const ledger = new Ledger(':memory:')
  const events: string[] = []
  const gw = new Gateway({ ledger, providers, routes, pollMs: 1, onEvent: (e) => e.type === 'job' && events.push(e.job.state) })
  return { ledger, gw, events }
}

test('견적은 승인 대기만 만들고, 승인 전에는 서비스에 제출하지 않는다', async () => {
  const p = new FakeProvider({ id: 'comfy' })
  const { gw } = setup([p])
  const job = await gw.quote(req)
  assert.equal(job.state, 'awaiting_approval')
  assert.equal(job.provider, 'comfy')
  assert.deepEqual(job.estimate, { amount: 10, unit: 'credits', usd: 0.1 })
  assert.equal(p.submitted.length, 0)
})

test('승인하면 제출 → 완료까지 추적하고 결과와 실제 비용을 기록한다', async () => {
  const p = new FakeProvider({ id: 'comfy', steps: 3 })
  const { gw, events } = setup([p])
  const job = await gw.quote(req)
  await gw.approve(job.id)
  const done = await gw.waitFor(job.id, 2000)
  assert.equal(done.state, 'succeeded')
  assert.equal(p.submitted.length, 1)
  assert.deepEqual(done.cost, { amount: 10, unit: 'credits', usd: 0.1 })
  assert.equal(gw.outputs(job.id).length, 1)
  assert.deepEqual(events.slice(0, 3), ['awaiting_approval', 'submitting', 'running'])
  assert.equal(events.at(-1), 'succeeded')
})

test('거절한 작업은 제출되지 않고, 다시 승인할 수 없다', async () => {
  const p = new FakeProvider({ id: 'comfy' })
  const { gw } = setup([p])
  const job = await gw.quote(req)
  assert.equal(gw.reject(job.id).state, 'rejected')
  await assert.rejects(gw.approve(job.id), (e: unknown) => e instanceof GatewayError && e.code === 'bad_state')
  assert.equal(p.submitted.length, 0)
})

test('1순위 잔액이 부족하면 2순위로 넘어가고 이유를 남긴다', async () => {
  const hf = new FakeProvider({ id: 'higgsfield', unit: 'usd', balance: 0.05, price: 0.4 })
  const comfy = new FakeProvider({ id: 'comfy', balance: 500, price: 20 })
  const { gw } = setup([hf, comfy])
  const job = await gw.quote(req)
  assert.equal(job.provider, 'comfy')
  assert.match(job.fallbackReason ?? '', /higgsfield: 잔액 부족\(\$0\.05 < 예상 \$0\.40\)/)
})

test('키가 없거나 모델을 지원하지 않는 서비스는 건너뛴다', async () => {
  const noKey = new FakeProvider({ id: 'higgsfield', configured: false })
  const noModel = new FakeProvider({ id: 'tripo', models: ['other'] })
  const ok = new FakeProvider({ id: 'comfy' })
  const { gw } = setup([noKey, noModel, ok])
  const job = await gw.quote(req)
  assert.equal(job.provider, 'comfy')
  assert.match(job.fallbackReason ?? '', /higgsfield: API 키 없음/)
  assert.match(job.fallbackReason ?? '', /tripo: 이 모델을 지원하지 않음/)
})

test('쓸 수 있는 서비스가 없으면 이유와 함께 거부한다', async () => {
  const p = new FakeProvider({ id: 'comfy', balance: 1, price: 50 })
  const { gw } = setup([p])
  await assert.rejects(gw.quote(req), (e: unknown) => e instanceof GatewayError && e.code === 'no_provider' && /잔액 부족/.test(e.message))
})

test('라우팅 표에 없는 모델은 거부한다', async () => {
  const { gw } = setup([new FakeProvider({ id: 'comfy' })])
  await assert.rejects(gw.quote({ ...req, model: 'nope' }), (e: unknown) => e instanceof GatewayError && e.code === 'no_route')
})

test('잔액을 알 수 없으면(잔액 API 없음) 막지 않고 진행한다', async () => {
  const p = new FakeProvider({ id: 'higgsfield', unit: 'usd', balance: null, price: 0.2 })
  const { gw } = setup([p])
  const job = await gw.quote(req)
  assert.equal(job.provider, 'higgsfield')
  assert.equal(job.balanceBefore, null)
})

test('서비스가 비용을 안 알려주면 잔액 차이로 기록한다', async () => {
  const p = new FakeProvider({ id: 'comfy', balance: 300, price: 42, reportsCost: false })
  const { gw } = setup([p])
  const job = await gw.quote(req)
  await gw.approve(job.id)
  const done = await gw.waitFor(job.id, 2000)
  assert.deepEqual(done.cost, { amount: 42, unit: 'credits', usd: 0.42 })
})

test('견적이 곧 청구액인 서비스는 견적을 실제 비용으로 기록한다', async () => {
  const p = new FakeProvider({ id: 'higgsfield', unit: 'usd', balance: null, price: 0.9, reportsCost: false, estimateIsExact: true })
  const { gw } = setup([p])
  const job = await gw.quote(req)
  await gw.approve(job.id)
  const done = await gw.waitFor(job.id, 2000)
  assert.deepEqual(done.cost, { amount: 0.9, unit: 'usd', usd: 0.9 })
})

test('서비스 실패는 실패로 기록하고 비용을 매기지 않는다', async () => {
  const p = new FakeProvider({ id: 'comfy', fail: 'nsfw' })
  const { gw } = setup([p])
  const job = await gw.quote(req)
  await gw.approve(job.id)
  const done = await gw.waitFor(job.id, 2000)
  assert.equal(done.state, 'failed')
  assert.equal(done.error, 'nsfw')
  assert.equal(done.cost, null)
})

test('재시작 시 제출 중이던 작업은 재제출하지 않고 확인 필요로 남긴다', async () => {
  const p = new FakeProvider({ id: 'comfy' })
  const { gw, ledger } = setup([p])
  const job = await gw.quote(req)
  ledger.update(job.id, { state: 'submitting' })
  gw.resume()
  const j = ledger.job(job.id)!
  assert.equal(j.state, 'failed')
  assert.match(j.error ?? '', /확인할 수 없어요/)
  assert.equal(p.submitted.length, 0)
})

test('기간별 사용액 집계', async () => {
  const a = new FakeProvider({ id: 'comfy', price: 100, balance: 1000 })
  const { gw, ledger } = setup([a])
  for (let i = 0; i < 2; i++) {
    const j = await gw.quote(req)
    await gw.approve(j.id)
    await gw.waitFor(j.id, 2000)
  }
  assert.deepEqual(ledger.spend(0), [{ provider: 'comfy', jobs: 2, usd: 2, unknown: 0 }])
})

test('라우팅: 정확한 이름 > 접두(hf/*) > *', () => {
  const routes: Route[] = [
    { capability: 'video', model: '*', providers: ['comfy'] },
    { capability: 'video', model: 'hf/*', providers: ['higgsfield'] },
    { capability: 'video', model: 'seedance', providers: ['tripo'] }
  ]
  assert.deepEqual(findRoute(routes, 'video', 'seedance')?.providers, ['tripo'])
  assert.deepEqual(findRoute(routes, 'video', 'hf/bytedance/x')?.providers, ['higgsfield'])
  assert.deepEqual(findRoute(routes, 'video', 'other')?.providers, ['comfy'])
  assert.equal(findRoute(routes, 'image', 'x'), null)
})

test('승인 전 고치기: 옵션을 바꾸면 같은 작업 id로 다시 견적, 틀린 값은 거절하고 원래 값을 지킨다', async () => {
  const p = new FakeProvider({ id: 'comfy' })
  // 장수에 비례하는 견적, 'bad' 옵션은 서비스가 거절
  ;(p as unknown as { estimate: (r: GenerationRequest) => Promise<Estimate> }).estimate = async (r) =>
    r.params?.bad ? { cost: null, invalid: "옵션 값이 맞지 않아요 — bad: not allowed" } : { cost: { amount: 10 * Number(r.params?.n ?? 1), unit: 'credits' as const, usd: 0.1 * Number(r.params?.n ?? 1) } }
  const { gw, ledger } = setup([p])
  const job = await gw.quote({ ...req, params: { n: 1 } })
  const next = await gw.revise(job.id, { params: { n: 3 } })
  assert.equal(next.id, job.id)
  assert.deepEqual(next.params, { n: 3 })
  assert.equal(next.estimate?.amount, 30)
  await assert.rejects(gw.revise(job.id, { params: { n: 3, bad: true } }), (e: unknown) => e instanceof GatewayError && e.code === 'bad_request')
  assert.deepEqual(ledger.job(job.id)?.params, { n: 3 }) // 거절된 변경은 남지 않는다
  const edited = await gw.revise(job.id, { prompt: '  a glass sphere ' })
  assert.equal(edited.prompt, 'a glass sphere')
  // 승인 뒤에는 고칠 수 없다
  await gw.approve(job.id)
  await assert.rejects(gw.revise(job.id, { params: { n: 1 } }), (e: unknown) => e instanceof GatewayError && e.code === 'bad_state')
  assert.equal(p.submitted[0].params?.n, 3) // 고친 옵션으로 제출된다
})

test('결과 지우기: 보관본과 서비스 결과를 지우고, 비용 기록은 남긴다 · 진행 중이면 거절', async () => {
  const p = new FakeProvider({ id: 'comfy' })
  const remoteDeleted: string[] = []
  ;(p as unknown as { deleteOutput: (o: { id: string }) => Promise<boolean> }).deleteOutput = async (o) => (remoteDeleted.push(o.id), true)
  const removed: string[] = []
  const archiver = { wants: () => true, archive: async (o: { id: string }) => `local:${o.id}.png`, remove: async (k: string) => void removed.push(k) }
  const ledger = new Ledger(':memory:')
  const gw = new Gateway({ ledger, providers: [p], routes: [{ capability: 'image', model: 'm', providers: ['comfy'] }], pollMs: 1, archiver })
  const pending = await gw.quote(req)
  await assert.rejects(gw.deleteJob(pending.id), (e: unknown) => e instanceof GatewayError && e.code === 'bad_state')
  gw.reject(pending.id)
  const job = await gw.quote(req)
  await gw.approve(job.id)
  await gw.waitFor(job.id, 2000)
  const outs = ledger.outputs(job.id)
  assert.equal(outs.length, 1)
  const r = await gw.deleteJob(job.id)
  assert.deepEqual(r, { local: 1, remote: 1, remoteSupported: true })
  assert.deepEqual(removed, [`local:${outs[0].id}.png`])
  assert.deepEqual(remoteDeleted, [outs[0].id])
  assert.equal(ledger.outputs(job.id).length, 0) // 갤러리에서 사라진다
  assert.equal(ledger.spend(0)[0]?.jobs, 1) // 사용액 합계에는 남는다
})

test('결과 지우기: 서비스 삭제가 실패하면 기록을 그대로 두고 오류를 돌려준다', async () => {
  const p = new FakeProvider({ id: 'comfy' })
  ;(p as unknown as { deleteOutput: () => Promise<boolean> }).deleteOutput = async () => {
    throw new Error('ComfyCloud 결과 삭제 실패 (HTTP 500)')
  }
  const { gw, ledger } = setup([p])
  const job = await gw.quote(req)
  await gw.approve(job.id)
  await gw.waitFor(job.id, 2000)
  await assert.rejects(gw.deleteJob(job.id), (e: unknown) => e instanceof GatewayError && e.code === 'delete_failed' && /HTTP 500/.test(e.message))
  assert.equal(ledger.outputs(job.id).length, 1)
})
