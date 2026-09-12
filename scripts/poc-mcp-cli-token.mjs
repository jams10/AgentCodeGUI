/**
 * PoC — 진짜 claude.exe가 앱이 저장한 MCP OAuth 토큰 포맷을 읽어 쓰는지.
 *
 * 격리 CLAUDE_CONFIG_DIR(임시 폴더)에 .claude.json(user 범위 mcpServers)과
 * .credentials.json(mcpOAuth — 앱 보관소와 같은 키/필드)을 넣고, 가짜 MCP 서버(Bearer 토큰
 * 없으면 401, 있으면 initialize/tools/list 응답)를 띄운 뒤 `claude mcp list`를 돌린다.
 * 토큰이 맞으면 "Connected", 못 찾으면 "Needs authentication"/"Failed" — 전자가 나와야 한다.
 * 실 계정·실 토큰은 전혀 건드리지 않는다(리프레시 토큰 회전 사고 방지).
 *
 * 실행: node scripts/poc-mcp-cli-token.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'

const root = path.resolve(import.meta.dirname, '..')
const bin = path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')
const TOKEN = 'AT-poc-' + Math.random().toString(36).slice(2)
const log = []

const srv = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const auth = req.headers.authorization ?? ''
    log.push(`${req.method} ${req.url} auth=${auth ? auth.slice(0, 14) + '…' : '(none)'}`)
    const json = (code, v, hdr = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...hdr })
      res.end(JSON.stringify(v))
    }
    if (req.url !== '/mcp') return json(404, {})
    if (auth !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="http://127.0.0.1:${srv.address().port}/.well-known/oauth-protected-resource/mcp"` })
    let rpc = null
    try {
      rpc = JSON.parse(body)
    } catch {
      /* GET (SSE 열기) 등 */
    }
    if (req.method === 'GET') return json(405, {})
    if (!rpc) return json(400, {})
    if (rpc.method === 'initialize') return json(200, { jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: rpc.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'poc-mcp', version: '1' } } })
    if (rpc.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'ping', description: 'poc', inputSchema: { type: 'object', properties: {} } }] } })
    if (rpc.id === undefined) {
      res.writeHead(202)
      return res.end()
    }
    json(200, { jsonrpc: '2.0', id: rpc.id, result: {} })
  })
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${srv.address().port}/mcp`

const key = `pocsrv|${createHash('sha256').update(JSON.stringify({ type: 'http', url, headers: {} })).digest('hex').slice(0, 16)}`
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poc-cli-token-'))
fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { pocsrv: { type: 'http', url } } }))
fs.writeFileSync(
  path.join(dir, '.credentials.json'),
  JSON.stringify({
    mcpOAuth: {
      [key]: { serverName: 'pocsrv', serverUrl: url, accessToken: TOKEN, refreshToken: 'RT-poc', expiresAt: Date.now() + 3600e3, clientId: 'cid-poc', redirectUri: 'http://localhost:1/callback', scope: 'tools:read', discoveryState: { authorizationServerUrl: `http://127.0.0.1:${srv.address().port}`, oauthMetadataFound: true } }
    }
  })
)

const run = (args) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: 60000, windowsHide: true, cwd: dir, env: { ...process.env, CLAUDE_CONFIG_DIR: dir, ANTHROPIC_API_KEY: '' } }, (err, stdout, stderr) => resolve({ err, stdout, stderr }))
  })

console.log('claude.exe:', bin)
const r1 = await run(['mcp', 'list'])
console.log('--- mcp list (with token) ---\n' + r1.stdout.trim() + (r1.stderr.trim() ? '\n[stderr] ' + r1.stderr.trim() : ''))
const withTok = /connected/i.test(r1.stdout) && !/needs auth|failed/i.test(r1.stdout)
const sawBearer = log.some((l) => l.includes('auth=Bearer'))

// 대조군 — 토큰을 지우면 인증 필요로 떨어져야 한다
log.length = 0
fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ mcpOAuth: {} }))
const r2 = await run(['mcp', 'list'])
console.log('--- mcp list (no token) ---\n' + r2.stdout.trim() + (r2.stderr.trim() ? '\n[stderr] ' + r2.stderr.trim() : ''))
const noTok = /needs auth|failed|not connected|✗|✘/i.test(r2.stdout) || !/✓|connected/i.test(r2.stdout)

console.log('\nserver log (with token):', sawBearer ? 'Bearer 토큰 도착' : '토큰 없이 접속')
console.log(`${withTok && sawBearer ? 'ok  ' : 'FAIL'} 저장 포맷의 토큰으로 CLI가 Connected`)
console.log(`${noTok ? 'ok  ' : 'FAIL'} 토큰 없으면 미연결(대조군)`)
srv.close()
fs.rmSync(dir, { recursive: true, force: true })
process.exit(withTok && sawBearer && noTok ? 0 : 1)
