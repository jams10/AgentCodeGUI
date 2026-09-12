import { useCallback, useEffect, useRef, useState } from 'react'
import type { CreditService, ServiceCreditInfo } from '@shared/protocol'
import { isEn, t } from '../lib/i18n'
import { IconRefresh } from './icons'

const SERVICES: CreditService[] = ['tripo', 'comfy-cloud']
const labels: Record<CreditService, string> = { tripo: 'Tripo', 'comfy-cloud': 'ComfyCloud' }
const number = (value: number): string => value.toLocaleString(isEn() ? 'en-US' : 'ko-KR', { maximumFractionDigits: 2 })

function CreditRow({ service, compact, codexAccount, busy }: { service: CreditService; compact: boolean; codexAccount?: string; busy?: boolean }): React.ReactElement {
  const [value, setValue] = useState<ServiceCreditInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const revision = useRef(0)
  const wasBusy = useRef(busy)
  const refresh = useCallback(async (fresh: boolean): Promise<void> => {
    const request = ++revision.current
    setLoading(true); setFailed(false)
    try {
      const next = await window.api.credits.get(service, fresh, codexAccount)
      if (request === revision.current) setValue(next)
    } catch { if (request === revision.current) setFailed(true) }
    finally { if (request === revision.current) setLoading(false) }
  }, [service, codexAccount])
  useEffect(() => {
    setValue(null)
    void refresh(false)
    return () => { revision.current++ }
  }, [refresh])
  useEffect(() => {
    if (wasBusy.current && !busy) void refresh(true)
    wasBusy.current = busy
  }, [busy, refresh])

  const balance = value?.balance
  const stale = value?.stale || (failed && balance != null)
  const stateText = loading && balance == null ? t('불러오는 중…', 'Loading…')
    : value?.state === 'unconfigured' ? t('미연결', 'Not connected')
      : value?.state === 'auth-required' ? t('다시 로그인 필요', 'Sign-in required')
        : balance == null ? t('조회할 수 없음', 'Unavailable')
          : stale ? t('마지막 확인값', 'Last known balance') : t('남은 크레딧', 'Credits left')
  const detail = [value?.account, value?.plan].filter(Boolean).join(' · ')
  const checked = value?.checkedAt ? new Date(value.checkedAt).toLocaleTimeString(isEn() ? 'en-US' : 'ko-KR', { hour: '2-digit', minute: '2-digit' }) : null
  const note = !window.api.credits ? t('앱을 다시 실행해 주세요.', 'Restart the app to load this feature.')
    : failed ? t('새로고침에 실패했어요.', 'Refresh failed.') : value?.note

  return <div className={(compact ? 'credit-row compact' : 'sc2 credit-row') + (stale ? ' stale' : '')} data-testid={`credits-${service}`} aria-busy={loading}>
    <div className="credit-main">
      <div className="credit-provider">
        <span className="credit-name">{labels[service]}</span>
        <span className="credit-detail">{compact ? stateText : detail || stateText}</span>
      </div>
      <div className={'credit-value' + (balance != null && balance <= 0 ? ' empty' : '')} aria-live="polite">
        <strong>{balance == null ? '—' : number(balance)}</strong>
        <span>{balance == null ? stateText : t('크레딧', 'credits')}</span>
      </div>
      <button type="button" className="credit-refresh" disabled={loading} onClick={() => void refresh(true)}
        aria-label={t(`${labels[service]} 잔액 새로고침`, `Refresh ${labels[service]} balance`)} title={t('잔액 새로고침', 'Refresh balance')}>
        {loading ? <span className="set-spin" /> : <IconRefresh size={13} />}
      </button>
    </div>
    {!compact && <div className="credit-foot">
      <span>{balance != null ? stateText : t('연결한 서비스 계정의 잔액', 'Balance of the connected service account')}</span>
      {checked && <span>{t(`${checked} 확인`, `Checked ${checked}`)}</span>}
    </div>}
    {value?.frozen != null && value.frozen > 0 && <div className="credit-note">{t(`보류 중 ${number(value.frozen)} 크레딧`, `${number(value.frozen)} credits frozen`)}</div>}
    {note && <div className="credit-note" role={failed || value?.state === 'auth-required' ? 'status' : undefined}>{note}</div>}
  </div>
}

export function ServiceCredits({ compact = false, only, codexAccount, busy }: { compact?: boolean; only?: CreditService; codexAccount?: string; busy?: boolean }): React.ReactElement {
  return <section className={'service-credits' + (compact ? ' compact' : '')} aria-label={t('생성 서비스 크레딧', 'Generation service credits')}>
    <div className={compact ? 'credit-heading' : 'set-sec'}>{t('생성 서비스 크레딧', 'Generation service credits')}</div>
    {(only ? [only] : SERVICES).map(service => <CreditRow key={service} service={service} compact={compact} codexAccount={codexAccount} busy={busy} />)}
    {!compact && <div className="set-note2">{t('연결한 서비스 계정 전체의 잔액입니다. 화면을 열거나 새로고침하면 조회하며, 조회에는 생성 크레딧을 쓰지 않습니다.', 'Balances cover the connected service accounts. Opening this view or refreshing checks balances without spending generation credits.')}</div>}
  </section>
}
