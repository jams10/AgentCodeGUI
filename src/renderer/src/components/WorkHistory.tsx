import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { GenerationRecord, WorkPathInfo } from '@shared/protocol'
import { t, useLang } from '../lib/i18n'
import { IconFolder, IconX2 as IconX } from './icons'

const format = (n: number | null): string => n == null ? t('미제공', 'Not reported') : n.toLocaleString(undefined, { maximumFractionDigits: 4 })
const statusText = (s: GenerationRecord['status']): string => ({ running: t('호출 중', 'Calling'), submitted: t('접수됨', 'Submitted'), completed: t('완료', 'Completed'), error: t('실패', 'Failed'), unknown: t('결과 확인 필요', 'Result unconfirmed') })[s]
const looksLocal = (s: string): boolean => !/^(?:https?:|mailto:|#)/i.test(s) && /^(?:[A-Za-z]:[\\/]|\/(?!\/)|\.\.?[\\/]|file:)|[\\/]/.test(s) && !/[\n\r]/.test(s)

/** Only existing local paths become buttons; code and URLs remain ordinary text. */
export function LocalWorkPath({ value, cwd, children, onOpenFile }: { value: string; cwd: string; children: ReactNode; onOpenFile?: (p: string) => void }): React.ReactElement {
  const [info, setInfo] = useState<WorkPathInfo | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setInfo(null)
    if (looksLocal(value)) void window.api.work?.inspectPaths(cwd, [value]).then(rows => { if (alive) setInfo(rows[0] ?? null) }).catch(() => {})
    return () => { alive = false }
  }, [value, cwd])
  if (!info) return <>{children}</>
  const openFolder = (): void => {
    setError('')
    void window.api.work.openFolder(cwd, info.folder).catch(() => setError(t('폴더를 열지 못했어요.', 'Could not open the folder.')))
  }
  return <span className="work-path" title={error || info.path}>
    <button type="button" className="work-path-link" onClick={info.kind === 'file' && onOpenFile ? () => onOpenFile(info.path) : openFolder}
      aria-label={info.kind === 'directory' ? t(`${info.path} 파일 탐색기로 열기`, `Open ${info.path} in file manager`) : info.path}>{children}</button>
    {info.kind === 'file' && <button type="button" className="work-path-folder" onClick={openFolder} aria-label={t('포함된 폴더 열기', 'Open containing folder')}><IconFolder size={12} /></button>}
    {error && <span role="status" className="wh-error">{error}</span>}
  </span>
}

export function WorkHistory({ records = [], folders = [], cwd = '', files = [] }: { records?: GenerationRecord[]; folders?: string[]; cwd?: string; files?: { path: string }[] }): React.ReactElement {
  useLang()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [paths, setPaths] = useState<string[]>([])
  const [pathError, setPathError] = useState('')
  const [loading, setLoading] = useState(false)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const candidates = useMemo(() => [...new Set([cwd, ...folders, ...files.map(f => f.path), ...records.flatMap(r => r.outputs.filter(looksLocal))].filter(Boolean))], [cwd, folders, files, records])
  const candidatesKey = JSON.stringify(candidates)
  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true); setPathError('')
    const all = JSON.parse(candidatesKey) as string[]
    const batches: string[][] = []
    for (let i = 0; i < all.length; i += 200) batches.push(all.slice(i, i + 200))
    void (async () => {
      const found: string[] = []
      for (const batch of batches) {
        const rows = await window.api.work.inspectPaths(cwd, batch)
        found.push(...rows.map(p => p.folder))
      }
      if (alive) setPaths([...new Set(found)])
    })().catch(() => { if (alive) setPathError(t('폴더 목록을 읽지 못했어요. 앱을 다시 실행해 주세요.', 'Could not read folders. Restart the app.')) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, candidatesKey, cwd])
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
      if (e.key === 'Tab') {
        const nodes = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, summary, a[href]')
        if (!nodes?.length) return
        const first = nodes[0], last = nodes[nodes.length - 1]
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', key, true)
    return () => { document.removeEventListener('keydown', key, true); (trigger.current ?? (previous?.isConnected ? previous : null))?.focus() }
  }, [open])
  const needle = query.trim().toLocaleLowerCase()
  const shownRecords = records.filter(r => !needle || [r.service, r.model, r.prompt, ...r.jobIds].join(' ').toLocaleLowerCase().includes(needle)).slice().reverse()
  const shownFolders = paths.filter(p => !needle || p.toLocaleLowerCase().includes(needle))
  const exportRecords = (): void => {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), cwd, folders: paths, generations: records }, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `work-records-${new Date().toISOString().slice(0, 10)}.json`; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return <>
    <button ref={trigger} type="button" className="work-history-toggle" onClick={() => setOpen(true)} aria-haspopup="dialog">
      <IconFolder size={13} /><span>{t('작업 기록', 'Work history')}</span><span className="wh-count">{t(`생성 ${records.length}건`, `${records.length} generations`)}</span>
    </button>
    {open && createPortal(<div className="wh-shade" onMouseDown={e => { if (e.target === e.currentTarget) setOpen(false) }}>
      <div ref={panel} className="wh-panel" role="dialog" aria-modal="true" aria-label={t('작업 기록', 'Work history')} tabIndex={-1}>
        <div className="wh-head"><div><strong>{t('작업 기록', 'Work history')}</strong><p>{t('이 대화의 작업 폴더와 생성형 AI 사용 내역', 'Folders and generative AI activity in this conversation')}</p></div>
          <button type="button" onClick={exportRecords}>{t('JSON 저장', 'Export JSON')}</button><button type="button" onClick={() => setOpen(false)} aria-label={t('닫기', 'Close')}><IconX size={16} /></button></div>
        <input className="wh-search" value={query} onChange={e => setQuery(e.target.value)} placeholder={t('폴더, 서비스, 모델, 프롬프트 검색', 'Search folders, services, models or prompts')} aria-label={t('작업 기록 검색', 'Search work history')} />
        <div className="wh-body">
          <h3>{t('작업 폴더', 'Work folders')} <span>{paths.length}</span></h3>
          {loading && <p className="wh-note">{t('폴더 확인 중…', 'Checking folders…')}</p>}
          {pathError && <p className="wh-error" role="status">{pathError}</p>}
          {!loading && !shownFolders.length && <p className="wh-note">{t('표시할 폴더가 없습니다.', 'No folders to show.')}</p>}
          {shownFolders.map(folder => <button key={folder} type="button" className="wh-folder" title={t('Windows 파일 탐색기로 열기', 'Open in file manager')}
            onClick={() => { setPathError(''); void window.api.work.openFolder(cwd, folder).catch(() => setPathError(t('폴더가 이동되었거나 삭제되어 열지 못했어요.', 'Could not open the folder. It may have moved or been deleted.'))) }}>
            <IconFolder size={15} /><span>{folder}</span><small>{t('폴더 열기', 'Open folder')}</small></button>)}
          <h3>{t('생성형 AI 사용 내역', 'Generative AI activity')} <span>{records.length}</span></h3>
          <p className="wh-note">{t('서비스가 보고한 사용량만 표시합니다. 잔액은 계정 전체 기준이며, 기록은 이 대화와 함께 저장됩니다.', 'Only service-reported usage is shown. Balances cover the entire account; records are saved with this conversation.')}</p>
          {!shownRecords.length && <p className="wh-empty">{t('기록된 생성 작업이 없습니다.', 'No recorded generations.')}</p>}
          {shownRecords.map(r => <details key={r.id} className="wh-record">
            <summary><div className="wh-record-title"><b>{r.service}</b><span>{r.model || r.tool}</span><small className={r.status === 'error' ? 'wh-error' : ''}>{statusText(r.status)}</small></div>
              <div className="wh-record-meta"><time>{new Date(r.startedAt).toLocaleString()}</time><span>{t('크레딧', 'Credits')} {format(r.usage.credits)} · {t('토큰', 'Tokens')} {format(r.usage.tokens)}</span></div>
              {r.prompt && <p className="wh-prompt-preview">{r.prompt}</p>}</summary>
            <div className="wh-record-body"><div className="wh-detail-head"><b>{t('프롬프트', 'Prompt')}</b>{r.prompt && <button type="button" onClick={() => void navigator.clipboard.writeText(r.prompt!).catch(() => setPathError(t('복사하지 못했어요.', 'Could not copy.')))}>{t('복사', 'Copy')}</button>}</div>
              <pre>{r.prompt || t('별도 프롬프트 필드가 없습니다. 아래 실행 설정에서 워크플로·입력을 확인하세요.', 'No separate prompt field. See the workflow and inputs in the execution parameters below.')}</pre>
              <dl className="wh-facts"><dt>{t('입력 / 출력 토큰', 'Input / output tokens')}</dt><dd>{format(r.usage.inputTokens)} / {format(r.usage.outputTokens)}</dd><dt>{t('비용 (USD)', 'Cost (USD)')}</dt><dd>{format(r.usage.usd)}</dd><dt>{t('호출 소요', 'Call duration')}</dt><dd>{r.durationMs == null ? t('미제공', 'Not reported') : `${(r.durationMs / 1000).toFixed(1)}s`}</dd><dt>{t('작업 ID', 'Job ID')}</dt><dd>{r.jobIds.join(', ') || t('미제공', 'Not reported')}</dd></dl>
              {!!r.outputs.length && <div className="wh-outputs"><b>{t('결과물', 'Outputs')}</b>{r.outputs.map(output => /^https?:\/\//i.test(output)
                ? <a key={output} href={output} target="_blank" rel="noreferrer">{output}</a>
                : <LocalWorkPath key={output} value={output} cwd={cwd}>{output}</LocalWorkPath>)}</div>}
              <details className="wh-parameters"><summary>{t('실행 설정', 'Execution parameters')}{r.truncated ? t(' · 일부 생략', ' · truncated') : ''}</summary><pre>{r.parameters}</pre></details>
            </div></details>)}
        </div>
      </div>
    </div>, document.body)}
  </>
}
