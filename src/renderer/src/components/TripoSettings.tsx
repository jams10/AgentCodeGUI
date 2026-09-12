import { useEffect, useState } from 'react'
import type { TripoStatus, TripoConnectionResult } from '@shared/protocol'
import { ServiceCredits } from './ServiceCredits'
import { t } from '../lib/i18n'

export function TripoSettings(): React.ReactElement {
  const [status, setStatus] = useState<TripoStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [check, setCheck] = useState<TripoConnectionResult | null>(null)
  const bridgeReady = !!window.api.tripo
  const refresh = async (): Promise<void> => {
    if (!bridgeReady) return
    try { setStatus(await window.api.tripo.status()) }
    catch { setError(t('Tripo 설정을 읽지 못했어요.', 'Could not load Tripo settings.')) }
  }
  useEffect(() => { void refresh() }, [])

  const register = async (saveKey: boolean): Promise<void> => {
    setBusy(true); setError(''); setMessage(''); setCheck(null)
    try {
      const next = await window.api.tripo.register(saveKey ? key : undefined)
      setStatus(next); setKey('')
      setMessage(next.keySaved
        ? t('Tripo MCP를 등록했어요. 다음 메시지부터 사용할 수 있어요.', 'Tripo MCP registered. Available from your next message.')
        : t('MCP를 등록했어요. 3D 생성 전에 API 키를 저장해 주세요.', 'MCP registered. Save an API key before generating 3D assets.'))
    } catch (e) {
      setError(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
    } finally { setBusy(false) }
  }
  const test = async (): Promise<void> => {
    setBusy(true); setError(''); setMessage(''); setCheck(null)
    try { setCheck(await window.api.tripo.check()) }
    catch { setError(t('연결 확인에 실패했어요.', 'Connection check failed.')) }
    finally { setBusy(false) }
  }

  return <>
    <div className="set-h1">Tripo</div>
    <div className="set-h1-sub">{t('텍스트·이미지로 3D 모델을 만들고 GLB·FBX로 내려받습니다. API 키를 저장하면 Claude와 Codex 대화에서 Tripo 도구를 사용할 수 있어요.', 'Create 3D models from text or images and download GLB or FBX assets. Save your API key to use Tripo tools in Claude and Codex chats.')}</div>
    {!bridgeReady && <div className="set-msg err">{t('새 Tripo 기능을 불러오려면 앱을 완전히 종료한 뒤 다시 실행해 주세요.', 'Fully quit and reopen the app to load the new Tripo integration.')}</div>}
    <div className="set-sec">{t('API 키 · 국제 사이트', 'API key · International site')}</div>
    <div className="sc2 form" data-testid="tripo-settings">
      <div className="aphead">
        <span className="apn">Tripo API</span><span className="sp" />
        <span className={'set-badge' + (status?.keySaved ? '' : ' warn')}>{status?.keySaved ? t('키 저장됨', 'Key saved') : t('키 필요', 'Key needed')}</span>
        {status?.registered && <span className={'set-badge' + (status.enabled ? '' : ' off')}>{status.enabled ? t('MCP 등록됨', 'MCP registered') : t('MCP 꺼짐', 'MCP disabled')}</span>}
      </div>
      <div className="set-field">
        <label htmlFor="tripo-api-key">TRIPO_API_KEY</label>
        <input id="tripo-api-key" className="set-input mono" type="password" autoComplete="off" spellCheck={false}
          value={key} disabled={busy || !bridgeReady} placeholder={status?.keySaved ? '••••' + status.keyTail : 'tsk_…'}
          onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && key.trim() && !busy) void register(true) }} />
        <div className="meta">{t('키는 앱의 Keys 보관함에 암호화해 저장합니다. 모델 생성 비용은 Tripo 계정에서 사용돼요.', 'Keys are encrypted in the app’s Keys vault. Model generation uses credits from your Tripo account.')}</div>
      </div>
      <div className="set-acts">
        <button className="set-chipbtn on" disabled={!status?.cliAvailable || !key.trim() || busy || status.nameConflict} onClick={() => void register(true)}>{t('키 저장 · MCP 등록', 'Save key & register MCP')}</button>
        <button className="set-chipbtn" disabled={!status?.cliAvailable || busy || status.nameConflict} onClick={() => void register(false)}>{t('MCP 등록', 'Register MCP')}</button>
        <button className="set-chipbtn" disabled={!status?.keySaved || busy || !!key.trim()} onClick={() => void test()}>{t('저장한 키 연결 확인', 'Check saved key')}</button>
      </div>
      <div className="meta" style={{ marginTop: 12 }}><a style={{ color: 'var(--green)' }} href="https://platform.tripo3d.ai" target="_blank" rel="noreferrer">{t('Tripo API 키 발급', 'Get a Tripo API key')}</a>{' · '}<a style={{ color: 'var(--green)' }} href="https://developers.tripo3d.ai/en/docs/cli" target="_blank" rel="noreferrer">{t('공식 사용 안내', 'Official guide')}</a></div>
    </div>
    {busy && <div className="set-msg" role="status"><span className="set-spin" /> {t('처리 중…', 'Working…')}</div>}
    {status?.nameConflict && <div className="set-msg err">{t('tripo 이름의 사용자 서버가 있어요. MCP에서 이름을 변경한 뒤 등록해 주세요.', 'A custom server named tripo exists. Rename it in MCP settings before registering.')}</div>}
    {status && !status.cliAvailable && <div className="set-msg err">{t('앱에 Tripo CLI가 누락되어 있어요. 앱을 다시 빌드하거나 설치해 주세요.', 'The bundled Tripo CLI is missing. Rebuild or reinstall the app.')}</div>}
    {error && <div className="set-msg err" role="alert">{error}</div>}
    {message && <div className="set-msg" role="status">{message}</div>}
    {check && <div className={'set-msg' + (check.ok ? '' : ' err')} role="status">{check.ok ? t(`인증 확인 완료 · ${check.balance.toLocaleString()} 크레딧`, `Authentication verified · ${check.balance.toLocaleString()} credits`) : check.error}</div>}
    <ServiceCredits only="tripo" />
    <div className="set-sec">{t('대화에서 사용', 'Use in chat')}</div>
    <div className="sc2 form"><div className="em">{t('“Tripo로 T 포즈의 판타지 전사 캐릭터를 만들고 GLB로 저장해 줘.”', '“Use Tripo to create a fantasy warrior in a T-pose and save it as GLB.”')}</div>
      <div className="meta" style={{ marginTop: 8 }}>{t('연결 확인은 잔액만 조회합니다. 생성·작업 조회·다운로드·최근 작업 도구는 대화에서 사용할 수 있어요. 등록 해제는 MCP, 키 변경·삭제는 Keys에서도 할 수 있습니다.', 'The connection check only reads your balance. Chats can generate assets, inspect tasks, download results, and read recent history. Manage registration in MCP and keys in Keys.')}</div></div>
    <div className="set-note2">{t('공식 Tripo CLI', 'Official Tripo CLI')} {status?.cliVersion ?? '0.3.1'} · {t('앱에 포함 · 별도 Node.js/Blender 실행 불필요', 'Bundled · no separate Node.js or Blender process required')}</div>
  </>
}
