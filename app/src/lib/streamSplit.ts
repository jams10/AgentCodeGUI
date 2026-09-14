/* ============================================================
 * ★3.3 스트리밍 공개 중 마크다운 머리/꼬리 분할점 — 순수 규칙 (Chat.tsx StreamingMarkdown이 쓴다)
 *
 * 공개 커밋마다 지금까지 보인 글 전체를 다시 파싱·조정하면 비용이 글 길이에 비례해 커진다.
 * 앞부분은 이미 굳은 문단이라 다시 파싱할 이유가 없다 — 굳은 앞부분(머리)과 자라는 뒷부분
 * (꼬리)을 따로 그리면 매 커밋 파싱되는 건 짧은 꼬리뿐이다.
 *
 * 분할점 = 블록 경계(빈 줄 `\n\n`) 중 꼬리 최소 길이 밖에 있는 **마지막** 것. 단
 *   · 열린 코드 펜스 안은 안 된다(머리의 ``` / ~~~ 줄 수가 짝수여야 그 지점이 펜스 밖)
 *   · 목록 항목 사이는 안 된다(두 목록으로 갈라지면 여백이 달라 보인다)
 *   · 머리는 뒤로만 는다(안정성 — 이미 굳은 DOM은 그대로). 글이 줄면(교체) 처음부터.
 * 경계를 못 찾으면 머리 0 = 통째로 꼬리(= 분할 전과 같다).
 * ============================================================ */

export interface StreamHead {
  len: number // 머리 길이(문자) — 0이면 분할 없음
  fences: number // 머리 안의 펜스 줄(``` / ~~~) 수 — 다음 탐색이 여기서부터 이어 센다
}

export const STREAM_TAIL_MIN = 800 // 꼬리 최소 길이 — 경계 직후 문단은 아직 자라는 중이라 조금 뒤에서 자른다
const FENCE_RE = /^ {0,3}(```|~~~)/
const LIST_RE = /^\s{0,3}([-*+]|\d{1,9}[.)])\s/

export const EMPTY_HEAD: StreamHead = { len: 0, fences: 0 }

/** `text[from, to)` 구간의 펜스 줄 수 (줄 머리 기준 — `from`은 줄 시작이어야 한다). */
export function fenceLines(text: string, from: number, to: number): number {
  let n = 0
  let i = from
  while (i < to) {
    const nl = text.indexOf('\n', i)
    const end = nl < 0 || nl > to ? to : nl
    if (FENCE_RE.test(text.slice(i, Math.min(end, i + 8)))) n++
    if (nl < 0) break
    i = nl + 1
  }
  return n
}

function lineAt(text: string, i: number): string {
  const s = text.lastIndexOf('\n', i - 1) + 1
  const e = text.indexOf('\n', i)
  return text.slice(s, e < 0 ? text.length : e)
}

/** 지금 글에 맞는 머리 — `prev`에서 뒤로만 늘린다. 같은 입력엔 같은 답(멱등). */
export function advanceStreamHead(text: string, prev: StreamHead, tailMin = STREAM_TAIL_MIN): StreamHead {
  let cur = text.length < prev.len ? EMPTY_HEAD : prev
  const limit = text.length - tailMin
  if (limit <= cur.len) return cur
  let idx = text.lastIndexOf('\n\n', limit)
  while (idx >= cur.len) {
    const cut = idx + 2
    const fences = cur.fences + fenceLines(text, cur.len, cut)
    if (fences % 2 === 0 && !(LIST_RE.test(lineAt(text, idx)) && LIST_RE.test(lineAt(text, cut)))) {
      cur = { len: cut, fences }
      break
    }
    if (idx === 0) break
    idx = text.lastIndexOf('\n\n', idx - 1)
  }
  return cur
}
