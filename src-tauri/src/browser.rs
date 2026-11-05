//! One shared browser for every job.
//!
//! Ondra keeps a single headless Chrome (the bundled headless shell) running on
//! a persistent profile, `<data dir>/browser/profile`. Every job attaches to it
//! over CDP with its own agent-browser session pinned to its own tab
//! (`AGENT_BROWSER_CDP` + `AGENT_BROWSER_PIN_TAB`): a fresh pinned session
//! opens a new tab instead of taking one that is already there, so jobs never
//! drive each other's pages, while cookies and storage are the profile's and
//! are shared. A login made once (by a job or by the user in the Browser view)
//! holds for every job and survives restarts.
//!
//! Only one Chrome may own a profile, so there is exactly one process: it is
//! started on first use and stopped when Ondra quits. One an earlier run left
//! running is replaced (it can't open tabs any more), and one that stops
//! responding to agent-browser is restarted.

use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

/// Plugin name jobs pass to `auth login --credential-provider`.
pub const KEYCHAIN_PLUGIN: &str = "keychain";
/// A job's session daemon goes away after this long without a command; its tab stays.
const IDLE_MS: &str = "900000";

#[derive(Default)]
pub struct Shared(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    port: Option<u16>,
}

fn profile_dir(app: &AppHandle) -> PathBuf {
    crate::engine::data_dir(app).join("browser").join("profile")
}

fn port_file(app: &AppHandle) -> PathBuf {
    profile_dir(app).join("DevToolsActivePort")
}

fn read_port(app: &AppHandle) -> Option<u16> {
    std::fs::read_to_string(port_file(app)).ok()?.lines().next()?.trim().parse().ok()
}

/// A Chrome DevTools endpoint answers on this port.
fn answers(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(400)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
    if s.write_all(b"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    text.lines().next().is_some_and(|l| l.contains(" 200")) && text.contains("webSocketDebuggerUrl")
}

/// Sites turn away "HeadlessChrome"; present the same build as plain Chrome.
fn user_agent(chrome: &std::path::Path) -> Option<String> {
    static UA: OnceLock<String> = OnceLock::new();
    if let Some(ua) = UA.get() {
        return Some(ua.clone());
    }
    let out = Command::new(chrome).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let version = text.split_whitespace().find(|w| w.chars().next().is_some_and(|c| c.is_ascii_digit()) && w.contains('.'))?;
    let ua = format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Safari/537.36");
    Some(UA.get_or_init(|| ua).clone())
}

/// The running browser's DevTools port, without starting one.
pub fn port(app: &AppHandle) -> Option<u16> {
    let shared = app.state::<Shared>();
    let mut inner = shared.0.lock().ok()?;
    if let Some(p) = inner.port.filter(|p| answers(*p)) {
        return Some(p);
    }
    let p = read_port(app).filter(|p| answers(*p))?;
    inner.port = Some(p);
    Some(p)
}

/// agent-browser can drive it. A Chrome that has run for hours can still answer
/// /json/version while every agent-browser command hangs (seen after a heavy
/// WebGL page); checked at most once a minute.
fn works(app: &AppHandle, port: u16) -> bool {
    static LAST_OK: Mutex<Option<(u16, Instant)>> = Mutex::new(None);
    if let Ok(last) = LAST_OK.lock() {
        if last.is_some_and(|(p, at)| p == port && at.elapsed() < Duration::from_secs(60)) {
            return true;
        }
    }
    let Some(mut cmd) = crate::tools::agent_browser(app) else { return true };
    cmd.env("AGENT_BROWSER_CDP", port.to_string())
        .env("AGENT_BROWSER_SESSION", format!("ondra-health-{port}"))
        .env("AGENT_BROWSER_IDLE_TIMEOUT_MS", "30000")
        .args(["get", "url"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else { return true };
    let until = Instant::now() + Duration::from_secs(10);
    let ok = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.success(),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break false;
            }
        }
    };
    if ok {
        if let Ok(mut last) = LAST_OK.lock() {
            *last = Some((port, Instant::now()));
        }
    }
    ok
}

/// Kill whatever Chrome owns the profile (ours or one an earlier run left), so a
/// fresh one can start on it. The profile, and so the logins, stay.
fn kill_profile_chrome(app: &AppHandle, inner: &mut Inner) {
    if let Some(mut c) = inner.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    let flag = format!("--user-data-dir={}", profile_dir(app).display());
    let _ = Command::new("/usr/bin/pkill").args(["-f", &flag]).status();
    std::thread::sleep(Duration::from_millis(800));
    inner.port = None;
}

/// The shared browser's DevTools port, starting it if it is not running.
pub fn ensure(app: &AppHandle) -> Result<u16, String> {
    let shared = app.state::<Shared>();
    let mut inner = shared.0.lock().map_err(|_| "browser lock".to_string())?;
    // A Chrome left by an earlier run of Ondra still answers but can't start new
    // tabs any more (its renderers fail to launch once the app that started it is
    // gone): only keep a browser this run started, and only while it works.
    let ours = inner.child.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)));
    if !ours {
        kill_profile_chrome(app, &mut inner);
    }
    if let Some(p) = inner.port.or_else(|| read_port(app)).filter(|p| ours && answers(*p)) {
        if works(app, p) {
            inner.port = Some(p);
            return Ok(p);
        }
        kill_profile_chrome(app, &mut inner);
    }
    inner.port = None;
    if let Some(c) = inner.child.as_mut() {
        if !matches!(c.try_wait(), Ok(None)) {
            inner.child = None;
        }
    }
    if let Some(mut c) = inner.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }

    let chrome = crate::tools::chrome_path(app).ok_or("브라우저를 찾을 수 없어요")?;
    let profile = profile_dir(app);
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(port_file(app));
    let mut cmd = Command::new(&chrome);
    cmd.arg(format!("--user-data-dir={}", profile.display()))
        .args([
            "--remote-debugging-port=0",
            "--remote-debugging-address=127.0.0.1",
            // never touch the user's keychain for Chrome's own cookie key
            "--use-mock-keychain",
            "--password-store=basic",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--window-size=1280,800",
        ]);
    if !chrome.ends_with("chrome-headless-shell") {
        cmd.arg("--headless=new");
    }
    if let Some(ua) = user_agent(&chrome) {
        cmd.arg(format!("--user-agent={ua}"));
    }
    cmd.arg("about:blank");
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("브라우저를 열 수 없어요: {e}"))?;

    let started = Instant::now();
    loop {
        if let Some(p) = read_port(app).filter(|p| answers(*p)) {
            inner.child = Some(child);
            inner.port = Some(p);
            return Ok(p);
        }
        if !matches!(child.try_wait(), Ok(None)) {
            return Err("브라우저가 바로 닫혔어요".into());
        }
        if started.elapsed() > Duration::from_secs(20) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("브라우저가 응답하지 않아요".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Quit the browser Ondra started (SIGTERM first, so cookies are flushed to disk).
pub fn stop(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let Ok(mut inner) = shared.0.lock() else { return };
    inner.port = None;
    let Some(mut child) = inner.child.take() else { return };
    let _ = Command::new("/bin/kill").args(["-TERM", &child.id().to_string()]).status();
    let until = Instant::now() + Duration::from_secs(3);
    while Instant::now() < until {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// A job's agent-browser session. It carries the browser's port so a session
/// bound to a tab of an earlier browser is never reused after a restart.
pub fn session_for(worker_id: &str, port: Option<u16>) -> String {
    match port {
        Some(p) => format!("w-{worker_id}-{p}"),
        None => format!("w-{worker_id}"),
    }
}

/// The session's daemon is up (`session list` starts nothing).
pub fn session_running(app: &AppHandle, session: &str) -> bool {
    let Some(mut cmd) = crate::tools::agent_browser(app) else { return false };
    let Ok(out) = cmd.args(["session", "list", "--json"]).stdin(Stdio::null()).stderr(Stdio::null()).output() else { return false };
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    v.pointer("/data/sessions")
        .and_then(|s| s.as_array())
        .is_some_and(|list| list.iter().any(|s| s.as_str() == Some(session)))
}

/// The registry entry that makes `--credential-provider keychain` work: this
/// same binary in plugin mode (see `keychain.rs`).
pub fn plugins_env() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let plugins = serde_json::json!([{
        "name": KEYCHAIN_PLUGIN,
        "command": exe.display().to_string(),
        "args": [crate::keychain::FLAG],
        "capabilities": ["credential.read"],
    }]);
    Some(plugins.to_string())
}

/// What makes an agent-browser command use the shared browser in its own tab.
pub fn attach_env(port: u16, session: &str) -> Vec<(String, String)> {
    vec![
        ("AGENT_BROWSER_CDP".into(), port.to_string()),
        ("AGENT_BROWSER_PIN_TAB".into(), "1".into()),
        ("AGENT_BROWSER_IDLE_TIMEOUT_MS".into(), IDLE_MS.into()),
        ("AGENT_BROWSER_SESSION".into(), session.into()),
    ]
}

// ───────────── the Browser view: Ondra's own tab in the shared browser ─────────────

fn view_session(port: u16) -> String {
    format!("ondra-{port}")
}

fn view_command(app: &AppHandle, port: u16) -> Option<Command> {
    let mut cmd = crate::tools::agent_browser(app)?;
    for (k, v) in attach_env(port, &view_session(port)) {
        cmd.env(k, v);
    }
    cmd.stdin(Stdio::null()).stderr(Stdio::null());
    Some(cmd)
}

fn stream_port(mut cmd: Command) -> Option<u16> {
    let out = cmd.args(["stream", "status", "--json"]).output().ok()?;
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let data = v.get("data")?;
    if data.get("connected").and_then(|c| c.as_bool()) != Some(true) {
        return None;
    }
    data.get("port").and_then(|p| p.as_u64()).map(|p| p as u16)
}

/// Start (or find) the shared browser and the view's tab; the tab's live stream port.
#[tauri::command]
pub async fn shared_browser_open(app: AppHandle) -> Result<u16, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let port = ensure(&app)?;
        let cmd = || view_command(&app, port).ok_or_else(|| "agent-browser를 찾을 수 없어요".to_string());
        if let Some(p) = stream_port(cmd()?) {
            return Ok(p);
        }
        // connecting opens the view's own tab; streaming may already be on
        let _ = cmd()?.args(["stream", "enable"]).stdout(Stdio::null()).status();
        stream_port(cmd()?).ok_or_else(|| "화면을 받을 수 없어요".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Drive the view's tab: open a URL, or go back / forward / reload.
#[tauri::command]
pub async fn shared_browser_go(app: AppHandle, action: String, url: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let port = ensure(&app)?;
        let mut cmd = view_command(&app, port).ok_or("agent-browser를 찾을 수 없어요")?;
        match action.as_str() {
            "open" => {
                let url = url.filter(|u| u.starts_with("http://") || u.starts_with("https://")).ok_or("주소가 올바르지 않아요")?;
                cmd.args(["open", &url]);
            }
            "back" | "forward" | "reload" => {
                cmd.arg(&action);
            }
            _ => return Err("unknown action".into()),
        }
        let ok = cmd.stdout(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
        if ok { Ok(()) } else { Err("페이지를 열 수 없어요".into()) }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A job ended: close its tab and its session (the profile, and so the logins, stay).
#[tauri::command]
pub async fn browser_release(app: AppHandle, worker_id: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let Some(port) = port(&app) else { return };
        let session = session_for(&worker_id, Some(port));
        // even when its daemon timed out, the pinned session rebinds to the job's own tab
        for args in [&["tab", "close"][..], &["close"][..]] {
            let Some(mut cmd) = crate::tools::agent_browser(&app) else { return };
            for (k, v) in attach_env(port, &session) {
                cmd.env(k, v);
            }
            let _ = cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
    })
    .await;
}
