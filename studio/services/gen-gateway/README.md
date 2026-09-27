# 생성 게이트웨이 (gen-gateway)

ComfyCloud · Tripo · Higgsfield 생성을 한 곳으로 모으는 상주 프로세스입니다.
앱 화면과 AI(Claude/Codex)가 모두 이 게이트웨이를 거쳐 생성하고, 모든 작업이 기록부에 남습니다.

```
앱 화면 ──(로컬 HTTP)──┐
                        ├─ 게이트웨이 ─ 견적 → 사용자 승인 → 제출 → 추적 → 결과 보관 ─┬─ ComfyCloud
AI ──(MCP 중계기 mcp.ts)┘        │                                                       ├─ Tripo
                                 └─ 기록부(SQLite): 프롬프트 · 서비스 · 비용 · 결과         └─ Higgsfield
```

Node 24가 `.ts`를 직접 실행합니다. 빌드 단계와 추가 패키지가 없습니다(`node:sqlite` 내장).

## 규칙

- **비용이 드는 제출은 사용자 승인 뒤에만 일어납니다.** AI에게는 승인 도구가 없습니다. AI의 `generate`는
  승인 대기 작업을 만들고, 사용자가 앱에서 승인·거절할 때까지 기다립니다.
- **서비스 선택:** 라우팅 표의 순서대로 고르고, 키가 없거나 · 모델을 지원하지 않거나 · 잔액이 부족하면
  다음 서비스로 넘어갑니다. 넘어간 이유는 작업 기록과 승인 카드에 남습니다.
- **비용 기록:** 서비스가 알려준 실제 비용 → (고정 요금 서비스는) 견적 → 실행 전후 잔액 차이 순서로 기록합니다.
  같은 서비스에 동시에 도는 작업이 있으면 잔액 차이는 섞이므로 기록하지 않습니다(알 수 없음).
- **키:** Windows DPAPI(현재 사용자)로 암호화해 `<데이터 폴더>/studio/secrets.json`에 둡니다. 평문은 디스크와
  명령줄 인자에 남지 않고, 저장소(git)에는 들어가지 않습니다.
- **결과 보관:** 곧 만료되는 결과(Tripo 5분 링크)는 완료 즉시 `<데이터 폴더>/studio/outputs/`에 받아 둡니다.
  클라우드 저장소(R2)를 연결하면 `archive.ts`의 보관 단계를 교체해 모든 결과를 그쪽으로 보냅니다.

데이터 폴더는 앱과 같습니다: `CCG_HOME`이 있으면 그 경로, 없으면 `~/.agentstudio`.

## 서비스별 확인 사항 (2026-09 공식 문서 기준)

| 서비스 | 인증 | 견적 | 실제 비용 | 잔액 | 결과 링크 |
|---|---|---|---|---|---|
| ComfyCloud (API v2) | `comfyui-…` 키 | 없음 | 잔액 차이 | `/api/billing/balance` (211 크레딧/USD) | 약 6시간 서명 URL — 요청 때마다 새로 받음 |
| Tripo (API v3) | Bearer 키 (Studio 구독과 별개인 API 크레딧 계정) | 공개 요금표 계산 | `credits_consumed` | `/v3/account/balance` | **5분 만료** → 즉시 보관 |
| Higgsfield | `KEY_ID:KEY_SECRET` | `/estimate/…` (= 청구액) | 견적 | **API 없음** | 최소 7일 보관 |

Higgsfield의 3D(Tripo 텍스트→3D)는 CLI 전용이라 REST로는 쓸 수 없습니다.

## 사용법

```bash
node studio/services/gen-gateway/src/cli.ts keys set comfy        # 키 입력 — 화면에 표시되지 않음
node studio/services/gen-gateway/src/cli.ts keys set tripo
node studio/services/gen-gateway/src/cli.ts keys set higgsfield   # "KEY_ID:KEY_SECRET"
node studio/services/gen-gateway/src/cli.ts keys list             # 끝 4자리만 표시
node studio/services/gen-gateway/src/cli.ts balance               # 잔액 확인(생성·과금 없음)
node studio/services/gen-gateway/src/cli.ts serve                 # 게이트웨이 실행(보통 앱이 띄움)
```

키는 채팅에 붙여넣지 말고 위 명령으로 직접 넣으세요.

## 모델 이름

| 모델 | 기능 | 서비스 |
|---|---|---|
| `comfy-workflow` | image · video · model3d | ComfyCloud — `params.workflow`에 API 형식 워크플로 JSON, 입력 파일은 `$INPUT_0`… |
| `tripo-text-to-3d` / `tripo-image-to-3d` / `tripo-multiview-to-3d` | model3d | Tripo |
| `soul` | image | Higgsfield |
| `seedance-2.0-t2v` / `seedance-2.0-i2v` / `kling-2.5-turbo-i2v` | video | Higgsfield |
| `hf/<모델 경로>` | image · video | Higgsfield 카탈로그의 다른 모델 |

라우팅(서비스 우선순위)은 `<데이터 폴더>/studio/routes.json`으로 바꿀 수 있습니다. 형식은 `src/routes.ts`의 `DEFAULT_ROUTES`와 같습니다.

## 로컬 API (127.0.0.1, `Authorization: Bearer <gateway.json의 token>`)

| 요청 | 내용 |
|---|---|
| `GET /health` | 인증 없음 |
| `POST /jobs` | 견적 → 승인 대기 작업 |
| `POST /jobs/:id/approve` · `reject` · `cancel` | 승인은 앱 UI에서만 부른다 |
| `GET /jobs` · `/jobs/:id` · `/jobs/:id/wait?timeout=` | 조회 · 완료 대기 |
| `GET /outputs/:id/url` | 지금 열 수 있는 결과 URL(보관본 우선) |
| `GET /balances` · `/providers` · `/spend?since=` | 잔액 · 연결 상태 · 사용액 |
| `GET /events` | 작업 상태 변화 스트림(SSE) |

## 앱 연결

- **실행:** 앱이 켜질 때 `src-tauri/src/studio.rs`가 `node cli.ts serve`를 띄운다(창 없이). 표준 입력 파이프를 앱이
  쥐고 있어서 앱이 어떻게 끝나든 게이트웨이도 따라 종료된다. 로그: `<데이터 폴더>/studio/gateway.log`, `app-gateway.log`.
  설치본은 `resources/gen-gateway/src`(studio/tauri.studio.conf.json의 bundle.resources)에서 실행한다.
- **AI 연결:** 앱이 `CCG_STUDIO_MCP`에 MCP 중계기 정의를 넣고, 엔진이 Claude에는 `--mcp-config`, Codex에는
  `thread/start`의 `config.mcp_servers`로 붙인다(`crates/ccg-engine/src/studio.rs`). 계정별 설정 폴더는 건드리지 않는다.
- **화면:** 렌더러가 `studio:gateway-info`로 port · token을 받아 로컬 API와 이벤트 스트림에 직접 붙는다
  (`app/src/studio/gateway.ts`). 승인 카드 · 진행 · 완료 알림은 `ApprovalCenter.tsx`, 잔액 · 사용액은 사용량 패널.
- **개발 확인:** `CCG_GATEWAY_FAKE=1`로 앱을 띄우면 과금 없는 가짜 서비스(`fake-demo` 모델)가 등록된다.
  승인 카드부터 완료 알림까지 실제 서비스 없이 확인할 때 쓴다.
- **꺼 두기:** `CCG_STUDIO_NO_GATEWAY=1`이면 앱이 게이트웨이를 띄우지 않는다.

## 검증

```bash
node --test "studio/services/gen-gateway/test/*.test.ts"   # 37개 — 가짜 서비스 · 가짜 네트워크, 과금 없음
npx tsc -p studio/services/gen-gateway                      # 타입 검사
```

실제 서비스 호출(인증 · 잔액 · 생성)은 키를 넣은 뒤 `balance` 명령부터 확인합니다.
