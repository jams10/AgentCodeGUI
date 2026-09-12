# Tripo 3D 연결

설정 → **Tripo**에서 국제 사이트 API 키를 입력하고 **키 저장 · MCP 등록**을 누릅니다. **저장한 키 연결 확인**은 잔액 GET 요청으로 인증만 확인합니다. 0 크레딧도 인증 성공이며, 생성 가능 여부는 잔액과 요청 비용에 따라 달라집니다. 키를 입력하기 전에 **MCP 등록**으로 도구만 등록할 수도 있습니다.

키는 기존 Keys 보관함의 `TRIPO_API_KEY`에 Windows DPAPI로 저장됩니다. Tripo 화면은 암호화를 사용할 수 없으면 저장하지 않습니다. MCP 설정 파일에는 키 참조만 들어갑니다. 삭제·변경은 설정 → Keys, MCP 끄기·삭제는 설정 → MCP에서 합니다. 저장한 키 원문을 조회하는 UI/IPC는 없습니다.

대화 예: “Tripo로 T 포즈의 판타지 전사를 만들고, 지정한 프로젝트의 raw 폴더에 GLB로 저장해 줘.” 모델을 Blender에서 리깅하려면 자동 리깅 처리 체인을 요청하지 않고 기본 모델을 내려받습니다. 이 앱 설정만으로 Blender 애드온이 설치되지는 않습니다.

## 구현과 재사용

| 역할 | 구현 |
|---|---|
| API 키·등록·인증 화면 | `src/renderer/src/components/TripoSettings.tsx` |
| 키 저장·등록·잔액 확인 | `src/main/tripo.ts` |
| 기존 암호화 보관함 | `src/main/secrets.ts` |
| Claude SDK 등록 | `src/main/mcp.ts` → `resolvedAppServers()` |
| Codex 등록 | `codexAppMcpConfig()` → `thread/start`/`thread/resume`의 `config.mcp_servers` |
| Codex 키·등록 변경 반영 | `mcpSpawnFingerprint()` 비교 후 다음 실행 경계에서 app-server 재시작 |
| 공식 서버 호환 처리 | `src/main/tripoMcpBridge.ts` |

공식 npm 패키지 `tripo-cli@0.3.1`을 정확한 버전으로 앱에 포함하고 lockfile에 무결성 정보를 고정했습니다. 별도 전역 Node.js·npm 설치 없이 앱의 Electron 실행 파일을 `ELECTRON_RUN_AS_NODE=1`로 실행합니다. 패키징 시 CLI 의존성과 호환 스크립트를 ASAR 밖에 풉니다. 업데이트·이동 후 앱 시작 시 앱이 등록한 프리셋 경로만 갱신합니다. 사용자 서버와 이름이 충돌하면 덮어쓰지 않습니다.

등록된 도구는 `tripo_make`, `tripo_task_get`, `tripo_task_wait`, `tripo_balance`, `tripo_history`입니다. Codex에서 생성·다운로드 완료를 기다릴 수 있도록 이 프리셋의 도구 제한 시간을 1,800초로 설정합니다. CLI 작업 기록은 앱 홈의 `tools/tripo`에, 생성물은 도구 요청의 `output_dir`에 저장합니다.

Codex 변환 범위는 앱에서 등록한 stdio/HTTP 서버입니다. Claude용 플러그인 OAuth 토큰의 Codex 변환과 legacy SSE 변환은 이 작업에 포함하지 않습니다.

## 실패 기록과 검증

- 공식 CLI 0.3.1은 모르는 MCP 요청에 오류 응답을 보내지 않습니다. Codex의 기본 전체 상태 조회가 `resources/list` 등에서 기다리는 문제를 실측했습니다. 호환 스크립트가 빈 resources/templates/prompts 목록 및 알 수 없는 메서드 오류를 반환하며, 3D 관련 도구는 원본 공식 CLI로 전달합니다.
- `electron out/main/index.js`로 테스트 창을 시작하면 `app.getAppPath()`가 패키지 루트와 다릅니다. 프로젝트 루트에서 `electron .`로 시작해야 포함된 CLI와 다른 앱 자원을 찾습니다.
- API 키가 없을 때 인증 성공이라고 표시하지 않습니다. 테스트에 실제 사용자 키 또는 유료 생성 요청을 사용하지 않았습니다.
- `npm run typecheck`, `npm run build`: 통과.
- `node scripts/poc-tripo.mjs`: 보관함·충돌·오류·Electron 실행·MCP 도구·호환 처리 14개 검사 통과. 잔액 API는 loopback 모의 서버로 검증.
- `node scripts/poc-tripo-codex.mjs <codex.exe>`: 실제 Codex 0.153.4 새 스레드에서 도구 5개, 전체 상태 조회 connected, 비활성화 적용 확인. 모델 턴은 실행하지 않았으며 기존 스레드 재개는 실측하지 않았습니다.
- `node scripts/poc-tripo-ui.mjs`: 격리 앱에서 화면·IPC·실제 Windows DPAPI 저장, MCP/Keys 목록 반영, 테스트 키 삭제 확인.
- 기존 `poc-mcp-vault.mjs` 회귀 검사도 통과. 검증 결과 JSON/화면은 `.dev-home/tripo-verification/`에 보관합니다.

실제 Tripo 계정 인증과 모델 생성은 사용자가 키를 입력한 뒤 확인해야 합니다. 설치 프로그램으로 배포한 패키징 결과는 이번 개발 실행 검증과 별개입니다.

공식 근거: [Tripo CLI](https://developers.tripo3d.ai/en/docs/cli), [Tripo 인증](https://developers.tripo3d.ai/en/docs/authentication), [공식 CLI 저장소](https://github.com/vast-enterprise/Tripo-API-CLI), [Codex MCP 설정](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
