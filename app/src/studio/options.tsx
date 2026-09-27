// 생성 옵션 입력칸 — 승인 카드에서 옵션을 고칠 때 쓴다.
// 고르기 · 켜고 끄기는 바로, 숫자 · 글자는 칸을 벗어나거나 Enter를 누를 때 반영한다(바뀔 때마다 견적을 다시 받으므로).
import { useEffect, useState, type ReactElement } from 'react'
import type { ModelOption } from './gateway'

/** 카탈로그에 없는 모델(hf/…)은 지금 값의 모양으로 입력칸을 정한다 */
export function guessOptions(params: Record<string, unknown>, hidden: Set<string>): ModelOption[] {
  return Object.entries(params)
    .filter(([k, v]) => !hidden.has(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
    .map(([k, v]) => ({ key: k, label: k, type: typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'number' : 'text' }))
}

export function OptionInput({ o, value, disabled, onCommit }: { o: ModelOption; value: unknown; disabled?: boolean; onCommit: (v: unknown) => void }): ReactElement {
  const id = `st-opt-${o.key}`
  const [text, setText] = useState(value == null ? '' : String(value))
  useEffect(() => setText(value == null ? '' : String(value)), [value])
  if (o.type === 'bool')
    return (
      <label className="st-art-check" htmlFor={id}>
        <input id={id} type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onCommit(e.target.checked)} />
        <span>{o.label}</span>
      </label>
    )
  const commitText = (): void => {
    const t = text.trim()
    const v = t === '' ? undefined : o.type === 'number' ? Number(t) : t
    if (String(v ?? '') !== String(value ?? '') && !(o.type === 'number' && t !== '' && !isFinite(Number(t)))) onCommit(v)
  }
  return (
    <label className="st-art-field" htmlFor={id}>
      <span>{o.label}</span>
      {o.type === 'enum' ? (
        <select id={id} value={String(value ?? '')} disabled={disabled} onChange={(e) => onCommit(typeof o.values?.[0] === 'number' ? Number(e.target.value) : e.target.value)}>
          {value == null && <option value="">서비스 기본값</option>}
          {(o.values ?? []).map((v) => (
            <option key={String(v)} value={String(v)}>
              {String(v)}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={o.type === 'number' ? 'number' : 'text'}
          min={o.min}
          max={o.max}
          value={text}
          disabled={disabled}
          placeholder="서비스 기본값"
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => e.key === 'Enter' && commitText()}
        />
      )}
    </label>
  )
}
