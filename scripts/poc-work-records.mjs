// Real capture/reducer replay with provider response fixtures; no paid requests.
import { build } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
const root = path.resolve(import.meta.dirname, '..')
const dir = path.join(root, '.dev-home/work-records-verification')
fs.mkdirSync(dir, { recursive: true })
await build({ stdin: { contents: `export * from './src/main/generationRecords'; export * from './src/main/generationUsage'; export * from './src/main/workPaths'; export * from './app/src/store/session';`, resolveDir: root },
  outfile: path.join(dir, 'replay.mjs'), bundle: true, platform: 'node', format: 'esm', alias: { '@shared': path.join(root, 'src/shared') },
  plugins: [{ name: 'fixtures', setup(b) {
    b.onResolve({ filter: /(?:lib\/|\.\/)i18n$/ }, () => ({ path: 'language', namespace: 'test' }));
    b.onResolve({ filter: /^\.\/secrets$/ }, () => ({ path: 'secrets', namespace: 'test' }));
    b.onLoad({ filter: /.*/, namespace: 'test' }, a => ({ contents: a.path === 'secrets' ? 'export const secretValues=()=>({TRIPO_API_KEY:"fixture-key"})' : 'export const t=(ko,en)=>en' }))
  } }] })
const { GenerationCapture, reportedGenerationUsage, initialSessionState, reducer, snapshotForPersist, sanitizeSnapshot, inspectWorkPaths } = await import(pathToFileURL(path.join(dir, 'replay.mjs')))
let state = structuredClone(initialSessionState), events = [], checks = 0
const send = e => { events.push(e); state = reducer(state, { type: 'engine', event: e }) }
const capture = new GenerationCapture(send)
const check = (name, fn) => { fn(); checks++; console.log('ok ' + name) }
send({ type: 'status', runId: 'r1', status: 'analyzing' })
capture.observe({ type: 'session', runId: 'r1', cwd: root })
capture.observe({ type: 'file-change', runId: 'r1', file: { path: 'src/main/generationRecords.ts' } })
check('working directories include files outside the starting directory', () => assert(state.workFolders.includes(path.join(root, 'src/main'))))
capture.start('r1', 'balance', 'tripo_balance', {})
check('balance/history reads do not become generations', () => assert.equal(state.generations.length, 0))
capture.start('r1', 't1', 'tripo_make', { input: 'A small red robot', model: 'v3.1', api_key: 'secret-1', env: { TRIPO_API_KEY: 'secret-2' } }, 'tripo')
capture.finish('r1', 't1', { content: [{ type: 'text', text: JSON.stringify({ task_id: 'job-1', status: 'success', model_file: path.join(dir, 'robot.glb') }) }] }, false)
check('Tripo input, model and artifact survive full MCP envelope parsing', () => {
  const r = state.generations[0]; assert.equal(r.prompt, 'A small red robot'); assert.equal(r.model, 'v3.1'); assert.equal(r.outputs[0], path.join(dir, 'robot.glb')); assert.equal(r.status, 'completed')
  assert(!r.parameters.includes('secret-')); assert.equal(r.usage.credits, null)
})
capture.start('r1', 'p1', 'tripo_task_get', { task_id: 'job-1' }, 'tripo')
capture.finish('r1', 'p1', { content: [{ type: 'text', text: '{"task_id":"job-1","status":"success","credits_consumed":30}' }] }, false)
capture.start('r1', 'p2', 'tripo_task_wait', { task_id: 'job-1' }, 'tripo')
capture.finish('r1', 'p2', { task_id: 'job-1', status: 'success', credits_consumed: 30 }, false)
check('polling updates one record without double charging', () => { assert.equal(state.generations.length, 1); assert.equal(state.generations[0].usage.credits, 30) })
capture.start('r1', 'c1', 'mcp__comfy_cloud__partner_generate', { prompt: 'A bright forest', model: 'gpt-image-2' })
capture.finish('r1', 'c1', { structuredContent: { job_id: 'comfy-1', status: 'queued', estimated: { credits_used: 50 } } }, false)
check('queued job and estimates are distinguished from completed billed work', () => { assert.equal(state.generations[1].status, 'submitted'); assert.equal(state.generations[1].usage.credits, null) })
capture.start('r1', 'cp1', 'get_output', { job_id: 'comfy-1' }, 'comfy-cloud')
capture.finish('r1', 'cp1', { status: 'completed', job_id: 'comfy-1', output_url: 'https://example.org/forest.png', usage: { credits: 0, total_tokens: 0 } }, false)
check('zero reported usage remains a real zero', () => { assert.equal(state.generations[1].usage.credits, 0); assert.equal(state.generations[1].usage.tokens, 0); assert.equal(state.generations[1].status, 'completed') })
capture.start('r1', 'cp2', 'get_output', { job_id: 'comfy-1' }, 'comfy-cloud')
capture.finish('r1', 'cp2', { isError: true }, true)
check('failed status lookup does not turn a completed generation into failure', () => assert.equal(state.generations[1].status, 'completed'))
capture.start('r1', 'sub-tool', 'partner_generate', { prompt: 'Subagent request' }, 'comfy-cloud')
capture.finish('r1', 'sub-tool', { isError: true }, false)
check('provider-level errors are preserved', () => assert.equal(state.generations[2].status, 'error'))
capture.start('r1', 'pending', 'tripo_make', { input: 'Interrupted request' })
capture.observe({ type: 'status', runId: 'r1', status: 'done' })
check('interrupted requests are no longer shown as actively calling', () => assert.equal(state.generations[3].status, 'unknown'))
const restored = sanitizeSnapshot(JSON.parse(JSON.stringify(snapshotForPersist(state))))
check('conversation persistence retains prompt, folders, usage and outputs', () => {
  assert.deepEqual(restored.generations, state.generations); assert.deepEqual(restored.workFolders, state.workFolders)
  assert.equal(sanitizeSnapshot({}).generations.length, 0)
  assert.equal(sanitizeSnapshot({ generations: [null, {}, { id: 'old', service: 'Tripo', usage: false }] }).generations[0].usage.credits, null)
})
state = { ...initialSessionState, curRunId: 'r2' }
send(events.find(e => e.type === 'generation'))
check('late events cannot leak into a different conversation', () => assert.equal(state.generations.length, 0))
const folder = path.join(dir, '한글 폴더 with spaces')
fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'sample.txt'), 'fixture')
const found = await inspectWorkPaths(root, [folder, path.join(folder, 'sample.txt') + ':12', 'https://example.org', 'javascript:alert(1)', path.join(dir, 'missing'), null])
check('folder/file paths with spaces, Korean and line suffixes resolve safely', () => {
  assert.equal(found.length, 2); assert.equal(found[0].kind, 'directory'); assert.equal(found[1].kind, 'file'); assert.equal(found[1].folder, folder)
})
fs.writeFileSync(path.join(dir, 'records.json'), JSON.stringify(restored.generations, null, 2))
let request, replyId = 'job-1'
globalThis.fetch = async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ code: 0, data: { task_id: replyId, credits_consumed: 0 } }) } }
const missingUsage = { ...restored.generations[0], usage: { ...restored.generations[0].usage, credits: null } }
const reported = await reportedGenerationUsage(missingUsage)
check('missing Tripo charge is fetched read-only and accepts zero', () => { assert.equal(reported.credits, 0); assert(request.url.endsWith('/v3/tasks/job-1')); assert.equal(request.options.redirect, 'error'); assert.equal(request.options.body, undefined) })
replyId = 'different-job'
const mismatched = await reportedGenerationUsage(missingUsage)
check('unrelated task usage cannot attach to this generation', () => assert.equal(mismatched, null))
fs.writeFileSync(path.join(dir, 'offline-results.json'), JSON.stringify({ checks, paidRequests: 0 }, null, 2))
console.log(`${checks} checks passed`)
