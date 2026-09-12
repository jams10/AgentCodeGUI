//! Fork integrations reuse the tested TypeScript services through a private
//! stdin/stdout worker. Credentials never cross renderer IPC or command argv.
use serde_json::{json, Value};
use std::{collections::HashMap, io::{BufRead, BufReader, Read, Write}, process::{Child, ChildStdin, Command, Stdio}, sync::{Arc, Mutex, OnceLock, mpsc}, time::Duration};
use tauri::{AppHandle, Emitter, Manager};

pub const FORK_BUILD: bool = true;
static APP: OnceLock<AppHandle> = OnceLock::new();
static WORKER: Mutex<Option<Arc<Worker>>> = Mutex::new(None);
type Reply = Result<Value, String>;
struct Worker {
    child: Mutex<Child>,
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, mpsc::SyncSender<Reply>>>,
}
pub fn init(app: AppHandle) { let _ = APP.set(app); }

/// Called before Tauri initialization. The same native codec reads existing
/// Electron vault files, including its v10 prefix and per-user DPAPI key.
pub fn crypto_mode() -> bool {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some("--custom-crypto") { return false; }
    let mut input = String::new();
    if std::io::stdin().take(4 * 1024 * 1024).read_to_string(&mut input).is_err() { std::process::exit(1); }
    let result = match args.get(2).map(String::as_str) {
        Some("encrypt") => ccg_store::safe_storage::encrypt(&input),
        Some("decrypt") => ccg_store::safe_storage::decrypt(&input),
        _ => None,
    };
    match result { Some(text) => { print!("{text}"); }, None => std::process::exit(1) }
    true
}

fn worker() -> Result<Arc<Worker>, String> {
    let mut slot = WORKER.lock().map_err(|_| "Custom service lock failed")?;
    if let Some(worker) = slot.as_ref() {
        if worker.child.lock().map_err(|_| "Custom child lock failed")?.try_wait().map_err(|_| "Custom child status failed")?.is_none() { return Ok(worker.clone()); }
    }
    let app = APP.get().ok_or("Custom services have not initialized")?;
    let resources = app.path().resource_dir().map_err(|_| "Resource directory unavailable")?;
    // Node's entrypoint resolver mishandles verbatim Windows resource paths.
    let resources = std::path::PathBuf::from(resources.to_string_lossy().strip_prefix(r"\\?\").unwrap_or(&resources.to_string_lossy()));
    let packaged = resources.join("custom-runtime");
    let root = if packaged.join("service.cjs").is_file() { packaged } else { std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("custom-runtime") };
    if !root.join("service.cjs").is_file() { return Err("Custom service bundle is missing; run npm run custom:build".into()); }
    let staged_node = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("lsp-runtime/node.exe");
    let node = if resources.join("node.exe").is_file() { resources.join("node.exe") } else if staged_node.is_file() { staged_node } else { "node".into() };
    let mut cmd = Command::new(node);
    cmd.arg(root.join("service.cjs")).current_dir(&root)
        .env("CCG_CUSTOM_ROOT", &root).env("CCG_HOME", ccg_store::app_home())
        .env("CCG_CUSTOM_EXE", std::env::current_exe().map_err(|_| "App executable unavailable")?)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(if std::env::var("CCG_CUSTOM_DIAGNOSTICS").as_deref() == Ok("1") { Stdio::inherit() } else { Stdio::null() });
    #[cfg(windows)] { use std::os::windows::process::CommandExt; cmd.creation_flags(0x0800_0000); }
    let mut child = cmd.spawn().map_err(|_| "Could not start the custom service runtime")?;
    let input = child.stdin.take().ok_or("Custom service input unavailable")?;
    let output = child.stdout.take().ok_or("Custom service output unavailable")?;
    let worker = Arc::new(Worker { child: Mutex::new(child), input: Mutex::new(input), pending: Mutex::new(HashMap::new()) });
    let reading = worker.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
            if let Some(id) = value["id"].as_str() {
                if let Some(reply) = reading.pending.lock().ok().and_then(|mut p| p.remove(id)) {
                    let response = if let Some(error) = value["error"].as_str() { Err(error.to_owned()) } else { Ok(value["value"].clone()) };
                    let _ = reply.send(response);
                }
            } else if value["event"] == "custom:generation" {
                if let Some(chat) = value["payload"]["chat"].as_str() { crate::engine::hub::cast(chat, crate::engine::hub::Op::CustomEvent(value["payload"]["event"].clone())); }
            } else if value["event"] == "mcp:oauth-event" {
                if let Some(app) = APP.get() { let _ = app.emit("mcp:oauth-event", &value["payload"]); }
            }
        }
        if let Ok(mut pending) = reading.pending.lock() { for (_, reply) in pending.drain() { let _ = reply.send(Err("Custom service stopped".into())); } }
    });
    *slot = Some(worker.clone());
    Ok(worker)
}

pub fn call(channel: &str, args: Value) -> Reply {
    let worker = worker()?;
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::sync_channel(1);
    worker.pending.lock().map_err(|_| "Custom pending lock failed")?.insert(id.clone(), tx);
    let sent = worker.input.lock().map_err(|_| "Custom input lock failed").and_then(|mut input| writeln!(input, "{}", json!({"id":id,"channel":channel,"args":args})).map_err(|_| "Custom request failed"));
    if let Err(error) = sent { worker.pending.lock().ok().map(|mut p| p.remove(&id)); return Err(error.into()); }
    let timeout = if channel == "mcp:oauth-connect" { 360 } else { 60 };
    let reply = rx.recv_timeout(Duration::from_secs(timeout)).unwrap_or_else(|_| Err("Custom service request timed out".into()));
    worker.pending.lock().ok().map(|mut p| p.remove(&id));
    reply
}

pub fn owns(channel: &str) -> bool {
    matches!(channel, "mcp:list" | "mcp:set-enabled" | "mcp:upsert" | "mcp:remove" | "mcp:import-candidates" | "mcp:import" | "mcp:prefs-get" | "mcp:prefs-set" | "mcp:oauth-connect" | "mcp:oauth-cancel" | "mcp:oauth-disconnect" | "mcp:oauth-import-global" | "secrets:list" | "secrets:set" | "secrets:remove" | "secrets:set-env" | "comfy:status" | "comfy:register" | "comfy:check" | "tripo:status" | "tripo:register" | "tripo:check" | "credits:get" | "work:inspect-paths" | "work:open-folder")
}

pub fn dispatch(channel: &str, args: &Value) -> Option<Value> {
    if !owns(channel) { return None; }
    Some(call(channel, args.clone()).unwrap_or_else(|error| json!({"__customError":error})))
}

pub fn capture(chat: &str, event: &Value) {
    if !matches!(event["type"].as_str(), Some("session" | "file-change" | "status" | "custom-tool-start" | "custom-tool-end")) { return; }
    // Do not start a worker merely for token streaming. Capture only the small
    // set of lifecycle/tool events; requests and provider enrichment are async.
    if let Ok(worker) = worker() { if let Ok(mut input) = worker.input.lock() { let _ = writeln!(input, "{}", json!({"channel":"custom:capture","args":[{"chat":chat,"event":event}]})); } }
}

pub fn harvest_oauth(path: &std::path::Path) {
    if APP.get().is_some() { let _ = call("custom:harvest-oauth", json!([{ "path": path }])); }
}

pub fn prepare_spawn(spec: &mut ccg_engine::driver::SpawnSpec) -> std::io::Result<()> {
    if APP.get().is_none() { return Ok(()); }
    let config_dir = spec.env_set.iter().find(|(key, _)| key == "CLAUDE_CONFIG_DIR").map(|(_, value)| value.clone());
    let info = call("custom:spawn", json!([{"engine":if spec.codex.is_some(){"codex"}else{"claude"},"cwd":spec.cwd,"configDir":config_dir}])).map_err(std::io::Error::other)?;
    if let Some(env) = info["env"].as_object() { for (key, value) in env { if let Some(value) = value.as_str() { spec.env_set.retain(|(k,_)| k != key); spec.env_set.push((key.clone(), value.into())); } } }
    if let Some(plan) = spec.codex.as_mut() { plan.app_config = info["config"].clone(); }
    else {
        if info["servers"].as_object().is_some_and(|v| !v.is_empty()) { spec.argv.extend(["--mcp-config".into(), json!({"mcpServers":info["servers"]}).to_string()]); }
        if let Some(settings) = info["settings"].as_object() {
            if let Some(index) = spec.argv.iter().position(|arg| arg == "--settings") {
                if let Some(raw) = spec.argv.get_mut(index+1) { if let Ok(Value::Object(mut current)) = serde_json::from_str(raw) { current.extend(settings.clone()); *raw = Value::Object(current).to_string(); } }
            } else if !settings.is_empty() { spec.argv.extend(["--settings".into(), Value::Object(settings.clone()).to_string()]); }
        }
    }
    Ok(())
}

pub fn shutdown() {
    if let Ok(mut slot) = WORKER.lock() { if let Some(worker) = slot.take() { if let Ok(mut child) = worker.child.lock() { let _ = child.kill(); let _ = child.wait(); } } }
}
