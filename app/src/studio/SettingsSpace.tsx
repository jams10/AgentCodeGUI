// 설정 공간 — 원본 설정 창(SettingsModal)을 그대로 공간 본문으로 쓴다. 원본이 설정을 늘리거나 바꾸면 자동으로 따라간다.
// Studio에 맞춘 부분(빼는 항목 · API 탭의 생성 서비스 키)은 settingsExt.tsx에 있다.
// 띄우는 창(오버레이) 모양은 studio.css에서 풀고, 닫기는 없다(홈 버튼으로 나간다).
import { useEffect, useRef, type ReactElement } from 'react'
import { SettingsModal, type SettingsView } from '../components/Settings'

const noop = (): void => {}

// Display의 「유리(벽지 비침)」 — Studio 테마가 배경을 칠하므로 값이 아무 효과가 없다. 제목 글자로 찾아 그 구역만 숨긴다.
// 원본이 글자를 바꾸면 아무것도 숨기지 않는다(엉뚱한 구역을 숨기지 않게).
const DEAD_SECTIONS = new Set(['유리', 'Glass'])

function hideDeadSections(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.set-inner > .set-sec').forEach((sec) => {
    if (!DEAD_SECTIONS.has(sec.textContent?.trim() ?? '') || sec.dataset.stHidden) return
    // 이 구역을 설명하는 머리글(바로 앞의 부제)과 다음 구역 제목 전까지 숨긴다
    const prev = sec.previousElementSibling as HTMLElement | null
    if (prev?.classList.contains('set-h1-sub')) prev.dataset.stHidden = '1'
    for (let el: HTMLElement | null = sec; el && (el === sec || !el.classList.contains('set-sec')); el = el.nextElementSibling as HTMLElement | null) {
      el.dataset.stHidden = '1'
    }
  })
}

// 원본 문구에 고정된 데이터 폴더 이름 — Studio 빌드는 ~/.agentstudio를 쓴다(CCG_DEFAULT_HOME_DIR). 화면 글자만 바꾼다.
const HOME_FROM = '~/.agentcodegui3'
const HOME_TO = '~/.agentstudio'

function fixHomeText(root: HTMLElement): void {
  root.querySelectorAll('.set-inner code').forEach((code) => {
    code.childNodes.forEach((n) => {
      // 텍스트 노드 값만 고친다(노드를 바꾸지 않아 React가 쥔 노드와 어긋나지 않는다)
      if (n.nodeType === Node.TEXT_NODE && n.nodeValue?.includes(HOME_FROM)) n.nodeValue = n.nodeValue.split(HOME_FROM).join(HOME_TO)
    })
  })
}

/** open — 채팅 등에서 특정 탭을 지정해 들어왔을 때(예: API 과금 가드 → 'api'). n이 바뀌면 그 탭으로 다시 연다. */
export function SettingsSpace({ open }: { open: { view?: SettingsView; n: number } }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const fix = (): void => (hideDeadSections(root), fixHomeText(root))
    fix()
    const mo = new MutationObserver(fix)
    mo.observe(root, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [])
  return (
    <div className="st-set">
      <div className="st-set-common" ref={ref}>
        <SettingsModal key={open.n} initialView={open.view} onClose={noop} />
      </div>
    </div>
  )
}
