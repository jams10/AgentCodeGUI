// 생성 승인 센터 — 화면 오른쪽 아래. 어느 공간에 있든(홈 포함) 떠 있다.
//  - 승인 대기: 프롬프트 · 서비스 · 옵션 · 예상 비용 · 대체 이유를 보여 주고 승인/거절을 받는다.
//    비용이 드는 제출은 여기서 누른 승인으로만 일어난다(AI에게는 승인 도구가 없다).
//    「옵션 바꾸기」로 해상도 · 길이 · 비율 등을 바로 고친다 — 바꿀 때마다 같은 서비스로 무료 견적을 다시 받고,
//    서비스가 거절한 값은 이유와 함께 알리고 원래 값을 지킨다. 작업 id는 그대로라 기다리던 AI도 끊기지 않는다.
//  - 진행 중: 진행률과 취소.
//  - 끝남: 몇 초간 알림(완료 · 실패)을 띄운다.
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { approve, cancel, CAP_NAME, fmtCost, listModels, outputUrl, PROVIDER_NAME, reject, revise, useGateway, type Job, type ModelInfo, type ModelOption } from './gateway'
import { guessOptions, OptionInput } from './options'

const TOAST_MS = 7000
const HIDDEN_PARAMS = new Set(['workflow', 'prompt', 'workflowPath'])

// 모델 카탈로그 — 옵션 입력칸을 그리는 데 쓴다. 카드가 처음 뜰 때 한 번 받아 둔다.
let catalog: ModelInfo[] | null = null
function useCatalog(): ModelInfo[] {
  const [list, setList] = useState<ModelInfo[]>(catalog ?? [])
  useEffect(() => {
    if (catalog) return
    listModels()
      .then((m) => {
        catalog = m
        setList(m)
      })
      .catch(() => {})
  }, [])
  return list
}

function paramChips(j: Job): string[] {
  const out: string[] = []
  const p = j.params ?? {}
  for (const [k, v] of Object.entries(p)) {
    if (HIDDEN_PARAMS.has(k) || v == null || typeof v === 'object') continue
    out.push(`${k} ${String(v)}`)
    if (out.length >= 5) break
  }
  const wf = p.workflow
  if (wf && typeof wf === 'object') out.unshift(`워크플로 노드 ${Object.keys(wf as object).length}개`)
  if (j.inputs?.length) out.push(`입력 ${j.inputs.length}개`)
  return out
}

function PendingCard({ job }: { job: Job }): ReactElement {
  const [busy, setBusy] = useState<'approve' | 'reject' | 'revise' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [promptEdit, setPromptEdit] = useState<string | null>(null)
  const models = useCatalog()
  const act = (kind: 'approve' | 'reject'): void => {
    setBusy(kind)
    setErr(null)
    ;(kind === 'approve' ? approve(job.id) : reject(job.id)).catch((e: Error) => {
      setErr(e.message)
      setBusy(null)
    })
  }
  const change = (patch: { prompt?: string; params?: Record<string, unknown> }): void => {
    setBusy('revise')
    setErr(null)
    revise(job.id, patch)
      .then(() => setPromptEdit(null))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(null))
  }
  const params = job.params ?? {}
  const setParam = (key: string, v: unknown): void => {
    const next = { ...params }
    if (v === undefined || v === '') delete next[key]
    else next[key] = v
    change({ params: next })
  }
  const model = models.find((m) => m.id === job.model)
  const opts: ModelOption[] = model ? model.options.filter((o) => !HIDDEN_PARAMS.has(o.key)) : guessOptions(params, HIDDEN_PARAMS)
  const chips = paramChips(job)
  const who = job.origin?.source === 'agent' ? 'AI 요청' : '직접 요청'
  const canEditPrompt = !job.styleId && job.prompt != null
  return (
    <section className="st-gen-card" role="dialog" aria-label={`${CAP_NAME[job.capability]} 승인`}>
      <header className="st-gen-h">
        <span>{CAP_NAME[job.capability]}</span>
        <span className="st-pill st-gen-prov">{PROVIDER_NAME[job.provider] ?? job.provider}</span>
      </header>
      <div className="st-gen-meta">
        {who} · {model?.label ?? job.model}
        {job.origin?.title ? ` · ${job.origin.title}` : ''}
      </div>
      {promptEdit != null ? (
        <div className="st-gen-pedit">
          <textarea aria-label="프롬프트" rows={5} value={promptEdit} onChange={(e) => setPromptEdit(e.target.value)} />
          <div className="st-gen-row">
            <button type="button" className="st-pill" disabled={busy != null || !promptEdit.trim() || promptEdit.trim() === job.prompt} onClick={() => change({ prompt: promptEdit })}>
              {busy === 'revise' ? '다시 견적 받는 중…' : '프롬프트 바꾸기'}
            </button>
            <button type="button" className="st-ghost" disabled={busy != null} onClick={() => setPromptEdit(null)}>
              취소
            </button>
          </div>
        </div>
      ) : (
        job.prompt && <div className="st-gen-prompt">{job.prompt}</div>
      )}
      {editing && opts.length > 0 ? (
        <div className="st-gen-opts">
          {opts.map((o) => (
            <OptionInput key={o.key} o={o} value={params[o.key] ?? o.default} disabled={busy != null} onCommit={(v) => setParam(o.key, v)} />
          ))}
        </div>
      ) : (
        chips.length > 0 && (
          <div className="st-gen-chips">
            {chips.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        )
      )}
      {(opts.length > 0 || canEditPrompt) && promptEdit == null && (
        <div className="st-gen-edit">
          {opts.length > 0 && (
            <button type="button" className="st-ghost" aria-expanded={editing} onClick={() => setEditing((x) => !x)}>
              {editing ? '옵션 접기' : '옵션 바꾸기'}
            </button>
          )}
          {canEditPrompt && (
            <button type="button" className="st-ghost" onClick={() => setPromptEdit(job.prompt ?? '')}>
              프롬프트 고치기
            </button>
          )}
        </div>
      )}
      <div className="st-gen-cost">
        <span>예상 비용</span>
        <b>{busy === 'revise' ? '다시 계산하는 중…' : job.estimate ? fmtCost(job.estimate) : '알 수 없음 — 실행 후 잔액 차이로 기록'}</b>
      </div>
      {job.balanceBefore && (
        <div className="st-gen-row">
          <span>현재 잔액</span>
          <span>{fmtCost(job.balanceBefore)}</span>
        </div>
      )}
      {job.fallbackReason && <div className="st-gen-warn">다른 서비스로 대체됨 — {job.fallbackReason}</div>}
      {err && <div className="st-gen-warn">{err}</div>}
      <footer className="st-gen-actions">
        <button type="button" className="st-gloss st-gen-go" disabled={busy != null || promptEdit != null} onClick={() => act('approve')}>
          {busy === 'approve' ? '제출 중…' : '생성하기'}
        </button>
        <button type="button" className="st-ghost" disabled={busy === 'approve' || busy === 'reject'} onClick={() => act('reject')}>
          거절
        </button>
      </footer>
    </section>
  )
}

function RunningRow({ job }: { job: Job }): ReactElement {
  const pct = job.progress != null ? Math.round(job.progress * 100) : null
  return (
    <div className="st-gen-run">
      <div className="st-gen-row">
        <span>
          {CAP_NAME[job.capability]} · {PROVIDER_NAME[job.provider]}
        </span>
        <button type="button" className="st-ghost" onClick={() => void cancel(job.id).catch(() => {})}>
          취소
        </button>
      </div>
      <div className="st-bar">{pct != null ? <div className="st-fill" style={{ width: `${pct}%` }} /> : <div className="st-gen-indet" />}</div>
      {job.prompt && <div className="st-gen-meta st-gen-ellipsis">{job.prompt}</div>}
    </div>
  )
}

function Toast({ job, onClose }: { job: Job; onClose: () => void }): ReactElement {
  const { outputs } = useGateway()
  const outs = outputs[job.id] ?? []
  const ok = job.state === 'succeeded'
  const open = (): void => {
    const first = outs.find((o) => o.kind !== 'image') ?? outs[0]
    if (!first) return
    void outputUrl(first.id)
      .then((r) => {
        if (r.localPath) {
          const i = Math.max(r.localPath.lastIndexOf('\\'), r.localPath.lastIndexOf('/'))
          return window.api.revealPath(r.localPath.slice(0, i), r.localPath.slice(i + 1))
        }
        return window.api.openExternal(r.url).then(() => undefined)
      })
      .catch(() => {})
  }
  return (
    <div className={ok ? 'st-gen-toast' : 'st-gen-toast bad'} role="status">
      <div className="st-gen-row">
        <b>
          {CAP_NAME[job.capability]} {ok ? '완료' : job.state === 'canceled' ? '취소됨' : '실패'}
        </b>
        <button type="button" className="st-ghost" aria-label="알림 닫기" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="st-gen-meta">
        {PROVIDER_NAME[job.provider]} · {ok ? `사용 ${fmtCost(job.cost)}` : job.error ?? ''}
      </div>
      {ok && job.error && <div className="st-gen-warn">{job.error}</div>}
      {ok && outs.length > 0 && (
        <button type="button" className="st-pill st-gen-open" onClick={open}>
          결과 열기 ({outs.length})
        </button>
      )}
    </div>
  )
}

export function ApprovalCenter(): ReactElement | null {
  const g = useGateway()
  const jobs = Object.values(g.jobs)
  const pending = jobs.filter((j) => j.state === 'awaiting_approval').sort((a, b) => a.createdAt - b.createdAt)
  const running = jobs.filter((j) => j.state === 'running' || j.state === 'submitting')

  // 이 창이 떠 있는 동안 끝난 작업만 알림으로(과거 기록은 띄우지 않는다)
  const mountedAt = useRef(Date.now())
  const [toasts, setToasts] = useState<string[]>([])
  const seen = useRef(new Set<string>())
  useEffect(() => {
    for (const j of jobs) {
      const done = j.state === 'succeeded' || j.state === 'failed' || j.state === 'canceled'
      if (!done || j.updatedAt < mountedAt.current || seen.current.has(j.id)) continue
      seen.current.add(j.id)
      setToasts((t) => [...t, j.id])
      setTimeout(() => setToasts((t) => t.filter((x) => x !== j.id)), TOAST_MS)
    }
  }, [jobs])

  if (!pending.length && !running.length && !toasts.length) return null
  return (
    <div className="st-gen-stack" aria-live="polite">
      {toasts.map((id) => g.jobs[id] && <Toast key={id} job={g.jobs[id]} onClose={() => setToasts((t) => t.filter((x) => x !== id))} />)}
      {running.length > 0 && (
        <section className="st-gen-card st-gen-running" aria-label="진행 중인 생성">
          {running.map((j) => (
            <RunningRow key={j.id} job={j} />
          ))}
        </section>
      )}
      {pending.map((j) => (
        <PendingCard key={j.id} job={j} />
      ))}
    </div>
  )
}
