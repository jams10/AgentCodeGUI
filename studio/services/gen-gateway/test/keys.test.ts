// 설정 화면용 키 API — 메모리 보관함 · 가짜 서비스로 검증(DPAPI · 네트워크 · 과금 없음).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Ledger } from '../src/ledger.ts'
import { Gateway } from '../src/gateway.ts'
import { FakeProvider } from '../src/providers/fake.ts'
import { keyProblem, startServer } from '../src/server.ts'
import type { KeyStore } from '../src/secrets.ts'
import type { ProviderId } from '../src/types.ts'

class MemoryKeys implements KeyStore {
  readonly map = new Map<ProviderId, string>()
  list() {
    return [...this.map].map(([provider, v]) => ({ provider, hint: `••••${v.slice(-4)}`, updatedAt: 1 }))
  }
  async set(p: ProviderId, v: string) {
    this.map.set(p, v)
  }
  remove(p: ProviderId) {
    return this.map.delete(p)
  }
}

async function boot() {
  const keys = new MemoryKeys()
  const tripo = new FakeProvider({ id: 'tripo', balance: 1234 })
  tripo.configured = () => keys.map.has('tripo')
  const ledger = new Ledger(':memory:')
  const gateway = new Gateway({ ledger, providers: [tripo], routes: [] })
  const srv = await startServer({ gateway, ledger, secrets: keys, providers: [tripo], infoFile: null })
  const call = (p: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${srv.port}${p}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { keys, srv, call }
}

test('키 모양 확인: 빈 값 · 공백 · 너무 짧음 · Higgsfield 형식', () => {
  assert.match(keyProblem('comfy', '') ?? '', /입력/)
  assert.match(keyProblem('comfy', 'comfyui-abc def123') ?? '', /공백/)
  assert.match(keyProblem('tripo', 'tsk_1') ?? '', /짧아요/)
  assert.match(keyProblem('higgsfield', 'onlyonepart1234') ?? '', /KEY_ID:KEY_SECRET/)
  assert.equal(keyProblem('higgsfield', 'id-1234:secret-5678'), null)
  assert.equal(keyProblem('comfy', 'dummy-comfy-key-for-tests'), null)
})

test('키 저장 → 목록에는 끝 4자리만, 원문은 어디에도 돌려주지 않는다', async () => {
  const { srv, call, keys } = await boot()
  try {
    const secret = 'dummy-SECRETVALUE-9876'
    const saved = await call('/keys/tripo', { key: `  ${secret}  ` })
    assert.equal(saved.status, 200)
    const savedText = await saved.text()
    assert.ok(!savedText.includes('SECRETVALUE'))
    assert.equal(keys.map.get('tripo'), secret) // 앞뒤 공백은 떼고 저장
    const listText = await (await call('/keys')).text()
    assert.ok(!listText.includes('SECRETVALUE'))
    const list = JSON.parse(listText) as { provider: string; configured: boolean; hint: string | null }[]
    assert.deepEqual(
      list.map((k) => [k.provider, k.configured, k.hint]),
      [
        ['comfy', false, null],
        ['tripo', true, '••••9876'],
        ['higgsfield', false, null]
      ]
    )
  } finally {
    await srv.close()
  }
})

test('잘못된 키 · 모르는 서비스는 거절한다', async () => {
  const { srv, call } = await boot()
  try {
    assert.equal((await call('/keys/higgsfield', { key: 'no-colon-here-1234' })).status, 400)
    assert.equal((await call('/keys/nope', { key: 'whatever-12345' })).status, 404)
  } finally {
    await srv.close()
  }
})

test('연결 확인: 키가 없으면 실패 문구, 있으면 잔액으로 인증 확인', async () => {
  const { srv, call } = await boot()
  try {
    const none = (await (await call('/keys/tripo/test', {})).json()) as { ok: boolean; message: string }
    assert.equal(none.ok, false)
    assert.match(none.message, /키가 없어요/)
    await call('/keys/tripo', { key: 'dummy-tripo-key-1234' })
    const ok = (await (await call('/keys/tripo/test', {})).json()) as { ok: boolean; message: string }
    assert.equal(ok.ok, true)
    assert.match(ok.message, /인증 확인됨 · 잔액 1,234 크레딧/)
  } finally {
    await srv.close()
  }
})

test('키 삭제', async () => {
  const { srv, call, keys } = await boot()
  try {
    await call('/keys/tripo', { key: 'dummy-tripo-key-1234' })
    assert.deepEqual(await (await call('/keys/tripo/delete', {})).json(), { ok: true })
    assert.equal(keys.map.has('tripo'), false)
  } finally {
    await srv.close()
  }
})
