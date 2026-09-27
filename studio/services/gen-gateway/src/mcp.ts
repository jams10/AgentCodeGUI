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
    description: [
      '외부 서비스(ComfyCloud · Tripo · Higgsfield)로 이미지·영상·3D를 생성한다. 비용이 드는 작업이라 사용자가 앱에서 승인해야 실행되며, 이 도구는 승인·완료까지 기다렸다가 결과(또는 거절)를 돌려준다. 거절되면 같은 요청을 다시 보내지 말고 사용자에게 무엇을 바꿀지 물어라.',
      '모델 고르기: 먼저 list_models로 검증된 모델과 옵션 값을 본다. 사용자가 목록에 없는 Higgsfield 모델(예: Kling O3, Wan, MiniMax, Seedance 2.5, Recraft, Ideogram)을 원하면',
      "model에 'hf/<API 경로>'를 넣는다. 경로와 옵션 이름·값은 기억에 의존하지 말고 공식 문서(https://docs.higgsfield.ai/docs/models)의 해당 모델 페이지에서 확인한다.",
      '제출 전에 무료 견적을 먼저 받으므로, 옵션 값이 틀리면 비용 없이 "옵션 값이 맞지 않아요 — …" 오류가 돌아온다. 그 메시지에 나온 허용 값으로 고쳐 다시 요청하라.',
      '아트 프로젝트 폴더에서 대화 중이면 결과는 그 프로젝트로 분류되고, 프로젝트의 "피할 것"이 게이트웨이에서 자동으로 붙는다. 분위기는 의상 · 소품 · 배경 · 조명 묘사로 직접 쓴다.',
      '대화 방식: 사용자가 만들고 싶은 것을 말하면, 결과를 크게 바꾸는데 정해지지 않은 것(예: 종류 · 비율 · 길이 · 스타일)만 짧게 묻는다.',
      '선택지 질문 도구(AskUserQuestion 등)가 있으면 그걸로, 한 번에 한 질문 · 선택지 2~4개로 묻는다. 요청이 충분히 분명하면 묻지 말고 바로 generate를 부른다.',
      '해상도 · 모델 버전 같은 세부 옵션은 사용자가 승인 카드에서 직접 바꿀 수 있으니 일일이 묻지 말고 알맞은 값을 골라라. 프롬프트는 서비스에 맞게 영어로 자세히 쓴다.',
      '결과에는 사용자가 카드에서 고친 최종 옵션 · 프롬프트가 담긴다 — 다음 요청에 반영하라.',
      "ComfyCloud(model 'comfy-workflow'): API 형식 워크플로 JSON을 params.workflow에 객체로 직접 넣는다 — 사용자 폴더(바탕화면 등)에 파일을 만들지 말 것.",
      '프롬프트는 prompt에도 같이 준다. 게이트웨이가 워크플로의 프롬프트 자리에 그 글을 써 넣고 기록하므로, 사용자가 카드에서 프롬프트를 고칠 수 있다.',
      '결과에는 결과물 주소(url) 또는 이 PC의 파일 경로(path)가 담긴다 — 결과를 확인해야 하면 그걸 연다.'
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string', enum: ['image', 'video', 'model3d', 'audio'] },
        model: { type: 'string', description: "list_models의 id(예: 'soul', 'seedance-2.0-t2v', 'tripo-text-to-3d') 또는 'hf/<Higgsfield 모델 API 경로>'(예: 'hf/kling-video/v2.5-turbo/pro/image-to-video')" },
        provider: { type: 'string', enum: ['higgsfield', 'tripo', 'comfy'], description: '서비스를 고정할 때만. 없으면 라우팅 순서대로(키 없음 · 잔액 부족이면 다음 서비스).' },
        prompt: { type: 'string' },
        inputs: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['image', 'video', 'model'] }, url: { type: 'string' }, path: { type: 'string' } } } },
        params: { type: 'object', description: '모델별 옵션(해상도·길이·종횡비·ComfyCloud workflow JSON 등)' },
        title: { type: 'string', description: '라이브러리에 보일 짧은 이름' }
      },
      required: ['capability', 'model']
    }
  },
  {
    name: 'list_models',
    description: '앱에서 검증한 생성 모델 목록(종류 · 입력 · 옵션 이름과 허용 값 · 처리 서비스와 키 준비 상태)을 조회한다(비용 없음). 여기 없는 Higgsfield 모델은 generate의 hf/<경로>로 부를 수 있다.',
    inputSchema: { type: 'object', properties: { capability: { type: 'string', enum: ['image', 'video', 'model3d'] } } }
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
    `모델: ${job.model}`,
    job.params && Object.keys(job.params).length ? `옵션: ${JSON.stringify(Object.fromEntries(Object.entries(job.params).filter(([k]) => k !== 'workflow' && k !== 'promptSlot')))}` : '',
    job.prompt ? `프롬프트: ${job.prompt}` : '',
    job.error ? `오류: ${job.error}` : '',
    ...outputs.map((o) => `결과(${o.kind}): output_id=${o.id}`)
  ]
  return lines.filter(Boolean).join('\n')
}

/** 결과마다 지금 열 수 있는 곳 — 보관본이 있으면 이 PC의 파일 경로, 없으면 서비스 링크(만료될 수 있음) */
async function whereIs(outputs: OutputRecord[]): Promise<string> {
  const rows = await Promise.all(
    outputs.map(async (o) => {
      try {
        const r = (await api(`/outputs/${o.id}/url`)) as { url?: string; localPath?: string | null }
        return r.localPath ? `  ${o.kind} path: ${r.localPath}` : r.url ? `  ${o.kind} url: ${r.url}` : ''
      } catch {
        return ''
      }
    })
  )
  const text = rows.filter(Boolean).join('\n')
  return text ? `\n열어 보기:\n${text}` : ''
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
        provider: typeof args.provider === 'string' ? args.provider : undefined,
        // 이 중계기는 채팅의 작업 폴더에서 실행된다 — 아트 프로젝트 폴더면 게이트웨이가 그 프로젝트로 분류하고 아트 디렉션을 붙인다
        origin: { source: 'agent', title: typeof args.title === 'string' ? args.title : undefined, cwd: process.cwd() }
      }
    })) as JobRecord
    // 승인 대기 → (승인되면) 완료까지
    let w = (await api(`/jobs/${job.id}/wait?timeout=${WAIT_APPROVAL_MS}`)) as { job: JobRecord; outputs: OutputRecord[] }
    if (w.job.state === 'awaiting_approval') return `사용자가 아직 승인하지 않았어요.\n${summary(w.job)}\n나중에 generation_status로 확인하세요.`
    if (w.job.state === 'running' || w.job.state === 'submitting') w = (await api(`/jobs/${job.id}/wait?timeout=${WAIT_RESULT_MS}`)) as typeof w
    if (w.job.state === 'rejected') return `사용자가 이 생성을 거절했어요. 같은 요청을 다시 보내지 말고 무엇을 바꿀지 물어보세요.\n${summary(w.job)}`
    return summary(w.job, w.outputs) + (await whereIs(w.outputs))
  }
  if (name === 'generation_status') {
    const w = (await api(`/jobs/${encodeURIComponent(String(args.id))}`)) as { job: JobRecord; outputs: OutputRecord[] }
    return summary(w.job, w.outputs) + (await whereIs(w.outputs))
  }
  if (name === 'list_models') {
    type Opt = { key: string; label: string; type: string; values?: unknown[]; default?: unknown; min?: number; max?: number }
    const list = (await api('/models')) as { id: string; label: string; capability: string; input: string; prompt: string; note?: string; options: Opt[]; providers: { id: string; configured: boolean }[] }[]
    const cap = typeof args.capability === 'string' ? args.capability : null
    const optText = (o: Opt): string =>
      `${o.key}(${o.label}): ${o.values ? o.values.join(' | ') : o.type}${o.min != null || o.max != null ? ` ${o.min ?? ''}~${o.max ?? ''}` : ''}${o.default !== undefined ? ` · 기본 ${String(o.default)}` : ''}`
    return (
      list
        .filter((m) => !cap || m.capability === cap)
        .map((m) =>
          [
            `■ ${m.id} — ${m.label} [${m.capability}]`,
            `  입력: ${m.input} · 프롬프트: ${m.prompt} · 서비스: ${m.providers.map((p) => `${p.id}${p.configured ? '' : '(키 없음)'}`).join(' → ')}`,
            m.note && `  참고: ${m.note}`,
            ...m.options.map((o) => `  - ${optText(o)}`)
          ]
            .filter(Boolean)
            .join('\n')
        )
        .join('\n') || '해당 모델이 없어요.'
    )
  }
  if (name === 'generation_balances') return JSON.stringify(await api('/balances'), null, 2)
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
// process.exit()로 끊으면 닫히는 중인 fetch 소켓과 겹쳐 Windows libuv가 assert로 죽는다 —
// 종료 코드만 정하고 남은 핸들이 닫히며 자연스럽게 끝나게 둔다.
rl.on('close', () => {
  void Promise.allSettled([...pending]).then(() => {
    process.stdin.pause()
    process.exitCode = 0
  })
})
