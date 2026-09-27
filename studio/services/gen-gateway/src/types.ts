// 생성 게이트웨이 공통 타입.
// Node 24가 .ts를 직접 실행한다(타입 제거) — enum·parameter property 같은 "지울 수 없는" 문법은 쓰지 않는다.

export type ProviderId = 'comfy' | 'tripo' | 'higgsfield' | 'fake'

/** 무엇을 만드나 — 라우팅 표의 1차 키 */
export type Capability = 'image' | 'video' | 'model3d' | 'audio'

export type OutputKind = 'image' | 'video' | 'model' | 'audio' | 'other'

/** 생성 요청 — UI 폼이든 AI 도구 호출이든 이 모양으로 들어온다 */
export interface GenerationRequest {
  capability: Capability
  /** 서비스와 무관한 모델 이름(예: 'seedance-2', 'tripo-text-to-3d', 'comfy-workflow') — 라우팅 표의 2차 키 */
  model: string
  prompt?: string
  /** 입력 이미지 등 — URL 또는 로컬 경로 */
  inputs?: { kind: 'image' | 'video' | 'model'; url?: string; path?: string; /** 여러 방향 입력(front · back · left · right) */ view?: string }[]
  /** 모델별 추가 옵션(해상도·길이·시드·워크플로 JSON 등) — 어댑터가 해석한다 */
  params?: Record<string, unknown>
  /** 이 요청이 어디서 왔나 — 라이브러리 출처 표시용 */
  origin?: { space?: string; source?: 'ui' | 'agent'; conversation?: string; title?: string }
  /** 특정 서비스를 강제(라우팅 무시) */
  provider?: ProviderId
}

/** 비용 — 서비스마다 단위가 달라서 원 단위와 USD 환산을 같이 둔다 */
export interface Cost {
  amount: number
  unit: 'credits' | 'usd'
  /** USD로 환산 가능한 경우만 */
  usd: number | null
}

export interface Estimate {
  /** null이면 서비스가 사전에 알려주지 않는 비용(실행 후 잔액 차이로 계산) */
  cost: Cost | null
  note?: string
}

export interface Balance {
  amount: number
  unit: 'credits' | 'usd'
  usd: number | null
  checkedAt: number
}

export interface ProviderOutput {
  kind: OutputKind
  url: string
  mime?: string
  /** 서비스 URL의 만료 시각(ms) — 영구 보관은 저장소 업로드가 맡는다 */
  expiresAt?: number | null
  meta?: Record<string, unknown>
}

export type RemoteState = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

export interface RemoteStatus {
  state: RemoteState
  progress?: number | null
  outputs?: ProviderOutput[]
  error?: string
  /** 서비스가 알려준 실제 비용 */
  cost?: Cost | null
}

/** 서비스 어댑터 — 서비스 하나를 같은 틀로 감싼다 */
export interface Provider {
  id: ProviderId
  /** 견적이 곧 실제 청구액인가(고정 요금표) — 참이면 서비스가 비용을 안 알려줘도 견적을 실제 비용으로 기록한다 */
  estimateIsExact?: boolean
  /** 이 서비스가 처리할 수 있는 (기능, 모델) 목록 */
  supports(req: GenerationRequest): boolean
  /** 키가 있어 호출 가능한가 */
  configured(): boolean
  balance(): Promise<Balance | null>
  estimate(req: GenerationRequest): Promise<Estimate>
  submit(req: GenerationRequest): Promise<{ remoteId: string }>
  status(remoteId: string): Promise<RemoteStatus>
  cancel?(remoteId: string): Promise<void>
  /** 인증이 필요하거나 만료되는 결과 URL을 지금 열 수 있는 URL로 바꾼다(없으면 저장된 URL 그대로) */
  resolveOutput?(url: string): Promise<string>
}

export type JobState =
  | 'awaiting_approval' // 견적 나옴, 사용자 승인 대기
  | 'rejected' // 사용자가 거절
  | 'submitting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'

export interface JobRecord {
  id: string
  createdAt: number
  updatedAt: number
  state: JobState
  capability: Capability
  model: string
  provider: ProviderId
  prompt: string | null
  params: Record<string, unknown> | null
  inputs: GenerationRequest['inputs'] | null
  origin: GenerationRequest['origin'] | null
  estimate: Cost | null
  cost: Cost | null
  /** 1순위를 건너뛰고 이 서비스를 고른 이유 */
  fallbackReason: string | null
  remoteId: string | null
  progress: number | null
  error: string | null
  balanceBefore: Balance | null
}

export interface OutputRecord {
  id: string
  jobId: string
  kind: OutputKind
  url: string
  mime: string | null
  expiresAt: number | null
  /** 영구 보관 위치(R2 키 등) — 저장소 연결 전에는 null */
  storageKey: string | null
  createdAt: number
}
