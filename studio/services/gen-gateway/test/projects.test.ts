// 아트 프로젝트 — 폴더 · 설정 · AI 지침 · 요청 분류 · 피할 것 · 보관 위치 (가짜 서비스, 과금 없음)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectStore, applyProject, folderName, normalize } from '../src/projects.ts'
import { Ledger } from '../src/ledger.ts'
import { Gateway } from '../src/gateway.ts'
import { FakeProvider } from '../src/providers/fake.ts'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'gw-proj-'))
}

test('프로젝트 만들기: 폴더 구조 · project.json · CLAUDE.md/AGENTS.md(관리 구역), 이름 중복 거절', () => {
  const root = tmp()
  try {
    const st = new ProjectStore(root)
    const p = st.create('Test', { avoid: '글자 없음' })
    assert.equal(p.id, 'Test')
    for (const sub of ['characters', 'assets', 'exports']) assert.ok(existsSync(join(root, 'Test', sub)))
    const claude = readFileSync(join(root, 'Test', 'CLAUDE.md'), 'utf8')
    assert.match(claude, /피할 것.*글자 없음/)
    assert.match(claude, /tools\/character-sheet\.json/)
    assert.ok(existsSync(join(root, 'Test', 'AGENTS.md')))
    assert.throws(() => st.create('Test'), /이미 있어요/)
    assert.deepEqual(st.list().map((x) => x.id), ['Test'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('설정을 바꾸면 관리 구역만 다시 쓰고, 사용자가 적은 내용은 남긴다', () => {
  const root = tmp()
  try {
    const st = new ProjectStore(root)
    st.create('P')
    const f = join(root, 'P', 'CLAUDE.md')
    writeFileSync(f, '내 메모: 주인공은 왼손잡이\n\n' + readFileSync(f, 'utf8') + '\n끝 메모')
    st.update('P', { settings: { avoid: '문신 없음' } })
    const t = readFileSync(f, 'utf8')
    assert.match(t, /^내 메모: 주인공은 왼손잡이/)
    assert.match(t, /끝 메모/)
    assert.match(t, /문신 없음/)
    assert.equal(t.match(/agentstudio:begin/g)?.length, 1) // 관리 구역은 하나만
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('설정 정리: 프로젝트 설정은 피할 것만 — 예전 테마 · 캐릭터 시트 값 같은 모르는 값은 버린다', () => {
  const s = normalize({ theme: 'fmv90', themes: {}, quality: 'high', avoid: '로고' } as never)
  assert.deepEqual(s, { avoid: '로고' })
})

test('예전 project.json의 캐릭터 시트 값은 도구 설정(tools/character-sheet.json)으로 옮긴다 · 도구 id 검사', () => {
  const root = tmp()
  try {
    const st = new ProjectStore(root)
    st.create('Old')
    const f = join(root, 'Old', 'project.json')
    const j = JSON.parse(readFileSync(f, 'utf8'))
    j.settings = { avoid: '글자', rules: '규칙 A', background: '회색', analysisModel: 'gpt-x' }
    writeFileSync(f, JSON.stringify(j))
    assert.deepEqual(st.get('Old')?.settings, { avoid: '글자' })
    assert.deepEqual(st.toolSettings('Old', 'character-sheet'), { rules: '규칙 A', background: '회색', analysisModel: 'gpt-x' })
    assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')).settings, { avoid: '글자' }) // 새 형식으로 다시 썼다
    // 이미 도구 설정이 있으면 덮어쓰지 않는다
    st.setToolSettings('Old', 'character-sheet', { rules: '새 규칙' })
    writeFileSync(f, JSON.stringify({ ...j, settings: { rules: '옛 규칙' } }))
    st.get('Old')
    assert.deepEqual(st.toolSettings('Old', 'character-sheet'), { rules: '새 규칙' })
    assert.throws(() => st.toolSettings('Old', '../x'), /도구 id/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('폴더 이름 정리와 경로로 프로젝트 찾기(밖 경로는 null)', () => {
  const root = tmp()
  try {
    assert.equal(folderName('  보스:용사/ 2 '), '보스_용사_ 2')
    assert.throws(() => folderName('CON'))
    const st = new ProjectStore(root)
    st.create('Test')
    assert.equal(st.projectOfPath(join(root, 'Test')), 'Test')
    assert.equal(st.projectOfPath(join(root, 'Test', 'characters', 'x')), 'Test')
    assert.equal(st.projectOfPath(root), null)
    assert.equal(st.projectOfPath(join(root, 'Nope')), null)
    assert.equal(st.projectOfPath('C:\\Users'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('피할 것: 네거티브를 받는 모델은 negative_prompt로, 아니면 프롬프트 끝에 · 원래 프롬프트는 origin에 · 3D는 분류만', () => {
  const p = { id: 'P', name: 'P', createdAt: 0, updatedAt: 0, settings: normalize({ avoid: '글자 없음' }) }
  const img = applyProject({ capability: 'image', model: 'm', prompt: '서린 초상화' }, p, false)
  assert.equal(img.prompt, '서린 초상화\n\n[피할 것] 글자 없음')
  assert.equal(img.origin?.userPrompt, '서린 초상화')
  assert.equal(img.origin?.project, 'P')
  assert.equal(applyProject(img, p, false).prompt, img.prompt) // 두 번 붙이지 않는다
  const vid = applyProject({ capability: 'video', model: 'v', prompt: 'breathing' }, p, true)
  assert.equal(vid.prompt, 'breathing')
  assert.equal(vid.params?.negative_prompt, '글자 없음')
  const m3d = applyProject({ capability: 'model3d', model: 't', prompt: 'frog' }, p, false)
  assert.equal(m3d.prompt, 'frog')
  assert.equal(m3d.origin?.project, 'P')
  // 피할 것이 없으면 프롬프트는 그대로
  const none = { ...p, settings: normalize({}) }
  assert.equal(applyProject({ capability: 'image', model: 'm', prompt: 'x' }, none, false).prompt, 'x')
})

test('게이트웨이: 채팅의 작업 폴더로 프로젝트를 찾아 분류하고, 결과는 프로젝트 assets에 보관한다', async () => {
  const root = tmp()
  try {
    const st = new ProjectStore(root)
    st.create('Test', { avoid: '로고 없음' })
    const saved: { project?: string | null }[] = []
    const archiver = { wants: () => true, archive: async (o: { id: string }, _u: string, ctx?: { project?: string | null }) => (saved.push(ctx ?? {}), `proj:${ctx?.project}/${o.id}.png`) }
    const ledger = new Ledger(':memory:')
    const gw = new Gateway({ ledger, providers: [new FakeProvider({ id: 'comfy' })], routes: [{ capability: 'image', model: 'm', providers: ['comfy'] }], pollMs: 1, archiver, projects: st })
    const job = await gw.quote({ capability: 'image', model: 'm', prompt: '기사', origin: { source: 'agent', cwd: join(root, 'Test') } })
    assert.equal(job.project, 'Test')
    assert.equal(job.prompt, '기사\n\n[피할 것] 로고 없음')
    await gw.approve(job.id)
    await gw.waitFor(job.id, 2000)
    assert.deepEqual(saved, [{ project: 'Test' }])
    assert.equal(ledger.recentOutputs(10, 'Test').length, 1)
    assert.equal(ledger.recentOutputs(10, '').length, 0)
    await assert.rejects(gw.quote({ capability: 'image', model: 'm', prompt: 'x', project: 'Nope' }), /프로젝트를 찾지 못했어요/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
