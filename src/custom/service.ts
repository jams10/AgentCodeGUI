import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { mcpForm, mcpFormResponse, type McpForm } from '../main/codex/elicitation'
import fs from 'node:fs'
import path from 'node:path'
import { app, shell } from './electronAdapter'
import * as mcp from '../main/mcp'
import * as oauth from '../main/mcpOAuth'
import * as secrets from '../main/secrets'
import { comfyStatus, registerComfy, checkComfyConnection } from '../main/comfy'
import { tripoStatus, registerTripo, checkTripoConnection, refreshTripoRegistration } from '../main/tripo'
import { getServiceCredits } from '../main/serviceCredits'
import { inspectWorkPaths } from '../main/workPaths'
import { GenerationCapture } from '../main/generationRecords'
import { reportedGenerationUsage } from '../main/generationUsage'
import { setUiLang } from '../main/lang'
import type { EngineEvent } from '../shared/protocol'

function write(value: unknown): void { process.stdout.write(JSON.stringify(value) + '\n') }
const sender = { isDestroyed: () => false, send: (channel: string, payload: unknown) => write({ event: channel, payload }) }
const captures = new Map<string, GenerationCapture>()
const forms = new Map<string, McpForm>()

async function dispatch(channel: string, args: any[]): Promise<unknown> {
  const a = args[0]
  try { setUiLang(JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'ui-prefs.json'), 'utf8'))['ui.lang']) } catch { /* default language */ }
  switch (channel) {
    case 'mcp:list': return mcp.listMcpServers(a || '')
    case 'mcp:set-enabled': return mcp.setMcpEnabled(a.name, a.enabled)
    case 'mcp:upsert': return mcp.upsertAppServer(a.name, a.spec, a.prevName)
    case 'mcp:remove': return mcp.removeAppServer(a)
    case 'mcp:import-candidates': return mcp.importCandidates(a || '')
    case 'mcp:import': return mcp.importAppServers(a)
    case 'mcp:prefs-get': return mcp.mcpPrefs()
    case 'mcp:prefs-set': return mcp.setMcpPrefs(a || {})
    case 'mcp:oauth-connect': {
      const spec = mcp.findUrlSpec(a.name, a.cwd || '')
      if (!spec) throw new Error('HTTP/SSE MCP server not found')
      return oauth.connectMcpOAuth(a.name, spec, sender as any)
    }
    case 'mcp:oauth-cancel': return oauth.cancelMcpOAuth()
    case 'mcp:oauth-disconnect': {
      const spec = mcp.findUrlSpec(a.name, a.cwd || '')
      if (spec) oauth.disconnectMcpOAuth(a.name, spec)
      return null
    }
    case 'mcp:oauth-import-global': return oauth.importGlobalMcpOAuth()
    case 'secrets:list': return secrets.listSecrets()
    case 'secrets:set': return secrets.setSecret(a.name, a.value, a)
    case 'secrets:remove': return secrets.removeSecret(a)
    case 'secrets:set-env': return secrets.setSecretEnv(a.name, a.env)
    case 'comfy:status': return comfyStatus()
    case 'comfy:register': return registerComfy(a ?? undefined)
    case 'comfy:check': return checkComfyConnection()
    case 'tripo:status': return tripoStatus()
    case 'tripo:register': return registerTripo(a ?? undefined)
    case 'tripo:check': return checkTripoConnection()
    case 'credits:get': return getServiceCredits(a.service, a.fresh === true, a.codexAccount)
    case 'work:inspect-paths': return inspectWorkPaths(a.cwd || '', a.paths)
    case 'work:open-folder': {
      const [found] = await inspectWorkPaths(a.cwd || '', [a.path])
      if (!found) throw new Error('The folder was moved or deleted')
      await shell.openPath(found.folder)
      return null
    }
    // Internal channels never enter the renderer IPC allowlist.
    case 'custom:mcp-form': {
      const form = mcpForm(a)
      const id = randomUUID()
      forms.set(id, form)
      if (forms.size > 256) forms.delete(forms.keys().next().value!)
      return { id, questions: form.questions }
    }
    case 'custom:mcp-answer': {
      const form = forms.get(a.id)
      if (!form) throw new Error('MCP form expired')
      try { return mcpFormResponse(form, a.answers) } finally { forms.delete(a.id) }
    }
    case 'custom:harvest-oauth': {
      if (a?.path) oauth.harvestMcpOAuth(a.path)
      return null
    }
    case 'custom:spawn': {
      if (process.env.CCG_NO_NET !== '1') oauth.importGlobalMcpOAuthOnce()
      refreshTripoRegistration()
      if (a.configDir && a.engine === 'claude') oauth.materializeMcpOAuth(path.join(a.configDir, '.credentials.json'))
      return { env: secrets.secretEnv(), servers: mcp.resolvedAppServers(), settings: mcp.mcpRunSettings(), config: mcp.codexAppMcpConfig() }
    }
    case 'custom:capture': {
      let capture = captures.get(a.chat)
      if (!capture) {
        capture = new GenerationCapture(event => write({ event: 'custom:generation', payload: { chat: a.chat, event } }), reportedGenerationUsage)
        captures.set(a.chat, capture)
      }
      const event = a.event as EngineEvent
      if (a.event.type === 'custom-tool-start') { capture.start(a.event.runId, a.event.id, a.event.name, a.event.input); return null }
      if (a.event.type === 'custom-tool-end') { capture.finish(a.event.runId, a.event.id, a.event.result, a.event.failed); return null }
      capture.observe(event)
      return null
    }
    default: throw new Error('Unknown custom service channel')
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  let message: { id?: string; channel: string; args: any[] }
  try { message = JSON.parse(line) } catch { return }
  void dispatch(message.channel, message.args || []).then(value => {
    if (message.id) write({ id: message.id, value: value ?? null })
  }).catch(error => {
    if (message.id) write({ id: message.id, error: error instanceof Error ? error.message : 'Custom service failed' })
  })
})
input.once('close', () => { oauth.cancelMcpOAuth(); process.exit(0) })
