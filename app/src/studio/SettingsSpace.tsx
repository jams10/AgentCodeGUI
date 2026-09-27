// 설정 공간 — 외부 생성 서비스 연결(API 키 저장 · 연결 확인 · 삭제).
// 키 원문은 입력칸에서 게이트웨이로 바로 보내고, 저장 뒤에는 입력칸을 비운다. 화면에 남는 것은 끝 4자리뿐이다.
// 게이트웨이가 Windows DPAPI로 암호화해 앱 데이터 폴더에 둔다(저장소 · 채팅에는 절대 들어가지 않는다).
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { deleteKey, fmtCost, listKeys, PROVIDER_NAME, saveKey, testKey, useGateway, type KeyInfo, type ProviderId } from './gateway'

interface ServiceGuide {
  id: ProviderId
  what: string
  where: string
  url: string
  format: string
  placeholder: string
  note?: string
}

const SERVICES: ServiceGuide[] = [
  {
    id: 'comfy',
    what: '워크플로 실행 · 파트너 노드(Nano Banana · Seedance · Kling · GPT Image …)',
    where: 'Comfy Platform → Profile → API Keys',
    url: 'https://platform.comfy.org/profile/api-keys',
    format: '"comfyui-"로 시작하는 키',
    placeholder: 'comfyui-…',
    note: 'API는 유료 구독에서만 열려요. 구독 크레딧을 그대로 써요.'
  },
  {
    id: 'higgsfield',
    what: '이미지(Soul) · 영상(Seedance · Kling · Hailuo …)',
    where: 'Higgsfield 콘솔 → API Keys',
    url: 'https://console.higgsfield.ai',
    format: 'KEY_ID와 KEY_SECRET을 콜론으로 이어서 한 줄로 — "KEY_ID:KEY_SECRET"',
    placeholder: 'KEY_ID:KEY_SECRET',
    note: '웹 구독과 별개인 API 잔액(달러, 건별 결제)을 써요. 잔액 조회 API가 없어서 앱에는 사용액으로 보여요.'
  },
  {
    id: 'tripo',
    what: '3D 모델(텍스트 · 이미지 · 여러 방향 이미지 → 3D)',
    where: 'Tripo 개발자 플랫폼 → API Keys',
    url: 'https://platform.tripo3d.ai',
    format: 'API 키(보통 "tsk_"로 시작)',
    placeholder: 'tsk_…',
    note: 'Tripo Studio(웹) 구독과 결제가 따로예요. API 크레딧을 충전한 계정의 키가 필요해요.'
  }
]

type Status = { kind: 'idle' } | { kind: 'busy'; text: string } | { kind: 'ok'; text: string } | { kind: 'bad'; text: string }

function ServiceCard({ g, info, onChanged }: { g: ServiceGuide; info: KeyInfo | undefined; onChanged: () => void }): ReactElement {
  const [value, setValue] = useState('')
  const [show, setShow] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [confirmDel, setConfirmDel] = useState(false)
  const { balances, spend } = useGateway()
  const busy = status.kind === 'busy'

  const verify = (): void => {
    setStatus({ kind: 'busy', text: '연결 확인 중…' })
    testKey(g.id)
      .then((r) => setStatus({ kind: r.ok ? 'ok' : 'bad', text: r.ok ? r.message : `연결 실패 — ${r.message}` }))
      .catch((e: Error) => setStatus({ kind: 'bad', text: e.message }))
  }
  const save = (): void => {
    const key = value.trim()
    if (!key) return
    setStatus({ kind: 'busy', text: '암호화해 저장하는 중…' })
    saveKey(g.id, key)
      .then(() => {
        setValue('') // 원문은 화면에 남기지 않는다
        setShow(false)
        onChanged()
        verify()
      })
      .catch((e: Error) => setStatus({ kind: 'bad', text: e.message }))
  }
  const remove = (): void => {
    if (!confirmDel) return setConfirmDel(true)
    setConfirmDel(false)
    setStatus({ kind: 'busy', text: '지우는 중…' })
    deleteKey(g.id)
      .then(() => {
        onChanged()
        setStatus({ kind: 'idle' })
      })
      .catch((e: Error) => setStatus({ kind: 'bad', text: e.message }))
  }

  const b = balances[g.id]
  const month = spend.find((s) => s.provider === g.id)
  return (
    <section className="st-set-card" aria-label={`${PROVIDER_NAME[g.id]} 연결`}>
      <header className="st-set-head">
        <div>
          <h3>{PROVIDER_NAME[g.id]}</h3>
          <div className="st-set-what">{g.what}</div>
        </div>
        <span className={info?.configured ? 'st-set-badge on' : 'st-set-badge'}>{info?.configured ? `연결됨 ${info.hint ?? ''}` : '키 없음'}</span>
      </header>

      {info?.configured && (
        <div className="st-set-facts">
          <span>잔액 {b && !('error' in b) ? fmtCost(b) : g.id === 'higgsfield' ? '조회 API 없음' : '—'}</span>
          <span>30일 사용 {month ? `${month.jobs}건 · $${month.usd.toFixed(2)}` : '없음'}</span>
          {info.updatedAt && <span>저장 {new Date(info.updatedAt).toLocaleDateString('ko-KR')}</span>}
        </div>
      )}

      <label className="st-art-field" htmlFor={`st-key-${g.id}`}>
        <span>{info?.configured ? '새 키로 바꾸기' : 'API 키'}</span>
        <div className="st-set-input">
          <input
            id={`st-key-${g.id}`}
            type={show ? 'text' : 'password'}
            value={value}
            placeholder={g.placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && save()}
          />
          <button type="button" className="st-ghost" onClick={() => setShow((s) => !s)} aria-label={show ? '키 가리기' : '키 보기'} disabled={!value}>
            {show ? '가리기' : '보기'}
          </button>
        </div>
      </label>
      <div className="st-set-hint">
        {g.format} · 발급: {g.where}{' '}
        <button type="button" className="st-set-link" onClick={() => void window.api.openExternal(g.url)}>
          열기 ↗
        </button>
      </div>
      {g.note && <div className="st-usage-note">{g.note}</div>}

      <div className="st-set-actions">
        <button type="button" className="st-gloss st-gen-go" disabled={busy || !value.trim()} onClick={save}>
          저장하고 연결 확인
        </button>
        {info?.configured && (
          <>
            <button type="button" className="st-pill" disabled={busy} onClick={verify}>
              연결 확인
            </button>
            <button type="button" className="st-pill st-art-danger" disabled={busy} onClick={remove}>
              {confirmDel ? '정말 지울까요?' : '키 지우기'}
            </button>
          </>
        )}
      </div>
      {status.kind !== 'idle' && <div className={status.kind === 'bad' ? 'st-gen-warn' : 'st-usage-note'}>{status.text}</div>}
    </section>
  )
}

export function SettingsSpace(): ReactElement {
  const g = useGateway()
  const [keys, setKeys] = useState<KeyInfo[]>([])
  const reload = useCallback(() => {
    listKeys().then(setKeys).catch(() => {})
  }, [])
  const configuredKey = g.providers.map((p) => `${p.id}:${p.configured}`).join(',')
  useEffect(() => {
    if (g.status === 'ready') reload()
  }, [g.status, configuredKey, reload])

  return (
    <div className="st-set">
      <div className="st-set-col">
        <div className="st-set-intro">
          <h2>서비스 연결</h2>
          <p>
            외부 생성 서비스의 API 키를 넣어요. 키는 이 PC 안에서만 오가고, Windows 계정으로 암호화해 앱 데이터 폴더에 저장돼요. 저장하면 앱을 다시 켜지 않아도 바로 쓸 수 있어요.
          </p>
          <p className="st-dim">키를 채팅에 붙여 넣지 마세요. 여기서만 입력하면 돼요.</p>
        </div>
        {g.status !== 'ready' ? (
          <div className="st-empty">{g.status === 'connecting' ? '생성 게이트웨이에 연결하는 중…' : '생성 게이트웨이에 연결하지 못했어요. 잠시 후 다시 시도해요.'}</div>
        ) : (
          SERVICES.map((s) => <ServiceCard key={s.id} g={s} info={keys.find((k) => k.provider === s.id)} onChanged={reload} />)
        )}
        <div className="st-set-intro">
          <h2>AI 계정</h2>
          <p>Claude · Codex(GPT) 로그인과 계정 관리는 채팅 공간 왼쪽 아래의 설정(톱니바퀴)에서 해요.</p>
        </div>
      </div>
    </div>
  )
}
