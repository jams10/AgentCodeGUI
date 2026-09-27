// 사진 분석 — 칸 정의 · 응답 정리 · Codex 찾기 · /analyze · 참고 사진 올리기 (가짜 엔진, 계정 사용 없음)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeFields, analyzeSchema, findCodex, findCodexHome, pickFields, type AnalyzeEngine } from '../src/analyze.ts'
import { Ledger } from '../src/ledger.ts'
import { Gateway } from '../src/gateway.ts'
import { ProjectStore } from '../src/projects.ts'
import { FakeProvider } from '../src/providers/fake.ts'
import { startServer } from '../src/server.ts'

test('칸 정의: 스키마는 모든 칸을 요구하고, 응답에서는 알고 있는 빈칸 아닌 문자열만 고른다', () => {
  const s = analyzeSchema('face') as { required: string[]; additionalProperties: boolean }
  assert.deepEqual(s.required, analyzeFields('face'))
  assert.equal(s.additionalProperties, false)
  assert.deepEqual(pickFields('costume', { costume: ' 청바지 ', shoes: '', extra: 'x', heldItem: 3 }), { costume: '청바지' })
})

test('Codex 찾기: 앱 설치본 중 가장 새 버전 · auth.json이 있는 계정 폴더', () => {
  const home = mkdtempSync(join(tmpdir(), 'gw-codex-'))
  try {
    const exe = process.platform === 'win32' ? 'codex.exe' : 'codex'
    for (const v of ['0.9.0', '0.157.1']) {
      const d = join(home, 'codex-engines', v, 'node_modules', '@openai', 'codex-x', 'vendor', 'triple', 'bin')
      mkdirSync(d, { recursive: true })
      writeFileSync(join(d, exe), '')
    }
    assert.match(findCodex(home) ?? '', /0\.157\.1/)
    const acc = join(home, 'codex', 'accounts', 'me')
    mkdirSync(acc, { recursive: true })
    writeFileSync(join(acc, 'auth.json'), '{}')
    assert.equal(findCodexHome(home), acc)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('/analyze: 요청한 엔진 · 모델로 분석하고 칸 값만 돌려준다 · 올린 사진은 references에 저장된다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gw-an-'))
  const seen: { images: string[]; model?: string }[] = []
  const engine: AnalyzeEngine = {
    id: 'codex',
    name: '가짜',
    unavailable: () => null,
    run: async ({ images, model }) => (seen.push({ images, model }), { faceShape: '둥근 얼굴', hair: '', bogus: 'x' })
  }
  const projects = new ProjectStore(root)
  projects.create('P')
  const ledger = new Ledger(':memory:')
  const gateway = new Gateway({ ledger, providers: [new FakeProvider({ id: 'comfy' })], routes: [], projects })
  const srv = await startServer({ gateway, ledger, secrets: null, providers: [], infoFile: null, engines: [engine] })
  const call = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${srv.port}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${srv.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  try {
    const png = 'data:image/png;base64,' + Buffer.from('fake').toString('base64')
    const up = (await (await call('/projects/P/uploads', { dataUrl: png, name: '내 사진.png' })).json()) as { path: string }
    assert.match(up.path, /[\\/]P[\\/]references[\\/].+\.png$/)
    assert.equal(readFileSync(up.path, 'utf8'), 'fake')
    assert.equal((await call('/projects/P/uploads', { dataUrl: 'data:text/html;base64,AA==' })).status, 400)

    const r = (await (await call('/analyze', { kind: 'face', engine: 'codex', model: 'gpt-x', images: [{ path: up.path }] })).json()) as { values: Record<string, string> }
    assert.deepEqual(r.values, { faceShape: '둥근 얼굴' })
    assert.deepEqual(seen[0], { images: [up.path], model: 'gpt-x' })
    assert.equal((await call('/analyze', { kind: 'face', images: [{ path: join(root, 'none.png') }] })).status, 400)
    assert.equal((await call('/analyze', { kind: 'nope', images: [{ path: up.path }] })).status, 400)
    assert.equal((await call('/analyze', { kind: 'face', engine: 'grok', images: [{ path: up.path }] })).status, 400)
    // 도구 설정 저장 · 읽기
    assert.deepEqual(await (await call('/projects/P/tools/character-sheet/settings')).json(), {})
    await call('/projects/P/tools/character-sheet/settings', { rules: 'R' })
    assert.deepEqual(await (await call('/projects/P/tools/character-sheet/settings')).json(), { rules: 'R' })
    const engines = (await (await call('/analyze/engines')).json()) as { id: string }[]
    assert.deepEqual(engines.map((e) => e.id), ['codex'])
  } finally {
    await srv.close()
    rmSync(root, { recursive: true, force: true })
  }
})
