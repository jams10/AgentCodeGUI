// 원본 설정 창(components/Settings.tsx)에 얹는 Studio 확장 — 원본 파일에는 [studio hook] 3줄만 둔다.
//  · studioNav: AgentStudio에 쓸모없거나 헷갈리는 항목을 레일에서 뺀다(원본 코드는 그대로라 목록만 고치면 되살아난다).
//  · StudioApiServices: API 탭 아래에 외부 생성 서비스(ComfyCloud · Higgsfield · Tripo) 키 카드를 붙인다.
// 키 원문은 입력칸에서 생성 게이트웨이로 바로 보내고, 저장 뒤에는 입력칸을 비운다. 화면에 남는 것은 끝 4자리뿐이다.
// 게이트웨이가 Windows DPAPI로 암호화해 앱 데이터 폴더에 둔다(저장소 · 채팅에는 절대 들어가지 않는다).
import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { deleteKey, fmtCost, listKeys, PROVIDER_NAME, saveKey, testKey, useGateway, type KeyInfo, type ProviderId } from './gateway'

/** 레일에서 뺄 원본 설정 항목 — 이유는 FORK.md 「설정 정리」 */
const HIDDEN = new Set<string>([
  'external-tools', // 내 프로그램을 대화에 잇는 개발자용 규격 안내 — 게임 제작 공간을 만들 때 다시 본다
  'lsp', // 파일 뷰어 코드 심볼(언어 서버) — 코딩 전용
  'explorer', // 파일 탐색기 숨김 필터 — 코딩 전용
  'app' // 원본(AgentCodeGUI) 릴리스 업데이트 · 패치노트 — Studio 빌드엔 맞지 않는다
])

export function studioNav<G extends { items: { id: string }[] }>(groups: G[]): G[] {
  return groups.map((g) => ({ ...g, items: g.items.filter((it) => !HIDDEN.has(it.id)) })).filter((g) => g.items.length > 0)
}

interface ServiceGuide {
  id: ProviderId
  what: string
  where: string
  url: string
  placeholder: string
  note: string
}

const SERVICES: ServiceGuide[] = [
  {
    id: 'comfy',
    what: '이미지 · 영상 — 워크플로와 파트너 노드(Nano Banana · Seedance · Kling · GPT Image …)',
    where: 'Comfy Platform → Profile → API Keys',
    url: 'https://platform.comfy.org/profile/api-keys',
    placeholder: 'comfyui-…',
    note: '"comfyui-"로 시작하는 키. API는 유료 구독에서만 열리고, 구독 크레딧을 그대로 써요.'
  },
  {
    id: 'higgsfield',
    what: '이미지(Soul) · 영상(Seedance · Kling · Hailuo …)',
    where: 'Higgsfield 콘솔 → API Keys',
    url: 'https://console.higgsfield.ai',
    placeholder: 'KEY_ID:KEY_SECRET',
    note: 'KEY_ID와 KEY_SECRET을 콜론으로 이어 한 줄로. 웹 구독과 별개인 API 잔액(달러, 건별 결제)을 쓰고, 잔액 조회 API가 없어 사용액으로 보여요.'
  },
  {
    id: 'tripo',
    what: '3D 모델 — 텍스트 · 이미지 · 여러 방향 이미지 → 3D',
    where: 'Tripo 개발자 플랫폼 → API Keys',
    url: 'https://platform.tripo3d.ai',
    placeholder: 'tsk_…',
    note: 'Tripo Studio(웹) 구독과 결제가 따로예요. API 크레딧을 충전한 계정의 키가 필요해요.'
  }
]

type Status = { kind: 'idle' } | { kind: 'busy'; text: string } | { kind: 'ok'; text: string } | { kind: 'bad'; text: string }

function ServiceCard({ g, info, onChanged }: { g: ServiceGuide; info: KeyInfo | undefined; onChanged: () => void }): ReactElement {
  const [value, setValue] = useState('')
  const [edit, setEdit] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [confirmDel, setConfirmDel] = useState(false)
  const { balances, spend } = useGateway()
  const busy = status.kind === 'busy'
  const has = !!info?.configured

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
        setEdit(false)
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
    <>
      <div className="set-sec">{PROVIDER_NAME[g.id]}</div>
      <div className="sc2 api st-svc">
        <div className="aphead">
          <span className="apn">{g.what}</span>
          <span className={has ? 'set-badge' : 'set-badge off'}>{has ? '등록됨' : '미등록'}</span>
          <span className="sp" />
          {has && !edit && (
            <>
              <button className="set-chipbtn" disabled={busy} onClick={verify}>
                연결 확인
              </button>
              <button className="set-chipbtn" disabled={busy} onClick={() => (setValue(''), setEdit(true))}>
                변경
              </button>
              <button className="set-chipbtn danger" disabled={busy} onClick={remove}>
                {confirmDel ? '정말 삭제' : '삭제'}
              </button>
            </>
          )}
        </div>

        {has && !edit ? (
          <div className="apkey">{'••••••••' + (info?.hint?.replace(/^[•.…\s]+/, '') ?? '')}</div>
        ) : (
          <div className="apform">
            <input
              className="set-input"
              type="password"
              placeholder={g.placeholder}
              value={value}
              spellCheck={false}
              autoComplete="off"
              aria-label={`${PROVIDER_NAME[g.id]} API 키`}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !busy) save()
                if (e.key === 'Escape' && edit) (setEdit(false), setValue(''))
              }}
            />
            <button className="set-chipbtn" disabled={busy || !value.trim()} onClick={save}>
              저장
            </button>
            {edit && (
              <button className="set-chipbtn" onClick={() => (setEdit(false), setValue(''))}>
                취소
              </button>
            )}
          </div>
        )}

        {has && (
          <div className="st-svc-facts">
            <span>잔액 {b && !('error' in b) ? fmtCost(b) : g.id === 'higgsfield' ? '조회 API 없음' : '—'}</span>
            <span>30일 사용 {month ? `${month.jobs}건 · $${month.usd.toFixed(2)}` : '없음'}</span>
          </div>
        )}
        {status.kind !== 'idle' && <div className={status.kind === 'bad' ? 'st-svc-msg bad' : 'st-svc-msg'}>{status.text}</div>}
      </div>
      <div className="set-note2">
        {g.note} 발급: {g.where}{' '}
        <button type="button" className="st-svc-link" onClick={() => void window.api.openExternal(g.url)}>
          열기 ↗
        </button>
      </div>
    </>
  )
}

/** API 탭 아래 — 외부 생성 서비스 키 */
export function StudioApiServices(): ReactElement {
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
    <div className="st-svc-wrap">
      <div className="set-h1" style={{ fontSize: 17, marginTop: 34 }}>
        생성 서비스
      </div>
      <div className="set-h1-sub">
        아트 · 게임 제작에서 쓰는 외부 생성 서비스예요. 키는 이 PC 안에서만 오가고 Windows 계정으로 암호화해 저장돼요. 저장하면 바로 쓸 수
        있어요 — 키를 채팅에 붙여 넣지 마세요.
      </div>
      {g.status !== 'ready' ? (
        <div className="set-note2">{g.status === 'connecting' ? '생성 게이트웨이에 연결하는 중…' : '생성 게이트웨이에 연결하지 못했어요. 잠시 후 다시 시도해요.'}</div>
      ) : (
        SERVICES.map((s) => <ServiceCard key={s.id} g={s} info={keys.find((k) => k.provider === s.id)} onChanged={reload} />)
      )}
    </div>
  )
}

/** 채팅(원본 App)이 설정 창을 열려 할 때 — Studio 셸 안이면 Studio 설정 공간으로 보낸다(StudioRoot가 받음). 처리했으면 true. */
export function studioRouteSettings(view?: string): boolean {
  if (!document.documentElement.classList.contains('studio-theme')) return false
  window.dispatchEvent(new CustomEvent<string | undefined>('studio:settings', { detail: view }))
  return true
}
