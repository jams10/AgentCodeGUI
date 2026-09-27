#!/usr/bin/env node
// MCP 중계기(stdio) — Claude/Codex가 대화마다 띄우는 얇은 프로세스. 실제 일은 상주 게이트웨이가 한다.
//
// AI에게 "승인" 도구는 없다. generate는 견적(승인 대기 작업)을 만들고, 사용자가 앱에서 승인·거절할 때까지
// 기다린 뒤 결과를 돌려준다. 그래서 AI가 혼자 크레딧을 쓰는 경로가 구조적으로 없다.
import { createInterface } from 'node:readline'
import { runningInfo } from './main.ts'
import type { JobRecord, OutputRecord } from './types.ts'

const WAIT_APPROVAL_MS = 10 * 60 * 1000
const WAIT_RESULT_MS = 25 * 60 * 1000

type Json = Record<string, unknown>

const TOOLS = [
  {
    name: 'generate',
    description:
      '외부 서비스(ComfyCloud · Tripo · Higgsfield)로 이미지·영상·3D를 생성한다. 비용이 드는 작업이라 사용자가 앱에서 승인해야 실행되며, 이 도구는 승인·완료까지 기다렸다가 결과(또는 거절)를 돌려준다. 거절되면 같은 요청을 다시 보내지 말고 사용자에게 무엇을 바꿀지 물어라.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string', enum: ['image', 'video', 'model3d', 'audio'] },
        model: { type: 'string', description: "예: 'soul', 'seedance-2.0-i2v', 'kling-2.5-turbo-i2v', 'tripo-text-to-3d', 'tripo-image-to-3d', 'comfy-workflow', 또는 'hf/<Higgsfield 모델 경로>'" },
        prompt: { type: 'string' },
        inputs: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['image', 'video', 'model'] }, url: { type: 'string' }, path: { type: 'string' } } } },
        params: { type: 'object', description: '모델별 옵션(해상도·길이·종횡비·ComfyCloud workflow JSON 등)' },
        title: { type: 'string', description: '라이브러리에 보일 짧은 이름' },
        style: { type: 'string', description: '스타일 이름 또는 id(list_styles로 확인). 결과를 그 스타일로 분류하고, 스타일의 앞/뒤 문구를 프롬프트에 자동으로 붙인다 — prompt에는 그 문구를 반복하지 말 것' }
      },
      required: ['capability', 'model']
    }
  },
  {
    name: 'generation_status',
    description: '생성 작업 하나의 상태와 결과를 조회한다(비용 없음).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'generation_balances',
    description: '연결된 생성 서비스의 남은 잔액/크레딧을 조회한다(비용 없음).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_styles',
    description: '사용자가 만든 아트 스타일(분류 + 프롬프트 프리셋) 목록을 조회한다(비용 없음). 각 스타일의 설명과 프롬프트 앞/뒤 문구, 결과 수를 준다.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'generation_history',
    description: '최근 생성 기록(프롬프트 · 서비스 · 비용 · 상태)을 조회한다(비용 없음).',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } }
  }
]

async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
  const info = await runningInfo()
  if (!info) throw new Error('생성 게이트웨이가 실행 중이 아니에요. AgentStudio 앱을 켜 주세요.')
  const res = await fetch(`http://127.0.0.1:${info.port}${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: init.body ? JSON.stringify(init.body) : undefined
  })
  const body = (await res.json().catch(() => null)) as Json | null
  if (!res.ok) throw new Error(String(body?.message ?? body?.error ?? `HTTP ${res.status}`))
  return body
}

function summary(job: JobRecord, outputs: OutputRecord[] = []): string {
  const cost = job.cost ?? job.estimate
  const lines = [
    `작업 ${job.id} — ${job.state}`,
    `서비스: ${job.provider}${job.fallbackReason ? ` (대체: ${job.fallbackReason})` : ''}`,
    cost ? `비용: ${cost.unit === 'usd' ? '$' + cost.amount.toFixed(2) : Math.round(cost.amount) + ' 크레딧'}${job.cost ? '' : ' (예상)'}` : '비용: 알 수 없음',
    job.error ? `오류: ${job.error}` : '',
    ...outputs.map((o) => `결과(${o.kind}): output_id=${o.id}`)
  ]
  return lines.filter(Boolean).join('\n')
}

async function call(name: string, args: Json): Promise<string> {
  if (name === 'generate') {
    const job = (await api('/jobs', {
      body: {
        capability: args.capability,
        model: args.model,
        prompt: args.prompt,
        inputs: args.inputs,
        params: args.params,
        origin: { source: 'agent', title: typeof args.title === 'string' ? args.title : undefined },
        style: typeof args.style === 'string' ? args.style : undefined
      }
    })) as JobRecord
    // 승인 대기 → (승인되면) 완료까지
    let w = (await api(`/jobs/${job.id}/wait?timeout=${WAIT_APPROVAL_MS}`)) as { job: JobRecord; outputs: OutputRecord[] }
    if (w.job.state === 'awaiting_approval') return `사용자가 아직 승인하지 않았어요.\n${summary(w.job)}\n나중에 generation_status로 확인하세요.`
    if (w.job.state === 'running' || w.job.state === 'submitting') w = (await api(`/jobs/${job.id}/wait?timeout=${WAIT_RESULT_MS}`)) as typeof w
    if (w.job.state === 'rejected') return `사용자가 이 생성을 거절했어요. 같은 요청을 다시 보내지 말고 무엇을 바꿀지 물어보세요.\n${summary(w.job)}`
    return summary(w.job, w.outputs)
  }
  if (name === 'generation_status') {
    const w = (await api(`/jobs/${encodeURIComponent(String(args.id))}`)) as { job: JobRecord; outputs: OutputRecord[] }
    return summary(w.job, w.outputs)
  }
  if (name === 'generation_balances') return JSON.stringify(await api('/balances'), null, 2)
  if (name === 'list_styles') {
    const list = (await api('/styles')) as { name: string; description: string | null; promptPrefix: string | null; promptSuffix: string | null; negative: string | null; count: number }[]
    if (!list.length) return '아직 만든 스타일이 없어요. 사용자가 아트 화면에서 만들 수 있어요.'
    return list
      .map((s) => [`■ ${s.name} (결과 ${s.count}개)`, s.description && `  설명: ${s.description}`, s.promptPrefix && `  앞 문구: ${s.promptPrefix}`, s.promptSuffix && `  뒤 문구: ${s.promptSuffix}`, s.negative && `  네거티브: ${s.negative}`].filter(Boolean).join('\n'))
      .join('\n')
  }
  if (name === 'generation_history') {
    const list = (await api(`/jobs?limit=${Math.min(50, Number(args.limit ?? 10))}`)) as JobRecord[]
    return list.map((j) => `${new Date(j.createdAt).toISOString()} ${j.state} ${j.provider}/${j.model} — ${(j.prompt ?? '').slice(0, 80)}`).join('\n') || '기록이 없어요.'
  }
  throw new Error(`모르는 도구: ${name}`)
}

function reply(id: unknown, result?: unknown, error?: { code: number; message: string }): void {
  process.stdout.write(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }) + '\n')
}

const rl = createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  let msg: Json
  try {
    msg = JSON.parse(line) as Json
  } catch {
    return reply(null, undefined, { code: -32700, message: 'Parse error' })
  }
  const { id, method } = msg
  const params = (msg.params ?? {}) as Json
  if (id === undefined || id === null) return // 알림(notifications/*)은 응답하지 않는다
  if (method === 'initialize')
    return reply(id, { protocolVersion: (params.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agentstudio-gen', version: '0.1.0' } })
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'resources/list') return reply(id, { resources: [] })
  if (method === 'resources/templates/list') return reply(id, { resourceTemplates: [] })
  if (method === 'prompts/list') return reply(id, { prompts: [] })
  if (method === 'tools/call') {
    const name = String(params.name ?? '')
    const args = (params.arguments ?? {}) as Json
    const run = call(name, args)
      .then((text) => reply(id, { content: [{ type: 'text', text }] }))
      .catch((e) => reply(id, { content: [{ type: 'text', text: `오류: ${(e as Error).message}` }], isError: true }))
      .finally(() => pending.delete(run))
    pending.add(run)
    return
  }
  reply(id, undefined, { code: -32601, message: 'Method not found' })
})
// 입력이 닫혀도 진행 중인 도구 호출의 응답은 끝까지 보낸다
const pending = new Set<Promise<void>>()
rl.on('close', () => {
  void Promise.allSettled([...pending]).then(() => process.exit(0))
})
