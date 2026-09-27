//! AgentStudio — 생성 게이트웨이(studio/services/gen-gateway)를 앱과 함께 띄우고 잇는다.
//!
//! - 앱이 켜질 때 `node cli.ts serve`를 띄운다. 표준 입력 파이프를 이 프로세스가 쥐고 있어서
//!   앱이 어떤 식으로 끝나든 파이프가 닫히고, 게이트웨이는 그걸 보고 스스로 종료한다.
//! - 엔진(Claude · Codex)에 붙일 MCP 중계기 정의를 `CCG_STUDIO_MCP` 환경변수로 알린다
//!   (`ccg_engine::studio`가 읽는다).
//! - 렌더러는 `studio:gateway-info`로 접속 정보(port · token)를 받아 로컬 API에 직접 붙는다.
//!
//! Node는 원본 LSP가 쓰는 것과 같은 해석(`ccg_lsp::launch::node_exe`)을 따른다 — 설치본에 함께
//! 실린 node.exe → 개발 스테이징 → PATH.
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const MCP_NAME: &str = "agentstudio-gen";
static GATEWAY: Mutex<Option<Child>> = Mutex::new(None);

/// Windows 확장 경로(`\\?\D:\…`)를 보통 경로로 — Node는 진입 파일이 이 형태면 실제 경로를 풀다 실패한다
/// ('EISDIR lstat D:'). Tauri의 resource_dir가 이 형태를 돌려준다. UNC(`\\?\UNC\…`)는 그대로 둔다.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC\\") => PathBuf::from(rest),
        _ => p,
    }
}

/// 게이트웨이 소스 폴더 — 설치본은 resources/gen-gateway, 개발 실행은 저장소의 studio/services/gen-gateway
fn gateway_dir(app: &AppHandle) -> Option<PathBuf> {
    let bundled = app.path().resource_dir().ok().map(|d| plain(d).join("gen-gateway"));
    // `..`을 넣으면 Node가 진입 파일의 실제 경로를 풀다 실패한다(Windows · 'lstat D:') — 부모를 직접 구한다
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().map(|repo| repo.join("studio").join("services").join("gen-gateway"));
    [bundled, dev].into_iter().flatten().find(|d| d.join("src").join("cli.ts").is_file())
}

fn log_line(msg: &str) {
    let dir = ccg_store::app_home().join("studio");
    let _ = std::fs::create_dir_all(&dir);
    let unix = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("app-gateway.log")) {
        let _ = writeln!(f, "[{unix}] {msg}");
    }
}

/// 앱 부팅 때 한 번. 실패해도 앱은 그대로 뜬다(생성 기능만 "연결 안 됨"으로 보인다).
pub fn start(app: &AppHandle) {
    if std::env::var("CCG_STUDIO_NO_GATEWAY").is_ok() {
        return;
    }
    let Some(dir) = gateway_dir(app) else {
        log_line("게이트웨이 소스를 찾지 못했어요");
        return;
    };
    let Some(node) = ccg_lsp::launch::node_exe().map(plain) else {
        log_line("Node 실행 파일을 찾지 못했어요");
        return;
    };
    let home = plain(ccg_store::app_home());
    let mcp = dir.join("src").join("mcp.ts");
    // 엔진이 대화를 띄울 때 붙일 MCP 중계기 정의 — 게이트웨이와 같은 데이터 폴더를 가리킨다
    let def = json!({
        "name": MCP_NAME,
        "command": node.to_string_lossy(),
        "args": ["--no-warnings", mcp.to_string_lossy()],
        "env": { "CCG_HOME": home.to_string_lossy() }
    });
    std::env::set_var(ccg_engine::studio::ENV, def.to_string());

    let _ = std::fs::create_dir_all(home.join("studio"));
    let stderr = std::fs::OpenOptions::new().create(true).append(true).open(home.join("studio").join("gateway.log")).map(Stdio::from).unwrap_or_else(|_| Stdio::null());
    let mut cmd = Command::new(&node);
    cmd.arg("--no-warnings")
        .arg(dir.join("src").join("cli.ts"))
        .arg("serve")
        .env("CCG_HOME", &home)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(stderr);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.spawn() {
        Ok(child) => {
            log_line(&format!("게이트웨이 시작 pid={} node={} src={}", child.id(), node.display(), dir.display()));
            if let Ok(mut g) = GATEWAY.lock() {
                *g = Some(child);
            }
        }
        Err(e) => log_line(&format!("게이트웨이 실행 실패: {e}")),
    }
}

/// 키를 바꾼 뒤 등 — 게이트웨이를 다시 띄운다(표준 입력을 닫으면 스스로 정리하고 끝난다).
fn restart(app: &AppHandle) -> Value {
    if let Ok(mut g) = GATEWAY.lock() {
        if let Some(mut child) = g.take() {
            drop(child.stdin.take());
            // 정리할 시간(최대 3초)을 준 뒤에도 살아 있으면 끝낸다
            for _ in 0..30 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            let _ = child.kill();
        }
    }
    start(app);
    json!({ "ok": true })
}

/// 렌더러용 접속 정보 — 게이트웨이가 쓴 gateway.json. 아직 안 떴으면 null.
fn info() -> Value {
    match ccg_store::read_home_json("studio/gateway.json") {
        Some(v) if v.get("port").is_some() && v.get("token").is_some() => json!({ "port": v["port"], "token": v["token"] }),
        _ => Value::Null,
    }
}

pub fn dispatch(app: &AppHandle, channel: &str) -> Option<Value> {
    match channel {
        "studio:gateway-info" => Some(info()),
        "studio:gateway-restart" => Some(restart(app)),
        _ => None,
    }
}
