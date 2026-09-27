// AgentStudio 셸 — 홈 런처와 작업 공간을 오간다.
//
// 채팅 공간은 원본 App(대화 목록 · 엔진 · 모델 선택 · 컨텍스트 · 한도)을 그대로 쓰고,
// 그 위에 Studio 바와 Aero 테마만 얹는다. App은 처음 채팅에 들어갈 때 마운트되고,
// 이후 홈으로 돌아가도 **내리지 않는다**(숨김) — 도는 대화와 엔진 연결을 끊지 않기 위해서다.
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import App from '../App'
import { getPref, setPref } from '../lib/prefs'
import { SIDEBAR_AUTOHIDE } from '../lib/sidebarAutohide'
import { ApprovalCenter } from './ApprovalCenter'
import { ArtSpace } from './ArtSpace'
import { SettingsSpace } from './SettingsSpace'
import { Launcher } from './Launcher'
import { SPACES, SpaceIcon, type SpaceId } from './spaces'
import { UsageButton, UsagePanel, useStudioUsage } from './usage'
import './studio.css'

type Space = 'home' | SpaceId

const SPACE_PREF = 'studio.space'
const FONT_HREF = 'https://fonts.googleapis.com/css2?family=Gowun+Dodum&family=Varela+Round&display=swap'

function useStudioChrome(): void {
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('studio-theme')
    if (!document.querySelector(`link[href="${FONT_HREF}"]`)) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = FONT_HREF
      document.head.appendChild(link)
    }
    return () => root.classList.remove('studio-theme')
  }, [])
}

// Studio 기본값 — 사용자가 설정에서 한 번이라도 고른 값이 있으면 건드리지 않는다.
// 채팅 공간은 대화 목록이 늘 보이는 쪽이 기본이다(원본 기본은 자동 숨김).
function applyStudioDefaults(): void {
  if (getPref<boolean | null>(SIDEBAR_AUTOHIDE, null) === null) setPref(SIDEBAR_AUTOHIDE, false)
}

function initialSpace(): Space {
  applyStudioDefaults()
  const saved = getPref<string>(SPACE_PREF, 'home')
  return SPACES.some((s) => s.id === saved && s.ready) ? (saved as SpaceId) : 'home'
}

function StudioBar({ space, onHome }: { space: SpaceId; onHome: () => void }): ReactElement {
  const usage = useStudioUsage()
  const [open, setOpen] = useState(false)
  const def = SPACES.find((s) => s.id === space)!
  const close = useCallback(() => setOpen(false), [])
  return (
    <>
      <div className="studio-bar">
        <div className="studio-bar-left">
          <button type="button" className="st-orb" aria-label="홈으로" onClick={onHome} style={{ width: 38, height: 38 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3.5 11 12 4l8.5 7" />
              <path d="M6 9.5V20h12V9.5" />
            </svg>
          </button>
          <span style={{ display: 'grid', placeItems: 'center', width: 22, height: 22 }}>
            <SpaceIcon id={space} size={22} />
          </span>
          <span className="studio-bar-title">{def.title}</span>
          <span className="studio-bar-sub">{def.en.toUpperCase()}</span>
        </div>
        <div className="studio-bar-right">
          <UsageButton usage={usage} open={open} onToggle={() => setOpen((o) => !o)} />
        </div>
      </div>
      {open && <UsagePanel usage={usage} onClose={close} onRefresh={() => usage.refresh(true)} />}
    </>
  )
}

export function StudioRoot(): ReactElement {
  useStudioChrome()
  const [space, setSpace] = useState<Space>(initialSpace)
  // 채팅에 한 번이라도 들어간 뒤로는 App을 계속 살려 둔다
  const [appMounted, setAppMounted] = useState(space === 'chat')

  // 공간별 팔레트 — studio.css의 html.studio-theme[data-space="…"]. 포털로 body에 붙는 팝오버도 같은 색을 받는다.
  useEffect(() => {
    document.documentElement.dataset.space = space
  }, [space])

  // 아트 어시스턴트가 원본 채팅을 빌려 쓸 때 — App을 (아직 안 떴다면) 띄운다
  const ensureApp = useCallback(() => setAppMounted(true), [])

  const go = (next: Space): void => {
    setSpace(next)
    setPref(SPACE_PREF, next)
    if (next === 'chat') setAppMounted(true)
  }

  return (
    <div className="studio" data-space={space}>
      {space !== 'home' && <StudioBar space={space} onHome={() => go('home')} />}
      {appMounted && (
        <div className="studio-app">
          <App />
        </div>
      )}
      {space === 'art' && <ArtSpace ensureApp={ensureApp} />}
      {space === 'settings' && <SettingsSpace />}
      {space === 'home' && <Launcher onStart={(id) => go(id)} />}
      <ApprovalCenter />
    </div>
  )
}
