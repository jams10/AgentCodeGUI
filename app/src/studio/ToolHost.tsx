// 도구(HTML 플러그인) 창 — 게이트웨이 tools 폴더의 HTML을 격리된 창(iframe sandbox, 별도 출처)에 띄운다.
// 도구는 게이트웨이 주소 · 토큰 · API 키에 닿지 못하고, 아래 다리(postMessage)로 정해진 일만 앱에 부탁한다.
//  - 비용이 드는 생성은 여기서도 견적까지만 — 승인 카드의 승인으로만 제출된다.
//  - 도구가 만든 작업은 상태가 바뀔 때마다 도구에 알려 준다(결과 id 포함). 미리보기는 앱이 줄여서 data URL로 준다.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  contentUrl,
  contentUrlReady,
  deleteCharacter,
  getCharacter,
  getProject,
  getTool,
  gw,
  listCharacters,
  listLibrary,
  listModels,
  listStyles,
  outputUrl,
  quote,
  saveCharacter,
  useGateway,
  type Job,
  type Output,
  type QuoteRequest
} from './gateway'

/** 도구 안에서 쓰는 window.studio — 부탁을 보내고 답을 기다리는 얇은 다리 */
const BRIDGE = `<script>
(() => {
  let seq = 0
  const wait = new Map()
  const listeners = new Set()
  addEventListener('message', (e) => {
    const m = e.data
    if (!m || m.__studio !== 1 || e.source !== parent) return
    if (m.event) { for (const f of listeners) try { f(m.event, m.data) } catch (err) { console.error(err) } return }
    const w = wait.get(m.id); if (!w) return
    wait.delete(m.id)
    m.error ? w.reject(new Error(m.error)) : w.resolve(m.result)
  })
  const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq
    wait.set(id, { resolve, reject })
    parent.postMessage({ __studio: 1, id, method, args }, '*')
  })
  window.studio = {
    styles: () => call('styles'),
    /** 이 도구가 열린 아트 프로젝트(이름 · 폴더 · 설정 — 비율 · 모델 · 영상 설정 등) */
    project: () => call('project'),
    models: () => call('models'),
    characters: {
      list: () => call('characters.list'),
      get: (id) => call('characters.get', id),
      save: (id, doc) => call('characters.save', id, doc),
      remove: (id) => call('characters.delete', id)
    },
    /** 견적(승인 대기 작업)을 만든다 — 승인 카드에서 승인해야 실행된다. 작업을 돌려준다 */
    generate: (req) => call('generate', req),
    job: (id) => call('job', id),
    /** 이미지 결과의 작은 미리보기(data URL) */
    thumb: (outputId, size) => call('thumb', outputId, size || 320),
    /** 앱 라이브러리에서 이미지 하나 고르기 — { outputId } 또는 null */
    pickImage: () => call('pickImage'),
    /** 결과 파일을 탐색기에서 보기 */
    reveal: (outputId) => call('reveal', outputId),
    /** 작업 상태가 바뀔 때 — (event: 'job', job) */
    on: (f) => (listeners.add(f), () => listeners.delete(f))
  }
})()
</script>`

function withBridge(html: string): string {
  const at = html.search(/<head[^>]*>/i)
  if (at < 0) return BRIDGE + html
  const end = html.indexOf('>', at) + 1
  return html.slice(0, end) + BRIDGE + html.slice(end)
}

/** 결과 이미지를 줄여 data URL로 — 도구는 게이트웨이 주소(토큰)를 모른다 */
async function thumbOf(outputId: string, size: number): Promise<string | null> {
  const src = await contentUrlReady(outputId)
  if (!src) throw new Error('생성 게이트웨이에 연결되지 않았어요')
  // 캐시를 쓰지 않는다(예전 응답이 형식 헤더 없이 남아 있을 수 있다). 디코딩은 img 요소로 — 형식 헤더가 없어도 내용으로 판별한다
  const blob = await fetch(src, { cache: 'no-store' }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
  if (blob.type && !blob.type.startsWith('image/')) return null
  const url = URL.createObjectURL(blob)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    const k = Math.min(1, size / Math.max(img.naturalWidth, img.naturalHeight))
    const c = document.createElement('canvas')
    c.width = Math.round(img.naturalWidth * k)
    c.height = Math.round(img.naturalHeight * k)
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
    return c.toDataURL('image/jpeg', 0.86)
  } finally {
    URL.revokeObjectURL(url)
  }
}

type Picker = { resolve: (v: { outputId: string } | null) => void } | null

function ImagePicker({ projectId, onPick }: { projectId: string; onPick: (id: string | null) => void }): ReactElement {
  const [items, setItems] = useState<{ id: string; title: string }[] | null>(null)
  useEffect(() => {
    listLibrary(300, projectId)
      .then((l) => setItems(l.filter((x) => x.output.kind === 'image').map((x) => ({ id: x.output.id, title: x.job.origin?.title || x.job.prompt || x.job.model }))))
      .catch(() => setItems([]))
  }, [])
  return (
    <div className="st-tool-pick" role="dialog" aria-label="이미지 고르기">
      <div className="st-gen-h">
        <span>라이브러리에서 이미지 고르기</span>
        <button type="button" className="st-ghost" onClick={() => onPick(null)}>
          취소
        </button>
      </div>
      {items == null ? (
        <div className="st-usage-note">불러오는 중…</div>
      ) : items.length === 0 ? (
        <div className="st-usage-note">이미지 결과가 없어요.</div>
      ) : (
        <div className="st-tool-pick-grid">
          {items.map((x) => (
            <button key={x.id} type="button" onClick={() => onPick(x.id)} title={x.title} aria-label={x.title}>
              <img src={contentUrl(x.id) ?? ''} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function ToolHost({ toolId, projectId, onClose }: { toolId: string; projectId: string; onClose: () => void }): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null)
  const [doc, setDoc] = useState<{ name: string; html: string } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [picker, setPicker] = useState<Picker>(null)
  const mine = useRef(new Set<string>()) // 이 도구가 만든 작업
  const g = useGateway()

  useEffect(() => {
    getTool(toolId)
      .then((t) => setDoc({ name: t.name, html: withBridge(t.html) }))
      .catch((e: Error) => setErr(e.message))
  }, [toolId])

  const post = useCallback((m: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ __studio: 1, ...m }, '*'), [])

  // 이 도구의 작업 상태 → 도구에 알림
  const snapshot = useMemo(
    () =>
      [...mine.current]
        .map((id) => g.jobs[id])
        .filter(Boolean)
        .map((j) => `${j.id}:${j.state}:${(g.outputs[j.id] ?? []).length}`)
        .join('|'),
    [g.jobs, g.outputs]
  )
  useEffect(() => {
    for (const id of mine.current) {
      const j = g.jobs[id]
      if (j) post({ event: 'job', data: { ...j, outputs: (g.outputs[id] ?? []).map((o) => ({ id: o.id, kind: o.kind })) } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot])

  useEffect(() => {
    const handle = async (method: string, args: unknown[]): Promise<unknown> => {
      switch (method) {
        case 'styles':
          return listStyles()
        case 'models':
          return listModels()
        case 'project':
          return getProject(projectId)
        case 'characters.list':
          return listCharacters(projectId)
        case 'characters.get':
          return getCharacter(projectId, String(args[0]))
        case 'characters.save':
          return saveCharacter(projectId, String(args[0]), (args[1] ?? {}) as Record<string, unknown>)
        case 'characters.delete':
          return deleteCharacter(projectId, String(args[0]))
        case 'generate': {
          // 도구의 요청은 늘 이 프로젝트로 — 아트 디렉션은 게이트웨이가 붙인다
          const req = (args[0] ?? {}) as QuoteRequest
          const j = await quote({ ...req, project: projectId, origin: { ...(req.origin ?? {}), space: 'art', source: 'tool', tool: toolId } })
          mine.current.add(j.id)
          return j
        }
        case 'job': {
          // 창을 닫아 둔 사이 끝난 작업도 결과까지 받도록 게이트웨이에 직접 묻는다
          const id = String(args[0])
          mine.current.add(id)
          const r = await gw<{ job: Job; outputs: Output[] }>(`/jobs/${encodeURIComponent(id)}`).catch(() => null)
          return r ? { ...r.job, outputs: r.outputs.map((o) => ({ id: o.id, kind: o.kind })) } : null
        }
        case 'thumb':
          return thumbOf(String(args[0]), Math.max(64, Math.min(1024, Number(args[1]) || 320)))
        case 'pickImage':
          return new Promise((resolve) => setPicker({ resolve }))
        case 'reveal': {
          const r = await outputUrl(String(args[0]))
          if (!r.localPath) return false
          const i = Math.max(r.localPath.lastIndexOf('\\'), r.localPath.lastIndexOf('/'))
          await window.api.revealPath(r.localPath.slice(0, i), r.localPath.slice(i + 1))
          return true
        }
        default:
          throw new Error(`모르는 요청: ${method}`)
      }
    }
    const onMsg = (e: MessageEvent): void => {
      const m = e.data as { __studio?: number; id?: number; method?: string; args?: unknown[] } | null
      // 이 창의 도구가 보낸 부탁만 받는다
      if (!m || m.__studio !== 1 || typeof m.id !== 'number' || e.source !== frame.current?.contentWindow) return
      handle(String(m.method), Array.isArray(m.args) ? m.args : [])
        .then((result) => post({ id: m.id, result }))
        .catch((er: Error) => post({ id: m.id, error: er.message || String(er) }))
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [toolId, projectId, post, g.jobs, g.outputs])

  return (
    <div className="st-veil st-tool-veil">
      <div className="st-tool" role="dialog" aria-modal="true" aria-label={doc?.name ?? '도구'}>
        <div className="st-tool-bar">
          <span>{doc?.name ?? '도구를 여는 중…'}</span>
          <button type="button" className="st-ghost" onClick={onClose} aria-label="도구 닫기">
            ×
          </button>
        </div>
        {err ? (
          <div className="st-gen-warn">도구를 열지 못했어요 — {err}</div>
        ) : doc ? (
          // allow-same-origin을 주지 않는다 — 도구는 별도 출처라 앱 저장소 · 게이트웨이 토큰에 닿지 못한다
          <iframe ref={frame} title={doc.name} className="st-tool-frame" sandbox="allow-scripts allow-downloads allow-modals allow-forms" srcDoc={doc.html} />
        ) : null}
        {picker && (
          <ImagePicker
            projectId={projectId}
            onPick={(id) => {
              picker.resolve(id ? { outputId: id } : null)
              setPicker(null)
            }}
          />
        )}
      </div>
    </div>
  )
}
