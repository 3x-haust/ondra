//! Agent processes. Every agent (the captain, each worker) is one
//! `ondra-engine --no-extensions --mode rpc` child: JSON commands go in on
//! stdin, JSON events come out on stdout and are forwarded to the UI as
//! `agent:event`. The engine is 3xhaustPi's coding agent compiled into a
//! single binary and shipped inside the app. All orchestration lives in the
//! UI; this file only owns processes.

use serde::Serialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

struct Proc {
    child: Child,
    stdin: ChildStdin,
    /// Tells a process apart from the one it replaced under the same id.
    generation: u64,
}

static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
/// Generations replaced by a restart under the same id. Their exit is not news:
/// the listeners already belong to the new process.
static RETIRED: std::sync::Mutex<Vec<u64>> = std::sync::Mutex::new(Vec::new());

#[derive(Default)]
pub struct Engine {
    procs: Mutex<HashMap<String, Proc>>,
}

impl Engine {
    pub fn kill_all(&self) {
        if let Ok(mut procs) = self.procs.lock() {
            for (_, mut p) in procs.drain() {
                let _ = p.child.kill();
            }
        }
    }
}

/// GUI apps start with a bare environment, but the user's tools (git, node,
/// editors) live wherever their shell puts them. Ask a login shell once for
/// the variables we care about.
fn login_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let script = r#"for v in PATH CLAUDE_CONFIG_DIR CODEX_HOME PI_CODING_AGENT_DIR LANG; do printf '\n__ENV__%s=%s' "$v" "$(printenv $v)"; done; printf '\n'"#;
        let out = Command::new(shell).args(["-ilc", script]).stdin(Stdio::null()).stderr(Stdio::null()).output();
        let mut map = HashMap::new();
        if let Ok(o) = out {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                if let Some((k, v)) = line.strip_prefix("__ENV__").and_then(|l| l.split_once('=')) {
                    if !v.is_empty() {
                        map.insert(k.to_string(), v.to_string());
                    }
                }
            }
        }
        if !map.contains_key("PATH") {
            map.insert("PATH".into(), std::env::var("PATH").unwrap_or_else(|_| "/usr/bin:/bin:/usr/sbin:/sbin".into()));
        }
        map
    })
}

/// The user's login-shell PATH.
pub fn user_path() -> &'static str {
    login_env().get("PATH").map(String::as_str).unwrap_or("/usr/bin:/bin")
}

/// A variable from the user's login shell (falls back to this process's env).
pub fn user_var(name: &str) -> Option<String> {
    login_env().get(name).cloned().or_else(|| std::env::var(name).ok()).filter(|v| !v.is_empty())
}

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into()))
}

/// The engine binary shipped next to the app executable.
pub fn engine_bin() -> Option<PathBuf> {
    crate::tools::sidecar("ondra-engine")
}

/// Support files the engine reads at runtime (themes, wasm, package.json).
fn engine_assets(app: &AppHandle) -> Option<PathBuf> {
    crate::tools::resource(app, "engine").filter(|d| d.join("package.json").is_file())
}

/// A Command for the engine with everything it needs. Extensions are off so
/// the user's own pi setup never leaks in or breaks a run.
pub fn engine_command(app: &AppHandle) -> Result<Command, String> {
    let bin = engine_bin().ok_or("엔진 파일이 앱에 없습니다. 앱을 다시 설치하세요.")?;
    let mut cmd = Command::new(bin);
    for (k, v) in engine_env(app) {
        cmd.env(k, v);
    }
    cmd.arg("--no-extensions");
    Ok(cmd)
}

/// Env every engine process gets (also used for the login terminal).
pub fn engine_env(app: &AppHandle) -> Vec<(String, String)> {
    let mut env = vec![
        ("PATH".to_string(), with_sidecars(user_path())),
        ("PI_SKIP_VERSION_CHECK".to_string(), "1".to_string()),
    ];
    if let Some(dir) = engine_assets(app) {
        env.push(("PI_PACKAGE_DIR".into(), dir.display().to_string()));
    }
    env
}

/// PATH with the bundled tools (agent-browser, agent-desktop) first.
pub fn with_sidecars(path: &str) -> String {
    match crate::tools::sidecar_dir() {
        Some(dir) => format!("{}:{path}", dir.display()),
        None => path.to_string(),
    }
}

pub fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("ondra"));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    engine_path: Option<String>,
    engine_version: Option<String>,
    data_dir: String,
    home: String,
}

#[tauri::command]
pub async fn engine_info(app: AppHandle) -> EngineInfo {
    let version = engine_command(&app).ok().and_then(|mut c| {
        let out = c.arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|s| !s.is_empty())
    });
    EngineInfo {
        engine_path: engine_bin().map(|p| p.display().to_string()),
        engine_version: version,
        data_dir: data_dir(&app).display().to_string(),
        home: home().display().to_string(),
    }
}

/// Keep IPC light: streaming updates repeat the whole partial message on every
/// token, and tool updates repeat the whole output so far. Send deltas and tails.
fn slim(mut ev: Value) -> Value {
    match ev.get("type").and_then(Value::as_str) {
        Some("message_update") => {
            if let Some(obj) = ev.as_object_mut() {
                obj.remove("message");
            }
            if let Some(ame) = ev.get_mut("assistantMessageEvent").and_then(Value::as_object_mut) {
                ame.remove("partial");
            }
        }
        Some("tool_execution_update") => {
            let tail = ev.pointer("/partialResult/content/0/text").and_then(Value::as_str).map(|t| tail_chars(t, 2400));
            if let Some(obj) = ev.as_object_mut() {
                obj.remove("partialResult");
                obj.insert("tail".into(), json!(tail));
            }
        }
        Some("agent_end") | Some("turn_end") => {
            if let Some(obj) = ev.as_object_mut() {
                obj.remove("messages");
                obj.remove("toolResults");
                obj.remove("message");
            }
        }
        Some("tool_execution_end") => {
            if let Some(text) = ev.pointer_mut("/result/content/0/text") {
                if let Some(s) = text.as_str() {
                    if s.chars().count() > 6000 {
                        *text = json!(format!("…{}", tail_chars(s, 6000)));
                    }
                }
            }
            if let Some(r) = ev.get_mut("result").and_then(Value::as_object_mut) {
                r.remove("details");
            }
        }
        _ => {}
    }
    ev
}

fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n { s.to_string() } else { s.chars().skip(count - n).collect() }
}

#[tauri::command]
pub fn agent_spawn(
    app: AppHandle,
    engine: State<'_, Engine>,
    id: String,
    cwd: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
) -> Result<(), String> {
    let mut cmd = engine_command(&app)?;
    if let Some(mut old) = engine.procs.lock().unwrap().remove(&id) {
        RETIRED.lock().unwrap().push(old.generation);
        let _ = old.child.kill();
        let _ = old.child.wait();
    }
    let generation = GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let cwd = if cwd.is_empty() { home().display().to_string() } else { cwd };
    std::fs::create_dir_all(&cwd).map_err(|e| format!("폴더를 만들 수 없습니다: {e}"))?;

    cmd.arg("--mode").arg("rpc").args(&args).current_dir(&cwd);
    // several parts may add to PATH (bundled tools, a space's CLI shims): all of them go first, in order
    let mut path_parts: Vec<&str> = Vec::new();
    for (k, v) in &env {
        if k == "PATH" {
            path_parts.push(v);
        } else {
            cmd.env(k, v);
        }
    }
    if !path_parts.is_empty() {
        cmd.env("PATH", format!("{}:{}", path_parts.join(":"), with_sidecars(user_path())));
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("엔진을 시작하지 못했습니다: {e}"))?;

    let stdout = child.stdout.take().ok_or("stdout 없음")?;
    let stderr = child.stderr.take().ok_or("stderr 없음")?;
    let stdin = child.stdin.take().ok_or("stdin 없음")?;
    engine.procs.lock().unwrap().insert(id.clone(), Proc { child, stdin, generation });

    {
        let app = app.clone();
        let id = id.clone();
        std::thread::spawn(move || {
            // Split on LF only (the RPC framing rule); JSON strings may hold U+2028.
            let mut reader = BufReader::new(stdout);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let line = String::from_utf8_lossy(&buf);
                        let line = line.trim_end_matches(['\n', '\r']);
                        if line.is_empty() {
                            continue;
                        }
                        if let Ok(ev) = serde_json::from_str::<Value>(line) {
                            let _ = app.emit("agent:event", json!({ "id": id, "ev": slim(ev) }));
                        }
                    }
                }
            }
            // Only this process's own entry: a newer one under the same id
            // (a restart) must stay, and its listeners must not hear this exit.
            {
                let mut retired = RETIRED.lock().unwrap();
                if let Some(i) = retired.iter().position(|g| *g == generation) {
                    retired.swap_remove(i);
                    return;
                }
            }
            let mine = {
                let engine = app.state::<Engine>();
                let mut m = engine.procs.lock().unwrap();
                match m.get(&id) {
                    Some(p) if p.generation != generation => None,
                    Some(_) => Some(m.remove(&id)),
                    None => Some(None),
                }
            };
            let Some(mine) = mine else { return };
            let code = mine.and_then(|mut p| p.child.wait().ok()).and_then(|s| s.code());
            let _ = app.emit("agent:exit", json!({ "id": id, "code": code }));
        });
    }
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if !line.trim().is_empty() {
                let _ = app.emit("agent:stderr", json!({ "id": id, "line": line }));
            }
        }
    });
    Ok(())
}

#[tauri::command]
pub fn agent_send(engine: State<'_, Engine>, id: String, command: Value) -> Result<(), String> {
    let mut procs = engine.procs.lock().unwrap();
    let p = procs.get_mut(&id).ok_or("에이전트가 실행 중이 아닙니다")?;
    let mut line = serde_json::to_string(&command).map_err(|e| e.to_string())?;
    line.push('\n');
    p.stdin.write_all(line.as_bytes()).and_then(|_| p.stdin.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agent_kill(engine: State<'_, Engine>, id: String) {
    if let Some(mut p) = engine.procs.lock().unwrap().remove(&id) {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
}

#[tauri::command]
pub fn agent_alive(engine: State<'_, Engine>) -> Vec<String> {
    engine.procs.lock().unwrap().keys().cloned().collect()
}

/// Models this account can pick, asked from a short-lived engine.
#[tauri::command]
pub async fn engine_models(app: AppHandle, account_id: String) -> Result<Vec<String>, String> {
    let mut cmd = engine_command(&app)?;
    cmd.args(["--mode", "rpc", "--no-session", "--no-tools"]).current_dir(home());
    if let Some(dir) = crate::store::account_dir(&app, &account_id) {
        let _ = std::fs::create_dir_all(&dir);
        cmd.env("PI_CODING_AGENT_DIR", dir);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("stdin")?;
    let stdout = child.stdout.take().ok_or("stdout")?;
    stdin
        .write_all(b"{\"id\":\"m\",\"type\":\"get_available_models\"}\n")
        .map_err(|e| e.to_string())?;

    // Read on a thread so a silent engine can't hang us past the deadline.
    let (tx, rx) = std::sync::mpsc::channel::<Vec<String>>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            if reader.read_until(b'\n', &mut buf).unwrap_or(0) == 0 {
                break;
            }
            let Ok(v) = serde_json::from_slice::<Value>(&buf) else { continue };
            if v.get("id").and_then(Value::as_str) == Some("m") {
                let list = v
                    .pointer("/data/models")
                    .or_else(|| v.get("data"))
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let models = list
                    .iter()
                    .filter_map(|m| Some(format!("{}/{}", m.get("provider")?.as_str()?, m.get("id")?.as_str()?)))
                    .collect();
                let _ = tx.send(models);
                return;
            }
        }
        let _ = tx.send(vec![]);
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let models = rx.recv_timeout(deadline.saturating_duration_since(Instant::now())).unwrap_or_default();
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    Ok(models)
}
