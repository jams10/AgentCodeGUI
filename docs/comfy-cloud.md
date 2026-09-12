# Comfy Cloud 공용 연결

## 승인창 없이 `spend.cancelled`가 나오는 문제 (2026-09-08)

사용자는 이미지 4장과 Tripo 1개 생성에 동의했고 승인창을 취소하지 않았다.
Nano Banana Pro 앞면 1장은 완료됐지만 후속 `submit_batch(confirm=true)`는
`spend.cancelled`를 반환했다. 후속 배치의 작업 ID와 과금은 없었다.

Codex CLI 0.153.4 + 과금 없는 로컬 MCP 서버에서 원인을 재현했다.

- 이전 자동/전체 접근 모드의 `approvalPolicy: never`는 MCP elicitation도 자동 거절한다.
  앱으로 서버 요청을 전달하지 않고 MCP 서버에 `{action:"decline"}`를 돌려줬다.
  이 결과를 ComfyCloud가 `Cancelled — no credits were spent`로 표현했다.
- 일반 승인 모드에서는 `mcpServer/elicitation/request`가 앱에 도착하지만,
  기존 `CodexEngine`에는 해당 분기가 없어 `unsupported client request` 오류를 보냈다.
  Codex는 이 경우에도 MCP에 decline을 반환했다. 사용자의 클릭 기록이 아니다.
- 수정: 자동/전체 접근 모드는 기존 sandbox를 유지하고 granular 정책에서
  `mcp_elicitations:true`만 켠다. 로컬 명령/파일 승인 동작을 새로 허용하지 않는다.
  표준 MCP form을 질문 카드에 표시하고 boolean/enum 값을 형식대로 전송한다.
  기본값만으로 승인하지 않으며 접기는 대기 유지, 명시적 닫기는 cancel이다.
- 동시 MCP 요청은 순서대로 표시한다. `serverRequest/resolved`로 만료된 카드를 없애고
  늦은 클릭을 무시한다. 지원하지 않는 URL/확장/중첩 양식은 명시적인 UI 오류로 알리며
  사용자가 취소했다고 기록하지 않는다. OpenAI 확장 form 기능은 opt-in하지 않는다.

수정은 main 프로세스와 renderer에 있으므로 **트레이 아이콘 우클릭 → 종료 → 다시 실행**해야
현재 앱에 적용된다. 단순히 창의 X를 누르면 트레이로 숨겨져 기존 코드가 계속 실행된다.
대화에서 이미 동의한 생성 범위를 다시 물을 필요는 없지만, 서비스가 별도 양식을 요청할 때는
앱이 지원하는 양식은 질문 카드로 처리한다. 실패한 배치를 무조건 재제출하거나 승인 범위를 넘겨 생성하지 않는다.

실제 재개 결과: granular 정책이 적용된 대화에서도 첫 Comfy 배치는 `spend.unconfirmed`로
시간 초과됐다(작업 없음). 서비스가 수동 동의 경로를 등록한 뒤 이미 승인받은 범위에서
`confirm:true`를 다시 전달하자 3장 모두 완료됐다. 총 Comfy 이미지 4장과 Tripo 다중 입력
모델 1개를 생성하고 Blender 스프라이트까지 제작했다. 실제 생성 경로 성공과 native 승인창의
안정성은 구분한다. 첫 요청의 실제 서비스 시간 초과 원인이 모두 해결됐다고 단정하지 않는다.
기록: `E:/ProjectAnalysis/ArtLibrary/classic-prerender/experiments/003_comfy_tripo_items/README.md`.

검증: `poc-mcp-elicitation-native.mjs`의 실제 Codex 정책/응답 7가지,
`poc-mcp-elicitation.mjs`의 실제 어댑터·입력·큐·만료 검사,
`poc-mcp-elicitation-ui.mjs`의 실제 renderer/reducer/preload/IPC + Chromium 포인터 승인/거절,
닫기·만료·기본값 비승인 확인. 숨긴 별도 Electron 창에서 진행했고 실제 유료 도구 호출은 0회다.
결과는 `.dev-home/mcp-elicitation-verification/`에 보관한다.

프로토콜 근거: [OpenAI 공식 App Server 문서](https://learn.chatgpt.com/docs/app-server#mcp-server-elicitation-requests),
실제 설치본이 생성한 `McpServerElicitationRequestParams`/`Response` 및 `AskForApproval` 스키마.

## 현재 권장 연결: API Key (2026-09-08)

반복 이미지 제작에는 **설정 → ComfyCloud → 키 저장 · 연결 확인**을 사용한다.
[Comfy Platform](https://platform.comfy.org/profile/api-keys)에서 발급한 `comfyui-` 키를
앱 입력란에 넣는다. 브라우저 OAuth 로그인과 별개이며 키를 대화에 전달하지 않는다.
저장 후 도구 목록과 잔액을 각각 검사한다. 도구 연결 성공과 결제 API 성공은 별개로 표시한다.
새 설정 화면이 없는 실행본은 앱을 한 번 다시 실행해야 한다.

키는 기존 Keys 보관함에 Windows DPAPI로 암호화하고, 공용 MCP 설정은
`X-API-Key: ${COMFY_API_KEY}` 참조만 저장한다. Claude와 Codex 자식 프로세스에
같은 키를 주입한다. 키 변경은 기존 MCP 지문에 반영되어 **다음 메시지**에서
Codex 프로세스를 교체한다. 실행 중인 턴의 도구 목록을 즉시 바꾸지는 않는다.
기존 OAuth 저장소를 삭제하거나 복사하지 않는다.

### 확인된 문제와 변경

- 실제 생성 준비에서 native OAuth 갱신이 `auth-required / revoked`로 실패했다.
  폐기 원인 전체를 단정하지 않는다. 앱 재시작마다 로그인해야 하는 정상 규칙은 아니다.
- 기존 MCP 설정의 브라우저 로그인은 `mcpOAuth.ts`의 Claude용 보관소/계정 폴더를
  갱신했다. Codex 대화 및 잔액 조회가 읽는 native Codex 저장소와 별개였다.
  해당 UI의 연결 표시를 Codex 인증 성공으로 해석할 수 없었다.
- OAuth 잔액 조회는 만료 때 별도 Codex app-server를 띄워 갱신한다.
  이 경로는 최대 55초 제한이며, 이후 결제 GET도 최대 15초가 걸릴 수 있었다.
  API Key 경로에서는 Codex 계정 열거·인증 복호화·갱신 프로세스를 호출하지 않는다.
- **Codex 0.153.4 실물 재현:** 폐기된 OAuth를 남긴 상태에서 `env_http_headers`에
  X-API-Key만 추가하면 `authenticationRequired`가 됐다. 따라서 Codex에는 같은 키의
  `bearer_token_env_var = COMFY_API_KEY`도 지정한다. 수정 후 새 프로세스 2개에서
  MCP 도구 호출 성공, OAuth 요청 0회를 확인했다. 로컬 모의 서버 수치는 Cloud 지연 측정이 아니다.
- 잔액·구독 상태·작업 공간 조회 세 개를 모두 기다리던 것을 수정했다.
  유효한 잔액이 먼저 오면 부가 정보는 최대 250ms만 더 기다린다. 부가 GET은 2.5초 제한.
  0원/마이그레이션 응답 판별에 상태가 필요하면 해당 응답을 기다린다.
- 키만 Keys에 저장하고 대화 MCP에 연결하지 않은 상태를 정상으로 표시하지 않는다.
  참조 키가 삭제됐을 때 다른 OAuth 계정으로 조용히 전환하지 않는다.
- API Key 연결에서는 MCP 목록의 OAuth 로그인 버튼/배지를 표시하지 않는다.
  MCP 도구 확인은 initialize → initialized → tools/list이며 생성 작업은 호출하지 않는다.

API Key가 서비스 자체의 HTTP 500이나 네트워크 지연까지 해결하는 것은 아니다.
기존 읽기 전용 재시도·마지막 잔액 표시 정책은 유지한다. 표시 단위는 크레딧이며 LLM 토큰이 아니다.

근거: [Comfy 공식 MCP 안내](https://docs.comfy.org/agent-tools/mcp),
[Codex 공식 MCP 설정](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
Comfy는 X-API-Key와 Bearer API Key를 모두 문서화하고 있다.

검증 실행기:

- `node scripts/poc-comfy-api.mjs`: 등록·동일 키 주입·비밀값 제외·교체·끄기·충돌·SSE·페이지 조회.
- `node scripts/poc-comfy-api-native.mjs <codex.exe>`: 실제 0.153.4 재시작/도구 호출, 폐기 OAuth 우회.
- `node scripts/poc-service-credits.mjs`: 잔액 28개 계약/회귀 검사, 느린 부가 정보·인증 분리 포함.
- `node scripts/poc-comfy-api-ui.mjs`: 격리된 숨김 Electron에서 실제 UI 이벤트·IPC·DPAPI·재시작 검사.

검증 결과는 `.dev-home/comfy-api-verification`에 보관한다. 모의 서비스/가짜 키로 검사하므로
사용자 API Key의 실제 Cloud 인증·잔액·도구 실행 성공은 키 등록 후 별도 확인해야 한다.
2026-09-08 최종 로컬 검증: 등록/프로토콜 8개, 잔액 28개, native Codex 2회 새 실행과
실제 MCP 호출 2회, Electron 2회 실행에서 키 재사용을 통과했다. UI는 숨긴 창의 DOM 이벤트로
실제 renderer/preload/IPC를 검사했으며 OS 포인터 입력 검사는 아니다. Windows DPAPI를 사용했고,
실행 사이에는 정상 종료로 Chromium Local State를 저장했다. 가짜 키는 검사 후 제거했다.
`npm run typecheck`, `npm run build` 통과. 빌드의 기존 큰 청크 경고는 유지된다.
아래 OAuth 기록은 이전 구현과 조사 이력이다.

### 입력란 클릭/입력 불가 수정 (2026-09-08)

ComfyCloud 화면이 갱신됐지만 이전 preload가 실행 중인 조합에서
`window.api.comfy`가 없고 입력란의 `disabled`가 true인 상태를 재현했다.
기존 코드는 연결 모듈 존재 여부를 키 입력 가능 여부에도 묶었다.
입력란은 실제 저장/조회 처리 중에만 잠그고, 연결 모듈이 없을 때의 저장은
명시적인 재실행 안내로 처리한다. 이때 저장 성공으로 표시하거나 키를 따로 기록하지 않는다.

앱의 창 X는 종료가 아니라 트레이 숨기기다. 안내를 **트레이 아이콘 우클릭 → 종료 → 다시 실행**으로
구체화했다. 새 main/preload를 적용하려면 이 정상 종료가 한 번 필요하다.

`poc-comfy-api-ui.mjs`는 이전 preload를 재현하는 단계와 실제 Chromium 마우스 이벤트로
입력란을 클릭하고 `Input.insertText`로 타이핑하는 검사를 추가했다. DOM value 직접 대입으로
입력 검사를 대신하지 않는다. 포커스·입력·저장/조회·정상 재실행 후 키 재사용을 검사하며,
Windows OS SendInput/창 이동 영역 검사는 별도다. 실제 키/클립보드 내용은 읽지 않는다.

## 적용 범위

AgentCodeGUI의 `~/.agentcodegui/mcp.json`에 다음 서버를 등록한다.
앱 등록 서버는 프로젝트별 `.mcp.json`과 별개로 모든 대화에 적용된다.

```json
{
  "servers": {
    "comfy-cloud": {
      "type": "http",
      "url": "https://cloud.comfy.org/mcp"
    }
  }
}
```

기존 `servers` 항목은 보존하고 `disabled`에서 `comfy-cloud`만 제거한다.
설정 → MCP에서도 같은 공용 항목을 관리할 수 있다.

`src/main/mcp.ts`의 `codexAppMcpConfig()`가 이 설정을 Codex의
`thread/start`와 `thread/resume`에 주입한다. `mcpSpawnFingerprint()` 변경은
기존 대화의 다음 실행에서 Codex 프로세스를 다시 시작하게 한다.
현재 실행 중인 턴의 도구 목록은 등록만으로 바뀌지 않는다.

## 인증

Claude용 플러그인 설치와 Codex 인증은 별개다. Comfy의 공식 Streamable HTTP
MCP와 Codex의 기본 OAuth 저장·갱신 기능을 사용한다. URL 등록만으로 로그인되지는 않는다.

앱이 사용하는 계정별 `CODEX_HOME`으로 아래 명령을 실행한다.
서버 주소를 인자로 주는 이유는 앱 공용 등록이 CLI의 `config.toml`에 직접 기록되지 않기 때문이다.

```text
codex -c 'mcp_servers.comfy-cloud.url="https://cloud.comfy.org/mcp"' mcp login comfy-cloud
```

출력된 링크를 브라우저에서 열고 작업 공간을 선택해 인증을 마친다.
현재 Codex 계정의 모든 프로젝트·대화에서 이 인증을 사용하며 갱신은 Codex가 관리한다.
다른 Codex 계정을 새로 추가할 경우 그 계정의 인증 상태도 확인해야 한다.
OAuth URL과 토큰은 문서·검증 로그에 저장하지 않는다.

## 검증과 관찰

2026-09-08: 공용 목록에 Tripo만 등록돼 있고 Comfy는 Claude 플러그인에만 있었다.
`comfy-cloud` 공용 HTTP 항목을 추가했다. 변경 전 설정 백업은 앱 홈의
`mcp.json.before-comfy-<timestamp>`에 보관했다.

기존 Claude의 `comfy-cloud` OAuth 레코드를 Codex 0.153.4의 파일 저장 형식으로
가져왔으나 실제 Codex 실행 결과는 `authenticationRequired`였다.
만료된 레코드가 존재한다는 사실을 정상 연결로 간주하지 않는다.
이 경우 Codex에서 새 OAuth 인증을 진행해야 한다.
이번 설정에서는 새 OAuth 로그인이 성공했고, 별도로 시작한 Codex 검증 프로세스가
저장된 인증을 읽어 다음 두 대화 모두에서 `connected`, `oAuth`, 도구 41개를 확인했다.

- `E:/ProjectAnalysis`
- `D:/GameMaker/AgentCodeGUI`

새로운 모델 턴과 생성 요청은 0회다. 기존 대화는 다음 메시지 실행부터 공용 설정을 읽는다.

아래 검증기는 실제 Codex app-server에 서로 다른 프로젝트의 빈 대화 두 개를
만들고 MCP 상태와 도구 목록을 확인한다. 모델 턴이나 이미지 생성은 요청하지 않는다.

```text
node scripts/verify-comfy-cloud.mjs <앱의-Codex-계정-홈> <codex.exe>
```

성공 결과는 `.dev-home/comfy-verification/connection-results.json`에 저장한다.

공식 연결 안내: <https://docs.comfy.org/agent-tools/mcp>
Codex 인증 저장 형식 확인에 사용한 소스:
<https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/rmcp-client/src/oauth.rs>

## 잔액 표시와 단위 검증

설정 → 계정 및 대화 아래 컨텍스트 팝오버에서 Tripo/ComfyCloud 잔액을 조회한다.
Tripo 설정에도 해당 잔액을 표시한다. 계정 전체의 잔액으로, 대화별 사용량과 구분한다.
기본 캐시는 60초이며 수동 새로고침을 제공한다. 인증이 바뀌거나 거절되면 예전 계정 잔액을 지운다.
일시적 조회 실패 때는 마지막 성공값과 확인 시각을 유지하며 오래된 값임을 표시한다.

2026-09-08 오류 수정: `billing/balance`의 `*_micros`라는 필드명과 comfy-cli의 계산을
따라 micro-USD로 처리해 7.45로 잘못 표시했다. 사용자의 Cloud 화면 74,502와 대조한 결과,
실제 Cloud 프런트엔드 `UserCredit.vue`는 같은 값을 `formatCreditsFromCents`에 직접 넣는다.
따라서 이 앱도 **Math.round(잔액 원본 × 211 / 100)**을 사용한다.
실측 원본 35308.8688168805 → 74,502 크레딧. 단순히 잘못 표시된 7.45에 배수를 곱하지 않는다.
수정 후 실제 API 재조회와 UI에서 ComfyCloud 74,502, Tripo 24,870을 확인했다.

기준 소스:
- <https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/src/components/common/UserCredit.vue>
- <https://github.com/Comfy-Org/ComfyUI_frontend/blob/main/packages/shared-frontend-utils/src/creditsUtil.ts>

Codex 0.153.4의 암호화된 MCP 인증은 메인 프로세스 안에서만 읽는다. 만료 시 Codex가 직접
갱신하도록 하며 `mcp_oauth_refresh_coordination`을 대화와 조회 프로세스에 활성화한다.
이는 해당 버전의 개발 중 기능이다. 동시에 여러 창이 같은 회전형 refresh token을 소비하는
문제를 재현하는 모의 OAuth 서버로 두 프로세스가 갱신 1회, 재사용 거절 0회로 연결됨을 검증했다.
모의 테스트의 첫 SQLite 초기화 경쟁은 공유 DB를 먼저 준비해 실제 OAuth 경쟁과 분리했다.

검증 명령:
- `node scripts/poc-service-credits.mjs` (단위/캐시/인증 격리 검증, 화면 74,502 회귀 사례 포함)
- `node scripts/poc-comfy-refresh-coordination.mjs <codex.exe>` (가짜 인증만 사용)
- `scripts/check-service-credits-live.cjs` (숨긴 Electron에서 실제 읽기 전용 잔액 조회)

대화별 생성 사용 내역은 [작업 기록](work-history.md)을 참고한다.

## 재시작 시 재로그인 안내 수정 (2026-09-08)

앱 실행마다 브라우저 로그인이 필요한 설계가 아니다. 저장된 인증을 재사용하고,
짧은 access token은 native Codex의 refresh token으로 갱신한다.
이번 실제 계정 점검에서는 저장된 갱신 인증을 서버가 거절해 한 번 새 OAuth 인증을 진행했다.
새 로그인 뒤 별도 프로세스에서 기존 저장소를 읽어 잔액 74,502와 MCP 도구 연결을 확인했다.

앱 코드에서도 두 가지 문제를 수정했다.

- MCP 시작을 5초만 기다리고, 지연·실행 실패까지 모두 재로그인으로 분류하던 것을 수정했다.
  시작 중/목록 미준비는 기다리고, 네트워크·프로세스·시간 초과는 일시적 조회 실패로 표시한다.
  서버가 실제 갱신 인증을 거절한 경우에만 재로그인을 안내한다.
- 시작 시간 초과 직후 조회용 프로세스를 강제 종료하면 회전형 토큰 응답의 저장을 끊을 수 있다.
  연결 성공/인증 거절이 확정되지 않은 실패에는 native 갱신 트랜잭션이 끝날 유예 시간을 둔다.
  강제 종료 대상은 이 조회 함수가 만든 자식 프로세스뿐이다.

추가 검증:

- `node scripts/poc-comfy-reconnect.mjs`: 10개 재연결/오류 분류 검증.
- `node scripts/poc-service-credits.mjs`: 16개 잔액 계약 검증. 일시적 갱신 실패에서
  재로그인을 요청하지 않는 회귀 사례 포함.
- `node scripts/poc-comfy-refresh-coordination.mjs <codex.exe> --native-store`:
  가짜 OAuth 로그인으로 실제 OS 암호화 저장소를 만들고, native Codex 프로세스 두 개가
  이를 다시 읽는다. 두 차례 연속 토큰 만료 구간을 지나며 실제 MCP 호출을 병행했다.
  시작 갱신 1회 + 후속 갱신 2회, 재사용 거절 0회. 실제 계정/유료 생성은 사용하지 않는다.
  파일 저장 방식에서도 같은 반복 갱신 검증을 통과했다.

## 잔액 HTTP 500 처리 (2026-09-08)

재로그인 복구 후 사용자가 `잔액 조회 실패 (HTTP 500)`를 보고했다. 해당 문구는
`/api/billing/balance`가 실패할 때 표시된다. 점검 시 기존 OAuth로 MCP 서버 정보와
결제 내역 조회가 정상 동작했고, REST 잔액 조회 두 번 및 실제 앱 조회 함수가 모두
HTTP 200 / 74,502 크레딧을 반환했다. 추가 로그인이나 API 키 전환은 하지 않았다.
보고 시점의 서버 응답 원문은 보관하지 않았으므로 서버 내부의 구체적인 원인은 확인하지
못했다. 관찰 결과는 잔액 서버의 일시적 실패와 일치하며, API 키가 필수라는 근거는 아니다.
공식 MCP 안내는 OAuth와 `X-API-Key` 방식을 모두 지원한다.

기존 앱은 첫 실패를 즉시 표시하고, 실패 결과도 성공과 같은 60초 동안 캐시했다.
읽기 전용 계정 GET 요청에만 다음 처리를 추가했다. 생성 요청에는 적용하지 않는다.

- HTTP 500/502/503/504 및 네트워크 실패는 0.5초, 1.5초 간격으로 최대 두 번 더 조회한다.
  재시도 전체가 기존 15초 요청 제한을 공유한다.
- 401/403은 재시도하지 않고 인증 오류로 처리한다. 다른 4xx도 반복하지 않는다.
- 서버 오류가 계속되면 서비스 이름과 HTTP 상태를 표시하고, 같은 인증으로 확인했던
  마지막 잔액과 확인 시각을 오래된 값으로 유지한다. 서버 응답 원문/토큰은 전달하지 않는다.
- 일시적 실패 캐시는 5초만 유지한다. 잠시 후 화면을 다시 열면 재조회할 수 있다.

`node scripts/poc-service-credits.mjs`: 24개 검증 통과. 500→성공 자동 복구,
지속 오류의 재시도 상한, 짧은 오류 캐시, 네트워크 복구, 전체 시간 제한,
인증 거절·요청 제한에서 재시도하지 않는 사례를 포함한다.
