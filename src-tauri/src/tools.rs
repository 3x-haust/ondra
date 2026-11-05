//! The tools that ship inside the app: agent-browser (+ a bundled Chrome for
//! Testing headless shell), agent-desktop (+ its macOS helper). Nothing is
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
    let anchor = if pane == "screen" { "Privacy_ScreenCapture" } else { "Privacy_Accessibility" };
    Command::new("/usr/bin/open")
        .arg(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ───────────── locating bundled files ─────────────

/// Sidecars sit beside the running executable, both in `tauri dev` and in the bundle.
pub fn sidecar(name: &str) -> Option<PathBuf> {
    let path = sidecar_dir()?.join(name);
    path.exists().then_some(path)
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

/// The Chrome agent-browser drives: the bundled headless shell, else a system Chrome.
pub fn chrome_path(app: &AppHandle) -> Option<PathBuf> {
    if let Some(dir) = resource(app, "chrome") {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                let bin = e.path().join("chrome-headless-shell");
                if bin.is_file() {
                    return Some(bin);
                }
                let full = e.path().join("Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
                if full.is_file() {
                    return Some(full);
                }
            }
        }
    }
    let system = PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    system.is_file().then_some(system)
}

/// A Command for agent-browser that finds its skills and its Chrome.
pub fn agent_browser(app: &AppHandle) -> Option<Command> {
    let mut cmd = Command::new(sidecar("agent-browser")?);
    if let Some(dir) = resource(app, "agent-browser-skills") {
        cmd.env("AGENT_BROWSER_SKILLS_DIR", dir);
    }
    if let Some(chrome) = chrome_path(app) {
        cmd.env("AGENT_BROWSER_EXECUTABLE_PATH", chrome);
    }
    Some(cmd)
}

/// A Command for agent-desktop with its macOS helper wired up.
pub fn agent_desktop() -> Option<Command> {
    let mut cmd = Command::new(sidecar("agent-desktop")?);
    if let Some(helper) = sidecar("agent-desktop-macos-helper") {
        cmd.env("AGENT_DESKTOP_MACOS_HELPER_PATH", helper);
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
    let desktop_version = first_line(agent_desktop(), &["version"]).map(|line| {
        // `agent-desktop version` prints a JSON envelope; keep just the number.
        serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .and_then(|v| v.pointer("/data/version").and_then(|s| s.as_str()).map(str::to_string))
            .unwrap_or(line)
    });
    ToolStatus {
        browser_version: first_line(sidecar("agent-browser").map(Command::new), &["--version"])
            .map(|s| s.trim_start_matches("agent-browser").trim().to_string()),
        chrome_ready: chrome_path(&app).is_some(),
        desktop_version,
        accessibility: accessibility_granted(),
        screen_recording: screen_recording_granted(),
    }
}

// ───────────── what each worker gets ─────────────

/// Environment every worker gets so the tools "just work" inside its session:
/// the bundled binaries on PATH, the shared browser (its own tab in it, see
/// `browser.rs`), keychain sign-in, and its own folder for screenshots and recordings.
/// Async: the first job may have to start the shared browser.
#[tauri::command]
pub async fn worker_env(app: AppHandle, worker_id: String) -> Vec<(String, String)> {
    let shared = {
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || crate::browser::ensure(&app).ok()).await.ok().flatten()
    };
    let mut env = Vec::new();
    if let Some(dir) = sidecar_dir() {
        // engine.rs appends the user's own PATH after this.
        env.push(("PATH".into(), dir.display().to_string()));
    }
    if let Some(dir) = resource(&app, "agent-browser-skills") {
        env.push(("AGENT_BROWSER_SKILLS_DIR".into(), dir.display().to_string()));
    }
    if let Some(chrome) = chrome_path(&app) {
        env.push(("AGENT_BROWSER_EXECUTABLE_PATH".into(), chrome.display().to_string()));
    }
    if let Some(helper) = sidecar("agent-desktop-macos-helper") {
        env.push(("AGENT_DESKTOP_MACOS_HELPER_PATH".into(), helper.display().to_string()));
    }
    let session = crate::browser::session_for(&worker_id, shared);
    match shared {
        Some(port) => env.extend(crate::browser::attach_env(port, &session)),
        // the shared browser would not start: the job gets a browser of its own
        None => env.push(("AGENT_BROWSER_SESSION".into(), session)),
    }
    if let Some(plugins) = crate::browser::plugins_env() {
        env.push(("AGENT_BROWSER_PLUGINS".into(), plugins));
    }
    env.push(("APP_WORKER_ID".into(), worker_id.clone()));
    env.extend(crate::bridge::env());
    env.push(("ONDRA_HOOKS_FILE".into(), hooks_file(&app).display().to_string()));
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
pub async fn browser_stream_port(app: AppHandle, worker_id: String) -> Option<u16> {
    let shared = crate::browser::port(&app);
    let mut cmd = agent_browser(&app)?;
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
#[tauri::command]
pub fn worker_extensions(app: AppHandle) -> Vec<String> {
    let bundled = app.path().resource_dir().ok().map(|d| d.join("app-extensions"));
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../extensions");
    let Some(root) = [bundled, Some(dev)].into_iter().flatten().find(|d| d.is_dir()) else { return vec![] };
    let Ok(entries) = std::fs::read_dir(&root) else { return vec![] };
    let mut out: Vec<String> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "ts"))
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

#[tauri::command]
pub fn global_skills() -> Vec<GlobalSkill> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else { return vec![] };
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
#[tauri::command]
pub async fn notify(app: AppHandle, title: String, body: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "macos")]
        {
            static AS_ONDRA: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
            let id = app.config().identifier.clone();
            let ok = *AS_ONDRA.get_or_init(|| {
                #[cfg(debug_assertions)]
                dev_bundle(&app, &id);
                mac_notification_sys::set_application(&id).is_ok()
            });
            if ok && mac_notification_sys::Notification::new().title(&title).message(&body).send().is_ok() {
                return;
            }
        }
        let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!("display notification \"{}\" with title \"{}\"", esc(&body), esc(&title));
        let _ = std::process::Command::new("/usr/bin/osascript").args(["-e", &script]).output();
    })
    .await;
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
const HOME_CLIS: &[&str] = &["vercel", "supabase", "netlify", "railway", "fly", "flyctl", "firebase", "eas", "heroku", "doctl", "wrangler", "stripe"];

fn space_base(app: &AppHandle, space: &str) -> PathBuf {
    let safe: String = space.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    crate::engine::data_dir(app).join("spaces").join(if safe.is_empty() { "home".into() } else { safe })
}

fn expand_home(p: &str) -> PathBuf {
    match p.strip_prefix("~/") {
        Some(rest) => std::env::var("HOME").map(|h| PathBuf::from(h).join(rest)).unwrap_or_else(|_| PathBuf::from(p)),
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
    link_keychain(base);
}

/** CLIs run with a space home as $HOME still find the Mac's login keychain */
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
    let Some(base) = cli_home(&app, &space, home.clone()) else { return Vec::new() };
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
    ];
    if base.join(".gitconfig").exists() {
        env.push(("GIT_CONFIG_GLOBAL".into(), b(".gitconfig")));
    }
    if base.join(".ssh/config").exists() {
        env.push(("GIT_SSH_COMMAND".into(), format!("ssh -F '{}'", b(".ssh/config"))));
    }
    link_keychain(&base);
    let shims = space_base(&app, &space).join("bin");
    write_shims(&shims, &base);
    let mut path = vec![shims.display().to_string()];
    // a wrapper setup the user already has (…/home next to …/bin): its commands first
    if let Some(bin) = base.parent().map(|p| p.join("bin")).filter(|p| !own && p.is_dir()) {
        path.insert(0, bin.display().to_string());
    }
    env.push(("PATH".into(), path.join(":")));
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
    let mut cmd = Command::new("git");
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
    let gh_dir = base.as_ref().map(|b| b.join(".config/gh")).unwrap_or_else(|| expand_home("~/.config/gh"));
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
    let dir = space_base(&app, &space);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let script = dir.join("github-login.command");
    let export = gh.map(|g| format!("export GH_CONFIG_DIR='{}'\n", g.display().to_string().replace('\'', "'\\''"))).unwrap_or_default();
    std::fs::write(&script, format!("#!/bin/zsh -l\n{export}gh auth login --hostname github.com --git-protocol https --web\necho\necho \"이 창은 닫아도 돼요.\"\n"))
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755));
    }
    Command::new("/usr/bin/open").arg(&script).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/** Sets the name and email this space commits with (empty: the one in ~/.gitconfig). */
#[tauri::command]
pub fn space_git_identity(app: AppHandle, space: String, home: Option<String>, name: String, email: String) -> Result<(), String> {
    let base = cli_home(&app, &space, home.clone());
    if let Some(b) = &base {
        if home.as_deref().map_or(true, |h| h.trim().is_empty()) {
            prepare_home(b);
        }
    }
    for (key, v) in [("user.name", name.trim()), ("user.email", email.trim())] {
        let mut cmd = Command::new("git");
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
