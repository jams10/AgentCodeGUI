// 어댑터 요청/응답 형식 검증 — 가짜 fetch만 쓴다(실제 서비스 호출 · 과금 없음).
// 기대값은 2026-09에 확인한 각 서비스 공식 문서의 형식이다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TripoProvider, tripoEstimateCredits } from '../src/providers/tripo.ts'
import { HiggsfieldProvider, tokenMeteredUsd } from '../src/providers/higgsfield.ts'
import { ComfyProvider, comfyBalanceCredits, findPromptSlot, substituteInputs } from '../src/providers/comfy.ts'
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

test('Tripo: 모델 버전을 안 주면 기본 H3.1로 보낸다(필수 필드)', async () => {
  const { f, calls } = mockFetch(() => ({ body: { code: 0, data: { task_id: 't' } } }))
  await new TripoProvider(() => 'k', f).submit({ capability: 'model3d', model: 'tripo-text-to-3d', prompt: 'a frog' })
  assert.deepEqual(calls[0].body, { model: 'v3.1-20260211', prompt: 'a frog' })
})

test('Tripo: 이미지 URL 입력은 input 필드, 여러 방향은 inputs[{view:url}]', async () => {
  const { f, calls } = mockFetch(() => ({ body: { code: 0, data: { task_id: 't' } } }))
  const p = new TripoProvider(() => 'k', f)
  await p.submit({ capability: 'model3d', model: 'tripo-image-to-3d', inputs: [{ kind: 'image', url: 'https://x/a.png' }] })
  assert.deepEqual(calls[0].body, { model: 'v3.1-20260211', input: 'https://x/a.png' })
  await p.submit({ capability: 'model3d', model: 'tripo-multiview-to-3d', inputs: [{ kind: 'image', url: 'https://x/f.png' }, { kind: 'image', url: 'https://x/b.png', view: 'back' }] })
  assert.equal(calls[1].url, 'https://openapi.tripo3d.ai/v3/generation/multiview-to-model')
  assert.deepEqual(calls[1].body, { model: 'v3.1-20260211', inputs: [{ front: 'https://x/f.png' }, { back: 'https://x/b.png' }] })
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

// 2026-09 실제 응답 문구(Seedance 2.0) — 금액 대신 요금 설명을 준다
const SEEDANCE_PRICING = 'Token-metered pricing. Billable video tokens = ceil(generated video seconds × output width × output height × 24 fps / 1024). Image and audio references do not count as video input. Per 1,000 video tokens: 480p/720p/1080p $0.014, 4K $0.008. Rates shown are before any applicable customer discount.'

test('Higgsfield: 토큰 과금 설명문으로 견적을 계산한다', async () => {
  // 5초 · 1280×720 → ceil(5×1280×720×24/1024) = 108000 토큰 × $0.014/1000 = $1.512
  assert.equal(tokenMeteredUsd(SEEDANCE_PRICING, { duration: 5, resolution: '720p', aspect_ratio: '16:9' }), 1.512)
  assert.equal(tokenMeteredUsd(SEEDANCE_PRICING, { duration: 5, resolution: '720p', aspect_ratio: '9:16' }), 1.512)
  assert.equal(tokenMeteredUsd(SEEDANCE_PRICING, { duration: 5, resolution: '4k', aspect_ratio: '16:9' }), 7.776) // 3840×2160 → 972000 토큰 × $0.008
  assert.equal(tokenMeteredUsd(SEEDANCE_PRICING, {}), 1.512) // 기본값 5초 · 720p · 16:9
  assert.equal(tokenMeteredUsd('Flat price per request.', { resolution: '720p' }), null) // 모르는 형식은 견적 없음
  assert.equal(tokenMeteredUsd(SEEDANCE_PRICING, { resolution: '2K' }), null)
  const { f } = mockFetch(() => ({ body: { type: 'description', pricing_description: SEEDANCE_PRICING } }))
  const e = await new HiggsfieldProvider(() => 'a:b', f).estimate({ capability: 'video', model: 'seedance-2.0-t2v', prompt: 'x', params: { duration: 10, resolution: '480p', aspect_ratio: '16:9' } })
  assert.deepEqual(e.cost, { amount: 1.343, unit: 'usd', usd: 1.343 }) // 10초 · 853×480 → 95963 토큰
})

test('Higgsfield: 옵션 값이 틀려 거절되면 견적 단계에서 요청 오류(작업을 만들지 않음)', async () => {
  const { f } = mockFetch(() => ({ status: 400, body: { detail: "resolution: '2K' is not one of ['720p', '1080p']" } }))
  const e = await new HiggsfieldProvider(() => 'a:b', f).estimate({ capability: 'image', model: 'soul', prompt: 'x', params: { resolution: '2K' } })
  assert.equal(e.cost, null)
  assert.match(e.invalid ?? '', /2K/)
})

test('Higgsfield: API에 없는 모델 경로(404)는 견적 단계에서 요청 오류', async () => {
  const { f } = mockFetch(() => ({ status: 404, body: { detail: 'model_not_found' } }))
  const e = await new HiggsfieldProvider(() => 'a:b', f).estimate({ capability: 'image', model: 'hf/openai/gpt-image-2.5-sunburst', prompt: 'x' })
  assert.match(e.invalid ?? '', /API에 없는 모델 경로/)
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

test('Higgsfield: 연결 확인은 견적(과금 없음)으로, 인증 오류는 그대로 올린다', async () => {
  const ok = mockFetch(() => ({ body: { credits: '1.5', usd: '0.094' } }))
  assert.match(await new HiggsfieldProvider(() => 'a:b', ok.f).verify(), /인증 확인됨/)
  assert.equal(ok.calls[0].url, 'https://api.higgsfield.ai/estimate/higgsfield-ai/soul/standard')
  const bad = mockFetch(() => ({ status: 401, body: { detail: 'Invalid credentials' } }))
  await assert.rejects(new HiggsfieldProvider(() => 'a:b', bad.f).verify(), /401.*Invalid credentials/)
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

test('Comfy: 워크플로를 파일 경로로도 받고, UI 형식 파일은 알아듣기 쉬운 오류로 거절한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-wf-'))
  try {
    const api = join(dir, 'api.json')
    const ui = join(dir, 'ui.json')
    writeFileSync(api, JSON.stringify({ '3': { class_type: 'KSampler', inputs: {} } }))
    writeFileSync(ui, JSON.stringify({ nodes: [], links: [] }))
    const { f, calls } = mockFetch(() => ({ status: 201, body: { id: 'job_2' } }))
    const p = new ComfyProvider(() => 'k', f)
    assert.equal(p.supports({ capability: 'image', model: 'comfy-workflow', params: { workflowPath: join(dir, 'missing.json') } }), false)
    assert.equal(p.supports({ capability: 'image', model: 'comfy-workflow', params: { workflowPath: api } }), true)
    await p.submit({ capability: 'image', model: 'comfy-workflow', params: { workflowPath: api } })
    assert.deepEqual((calls[0].body as { workflow: unknown }).workflow, { '3': { class_type: 'KSampler', inputs: {} } })
    await assert.rejects(p.submit({ capability: 'image', model: 'comfy-workflow', params: { workflowPath: ui } }), /Export \(API\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Comfy: 준비 단계에서 워크플로를 스냅숏하고 프롬프트를 꺼내며, 제출 때 고친 프롬프트를 그 자리에 쓴다', async () => {
  const wf = {
    '1': { class_type: 'OpenAIGPTImageNodeV2', inputs: { prompt: 'a frog knight holding a lantern', size: '1024x1536' } },
    '2': { class_type: 'CLIPTextEncode', _meta: { title: 'Negative Prompt' }, inputs: { text: 'blurry, low quality, watermark, extra fingers, very long negative text here' } },
    '3': { class_type: 'LoadImage', inputs: { image: '$INPUT_0' } }
  }
  assert.deepEqual(findPromptSlot(wf), { node: '1', key: 'prompt', text: 'a frog knight holding a lantern' })
  const dir = mkdtempSync(join(tmpdir(), 'gw-wf-'))
  try {
    const file = join(dir, 'wf.json')
    writeFileSync(file, JSON.stringify(wf))
    const { f, calls } = mockFetch(() => ({ status: 201, body: { id: 'job_3' } }))
    const p = new ComfyProvider(() => 'k', f)
    const r = await p.prepare({ capability: 'image', model: 'comfy-workflow', params: { workflowPath: file } })
    assert.equal(r.prompt, 'a frog knight holding a lantern') // 워크플로 안의 프롬프트가 기록된다
    assert.deepEqual(r.params?.workflow, wf) // 파일이 지워져도 다시 만들 수 있게 스냅숏
    assert.deepEqual(r.params?.promptSlot, { node: '1', key: 'prompt' })
    rmSync(file)
    // 카드에서 고친 프롬프트로 제출 — 스냅숏의 그 자리에 들어간다(입력 이미지 없이 부르면 $INPUT_0 오류이므로 LoadImage는 뺀다)
    const { '3': _drop, ...noInput } = wf
    await p.submit({ ...r, prompt: 'a frog knight holding TWO lanterns', params: { ...r.params, workflow: noInput } })
    const sent = (calls[0].body as { workflow: Record<string, { inputs: Record<string, unknown> }> }).workflow
    assert.equal(sent['1'].inputs.prompt, 'a frog knight holding TWO lanterns')
    assert.equal(sent['2'].inputs.text, wf['2'].inputs.text) // 네거티브는 그대로
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Comfy: UI 형식 워크플로는 준비 단계에서 거절한다(작업을 만들지 않음)', async () => {
  const p = new ComfyProvider(() => 'k')
  await assert.rejects(p.prepare({ capability: 'image', model: 'comfy-workflow', params: { workflow: { nodes: [], links: [] } } }), /Export \(API\)/)
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

test('Comfy: 결과 삭제는 주소의 자산 id로 DELETE /api/assets/{id}(X-API-Key), 이미 없으면(404) 성공으로 본다', async () => {
  const id = '0f6c3e2a-1b2c-4d5e-8f90-1234567890ab'
  const ok = mockFetch(() => ({ status: 204 }))
  const o = { id: 'o', jobId: 'j', kind: 'image' as const, url: `https://cloud.comfy.org/api/v2/assets/${id}/content`, mime: null, expiresAt: null, storageKey: null, createdAt: 0 }
  assert.equal(await new ComfyProvider(() => 'k', ok.f).deleteOutput(o), true)
  assert.equal(ok.calls[0].method, 'DELETE')
  assert.equal(ok.calls[0].url, `https://cloud.comfy.org/api/assets/${id}`)
  assert.equal(ok.calls[0].headers['x-api-key'], 'k')
  const gone = mockFetch(() => ({ status: 404 }))
  assert.equal(await new ComfyProvider(() => 'k', gone.f).deleteOutput(o), true)
  const bad = mockFetch(() => ({ status: 500 }))
  await assert.rejects(new ComfyProvider(() => 'k', bad.f).deleteOutput(o), /HTTP 500/)
})

test('로컬 보관본 지우기: 파일과 빈 작업 폴더를 지우고, 보관 폴더 밖 경로는 거절한다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-rm-'))
  try {
    const a = new LocalArchiver(dir)
    mkdtempSync(join(dir, 'x')) // 다른 폴더는 남아야 한다
    const jobDir = join(dir, 'job1')
    mkdirSync(jobDir)
    writeFileSync(join(jobDir, 'o.png'), 'x')
    await a.remove('local:job1/o.png')
    assert.equal(existsSync(jobDir), false)
    await a.remove('local:job1/o.png') // 없어도 조용히 넘어간다
    await assert.rejects(a.remove('local:../outside.png'), /보관 폴더 밖/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── 결과 보관 ───────────────────────────────────────────
test('결과는 완료 즉시 로컬에 보관하고 저장 키를 남긴다(곧 만료되는 결과)', async () => {
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

test('만료 시각이 없는 결과도 보관하고, 주소에 확장자가 없으면 응답 형식으로 정한다(Comfy …/content)', async () => {
  const srv = createServer((_q, r) => {
    r.writeHead(200, { 'content-type': 'image/webp' })
    r.end(Buffer.from('webp-bytes'))
  })
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))
  const port = (srv.address() as { port: number }).port
  const dir = mkdtempSync(join(tmpdir(), 'gw-archive-'))
  try {
    const fake = new FakeProvider({ id: 'comfy' })
    fake.status = async () => ({ state: 'succeeded', outputs: [{ kind: 'image', url: `http://127.0.0.1:${port}/api/v2/assets/a/content`, expiresAt: null }], cost: null })
    const ledger = new Ledger(':memory:')
    const gw = new Gateway({ ledger, providers: [fake], routes: [{ capability: 'image', model: 'm', providers: ['comfy'] }], pollMs: 1, archiver: new LocalArchiver(dir) })
    const job = await gw.quote({ capability: 'image', model: 'm' })
    await gw.approve(job.id)
    assert.equal((await gw.waitFor(job.id, 3000)).state, 'succeeded')
    const [o] = gw.outputs(job.id)
    assert.match(o.storageKey ?? '', /^local:.+\.webp$/)
    assert.equal(readFileSync(join(dir, o.storageKey!.slice(6))).toString(), 'webp-bytes')
  } finally {
    srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
