// Studio 홈 — PS Vita 풍 유리 버블 런처와 LiveArea 소개 카드.
import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from 'react'
import { GEN_PROVIDERS, SPACES, SpaceIcon, bubbleBg, type SpaceDef, type SpaceId } from './spaces'
import { WindowControls } from './WindowControls'

// 가장 오른쪽 버블(x 865) + 버블 칸 폭(200)
const FIELD_W = 1065
const FIELD_H = 560

// 창 크기에 맞춰 버블 필드를 줄인다(늘리지는 않는다)
function useFieldScale(): number {
  const [scale, setScale] = useState(1)
  useLayoutEffect(() => {
    const fit = (): void => setScale(Math.min(1, (window.innerWidth - 80) / FIELD_W, (window.innerHeight - 140) / FIELD_H))
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  return scale
}

function LiveArea({ space, onClose, onStart }: { space: SpaceDef; onClose: () => void; onStart: (id: SpaceId) => void }): ReactElement {
  const ctaRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    ctaRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const costRows = space.tools.filter((t) => GEN_PROVIDERS.includes(t))
  return (
    <div className="st-veil" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="st-live" role="dialog" aria-modal="true" aria-label={space.title}>
        <button type="button" className="st-peel" aria-label="홈으로 돌아가기" onClick={onClose} />
        <div className="st-live-l">
          <div className="st-bub" style={{ background: bubbleBg(space) }}>
            <SpaceIcon id={space.id} size={96} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div className="st-live-title">{space.title}</div>
            <div className="st-sub" style={{ marginTop: 0 }}>
              {space.en}
            </div>
          </div>
          <div className="st-live-desc">{space.desc}</div>
          <button ref={ctaRef} type="button" className="st-gloss st-live-cta" disabled={!space.ready} onClick={() => onStart(space.id)}>
            {space.ready ? space.cta : '준비 중'}
          </button>
          <button type="button" className="st-ghost" onClick={onClose} style={{ fontSize: 15 }}>
            ← 홈으로
          </button>
        </div>
        <div className="st-live-r">
          <section className="st-card">
            <h3>이 공간에서 하는 일</h3>
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {space.does.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </section>
          <section className="st-card">
            <h3>연결된 도구</h3>
            {space.tools.length ? (
              <div className="st-chips">
                {space.tools.map((t) => (
                  <span key={t} className="st-pill">
                    {t}
                  </span>
                ))}
              </div>
            ) : (
              <div className="st-usage-note">계정과 서비스 연결을 여기서 관리해요.</div>
            )}
          </section>
          <section className="st-card">
            <h3>최근 작업</h3>
            <div className="st-empty">아직 작업이 없어요</div>
          </section>
          <section className="st-card">
            <h3>이번 달 생성 비용</h3>
            {costRows.length ? (
              costRows.map((p) => (
                <div key={p} className="st-credit">
                  <span>{p}</span>
                  <span className="st-dim">연결 전</span>
                </div>
              ))
            ) : (
              <div className="st-usage-note">이 공간은 외부 생성 서비스를 쓰지 않아요.</div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

export function Launcher({ onStart }: { onStart: (id: SpaceId) => void }): ReactElement {
  const [open, setOpen] = useState<SpaceId | null>(null)
  const scale = useFieldScale()
  const space = open ? SPACES.find((s) => s.id === open) ?? null : null
  return (
    <div className="st-home motion">
      <div className="studio-bokeh a" />
      <div className="studio-bokeh b" />
      <svg className="st-ribbon" viewBox="0 0 1440 360" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="st-rib" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset=".45" stopColor="#fff" stopOpacity=".55" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M-40 220 C 260 100, 520 320, 820 200 S 1300 80, 1500 160" fill="none" stroke="url(#st-rib)" strokeWidth="3" />
        <path d="M-40 260 C 300 160, 560 360, 860 240 S 1320 140, 1500 210" fill="none" stroke="url(#st-rib)" strokeWidth="1.5" />
        <path d="M-40 300 C 340 220, 600 390, 900 290 S 1340 200, 1500 260" fill="none" stroke="url(#st-rib)" strokeWidth="1" />
      </svg>

      <div className="st-home-top">
        <div className="st-brand">
          <i />
          AgentStudio
        </div>
        <WindowControls />
      </div>

      <div className="st-field" style={{ ['--st-scale' as string]: scale }}>
        {SPACES.map((s, i) => (
          <div key={s.id} className="st-float" style={{ left: s.x, top: s.y, animationDelay: `${-i * 1.1}s` }}>
            <button type="button" className="st-bub" aria-label={`${s.title} 열기`} style={{ background: bubbleBg(s) }} onClick={() => (s.id === 'settings' ? onStart(s.id) : setOpen(s.id))}>
              <SpaceIcon id={s.id} />
            </button>
            <div className="st-lbl">{s.title}</div>
            <div className="st-sub">{s.en}</div>
          </div>
        ))}
      </div>

      {space && (
        <LiveArea
          space={space}
          onClose={() => setOpen(null)}
          onStart={(id) => {
            setOpen(null)
            onStart(id)
          }}
        />
      )}
    </div>
  )
}
