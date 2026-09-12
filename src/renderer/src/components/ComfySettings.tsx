import { useEffect, useState } from 'react'
import type { ComfyStatus, ComfyConnectionResult } from '@shared/protocol'
import { t } from '../lib/i18n'

export function ComfySettings(): React.ReactElement {
  const [status, setStatus] = useState<ComfyStatus | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [check, setCheck] = useState<ComfyConnectionResult | null>(null)
  const bridgeReady = !!window.api.comfy
  const restartMessage = t('새 연결 기능을 적용하려면 트레이 아이콘을 우클릭해 종료한 뒤 앱을 다시 실행해 주세요. 창의 X 버튼은 트레이로 숨기기만 합니다.', 'To apply the new connection feature, right-click the tray icon, choose Quit, and reopen the app. The window’s X button only hides it to the tray.')
  useEffect(() => { if (bridgeReady) void window.api.comfy.status().then(setStatus).catch(() => setError(t('연결 설정을 읽지 못했어요.', 'Could not read connection settings.'))) }, [])

  const run = async (save: boolean): Promise<void> => {
    if (!bridgeReady) { setError(restartMessage); return }
    setBusy(true); setError(''); setMessage(''); setCheck(null)
    try {
      if (save) {
        setStatus(await window.api.comfy.register(key.trim() ? key : undefined)); setKey('')
        setMessage(t('API 키 연결을 저장했어요. 다음 대화 메시지부터 적용됩니다.', 'API key connection saved. Applies from the next chat message.'))
      }
      setCheck(await window.api.comfy.check())
    } catch (e) { setError(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')) }
    finally { setBusy(false) }
  }
  return <>
    <div className="set-h1">ComfyCloud</div>
    <div className="set-h1-sub">{t('API 키 하나로 이미지 생성 도구와 남은 크레딧을 연결합니다. Claude·Codex의 모든 대화에서 같은 키를 사용합니다.', 'Connect generation tools and remaining credits with one API key, shared by Claude and Codex chats.')}</div>
    {!bridgeReady && <div id="comfy-connection-notice" className="set-msg err" role="status">{restartMessage}</div>}
    <div className="sc2 form" data-testid="comfy-settings">
      <div className="aphead"><span className="apn">ComfyCloud API</span><span className="sp" />
        <span className={'set-badge' + (status?.keySaved ? '' : ' warn')}>{status?.keySaved ? t('키 저장됨', 'Key saved') : t('키 필요', 'Key needed')}</span>
        {status?.registered && <span className={'set-badge' + (status.enabled ? '' : ' off')}>{status.enabled ? t('API 키 연결', 'API key connected') : t('연결 꺼짐', 'Disabled')}</span>}
      </div>
      <div className="set-field"><label htmlFor="comfy-api-key">COMFY_API_KEY</label>
        <input id="comfy-api-key" className="set-input mono" type="password" autoComplete="off" spellCheck={false}
          value={key} disabled={busy} aria-describedby={!bridgeReady ? 'comfy-connection-notice' : undefined} placeholder={status?.keySaved ? '••••' + status.keyTail : 'comfyui-…'}
          onChange={e => setKey(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && key.trim() && !busy) void run(true) }} />
        <div className="meta">{t('Comfy Platform에서 발급한 키를 입력하세요. 키는 앱의 Keys 보관함에 암호화해 저장하며, 앱을 다시 열어도 유지됩니다.', 'Enter a key from Comfy Platform. It is encrypted in the app’s Keys vault and retained across restarts.')}</div>
      </div>
      <div className="set-acts">
        <button className="set-chipbtn on" disabled={busy || !bridgeReady || !!status?.nameConflict || (!key.trim() && !status?.keySaved)} onClick={() => void run(true)}>{t('키 저장 · 연결 확인', 'Save key & check connection')}</button>
        <button className="set-chipbtn" disabled={busy || !status?.enabled || !status.keySaved || !!key.trim()} onClick={() => void run(false)}>{t('저장한 키 연결 확인', 'Check saved key')}</button>
      </div>
      <div className="meta" style={{ marginTop: 12 }}><a style={{ color: 'var(--green)' }} href="https://platform.comfy.org/profile/api-keys" target="_blank" rel="noreferrer">{t('Comfy API 키 발급', 'Get a Comfy API key')}</a>{' · '}<a style={{ color: 'var(--green)' }} href="https://docs.comfy.org/agent-tools/mcp" target="_blank" rel="noreferrer">{t('공식 연결 안내', 'Official connection guide')}</a></div>
    </div>
    {status?.authMode === 'oauth-or-custom' && <div className="set-note2">{t('현재 로그인 또는 사용자 설정을 사용 중입니다. 키를 저장하면 API 키 연결로 전환됩니다.', 'Currently using login or custom settings. Saving a key switches this connection to API key authentication.')}</div>}
    {status?.nameConflict && <div className="set-msg err">{t('comfy-cloud 이름에 다른 서버가 등록되어 있어요. MCP에서 이름을 변경해 주세요.', 'A different server uses the comfy-cloud name. Rename it in MCP settings.')}</div>}
    {busy && <div className="set-msg" role="status"><span className="set-spin" /> {t('도구 연결과 잔액 확인 중…', 'Checking tools and credits…')}</div>}
    {message && <div className="set-msg" role="status">{message}</div>}
    {error && <div className="set-msg err" role="alert">{error}</div>}
    {check && <div className="sc2 form" data-testid="comfy-check">
      <div className={'set-msg' + (check.mcp.ok ? '' : ' err')}>{check.mcp.ok
        ? t(`도구 연결 확인 · ${check.mcp.toolCount}개 · ${(check.mcp.elapsedMs / 1000).toFixed(1)}초`, `Tools connected · ${check.mcp.toolCount} tools · ${(check.mcp.elapsedMs / 1000).toFixed(1)} s`)
        : t(`도구 연결 실패 · ${check.mcp.error}`, `Tool connection failed · ${check.mcp.error}`)}</div>
      <div className={'set-msg' + (check.credits.state === 'ready' ? '' : ' err')}>{check.credits.state === 'ready'
        ? t(`잔액 확인 · ${check.credits.balance?.toLocaleString()} 크레딧`, `Balance verified · ${check.credits.balance?.toLocaleString()} credits`)
        : check.credits.note}</div>
    </div>}
    <div className="set-note2">{t('연결 확인은 도구 목록과 잔액만 읽습니다. 이미지 생성 크레딧은 사용하지 않습니다. 연결 끄기는 MCP, 키 삭제는 Keys에서 관리합니다.', 'Checks read only the tool list and balance, without generating images. Disable the connection in MCP; delete the key in Keys.')}</div>
  </>
}
