// Studio 작업 공간 정의 — 런처 버블·LiveArea 카드가 이 표 하나를 읽는다.
// ready=false인 공간은 LiveArea까지만 열리고 시작 버튼이 「준비 중」으로 잠긴다.
import type { ReactElement } from 'react'

export type SpaceId = 'chat' | 'game' | 'art' | 'research' | 'library' | 'settings'

export interface SpaceDef {
  id: SpaceId
  title: string
  en: string
  cta: string
  desc: string
  does: string[]
  tools: string[]
  // 버블 유리 색 — 밝은 중심 → 본색 → 어두운 테두리
  light: string
  tint: string
  dark: string
  ready: boolean
  // 런처 필드(1000×560) 안의 자리
  x: number
  y: number
}

// 생성 비용이 드는 외부 서비스 — LiveArea 비용 카드에 나온다
export const GEN_PROVIDERS = ['ComfyCloud', 'Higgsfield', 'Tripo']

export const SPACES: SpaceDef[] = [
  {
    id: 'chat', title: '채팅', en: 'Chat', cta: '대화 시작',
    desc: '도구 없이 가볍게 묻고 답하는 일반 대화 공간이에요.',
    does: ['빠른 질문과 아이디어 정리', '대화 기록 보관과 검색', 'Claude · GPT 모델을 골라 쓰기'],
    tools: ['Claude', 'Codex'],
    light: '#6fd6ff', tint: '#1c8fd8', dark: '#0b5ea8', ready: true, x: 90, y: 20
  },
  {
    id: 'game', title: '게임 제작', en: 'Game', cta: '프로젝트 열기',
    desc: '언리얼 · 유니티 프로젝트를 열고 코드와 에셋을 함께 다뤄요.',
    does: ['프로젝트 폴더 · 코드 · Git', 'Verse · C++ · C# 코드 인텔리전스', '3D · 이미지 에셋을 생성해 바로 가져오기'],
    tools: ['Claude Code', 'Unreal Engine', 'Tripo'],
    light: '#ffcf7a', tint: '#f28a2e', dark: '#c2531a', ready: false, x: 400, y: 0
  },
  {
    id: 'art', title: '아트', en: 'Art', cta: '작업 시작',
    desc: '레퍼런스를 모으고 컨셉을 잡아 이미지 · 영상 · 3D로 만들어요.',
    does: ['레퍼런스 리서치와 무드보드', '프롬프트 작성과 반복 생성', '결과는 클라우드에 보관하고 썸네일로 탐색'],
    tools: ['ComfyCloud', 'Higgsfield', 'Tripo'],
    light: '#ff9fe3', tint: '#e04fb7', dark: '#9c1f7c', ready: true, x: 710, y: 20
  },
  {
    id: 'research', title: '리서치', en: 'Research', cta: '조사 시작',
    desc: '웹과 문서를 조사해 출처가 달린 정리 문서로 남겨요.',
    does: ['웹 검색과 문서 읽기', '출처 달린 요약과 비교표', '결과를 다른 작업 공간에 공유'],
    tools: ['웹 검색', '문서'],
    light: '#a6f09a', tint: '#45b84f', dark: '#1f7a33', ready: false, x: 245, y: 310
  },
  {
    id: 'library', title: '생성 라이브러리', en: 'Library', cta: '라이브러리 열기',
    desc: '모든 외부 생성 결과와 프롬프트, 비용을 한곳에서 봐요.',
    does: ['서비스별 · 작업 공간별 비용', '썸네일 갤러리 · 스트리밍 · 다운로드', '프롬프트 기록과 재사용'],
    tools: ['ComfyCloud', 'Higgsfield', 'Tripo'],
    light: '#c7b4ff', tint: '#7b5cf0', dark: '#4527a8', ready: false, x: 555, y: 290
  },
  {
    id: 'settings', title: '설정', en: 'Settings', cta: '연결 관리',
    desc: '외부 생성 서비스의 API 키를 넣고 연결을 확인해요.',
    does: ['ComfyCloud · Higgsfield · Tripo API 키', '키 연결 확인 · 잔액 · 30일 사용액', '키는 이 PC에서 암호화해 보관'],
    tools: [],
    light: '#f2f7fb', tint: '#a9bccd', dark: '#5f7489', ready: true, x: 865, y: 310
  }
]

export function bubbleBg(s: SpaceDef): string {
  return `radial-gradient(circle at 50% 72%, ${s.light} 0%, ${s.tint} 55%, ${s.dark} 100%)`
}

const stroke = { fill: 'none', stroke: '#fff', strokeWidth: 2.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

export function SpaceIcon({ id, size = 72 }: { id: SpaceId; size?: number }): ReactElement {
  const p = { width: size, height: size, viewBox: '0 0 48 48', 'aria-hidden': true, ...stroke }
  switch (id) {
    case 'chat':
      return (
        <svg {...p}>
          <path d="M9 11h30a4 4 0 0 1 4 4v15a4 4 0 0 1-4 4H23l-8 7v-7H9a4 4 0 0 1-4-4V15a4 4 0 0 1 4-4z" />
          <path d="M15 20h18M15 26h11" />
        </svg>
      )
    case 'game':
      return (
        <svg {...p}>
          <path d="M14 15h20a9 9 0 0 1 9 9v3a6.5 6.5 0 0 1-11.8 3.8L29.5 29h-11l-1.7 1.8A6.5 6.5 0 0 1 5 27v-3a9 9 0 0 1 9-9z" />
          <path d="M14 20v7M10.5 23.5h7" />
          <circle cx="31" cy="21.5" r="1.4" />
          <circle cx="35.5" cy="26" r="1.4" />
        </svg>
      )
    case 'art':
      return (
        <svg {...p}>
          <path d="M24 6a18 18 0 1 0 0 36c2.6 0 3.6-2.1 2.5-4.1-1-2 0-3.9 2.5-3.9H34a8 8 0 0 0 8-8C42 14 34 6 24 6z" />
          <circle cx="15" cy="22" r="2.4" />
          <circle cx="21.5" cy="14" r="2.4" />
          <circle cx="30.5" cy="14.5" r="2.4" />
        </svg>
      )
    case 'research':
      return (
        <svg {...p}>
          <circle cx="21" cy="21" r="12.5" />
          <path d="M30.5 30.5 41 41M15.5 18h11M15.5 24h7" />
        </svg>
      )
    case 'library':
      return (
        <svg {...p}>
          <rect x="7" y="14" width="27" height="25" rx="3.5" />
          <path d="M14 8h24.5A3.5 3.5 0 0 1 42 11.5V32M8 33l7.5-7.5 6 6 4-4 8 8" />
          <circle cx="25" cy="21" r="2.2" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...p}>
          <circle cx="24" cy="24" r="6.5" />
          <path d="M24 5v6M24 37v6M5 24h6M37 24h6M10.6 10.6l4.2 4.2M33.2 33.2l4.2 4.2M10.6 37.4l4.2-4.2M33.2 14.8l4.2-4.2" />
        </svg>
      )
  }
}
