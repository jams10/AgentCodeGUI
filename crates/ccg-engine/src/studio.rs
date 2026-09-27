//! AgentStudio — 생성 게이트웨이 MCP를 엔진 실행에 끼워 넣는다.
//!
//! 앱(`src-tauri/src/studio.rs`)이 게이트웨이를 띄운 뒤 `CCG_STUDIO_MCP`에 MCP 서버 한 개의
//! 정의(JSON: `{name, command, args, env}`)를 넣는다. 여기서는 그 값을 읽어
//! Claude에는 `--mcp-config`로, Codex에는 `thread/start`의 `config.mcp_servers`로 넘긴다.
//! 계정마다 격리된 설정 폴더(CLAUDE_CONFIG_DIR · CODEX_HOME)를 건드리지 않아도 모든 계정에 붙는다.
//! 환경변수가 없으면 아무것도 하지 않는다 — 원본 동작과 같다.
use serde_json::{json, Value};

pub const ENV: &str = "CCG_STUDIO_MCP";

/// Codex는 도구 호출 제한 시간이 짧다 — 생성 도구는 사용자 승인 + 생성 시간만큼 기다린다.
const TOOL_TIMEOUT_SEC: u64 = 40 * 60;

fn env() -> Option<String> {
    std::env::var(ENV).ok()
}

fn server(raw: Option<String>) -> Option<(String, Value)> {
    let v: Value = serde_json::from_str(&raw?).ok()?;
    let name = v.get("name")?.as_str()?.to_string();
    let command = v.get("command")?.as_str()?;
    if name.is_empty() || command.is_empty() {
        return None;
    }
    let spec = json!({
        "command": command,
        "args": v.get("args").cloned().unwrap_or_else(|| json!([])),
        "env": v.get("env").cloned().unwrap_or_else(|| json!({})),
    });
    Some((name, spec))
}

/// Claude CLI에 붙일 인자(`--mcp-config <json>`). 사용자 MCP 설정은 그대로 두고 더한다.
pub fn claude_args() -> Vec<String> {
    claude_args_from(env())
}

fn claude_args_from(raw: Option<String>) -> Vec<String> {
    match server(raw) {
        Some((name, spec)) => vec!["--mcp-config".into(), json!({ "mcpServers": { name: spec } }).to_string()],
        None => vec![],
    }
}

/// Codex `thread/start` 설정에 게이트웨이 MCP를 더한다. 같은 이름이 이미 있으면 덮지 않는다.
pub fn codex_config(config: &mut Value) {
    codex_config_from(config, env())
}

fn codex_config_from(config: &mut Value, raw: Option<String>) {
    let Some((name, mut spec)) = server(raw) else { return };
    spec["tool_timeout_sec"] = json!(TOOL_TIMEOUT_SEC);
    spec["startup_timeout_sec"] = json!(20);
    if !config.is_object() {
        *config = json!({});
    }
    let servers = config.as_object_mut().unwrap().entry("mcp_servers").or_insert_with(|| json!({}));
    if let Some(m) = servers.as_object_mut() {
        m.entry(name).or_insert(spec);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEF: &str = r#"{"name":"agentstudio-gen","command":"node.exe","args":["mcp.ts"],"env":{"CCG_HOME":"C:\\h"}}"#;

    #[test]
    fn nothing_without_definition() {
        assert!(claude_args_from(None).is_empty());
        assert!(claude_args_from(Some("not json".into())).is_empty());
        let mut c = json!({ "x": 1 });
        codex_config_from(&mut c, None);
        assert_eq!(c, json!({ "x": 1 }));
    }

    #[test]
    fn claude_gets_mcp_config_json() {
        let a = claude_args_from(Some(DEF.into()));
        assert_eq!(a[0], "--mcp-config");
        let cfg: Value = serde_json::from_str(&a[1]).unwrap();
        assert_eq!(cfg["mcpServers"]["agentstudio-gen"]["command"], "node.exe");
        assert_eq!(cfg["mcpServers"]["agentstudio-gen"]["env"]["CCG_HOME"], "C:\\h");
    }

    #[test]
    fn codex_adds_server_without_overwriting_user_one() {
        let mut c = json!({ "mcp_servers": { "mine": { "command": "x" } } });
        codex_config_from(&mut c, Some(DEF.into()));
        assert_eq!(c["mcp_servers"]["mine"]["command"], "x");
        assert_eq!(c["mcp_servers"]["agentstudio-gen"]["args"], json!(["mcp.ts"]));
        assert_eq!(c["mcp_servers"]["agentstudio-gen"]["tool_timeout_sec"], 2400);

        let mut c = json!({ "mcp_servers": { "agentstudio-gen": { "command": "user" } } });
        codex_config_from(&mut c, Some(DEF.into()));
        assert_eq!(c["mcp_servers"]["agentstudio-gen"]["command"], "user");

        let mut c = Value::Null;
        codex_config_from(&mut c, Some(DEF.into()));
        assert_eq!(c["mcp_servers"]["agentstudio-gen"]["command"], "node.exe");
    }
}
