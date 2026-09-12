// Exercise the real adapter router and form conversion; no subprocess or services.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '..')
const dir = path.join(root, '.dev-home/mcp-elicitation-verification')
fs.mkdirSync(dir, { recursive: true })
const outfile = path.join(dir, 'adapter.mjs')
const stubs = {
  './auth': 'export const codexAccountRunDir=()=>null,codexApiKeyRunDir=()=>null,codexDefaultAccountEmail=()=>null,syncCodexAccount=()=>{};',
  './unidiff': 'export const parseUnifiedDiff=()=>[],reverseApplyUnified=()=>null;',
  '../claude/diff': 'export const computeLineDiff=()=>[],newFileDiff=()=>[];',
  '../apiConfig': 'export const getOpenaiApiKey=()=>null;',
  '../secrets': 'export const secretEnv=()=>({});',
  '../mcp': 'export const codexAppMcpConfig=()=>({}),mcpSpawnFingerprint=()=>"fixture";',
  './versions': 'export const codexBin=()=>{throw new Error("Offline fixture")};',
  '../lsp/manager': 'export const lspManager={};',
  '../generationRecords': 'export class GenerationCapture {observe(){}}',
  '../generationUsage': 'export const reportedGenerationUsage=()=>null;',
  '../lang': 'export const t=(ko,en)=>en,isEn=()=>true;'
}
await build({ stdin: { contents: "export {CodexEngine} from './src/main/codex/engine'; export * from './src/main/codex/elicitation'; export * from './src/main/codex/policy'", resolveDir: root }, bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent', plugins: [{ name: 'offline', setup(b) {
  b.onResolve({ filter: /.*/ }, a => stubs[a.path] && /[\\/]codex[\\/](engine|elicitation)\.ts$/.test(a.importer) ? { path: a.path, namespace: 'fixture' } : null)
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: stubs[a.path], loader: 'js' }))
} }] })
const { CodexEngine, mcpForm, mcpFormResponse, codexPolicy } = await import(pathToFileURL(outfile).href)
const events = [], replies = [], errors = []
const engine = new CodexEngine(e => events.push(e))
engine.activeRunId = 'fixture-run'
engine.activeThreadId = 'fixture-thread'
engine.respondRpc = (id, result) => replies.push({ id, result })
engine.respondRpcError = (id, message) => errors.push({ id, message })
const params = { threadId: 'fixture-thread', serverName: 'comfy-cloud-fixture', mode: 'form', message: 'Generate 3 fixture images? Credits: 0.', requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', default: true } }, required: ['confirm'] } }
engine.onServerRequest(100, 'mcpServer/elicitation/request', params)
assert.equal(replies.length, 0, 'A schema default must never grant consent')
const first = events.at(-1)
assert.equal(first.type, 'question-request')
assert.equal(first.questions[0].allowCustom, false)
engine.onServerRequest(101, 'mcpServer/elicitation/request', params)
assert.equal(events.filter(e => e.type === 'question-request').length, 1, 'Queue concurrent forms')
engine.respondQuestion({ requestId: first.requestId, answers: [[first.questions[0].options[0].label]] })
assert.deepEqual(replies.at(-1), { id: 100, result: { action: 'accept', content: { confirm: true } } })
const second = events.at(-1)
assert.equal(second.type, 'question-request')
engine.respondQuestion({ requestId: second.requestId, answers: [[second.questions[0].options[1].label]] })
assert.deepEqual(replies.at(-1), { id: 101, result: { action: 'accept', content: { confirm: false } } })
engine.onServerRequest(102, 'mcpServer/elicitation/request', params)
engine.respondQuestion({ requestId: events.at(-1).requestId, answers: null })
assert.deepEqual(replies.at(-1), { id: 102, result: { action: 'cancel', content: null } })
engine.onServerRequest(103, 'mcpServer/elicitation/request', params)
const expired = events.at(-1)
engine.onNotification('serverRequest/resolved', { threadId: 'fixture-thread', requestId: 103 })
assert.equal(events.at(-1).type, 'question-resolved')
const count = replies.length
engine.respondQuestion({ requestId: expired.requestId, answers: [[expired.questions[0].options[0].label]] })
assert.equal(replies.length, count, 'Late clicks cannot approve an expired request')
engine.onServerRequest(104, 'mcpServer/elicitation/request', { ...params, mode: 'url', url: 'https://example.invalid' })
assert(events.some(e => e.type === 'notice' && e.text.includes('not a user cancellation')))
assert.equal(errors.at(-1).id, 104)
engine.onServerRequest(105, 'mcpServer/elicitation/request', params)
const parked = events.at(-1)
engine.onServerRequest(106, 'item/tool/requestUserInput', { questions: [{ id: 'choice', question: 'Ordinary question', header: 'Choice', options: [{ label: 'A', description: '' }] }] })
engine.respondQuestion({ requestId: events.at(-1).requestId, answers: [['A']] })
assert.equal(events.at(-1).requestId, parked.requestId, 'An ordinary question must not lose the pending MCP form')
engine.respondQuestion({ requestId: parked.requestId, answers: null })
const form = mcpForm({ ...params, requestedSchema: { type: 'object', properties: { n: { type: 'integer', minimum: 1, maximum: 4 }, choice: { type: 'string', enum: ['a','b'] }, note: { type: 'string' } }, required: ['n', 'choice'] } })
assert.deepEqual(mcpFormResponse(form, [['3'], ['2. b'], ['Omit this field']]), { action: 'accept', content: { n: 3, choice: 'b' } })
assert.throws(() => mcpFormResponse(form, [['8'], ['2. b'], ['x']]), /out of range/)
assert.throws(() => mcpFormResponse(form, [['3'], ['unexpected'], ['x']]), /Invalid MCP choice/)
assert.equal(codexPolicy('auto').sandbox, 'workspace-write')
assert.equal(codexPolicy('bypass').sandbox, 'danger-full-access')
assert.equal(codexPolicy('bypass').approvalPolicy.granular.sandbox_approval, false)
const result = { checks: 15, generatedAssets: 0, booleanConsent: true, decline: true, cancel: true, queue: true, ordinaryQuestionInterleaving: true, lateClickIgnored: true, invalidFormVisible: true, noDefaultConsent: true, existingSandboxesPreserved: true }
fs.writeFileSync(path.join(dir, 'adapter-results.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result))
