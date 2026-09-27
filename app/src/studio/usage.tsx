// Studio 사용량 · 크레딧 패널.
// 데이터는 원본 API를 그대로 읽는다 — Claude는 getUsage(기본 계정), Codex는 기본 계정의 rateLimits.
// 외부 생성 서비스 크레딧은 생성 게이트웨이(다음 단계)가 붙기 전까지 「연결 전」으로 표시한다.
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { CodexAccountUsage, UsageInfo, UsageWindow } from '@shared/protocol'
import { fmtCost, PROVIDER_NAME, refreshBalances, useGateway, type ProviderId } from './gateway'

const REFRESH_MS = 5 * 60 * 1000
const WARN_PCT = 80

export interface StudioUsage {
  claude: UsageInfo | null
  claudePlan: string | null
  codex: CodexAccountUsage | null
  loading: boolean
  checkedAt: number | null
}

export function useStudioUsage(): StudioUsage & { refresh: (fresh?: boolean) => void } {
  const [u, setU] = useState<StudioUsage>({ claude: null, claudePlan: null, codex: null, loading: true, checkedAt: null })
  const alive = useRef(true)

  const refresh = useCallback((fresh = false): void => {
    setU((cur) => ({ ...cur, loading: true }))
    const api = window.api
    const claudeP = api.getUsage(fresh).catch(() => null)
    const planP = api.auth
      .listAccounts()
      .then((list) => list.find((a) => a.isDefault)?.subscriptionType ?? list[0]?.subscriptionType ?? null)
      .catch(() => null)
    const codexP = Promise.all([api.codexAuth.listAccounts().catch(() => []), api.codexAuth.accountsUsage(fresh).catch(() => [])]).then(
      ([accounts, usage]) => {
        const email = accounts.find((a) => a.isDefault)?.email ?? accounts[0]?.email
        return (email ? usage.find((x) => x.email === email) : usage[0]) ?? null
      }
    )
    void Promise.all([claudeP, planP, codexP]).then(([claude, claudePlan, codex]) => {
      if (!alive.current) return
      setU({ claude, claudePlan, codex, loading: false, checkedAt: Date.now() })
    })
  }, [])

  useEffect(() => {
    alive.current = true
    refresh(false)
    const t = setInterval(() => refresh(false), REFRESH_MS)
    return () => {
      alive.current = false
      clearInterval(t)
    }
  }, [refresh])

  return { ...u, refresh }
}

// ── 표시 도우미 ─────────────────────────────────────────────
function resetText(resetsAt: number | null | undefined): string {
  if (!resetsAt) return ''
  const diff = resetsAt * 1000 - Date.now()
  if (diff <= 0) return '곧 초기화'
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `${mins}분 후 초기화`
  const h = Math.floor(mins / 60)
  if (h < 24) return `${h}시간 ${mins % 60}분 후 초기화`
  const d = new Date(resetsAt * 1000)
  return `${d.getMonth() + 1}월 ${d.getDate()}일 초기화`
}

function Meter({ label, pct, resetsAt }: { label: string; pct: number; resetsAt?: number | null }): ReactElement {
  const v = Math.max(0, Math.min(100, Math.round(pct)))
  return (
    <div className="st-usage-meter">
      <div className="st-usage-row">
        <span>
          {label} {v}%
        </span>
        <span className="dim">{resetText(resetsAt)}</span>
      </div>
      <div className="st-bar" role="meter" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
        <div className={v >= WARN_PCT ? 'st-fill warn' : 'st-fill'} style={{ width: `${v}%` }} />
      </div>
    </div>
  )
}

function claudeWindows(u: UsageInfo | null): { label: string; w: UsageWindow }[] {
  if (!u) return []
  const out: { label: string; w: UsageWindow }[] = []
  if (u.fiveHour) out.push({ label: '5시간 한도', w: u.fiveHour })
  if (u.weekly) out.push({ label: '주간 한도', w: u.weekly })
  if (u.weeklyFable) out.push({ label: 'Fable 주간 한도', w: u.weeklyFable })
  return out
}

/** 상단 바 버튼 옆 미니 게이지에 쓸 대표값 — 가장 먼저 차는 창 */
export function topPct(u: StudioUsage): { claude: number | null; codex: number | null } {
  const c = claudeWindows(u.claude).map((x) => x.w.pct)
  const g = (u.codex?.windows ?? []).map((w) => w.usedPct)
  return { claude: c.length ? Math.max(...c) : null, codex: g.length ? Math.max(...g) : null }
}

function MiniMeter({ label, pct }: { label: string; pct: number | null }): ReactElement {
  return (
    <span className="mini">
      {label}
      <span className="st-bar">
        <span className={pct != null && pct >= WARN_PCT ? 'st-fill warn' : 'st-fill'} style={{ display: 'block', width: `${pct ?? 0}%` }} />
      </span>
    </span>
  )
}

export function UsageButton({ usage, open, onToggle }: { usage: StudioUsage; open: boolean; onToggle: () => void }): ReactElement {
  const top = topPct(usage)
  return (
    <button type="button" className="st-pill st-usage-btn" aria-expanded={open} aria-label="사용량과 크레딧 보기" onClick={onToggle}>
      <MiniMeter label="Claude" pct={top.claude} />
      <MiniMeter label="GPT" pct={top.codex} />
      <span className="mini">크레딧</span>
    </button>
  )
}

/** 외부 생성 서비스 — 게이트웨이의 잔액 + 최근 30일 사용액 */
function GenCredits(): ReactElement {
  const g = useGateway()
  const ids: ProviderId[] = ['comfy', 'higgsfield', 'tripo']
  const text = (id: ProviderId): string => {
    if (g.status !== 'ready') return g.status === 'connecting' ? '연결 중…' : '게이트웨이 연결 안 됨'
    const p = g.providers.find((x) => x.id === id)
    if (!p?.configured) return 'API 키 없음'
    const b = g.balances[id]
    if (b && 'error' in b) return '조회 실패'
    if (b) return `${fmtCost(b)} 남음`
    return id === 'higgsfield' ? '잔액 조회 API 없음' : g.checkedAt ? '알 수 없음' : '확인 전'
  }
  const spent = (id: ProviderId): string | null => {
    const s = g.spend.find((x) => x.provider === id)
    if (!s || !s.jobs) return null
    return `30일 ${s.jobs}건 · $${s.usd.toFixed(2)}${s.unknown ? ` (+${s.unknown}건 금액 미상)` : ''}`
  }
  return (
    <section className="st-usage-sec">
      <div className="st-usage-row">
        <span>외부 서비스 크레딧</span>
        <button type="button" className="st-ghost" onClick={() => void refreshBalances().catch(() => {})} disabled={g.status !== 'ready'}>
          잔액 확인
        </button>
      </div>
      {ids.map((id) => (
        <div key={id} className="st-credit" style={{ flexDirection: 'column', gap: 2 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>{PROVIDER_NAME[id]}</span>
            <span className="st-dim">{text(id)}</span>
          </div>
          {spent(id) && <span className="st-dim" style={{ fontSize: 12 }}>{spent(id)}</span>}
        </div>
      ))}
      {g.status === 'ready' && g.providers.every((p) => !p.configured) && (
        <div className="st-usage-note">API 키를 넣으면 남은 크레딧과 사용 기록이 여기에 표시돼요.</div>
      )}
    </section>
  )
}

export function UsagePanel({ usage, onClose, onRefresh }: { usage: StudioUsage; onClose: () => void; onRefresh: () => void }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const el = e.target as Element | null
      if (ref.current?.contains(el) || el?.closest('.st-usage-btn')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const cw = claudeWindows(usage.claude)
  const credit = usage.claude?.extraCredit
  const codex = usage.codex
  return (
    <div className="st-pop st-usage" ref={ref} role="dialog" aria-label="사용량과 크레딧">
      <div className="st-usage-h">
        <span>사용량 · 크레딧</span>
        <button type="button" className="st-ghost" onClick={onRefresh} disabled={usage.loading}>
          {usage.loading ? '확인 중…' : '새로고침'}
        </button>
      </div>

      <section className="st-usage-sec">
        <div className="st-usage-row">
          <span>Claude{usage.claudePlan ? ` · ${usage.claudePlan}` : ''}</span>
          <span className="dim">기본 계정</span>
        </div>
        {cw.length ? (
          cw.map((x) => <Meter key={x.label} label={x.label} pct={x.w.pct} resetsAt={x.w.resetsAt} />)
        ) : (
          <div className="st-usage-note">
            {usage.claude?.unavailable ? '한도를 조회하지 못했어요. 로그인 상태를 확인해 주세요.' : '표시할 한도가 없어요.'}
          </div>
        )}
        {credit && (credit.enabled || credit.outOfCredits) && (
          <div className="st-usage-row">
            <span>추가 사용 크레딧</span>
            <span className="dim">
              {credit.outOfCredits ? '소진됨' : credit.balance != null ? `${credit.currency === 'USD' ? '$' : ''}${credit.balance.toFixed(2)} 남음` : ''}
            </span>
          </div>
        )}
      </section>

      <section className="st-usage-sec">
        <div className="st-usage-row">
          <span>GPT · Codex{codex?.planType ? ` · ${codex.planType}` : ''}</span>
          <span className="dim">기본 계정</span>
        </div>
        {codex && codex.windows.length ? (
          codex.windows.map((w) => <Meter key={w.label} label={`${w.label} 한도`} pct={w.usedPct} resetsAt={w.resetsAt} />)
        ) : (
          <div className="st-usage-note">{codex ? '표시할 한도가 없어요.' : '연결된 Codex 계정이 없어요.'}</div>
        )}
      </section>

      <GenCredits />


      <div className="st-usage-row">
        <span className="dim">{usage.checkedAt ? `마지막 확인 · ${new Date(usage.checkedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
        <button type="button" className="st-ghost" onClick={onClose}>
          닫기
        </button>
      </div>
    </div>
  )
}
