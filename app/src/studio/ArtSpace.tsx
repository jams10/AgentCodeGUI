// 아트 작업 공간 — 필터 · 결과 갤러리 · 어시스턴트(채팅) · 상세 보기.
// 만들기는 어시스턴트에게 말로 한다: AI가 필요한 것을 선택지로 묻고 견적을 내면, 승인 카드에서 옵션을 고치고 승인한다.
// 비용이 드는 제출은 승인 센터 카드의 승인으로만 일어난다. 같은 요청 다시 만들기는 상세 보기에서 바로 한다.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import {
  CAP_NAME,
  composePrompt,
  contentUrl,
  createStyle,
  deleteStyle,
  fmtCost,
  listLibrary,
  listModels,
  listStyles,
  outputUrl,
  PROVIDER_NAME,
  quote,
  setJobStyle,
  updateStyle,
  useGateway,
  type Job,
  type LibraryItem,
  type ModelInfo,
  type ProviderId,
  type Style,
  type StyleInput
} from './gateway'

type Kind = 'all' | Job['capability']
const KIND_LABEL: Record<Kind, string> = { all: '전체', image: '이미지', video: '영상', model3d: '3D', audio: '오디오' }

/** 작업 하나 = 갤러리 칸 하나. 대표 미리보기는 이미지 → 영상 순. */
interface Entry {
  job: Job
  outputs: LibraryItem['output'][]
  preview: LibraryItem['output'] | null
}

function group(items: LibraryItem[]): Entry[] {
  const by = new Map<string, Entry>()
  for (const it of items) {
    const e = by.get(it.job.id) ?? { job: it.job, outputs: [], preview: null }
    e.outputs.push(it.output)
    by.set(it.job.id, e)
  }
  for (const e of by.values()) e.preview = e.outputs.find((o) => o.kind === 'image') ?? e.outputs.find((o) => o.kind === 'video') ?? null
  return [...by.values()].sort((a, b) => b.job.createdAt - a.job.createdAt)
}

function when(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })
}

function baseName(p: string): string {
  return p.slice(Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')) + 1)
}

const ModelGlyph = (): ReactElement => (
  <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" />
    <path d="M4 7.5 12 12l8-4.5M12 12v9" />
  </svg>
)

const LOAD_TIMEOUT_MS = 20000

/** 결과 미리보기 — 불러오는 동안과 실패했을 때는 자리 표시를 보여 준다(검은 빈 칸 방지) */
function Media({ o, big }: { o: LibraryItem['output'] | null; big?: boolean }): ReactElement {
  const [phase, setPhase] = useState<'loading' | 'ready' | 'broken'>('loading')
  const src = o ? contentUrl(o.id) : null
  const previewable = !!o && !!src && (o.kind === 'image' || o.kind === 'video')
  useEffect(() => {
    setPhase('loading')
    if (!previewable) return
    // 응답 없는 주소는 로딩 이벤트도 오류 이벤트도 늦게 온다 — 일정 시간 뒤 실패로 본다
    const t = setTimeout(() => setPhase((p) => (p === 'loading' ? 'broken' : p)), LOAD_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [src, previewable])
  const ph = (text: string): ReactElement => (
    <div className="st-art-ph">
      <ModelGlyph />
      <span>{text}</span>
    </div>
  )
  if (!o || !src) return ph('결과 없음')
  if (!previewable) return ph(o.kind === 'model' ? '3D 모델' : o.kind === 'audio' ? '오디오' : '파일')
  const ok = (): void => setPhase('ready')
  const bad = (): void => setPhase('broken')
  const media =
    o.kind === 'video' ? (
      big ? (
        <video className="st-art-media" src={src} controls autoPlay loop onLoadedData={ok} onError={bad} />
      ) : (
        <video className="st-art-media" src={src} muted loop playsInline preload="metadata" onLoadedMetadata={(e) => { const v = e.currentTarget; if (isFinite(v.duration) && v.currentTime === 0) v.currentTime = v.duration / 2 }} onLoadedData={ok} onError={bad} onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})} onMouseLeave={(e) => e.currentTarget.pause()} />
      )
    ) : (
      <img className="st-art-media" src={src} alt="" loading="lazy" onLoad={ok} onError={bad} />
    )
  return (
    <div className="st-art-mediabox">
      {phase !== 'broken' && media}
      {phase !== 'ready' && <div className="st-art-overlay">{ph(phase === 'broken' ? '미리보기를 불러오지 못했어요' : '불러오는 중…')}</div>}
    </div>
  )
}

// ── 상세 보기 ─────────────────────────────────────────
const SPACE_NAME: Record<string, string> = { chat: '채팅', art: '아트', game: '게임 제작', research: '리서치', library: '라이브러리' }

const VIEW_NAME: Record<string, string> = { front: '앞', left: '왼쪽', back: '뒤', right: '오른쪽' }
/** 상세 화면의 옵션 칩에서 뺄 값 — 따로 보여 주거나(프롬프트 · 입력) 너무 큰 값(워크플로 본문) */
const DETAIL_HIDDEN = new Set(['workflow', 'workflowPath', 'negative_prompt', 'prompt', 'promptSlot'])

function Detail({ e, model, styles, onStyle, onClose, onReuse }: { e: Entry; model?: ModelInfo; styles: Style[]; onStyle: (styleId: string | null) => void; onClose: () => void; onReuse: () => void }): ReactElement {
  const [idx, setIdx] = useState(0)
  const o = e.outputs[idx] ?? null
  useEffect(() => {
    const k = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const open = (): void => {
    if (!o) return
    void outputUrl(o.id)
      .then((r) => {
        if (r.localPath) {
          const i = Math.max(r.localPath.lastIndexOf('\\'), r.localPath.lastIndexOf('/'))
          return window.api.revealPath(r.localPath.slice(0, i), r.localPath.slice(i + 1))
        }
        return window.api.openExternal(r.url).then(() => undefined)
      })
      .catch(() => {})
  }
  const [copied, setCopied] = useState(false)
  const j = e.job
  const negative = j.params?.negative_prompt
  const workflowPath = typeof j.params?.workflowPath === 'string' ? j.params.workflowPath : null
  const inputs = j.inputs ?? []
  const chips = Object.entries(j.params ?? {}).filter(([k, v]) => !DETAIL_HIDDEN.has(k) && v != null && typeof v !== 'object')
  const optLabel = (k: string): string => model?.options.find((x) => x.key === k)?.label ?? k
  return (
    <div className="st-veil" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="st-art-detail" role="dialog" aria-modal="true" aria-label="결과 자세히 보기">
        <div className="st-art-detail-media">
          <Media key={o?.id} o={o} big />
          {e.outputs.length > 1 && (
            <div className="st-art-thumbs">
              {e.outputs.map((x, i) => (
                <button key={x.id} type="button" className={i === idx ? 'on' : ''} onClick={() => setIdx(i)} aria-label={`결과 ${i + 1}`}>
                  {x.kind === 'model' ? '3D' : x.kind === 'video' ? '영상' : `${i + 1}`}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="st-art-detail-info">
          <div className="st-gen-h">
            <span>{CAP_NAME[j.capability]}</span>
            <button type="button" className="st-ghost" onClick={onClose} aria-label="닫기">
              ×
            </button>
          </div>
          <dl className="st-art-facts">
            <dt>서비스</dt>
            <dd>
              <span className="st-art-svc">{PROVIDER_NAME[j.provider] ?? j.provider}</span>
              {j.fallbackReason && <span className="st-dim"> · 대체 실행</span>}
            </dd>
            <dt>모델</dt>
            <dd>{model?.label ?? j.model}</dd>
            <dt>요청</dt>
            <dd>
              {j.origin?.source === 'agent' ? 'AI 요청' : '직접 요청'}
              {j.origin?.space ? ` · ${SPACE_NAME[j.origin.space] ?? j.origin.space}` : ''}
            </dd>
            <dt>스타일</dt>
            <dd>
              <select className="st-art-inline" aria-label="스타일 분류" value={j.styleId ?? ''} onChange={(ev) => onStyle(ev.target.value || null)}>
                <option value="">미분류</option>
                {styles.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </dd>
            <dt>생성 시각</dt>
            <dd>{new Date(j.createdAt).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })}</dd>
          </dl>
          <section className="st-art-sec">
            <div className="st-art-sec-h">
              <span>프롬프트</span>
              {j.prompt && (
                <button type="button" className="st-ghost" onClick={() => void navigator.clipboard.writeText(j.prompt ?? '').then(() => setCopied(true)).catch(() => {})}>
                  {copied ? '복사됨' : '복사'}
                </button>
              )}
            </div>
            {j.prompt ? <div className="st-gen-prompt st-art-prompt">{j.prompt}</div> : <div className="st-usage-note">프롬프트 없이 생성했어요.</div>}
            {j.origin?.userPrompt != null && j.origin.userPrompt !== j.prompt && (
              <div className="st-usage-note">스타일 적용 전: {j.origin.userPrompt || '(비어 있음)'}</div>
            )}
            {typeof negative === 'string' && negative.trim() && (
              <>
                <div className="st-art-sec-h">
                  <span>네거티브 프롬프트</span>
                </div>
                <div className="st-gen-prompt st-art-prompt">{negative}</div>
              </>
            )}
          </section>
          {(inputs.length > 0 || workflowPath) && (
            <section className="st-art-sec">
              <div className="st-art-sec-h">
                <span>입력</span>
              </div>
              <ul className="st-art-inputs">
                {workflowPath && <li title={workflowPath}>워크플로 · {baseName(workflowPath)}</li>}
                {inputs.map((i, n) => (
                  <li key={n} title={i.path ?? i.url}>
                    {i.view ? `${VIEW_NAME[i.view] ?? i.view} · ` : '이미지 · '}
                    {baseName(i.path ?? i.url ?? '')}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {chips.length > 0 && (
            <section className="st-art-sec">
              <div className="st-art-sec-h">
                <span>옵션</span>
              </div>
              <div className="st-gen-chips">
                {chips.map(([k, v]) => (
                  <span key={k}>
                    {optLabel(k)} {typeof v === 'boolean' ? (v ? '켬' : '끔') : String(v)}
                  </span>
                ))}
              </div>
            </section>
          )}
          <div className="st-gen-cost">
            <span>사용 비용</span>
            <b>{j.cost ? fmtCost(j.cost) : j.estimate ? `${fmtCost(j.estimate)} (예상)` : '알 수 없음'}</b>
          </div>
          {j.fallbackReason && <div className="st-gen-warn">대체 — {j.fallbackReason}</div>}
          {j.error && <div className="st-gen-warn">{j.error}</div>}
          <div className="st-art-actions">
            <button type="button" className="st-gloss st-gen-go" onClick={onReuse}>
              다시 생성
            </button>
            <button type="button" className="st-pill" onClick={open} disabled={!o}>
              {o?.storageKey ? '폴더에서 보기' : '원본 열기'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── 스타일 편집기 ─────────────────────────────────────
const EMPTY_STYLE: StyleInput = { name: '', description: '', promptPrefix: '', promptSuffix: '', negative: '' }

function StyleEditor({ style, onClose, onSaved }: { style: Style | null; onClose: () => void; onSaved: () => void }): ReactElement {
  const [v, setV] = useState<StyleInput>(style ? { name: style.name, description: style.description ?? '', promptPrefix: style.promptPrefix ?? '', promptSuffix: style.promptSuffix ?? '', negative: style.negative ?? '' } : EMPTY_STYLE)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  useEffect(() => {
    const k = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [onClose])
  const field = (key: keyof StyleInput, label: string, hint: string, rows = 2): ReactElement => (
    <label className="st-art-field" htmlFor={`st-style-${key}`}>
      <span>{label}</span>
      <textarea id={`st-style-${key}`} rows={rows} value={v[key] ?? ''} placeholder={hint} onChange={(e) => setV({ ...v, [key]: e.target.value })} />
    </label>
  )
  const save = (): void => {
    if (!v.name.trim()) return setErr('이름을 적어 주세요')
    setBusy(true)
    setErr(null)
    ;(style ? updateStyle(style.id, v) : createStyle(v))
      .then(() => (onSaved(), onClose()))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false))
  }
  const remove = (): void => {
    if (!style) return
    if (!confirmDel) return setConfirmDel(true)
    setBusy(true)
    deleteStyle(style.id)
      .then(() => (onSaved(), onClose()))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setBusy(false))
  }
  const preview = composePrompt({ promptPrefix: v.promptPrefix, promptSuffix: v.promptSuffix }, '(프롬프트)')
  return (
    <div className="st-veil" onMouseDown={(ev) => ev.target === ev.currentTarget && onClose()}>
      <div className="st-art-styleed" role="dialog" aria-modal="true" aria-label={style ? '스타일 고치기' : '새 스타일'}>
        <div className="st-gen-h">
          <span>{style ? '스타일 고치기' : '새 스타일'}</span>
          <button type="button" className="st-ghost" onClick={onClose} aria-label="스타일 편집 닫기">
            ×
          </button>
        </div>
        <label className="st-art-field" htmlFor="st-style-name">
          <span>이름</span>
          <input id="st-style-name" value={v.name} maxLength={60} placeholder="예: 90년대 FMV · 귀엽고 멍청 · 심플" onChange={(e) => setV({ ...v, name: e.target.value })} />
        </label>
        {field('description', '설명', '이 스타일이 어떤 느낌인지 — AI 어시스턴트도 읽어요')}
        {field('promptPrefix', '프롬프트 앞에 붙일 말', '예: 1990s FMV cutscene, pre-rendered CG, low-poly')}
        {field('promptSuffix', '프롬프트 뒤에 붙일 말', '예: CRT scanlines, muted palette, VHS grain')}
        {field('negative', '네거티브 프롬프트', '예: text, watermark — 받는 모델에만 쓰여요', 1)}
        <div className="st-art-field">
          <span>이렇게 붙어요</span>
          <div className="st-gen-prompt st-art-final">{preview}</div>
        </div>
        {err && <div className="st-gen-warn">{err}</div>}
        <div className="st-art-actions">
          <button type="button" className="st-gloss st-gen-go" disabled={busy} onClick={save}>
            저장
          </button>
          <button type="button" className="st-ghost" onClick={onClose}>
            취소
          </button>
          {style && (
            <button type="button" className="st-pill st-art-danger" disabled={busy} onClick={remove}>
              {confirmDel ? `정말 지울까요? (결과 ${style.count}개는 남아요)` : '스타일 지우기'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── 어시스턴트 자리 ─────────────────────────────────────
/**
 * 원본 채팅(App의 .win)이 겹쳐 그려질 자리. 이 칸의 실제 위치 · 크기를 재서 html의 CSS 변수로 넘기면
 * studio.css가 .win을 정확히 그 자리에 놓는다 — 숫자를 CSS에 따로 적으면 몇 px씩 어긋나 테두리가 겹쳐 보인다.
 */
function AssistHole(): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const root = document.documentElement.style
    const place = (): void => {
      const r = el.getBoundingClientRect()
      root.setProperty('--st-assist-top', `${Math.round(r.top)}px`)
      root.setProperty('--st-assist-left', `${Math.round(r.left)}px`)
      root.setProperty('--st-assist-width', `${Math.round(r.width)}px`)
      root.setProperty('--st-assist-height', `${Math.round(r.height)}px`)
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    window.addEventListener('resize', place)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', place)
    }
  }, [])
  return <div ref={ref} className="st-art-assist-hole" aria-hidden="true" />
}

// ── 스타일 드롭다운 ───────────────────────────────────
/**
 * 스타일이 늘어도 한 줄만 차지하는 필터. 펼치면 검색 · 전체 · 스타일(개수, ✎ 편집) · 미분류 · 새 스타일.
 * 목록 밖을 누르거나 Esc로 닫힌다. 검색칸에서 ↑↓로 고르고 Enter로 선택한다.
 */
function StylePicker({
  styles,
  value,
  total,
  unsorted,
  onChange,
  onEdit,
  onNew
}: {
  styles: Style[]
  value: StyleFilter
  total: number
  unsorted: number
  onChange: (v: StyleFilter) => void
  onEdit: (s: Style) => void
  onNew: () => void
}): ReactElement {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)

  const opts: { id: StyleFilter; label: string; count: number; style?: Style }[] = [
    { id: 'all', label: '전체', count: total },
    ...styles.filter((x) => !q.trim() || x.name.toLowerCase().includes(q.trim().toLowerCase())).map((x) => ({ id: x.id, label: x.name, count: x.count, style: x })),
    { id: 'none', label: '미분류', count: unsorted }
  ]
  const current = value === 'all' ? '전체' : value === 'none' ? '미분류' : styles.find((x) => x.id === value)?.name ?? '전체'

  useEffect(() => {
    if (!open) return
    setQ('')
    setHi(Math.max(0, opts.findIndex((o) => o.id === value)))
    requestAnimationFrame(() => search.current?.focus())
    const down = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const pick = (v: StyleFilter): void => {
    onChange(v)
    setOpen(false)
  }
  const onKey = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      setOpen(false)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHi((h) => Math.min(opts.length - 1, h + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHi((h) => Math.max(0, h - 1))
    } else if (e.key === 'Enter' && opts[hi]) {
      e.preventDefault()
      pick(opts[hi].id)
    }
  }

  return (
    <div className="st-sp" ref={box}>
      <button type="button" className="st-sp-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={`스타일 필터: ${current}`} onClick={() => setOpen((o) => !o)}>
        <span className="st-gen-ellipsis">{current}</span>
        <em>{value === 'all' ? total : value === 'none' ? unsorted : styles.find((x) => x.id === value)?.count ?? 0}</em>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="st-sp-pop" onKeyDown={onKey}>
          <input
            ref={search}
            className="st-art-search"
            type="search"
            aria-label="스타일 검색"
            placeholder={`스타일 검색 (${styles.length}개)`}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setHi(0)
            }}
          />
          <ul className="st-sp-list" role="listbox" aria-label="스타일">
            {opts.map((o, i) => (
              <li key={o.id} role="option" aria-selected={value === o.id} className={(i === hi ? 'hi ' : '') + (value === o.id ? 'on' : '')} onMouseEnter={() => setHi(i)}>
                <button type="button" className="st-sp-pick" onClick={() => pick(o.id)} title={o.style?.description ?? undefined}>
                  <span className="st-gen-ellipsis">{o.label}</span>
                  <em>{o.count}</em>
                </button>
                {o.style && (
                  <button
                    type="button"
                    className="st-art-edit"
                    aria-label={`${o.label} 스타일 고치기`}
                    onClick={() => {
                      setOpen(false)
                      onEdit(o.style!)
                    }}
                  >
                    ✎
                  </button>
                )}
              </li>
            ))}
            {q.trim() && opts.length === 2 && <li className="st-sp-empty">'{q.trim()}' 스타일이 없어요</li>}
          </ul>
          <button
            type="button"
            className="st-art-newstyle st-sp-new"
            onClick={() => {
              setOpen(false)
              onNew()
            }}
          >
            + 새 스타일
          </button>
        </div>
      )}
    </div>
  )
}

// ── 공간 ───────────────────────────────────────────────
type StyleFilter = 'all' | 'none' | string

export function ArtSpace({ ensureApp }: { ensureApp: () => void }): ReactElement {
  const g = useGateway()
  // 오른쪽은 늘 어시스턴트 — 원본 채팅(App)을 이 자리에 띄운다(studio.css의 html[data-art-assist])
  useEffect(() => {
    ensureApp()
    document.documentElement.dataset.artAssist = '1'
    return () => {
      document.documentElement.dataset.artAssist = ''
    }
  }, [ensureApp])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [styles, setStyles] = useState<Style[]>([])
  const [items, setItems] = useState<LibraryItem[]>([])
  const [kind, setKind] = useState<Kind>('all')
  const [prov, setProv] = useState<ProviderId | 'all'>('all')
  const [styleF, setStyleF] = useState<StyleFilter>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [editing, setEditing] = useState<Style | 'new' | null>(null)

  const configuredKey = g.providers.map((p) => `${p.id}:${p.configured}`).join(',')
  useEffect(() => {
    if (g.status !== 'ready') return
    listModels().then(setModels).catch(() => {})
  }, [g.status, configuredKey])
  // 목록 새로고침 — 결과 · 스타일이 바뀌면 이벤트로, 상세 보기를 열 때도(기록이 나중에 보강될 수 있어서) 다시 받는다
  const reload = useCallback(() => {
    listLibrary().then(setItems).catch(() => {})
    listStyles().then(setStyles).catch(() => {})
  }, [])
  useEffect(() => {
    if (g.status === 'ready') reload()
  }, [g.status, g.outputsVersion, g.stylesVersion, reload])

  const entries = useMemo(() => group(items), [items])
  const byStyle = useMemo(() => new Map(styles.map((x) => [x.id, x])), [styles])
  const shown = entries.filter(
    (e) =>
      (kind === 'all' || e.job.capability === kind) &&
      (prov === 'all' || e.job.provider === prov) &&
      (styleF === 'all' || (styleF === 'none' ? !e.job.styleId : e.job.styleId === styleF)) &&
      (!q.trim() || (e.job.prompt ?? '').toLowerCase().includes(q.trim().toLowerCase()))
  )
  const current = open ? entries.find((e) => e.job.id === open) ?? null : null

  // 다시 만들기 — 같은 요청으로 견적을 내면 승인 카드가 뜬다(옵션은 카드에서 고친다)
  const reuse = (e: Entry): void => {
    const j = e.job
    // 스타일로 만든 결과는 스타일 적용 전 원문을 쓴다(문구가 두 번 붙지 않게)
    const styleId = j.styleId && byStyle.has(j.styleId) ? j.styleId : ''
    const prompt = styleId && j.origin?.userPrompt != null ? j.origin.userPrompt : j.prompt ?? ''
    const params = { ...(j.params ?? {}) }
    if (styleId && byStyle.get(styleId)?.negative === params.negative_prompt) delete params.negative_prompt
    setOpen(null)
    void quote({
      capability: j.capability,
      model: j.model,
      provider: j.provider,
      prompt: prompt || undefined,
      inputs: (j.inputs ?? []).filter((i) => i.kind === 'image').map((i) => ({ kind: 'image' as const, path: i.path, url: i.url, view: i.view })),
      params,
      style: styleId || undefined,
      origin: { space: 'art', source: 'ui', title: j.origin?.title }
    }).catch(() => {})
  }

  const count = (k: Kind): number => (k === 'all' ? entries.length : entries.filter((e) => e.job.capability === k).length)
  const provs: ProviderId[] = ['comfy', 'higgsfield', 'tripo']
  const unsorted = entries.filter((e) => !e.job.styleId).length

  return (
    <div className="st-art assist">
      <aside className="st-art-side st-art-filter" aria-label="보기 필터">
        <h2>라이브러리</h2>
        <input className="st-art-search" type="search" aria-label="프롬프트 검색" placeholder="프롬프트 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="st-art-group">
          <span>스타일</span>
          <StylePicker styles={styles} value={styleF} total={entries.length} unsorted={unsorted} onChange={setStyleF} onEdit={(x) => setEditing(x)} onNew={() => setEditing('new')} />
        </div>
        <div className="st-art-group">
          <span>종류</span>
          {(['all', 'image', 'video', 'model3d'] as Kind[]).map((k) => (
            <button key={k} type="button" className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>
              {KIND_LABEL[k]}
              <em>{count(k)}</em>
            </button>
          ))}
        </div>
        <div className="st-art-group">
          <span>서비스</span>
          <button type="button" className={prov === 'all' ? 'on' : ''} onClick={() => setProv('all')}>
            전체
          </button>
          {provs.map((p) => (
            <button key={p} type="button" className={prov === p ? 'on' : ''} onClick={() => setProv(p)}>
              {PROVIDER_NAME[p]}
            </button>
          ))}
        </div>
      </aside>

      <main className="st-art-main">
        {g.status !== 'ready' ? (
          <div className="st-empty">{g.status === 'connecting' ? '생성 게이트웨이에 연결하는 중…' : '생성 게이트웨이에 연결하지 못했어요. 잠시 후 다시 시도해요.'}</div>
        ) : shown.length === 0 ? (
          <div className="st-empty">{entries.length ? '조건에 맞는 결과가 없어요' : '아직 생성 결과가 없어요 — 오른쪽 어시스턴트에게 만들고 싶은 것을 말해 보세요'}</div>
        ) : (
          <div className="st-art-grid">
            {shown.map((e) => {
              const st = e.job.styleId ? byStyle.get(e.job.styleId) : undefined
              return (
                <button key={e.job.id} type="button" className="st-art-tile" onClick={() => (setOpen(e.job.id), reload())} aria-label={`${CAP_NAME[e.job.capability]} — ${e.job.prompt ?? e.job.model}`}>
                  <div className="st-art-thumb">
                    <Media o={e.preview ?? e.outputs[0]} />
                    <span className="st-art-badge">{KIND_LABEL[e.job.capability]}</span>
                    {e.outputs.length > 1 && <span className="st-art-badge right">{e.outputs.length}</span>}
                    {st && <span className="st-art-badge bottom">{st.name}</span>}
                  </div>
                  <div className="st-art-cap">
                    <span className="st-gen-ellipsis">{e.job.origin?.userPrompt || e.job.prompt || e.job.origin?.title || e.job.model}</span>
                    <span className="st-dim">
                      {PROVIDER_NAME[e.job.provider] ?? e.job.provider} · {e.job.cost ? fmtCost(e.job.cost) : '비용 미상'} · {when(e.job.createdAt)}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </main>

      <div className="st-art-right">
        {/* 이 자리는 비워 두고, 원본 채팅(App)이 위에 겹쳐 그려진다(원본 배경이 반투명이라 안내 문구를 두지 않는다) */}
        <AssistHole />
      </div>
      {current && (
        <Detail
          e={current}
          model={models.find((m) => m.id === current.job.model)}
          styles={styles}
          onStyle={(sid) => void setJobStyle(current.job.id, sid).then(reload).catch(() => {})}
          onClose={() => setOpen(null)}
          onReuse={() => reuse(current)}
        />
      )}
      {editing && <StyleEditor style={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={reload} />}
    </div>
  )
}
