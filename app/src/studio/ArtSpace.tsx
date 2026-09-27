// 아트 작업 공간 — 프로젝트 목록 → 프로젝트(결과 갤러리 · 도구 · 프로젝트 채팅 · 상세 보기).
// 프로젝트 하나 = 폴더 하나(E:\AgentStudio\ArtProjects\<이름>). 분위기는 따로 정하지 않고 의상 · 소품 묘사로 만든다 —
// 프로젝트는 공통 제작 규칙 · 피할 것 · 출력 규격을 갖고, 채팅은 이 폴더에서 열려 CLAUDE.md · AGENTS.md를 읽는다.
// 만들기는 어시스턴트에게 말로 한다: AI가 필요한 것을 선택지로 묻고 견적을 내면, 승인 카드에서 옵션을 고치고 승인한다.
// 비용이 드는 제출은 승인 센터 카드의 승인으로만 일어난다. 같은 요청 다시 만들기는 상세 보기에서 바로 한다.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { getPref, setPref } from '../lib/prefs'
import { listProjectChats, newProjectChat, openChat, type ProjectChat } from './chatBridge'
import {
  CAP_NAME,
  contentUrl,
  createProject,
  deleteJob,
  fmtCost,
  getProject,
  listLibrary,
  listModels,
  listProjects,
  listTools,
  openInBlender,
  outputUrl,
  PROVIDER_NAME,
  quote,
  updateProject,
  useGateway,
  type Job,
  type LibraryItem,
  type ModelInfo,
  type Project,
  type ProjectSettings,
  type ProviderId,
  type ToolInfo
} from './gateway'
import { ToolHost } from './ToolHost'

type Kind = 'all' | Job['capability']
const KIND_LABEL: Record<Kind, string> = { all: '전체', image: '이미지', video: '영상', model3d: '3D', audio: '오디오' }

/** 작업 하나 = 갤러리 칸 하나. 대표 미리보기는 이미지 → 영상 순. */
interface Entry {
  job: Job
  outputs: LibraryItem['output'][]
  preview: LibraryItem['output'] | null
}

const KIND_RANK: Record<string, number> = { image: 0, video: 1, model: 2, audio: 3 }

function group(items: LibraryItem[]): Entry[] {
  const by = new Map<string, Entry>()
  for (const it of items) {
    const e = by.get(it.job.id) ?? { job: it.job, outputs: [], preview: null }
    e.outputs.push(it.output)
    by.set(it.job.id, e)
  }
  for (const e of by.values()) {
    // 볼 수 있는 결과(이미지 · 영상)를 앞에 — 3D 작업은 미리보기 이미지가 먼저 보이게
    e.outputs.sort((a, b) => (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9))
    e.preview = e.outputs.find((o) => o.kind === 'image') ?? e.outputs.find((o) => o.kind === 'video') ?? null
  }
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
      // 캐시에서 바로 그려진 이미지는 load 이벤트를 놓칠 수 있다 — 붙는 순간 이미 다 읽혔으면 준비 완료로
      <img className="st-art-media" src={src} alt="" loading="lazy" onLoad={ok} onError={bad} ref={(el) => void (el?.complete && el.naturalWidth > 0 && ok())} />
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

function Detail({ e, model, onClose, onReuse, onDeleted }: { e: Entry; model?: ModelInfo; onClose: () => void; onReuse: () => void; onDeleted: () => void }): ReactElement {
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
  // 3D 모델은 Blender(설치된 것 중 최신)를 띄워 빈 장면에 불러온다
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const openModel = (): void => {
    if (!o) return
    setNote({ ok: true, text: 'Blender를 여는 중…' })
    openInBlender(o.id)
      .then((b) => setNote({ ok: true, text: `Blender ${b.version}에서 모델을 불러오고 있어요 — 창이 뜰 때까지 몇 초 걸려요` }))
      .catch((err: Error) => setNote({ ok: false, text: err.message }))
  }
  // 지우기 — 한 번 더 확인받는다. 되돌릴 수 없다.
  const [confirmDel, setConfirmDel] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const remoteDeletable = e.job.provider === 'comfy'
  const doDelete = (): void => {
    setDeleting(true)
    setNote(null)
    deleteJob(e.job.id)
      .then(onDeleted)
      .catch((err: Error) => {
        setNote({ ok: false, text: err.message })
        setDeleting(false)
        setConfirmDel(false)
      })
  }
  const thumbLabel = (x: LibraryItem['output'], i: number): string => {
    if (x.kind === 'model') return '3D 모델'
    if (x.kind === 'video') return '영상'
    if (e.job.capability === 'model3d') return '미리보기'
    return `${i + 1}`
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
          {o?.kind === 'model' ? (
            // 앱 안 3D 보기는 아직 없다 — 미리보기 이미지 위에 모델 파일 안내와 열기 버튼
            <div className="st-art-model3d">
              {e.preview && <Media key={e.preview.id} o={e.preview} big />}
              <div className="st-art-model3d-bar">
                <div>
                  <b>3D 모델 파일 (.glb)</b>
                  <span>Blender를 열어 빈 장면에 이 모델을 불러와요</span>
                </div>
                <button type="button" className="st-gloss st-gen-go" onClick={openModel}>
                  Blender로 열기
                </button>
              </div>
            </div>
          ) : (
            <Media key={o?.id} o={o} big />
          )}
          {e.outputs.length > 1 && (
            <div className="st-art-thumbs">
              {e.outputs.map((x, i) => (
                <button key={x.id} type="button" className={i === idx ? 'on' : ''} onClick={() => setIdx(i)} aria-label={thumbLabel(x, i)}>
                  {thumbLabel(x, i)}
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
              {j.origin?.source === 'agent' ? 'AI 요청' : j.origin?.source === 'tool' ? '도구 요청' : '직접 요청'}
              {j.origin?.space ? ` · ${SPACE_NAME[j.origin.space] ?? j.origin.space}` : ''}
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
              <div className="st-usage-note">아트 디렉션을 붙이기 전: {j.origin.userPrompt || '(비어 있음)'}</div>
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
          {note && <div className={note.ok ? 'st-usage-note' : 'st-gen-warn'}>{note.text}</div>}
          {confirmDel && (
            <div className="st-gen-warn st-art-delwarn">
              {remoteDeletable
                ? `이 PC의 파일과 ${PROVIDER_NAME[j.provider]} 서버의 결과를 지워요.`
                : `이 PC의 파일을 지워요. ${PROVIDER_NAME[j.provider] ?? j.provider}는 서버에서 지우는 기능이 없어서, 서비스 쪽 사본은 보관 기간이 지나면 사라져요.`}{' '}
              되돌릴 수 없어요. 비용 기록은 사용액 합계를 위해 남겨요.
            </div>
          )}
          <div className="st-art-actions">
            {confirmDel ? (
              <>
                <button type="button" className="st-pill st-art-danger st-art-delgo" disabled={deleting} onClick={doDelete}>
                  {deleting ? '지우는 중…' : '정말 지우기'}
                </button>
                <button type="button" className="st-pill" disabled={deleting} onClick={() => setConfirmDel(false)}>
                  취소
                </button>
              </>
            ) : (
              <>
                <button type="button" className="st-gloss st-gen-go" onClick={onReuse}>
                  다시 생성
                </button>
                <button type="button" className="st-pill" onClick={open} disabled={!o}>
                  {o?.storageKey ? '폴더에서 보기' : '원본 열기'}
                </button>
                <button type="button" className="st-pill st-art-danger" onClick={() => setConfirmDel(true)}>
                  삭제
                </button>
              </>
            )}
          </div>
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

// ── 공간 ───────────────────────────────────────────────

const PROJECT_PREF = 'studio.art.project'

export function ArtSpace({ ensureApp }: { ensureApp: () => void }): ReactElement {
  const [project, setProject] = useState<string | null>(() => getPref<string>(PROJECT_PREF, '') || null)
  const pick = (id: string | null): void => {
    setProject(id)
    setPref(PROJECT_PREF, id ?? '')
  }
  return project ? <ProjectSpace key={project} id={project} ensureApp={ensureApp} onBack={() => pick(null)} /> : <ProjectList onOpen={pick} />
}

// ── 프로젝트 목록 ───────────────────────────────────────
function ProjectList({ onOpen }: { onOpen: (id: string) => void }): ReactElement {
  const g = useGateway()
  const [data, setData] = useState<{ root: string; defaults: ProjectSettings; projects: Project[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  useEffect(() => {
    if (g.status !== 'ready') return
    listProjects()
      .then(setData)
      .catch((e: Error) => setErr(e.message))
  }, [g.status, g.outputsVersion])
  return (
    <div className="st-proj">
      <div className="st-proj-head">
        <div>
          <h2>아트 프로젝트</h2>
          <p className="st-dim">프로젝트마다 규칙 · 채팅 · 결과가 따로예요. 폴더: {data?.root ?? '…'}</p>
        </div>
      </div>
      {err && <div className="st-gen-warn">{err}</div>}
      {g.status !== 'ready' && <div className="st-empty">생성 게이트웨이에 연결하는 중…</div>}
      <div className="st-proj-grid">
        {data?.projects.map((pr) => (
          <button key={pr.id} type="button" className="st-proj-card" onClick={() => onOpen(pr.id)} aria-label={`${pr.name} 프로젝트 열기`}>
            <div className="st-proj-cover">{pr.cover ? <img src={contentUrl(pr.cover) ?? ''} alt="" loading="lazy" /> : <ModelGlyph />}</div>
            <div className="st-proj-meta">
              <b className="st-gen-ellipsis">{pr.name}</b>
              <span className="st-dim">
                결과 {pr.outputs ?? 0}개 · {new Date(pr.updatedAt).toLocaleDateString('ko-KR')}
              </span>
            </div>
          </button>
        ))}
        {data && (
          <button type="button" className="st-proj-card st-proj-new" onClick={() => setMaking(true)}>
            <span>+</span>새 프로젝트
          </button>
        )}
      </div>
      {making && data && <ProjectSettingsDialog defaults={data.defaults} onClose={() => setMaking(false)} onSaved={(pr) => onOpen(pr.id)} />}
    </div>
  )
}

// ── 프로젝트 설정(새로 만들기 · 고치기) ─────────────────────
// 모든 도구에 공통인 것만 — 이름 · 피할 것. 캐릭터 시트의 규칙 · 출력 · 기본 복장 · 분석 엔진은 캐릭터 시트의 "설정"에 있다.
function ProjectSettingsDialog({ project, defaults, onClose, onSaved }: { project?: Project; defaults: ProjectSettings; onClose: () => void; onSaved: (p: Project) => void }): ReactElement {
  const [name, setName] = useState(project?.name ?? '')
  const [st, setSt] = useState<ProjectSettings>(() => structuredClone(project?.settings ?? defaults))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]): void => setSt((x) => ({ ...x, [k]: v }))
  const save = (): void => {
    if (!name.trim()) return setErr('프로젝트 이름을 적어 주세요')
    setBusy(true)
    setErr(null)
    ;(project ? updateProject(project.id, { name, settings: st }) : createProject(name, st))
      .then((p) => (onSaved(p), onClose()))
      .catch((e: Error) => (setErr(e.message), setBusy(false)))
  }
  return (
    <div className="st-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="st-art-editor st-proj-editor" role="dialog" aria-modal="true" aria-label={project ? '프로젝트 설정' : '새 프로젝트'}>
        <h2>{project ? '프로젝트 설정' : '새 프로젝트'}</h2>
        <label className="st-art-field" htmlFor="pj-name">
          <span>이름 {project ? '' : '(폴더 이름이 돼요)'}</span>
          <input id="pj-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 서울 괴담 · 주인공 파티" />
        </label>
        <label className="st-art-field" htmlFor="pj-avoid">
          <span>피할 것 (모든 이미지 · 영상 · 선택)</span>
          <input id="pj-avoid" value={st.avoid} onChange={(e) => set('avoid', e.target.value)} placeholder="예: 글자 · 로고 · 워터마크" />
        </label>
        <p className="st-dim">도구마다 쓰는 설정(예: 캐릭터 시트의 공통 규칙 · 출력 규격 · 기본 복장 · AI 분석)은 각 도구 안의 "설정"에서 정해요.</p>
        <p className="st-dim">설정은 프로젝트 폴더의 project.json과 AI 지침(CLAUDE.md · AGENTS.md)에 저장돼요.</p>
        {err && <div className="st-gen-warn">{err}</div>}
        <div className="st-art-actions">
          <button type="button" className="st-gloss st-gen-go" disabled={busy} onClick={save}>
            {busy ? '저장 중…' : project ? '저장' : '만들기'}
          </button>
          <button type="button" className="st-pill" onClick={onClose}>
            취소
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 프로젝트 채팅 바 — 이 프로젝트 폴더의 채팅 목록 · 새 채팅 ──────────
function ChatBar({ dir }: { dir: string }): ReactElement {
  const [list, setList] = useState<ProjectChat[]>([])
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const refresh = useCallback(() => {
    listProjectChats(dir)
      .then((r) => setList(r.chats))
      .catch(() => {})
  }, [dir])
  // 들어올 때 — 지금 채팅이 이 프로젝트 것이 아니면 최근 채팅을 열고, 없으면 새로 만든다
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      listProjectChats(dir)
        .then((r) => {
          if (!alive) return
          setList(r.chats)
          if (!r.activeInProject) (r.chats[0] ? openChat(r.chats[0].id) : newProjectChat(dir))
        })
        .catch(() => {})
    }, 400) // 채팅(App)이 막 마운트되는 경우를 기다린다
    // 목록은 가끔만 다시 읽는다(채팅 저장소를 읽는 IPC) — 창에 돌아올 때 · 30초마다 · 목록을 열 때
    const iv = setInterval(() => document.visibilityState === 'visible' && refresh(), 30000)
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      clearTimeout(t)
      clearInterval(iv)
      window.removeEventListener('focus', onFocus)
    }
  }, [dir, refresh])
  useEffect(() => {
    if (open) refresh()
  }, [open, refresh])
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [open])
  const active = list.find((c) => c.active)
  return (
    <div className="st-chatbar" ref={box}>
      <button type="button" className="st-chatbar-pick" aria-haspopup="listbox" aria-expanded={open} onClick={() => (setOpen((o) => !o), refresh())}>
        <span className="st-gen-ellipsis">{active?.title ?? '프로젝트 채팅'}</span>
        <em>{list.length}</em>
      </button>
      <button
        type="button"
        className="st-pill st-chatbar-new"
        onClick={() => {
          newProjectChat(dir)
          setTimeout(refresh, 600)
        }}
      >
        + 새 채팅
      </button>
      {open && (
        <ul className="st-chatbar-list" role="listbox" aria-label="프로젝트 채팅">
          {list.length === 0 && <li className="st-dim">아직 채팅이 없어요</li>}
          {list.map((c) => (
            <li key={c.id} role="option" aria-selected={c.active}>
              <button
                type="button"
                className={c.active ? 'on' : ''}
                onClick={() => {
                  openChat(c.id)
                  setOpen(false)
                  setTimeout(refresh, 400)
                }}
              >
                <span className="st-gen-ellipsis">{c.title}</span>
                <em>{c.updatedAt ? when(c.updatedAt) : ''}</em>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ── 프로젝트 ────────────────────────────────────────────
function ProjectSpace({ id, ensureApp, onBack }: { id: string; ensureApp: () => void; onBack: () => void }): ReactElement {
  const g = useGateway()
  // 오른쪽은 늘 어시스턴트 — 원본 채팅(App)을 이 자리에 띄운다(studio.css의 html[data-art-assist])
  useEffect(() => {
    ensureApp()
    document.documentElement.dataset.artAssist = '1'
    return () => {
      document.documentElement.dataset.artAssist = ''
    }
  }, [ensureApp])
  const [project, setProject] = useState<Project | null>(null)
  const [defaults, setDefaults] = useState<ProjectSettings | null>(null)
  const [perr, setPerr] = useState<string | null>(null)
  const [editingProject, setEditingProject] = useState(false)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [items, setItems] = useState<LibraryItem[]>([])
  const [kind, setKind] = useState<Kind>('all')
  const [prov, setProv] = useState<ProviderId | 'all'>('all')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  // 도구(HTML 플러그인) — 게이트웨이 tools 폴더 목록, 연 도구
  const [tools, setTools] = useState<ToolInfo[]>([])
  const [tool, setTool] = useState<string | null>(null)

  useEffect(() => {
    if (g.status !== 'ready') return
    getProject(id)
      .then(setProject)
      .catch((e: Error) => setPerr(e.message))
    listProjects()
      .then((d) => setDefaults(d.defaults))
      .catch(() => {})
  }, [id, g.status])
  const configuredKey = g.providers.map((p) => `${p.id}:${p.configured}`).join(',')
  useEffect(() => {
    if (g.status !== 'ready') return
    listModels().then(setModels).catch(() => {})
  }, [g.status, configuredKey])
  // 목록 새로고침 — 결과가 바뀌면 이벤트로, 상세 보기를 열 때도(기록이 나중에 보강될 수 있어서) 다시 받는다
  const reload = useCallback(() => {
    listLibrary(300, id).then(setItems).catch(() => {})
  }, [id])
  useEffect(() => {
    if (g.status === 'ready') listTools().then(setTools).catch(() => {})
  }, [g.status])
  useEffect(() => {
    if (g.status === 'ready') reload()
  }, [g.status, g.outputsVersion, reload])

  const entries = useMemo(() => group(items), [items])
  const shown = entries.filter(
    (e) =>
      (kind === 'all' || e.job.capability === kind) &&
      (prov === 'all' || e.job.provider === prov) &&
      (!q.trim() || (e.job.prompt ?? '').toLowerCase().includes(q.trim().toLowerCase()))
  )
  const current = open ? entries.find((e) => e.job.id === open) ?? null : null

  // 다시 만들기 — 같은 요청으로 견적을 내면 승인 카드가 뜬다(옵션은 카드에서 고친다). 아트 디렉션은 게이트웨이가 다시 붙인다
  const reuse = (e: Entry): void => {
    const j = e.job
    setOpen(null)
    void quote({
      capability: j.capability,
      model: j.model,
      provider: j.provider,
      project: j.project ?? id,
      prompt: (j.origin?.userPrompt ?? j.prompt) || undefined,
      inputs: (j.inputs ?? []).filter((i) => i.kind === 'image').map((i) => ({ kind: 'image' as const, path: i.path, url: i.url, view: i.view })),
      // 시드는 빼고 다시 만든다 — 같은 시드면 서비스가 지난 결과를 그대로 돌려줄 수 있다
      params: Object.fromEntries(Object.entries(j.params ?? {}).filter(([k]) => k !== 'seed')),
      origin: { space: 'art', source: 'ui', title: j.origin?.title }
    }).catch(() => {})
  }

  const count = (k: Kind): number => (k === 'all' ? entries.length : entries.filter((e) => e.job.capability === k).length)
  const provs: ProviderId[] = ['comfy', 'higgsfield', 'tripo']

  return (
    <div className="st-art assist">
      <aside className="st-art-side st-art-filter" aria-label="프로젝트">
        <button type="button" className="st-proj-back" onClick={onBack}>
          ← 프로젝트 목록
        </button>
        <div className="st-proj-title">
          <h2 className="st-gen-ellipsis">{project?.name ?? id}</h2>
          <span className="st-dim">{project ? project.dir : perr ?? '…'}</span>
          <button type="button" className="st-pill" disabled={!project || !defaults} onClick={() => setEditingProject(true)}>
            프로젝트 설정
          </button>
        </div>
        <input className="st-art-search" type="search" aria-label="프롬프트 검색" placeholder="프롬프트 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        {tools.length > 0 && (
          <div className="st-art-group">
            <span>도구</span>
            {tools.map((t) => (
              <button key={t.id} type="button" onClick={() => setTool(t.id)} disabled={!project}>
                {t.name}
              </button>
            ))}
          </div>
        )}
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
          <div className="st-empty">{entries.length ? '조건에 맞는 결과가 없어요' : '아직 결과가 없어요 — 오른쪽 채팅에서 만들고 싶은 것을 말하거나, 왼쪽 도구를 써 보세요'}</div>
        ) : (
          <div className="st-art-grid">
            {shown.map((e) => (
              <button key={e.job.id} type="button" className="st-art-tile" onClick={() => (setOpen(e.job.id), reload())} aria-label={`${CAP_NAME[e.job.capability]} — ${e.job.prompt ?? e.job.model}`}>
                <div className="st-art-thumb">
                  <Media o={e.preview ?? e.outputs[0]} />
                  <span className="st-art-badge">{KIND_LABEL[e.job.capability]}</span>
                  {e.outputs.length > 1 && <span className="st-art-badge right">{e.outputs.length}</span>}
                </div>
                <div className="st-art-cap">
                  <span className="st-gen-ellipsis">{e.job.origin?.userPrompt || e.job.prompt || e.job.origin?.title || e.job.model}</span>
                  <span className="st-dim">
                    {PROVIDER_NAME[e.job.provider] ?? e.job.provider} · {e.job.cost ? fmtCost(e.job.cost) : '비용 미상'} · {when(e.job.createdAt)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
      </main>

      <div className="st-art-right">
        {project && <ChatBar dir={project.dir} />}
        {/* 이 자리는 비워 두고, 원본 채팅(App)이 위에 겹쳐 그려진다(원본 배경이 반투명이라 안내 문구를 두지 않는다) */}
        <AssistHole />
      </div>
      {current && (
        <Detail
          e={current}
          model={models.find((m) => m.id === current.job.model)}
          onClose={() => setOpen(null)}
          onReuse={() => reuse(current)}
          onDeleted={() => (setOpen(null), reload())}
        />
      )}
      {tool && project && <ToolHost toolId={tool} projectId={project.id} onClose={() => (setTool(null), reload())} />}
      {editingProject && project && defaults && (
        <ProjectSettingsDialog project={project} defaults={defaults} onClose={() => setEditingProject(false)} onSaved={(p) => setProject({ ...p, dir: project.dir })} />
      )}
    </div>
  )
}
