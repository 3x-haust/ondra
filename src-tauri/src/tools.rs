//! The tools that ship with the app: ondra-browser (our browser tool, built from
//! helpers/browser, + a Chrome for Testing headless shell, a component: see
//! components.rs) and ondra-cuhost (background Mac app control). Nothing is
//! installed by hand; the only steps macOS insists on are the Accessibility
//! and Screen Recording grants, which belong to this app because it spawns
//! the tools.

use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Manager};

// ───────────── macOS permission FFI ─────────────
#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        pub fn AXIsProcessTrusted() -> bool;
        pub fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
        pub static kAXTrustedCheckOptionPrompt: *const c_void;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        pub fn CGPreflightScreenCaptureAccess() -> bool;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        pub static kCFBooleanTrue: *const c_void;
        pub static kCFTypeDictionaryKeyCallBacks: c_void;
        pub static kCFTypeDictionaryValueCallBacks: c_void;
        pub fn CFDictionaryCreate(
            allocator: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_callbacks: *const c_void,
            value_callbacks: *const c_void,
        ) -> *const c_void;
        pub fn CFRelease(cf: *const c_void);
    }
}

fn accessibility_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: a plain query with no arguments and no side effects.
        unsafe { mac::AXIsProcessTrusted() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

fn screen_recording_granted() -> bool {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: a plain query; it never shows UI.
        unsafe { mac::CGPreflightScreenCaptureAccess() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

/// Shows the system Accessibility prompt (once per app) and returns the current grant.
#[tauri::command]
pub fn request_accessibility() -> bool {
    #[cfg(target_os = "macos")]
    // SAFETY: builds a one-entry CFDictionary {kAXTrustedCheckOptionPrompt: true}
    // with the standard CF callbacks, passes it, then releases it.
    unsafe {
        use std::ffi::c_void;
        let keys = [mac::kAXTrustedCheckOptionPrompt];
        let values = [mac::kCFBooleanTrue];
        let dict = mac::CFDictionaryCreate(
            std::ptr::null(),
            keys.as_ptr(),
            values.as_ptr(),
            1,
            &raw const mac::kCFTypeDictionaryKeyCallBacks as *const c_void,
            &raw const mac::kCFTypeDictionaryValueCallBacks as *const c_void,
        );
        let trusted = mac::AXIsProcessTrustedWithOptions(dict);
        if !dict.is_null() {
            mac::CFRelease(dict);
        }
        trusted
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[tauri::command]
pub fn open_privacy_settings(pane: String) -> Result<(), String> {
    #[cfg(windows)]
    if pane == "microphone" {
        crate::store::open_windows_settings("privacy-microphone");
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    return Err(format!("no privacy settings page for {pane} here"));
    #[cfg(target_os = "macos")]
    let anchor = match pane.as_str() {
        "screen" => "Privacy_ScreenCapture",
        "microphone" => "Privacy_Microphone",
        "speech" => "Privacy_SpeechRecognition",
        _ => "Privacy_Accessibility",
    };
    #[cfg(target_os = "macos")]
    Command::new("/usr/bin/open")
        .arg(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The off-screen display jobs run Mac apps on, held while the app runs.
static DISPLAY: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

/// Hold the off-screen display for as long as the app runs, so a job starting or ending its
/// Mac-app helper attaches or drops no display: macOS lays the user's Stage Manager stage out
/// again on each, and a window of theirs shrinks for a moment. The helper exits when its
/// stdin closes, also when the app is killed.
pub fn hold_display() {
    let Some(host) = sidecar("ondra-cuhost") else { return };
    let Ok(mut held) = DISPLAY.lock() else { return };
    if held.is_some() {
        return;
    }
    *held = Command::new(host).arg("--hold-display").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().ok();
}

pub fn release_display() {
    if let Some(mut child) = DISPLAY.lock().ok().and_then(|mut d| d.take()) {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The guide laid over System Settings' privacy list (one at a time).
static GUIDE: std::sync::Mutex<Option<std::process::Child>> = std::sync::Mutex::new(None);

/// Show a small panel over System Settings with Ondra's tile to drag into the privacy list
/// ("Ondra를 손쉬운 사용 목록에 끌어다 놓으세요"); it goes away once the permission is on.
#[tauri::command]
pub fn permission_guide(pane: String, title: String, sub: String) -> Result<(), String> {
    let mut guide = GUIDE.lock().map_err(|e| e.to_string())?;
    if let Some(mut old) = guide.take() {
        let _ = old.kill();
        let _ = old.wait();
    }
    // the app the user drags in: the bundle this runs from (none when run from a dev build)
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let Some(app) = exe.ancestors().find(|p| p.extension().is_some_and(|x| x == "app")) else { return Ok(()) };
    let Some(host) = sidecar("ondra-cuhost") else { return Ok(()) };
    let pane = if pane == "screen" { "screen" } else { "accessibility" };
    let child = Command::new(host)
        .args(["--guide", pane, "--app"])
        .arg(app)
        .args(["--title", &title, "--sub", &sub])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    *guide = Some(child);
    Ok(())
}

// ───────────── locating bundled files ─────────────

/// Sidecars sit beside the running executable, both in `tauri dev` and in the bundle.
pub fn sidecar(name: &str) -> Option<PathBuf> {
    let path = sidecar_dir()?.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
    path.is_file().then_some(path)
}

pub fn sidecar_dir() -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|d| d.to_path_buf())
}

/// A bundled resource folder: the app's Resources in a build, or
/// `src-tauri/resources` (or the repo's `skills/`) during development.
pub fn resource(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let bundled = app.path().resource_dir().ok().map(|d| d.join(name));
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join(name);
    [bundled, Some(dev)].into_iter().flatten().find(|d| d.is_dir())
}

/// The background-activation guard dylib: beside the helper in the bundle's Resources,
/// else src-tauri/binaries during development.
pub fn guard_dylib(app: &AppHandle) -> Option<PathBuf> {
    let name = "ondra-bgguard.dylib";
    let bundled = app.path().resource_dir().ok().map(|d| d.join(name));
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(name);
    [bundled, Some(dev)].into_iter().flatten().find(|p| p.is_file())
}

/// The Chrome ondra-browser drives: the browser component (see components.rs), the
/// one an older app kept in its Resources, else a system Chrome (the only one on Windows
/// and Linux on ARM, which have no Chrome for Testing build).
pub fn chrome_path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(bin) = crate::components::path(app, "chrome").or_else(|| resource(app, "chrome")).and_then(|d| chrome_in(&d)) {
        return Some(bin);
    }
    system_chrome()
}

fn system_chrome() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let found = Some(PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"));
    #[cfg(target_os = "linux")]
    let found = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
        .iter()
        .flat_map(|name| ["/usr/bin", "/usr/local/bin", "/snap/bin", "/opt/google/chrome"].map(|dir| PathBuf::from(dir).join(name)))
        .find(|p| p.is_file());
    #[cfg(windows)]
    let found = [
        ("ProgramFiles", r"Google\Chrome\Application\chrome.exe"),
        ("ProgramFiles(x86)", r"Google\Chrome\Application\chrome.exe"),
        ("LOCALAPPDATA", r"Google\Chrome\Application\chrome.exe"),
        ("ProgramFiles(x86)", r"Microsoft\Edge\Application\msedge.exe"),
        ("ProgramFiles", r"Microsoft\Edge\Application\msedge.exe"),
    ]
    .iter()
    .filter_map(|(var, rel)| std::env::var_os(var).map(|base| PathBuf::from(base).join(rel)))
    .find(|p| p.is_file());
    found.filter(|p| p.is_file())
}

/// The Chrome for Testing program inside a folder of it (`<dir>/chrome-*-<platform>/…`).
pub fn chrome_in(dir: &Path) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let bin = e.path().join(format!("chrome-headless-shell{}", std::env::consts::EXE_SUFFIX));
        if bin.is_file() {
            return Some(bin);
        }
        let full = e.path().join("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
        if full.is_file() {
            return Some(full);
        }
    }
    None
}

/// A Command for ondra-browser that finds its Chrome.
pub fn browser_command(app: &AppHandle) -> Option<Command> {
    let mut cmd = crate::engine::background_command(sidecar("ondra-browser")?);
    if let Some(chrome) = chrome_path(app) {
        cmd.env("ONDRA_BROWSER_EXECUTABLE_PATH", chrome);
    }
    Some(cmd)
}

fn first_line(cmd: Option<Command>, args: &[&str]) -> Option<String> {
    let out = cmd?.args(args).stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty()).then(|| text.lines().next().unwrap_or_default().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    browser_version: Option<String>,
    chrome_ready: bool,
    desktop_version: Option<String>,
    accessibility: bool,
    screen_recording: bool,
}

/// Async so the checks (a few child processes) run off the main thread.
#[tauri::command]
pub async fn tool_status(app: AppHandle) -> ToolStatus {
    // `ondra-cuhost --version` / `ondra-browser --version` print "<name> <version>"
    let version = |name: &str| first_line(sidecar(name).map(crate::engine::background_command), &["--version"]).map(|s| s.trim_start_matches(name).trim().to_string());
    let desktop_version = version("ondra-cuhost");
    ToolStatus {
        browser_version: version("ondra-browser"),
        chrome_ready: chrome_path(&app).is_some(),
        desktop_version,
        accessibility: accessibility_granted(),
        screen_recording: screen_recording_granted(),
    }
}

// ───────────── what each worker gets ─────────────

/// Environment every worker gets so the tools "just work" inside its session:
/// the bundled binaries on PATH, the shared browser (its own tab in it, see
/// `browser.rs`), keychain sign-in, its own folder for screenshots and recordings,
/// and one for builds and scratch work.
/// Async: the first job may have to start the shared browser.
#[tauri::command]
pub async fn worker_env(app: AppHandle, worker_id: String, space: Option<String>) -> Vec<(String, String)> {
    let space = space.unwrap_or_default();
    // the app's own tool probe never opens a browser
    let shared = if worker_id == "tools" {
        None
    } else {
        let app = app.clone();
        let space = space.clone();
        tauri::async_runtime::spawn_blocking(move || crate::browser::ensure(&app, &space).ok()).await.ok().flatten()
    };
    let mut env = Vec::new();
    // agent_spawn swaps this for the saved secrets (secrets.rs); the page only sees the flag
    env.push((crate::secrets::MARKER.into(), "1".into()));
    // a Claude or Codex account searches the web with its own provider's built-in web_search
    // (the engine adds it only for those, and drops it for a session the provider refuses it in)
    env.push(("PI_HOSTED_WEB_SEARCH".into(), "1".into()));
    if let Some(dir) = sidecar_dir() {
        // engine.rs appends the user's own PATH after this.
        env.push(("PATH".into(), dir.display().to_string()));
    }
    // `browse`, the browser-use skill's lean loop over ondra-browser
    // and its net.js on every page of the job's tab, so `browse` can tell when a page is done
    // loading data (it must be there when the session's daemon starts)
    if let Some(dir) = bundled_skills_root(&app).map(|r| r.join("browser-use")).filter(|d| d.join("browse").is_file()) {
        env.push(("ONDRA_BROWSER_INIT_SCRIPTS".into(), dir.join("net.js").display().to_string()));
        env.push(("PATH".into(), dir.display().to_string()));
    }
    if let Some(chrome) = chrome_path(&app) {
        env.push(("ONDRA_BROWSER_EXECUTABLE_PATH".into(), chrome.display().to_string()));
    }
    // `ondra-binary` runs the analyzer component; while it is still coming, the folder it will be
    // in (the launcher waits for it there)
    if let Some(dir) = crate::components::path(&app, "binary-analysis").or_else(|| crate::components::expected(&app, "binary-analysis")) {
        env.push(("ONDRA_BINARY_ANALYSIS".into(), dir.display().to_string()));
    }
    // Background host computer use is the default when its signed helper is bundled.
    // The engine's computer extension spawns it on `start`; no VM guest is involved.
    if let Some(cuhost) = sidecar("ondra-cuhost") {
        env.push(("ONDRA_COMPUTER_HOST".into(), "1".into()));
        env.push(("ONDRA_COMPUTER_HOST_APP_PID".into(), std::process::id().to_string()));
        env.push(("ONDRA_COMPUTER_HOST_BIN".into(), cuhost.display().to_string()));
        // The guard is injected into an app the helper opens in the background so the app
        // cannot make itself a Dock app or come to the front. It ships beside the helper
        // (bundle Resources) or, in development, in src-tauri/binaries.
        if let Some(guard) = guard_dylib(&app) {
            env.push(("ONDRA_COMPUTER_HOST_GUARD".into(), guard.display().to_string()));
        }
    }
    let session = crate::browser::session_for(&worker_id, shared);
    match shared {
        Some(port) => env.extend(crate::browser::attach_env(port, &session)),
        // the shared browser would not start: the job gets a browser of its own
        None => env.push(("ONDRA_BROWSER_SESSION".into(), session)),
    }
    if let Some(helper) = crate::browser::keychain_helper() {
        env.push(("ONDRA_BROWSER_KEYCHAIN".into(), helper));
    }
    if let Some(sdk) = crate::devices::job_sdk(&crate::engine::data_dir(&app)) {
        let sdk = sdk.display().to_string();
        env.push(("ANDROID_HOME".into(), sdk.clone()));
        env.push(("ANDROID_SDK_ROOT".into(), sdk));
    }
    if let Some(xc) = crate::devices::xcode_cache() {
        env.push(("XCODE_XCCONFIG_FILE".into(), xc.display().to_string()));
    }
    env.push(("APP_WORKER_ID".into(), worker_id.clone()));
    env.extend(crate::bridge::env());
    env.push(("ONDRA_HOOKS_FILE".into(), hooks_file(&app).display().to_string()));
    env.push(("APP_SCRATCH_DIR".into(), crate::store::scratch_dir(&worker_id).display().to_string()));
    env.push(("APP_PETS_DIR".into(), crate::pet::pets_dir(&app).display().to_string()));
    env.push(("APP_ARTIFACTS_DIR".into(), crate::store::artifacts_dir(app, worker_id)));
    env
}

/// Run a command and return its stdout, or None if it fails or takes longer than `limit` (then it's killed).
fn output_within(mut cmd: Command, limit: std::time::Duration) -> Option<Vec<u8>> {
    let mut child = cmd.spawn().ok()?;
    let until = std::time::Instant::now() + limit;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < until => std::thread::sleep(std::time::Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = Vec::new();
    std::io::Read::read_to_end(child.stdout.as_mut()?, &mut out).ok()?;
    Some(out)
}

/// Port of a worker's live browser stream, if its browser is open.
#[tauri::command]
pub async fn browser_stream_port(app: AppHandle, worker_id: String, space: Option<String>) -> Option<u16> {
    let shared = crate::browser::port(&app, &space.unwrap_or_default());
    let mut cmd = browser_command(&app)?;
    let session = crate::browser::session_for(&worker_id, shared);
    // asking a session that is not running would start it (and open a tab)
    if !crate::browser::session_running(&app, &session) {
        return None;
    }
    if let Some(port) = shared {
        cmd.envs(crate::browser::attach_env(port, &session));
    }
    cmd.args(["--session", &session, "stream", "status", "--json"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    // a stuck browser never answers; don't let the panel's poll pile up hung processes
    let stdout = output_within(cmd, std::time::Duration::from_secs(4))?;
    let v: serde_json::Value = serde_json::from_slice(&stdout).ok()?;
    let data = v.get("data")?;
    if data.get("connected").and_then(|c| c.as_bool()) != Some(true) {
        return None;
    }
    data.get("port").and_then(|p| p.as_u64()).map(|p| p as u16)
}

/// The skills every worker gets, as SKILL.md paths for `--skill`.
/// Engine extensions every worker loads (permission modes).
#[tauri::command(async)]
pub fn worker_extensions(app: AppHandle) -> Vec<String> {
    let bundled = app.path().resource_dir().ok().map(|d| d.join("app-extensions"));
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../extensions");
    let Some(root) = [bundled, Some(dev)].into_iter().flatten().find(|d| d.is_dir()) else { return vec![] };
    let Ok(entries) = std::fs::read_dir(&root) else { return vec![] };
    let mut out: Vec<String> = entries
        .flatten()
        .map(|e| e.path())
        // tests sit next to the extensions; they are not extensions
        .filter(|p| p.extension().is_some_and(|x| x == "ts") && !p.to_string_lossy().ends_with(".test.ts"))
        .map(|p| p.display().to_string())
        .collect();
    out.sort();
    out
}

/// Skills that ship with the app (`app-skills`, or `skills/` next to the sources).
fn bundled_skills_root(app: &AppHandle) -> Option<PathBuf> {
    let bundled = app.path().resource_dir().ok().map(|d| d.join("app-skills"));
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../skills");
    [bundled, Some(dev)].into_iter().flatten().find(|d| d.is_dir())
}

/// Skills made in the app (listed in the app state, which passes them to jobs):
/// `<data dir>/skills/<name>/SKILL.md`.
fn user_skills_root(app: &AppHandle) -> PathBuf {
    crate::engine::data_dir(app).join("skills")
}

/// The user's changes to bundled skills: `<data dir>/skill-overrides/<name>/SKILL.md`.
/// Workers get one of these instead of the bundled skill with that name.
fn skill_overrides_root(app: &AppHandle) -> PathBuf {
    crate::engine::data_dir(app).join("skill-overrides")
}

/// (folder name, SKILL.md) for every skill folder under `root`.
fn skill_dirs(root: &std::path::Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(root) else { return vec![] };
    entries
        .flatten()
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path().join("SKILL.md")))
        .filter(|(_, p)| p.is_file())
        .collect()
}

fn skill_name_ok(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    name: String,
    /// The SKILL.md workers get (the user's changed copy when there is one).
    path: String,
    /// The user changed it (their copy is used).
    overridden: bool,
    /// The bundled original.
    original: String,
}

/// The skills that ship with the app, each replaced by the user's changed copy if any.
#[tauri::command]
pub fn skill_list(app: AppHandle) -> Vec<SkillFile> {
    let bundled = bundled_skills_root(&app).map(|r| skill_dirs(&r)).unwrap_or_default();
    let changed = skill_dirs(&skill_overrides_root(&app));
    let mut out: Vec<SkillFile> = bundled
        .iter()
        .map(|(name, path)| {
            let own = changed.iter().find(|(n, _)| n == name);
            SkillFile {
                name: name.clone(),
                path: own.map_or(path, |(_, p)| p).display().to_string(),
                overridden: own.is_some(),
                original: path.display().to_string(),
            }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Skills the user installed for every agent (~/.agents/skills), with their
/// one-line description, so Ondra can hand a job only the ones that fit it.
#[derive(Serialize)]
pub struct GlobalSkill {
    name: String,
    path: String,
    description: String,
}

#[tauri::command(async)]
pub fn global_skills() -> Vec<GlobalSkill> {
    let Some(home) = crate::engine::user_home() else { return vec![] };
    let mut out = Vec::new();
    for (name, path) in skill_dirs(&home.join(".agents/skills")) {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        // front matter "description:" (a one-liner or a folded ">" block)
        let mut desc = String::new();
        let mut lines = text.lines().skip_while(|l| l.trim() != "---").skip(1);
        while let Some(l) = lines.next() {
            if l.trim() == "---" {
                break;
            }
            if let Some(v) = l.strip_prefix("description:") {
                let v = v.trim();
                if v.starts_with('>') || v.starts_with('|') || v.is_empty() {
                    for c in lines.by_ref() {
                        if !c.starts_with(' ') {
                            break;
                        }
                        desc.push_str(c.trim());
                        desc.push(' ');
                    }
                } else {
                    desc.push_str(v.trim_matches('"'));
                }
                break;
            }
        }
        out.push(GlobalSkill { name, path: path.display().to_string(), description: desc.trim().chars().take(400).collect() });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

#[tauri::command]
pub fn worker_skills(app: AppHandle) -> Vec<String> {
    skill_list(app).into_iter().map(|s| s.path).collect()
}

/// Write a skill's SKILL.md: a change to a bundled skill (`changed`) or a skill made
/// in the app. Returns the skill's folder.
#[tauri::command]
pub fn skill_save(app: AppHandle, name: String, text: String, changed: bool) -> Result<String, String> {
    if !skill_name_ok(&name) {
        return Err("이름은 영문, 숫자, -, _ 만 쓸 수 있어요".into());
    }
    let root = if changed { skill_overrides_root(&app) } else { user_skills_root(&app) };
    let dir = root.join(&name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("SKILL.md");
    let tmp = dir.join("SKILL.md.tmp");
    std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

/// Remove a skill made in the app, or (`changed`) the user's change to a bundled one.
#[tauri::command]
pub fn skill_remove(app: AppHandle, name: String, changed: bool) -> Result<(), String> {
    if !skill_name_ok(&name) {
        return Err("잘못된 이름".into());
    }
    let root = if changed { skill_overrides_root(&app) } else { user_skills_root(&app) };
    let dir = root.join(&name);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hooks (shell commands run on engine events), read by `extensions/hooks.ts`.
fn hooks_file(app: &AppHandle) -> PathBuf {
    crate::engine::data_dir(app).join("hooks.json")
}

#[tauri::command]
pub fn hooks_load(app: AppHandle) -> String {
    std::fs::read_to_string(hooks_file(&app)).unwrap_or_else(|_| "[]".into())
}

#[tauri::command]
pub fn hooks_save(app: AppHandle, json: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    let path = hooks_file(&app);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| e.to_string())
}

/// A macOS notification (job finished, a job needs you) while the window is in the background.
/// Sent as Ondra (its bundle id), so it shows the Ondra icon; osascript would
/// show Script Editor's. Falls back to osascript if the id can't be used.
/// An alarm (`sound`) rings with a sound; with a `tag`, a click on it brings Ondra up and tells
/// the page ("notify:click" with the tag), which opens the line it is about. macOS shows no
/// banner for the app in front, so an alarm while Ondra is in front only plays the sound.
#[tauri::command]
pub async fn notify(app: AppHandle, title: String, body: String, sound: Option<bool>, tag: Option<String>) {
    let sound = sound.unwrap_or(false);
    if sound && app.get_webview_window("main").and_then(|w| w.is_focused().ok()).unwrap_or(false) {
        play_alarm();
        return;
    }
    let waits = tag.is_some();
    let send = move || {
        #[cfg(target_os = "macos")]
        {
            static AS_ONDRA: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
            let id = app.config().identifier.clone();
            let ok = *AS_ONDRA.get_or_init(|| {
                #[cfg(debug_assertions)]
                dev_bundle(&app, &id);
                mac_notification_sys::set_application(&id).is_ok()
            });
            if ok {
                let mut n = mac_notification_sys::Notification::new();
                n.title(&title).message(&body);
                if sound {
                    n.sound(ALARM_SOUND);
                }
                // waits (on its own thread) until it is clicked or cleared
                n.wait_for_click(waits);
                if let Ok(answer) = n.send() {
                    if answer == mac_notification_sys::NotificationResponse::Click {
                        if let Some(tag) = tag {
                            clicked(&app, &tag);
                        }
                    }
                    return;
                }
            }
        }
        #[cfg(not(target_os = "linux"))]
        {
            let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
            let tone = if sound { format!(" sound name \"{ALARM_SOUND}\"") } else { String::new() };
            let script = format!("display notification \"{}\" with title \"{}\"{}", esc(&body), esc(&title), tone);
            let _ = std::process::Command::new("/usr/bin/osascript").args(["-e", &script]).output();
        }
        #[cfg(target_os = "linux")]
        {
            if sound {
                play_alarm();
            }
            // the default action is a click on the notice itself; waiting for it holds this thread
            let mut n = notify_rust::Notification::new();
            n.appname(&app.package_info().name).summary(&title).body(&body);
            if waits {
                n.action("default", "열기");
            }
            if let (Ok(shown), Some(tag)) = (n.show(), tag) {
                shown.wait_for_action(|action| {
                    if action == "default" {
                        clicked(&app, &tag);
                    }
                });
            }
        }
    };
    if waits {
        // a click may come much later: a thread of its own, not one of the blocking pool's
        std::thread::spawn(send);
    } else {
        let _ = tauri::async_runtime::spawn_blocking(send).await;
    }
}

/// Ondra's own sound when a job ends (Settings › 작업 끝 소리), at `volume` (0–1): one of the
/// bundled `sounds/<name>.wav` (scripts/make-sounds.py), by name only, so the page can't make it
/// play an arbitrary file.
#[tauri::command]
pub fn play_sound(app: AppHandle, name: String, volume: f64) {
    const SOUNDS: [&str; 3] = ["done", "waiting", "failed"];
    if !SOUNDS.contains(&name.as_str()) || !(volume > 0.0) {
        return;
    }
    let Ok(dir) = app.path().resource_dir() else { return };
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("/usr/bin/afplay")
        .args(["-v", &format!("{:.2}", volume.min(1.0))])
        .arg(dir.join("sounds").join(format!("{name}.wav")))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("paplay")
        .arg(format!("--volume={}", (volume.min(1.0) * 65536.0) as u32))
        .arg(dir.join("sounds").join(format!("{name}.wav")))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/** the system sound an alarm rings with (/System/Library/Sounds) */
#[cfg(not(target_os = "linux"))]
const ALARM_SOUND: &str = "Glass";

fn play_alarm() {
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("/usr/bin/afplay")
        .arg(format!("/System/Library/Sounds/{ALARM_SOUND}.aiff"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    // the freedesktop sound theme's bell, which desktops ship with
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("paplay")
        .arg("/usr/share/sounds/freedesktop/stereo/complete.oga")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
}

/** a tagged notice was clicked: Ondra comes up and the page opens what it was about */
#[cfg(not(windows))]
fn clicked(app: &AppHandle, tag: &str) {
    use tauri::Emitter;
    if let Some(w) = app.get_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    let _ = app.emit("notify:click", tag.to_string());
}

/// A dev build is a bare executable with no bundle, so macOS can't find the app
/// id. Register a stub bundle with that id and the brand icon in the data dir.
#[cfg(all(target_os = "macos", debug_assertions))]
fn dev_bundle(app: &AppHandle, id: &str) {
    let root = crate::engine::data_dir(app).join("notifier/Ondra.app/Contents");
    let _ = std::fs::create_dir_all(root.join("MacOS"));
    let _ = std::fs::create_dir_all(root.join("Resources"));
    let _ = std::fs::copy(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("icons/icon.icns"), root.join("Resources/icon.icns"));
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>{id}</string><key>CFBundleName</key><string>Ondra</string><key>CFBundleDisplayName</key><string>Ondra</string><key>CFBundleExecutable</key><string>ondra</string><key>CFBundleIconFile</key><string>icon</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>"#
    );
    let _ = std::fs::write(root.join("Info.plist"), plist);
    let exe = root.join("MacOS/ondra");
    if !exe.exists() {
        let _ = std::fs::write(&exe, "#!/bin/sh\nexit 0\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755));
        }
    }
    let bundle = root.parent().unwrap().to_path_buf();
    let _ = std::process::Command::new("/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister")
        .args(["-f".as_ref(), bundle.as_os_str()])
        .output();
}

// ───────────── per-space command-line accounts ─────────────
//
// Every space but 개인 keeps its own command-line logins in a home folder of its
// own, like running every command through a per-account wrapper: gh, git, ssh,
// aws, gcloud, docker and kubectl are pointed there by their settings variables,
// and CLIs that only know $HOME (vercel, supabase, firebase, eas …) run through
// small shims that give them that home. A CLI that isn't logged in there asks to
// log in, and from then on that space has its own login. 개인 uses the Mac's.

/** CLIs that keep their login under $HOME and have no variable to move it */
#[cfg(unix)]
const HOME_CLIS: &[&str] = &["vercel", "supabase", "netlify", "railway", "fly", "flyctl", "firebase", "eas", "heroku", "doctl", "wrangler", "stripe"];

pub(crate) fn space_base(app: &AppHandle, space: &str) -> PathBuf {
    let safe: String = space.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    crate::engine::data_dir(app).join("spaces").join(if safe.is_empty() { "home".into() } else { safe })
}

fn expand_home(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => crate::engine::home().join(rest),
        None => PathBuf::from(p),
    }
}

/** the space's CLI home: a folder the user chose, its own, or none (개인: the Mac's) */
fn cli_home(app: &AppHandle, space: &str, home: Option<String>) -> Option<PathBuf> {
    match home.map(|h| h.trim().to_string()).filter(|h| !h.is_empty()) {
        Some(h) => Some(expand_home(&h)),
        None if space == "home" => None,
        None => Some(space_base(app, space).join("home")),
    }
}

/** the GitHub user gh is logged in as in this folder (from hosts.yml; the token is never read out) */
fn gh_user(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("hosts.yml")).ok()?;
    let mut in_github = false;
    for line in text.lines() {
        if !line.starts_with(' ') {
            in_github = line.trim_end().trim_end_matches(':') == "github.com";
            continue;
        }
        if in_github {
            if let Some(u) = line.trim().strip_prefix("user:") {
                let u = u.trim().trim_matches('"');
                if !u.is_empty() {
                    return Some(u.to_string());
                }
            }
        }
    }
    None
}

const OWN_GIT: &str = "# Ondra: git settings for one space. ~/.gitconfig applies first.";

/** A new space home: its git settings (yours first, then the space's) and the Mac keychain reachable. */
fn prepare_home(base: &Path) {
    let _ = std::fs::create_dir_all(base.join(".config/gh"));
    let git = base.join(".gitconfig");
    let logged_in = gh_user(&base.join(".config/gh")).is_some();
    let mut text = std::fs::read_to_string(&git).unwrap_or_default();
    let before = text.clone();
    if text.is_empty() {
        text = format!("{OWN_GIT}\n[include]\n\tpath = ~/.gitconfig\n");
    }
    // pushes over https use this space's gh login (only in settings Ondra made)
    let helper = "[credential \"https://github.com\"]";
    if logged_in && text.starts_with(OWN_GIT) && !text.contains(helper) {
        text.push_str(&format!("{helper}\n\thelper =\n\thelper = !gh auth git-credential\n"));
    }
    if text != before {
        let _ = std::fs::write(&git, text);
    }
    #[cfg(target_os = "macos")]
    link_keychain(base);
}

/** CLIs run with a space home as $HOME still find the Mac's login keychain */
#[cfg(target_os = "macos")]
fn link_keychain(base: &Path) {
    let kc = base.join("Library/Keychains");
    if !kc.exists() {
        if let Ok(h) = std::env::var("HOME") {
            let _ = std::fs::create_dir_all(base.join("Library"));
            #[cfg(unix)]
            let _ = std::os::unix::fs::symlink(PathBuf::from(h).join("Library/Keychains"), &kc);
        }
    }
}

/** shims that run HOME-only CLIs with the space's home, for the ones installed */
#[cfg(unix)]
fn write_shims(dir: &Path, base: &Path) {
    let _ = std::fs::create_dir_all(dir);
    let q = |p: &Path| p.display().to_string().replace('\'', "'\\''");
    for tool in HOME_CLIS {
        let shim = dir.join(tool);
        let real = std::env::split_paths(crate::engine::user_path()).map(|d| d.join(tool)).find(|p| p.is_file());
        let Some(real) = real else {
            let _ = std::fs::remove_file(&shim);
            continue;
        };
        let body = format!("#!/bin/sh\n# Ondra: {tool} with this space's own login\nHOME='{}' exec '{}' \"$@\"\n", q(base), q(&real));
        if std::fs::read_to_string(&shim).ok().as_deref() != Some(body.as_str()) {
            let _ = std::fs::write(&shim, body);
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755));
            }
        }
    }
}

#[tauri::command]
pub fn space_env(app: AppHandle, space: String, home: Option<String>) -> Vec<(String, String)> {
    // its connected services (MCP servers) and their sign-ins, its own
    let mcp = ("PI_MCP_DIR".to_string(), crate::mcp::dir(&app, &space).display().to_string());
    let Some(base) = cli_home(&app, &space, home.clone()) else { return vec![mcp] };
    let own = home.as_deref().map_or(true, |h| h.trim().is_empty());
    if own {
        prepare_home(&base);
    }
    let b = |rel: &str| base.join(rel).display().to_string();
    let mut env: Vec<(String, String)> = vec![
        ("GH_CONFIG_DIR".into(), b(".config/gh")),
        ("AWS_CONFIG_FILE".into(), b(".aws/config")),
        ("AWS_SHARED_CREDENTIALS_FILE".into(), b(".aws/credentials")),
        ("CLOUDSDK_CONFIG".into(), b(".config/gcloud")),
        ("DOCKER_CONFIG".into(), b(".docker")),
        ("KUBECONFIG".into(), b(".kube/config")),
        ("ONDRA_CLI_HOME".into(), base.display().to_string()),
        mcp,
    ];
    if base.join(".gitconfig").exists() {
        env.push(("GIT_CONFIG_GLOBAL".into(), b(".gitconfig")));
    }
    if base.join(".ssh/config").exists() {
        env.push(("GIT_SSH_COMMAND".into(), format!("ssh -F '{}'", b(".ssh/config"))));
    }
    let mut path = Vec::new();
    #[cfg(unix)]
    {
        #[cfg(target_os = "macos")]
        link_keychain(&base);
        let shims = space_base(&app, &space).join("bin");
        write_shims(&shims, &base);
        path.push(shims.display().to_string());
    }
    // a wrapper setup the user already has (…/home next to …/bin): its commands first
    if let Some(bin) = base.parent().map(|p| p.join("bin")).filter(|p| !own && p.is_dir()) {
        path.insert(0, bin.display().to_string());
    }
    if !path.is_empty() {
        env.push(("PATH".into(), path.join(crate::engine::PATH_SEPARATOR)));
    }
    env
}

#[derive(Serialize)]
pub struct SpaceTools {
    /** the space's CLI home (None: the Mac's own) */
    home: Option<String>,
    /** GitHub user this space is logged in as */
    gh_user: Option<String>,
    git_name: Option<String>,
    git_email: Option<String>,
}

fn git_get(file: Option<&Path>, key: &str) -> Option<String> {
    let mut cmd = crate::engine::background_command("git");
    cmd.arg("config");
    match file {
        Some(f) => cmd.arg("--file").arg(f).arg("--includes"),
        None => cmd.arg("--global"),
    };
    let out = cmd.args(["--get", key]).output().ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!v.is_empty()).then_some(v)
}

#[tauri::command]
pub fn space_tools(app: AppHandle, space: String, home: Option<String>) -> SpaceTools {
    let base = cli_home(&app, &space, home.clone());
    if let Some(b) = &base {
        if home.as_deref().map_or(true, |h| h.trim().is_empty()) {
            prepare_home(b);
        }
    }
    let gh_dir = base.as_ref().map(|b| b.join(".config/gh")).unwrap_or_else(|| {
        #[cfg(windows)]
        if let Some(dir) = std::env::var_os("GH_CONFIG_DIR").map(PathBuf::from).or_else(|| std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join("GitHub CLI"))) {
            return dir;
        }
        expand_home("~/.config/gh")
    });
    let git = base.as_ref().map(|b| b.join(".gitconfig"));
    SpaceTools {
        home: base.as_ref().map(|b| b.display().to_string()),
        gh_user: gh_user(&gh_dir),
        git_name: git_get(git.as_deref(), "user.name"),
        git_email: git_get(git.as_deref(), "user.email"),
    }
}

/** Opens a terminal that logs this space in to GitHub (gh asks in the browser). */
#[tauri::command]
pub fn space_gh_login(app: AppHandle, space: String, home: Option<String>) -> Result<(), String> {
    let base = cli_home(&app, &space, home);
    let gh = base.as_ref().map(|b| b.join(".config/gh"));
    if let Some(g) = &gh {
        std::fs::create_dir_all(g).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = Command::new("gh");
        if let Some(dir) = gh { cmd.env("GH_CONFIG_DIR", dir); }
        cmd.args(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"])
            .creation_flags(0x00000010).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    { open_gh_login(&space_base(&app, &space), gh) }
}

#[cfg(not(windows))]
fn open_gh_login(dir: &Path, gh: Option<PathBuf>) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let script = dir.join("github-login.command");
    let export = gh.map(|g| format!("export GH_CONFIG_DIR='{}'\n", g.display().to_string().replace('\'', "'\\''"))).unwrap_or_default();
    std::fs::write(&script, format!("#!/bin/zsh -l\n{export}gh auth login --hostname github.com --git-protocol https --web\necho\necho \"이 창은 닫아도 돼요.\"\n"))
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(target_os = "linux")]
    return crate::store::linux::terminal(&dir.display().to_string(), Some(&script.display().to_string()));
    #[cfg(target_os = "macos")]
    Command::new("/usr/bin/open").arg(&script).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/** Sets the name and email this space commits with (empty: the one in ~/.gitconfig). */
#[tauri::command(async)]
pub fn space_git_identity(app: AppHandle, space: String, home: Option<String>, name: String, email: String) -> Result<(), String> {
    let base = cli_home(&app, &space, home.clone());
    if let Some(b) = &base {
        if home.as_deref().map_or(true, |h| h.trim().is_empty()) {
            prepare_home(b);
        }
    }
    for (key, v) in [("user.name", name.trim()), ("user.email", email.trim())] {
        let mut cmd = crate::engine::background_command("git");
        cmd.arg("config");
        match &base {
            Some(b) => cmd.arg("--file").arg(b.join(".gitconfig")),
            None => cmd.arg("--global"),
        };
        if v.is_empty() {
            cmd.args(["--unset", key]);
        } else {
            cmd.args([key, v]);
        }
        let _ = cmd.output();
    }
    Ok(())
}

// ───────────────── a workspace's terminal command
// `work` (any name the user gives a space) in the user's own terminal opens a shell with that
// space's logins, as its jobs have them: gh, git, ssh, cloud CLIs, and claude / codex configs of
// its own, with the user's own shell files, PATH and tools otherwise. `work COMMAND …` runs one
// command so. Like a hand-made "company shell", made by Ondra for every workspace.

/** account and provider overrides a parent shell may carry: the space's own logins must win */
const UNSET_VARS: &str = "GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN GITHUB_ENTERPRISE_TOKEN GH_HOST GH_REPO \
ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL ANTHROPIC_PROFILE CLAUDE_CODE_OAUTH_TOKEN \
OPENAI_API_KEY CODEX_API_KEY OPENAI_BASE_URL OPENAI_ORG_ID OPENAI_ORGANIZATION \
GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS \
AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN SSH_AUTH_SOCK";
/** the first line of every launcher Ondra writes: only such a file is ever replaced or removed */
const LAUNCHER_MARK: &str = "# Ondra workspace shell";

fn real_home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
}
fn launcher_path(command: &str) -> PathBuf {
    real_home().join(".local/bin").join(command)
}
fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
fn is_ours(p: &Path) -> bool {
    std::fs::read_to_string(p).map(|t| t.lines().nth(1) == Some(LAUNCHER_MARK)).unwrap_or(false)
}
/** a name a terminal command can have, and no command of the Mac's already has */
fn check_command(command: &str) -> Result<(), String> {
    let ok = !command.is_empty() && command.len() <= 32 && command.starts_with(|c: char| c.is_ascii_lowercase()) && command.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_');
    if !ok {
        return Err("명령 이름은 영어 소문자로 시작하고 소문자·숫자·-·_만 써요".into());
    }
    let mine = launcher_path(command);
    for dir in std::env::split_paths(crate::engine::user_path()) {
        let p = dir.join(command);
        if p.is_file() && p != mine && !is_ours(&p) {
            return Err(format!("{command}은(는) 이미 있는 명령이에요 ({})", p.display()));
        }
    }
    if mine.exists() && !is_ours(&mine) {
        return Err(format!("{}에 Ondra가 만들지 않은 파일이 있어요", mine.display()));
    }
    Ok(())
}

/** The launcher's text: the space's env (as its jobs get it), then the user's own shell. */
fn launcher_text(label: &str, space: &str, base: &Path, env: &[(String, String)], folder: &str) -> String {
    let mut s = format!("#!/bin/zsh\n{LAUNCHER_MARK}: {label} ({space}). Ondra rewrites this file; change the workspace in Ondra.\nset -eu\nunset {UNSET_VARS}\n");
    let mut shims = Vec::new();
    for (k, v) in env {
        if k == "PATH" {
            shims.push(v.clone());
        } else {
            s.push_str(&format!("export {k}={}\n", sq(v)));
        }
    }
    let b = |rel: &str| sq(&base.join(rel).display().to_string());
    s.push_str(&format!(
        "export CLAUDE_CONFIG_DIR={}\nexport CODEX_HOME={}\nexport ANTHROPIC_CONFIG_DIR={}\nexport ONDRA_CLI_SPACE={}\nexport ONDRA_CLI_LABEL={}\nexport ZDOTDIR={}\n",
        b(".claude"),
        b(".codex"),
        b(".config/anthropic"),
        sq(space),
        sq(label),
        b(".zsh")
    ));
    if !shims.is_empty() {
        s.push_str(&format!("export ONDRA_CLI_PATH={}\nexport PATH=\"$ONDRA_CLI_PATH:$PATH\"\n", sq(&shims.join(":"))));
    }
    s.push_str(&format!("if (( $# )); then exec \"$@\"; fi\ncd {} 2>/dev/null || true\nexec /bin/zsh -l\n", sq(folder)));
    s
}

/** The space's own zsh dotfiles: the user's own ones first, then its history and its PATH ahead. */
fn write_zdotdir(base: &Path) -> std::io::Result<()> {
    let z = base.join(".zsh");
    std::fs::create_dir_all(&z)?;
    let own = |f: &str| format!("# Ondra: the user's own {f} first\n[[ -r \"$HOME/{f}\" ]] && source \"$HOME/{f}\"\n");
    std::fs::write(z.join(".zshenv"), own(".zshenv"))?;
    std::fs::write(z.join(".zprofile"), own(".zprofile"))?;
    std::fs::write(z.join(".zlogin"), own(".zlogin"))?;
    std::fs::write(
        z.join(".zshrc"),
        format!(
            "{}HISTFILE=\"$ZDOTDIR/.zsh_history\"\n# this workspace's commands stay first\n[[ -n \"${{ONDRA_CLI_PATH:-}}\" ]] && export PATH=\"$ONDRA_CLI_PATH:$PATH\"\n# which workspace this shell is\nPROMPT=\"%F{{cyan}}[${{ONDRA_CLI_LABEL}}]%f $PROMPT\"\n",
            own(".zshrc")
        ),
    )
}

#[derive(Serialize)]
pub struct SpaceCli {
    /** where the command is */
    path: String,
    /** ~/.local/bin isn't on the user's PATH: the command has to be typed with its path */
    off_path: bool,
}

/** Install (or update) the space's terminal command; a previous name of it goes. */
#[tauri::command(async)]
pub fn space_cli_install(app: AppHandle, space: String, home: Option<String>, command: String, label: String, folder: String, previous: Option<String>) -> Result<SpaceCli, String> {
    let command = command.trim().to_string();
    check_command(&command)?;
    let base = cli_home(&app, &space, home.clone()).ok_or("개인 워크스페이스는 Mac 그대로의 로그인을 써요")?;
    let env = space_env(app.clone(), space.clone(), home);
    write_zdotdir(&base).map_err(|e| e.to_string())?;
    let folder = if folder.trim().is_empty() || folder.trim() == "~" { real_home().display().to_string() } else { expand_home(folder.trim()).display().to_string() };
    let path = launcher_path(&command);
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&path, launcher_text(&label, &space, &base, &env, &folder)).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    if let Some(old) = previous.map(|p| p.trim().to_string()).filter(|p| !p.is_empty() && *p != command) {
        space_cli_remove(old);
    }
    let bin = path.parent().unwrap().to_path_buf();
    let off_path = !std::env::split_paths(crate::engine::user_path()).any(|d| d == bin);
    Ok(SpaceCli { path: path.display().to_string(), off_path })
}

/** Remove a space's terminal command (only a launcher Ondra wrote). */
#[tauri::command]
pub fn space_cli_remove(command: String) {
    let p = launcher_path(command.trim());
    if !command.trim().is_empty() && is_ours(&p) {
        let _ = std::fs::remove_file(p);
    }
}

#[cfg(test)]
mod cli_tests {
    use super::*;

    #[test]
    fn launcher_sets_the_space_and_leaves_the_rest() {
        let env = vec![("GH_CONFIG_DIR".to_string(), "/s/home/.config/gh".to_string()), ("PATH".to_string(), "/s/bin".to_string())];
        let t = launcher_text("회사", "sp1", Path::new("/s/home"), &env, "/Users/me/Work");
        assert_eq!(t.lines().nth(1).map(|l| l.starts_with(LAUNCHER_MARK)), Some(true));
        assert!(t.contains("export GH_CONFIG_DIR='/s/home/.config/gh'\n"));
        assert!(t.contains("export CODEX_HOME='/s/home/.codex'\n"));
        assert!(t.contains("export ZDOTDIR='/s/home/.zsh'\n"));
        assert!(t.contains("export PATH=\"$ONDRA_CLI_PATH:$PATH\"\n"));
        assert!(t.contains("unset GH_TOKEN"));
        assert!(t.contains("if (( $# )); then exec \"$@\"; fi\ncd '/Users/me/Work'"));
        assert!(!t.contains("export HOME"));
    }

    #[test]
    fn command_names() {
        assert!(check_command("Work").is_err());
        assert!(check_command("회사").is_err());
        assert!(check_command("").is_err());
        // a command the Mac already has is never taken over
        assert!(check_command("ls").is_err());
    }
}

#[cfg(test)]
mod cli_run_tests {
    use super::*;

    /** runs the launcher for real: one command, and the shell's own start (zsh -i) */
    #[test]
    #[ignore]
    fn launcher_runs() {
        let tmp = std::env::temp_dir().join(format!("ondra-cli-{}", std::process::id()));
        let base = tmp.join("home");
        std::fs::create_dir_all(base.join(".config/gh")).unwrap();
        write_zdotdir(&base).unwrap();
        let env = vec![("GH_CONFIG_DIR".to_string(), base.join(".config/gh").display().to_string()), ("PATH".to_string(), tmp.join("bin").display().to_string())];
        let script = tmp.join("work");
        std::fs::write(&script, launcher_text("회사", "sp1", &base, &env, "/tmp")).unwrap();
        let out = Command::new("/bin/zsh").arg(&script).args(["/bin/sh", "-c", "echo \"$GH_CONFIG_DIR|$ZDOTDIR|$GH_TOKEN|${PATH%%:*}\""]).env("GH_TOKEN", "x").output().unwrap();
        let said = String::from_utf8_lossy(&out.stdout);
        eprintln!("one: {said} / {}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(said.trim(), format!("{}||{}|{}", base.join(".config/gh").display(), "", tmp.join("bin").display()).replacen("||", &format!("|{}|", base.join(".zsh").display()), 1));
        let out = Command::new("/bin/zsh").arg(&script).args(["/bin/zsh", "-i", "-c", "echo \"$HISTFILE|${PATH%%:*}|$PROMPT\""]).output().unwrap();
        let said = String::from_utf8_lossy(&out.stdout);
        eprintln!("interactive: {said} / {}", String::from_utf8_lossy(&out.stderr));
        assert!(said.contains(&format!("{}/.zsh_history|{}|", base.join(".zsh").display(), tmp.join("bin").display())));
        assert!(said.contains("[${ONDRA_CLI_LABEL}]") || said.contains("[회사]"));
        let _ = std::fs::remove_dir_all(tmp);
    }
}
