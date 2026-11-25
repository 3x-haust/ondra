//! One shared browser per space for every job in it.
//!
//! Spaces are separate workspaces, so each keeps its own headless Chrome (the
//! bundled headless shell) on its own persistent profile,
//! `<data dir>/browser/<space>/profile`: a login made in one space never reaches
//! the other. Every job attaches to its space's browser
//! over CDP with its own ondra-browser session pinned to its own tab
//! (`ONDRA_BROWSER_CDP` + `ONDRA_BROWSER_PIN_TAB`): a fresh pinned session
//! opens a new tab instead of taking one that is already there, so jobs never
//! drive each other's pages, while cookies and storage are the profile's and
//! are shared. A login made once (by a job, or by the user in a job's tab)
//! holds for every job and survives restarts.
//!
//! Only one Chrome may own a profile, so there is one process per space: it is
//! started on first use and stopped when Ondra quits. One an earlier run left
//! running is replaced (it can't open tabs any more), and one that stops
//! responding to ondra-browser is restarted.

use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Stdio},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
#[cfg(unix)]
use std::process::Command;
use std::sync::OnceLock;

/// A job's session daemon goes away after this long without a command; its tab stays.
const IDLE_MS: &str = "900000";

#[derive(Default)]
pub struct Shared(Mutex<HashMap<String, Inner>>);

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    port: Option<u16>,
}

/// A space id safe for a folder name ("" and anything odd → "home").
pub fn space_key(space: &str) -> String {
    let s: String = space.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    if s.is_empty() { "home".into() } else { s }
}

fn space_dir(app: &AppHandle, space: &str) -> PathBuf {
    crate::engine::data_dir(app).join("browser").join(space_key(space))
}

/// The space's profile. The first time, it starts as a copy of the one profile
/// every space used to share, so nobody is signed out by the split.
fn profile_dir(app: &AppHandle, space: &str) -> PathBuf {
    let dir = space_dir(app, space).join("profile");
    #[cfg(target_os = "macos")]
    let old = crate::engine::data_dir(app).join("browser").join("profile");
    #[cfg(target_os = "macos")]
    if !dir.exists() && old.is_dir() {
        let _ = std::fs::create_dir_all(space_dir(app, space));
        let _ = Command::new("/bin/cp").arg("-Rp").arg(&old).arg(&dir).status();
        for lock in ["SingletonLock", "SingletonCookie", "SingletonSocket", "DevToolsActivePort"] {
            let _ = std::fs::remove_file(dir.join(lock));
        }
    }
    dir
}

fn port_file(app: &AppHandle, space: &str) -> PathBuf {
    space_dir(app, space).join("profile").join("DevToolsActivePort")
}

/// The port the shared browser listens on, kept across restarts: jobs got it in
/// their environment when they started, so a restarted browser must come back on
/// the same one or every running job loses it.
fn stable_port(app: &AppHandle, space: &str) -> u16 {
    let file = space_dir(app, space).join("port");
    // the first space to start after the split keeps the old shared port, so jobs
    // that were already running with it find their browser again
    let old = crate::engine::data_dir(app).join("browser").join("port");
    if !file.exists() && old.exists() {
        let _ = std::fs::create_dir_all(space_dir(app, space));
        let _ = std::fs::rename(&old, &file);
    }
    let free = |p: u16| std::net::TcpListener::bind(("127.0.0.1", p)).is_ok();
    if let Some(p) = std::fs::read_to_string(&file).ok().and_then(|t| t.trim().parse::<u16>().ok()).filter(|p| *p > 1024 && free(*p)) {
        return p;
    }
    let p = std::net::TcpListener::bind(("127.0.0.1", 0)).ok().and_then(|l| l.local_addr().ok()).map(|a| a.port()).unwrap_or(0);
    if p != 0 {
        let _ = std::fs::write(&file, p.to_string());
    }
    p
}

fn read_port(app: &AppHandle, space: &str) -> Option<u16> {
    std::fs::read_to_string(port_file(app, space)).ok()?.lines().next()?.trim().parse().ok()
}

/// The browser's DevTools WebSocket, when a Chrome DevTools endpoint answers on this port.
fn ws_url(port: u16) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
    let _ = s.set_read_timeout(Some(Duration::from_millis(1500)));
    s.write_all(b"GET /json/version HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").ok()?;
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    if !text.lines().next().is_some_and(|l| l.contains(" 200")) {
        return None;
    }
    let body = text.split_once("\r\n\r\n")?.1;
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    v.get("webSocketDebuggerUrl")?.as_str().map(String::from)
}

/// A Chrome DevTools endpoint answers on this port.
fn answers(port: u16) -> bool {
    ws_url(port).is_some()
}

#[cfg(windows)]
/// Ask the browser on `port` to quit (it writes its cookies out first); true once it is gone.
fn close_over_cdp(port: u16) -> bool {
    let Some(url) = ws_url(port) else { return true };
    let Ok((mut ws, _)) = tungstenite::connect(url.as_str()) else { return false };
    let _ = ws.send(tungstenite::Message::text(r#"{"id":1,"method":"Browser.close"}"#));
    let until = Instant::now() + Duration::from_secs(5);
    while Instant::now() < until {
        if !answers(port) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

/// The Chrome build a program is: `--version` where that only prints it; on Windows (where
/// chrome.exe --version may open a window) the version folder Chrome for Testing unpacks
/// into, or the one beside chrome.exe.
fn chrome_version(chrome: &std::path::Path) -> Option<String> {
    let is_version = |s: &str| s.split('.').count() == 4 && s.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    #[cfg(windows)]
    {
        let named = chrome.ancestors().filter_map(|a| a.file_name()?.to_str()).find(|n| is_version(n)).map(String::from);
        let beside = || std::fs::read_dir(chrome.parent()?).ok()?.flatten().filter_map(|e| e.file_name().to_str().map(String::from)).filter(|n| is_version(n)).max();
        named.or_else(beside)
    }
    #[cfg(not(windows))]
    {
        let out = Command::new(chrome).arg("--version").stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        text.split_whitespace().find(|w| is_version(w)).map(String::from)
    }
}

/// Sites turn away "HeadlessChrome"; present the same build as plain Chrome on this system.
fn user_agent(chrome: &std::path::Path) -> Option<String> {
    static UA: OnceLock<String> = OnceLock::new();
    if let Some(ua) = UA.get() {
        return Some(ua.clone());
    }
    let version = chrome_version(chrome)?;
    let platform = if cfg!(target_os = "macos") {
        "Macintosh; Intel Mac OS X 10_15_7"
    } else if cfg!(windows) {
        "Windows NT 10.0; Win64; x64"
    } else {
        "X11; Linux x86_64"
    };
    let ua = format!("Mozilla/5.0 ({platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{version} Safari/537.36");
    Some(UA.get_or_init(|| ua).clone())
}

/// The space's running browser's DevTools port, without starting one.
pub fn port(app: &AppHandle, space: &str) -> Option<u16> {
    let shared = app.state::<Shared>();
    let mut all = shared.0.lock().ok()?;
    let inner = all.entry(space_key(space)).or_default();
    if let Some(p) = inner.port.filter(|p| answers(*p)) {
        return Some(p);
    }
    let p = read_port(app, space).filter(|p| answers(*p))?;
    inner.port = Some(p);
    Some(p)
}

/// ondra-browser can drive it. A Chrome that has run for hours can still answer
/// /json/version while every browser command hangs (seen after a heavy
/// WebGL page); checked at most once a minute.
fn works(app: &AppHandle, port: u16, force: bool) -> bool {
    static LAST_OK: Mutex<Option<(u16, Instant)>> = Mutex::new(None);
    if let Ok(last) = LAST_OK.lock() {
        if !force && last.is_some_and(|(p, at)| p == port && at.elapsed() < Duration::from_secs(60)) {
            return true;
        }
    }
    // a new session every time: an already-connected one keeps answering while
    // every new connection (each job's first command) hangs on a stuck tab
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let Some(mut cmd) = crate::tools::browser_command(app) else { return true };
    cmd.env("ONDRA_BROWSER_CDP", port.to_string())
        .env("ONDRA_BROWSER_SESSION", format!("ondra-health-{port}-{stamp}"))
        .env("ONDRA_BROWSER_IDLE_TIMEOUT_MS", "5000")
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
fn kill_profile_chrome(app: &AppHandle, space: &str, inner: &mut Inner) {
    if let Some(mut c) = inner.child.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    // this space's profile, and the old shared one (a Chrome left from before the split)
    #[cfg(unix)]
    let old = crate::engine::data_dir(app).join("browser").join("profile");
    #[cfg(unix)]
    for dir in [profile_dir(app, space), old] {
        let flag = format!("--user-data-dir={}", dir.display());
        // `--` first: without it pkill reads the pattern as an option and kills nothing
        let _ = Command::new("pkill").args(["-f", "--", &flag]).status();
    }
    // no command lines to search on Windows: the profile's Chrome wrote its port and its browser id to
    // DevToolsActivePort; ask that browser to quit, and only when the one on the port is that browser
    #[cfg(windows)]
    for dir in [profile_dir(app, space), crate::engine::data_dir(app).join("browser").join("profile")] {
        let Ok(text) = std::fs::read_to_string(dir.join("DevToolsActivePort")) else { continue };
        let mut lines = text.lines();
        let (Some(Ok(port)), Some(path)) = (lines.next().map(|l| l.trim().parse::<u16>()), lines.next().map(str::trim)) else { continue };
        if !path.is_empty() && ws_url(port).is_some_and(|url| url.ends_with(path)) {
            close_over_cdp(port);
        }
    }
    std::thread::sleep(Duration::from_millis(800));
    inner.port = None;
}

/// The space's browser's DevTools port, starting it if it is not running.
pub fn ensure(app: &AppHandle, space: &str) -> Result<u16, String> {
    ensure_checked(app, space, false)
}

/// A job's browser command just failed to get an answer: check with a fresh
/// connection now (not the once-a-minute cache) and restart the browser if it hangs.
#[tauri::command]
pub async fn browser_check(app: AppHandle, space: Option<String>) -> Result<u16, String> {
    let space = space.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || ensure_checked(&app, &space, true)).await.map_err(|e| e.to_string())?
}

fn ensure_checked(app: &AppHandle, space: &str, force: bool) -> Result<u16, String> {
    // on a first run without the browser in the app, it may still be downloading: wait for it
    // (before taking the lock, so nothing else waits behind this)
    crate::components::wait_usable(app, "chrome", Duration::from_secs(15 * 60));
    let shared = app.state::<Shared>();
    let mut all = shared.0.lock().map_err(|_| "browser lock".to_string())?;
    let inner = all.entry(space_key(space)).or_default();
    // A Chrome left by an earlier run of Ondra still answers but can't start new
    // tabs any more (its renderers fail to launch once the app that started it is
    // gone): only keep a browser this run started, and only while it works.
    let ours = inner.child.as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)));
    if !ours {
        kill_profile_chrome(app, space, inner);
    }
    if let Some(p) = inner.port.or_else(|| read_port(app, space)).filter(|p| ours && answers(*p)) {
        if works(app, p, force) {
            inner.port = Some(p);
            return Ok(p);
        }
        kill_profile_chrome(app, space, inner);
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
    let profile = profile_dir(app, space);
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(port_file(app, space));
    let mut cmd = crate::engine::background_command(&chrome);
    #[cfg(target_os = "macos")]
    cmd.arg("--use-mock-keychain");
    // the profile's own store, never the desktop keyring (no unlock prompt on Linux)
    #[cfg(not(windows))]
    cmd.arg("--password-store=basic");
    let port = stable_port(app, space);
    cmd.arg(format!("--user-data-dir={}", profile.display()))
        .arg(format!("--remote-debugging-port={port}"))
        .args([
            "--remote-debugging-address=127.0.0.1",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--window-size=1280,800",
        ]);
    if chrome.file_stem().is_none_or(|s| s != "chrome-headless-shell") {
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
        // Chrome writes DevToolsActivePort only when it picked the port itself (--port=0).
        if let Some(p) = (port != 0).then_some(port).or_else(|| read_port(app, space)).filter(|p| answers(*p)) {
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

/// Quit the browsers Ondra started (SIGTERM, or on Windows Browser.close, first, so cookies
/// are flushed to disk).
pub fn stop(app: &AppHandle) {
    let shared = app.state::<Shared>();
    let Ok(mut all) = shared.0.lock() else { return };
    let mut children: Vec<Child> = all.values_mut().filter_map(|inner| {
        #[cfg(windows)]
        if let Some(p) = inner.port {
            close_over_cdp(p);
        }
        inner.port = None;
        inner.child.take()
    }).collect();
    #[cfg(unix)]
    for child in &children {
        let _ = Command::new("/bin/kill").args(["-TERM", &child.id().to_string()]).status();
    }
    #[cfg(unix)]
    {
        let until = Instant::now() + Duration::from_secs(3);
        while Instant::now() < until && children.iter_mut().any(|c| matches!(c.try_wait(), Ok(None))) {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    for mut child in children {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// A job's ondra-browser session. It carries the browser's port so a session
/// bound to a tab of an earlier browser is never reused after a restart.
pub fn session_for(worker_id: &str, port: Option<u16>) -> String {
    match port {
        Some(p) => format!("w-{worker_id}-{p}"),
        None => format!("w-{worker_id}"),
    }
}

/// The session's daemon is up (`session list` starts nothing).
pub fn session_running(app: &AppHandle, session: &str) -> bool {
    let Some(mut cmd) = crate::tools::browser_command(app) else { return false };
    let Ok(out) = cmd.args(["session", "list", "--json"]).stdin(Stdio::null()).stderr(Stdio::null()).output() else { return false };
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    v.pointer("/data/sessions")
        .and_then(|s| s.as_array())
        .is_some_and(|list| list.iter().any(|s| s.as_str() == Some(session)))
}

/// The helper that makes `auth login --credential-provider keychain` work: this
/// same binary in credential mode (see `keychain.rs`).
pub fn keychain_helper() -> Option<String> {
    std::env::current_exe().ok().map(|exe| exe.display().to_string())
}

/// What makes an ondra-browser command use the shared browser in its own tab.
pub fn attach_env(port: u16, session: &str) -> Vec<(String, String)> {
    vec![
        ("ONDRA_BROWSER_CDP".into(), port.to_string()),
        ("ONDRA_BROWSER_PIN_TAB".into(), "1".into()),
        ("ONDRA_BROWSER_IDLE_TIMEOUT_MS".into(), IDLE_MS.into()),
        ("ONDRA_BROWSER_SESSION".into(), session.into()),
    ]
}

/// A job ended: close its tab and its session (the profile, and so the logins, stay).
#[tauri::command]
pub async fn browser_release(app: AppHandle, worker_id: String, space: Option<String>) {
    let space = space.unwrap_or_default();
    let _ = tauri::async_runtime::spawn_blocking(move || {
        let Some(port) = port(&app, &space) else { return };
        let session = session_for(&worker_id, Some(port));
        // even when its daemon timed out, the pinned session rebinds to the job's own tab
        for args in [&["tab", "close"][..], &["close"][..]] {
            let Some(mut cmd) = crate::tools::browser_command(&app) else { return };
            for (k, v) in attach_env(port, &session) {
                cmd.env(k, v);
            }
            let _ = cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
    })
    .await;
}
