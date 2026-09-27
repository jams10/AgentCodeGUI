// 스타일(결과 분류 + 프롬프트 프리셋) 검증 — 가짜 서비스만 쓴다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Ledger } from '../src/ledger.ts'
import { Gateway, GatewayError, composePrompt } from '../src/gateway.ts'
import { FakeProvider } from '../src/providers/fake.ts'
import { startServer } from '../src/server.ts'

function setup(models = ['m']) {
  const ledger = new Ledger(':memory:')
  const fake = new FakeProvider({ id: 'tripo', models })
  const gateway = new Gateway({ ledger, providers: [fake], routes: models.map((m) => ({ capability: 'model3d' as const, model: m, providers: ['tripo' as const] })), pollMs: 1 })
  return { ledger, fake, gateway }
}

test('프롬프트 조합: 앞 문구 + 프롬프트 + 뒤 문구, 빈 값은 건너뛴다', () => {
  assert.equal(composePrompt({ promptPrefix: '1990s FMV cutscene', promptSuffix: 'CRT scanlines' }, 'a knight'), '1990s FMV cutscene, a knight, CRT scanlines')
  assert.equal(composePrompt({ promptPrefix: ' cute ', promptSuffix: null }, undefined), 'cute')
  assert.equal(composePrompt({ promptPrefix: null, promptSuffix: '' }, '  '), undefined)
})

test('스타일을 고르면 최종 프롬프트가 견적 · 기록 · 제출에 그대로 쓰이고 분류된다', async () => {
  const { ledger, fake, gateway } = setup()
  const st = ledger.createStyle({ name: '90년대 FMV', promptPrefix: '1990s FMV cutscene, low-poly', promptSuffix: 'CRT scanlines' })
  const job = await gateway.quote({ capability: 'model3d', model: 'm', prompt: 'a knight', style: '90년대 fmv' })
  assert.equal(job.prompt, '1990s FMV cutscene, low-poly, a knight, CRT scanlines')
  assert.equal(job.styleId, st.id)
  assert.equal(job.origin?.userPrompt, 'a knight')
  await gateway.approve(job.id)
  await gateway.waitFor(job.id, 2000)
  assert.equal(fake.submitted[0].prompt, '1990s FMV cutscene, low-poly, a knight, CRT scanlines')
  assert.equal(ledger.styles()[0].count, 1)
})

test('네거티브는 그 옵션을 받는 모델에만 넣고, 사용자가 준 값은 덮지 않는다', async () => {
  const { ledger, gateway } = setup(['tripo-text-to-3d', 'tripo-image-to-3d'])
  ledger.createStyle({ name: '심플', negative: 'noise, clutter' })
  const takes = await gateway.quote({ capability: 'model3d', model: 'tripo-text-to-3d', prompt: 'cup', style: '심플' })
  assert.equal(takes.params?.negative_prompt, 'noise, clutter')
  const own = await gateway.quote({ capability: 'model3d', model: 'tripo-text-to-3d', prompt: 'cup', style: '심플', params: { negative_prompt: 'mine' } })
  assert.equal(own.params?.negative_prompt, 'mine')
  const not = await gateway.quote({ capability: 'model3d', model: 'tripo-image-to-3d', style: '심플' })
  assert.equal(not.params?.negative_prompt, undefined)
})

test('없는 스타일은 거부한다', async () => {
  const { gateway } = setup()
  await assert.rejects(gateway.quote({ capability: 'model3d', model: 'm', style: 'nope' }), (e: unknown) => e instanceof GatewayError && e.code === 'no_style')
})

test('스타일을 지우면 결과는 남고 분류만 풀린다', async () => {
  const { ledger, gateway } = setup()
  const st = ledger.createStyle({ name: '귀엽고 멍청' })
  const job = await gateway.quote({ capability: 'model3d', model: 'm', style: st.id })
  assert.equal(ledger.deleteStyle(st.id), true)
  assert.equal(ledger.job(job.id)?.styleId, null)
  assert.equal(ledger.styles().length, 0)
})

test('이전 기록부(style_id 없음)를 열면 열을 더하고 기존 기록은 그대로다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-mig-'))
  const file = join(dir, 'old.db')
  try {
    const old = new DatabaseSync(file)
    old.exec(`create table jobs (id text primary key, created_at integer not null, updated_at integer not null, state text not null, capability text not null, model text not null, provider text not null, prompt text, params text, inputs text, origin text, estimate text, cost text, fallback_reason text, remote_id text, progress real, error text, balance_before text)`)
    old.prepare(`insert into jobs (id, created_at, updated_at, state, capability, model, provider, prompt) values ('j1', 1, 1, 'succeeded', 'image', 'm', 'comfy', 'old')`).run()
    old.close()
    const l = new Ledger(file)
    assert.equal(l.job('j1')?.prompt, 'old')
    assert.equal(l.job('j1')?.styleId, null)
    l.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('스타일 API: 만들기 · 중복 거절 · 고치기 · 결과 분류 바꾸기 · 지우기', async () => {
  const { ledger, gateway } = setup()
  const srv = await startServer({ gateway, ledger, secrets: null, providers: [], infoFile: null })
  const call = (p: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${srv.port}${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  try {
    const created = await call('/styles', { name: '90년대 FMV', promptPrefix: '1990s FMV' })
    assert.equal(created.status, 201)
    const st = (await created.json()) as { id: string }
    assert.equal((await call('/styles', { name: '90년대 fmv' })).status, 400)
    assert.equal((await call('/styles', { name: '' })).status, 400)
    const upd = (await (await call(`/styles/${st.id}`, { description: 'PS1 컷신 느낌' })).json()) as { description: string; name: string }
    assert.equal(upd.description, 'PS1 컷신 느낌')
    assert.equal(upd.name, '90년대 FMV')
    const job = await gateway.quote({ capability: 'model3d', model: 'm' })
    const moved = (await (await call(`/jobs/${job.id}/style`, { styleId: st.id })).json()) as { styleId: string }
    assert.equal(moved.styleId, st.id)
    assert.equal((await call(`/jobs/${job.id}/style`, { styleId: 'nope' })).status, 404)
    const list = (await (await call('/styles')).json()) as { count: number }[]
    assert.equal(list[0].count, 1)
    assert.equal((await call(`/styles/${st.id}/delete`, {})).status, 200)
    assert.equal(ledger.job(job.id)?.styleId, null)
  } finally {
    await srv.close()
  }
})
