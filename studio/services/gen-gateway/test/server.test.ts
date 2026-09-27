// HTTP API 검증 — 가짜 서비스, 임시 포트, 접속 정보 파일 없음.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ledger } from '../src/ledger.ts'
import { Gateway, type GatewayEvent } from '../src/gateway.ts'
import { FakeProvider } from '../src/providers/fake.ts'
import { startServer } from '../src/server.ts'

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

test('브라우저 출처가 붙은 요청은 토큰이 있어도 막는다', async () => {
  const { srv, base } = await boot()
  try {
    const r = await fetch(`${base}/jobs`, { headers: { Authorization: `Bearer ${srv.token}`, Origin: 'https://evil.example' } })
    assert.equal(r.status, 403)
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
