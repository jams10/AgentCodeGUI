// Compatibility shim for tripo-cli 0.3.1: its MCP dispatch silently drops unknown
// requests. Codex's full inventory asks for resources/templates and otherwise hangs.
// All generation/tool requests are still handled by the unmodified official CLI.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const cli = process.argv[2]
if (!cli) process.exit(2)
const child = spawn(process.execPath, [cli, 'mcp'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
// Forward whole protocol frames so our inventory replies cannot be interleaved
// with a vendor response that arrives in multiple stdout chunks.
createInterface({ input: child.stdout }).on('line', line => process.stdout.write(line + '\n'))
// Never forward arbitrary vendor diagnostics (which might contain credentials).
child.stderr.resume()
child.on('error', () => process.exit(1))
child.on('exit', code => process.exit(code ?? 1))
process.on('exit', () => { child.kill() })
process.on('SIGTERM', () => process.exit(0))
process.on('SIGINT', () => process.exit(0))
const lines = createInterface({ input: process.stdin, terminal: false })
const supported = new Set(['initialize', 'ping', 'tools/list', 'tools/call'])
lines.on('line', line => {
  let message: { id?: string | number; method?: string }
  try { message = JSON.parse(line) } catch {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n')
    return
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }) + '\n')
    return
  }
  if (message.id != null && message.method && !supported.has(message.method)) {
    const result = message.method === 'resources/list' ? { resources: [] }
      : message.method === 'resources/templates/list' ? { resourceTemplates: [] }
        : message.method === 'prompts/list' ? { prompts: [] } : null
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...(result ? { result } : { error: { code: -32601, message: 'Method not found' } }) }) + '\n')
  } else if (child.stdin.writable) child.stdin.write(line + '\n')
})
lines.on('close', () => { child.stdin.end(); child.kill() })
