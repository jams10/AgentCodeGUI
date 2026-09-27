// 최소화 · 최대화 · 닫기 — 원본 창 API(window.api.win)를 그대로 쓴다.
import type { ReactElement } from 'react'

export function WindowControls(): ReactElement {
  const win = window.api.win
  return (
    <div className="st-winctl st-nodrag">
      <button type="button" aria-label="최소화" onClick={() => void win.minimize()}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 6h8" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      <button type="button" aria-label="최대화" onClick={() => void win.toggleMaximize()}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
      <button type="button" className="close" aria-label="닫기" onClick={() => void win.close()}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m2.5 2.5 7 7m0-7-7 7" stroke="currentColor" strokeWidth="1.4" />
        </svg>
      </button>
    </div>
  )
}
