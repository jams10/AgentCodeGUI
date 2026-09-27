// 어댑터 요청/응답 형식 검증 — 가짜 fetch만 쓴다(실제 서비스 호출 · 과금 없음).
// 기대값은 2026-09에 확인한 각 서비스 공식 문서의 형식이다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TripoProvider, tripoEstimateCredits } from '../src/providers/tripo.ts'
import { HiggsfieldProvider } from '../src/providers/higgsfield.ts'
import { ComfyProvider, comfyBalanceCredits, substituteInputs } from '../src/providers/comfy.ts'
import { LocalArchiver } from '../src/archive.ts'
import { Ledger } from '../src/ledger.ts'
import { Gateway } from '../src/gateway.ts'
import { FakeProvider } from '../src/providers/fake.ts'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function mockFetch(handler: (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = []
  const f = (async (input: string | URL, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    let body: unknown = init.body
    if (typeof body === 'string') body = JSON.parse(body)
    const c: Call = { url: String(input), method: init.method ?? 'GET', headers, body }
    calls.push(c)
    const r = handler(c)
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...(r.headers ?? {}) } })
  }) as typeof fetch
  return { f, calls }
}

// ── Tripo ──────────────────────────────────────────────
test('Tripo: 공개 요금표 견적', () => {
  assert.equal(tripoEstimateCredits('tripo-text-to-3d'), 20)
  assert.equal(tripoEstimateCredits('tripo-text-to-3d', { texture: false }), 10)
  assert.equal(tripoEstimateCredits('tripo-image-to-3d', { texture_quality: 'detailed', quad: true }), 45)
  assert.equal(tripoEstimateCredits('tripo-multiview-to-3d', { geometry_quality: 'detailed', generate_parts: true }), 70)
})

test('Tripo: 텍스트→3D 제출은 v3 엔드포인트에 Bearer 키와 prompt를 보낸다', async () => {
  const { f, calls } = mockFetch(() => ({ body: { code: 0, data: { task_id: 'task_1' } } }))
  const p = new TripoProvider(() => 'tsk_test', f)
  const r = await p.submit({ capability: 'model3d', model: 'tripo-text-to-3d', prompt: 'a knight', params: { model: 'v3.1-20260211' } })
  assert.equal(r.remoteId, 'task_1')
  assert.equal(calls[0].url, 'https://openapi.tripo3d.ai/v3/generation/text-to-model')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers.authorization, 'Bearer tsk_test')
  assert.deepEqual(calls[0].body, { model: 'v3.1-20260211', prompt: 'a knight' })
})

test('Tripo: 이미지 URL 입력은 input 필드, 여러 방향은 inputs[{view:url}]', async () => {
  const { f, calls } = mockFetch(() => ({ body: { code: 0, data: { task_id: 't' } } }))
  const p = new TripoProvider(() => 'k', f)
  await p.submit({ capability: 'model3d', model: 'tripo-image-to-3d', inputs: [{ kind: 'image', url: 'https://x/a.png' }] })
  assert.deepEqual(calls[0].body, { input: 'https://x/a.png' })
  await p.submit({ capability: 'model3d', model: 'tripo-multiview-to-3d', inputs: [{ kind: 'image', url: 'https://x/f.png' }, { kind: 'image', url: 'https://x/b.png', view: 'back' }] })
  assert.equal(calls[1].url, 'https://openapi.tripo3d.ai/v3/generation/multiview-to-model')
  assert.deepEqual(calls[1].body, { inputs: [{ front: 'https://x/f.png' }, { back: 'https://x/b.png' }] })
})

test('Tripo: 성공 상태 → 모델·미리보기 결과, 5분 만료, credits_consumed를 실제 비용으로', async () => {
  const { f } = mockFetch(() => ({
    body: { code: 0, data: { status: 'success', progress: 100, output: { model_url: 'https://cdn/m.glb', rendered_image_url: 'https://cdn/p.png' }, credits_consumed: 30 } }
  }))
  const p = new TripoProvider(() => 'k', f)
  const before = Date.now()
  const s = await p.status('task_1')
  assert.equal(s.state, 'succeeded')
  assert.deepEqual(s.cost, { amount: 30, unit: 'credits', usd: 0.3 })
  assert.equal(s.outputs?.[0].kind, 'model')
  assert.equal(s.outputs?.[1].kind, 'image')
  const exp = s.outputs![0].expiresAt!
  assert.ok(exp - before <= 5 * 60 * 1000 + 50 && exp - before >= 5 * 60 * 1000 - 50)
})

test('Tripo: 잔액 응답 파싱과 오류 봉투 처리', async () => {
  const ok = mockFetch(() => ({ body: { code: 0, data: { balance: '1234.5', frozen: 20 } } }))
  const b = await new TripoProvider(() => 'k', ok.f).balance()
  assert.equal(ok.calls[0].url, 'https://openapi.tripo3d.ai/v3/account/balance')
  assert.equal(b?.amount, 1234.5)
  assert.equal(b?.usd, 12.345)
  const bad = mockFetch(() => ({ body: { code: 2010, message: 'insufficient credits' } }))
  await assert.rejects(new TripoProvider(() => 'k', bad.f).submit({ capability: 'model3d', model: 'tripo-text-to-3d', prompt: 'x' }), /2010/)
})

test('Tripo: banned · failed · cancelled 매핑', async () => {
  for (const [st, want] of [['banned', 'failed'], ['failed', 'failed'], ['cancelled', 'canceled'], ['queued', 'queued']] as const) {
    const { f } = mockFetch(() => ({ body: { code: 0, data: { status: st } } }))
    assert.equal((await new TripoProvider(() => 'k', f).status('t')).state, want)
  }
})

// ── Higgsfield ─────────────────────────────────────────
test('Higgsfield: Key 인증, 모델 경로로 제출, 이미지 입력은 image_url', async () => {
  const { f, calls } = mockFetch(() => ({ body: { status: 'queued', request_id: 'req_1' } }))
  const p = new HiggsfieldProvider(() => 'kid:ksecret', f)
  const r = await p.submit({ capability: 'video', model: 'seedance-2.0-i2v', prompt: 'slow pan', inputs: [{ kind: 'image', url: 'https://x/in.jpg' }], params: { duration: 5 } })
  assert.equal(r.remoteId, 'req_1')
  assert.equal(calls[0].url, 'https://api.higgsfield.ai/bytedance/seedance-2.0/image-to-video')
  assert.equal(calls[0].headers.authorization, 'Key kid:ksecret')
  assert.deepEqual(calls[0].body, { duration: 5, prompt: 'slow pan', image_url: 'https://x/in.jpg' })
})

test('Higgsfield: 견적은 /estimate/<같은 경로>의 usd를 쓰고, 견적 = 청구액', async () => {
  const { f, calls } = mockFetch(() => ({ body: { credits: '1.500', usd: '0.094' } }))
  const p = new HiggsfieldProvider(() => 'a:b', f)
  const e = await p.estimate({ capability: 'image', model: 'soul', prompt: 'portrait' })
  assert.equal(calls[0].url, 'https://api.higgsfield.ai/estimate/higgsfield-ai/soul/standard')
  assert.deepEqual(e.cost, { amount: 0.094, unit: 'usd', usd: 0.094 })
  assert.equal(p.estimateIsExact, true)
})

test('Higgsfield: hf/<경로>로 카탈로그의 다른 모델을 부른다', () => {
  const p = new HiggsfieldProvider(() => 'a:b')
  assert.equal(p.supports({ capability: 'video', model: 'hf/minimax/hailuo-2.3/standard/text-to-video' }), true)
  assert.equal(p.supports({ capability: 'model3d', model: 'tripo-text-to-3d' }), false)
})

test('Higgsfield: 완료 → images/video 결과, nsfw → 실패(과금 없음)', async () => {
  const done = mockFetch(() => ({ body: { status: 'completed', images: [{ url: 'https://o/1.png' }], video: { url: 'https://o/v.mp4' } } }))
  const s = await new HiggsfieldProvider(() => 'a:b', done.f).status('req_1')
  assert.equal(done.calls[0].url, 'https://api.higgsfield.ai/requests/req_1/status')
  assert.deepEqual(s.outputs?.map((o) => o.kind), ['image', 'video'])
  const nsfw = mockFetch(() => ({ body: { status: 'nsfw' } }))
  const n = await new HiggsfieldProvider(() => 'a:b', nsfw.f).status('req_1')
  assert.equal(n.state, 'failed')
  assert.match(n.error ?? '', /과금 없음/)
})

test('Higgsfield: 잔액 API가 없으므로 null', async () => {
  assert.equal(await new HiggsfieldProvider(() => 'a:b').balance(), null)
})

// ── ComfyCloud ─────────────────────────────────────────
test('Comfy: v2 jobs에 워크플로와 파트너 노드 키를 보낸다', async () => {
  const { f, calls } = mockFetch(() => ({ status: 201, body: { id: 'job_1', status: 'queued' } }))
  const p = new ComfyProvider(() => 'comfyui-k', f)
  const wf = { '3': { class_type: 'KSampler', inputs: { seed: 1 } } }
  const r = await p.submit({ capability: 'image', model: 'comfy-workflow', params: { workflow: wf } })
  assert.equal(r.remoteId, 'job_1')
  assert.equal(calls[0].url, 'https://cloud.comfy.org/api/v2/jobs')
  assert.equal(calls[0].headers.authorization, 'Bearer comfyui-k')
  assert.ok(calls[0].headers['idempotency-key'])
  assert.deepEqual(calls[0].body, { workflow: wf, extra_data: { api_key_comfy_org: 'comfyui-k' } })
})

test('Comfy: 워크플로가 없으면 지원하지 않는다', () => {
  const p = new ComfyProvider(() => 'k')
  assert.equal(p.supports({ capability: 'image', model: 'comfy-workflow' }), false)
  assert.equal(p.supports({ capability: 'image', model: 'comfy-workflow', params: { workflow: {} } }), true)
})

test('Comfy: $INPUT_n을 자산 참조로 바꾼다', () => {
  const wf = { '10': { class_type: 'LoadImage', inputs: { image: '$INPUT_0' } }, '11': { inputs: { text: 'keep $INPUT_0 inside text' } } }
  assert.deepEqual(substituteInputs(wf, ['asset-1']), {
    '10': { class_type: 'LoadImage', inputs: { image: { __type: 'core/ASSET', info: { id: 'asset-1' } } } },
    '11': { inputs: { text: 'keep $INPUT_0 inside text' } }
  })
  assert.throws(() => substituteInputs({ a: '$INPUT_1' }, ['x']), /입력 파일이 부족/)
})

test('Comfy: 상태 매핑과 결과 종류', async () => {
  const { f } = mockFetch(() => ({
    body: { id: 'j', status: 'succeeded', outputs: [{ url: 'https://cloud.comfy.org/api/v2/assets/a/content', content_type: 'image/png', name: 'x.png', id: 'a' }, { url: 'https://cloud.comfy.org/api/v2/assets/b/content', content_type: 'video/mp4', id: 'b' }] }
  }))
  const s = await new ComfyProvider(() => 'k', f).status('j')
  assert.equal(s.state, 'succeeded')
  assert.deepEqual(s.outputs?.map((o) => o.kind), ['image', 'video'])
  for (const [st, want] of [['canceling', 'running'], ['expired', 'failed'], ['queued', 'queued']] as const) {
    const m = mockFetch(() => ({ body: { status: st } }))
    assert.equal((await new ComfyProvider(() => 'k', m.f).status('j')).state, want)
  }
})

test('Comfy: 잔액(센트) → 크레딧(211/USD), 0이 아닌 첫 값 우선', () => {
  assert.equal(comfyBalanceCredits({ effective_balance_micros: 1000 }), 2110)
  assert.equal(comfyBalanceCredits({ effective_balance_micros: 0, prepaid_balance_micros: 500 }), 1055)
  assert.equal(comfyBalanceCredits({}), null)
})

test('Comfy: 결과 링크는 302 Location(서명 URL)을 돌려준다', async () => {
  const { f, calls } = mockFetch(() => ({ status: 302, headers: { location: 'https://storage.googleapis.com/signed?x=1' } }))
  const url = await new ComfyProvider(() => 'k', f).resolveOutput('https://cloud.comfy.org/api/v2/assets/a/content')
  assert.equal(url, 'https://storage.googleapis.com/signed?x=1')
  assert.equal(calls[0].headers.authorization, 'Bearer k')
})

// ── 결과 보관 ───────────────────────────────────────────
test('곧 만료되는 결과는 완료 즉시 로컬에 보관하고 저장 키를 남긴다', async () => {
  const srv = createServer((_q, r) => {
    r.writeHead(200, { 'content-type': 'model/gltf-binary' })
    r.end(Buffer.from('glTF-bytes'))
  })
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))
  const port = (srv.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'gw-archive-'))
  try {
    const fake = new FakeProvider({ id: 'tripo' })
    // 5분 뒤 만료되는 모델 결과를 흉내 낸다
    fake.status = async () => ({ state: 'succeeded', outputs: [{ kind: 'model', url: `http://127.0.0.1:${port}/m.glb`, expiresAt: Date.now() + 5 * 60 * 1000 }], cost: null })
    const ledger = new Ledger(':memory:')
    const gw = new Gateway({ ledger, providers: [fake], routes: [{ capability: 'image', model: 'm', providers: ['tripo'] }], pollMs: 1, archiver: new LocalArchiver(dir) })
    const job = await gw.quote({ capability: 'image', model: 'm' })
    await gw.approve(job.id)
    const done = await gw.waitFor(job.id, 3000)
    assert.equal(done.state, 'succeeded')
    const [o] = gw.outputs(job.id)
    assert.match(o.storageKey ?? '', /^local:.+\.glb$/)
    assert.equal(readFileSync(join(dir, o.storageKey!.slice(6))).toString(), 'glTF-bytes')
  } finally {
    srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
