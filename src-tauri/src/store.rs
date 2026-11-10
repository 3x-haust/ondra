//! Small file-backed helpers: the app state file, per-worker artifact folders,
//! per-account engine login folders (one `PI_CODING_AGENT_DIR` per account so
//! several subscriptions sit side by side), folder picking and opening things,
//! and the inbox folder other tools can drop tasks into.

use crate::engine::{data_dir, home, user_path};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Emitter, Manager};

fn state_file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("state.json")
}

/// The memory pieces as an Obsidian-friendly folder: one markdown file per piece
/// plus an index. Rewritten as a whole (the app state is the source of truth);
/// only `.md` files we wrote are removed, anything else in the folder stays.
/// Without `space`: the app's own folder (모든 일, git versions). With `space`
/// (an existing space folder): `<space>/.ondra/memory`, that space's pieces.
#[tauri::command]
pub fn memory_mirror(app: AppHandle, files: Vec<MirrorFile>, space: Option<String>) -> Result<String, String> {
    let root = match space {
        Some(dir) => {
            let dir = PathBuf::from(dir);
            if !dir.is_absolute() || !dir.is_dir() || dir == home() {
                return Err("not a space folder".into());
            }
            dir.join(".ondra").join("memory")
        }
        None => data_dir(&app).join("memory"),
    };
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut keep = std::collections::HashSet::new();
    for f in &files {
        let rel = Path::new(&f.path);
        let settings = f.path.starts_with(".obsidian/") && rel.extension().is_some_and(|x| x == "json");
        if rel.is_absolute() || rel.components().any(|c| matches!(c, std::path::Component::ParentDir)) || (!settings && rel.extension().is_none_or(|x| x != "md")) {
            continue;
        }
        let path = root.join(rel);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        // Obsidian settings are a starting point only: once there, they're the user's
        if f.once && path.exists() {
            continue;
        }
        if std::fs::read_to_string(&path).ok().as_deref() != Some(f.text.as_str()) {
            std::fs::write(&path, &f.text).map_err(|e| e.to_string())?;
        }
        keep.insert(path);
    }
    fn sweep(dir: &Path, keep: &std::collections::HashSet<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')) {
                continue;
            }
            if p.is_dir() {
                sweep(&p, keep);
                let _ = std::fs::remove_dir(&p);
            } else if p.extension().is_some_and(|x| x == "md") && !keep.contains(&p) {
                let _ = std::fs::remove_file(&p);
            }
        }
    }
    sweep(&root, &keep);
    Ok(root.display().to_string())
}

/// One saved version of the memory folder (git log line).
#[derive(serde::Serialize)]
pub struct MemoryVersion {
    sha: String,
    at: i64,
    msg: String,
}

fn memory_git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        // the memory folder is the app's own repo: never the user's signing or hooks
        .args(["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Ondra", "-c", "user.email=memory@ondra.local"])
        .args(args)
        .stdin(Stdio::null())
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

/// Save this version of the memory: the pieces as JSON (what a restore reads back)
/// next to the markdown files, committed to the folder's own git repo.
/// Returns the new commit, or None when nothing changed.
#[tauri::command]
pub fn memory_git_commit(app: AppHandle, msg: String, snapshot: String) -> Result<Option<String>, String> {
    let root = data_dir(&app).join("memory");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    if !root.join(".git").exists() {
        memory_git(&root, &["init", "-q"])?;
    }
    std::fs::write(root.join(".ondra-memory.json"), snapshot).map_err(|e| e.to_string())?;
    memory_git(&root, &["add", "-A"])?;
    if memory_git(&root, &["diff", "--cached", "--quiet"]).is_ok() {
        return Ok(None);
    }
    memory_git(&root, &["commit", "-q", "-m", &msg])?;
    Ok(Some(memory_git(&root, &["rev-parse", "--short", "HEAD"])?.trim().to_string()))
}

/// The saved versions, newest first.
#[tauri::command]
pub fn memory_git_log(app: AppHandle, limit: Option<u32>) -> Vec<MemoryVersion> {
    let root = data_dir(&app).join("memory");
    if !root.join(".git").exists() {
        return vec![];
    }
    let n = format!("-{}", limit.unwrap_or(60));
    memory_git(&root, &["log", &n, "--format=%h%x09%ct%x09%s"])
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let mut p = l.splitn(3, '\t');
            Some(MemoryVersion { sha: p.next()?.to_string(), at: p.next()?.parse::<i64>().ok()? * 1000, msg: p.next().unwrap_or("").to_string() })
        })
        .collect()
}

/// The pieces as they were in one saved version.
#[tauri::command]
pub fn memory_git_show(app: AppHandle, sha: String) -> Result<String, String> {
    if !sha.chars().all(|c| c.is_ascii_hexdigit()) || sha.len() < 4 {
        return Err("bad version".into());
    }
    let root = data_dir(&app).join("memory");
    memory_git(&root, &["show", &format!("{sha}:.ondra-memory.json")])
}

/// Which of these files still exist (a code fact whose files are gone is stale).
#[tauri::command]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|p| match p.strip_prefix("~/") {
            Some(rest) => home().join(rest).exists(),
            None => Path::new(p).exists(),
        })
        .collect()
}

#[tauri::command]
pub fn memory_folder(app: AppHandle) -> String {
    let root = data_dir(&app).join("memory");
    let _ = std::fs::create_dir_all(&root);
    root.display().to_string()
}

/// A note file another agent tool keeps in a folder (to bring into Ondra's memory).
#[derive(serde::Serialize)]
pub struct NoteFile {
    path: String,
    text: String,
}

/// Memory and rule files other tools keep inside a folder: Work-style `context/`,
/// Cline `memory-bank/`, Cursor / Windsurf / Cline rules, Copilot and Gemini
/// instructions. AGENTS.md / CLAUDE.md are left out: the engine reads them itself.
#[tauri::command]
pub async fn memory_sources(folder: String) -> Vec<NoteFile> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = std::path::PathBuf::from(&folder);
        let mut out = Vec::new();
        let mut push = |p: std::path::PathBuf| {
            if out.len() >= 60 || !p.is_file() {
                return;
            }
            let Ok(meta) = std::fs::metadata(&p) else { return };
            if meta.len() > 600_000 {
                return;
            }
            if let Ok(text) = std::fs::read_to_string(&p) {
                if !text.trim().is_empty() {
                    out.push(NoteFile { path: p.display().to_string(), text });
                }
            }
        };
        let dir_files = |d: std::path::PathBuf, exts: &[&str]| -> Vec<std::path::PathBuf> {
            let mut v: Vec<_> = std::fs::read_dir(&d)
                .map(|it| it.filter_map(|e| e.ok().map(|e| e.path())).collect())
                .unwrap_or_default();
            v.retain(|p| p.extension().and_then(|x| x.to_str()).is_some_and(|x| exts.contains(&x)));
            v.sort();
            v
        };
        for d in ["context", "context/projects", "memory-bank", ".cursor/rules", ".windsurf/rules", ".clinerules"] {
            for p in dir_files(root.join(d), &["md", "mdc"]) {
                push(p);
            }
        }
        for f in [".cursorrules", ".windsurfrules", ".clinerules", ".github/copilot-instructions.md", "GEMINI.md"] {
            push(root.join(f));
        }
        // Claude Code's memory for this folder (<config>/projects/<folder as a slug>/memory);
        // MEMORY.md is only its index
        let slug: String = folder.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
        for cfg in claude_dirs() {
            for p in dir_files(cfg.join("projects").join(&slug).join("memory"), &["md"]) {
                if p.file_name().is_some_and(|n| n != "MEMORY.md") {
                    push(p);
                }
            }
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// Claude Code config folders: ~/.claude, $CLAUDE_CONFIG_DIR, and the ones
/// wrappers keep under ~/.local/share/<tool>/home/.claude*.
fn claude_dirs() -> Vec<std::path::PathBuf> {
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else { return vec![] };
    let mut dirs = vec![home.join(".claude")];
    if let Some(d) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        dirs.push(d.into());
    }
    let share = home.join(".local/share");
    for tool in std::fs::read_dir(&share).into_iter().flatten().flatten() {
        for d in std::fs::read_dir(tool.path().join("home")).into_iter().flatten().flatten() {
            if d.file_name().to_string_lossy().starts_with(".claude") && d.path().is_dir() {
                dirs.push(d.path());
            }
        }
    }
    dirs.sort();
    dirs.dedup();
    dirs.retain(|d| d.join("projects").is_dir());
    dirs
}

#[derive(serde::Deserialize)]
pub struct MirrorFile {
    path: String,
    text: String,
    #[serde(default)]
    once: bool,
}

/// The main chat lives as text in the state file; its engine sessions are
/// disposable. Keep only the newest session file in one of our session folders.
#[tauri::command]
pub fn sessions_prune(app: AppHandle, dir: String) -> Result<(), String> {
    let root = data_dir(&app).join("sessions");
    let dir = PathBuf::from(&dir);
    let canon = dir.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("not a session folder".into());
    }
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&canon)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "jsonl"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .collect();
    files.sort();
    files.pop();
    for (_, p) in files {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

#[tauri::command]
pub fn state_load(app: AppHandle) -> Option<String> {
    std::fs::read_to_string(state_file(&app)).ok()
}

/// Written via a temp file so a crash mid-write never leaves half a state file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| e.to_string())
}

/// Each task's JSON as last sent by the app (see src/state/persist.ts): a save sends only
/// the tasks that changed, and the file is put together here.
static TASK_PARTS: std::sync::Mutex<Option<std::collections::HashMap<String, String>>> = std::sync::Mutex::new(None);

#[tauri::command(async)]
pub fn state_save(app: AppHandle, json: String) -> Result<(), String> {
    let mut parts = TASK_PARTS.lock().unwrap_or_else(|e| e.into_inner());
    // a whole file replaces what was held: the next partial save sends every task again
    *parts = None;
    write_atomic(&state_file(&app), json.as_bytes())
}

/// The whole state file from the state without its tasks (`head`, a JSON object), the tasks'
/// order (`order`, their slots) and their JSON. Returns the slots it doesn't hold (then it
/// writes nothing and the app sends those).
pub fn join_parts(held: &std::collections::HashMap<String, String>, head: &str, order: &[String]) -> Result<Vec<u8>, Vec<String>> {
    let missing: Vec<String> = order.iter().filter(|k| !held.contains_key(*k)).cloned().collect();
    if !missing.is_empty() {
        return Err(missing);
    }
    let head = head.trim();
    let size = head.len() + order.iter().map(|k| held[k].len() + 1).sum::<usize>() + 16;
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(b"{\"tasks\":[");
    for (i, k) in order.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.extend_from_slice(held[k].as_bytes());
    }
    out.push(b']');
    let rest = head.strip_prefix('{').map(str::trim_start).unwrap_or("}");
    if !rest.starts_with('}') {
        out.push(b',');
    }
    out.extend_from_slice(rest.as_bytes());
    Ok(out)
}

#[tauri::command(async)]
pub fn state_save_parts(app: AppHandle, head: String, order: Vec<String>, tasks: std::collections::HashMap<String, String>) -> Result<Vec<String>, String> {
    if !head.trim_start().starts_with('{') {
        return Err("state head is not an object".into());
    }
    let mut guard = TASK_PARTS.lock().unwrap_or_else(|e| e.into_inner());
    let held = guard.get_or_insert_with(Default::default);
    held.extend(tasks);
    let bytes = match join_parts(held, &head, &order) {
        Ok(b) => b,
        Err(missing) => return Ok(missing),
    };
    let keep: std::collections::HashSet<&String> = order.iter().collect();
    held.retain(|k, _| keep.contains(k));
    write_atomic(&state_file(&app), &bytes)?;
    Ok(vec![])
}

static QUIT_SAVED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static QUIT_WAITING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The app is about to quit: ask the page for its last save first (it saves a moment after
/// a change, so the newest one may not be on disk yet), then quit once it says it's written,
/// or after a second and a half at most. True: the quit is held until then.
pub fn hold_quit_for_save(app: &AppHandle, code: i32) -> bool {
    use std::sync::atomic::Ordering;
    if QUIT_SAVED.load(Ordering::SeqCst) {
        return false;
    }
    if QUIT_WAITING.swap(true, Ordering::SeqCst) {
        return true;
    }
    let Some(page) = app.get_webview("main") else { return false };
    if page.emit("state:flush", ()).is_err() {
        return false;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let start = std::time::Instant::now();
        while !QUIT_SAVED.load(Ordering::SeqCst) && start.elapsed() < std::time::Duration::from_millis(1500) {
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        QUIT_SAVED.store(true, Ordering::SeqCst);
        app.exit(code);
    });
    true
}

/// The page's last save before quitting is written.
#[tauri::command]
pub fn state_flushed() {
    QUIT_SAVED.store(true, std::sync::atomic::Ordering::SeqCst);
}

fn safe_id(worker_id: &str) -> String {
    worker_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect()
}

#[tauri::command]
pub fn artifacts_dir(app: AppHandle, worker_id: String) -> String {
    let dir = data_dir(&app).join("artifacts").join(safe_id(&worker_id));
    let _ = std::fs::create_dir_all(&dir);
    dir.display().to_string()
}

/// A job's folder for builds, caches and scratch work, kept out of its artifacts folder.
/// It is in the system temp folder, which macOS clears on its own; Ondra never deletes it.
pub fn scratch_dir(worker_id: &str) -> PathBuf {
    let dir = std::env::temp_dir().join("ondra-scratch").join(safe_id(worker_id));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

// ───────────── accounts ─────────────

/// Where an account keeps its engine login. `None` = the user's normal ~/.pi/agent.
pub fn account_dir(app: &AppHandle, account_id: &str) -> Option<PathBuf> {
    if account_id == "default" || account_id.is_empty() {
        return None;
    }
    let safe: String = account_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    Some(data_dir(app).join("accounts").join(safe))
}

fn default_agent_dir() -> PathBuf {
    home().join(".pi/agent")
}

#[tauri::command]
pub fn account_dir_path(app: AppHandle, account_id: String) -> Option<String> {
    account_dir(&app, &account_id).map(|d| {
        let _ = std::fs::create_dir_all(&d);
        d.display().to_string()
    })
}

/// Which providers this account is logged into (names only; secrets stay in the file).
#[tauri::command]
pub fn account_providers(app: AppHandle, account_id: String) -> Vec<String> {
    let own = account_dir(&app, &account_id);
    let dir = own.clone().unwrap_or_else(default_agent_dir);
    let mut keys: Vec<String> = std::fs::read_to_string(dir.join("auth.json"))
        .ok()
        .and_then(|text| match serde_json::from_str(&text) {
            Ok(serde_json::Value::Object(map)) => Some(map.keys().cloned().collect()),
            _ => None,
        })
        .unwrap_or_default();
    // an Ondra-made account also counts the direct connections in its models.json (names only)
    if own.is_some() {
        if let Ok(text) = std::fs::read_to_string(dir.join("models.json")) {
            keys.extend(crate::providers::provider_ids(&text));
        }
    }
    keys.sort();
    keys.dedup();
    keys
}

/// Deletes an Ondra-made account folder. The user's own ~/.pi/agent is never touched.
#[tauri::command]
pub fn account_remove(app: AppHandle, account_id: String) {
    if let Some(dir) = account_dir(&app, &account_id) {
        if dir.starts_with(data_dir(&app)) {
            // its direct connections' keys go with it
            crate::providers::forget_secrets(&dir);
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

// ───────────── opening things ─────────────

/// Native folder picker via AppleScript, so no extra plugin is needed.
#[tauri::command]
pub async fn pick_folder(prompt: String) -> Option<String> {
    let out = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(format!("POSIX path of (choose folder with prompt \"{}\")", prompt.replace(['"', '\\'], "")))
        .output()
        .ok()?;
    let path = String::from_utf8_lossy(&out.stdout).trim().trim_end_matches('/').to_string();
    (out.status.success() && !path.is_empty()).then_some(path)
}

/// Files to attach to a message (several allowed). Empty if cancelled.
#[tauri::command]
pub async fn pick_files(prompt: String) -> Vec<String> {
    let script = format!(
        "set fs to choose file with prompt \"{}\" with multiple selections allowed\nset out to \"\"\nrepeat with f in fs\nset out to out & POSIX path of f & linefeed\nend repeat\nout",
        prompt.replace(['"', '\\'], "")
    );
    let Ok(out) = Command::new("/usr/bin/osascript").arg("-e").arg(script).output() else { return vec![] };
    if !out.status.success() {
        return vec![];
    }
    String::from_utf8_lossy(&out.stdout).lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}

#[tauri::command]
pub fn reveal_path(path: String) {
    let _ = Command::new("/usr/bin/open").arg("-R").arg(path).spawn();
}

/// The system's default browser for a web page; Mail or the phone for mailto: and tel:.
/// No other scheme is handed out (an agent's link must not launch an app).
#[tauri::command]
pub fn open_url(url: String) {
    if ["https://", "http://", "mailto:", "tel:"].iter().any(|p| url.starts_with(p)) {
        let _ = Command::new("/usr/bin/open").arg(url).spawn();
    }
}

fn which(name: &str) -> Option<PathBuf> {
    user_path().split(':').map(|d| Path::new(d).join(name)).find(|p| p.is_file())
}

/// Opens a file or folder in the user's editor (Cursor, VS Code, Zed), else the default app.
#[tauri::command]
pub fn open_in_editor(path: String) -> Result<(), String> {
    for editor in ["cursor", "code", "zed"] {
        if let Some(bin) = which(editor) {
            return Command::new(bin)
                .arg(&path)
                .env("PATH", user_path())
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string());
        }
    }
    Command::new("/usr/bin/open").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// A script that opens a shell in `path` with the space's environment (its git
/// identity, GitHub login, ssh keys, CLI shims first on PATH).
fn shell_script(path: &str, env: &[(String, String)]) -> String {
    let q = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let mut lines = vec!["#!/bin/zsh".to_string(), format!("cd {} || exit 1", q(path))];
    let mut shims = String::new();
    for (k, v) in env {
        if k == "PATH" {
            shims = v.clone();
        } else if k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            lines.push(format!("export {k}={}", q(v)));
        }
    }
    // a login shell rebuilds PATH, so the space's commands go back in front after it
    lines.push(format!(
        "exec \"${{SHELL:-/bin/zsh}}\" -l -c {}",
        q(&format!("export PATH={}:\"$PATH\"; exec \"${{SHELL:-/bin/zsh}}\" -i", q(&shims)))
    ));
    lines.join("\n") + "\n"
}

fn space_shell_script(app: &AppHandle, path: &str, env: &[(String, String)]) -> Result<String, String> {
    let dir = data_dir(app).join("terminal");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("open-{}.command", std::process::id()));
    std::fs::write(&file, shell_script(path, env)).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    Ok(file.display().to_string())
}

/// Opens a terminal window in a folder: Ghostty, iTerm, Warp, else Terminal. With
/// `env` (the space's `space_env`) the shell runs as that space.
#[tauri::command]
pub fn open_in_terminal(app: AppHandle, path: String, env: Option<Vec<(String, String)>>) -> Result<(), String> {
    let has = |app: &str| Path::new(&format!("/Applications/{app}.app")).exists();
    let mut cmd = Command::new("/usr/bin/open");
    if let Some(env) = env.filter(|e| !e.is_empty()) {
        let script = space_shell_script(&app, &path, &env)?;
        if has("Ghostty") {
            cmd.args(["-na", "Ghostty", "--args", "-e", &script]);
        } else if has("iTerm") {
            cmd.args(["-a", "iTerm", &script]);
        } else {
            // Warp doesn't run scripts it's handed: Terminal does
            cmd.args(["-a", "Terminal", &script]);
        }
        return cmd.spawn().map(|_| ()).map_err(|e| e.to_string());
    }
    if has("Ghostty") {
        cmd.args(["-na", "Ghostty", "--args", &format!("--working-directory={path}")]);
    } else if has("iTerm") {
        cmd.args(["-a", "iTerm", &path]);
    } else if has("Warp") {
        cmd.args(["-a", "Warp", &path]);
    } else {
        cmd.args(["-a", "Terminal", &path]);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

// ───────────── inbox: throw from anywhere ─────────────

/// Any `*.txt` dropped into `<data>/inbox/` becomes a task (an optional first
/// line `space: work|home` picks the space). `scripts/throw.sh` wraps this so a
/// terminal, a hook or a Shortcut can throw too.
pub fn watch_inbox(app: AppHandle) {
    let dir = data_dir(&app).join("inbox");
    let _ = std::fs::create_dir_all(&dir);
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(800));
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<_> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "txt"))
            .collect();
        files.sort();
        for path in files {
            let Ok(text) = std::fs::read_to_string(&path) else { continue };
            let _ = std::fs::remove_file(&path);
            let (space, body) = match text.split_once('\n') {
                Some((first, rest)) if first.trim_start().starts_with("space:") => {
                    (first.trim_start().trim_start_matches("space:").trim().to_string(), rest.to_string())
                }
                _ => (String::new(), text),
            };
            let body = body.trim();
            if !body.is_empty() {
                let _ = app.emit_to("main", "capture:submitted", serde_json::json!({ "text": body, "space": space }));
            }
        }
    });
}

// ───────────── plan limits ─────────────

/// How much of each plan window is used. Asked straight from the provider with
/// the account's own login; tokens go to curl on stdin, never on the command line.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    provider: String,
    /// window length in minutes (300 = 5 hours, 10080 = a week)
    window: u64,
    used: f64,
    /// unix ms
    resets_at: Option<u64>,
    /// paid credits on top of the plan ("12.5", "무제한", "$61.95 / $200"); only on the window-0 entry
    #[serde(skip_serializing_if = "Option::is_none")]
    credits: Option<String>,
}

fn curl_json(url: &str, headers: &[(String, String)]) -> Option<serde_json::Value> {
    use std::io::Write;
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--max-time", "12", "-H", "@-", url])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    {
        let mut stdin = child.stdin.take()?;
        for (k, v) in headers {
            let _ = writeln!(stdin, "{k}: {v}");
        }
    }
    let out = child.wait_with_output().ok()?;
    serde_json::from_slice(&out.stdout).ok()
}

#[tauri::command]
pub async fn account_limits(app: AppHandle, account_id: String) -> Vec<Limit> {
    let dir = account_dir(&app, &account_id).unwrap_or_else(default_agent_dir);
    let Ok(text) = std::fs::read_to_string(dir.join("auth.json")) else { return vec![] };
    let Ok(auth) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![] };
    let mut out = Vec::new();
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);

    if let Some(c) = auth.get("openai-codex") {
        if let (Some(tok), Some(acc)) = (c["access"].as_str(), c["accountId"].as_str()) {
            let h = vec![
                ("Authorization".into(), format!("Bearer {tok}")),
                ("chatgpt-account-id".into(), acc.to_string()),
                ("User-Agent".into(), "ondra".into()),
            ];
            if let Some(j) = curl_json("https://chatgpt.com/backend-api/wham/usage", &h) {
                for key in ["primary_window", "secondary_window"] {
                    let w = &j["rate_limit"][key];
                    if let Some(used) = w["used_percent"].as_f64() {
                        out.push(Limit {
                            provider: "openai-codex".into(),
                            window: w["limit_window_seconds"].as_u64().unwrap_or(0) / 60,
                            used,
                            resets_at: w["reset_after_seconds"].as_u64().map(|s| now + s * 1000),
                            credits: None,
                        });
                    }
                }
                // credits bought on top of the plan keep it going past 100%
                let c = &j["credits"];
                let credits = if c["unlimited"].as_bool() == Some(true) {
                    Some("무제한".to_string())
                } else if c["has_credits"].as_bool() == Some(true) {
                    Some(c["balance"].as_str().map(|b| b.to_string()).unwrap_or_else(|| "있음".into()))
                } else {
                    None
                };
                if credits.is_some() {
                    out.push(Limit { provider: "openai-codex".into(), window: 0, used: 0.0, resets_at: None, credits });
                }
            }
        }
    }
    if let Some(a) = auth.get("anthropic") {
        if let Some(tok) = a["access"].as_str() {
            let h = vec![
                ("Authorization".into(), format!("Bearer {tok}")),
                ("anthropic-beta".into(), "oauth-2025-04-20".into()),
                ("User-Agent".into(), "ondra".into()),
            ];
            if let Some(j) = curl_json("https://api.anthropic.com/api/oauth/usage", &h) {
                for (key, mins) in [("five_hour", 300u64), ("seven_day", 10080u64)] {
                    let w = &j[key];
                    if let Some(used) = w["utilization"].as_f64() {
                        let resets_at = w["resets_at"].as_str().and_then(|s| chrono_ms(s));
                        out.push(Limit { provider: "anthropic".into(), window: mins, used, resets_at, credits: None });
                    }
                }
                // extra usage: paid use past the plan, in cents
                let x = &j["extra_usage"];
                if x["is_enabled"].as_bool() == Some(true) {
                    let dollars = |v: &serde_json::Value| v.as_f64().map(|c| format!("${:.2}", c / 100.0));
                    let label = match (dollars(&x["used_credits"]), dollars(&x["monthly_limit"])) {
                        (Some(u), Some(l)) => format!("{u} / {l}"),
                        (Some(u), None) => u,
                        _ => "켜짐".into(),
                    };
                    out.push(Limit { provider: "anthropic".into(), window: 0, used: x["utilization"].as_f64().unwrap_or(0.0), resets_at: None, credits: Some(label) });
                }
            }
        }
    }
    out
}

/// "2026-11-04T12:00:00.000Z" → unix ms, without pulling in a date crate.
fn chrono_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    // days from civil (Howard Hinnant)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60 + se) * 1000) as u64)
}

/// The payload of a JWT (no signature check: we only read our own login's claims).
fn jwt_claims(token: &str) -> Option<serde_json::Value> {
    let part = token.split('.').nth(1)?;
    let mut bits: u32 = 0;
    let mut n = 0;
    let mut out = Vec::with_capacity(part.len() * 3 / 4);
    for c in part.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => continue,
        } as u32;
        bits = (bits << 6) | v;
        n += 6;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
            bits &= (1 << n) - 1;
        }
    }
    serde_json::from_slice(&out).ok()
}

/// Who an account is logged in as (email), for the status line.
#[tauri::command]
pub async fn account_email(app: AppHandle, account_id: String) -> Option<String> {
    let dir = account_dir(&app, &account_id).unwrap_or_else(default_agent_dir);
    let text = std::fs::read_to_string(dir.join("auth.json")).ok()?;
    let auth = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    if let Some(tok) = auth["openai-codex"]["access"].as_str() {
        if let Some(c) = jwt_claims(tok) {
            let e = c["https://api.openai.com/profile"]["email"].as_str().or(c["email"].as_str());
            if let Some(e) = e {
                return Some(e.to_string());
            }
        }
    }
    if let Some(tok) = auth["anthropic"]["access"].as_str() {
        let h = vec![
            ("Authorization".into(), format!("Bearer {tok}")),
            ("anthropic-beta".into(), "oauth-2025-04-20".into()),
            ("User-Agent".into(), "ondra".into()),
        ];
        if let Some(j) = curl_json("https://api.anthropic.com/api/oauth/profile", &h) {
            if let Some(e) = j["account"]["email"].as_str() {
                return Some(e.to_string());
            }
        }
    }
    None
}

#[derive(serde::Serialize)]
pub struct ArtifactFile {
    path: String,
    name: String,
    size: u64,
    modified: u64,
}

/// What a worker left in its artifacts folder (pages, pictures, recordings), newest first.
#[tauri::command]
pub fn artifacts_list(app: AppHandle, worker_id: String) -> Vec<ArtifactFile> {
    let dir = artifacts_dir(app, worker_id);
    let mut out: Vec<ArtifactFile> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let m = e.metadata().ok()?;
                    if !m.is_file() {
                        return None;
                    }
                    let name = e.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') {
                        return None;
                    }
                    let modified = m.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as u64;
                    Some(ArtifactFile { path: e.path().to_string_lossy().into_owned(), name, size: m.len(), modified })
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

#[derive(serde::Serialize)]
pub struct TraceChunk {
    text: String,
    end: u64,
}

/// The reverse-engineering trace `ondra-binary` keeps in a job's artifacts folder,
/// from byte `from` on (whole lines only), so the 리버싱 view reads only what is new.
#[tauri::command]
pub async fn reverse_trace(app: AppHandle, worker_id: String, from: u64) -> TraceChunk {
    let path = std::path::PathBuf::from(artifacts_dir(app, worker_id)).join(".reverse/trace.jsonl");
    tauri::async_runtime::spawn_blocking(move || read_lines_from(&path, from)).await.unwrap_or(TraceChunk { text: String::new(), end: from })
}

const TRACE_CHUNK: u64 = 32 * 1024 * 1024;

fn read_lines_from(path: &std::path::Path, from: u64) -> TraceChunk {
    use std::io::{Read, Seek, SeekFrom};
    let empty = |end| TraceChunk { text: String::new(), end };
    let Ok(mut f) = std::fs::File::open(path) else { return empty(0) };
    let len = f.metadata().map_or(0, |m| m.len());
    // a shorter file is a new trace: read it from the start
    let from = if from > len { 0 } else { from };
    if f.seek(SeekFrom::Start(from)).is_err() {
        return empty(from);
    }
    let mut buf = Vec::new();
    if f.take(TRACE_CHUNK).read_to_end(&mut buf).is_err() {
        return empty(from);
    }
    // a line still being written waits for the next read
    let whole = buf.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    buf.truncate(whole);
    TraceChunk { text: String::from_utf8_lossy(&buf).into_owned(), end: from + whole as u64 }
}

#[cfg(test)]
mod scratch_tests {
    use super::scratch_dir;

    #[test]
    fn scratch_is_a_per_job_folder_in_the_system_temp_folder() {
        let id = format!("job-{}", std::process::id());
        let dir = scratch_dir(&id);
        assert!(dir.is_dir());
        assert_eq!(dir, std::env::temp_dir().join("ondra-scratch").join(&id));
        // the id never reaches outside the scratch folder
        assert_eq!(scratch_dir("../../x").file_name().unwrap(), "x");
        let _ = std::fs::remove_dir(&dir);
    }
}

#[cfg(test)]
mod trace_tests {
    use super::{join_parts, read_lines_from};

    #[test]
    fn state_file_is_put_together_from_its_parts() {
        let held: std::collections::HashMap<String, String> =
            [("a".to_string(), r#"{"id":"a"}"#.to_string()), ("b".to_string(), r#"{"id":"b"}"#.to_string())].into_iter().collect();
        let order = vec!["b".to_string(), "a".to_string()];
        let out = String::from_utf8(join_parts(&held, r#"{"version":3,"space":"home"}"#, &order).unwrap()).unwrap();
        assert_eq!(out, r#"{"tasks":[{"id":"b"},{"id":"a"}],"version":3,"space":"home"}"#);
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["tasks"][1]["id"], "a");
        assert_eq!(String::from_utf8(join_parts(&held, "{}", &[]).unwrap()).unwrap(), r#"{"tasks":[]}"#);
        assert_eq!(join_parts(&held, "{}", &["c".to_string()]).unwrap_err(), vec!["c".to_string()]);
    }

    #[test]
    fn reads_whole_new_lines_only() {
        let path = std::env::temp_dir().join(format!("ondra-trace-{}.jsonl", std::process::id()));
        std::fs::write(&path, "{\"a\":1}\n{\"b\":2}\n{\"c\"").unwrap();
        let first = read_lines_from(&path, 0);
        assert_eq!(first.text, "{\"a\":1}\n{\"b\":2}\n");
        assert_eq!(first.end, 16);
        std::fs::write(&path, "{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n").unwrap();
        assert_eq!(read_lines_from(&path, first.end).text, "{\"c\":3}\n");
        // replaced by a shorter trace: start over
        std::fs::write(&path, "{\"d\":4}\n").unwrap();
        assert_eq!(read_lines_from(&path, 40).text, "{\"d\":4}\n");
        let _ = std::fs::remove_file(&path);
        assert_eq!(read_lines_from(&path, 0).end, 0);
    }
}

#[cfg(test)]
mod terminal_tests {
    use super::shell_script;

    #[test]
    fn space_shell_starts_in_the_folder_with_the_space_env() {
        let dir = std::env::temp_dir().join(format!("ondra-term-{}", std::process::id()));
        let odd = dir.join("it's here");
        std::fs::create_dir_all(&odd).unwrap();
        let env = vec![
            ("GH_CONFIG_DIR".to_string(), "/x/it's gh".to_string()),
            ("PATH".to_string(), "/x/shims".to_string()),
            ("BAD KEY".to_string(), "no".to_string()),
        ];
        let script = shell_script(&odd.display().to_string(), &env);
        assert!(!script.contains("BAD KEY"));
        // run it with a stand-in SHELL that prints what the user's shell would see
        let file = dir.join("t.command");
        std::fs::write(&file, &script).unwrap();
        let out = std::process::Command::new("/bin/zsh")
            .arg(&file)
            .env("SHELL", "/bin/sh")
            .env("ENV", "/dev/null")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut c| {
                use std::io::Write;
                c.stdin.take().unwrap().write_all(b"pwd; echo \"$GH_CONFIG_DIR\"; echo \"$PATH\" | cut -d: -f1\n")?;
                c.wait_with_output()
            })
            .unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[0].ends_with("it's here"), "{text}");
        assert_eq!(lines[1], "/x/it's gh");
        assert_eq!(lines[2], "/x/shims");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
