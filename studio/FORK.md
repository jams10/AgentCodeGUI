# AgentStudio 포크 운영

AgentStudio는 [UnrealFactory/AgentCodeGUI](https://github.com/UnrealFactory/AgentCodeGUI)의 포크입니다.
원본의 성능 개선과 업데이트를 계속 받으면서 우리 기능을 얹는 것이 목표라서,
**원본 파일은 최소한으로만 고치고 우리 코드는 따로 둡니다.**

## 브랜치

| 브랜치 | 역할 | 규칙 |
|---|---|---|
| `main` | 원본 main의 거울 | 직접 커밋 금지. 동기화 워크플로가 fast-forward만 합니다. |
| `studio/main` | AgentStudio 작업 브랜치 (기본 브랜치) | 기능 브랜치는 여기서 따고 여기로 머지합니다. |
| `sync/upstream-<sha>` | 원본 변경을 머지한 임시 브랜치 | 워크플로가 만들고 PR로 올립니다. |
| `custom/main`, `backup/*`, 태그 `archive/*` | 예전 작업 보관 | 건드리지 않습니다. |

리모트: `origin` = jams10/AgentCodeGUI, `upstream` = 원본(푸시 주소는 `DISABLED`로 막아 둠).

## 코드 배치

- 우리 코드는 모두 `studio/` 아래(서비스·스크립트), `app/src/studio/`(화면 — 렌더러 번들·타입체크 범위 안이어야 해서 여기), `crates/studio-*`(Rust)에 둡니다.
- 원본 파일을 고쳐야 하면 아래 **연결 지점** 목록에 추가하고, 그 자리에 `[studio hook]` 주석을 답니다.
  한 지점은 가능한 한 1~3줄로 유지합니다. 큰 파일(`Chat.tsx` 등)은 고치지 말고 감싸서 씁니다.
- `package.json`, `tauri.conf.json`처럼 원본이 자주 바꾸는 파일은 고치지 않습니다.
  앱 정체성은 `studio/tauri.studio.conf.json`을 Tauri `--config`로 병합해서 바꿉니다.

## 연결 지점 (원본 파일 수정 목록)

| 파일 | 내용 |
|---|---|
| `crates/ccg-store/src/lib.rs` `app_home()` | 기본 데이터 폴더 이름을 빌드 시 `CCG_DEFAULT_HOME_DIR`로 바꿀 수 있게 함. 없으면 원본과 같음. |
| `app/src/main.tsx` | 메인 창 루트를 `<App />` 대신 `<StudioRoot />`로 연다(import 1줄 + 렌더 1줄). |
| `app/src/App.tsx` `onOpenSettings` 아래 + import | 2줄 — 채팅이 설정 창을 열려 하면(사이드바 설정 버튼 · API 과금 가드) Studio 설정 공간으로 보낸다(`studioRouteSettings`). |
| `app/src/components/Settings.tsx` | 3줄 — import 1줄, 레일 목록을 `studioNav()`로 거름, API 탭 아래 `<StudioApiServices />`. 모두 `app/src/studio/settingsExt.tsx`. |
| `app/src/App.tsx` `<WelcomeState>` | `variant={cwd ? 'agent' : 'chat'}` 1줄 — 폴더 없는 대화는 일반 대화 문구(원본 SessionWindow와 같은 규칙). |
| `src-tauri/src/main.rs` | `mod studio;` 1줄 + setup에서 `studio::start()` 1줄(엔진 부팅 전) — 생성 게이트웨이 실행. |
| `src-tauri/src/ipc/mod.rs` `dispatch()` | 맨 앞 1줄 — `studio:*` 채널을 `src-tauri/src/studio.rs`로. |
| `crates/ccg-engine/src/lib.rs` | `pub mod studio;` 1줄. |
| `crates/ccg-engine/src/driver.rs` | Claude 인자에 1줄 — `crate::studio::claude_args()`(`--mcp-config`). |
| `crates/ccg-engine/src/codex/mod.rs` `thread_params()` | 1줄 — `crate::studio::codex_config()`(`config.mcp_servers`). |
| `.github/workflows/studio-upstream-sync.yml` | 새 파일(원본에 없음). |

새 파일(원본에 없음): `src-tauri/src/studio.rs`(게이트웨이 실행 · 접속 정보 IPC), `crates/ccg-engine/src/studio.rs`(엔진 MCP 주입).
두 엔진 모두 `CCG_STUDIO_MCP` 환경변수가 없으면 원본과 똑같이 동작한다.

## 생성 게이트웨이 (`studio/services/gen-gateway/`)

외부 생성 서비스(ComfyCloud · Tripo · Higgsfield)를 묶는 상주 프로세스. 원본 코드와 완전히 분리돼 있다.
사용법과 규칙은 [studio/services/gen-gateway/README.md](services/gen-gateway/README.md).

## Studio 화면 구조 (`app/src/studio/`)

- `StudioRoot.tsx` — 홈 런처 ⟷ 작업 공간 전환. 채팅 공간은 원본 `App`을 그대로 마운트하고(대화·엔진·모델 선택·컨텍스트·한도),
  홈으로 돌아가도 내리지 않고 숨긴다. 원본 App이 바뀌면 채팅은 자동으로 따라간다.
- `studio.css` — `html.studio-theme`에서 원본 CSS 변수를 Aero 값으로 덮는다(원본 CSS 수정 없음) + Studio 셸 스타일.
- `Launcher.tsx` · `spaces.tsx` — 버블 런처, LiveArea, 작업 공간 정의 표.
- `SettingsSpace.tsx` — 설정 공간. 원본 `SettingsModal`을 그대로 공간 본문으로 쓴다(홈에서 설정을 누르면 바로 열림).
  Claude · GPT 계정은 원본 Account, 생성 서비스 키는 API 탭 아래(`settingsExt.tsx`).

### 설정 정리 (원본 항목 중 뺀 것)

원본 코드는 그대로 두고 레일에서만 뺀다 — `settingsExt.tsx`의 `HIDDEN` 목록에서 지우면 되살아난다.

| 항목 | 뺀 이유 |
|---|---|
| External Tools | 내 프로그램을 대화에 잇는 개발자용 규격 안내. 게임 제작 공간을 만들 때 다시 검토. |
| Code (LSP) · Explorer | 파일 뷰어 코드 심볼 · 탐색기 숨김 필터 — 코딩 전용. |
| Updates | 원본(AgentCodeGUI) 릴리스 업데이트 · 패치노트 — Studio 빌드엔 맞지 않음. |
| (문구) `~/.agentcodegui3` | 원본에 고정된 데이터 폴더 이름 — 설정 공간이 화면 글자만 `~/.agentstudio`로 바꿔 보여 준다. |
| Display의 「유리」 구역 | Studio 테마가 배경을 칠해서 값이 효과가 없음(`SettingsSpace.tsx`가 제목 글자로 찾아 숨김). |
- `usage.tsx` — Claude(`getUsage`) · Codex(`codexAuth.accountsUsage`) 한도 패널. 외부 서비스 크레딧은 생성 게이트웨이 연결 후 채운다.

아직 원본 이름이 남아 있는 곳 (새 설계에서 연결 지점으로 처리 예정):
창 제목 `src-tauri/src/win.rs`, 트레이 툴팁 `src-tauri/src/tray.rs`, 탐색기 메뉴 `src-tauri/nsis/hooks.nsh`,
업데이트 스플래시 `src-tauri/src/updater.rs`.

## 빌드

```bash
node studio/scripts/build.mjs            # = build --unsigned
```

- 앱 이름 `AgentStudio`, 식별자 `com.jams10.agentstudio`, 데이터 폴더 `~/.agentstudio`로 빌드됩니다.
- 원본 빌드 스크립트(`scripts/tauri-build.mjs`)를 그대로 부르므로, 원본 빌드 과정이 바뀌어도 자동으로 따라갑니다.

## 원본 동기화

- `Studio · upstream sync` 워크플로가 매주 월요일 03:00(KST)에 돌고, Actions 탭에서 수동으로도 실행할 수 있습니다.
- 충돌이 없고 `typecheck:app`을 통과하면 `studio/main`으로 가는 PR을 엽니다.
- 충돌이 나면 충돌 파일 목록을 담은 이슈를 엽니다. 로컬에서 해결합니다:

```bash
git fetch upstream
git switch studio/main
git merge upstream/main
```
