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
    #[cfg(target_os = "macos")]
    computer: Option<computer_channel::Channel>,
}

impl Proc {
    fn revoke(&mut self) {
        #[cfg(target_os = "macos")]
        drop(self.computer.take());
    }

    fn terminate(&mut self) {
        self.revoke();
        // What its shell is running right then (a wait loop, a build, a crawl of a
        // dev server) would run on with nobody reading it, while the resumed job
        // runs it again. A server an earlier call started is no longer below the
        // engine (that call ended), so it stays.
        let running = match self.child.try_wait() {
            Ok(None) => below(&ps_rows(), self.child.id() as i32),
            _ => vec![],
        };
        let _ = self.child.kill();
        let _ = self.child.wait();
        for pid in running {
            signal("-KILL", pid);
        }
    }

    fn finish(&mut self) -> Option<i32> {
        self.revoke();
        self.child.wait().ok().and_then(|status| status.code())
    }
}

impl Drop for Proc {
    fn drop(&mut self) {
        self.terminate();
    }
}

#[cfg(target_os = "macos")]
mod computer_channel {
    use crate::computer::{EngineChannel, OwnedVm, SOCKET_ENV};
    use std::{ffi::CStr, path::PathBuf, process::{Child, Command}, sync::Arc};

    // The socket and its private directory have one owner and one lifetime.
    pub struct Channel {
        channel: Option<EngineChannel>,
        directory: PathBuf,
    }

    impl Channel {
        pub fn bind_child(&self, child: &mut Child, generation: u64) -> Result<(), &'static str> {
            self.channel.as_ref().ok_or("GUEST_REVOKED")?.bind_child(child, generation)
        }
    }

    impl Drop for Channel {
        fn drop(&mut self) {
            // EngineChannel revokes before unlinking; only then remove its directory.
            drop(self.channel.take());
            let _ = std::fs::remove_dir(&self.directory);
        }
    }

    pub fn prepare(cmd: &mut Command, id: &str, generation: u64, vm: Option<Arc<OwnedVm>>) -> Result<Option<Channel>, String> {
        cmd.env_remove(SOCKET_ENV);
        // Job ids come from tasks.agentOf; captains, login and probes are not jobs.
        if !id.strip_prefix("t:").is_some_and(|job| !job.is_empty()) {
            return Ok(None);
        }
        // Ignore TMPDIR and all job paths. mkdtemp creates a fresh 0700 directory
        // atomically; never chmod, unlink or adopt a caller-supplied directory.
        let mut template = b"/private/tmp/ondra-c-XXXXXX\0".to_vec();
        let created = unsafe { libc::mkdtemp(template.as_mut_ptr().cast()) };
        if created.is_null() {
            return Err("컴퓨터 채널 폴더를 만들 수 없습니다".into());
        }
        // SAFETY: mkdtemp returned the NUL-terminated ASCII template above.
        let directory = PathBuf::from(unsafe { CStr::from_ptr(created) }.to_string_lossy().into_owned());
        let mut owner = Channel { channel: None, directory };
        owner.directory = std::fs::canonicalize(&owner.directory)
            .map_err(|_| "컴퓨터 채널 폴더를 확인할 수 없습니다")?;
        let channel = EngineChannel::prepare(&owner.directory, generation, vm)
            .map_err(|code| format!("컴퓨터 채널을 준비하지 못했습니다: {code}"))?;
        cmd.env(SOCKET_ENV, channel.socket_path());
        owner.channel = Some(channel);
        Ok(Some(owner))
    }
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
    /// The jobs' engine processes, for telling apps they start apart from the user's.
    pub fn pids(&self) -> Vec<i32> {
        self.procs.lock().map(|p| p.values().map(|p| p.child.id() as i32).collect()).unwrap_or_default()
    }

    pub fn kill_all(&self) {
        if let Ok(mut procs) = self.procs.lock() {
            for (_, mut p) in procs.drain() {
                p.terminate();
            }
        }
    }
}

// Processes, from `ps`: what a job's engine runs (its shell's commands) is
// stopped with it, and one stalled command can be stopped on its own.
/// One process from `ps`.
struct PsRow {
    pid: i32,
    ppid: i32,
    command: String,
}

fn ps_rows() -> Vec<PsRow> {
    let Ok(out) = std::process::Command::new("/bin/ps").args(["-A", "-o", "pid=,ppid=,command="]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).output() else {
        return vec![];
    };
    String::from_utf8_lossy(&out.stdout).lines().filter_map(parse_ps).collect()
}

fn parse_ps(line: &str) -> Option<PsRow> {
    let (pid, rest) = line.trim_start().split_once(char::is_whitespace)?;
    let (ppid, command) = rest.trim_start().split_once(char::is_whitespace).unwrap_or((rest.trim(), ""));
    Some(PsRow { pid: pid.parse().ok()?, ppid: ppid.parse().ok()?, command: command.trim().to_string() })
}

/// Every process below `root` (never `root` itself).
fn below(rows: &[PsRow], root: i32) -> Vec<i32> {
    let mut below = vec![root];
    let mut i = 0;
    while i < below.len() {
        let parent = below[i];
        i += 1;
        for r in rows {
            if r.ppid == parent && r.pid > 1 && !below.contains(&r.pid) {
                below.push(r.pid);
            }
        }
    }
    below.remove(0);
    below
}

fn signal(sig: &str, pid: i32) {
    let _ = std::process::Command::new("/bin/kill").args([sig, &pid.to_string()]).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status();
}

/// GUI apps start with a bare environment, but the user's tools (git, node,
/// editors) live wherever their shell puts them. Ask a login shell once for
/// the variables we care about.
fn login_env() -> &'static HashMap<String, String> {
    static ENV: OnceLock<HashMap<String, String>> = OnceLock::new();
    ENV.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let vars = ["PATH", "LANG"].iter().chain(crate::LOGIN_VARS).copied().collect::<Vec<_>>().join(" ");
        let script = format!(r#"for v in {vars}; do printf '\n__ENV__%s=%s' "$v" "$(printenv $v)"; done; printf '\n'"#);
        let out = Command::new(shell).args(["-ilc", &script]).stdin(Stdio::null()).stderr(Stdio::null()).output();
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
    cmd.env_remove("ONDRA_COMPUTER_SOCKET");
    cmd.arg("--no-extensions");
    Ok(cmd)
}

/// Env every engine process gets (also used for the login terminal).
pub fn engine_env(app: &AppHandle) -> Vec<(String, String)> {
    let mut env = vec![
        ("PATH".to_string(), with_sidecars(user_path())),
        ("PI_SKIP_VERSION_CHECK".to_string(), "1".to_string()),
    ];
    // logins the user's shell sets (a space's own env overrides these)
    for k in crate::LOGIN_VARS {
        if let Some(v) = login_env().get(*k) {
            env.push((k.to_string(), v.clone()));
        }
    }
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
    #[cfg(target_os = "macos")]
    let computer_state = app.state::<crate::computer_setup::ComputerState>();
    #[cfg(target_os = "macos")]
    let computer_access = computer_state.engine_access().map_err(str::to_owned)?;
    if let Some(mut old) = engine.procs.lock().unwrap().remove(&id) {
        RETIRED.lock().unwrap().push(old.generation);
        old.terminate();
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
    cmd.env_remove("ONDRA_COMPUTER_SOCKET");
    #[cfg(target_os = "macos")]
    let computer = computer_channel::prepare(&mut cmd, &id, generation, computer_access.current_vm(&id))?;
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("엔진을 시작하지 못했습니다: {e}"))?;

    #[cfg(target_os = "macos")]
    if let Some(channel) = &computer {
        if let Err(error) = channel.bind_child(&mut child, generation) {
            drop(computer);
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("컴퓨터 채널을 연결하지 못했습니다: {error}"));
        }
    }
    let pipes = (child.stdout.take(), child.stderr.take(), child.stdin.take());
    let (Some(stdout), Some(stderr), Some(stdin)) = pipes else {
        #[cfg(target_os = "macos")]
        drop(computer);
        let _ = child.kill();
        let _ = child.wait();
        return Err("엔진 입출력 파이프를 열지 못했습니다".into());
    };
    engine.procs.lock().unwrap().insert(id.clone(), Proc {
        child, stdin, generation,
        #[cfg(target_os = "macos")]
        computer,
    });
    #[cfg(target_os = "macos")]
    drop(computer_access);

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
                            crate::focus::on_event(&id, &ev);
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
            crate::focus::job_gone(&id);
            let code = mine.and_then(|mut p| p.finish());
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
        p.terminate();
    }
}

/// `command` runs `program` (any path to it) with `arg` somewhere in its arguments.
fn runs_program(command: &str, program: &str, arg: Option<&str>) -> bool {
    let (first, rest) = command.split_once(char::is_whitespace).unwrap_or((command, ""));
    first.rsplit('/').next() == Some(program) && arg.is_none_or(|a| rest.contains(a))
}

/// The processes below `root` (never `root` itself) that run `program` with `arg`.
fn matching_below(rows: &[PsRow], root: i32, program: &str, arg: Option<&str>) -> Vec<i32> {
    let below = below(rows, root);
    rows.iter()
        .filter(|r| below.contains(&r.pid) && runs_program(&r.command, program, arg))
        .map(|r| r.pid)
        .collect()
}

/// Stop one command a job's shell is running (a search walking all of ~), not the
/// job: only processes under that job's engine whose command line is `program`
/// with `arg`. SIGTERM, then SIGKILL after 2s for the ones still there. Returns
/// how many were signalled.
#[tauri::command]
pub fn agent_stop_command(engine: State<'_, Engine>, id: String, program: String, arg: Option<String>) -> Result<usize, String> {
    let root = engine.procs.lock().unwrap().get(&id).map(|p| p.child.id() as i32).ok_or("에이전트가 실행 중이 아닙니다")?;
    if program.trim().is_empty() || program.contains('/') {
        return Ok(0);
    }
    // the shell expanded `~` before the program saw it
    let arg = arg.filter(|a| !a.is_empty()).map(|a| match a.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("{}{rest}", home().display()),
        _ => a,
    });
    let pids = matching_below(&ps_rows(), root, &program, arg.as_deref());
    for pid in &pids {
        signal("-TERM", *pid);
    }
    if !pids.is_empty() {
        let first = pids.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(2));
            // the same processes, still under the same engine (a pid can be reused)
            let still = matching_below(&ps_rows(), root, &program, arg.as_deref());
            for pid in first.iter().filter(|p| still.contains(p)) {
                signal("-KILL", *pid);
            }
        });
    }
    Ok(pids.len())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(list: &[(i32, i32, &str)]) -> Vec<PsRow> {
        list.iter().map(|(pid, ppid, c)| PsRow { pid: *pid, ppid: *ppid, command: c.to_string() }).collect()
    }

    #[test]
    fn reads_ps_lines() {
        let r = parse_ps("  412     1 /usr/bin/find . -name *.html").unwrap();
        assert_eq!((r.pid, r.ppid, r.command.as_str()), (412, 1, "/usr/bin/find . -name *.html"));
        assert!(parse_ps("PID PPID COMMAND").is_none());
    }

    #[test]
    fn stops_only_the_search_under_the_job() {
        let all = rows(&[
            (100, 1, "/Applications/Ondra.app/Contents/MacOS/ondra-engine --mode rpc"),
            (200, 100, "/bin/bash -c list=$(find . -name '*.html')"),
            (201, 200, "find . -name *.html"),
            (300, 100, "/bin/bash -c pnpm dev"),
            (301, 300, "node vite"),
            (400, 1, "find . -name *.html"),
            (500, 1, "/usr/bin/find / -name x"),
        ]);
        assert_eq!(matching_below(&all, 100, "find", Some(".")), vec![201]);
        assert_eq!(matching_below(&all, 100, "find", None), vec![201]);
        assert!(matching_below(&all, 100, "ondra-engine", None).is_empty());
        assert!(matching_below(&all, 100, "rg", None).is_empty());
        assert!(matching_below(&all, 100, "find", Some("/Users")).is_empty());
        assert!(runs_program("/opt/homebrew/bin/rg --files /Users/me/src", "rg", Some("--files")));
        assert!(!runs_program("/bin/bash -c rg foo", "rg", None));
    }

    #[test]
    fn stops_only_the_wait_not_the_server_it_waits_for() {
        let all = rows(&[
            (100, 1, "/Applications/Ondra.app/Contents/MacOS/ondra-engine --mode rpc"),
            (200, 100, "/bin/bash -c for i in $(seq 1 60); do grep -q \"Ready\" /tmp/dev.log && break; sleep 2; done"),
            (201, 200, "sleep 2"),
            (300, 100, "/bin/bash -c pnpm build"),
            // started by an earlier call: that shell ended, the server is launchd's now
            (400, 1, "node /repo/node_modules/.bin/next dev"),
        ]);
        let wait = "for i in $(seq 1 60); do grep -q \"Ready\" /tmp/dev.log && break; sleep 2; done";
        assert_eq!(matching_below(&all, 100, "bash", Some(wait)), vec![200]);
        // the engine goes: what its calls run goes with it, the server stays
        let mut gone = below(&all, 100);
        gone.sort();
        assert_eq!(gone, vec![200, 201, 300]);
    }

    #[test]
    fn a_stopped_engine_takes_its_running_commands_along() {
        // an "engine" whose shell runs a command, and a server an earlier call left behind
        let mut child = Command::new("/bin/bash")
            .args(["-c", "/bin/bash -c 'sleep 31; true' & read _"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let mut left = Command::new("/bin/sleep").arg("32").spawn().unwrap();
        let stdin = child.stdin.take().unwrap();
        let mut running = vec![];
        for _ in 0..50 {
            running = below(&ps_rows(), child.id() as i32);
            if running.len() >= 2 {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(running.len() >= 2, "the command and its sleep run below the engine");
        let mut p = Proc { child, stdin, generation: 0, #[cfg(target_os = "macos")] computer: None };
        p.terminate();
        std::thread::sleep(Duration::from_millis(100));
        let alive: Vec<i32> = ps_rows().iter().map(|r| r.pid).collect();
        assert!(running.iter().all(|pid| !alive.contains(pid)), "nothing it ran is left");
        assert!(left.try_wait().unwrap().is_none(), "what it didn't run stays");
        let _ = left.kill();
        let _ = left.wait();
    }
}
