# 커스텀 포크 3.2.5

원본 `UnrealFactory/AgentCodeGUI`의 3.2.5(`e70a64c`)에 이 포크의 ComfyCloud, Tripo, MCP·Keys 관리, 서비스 잔액, 생성 작업 기록을 이식했습니다. 원본의 Tauri/Rust 전환과 새 대화·계정·외부 도구 기능을 함께 사용합니다. 원본 GitHub에서 받는 설치 파일에는 포크 기능이 없으므로, 이 소스로 빌드한 설치 파일을 사용하세요.

## 실행과 데이터

새 앱은 `AgentCodeGUI3.exe`, 기본 데이터 폴더는 `%USERPROFILE%\.agentcodegui3`입니다. Electron 2.6.2의 `.agentcodegui` 데이터와 실행 파일은 그대로 보관합니다. 새 폴더를 아직 만들지 않은 경우 다음 명령으로 기존 대화·계정·암호화 키·설치 엔진을 복사할 수 있습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/migrate-fork-home.ps1
```

이전 데이터는 삭제하지 않으며 이미 존재하는 목적지는 덮어쓰지 않습니다. 원본 앱을 종료한 상태에서 복사하면 마지막 대화까지 포함됩니다. 새 앱의 첫 실행에서 복사한 대화를 `chats-v3` 형식으로 변환합니다. 계정의 공유 폴더 연결은 새 앱이 다시 만듭니다. Electron 전용 창 배치·브라우저 로컬 저장소는 별도이며 새 화면의 기본값으로 시작할 수 있습니다.

현재 앱을 닫을 때 트레이에 남을 수 있으므로 종료 메뉴로 끝낸 후 새 앱을 실행하세요. 이전 버전으로 돌아갈 때는 남겨 둔 Electron 실행본과 `.agentcodegui`를 사용합니다. 새 버전에서 만든 대화는 자동으로 이전 버전에 역이전되지 않습니다.

## 빌드

Windows x64, Visual Studio C++ 빌드 도구, Rust MSVC와 Node/npm이 필요합니다.

```powershell
npm ci --ignore-scripts
npm run tauri:build:unsigned
```

`target/release/bundle/nsis/AgentCodeGUI3_3.2.5_x64-setup.exe`가 생성됩니다. 로컬 설치용이며 원본의 업데이트 서명 키를 사용하지 않습니다. 원본 설치 파일이 커스텀 기능을 덮어쓰지 않도록 이 포크는 원본 자동 업데이트를 차단하고 설정에서 포크 저장소를 안내합니다. 이후 원본 변경도 소스로 병합하고 검증해서 배포해야 합니다. 별도 서명된 포크 업데이트 채널은 아직 구성하지 않았습니다.

루트 `package.json`과 `npm run dev`는 원본에 남아 있는 Electron 개발 경로입니다. 3.x 화면은 `app/src`, 네이티브 앱은 `src-tauri`, 개발 실행은 리소스를 준비한 뒤 `npm run tauri:dev`를 사용합니다. `npm run app:build`가 커스텀 서비스도 함께 빌드합니다.

## 커스텀 기능의 연결 위치

| 기능 | 구현 |
|---|---|
| MCP 등록·가져오기·OAuth, Keys, ComfyCloud, Tripo, 잔액 | 기존 `src/main` 서비스를 `src/custom/service.ts`에서 재사용합니다. |
| 네이티브 연결·키 암호화 | `src-tauri/src/custom.rs`의 비공개 Node 작업 프로세스와 Windows DPAPI 호환 코덱입니다. 키 값은 화면 IPC로 반환하지 않습니다. |
| Claude·Codex 실행 설정 | `engine/any.rs`와 Codex thread 설정에 MCP·키를 전달합니다. 설정 변경 시 다음 메시지에서 프로세스를 갱신하고 대화는 이어집니다. |
| MCP 동의 양식 | Codex 서버 요청을 기존 검증된 변환기로 처리합니다. 응답 전에는 실행하지 않으며 명시적인 거절·취소를 보존합니다. |
| 생성 작업 기록 | 출력 미리보기 생략 전에 필요한 도구 결과를 수집하고 키를 제거합니다. 원본 출력·서비스 보고 사용량을 기록하며 새 대화 저장소에 복원합니다. |
| Codex 엔진 설치 | 플랫폼 실행 파일까지 확인하고 누락된 선택적 의존성을 다시 받습니다. 불완전한 설치는 성공으로 표시하지 않습니다. |
| Tripo 실행 파일 | 공식 CLI 0.3.1과 호환 브리지를 `custom-runtime`에 포함합니다. 설치 이동 후 경로를 갱신하고 비활성화 상태를 보존합니다. |

## 검증 명령

```powershell
npm run typecheck:app
npm run typecheck:node
cargo test -p ccg-engine --lib --locked
cargo test -p agentcodegui --bin agentcodegui --locked --features custom-protocol
node scripts/poc-work-records.mjs
node scripts/poc-fork-services.mjs
node scripts/poc-fork-native-ui.mjs
```

엔진 단위 테스트 117개와 네이티브 앱 단위 테스트 213개가 통과했습니다(별도 자식 프로세스용 테스트 2개는 설계상 제외). 커스텀 서비스 검증은 14개입니다.

화면 검증은 별도 `CCG_HOME`에서 실제 화면·IPC·Windows 암호화·대화 이전·재실행을 확인하며 원래 실행 중인 앱을 종료하지 않습니다. 설치본을 검사할 때는 마지막 두 스크립트에 설치된 exe의 절대 경로를 전달합니다. 서비스 HTTP 검증은 고정 응답과 가짜 키를 사용합니다. 실제 유료 이미지·3D 생성은 이 업데이트 검증에서 실행하지 않았습니다.

설치 리소스 경로의 Windows `\\?\` 접두사는 Node 진입점에서 오류를 일으켜 정상 경로로 변환했습니다. JSON IPC가 선택 인자의 `undefined`를 `null`로 바꾸는 차이도 서비스 경계에서 처리합니다. 이런 배포 차이는 TypeScript 타입 검사만으로 잡히지 않으므로 설치본 화면 검증을 유지합니다.
