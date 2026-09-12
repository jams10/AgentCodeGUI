import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { CreditService, ServiceCreditInfo } from '@shared/protocol'
import { expandSecretRefs, secretValues } from './secrets'
import { COMFY_KEY, comfyKeyHeader } from './comfyConfig'
import { appServers } from './mcp'
import { comfyAppAccessToken } from './mcpOAuth'
import { codexListAccounts, codexAccountRunDir } from './codex/auth'
import { comfyCredentialSignature, readNativeComfyCredential, refreshNativeComfyCredential } from './comfyCredentials'
import { comfyCreditValues, tripoCreditValues } from './creditValues'
import { ComfyRefreshError } from './comfyRefresh'
import { t } from './lang'

const TTL = 60_000
const MIN_REFRESH = 5_000
const RETRY_DELAYS = [500, 1500]
const RETRY_STATUSES = new Set([500, 502, 503, 504])
type Context = { service: CreditService; signature: string; key?: string; home?: string; token?: string; expiresAt?: number | null }
type Cache = { at: number; value: ServiceCreditInfo }
const cache = new Map<string, Cache>()
const inflight = new Map<string, Promise<ServiceCreditInfo>>()
const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const empty = (service: CreditService): ServiceCreditInfo => ({ service, state: 'unavailable', balance: null, frozen: null, account: null, plan: null, checkedAt: null, stale: false, note: null })
class CreditError extends Error {
  constructor(readonly state: ServiceCreditInfo['state'], message: string) { super(message) }
}
const authError = (): CreditError => new CreditError('auth-required', t('ComfyCloud에 다시 로그인해 주세요.', 'Sign in to ComfyCloud again.'))

async function context(service: CreditService, account?: string): Promise<Context> {
  const secrets = secretValues()
  if (service === 'tripo') {
    const key = secrets.TRIPO_API_KEY
    return { service, key, signature: hash(key ?? '') }
  }
  const server = appServers()['comfy-cloud']
  // A direct API key is supported as well as the existing OAuth connection.
  const rawKey = comfyKeyHeader(server)
  if (rawKey !== undefined) {
    const key = expandSecretRefs(rawKey, secrets).trim()
    if (!key || key.includes('${')) throw new CreditError('unconfigured', t('설정 → ComfyCloud에서 API 키를 저장해 주세요.', 'Save an API key in Settings → ComfyCloud.'))
    return { service, key, signature: hash(key) }
  }
  // A key sitting in the vault is not proof that the conversation uses it.
  if (secrets[COMFY_KEY]) throw new CreditError('unconfigured', t('설정 → ComfyCloud에서 저장한 키로 연결해 주세요.', 'Connect the saved key in Settings → ComfyCloud.'))
  const accounts = await codexListAccounts()
  const selected = account ? accounts.find(a => a.email === account) : accounts.find(a => a.isDefault) ?? accounts[0]
  if (selected) {
    const home = codexAccountRunDir(selected.email)
    if (comfyCredentialSignature(home) !== '-|-') return { service, home, signature: hash(home + comfyCredentialSignature(home)) }
  }
  const login = comfyAppAccessToken()
  return { service, token: login?.accessToken, expiresAt: login?.expiresAt, signature: hash(login?.accessToken ?? '') }
}

async function getJson(url: string, headers: Record<string, string>, service: CreditService, timeoutMs = 15_000): Promise<Record<string, unknown>> {
  const provider = service === 'comfy-cloud' ? 'ComfyCloud' : 'Tripo'
  // Retry only these read-only account requests, within one overall deadline.
  // Never retry authentication failures or expose an upstream response body.
  const deadline = Date.now() + timeoutMs
  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined
    try {
      response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
    } catch { /* transport errors use the same bounded retry as transient 5xx */ }
    if (response?.ok) {
      const body = await response.json()
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Unexpected balance response')
      return body as Record<string, unknown>
    }
    if (response) await response.body?.cancel().catch(() => {})
    if (response?.status === 401 || response?.status === 403) throw new CreditError('auth-required', t('저장된 인증을 확인해 주세요.', 'Check the saved authentication.'))
    const retryable = !response || RETRY_STATUSES.has(response.status)
    const pause = RETRY_DELAYS[attempt]
    if (retryable && pause != null && Date.now() + pause < deadline) {
      await delay(pause)
      continue
    }
    throw new CreditError('unavailable', response
      ? retryable
        ? t(`${provider} 잔액 서버가 일시적으로 응답하지 못했어요 (HTTP ${response.status}). 잠시 후 새로고침해 주세요.`, `${provider}'s balance server is temporarily unavailable (HTTP ${response.status}). Refresh again shortly.`)
        : t(`${provider} 잔액 조회 실패 (HTTP ${response.status})`, `${provider} balance request failed (HTTP ${response.status})`)
      : t(`${provider} 잔액 서버에 연결하지 못했어요. 잠시 후 새로고침해 주세요.`, `Could not reach ${provider}'s balance server. Refresh again shortly.`))
  }
}

async function loadTripo(ctx: Context): Promise<ServiceCreditInfo> {
  if (!ctx.key) throw new CreditError('unconfigured', t('설정 → Tripo에서 API 키를 연결해 주세요.', 'Connect an API key in Settings → Tripo.'))
  const body = await getJson('https://openapi.tripo3d.ai/v3/account/balance', { Authorization: `Bearer ${ctx.key}` }, ctx.service)
  const values = tripoCreditValues(body)
  if (!values) throw new Error('Unknown Tripo balance')
  return { ...empty(ctx.service), ...values, state: 'ready', account: 'Tripo API', checkedAt: Date.now() }
}

async function loadComfy(ctx: Context): Promise<ServiceCreditInfo> {
  let token = ctx.token
  if (ctx.home) {
    let login = await readNativeComfyCredential(ctx.home)
    if (login && login.expiresAt != null && login.expiresAt < Date.now() + 30_000) {
      try { await refreshNativeComfyCredential(ctx.home) } catch (error) {
        if (error instanceof ComfyRefreshError && error.kind === 'auth-required') throw authError()
        throw new CreditError('unavailable', t('ComfyCloud 자동 연결이 지연됐어요. 잠시 후 새로고침해 주세요.', 'ComfyCloud reconnection was delayed. Refresh again shortly.'))
      }
      login = await readNativeComfyCredential(ctx.home)
    }
    token = login?.accessToken
  } else if (ctx.expiresAt != null && ctx.expiresAt < Date.now()) {
    throw authError()
  }
  if (!ctx.key && !token) throw new CreditError('unconfigured', t('ComfyCloud 로그인을 연결해 주세요.', 'Connect your ComfyCloud sign-in.'))
  const headers: Record<string, string> = ctx.key ? { 'X-API-Key': ctx.key } : { Authorization: `Bearer ${token}` }
  const metadata = Promise.allSettled(['billing/status', 'workspaces/current'].map(endpoint => getJson('https://cloud.comfy.org/api/' + endpoint, headers, ctx.service, 2500)))
  const balanceBody = await getJson('https://cloud.comfy.org/api/billing/balance', headers, ctx.service)
  // A slow workspace name must not hold a successfully loaded balance for 15 s.
  const unavailable: PromiseSettledResult<Record<string, unknown>> = { status: 'fulfilled', value: {} }
  let timer: ReturnType<typeof setTimeout> | undefined
  const results = await Promise.race([metadata, new Promise<PromiseSettledResult<Record<string, unknown>>[]>(resolve => {
    timer = setTimeout(() => resolve([unavailable, unavailable]), 250)
  })]).finally(() => clearTimeout(timer))
  let [statusResult, workspaceResult] = results
  if (comfyCreditValues(balanceBody, statusResult.status === 'fulfilled' ? statusResult.value : {}) == null) {
    // A zero migration balance needs subscription status to distinguish unknown.
    ;[statusResult, workspaceResult] = await metadata
  }
  const status = statusResult.status === 'fulfilled' ? statusResult.value : {}
  const workspace = workspaceResult.status === 'fulfilled' ? workspaceResult.value : {}
  const balance = comfyCreditValues(balanceBody, status)
  if (balance == null) throw new CreditError('unavailable', t('서비스에서 잔액을 확인하지 못했어요.', 'The service could not confirm the balance.'))
  return { ...empty(ctx.service), state: 'ready', balance,
    account: typeof workspace.name === 'string' ? workspace.name : null,
    plan: typeof status.subscription_tier === 'string' ? status.subscription_tier : null,
    checkedAt: Date.now(),
    note: status.billing_rail === 'legacy_stripe' ? t('ComfyCloud의 이전 결제 시스템으로, 잔액이 일부만 반영될 수 있어요.', 'ComfyCloud’s legacy billing system may report a partial balance.') : null
  }
}

export async function getServiceCredits(service: CreditService, fresh = false, codexAccount?: string): Promise<ServiceCreditInfo> {
  if (service !== 'tripo' && service !== 'comfy-cloud') throw new Error('Unknown credit service')
  let ctx: Context
  try { ctx = await context(service, codexAccount) }
  catch (error) { return { ...empty(service), state: error instanceof CreditError ? error.state : 'unavailable',
    note: error instanceof CreditError ? error.message : t('연결 정보를 읽지 못했어요.', 'Could not read the connection settings.') } }
  const cacheKey = service + ':' + ctx.signature
  const previous = cache.get(cacheKey)
  const lifetime = fresh || previous?.value.state === 'unavailable' ? MIN_REFRESH : TTL
  if (previous && Date.now() - previous.at < lifetime) return previous.value
  const running = inflight.get(cacheKey)
  if (running) return running
  const request = (async () => {
    let value: ServiceCreditInfo
    try { value = await (service === 'tripo' ? loadTripo(ctx) : loadComfy(ctx)) }
    catch (error) {
      const state = error instanceof CreditError ? error.state : 'unavailable'
      // Only retain a value for this exact credential/account, and never retain
      // it after revoked authentication or a disconnect.
      const old = state === 'unavailable' && previous?.value.balance != null ? previous.value : empty(service)
      value = { ...old, state, stale: old.balance != null,
        note: error instanceof CreditError ? error.message : t('잔액을 불러오지 못했어요. 다시 새로고침해 주세요.', 'Could not load the balance. Try refreshing again.') }
    }
    cache.set(cacheKey, { at: Date.now(), value })
    if (cache.size > 32) cache.delete(cache.keys().next().value!)
    return value
  })().finally(() => inflight.delete(cacheKey))
  inflight.set(cacheKey, request)
  return request
}
