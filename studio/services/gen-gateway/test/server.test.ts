// HTTP API 검증 — 가짜 서비스, 임시 포트, 접속 정보 파일 없음.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ledger } from '../src/ledger.ts'
import { Gateway, type GatewayEvent } from '../src/gateway.ts'
import { FakeProvider } from '../src/providers/fake.ts'
import { startServer } from '../src/server.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function boot() {
  const ledger = new Ledger(':memory:')
  const fake = new FakeProvider({ id: 'comfy', steps: 2 })
  let emit: (e: GatewayEvent) => void = () => {}
  const gateway = new Gateway({ ledger, providers: [fake], routes: [{ capability: 'image', model: 'm', providers: ['comfy'] }], pollMs: 1, onEvent: (e) => emit(e) })
  const srv = await startServer({ gateway, ledger, secrets: null, providers: [fake], infoFile: null })
  emit = srv.broadcast
  const base = `http://127.0.0.1:${srv.port}`
  const call = (path: string, init: RequestInit = {}) =>
    fetch(base + path, { ...init, headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) } })
  return { srv, base, call, fake, gateway }
}

test('health는 열려 있고, 나머지는 토큰이 필요하다', async () => {
  const { srv, base } = await boot()
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200)
    assert.equal((await fetch(`${base}/jobs`)).status, 401)
    assert.equal((await fetch(`${base}/jobs`, { headers: { Authorization: 'Bearer wrong' } })).status, 401)
  } finally {
    await srv.close()
  }
})

test('다른 웹 페이지 출처는 토큰이 있어도 막고, 앱 출처만 CORS로 허용한다', async () => {
  const { srv, base } = await boot()
  try {
    const evil = await fetch(`${base}/jobs`, { headers: { Authorization: `Bearer ${srv.token}`, Origin: 'https://evil.example' } })
    assert.equal(evil.status, 403)
    const local = await fetch(`${base}/jobs`, { headers: { Authorization: `Bearer ${srv.token}`, Origin: 'http://localhost:8080' } })
    assert.equal(local.status, 403)
    const app = await fetch(`${base}/jobs`, { headers: { Authorization: `Bearer ${srv.token}`, Origin: 'http://tauri.localhost' } })
    assert.equal(app.status, 200)
    assert.equal(app.headers.get('access-control-allow-origin'), 'http://tauri.localhost')
    const pre = await fetch(`${base}/jobs`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:5273', 'Access-Control-Request-Method': 'POST' } })
    assert.equal(pre.status, 204)
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/)
    // 앱 출처여도 토큰은 필요하다
    assert.equal((await fetch(`${base}/jobs`, { headers: { Origin: 'http://tauri.localhost' } })).status, 401)
  } finally {
    await srv.close()
  }
})

test('견적 → 승인 → 완료 대기 → 결과 URL', async () => {
  const { srv, call } = await boot()
  try {
    const q = await call('/jobs', { method: 'POST', body: JSON.stringify({ capability: 'image', model: 'm', prompt: 'x' }) })
    assert.equal(q.status, 201)
    const job = (await q.json()) as { id: string; state: string }
    assert.equal(job.state, 'awaiting_approval')
    assert.equal((await call(`/jobs/${job.id}/approve`, { method: 'POST' })).status, 200)
    const w = (await (await call(`/jobs/${job.id}/wait?timeout=3000`)).json()) as { job: { state: string }; outputs: { id: string }[] }
    assert.equal(w.job.state, 'succeeded')
    assert.equal(w.outputs.length, 1)
    const u = (await (await call(`/outputs/${w.outputs[0].id}/url`)).json()) as { url: string }
    assert.match(u.url, /^https:\/\/fake\.local\//)
  } finally {
    await srv.close()
  }
})

test('모델 카탈로그는 라우팅과 서비스 준비 상태를 함께 준다', async () => {
  const ledger = new Ledger(':memory:')
  const fake = new FakeProvider({ id: 'comfy' })
  const gateway = new Gateway({ ledger, providers: [fake], routes: [{ capability: 'image', model: 'm', providers: ['comfy', 'tripo'] }] })
  const srv = await startServer({ gateway, ledger, secrets: null, providers: [fake], infoFile: null, models: [{ id: 'm', label: 'M', capability: 'image', input: 'none', prompt: 'required', options: [] }] })
  try {
    const r = (await (await fetch(`http://127.0.0.1:${srv.port}/models`, { headers: { Authorization: `Bearer ${srv.token}` } })).json()) as { id: string; available: boolean; providers: { id: string; configured: boolean }[] }[]
    assert.equal(r[0].id, 'm')
    assert.equal(r[0].available, true)
    assert.deepEqual(r[0].providers, [{ id: 'comfy', configured: true }, { id: 'tripo', configured: false }])
  } finally {
    await srv.close()
  }
})

test('결과 목록과 결과 파일: 토큰은 ?t=로도 받고(결과 파일만), 로컬 보관본은 직접 흘려보낸다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gw-content-'))
  const ledger = new Ledger(':memory:')
  const fake = new FakeProvider({ id: 'comfy' })
  const gateway = new Gateway({ ledger, providers: [fake], routes: [{ capability: 'image', model: 'm', providers: ['comfy'] }], pollMs: 1 })
  const srv = await startServer({ gateway, ledger, secrets: null, providers: [fake], infoFile: null, outputsDir: dir })
  const base = `http://127.0.0.1:${srv.port}`
  try {
    const job = await gateway.quote({ capability: 'image', model: 'm', prompt: 'p' })
    await gateway.approve(job.id)
    await gateway.waitFor(job.id, 2000)
    const list = (await (await fetch(`${base}/outputs`, { headers: { Authorization: `Bearer ${srv.token}` } })).json()) as { output: { id: string }; job: { prompt: string } }[]
    assert.equal(list.length, 1)
    assert.equal(list[0].job.prompt, 'p')
    const id = list[0].output.id
    // 원격 결과 → 지금 열 수 있는 URL로 302
    const r = await fetch(`${base}/outputs/${id}/content?t=${srv.token}`, { redirect: 'manual' })
    assert.equal(r.status, 302)
    assert.match(r.headers.get('location') ?? '', /^https:\/\/fake\.local\//)
    // 토큰 없이는 안 되고, ?t=는 결과 파일 외에는 통하지 않는다
    assert.equal((await fetch(`${base}/outputs/${id}/content`, { redirect: 'manual' })).status, 401)
    assert.equal((await fetch(`${base}/jobs?t=${srv.token}`)).status, 401)
    // 로컬 보관본은 파일 내용을 그대로
    mkdirSync(join(dir, job.id), { recursive: true })
    writeFileSync(join(dir, job.id, 'x.png'), 'PNGDATA')
    ledger.setStorageKey(id, `local:${job.id}/x.png`)
    const local = await fetch(`${base}/outputs/${id}/content?t=${srv.token}`)
    assert.equal(local.status, 200)
    assert.equal(local.headers.get('content-type'), 'image/png')
    assert.equal(await local.text(), 'PNGDATA')
    // 보관 폴더 밖을 가리키는 저장 키는 거부
    ledger.setStorageKey(id, 'local:../escape.png')
    assert.equal((await fetch(`${base}/outputs/${id}/content?t=${srv.token}`)).status, 404)
  } finally {
    await srv.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('잘못된 요청과 상태 오류는 의미 있는 코드로 답한다', async () => {
  const { srv, call } = await boot()
  try {
    assert.equal((await call('/jobs', { method: 'POST', body: JSON.stringify({ capability: 'nope', model: 'm' }) })).status, 400)
    assert.equal((await call('/jobs', { method: 'POST', body: '{bad' })).status, 400)
    assert.equal((await call('/jobs/none/approve', { method: 'POST' })).status, 404)
    const job = (await (await call('/jobs', { method: 'POST', body: JSON.stringify({ capability: 'image', model: 'm' }) })).json()) as { id: string }
    await call(`/jobs/${job.id}/reject`, { method: 'POST' })
    assert.equal((await call(`/jobs/${job.id}/approve`, { method: 'POST' })).status, 409)
  } finally {
    await srv.close()
  }
})

test('이벤트 스트림이 작업 상태 변화를 흘려보낸다', async () => {
  const { srv, call } = await boot()
  try {
    const es = await call('/events')
    const reader = es.body!.getReader()
    const seen: string[] = []
    const reading = (async () => {
      const dec = new TextDecoder()
      let buf = ''
      while (!seen.includes('succeeded')) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value)
        for (const m of buf.matchAll(/data: (.+)\n\n/g)) {
          const e = JSON.parse(m[1]) as { type: string; job?: { state: string } }
          if (e.type === 'job' && e.job && !seen.includes(e.job.state)) seen.push(e.job.state)
        }
      }
    })()
    const job = (await (await call('/jobs', { method: 'POST', body: JSON.stringify({ capability: 'image', model: 'm' }) })).json()) as { id: string }
    await call(`/jobs/${job.id}/approve`, { method: 'POST' })
    await Promise.race([reading, new Promise((r) => setTimeout(r, 3000))])
    await reader.cancel()
    assert.deepEqual(seen, ['awaiting_approval', 'submitting', 'running', 'succeeded'])
  } finally {
    await srv.close()
  }
})
