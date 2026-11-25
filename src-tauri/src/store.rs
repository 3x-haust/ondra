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

#[cfg(windows)]
mod windows;
#[cfg(target_os = "linux")]
pub(crate) mod linux;

fn state_file(app: &AppHandle) -> PathBuf {
    data_dir(app).join("state.json")
}

/// The memory pieces as an Obsidian-friendly folder: one markdown file per piece
/// plus an index. Rewritten as a whole (the app state is the source of truth);
/// only `.md` files we wrote are removed, anything else in the folder stays.
/// Without `space`: the app's own folder (모든 일, git versions). With `space`
/// (an existing space folder): `<space>/.ondra/memory`, that space's pieces.
/// The memory folder's writers and its git, one at a time: they run off the main thread (a few
/// thousand files read and compared, git add/commit) and must not interleave.
static MEMORY_FOLDER: std::sync::Mutex<()> = std::sync::Mutex::new(());
fn memory_folder_lock() -> std::sync::MutexGuard<'static, ()> {
    MEMORY_FOLDER.lock().unwrap_or_else(|e| e.into_inner())
}

#[tauri::command(async)]
pub fn memory_mirror(app: AppHandle, files: Vec<MirrorFile>, space: Option<String>) -> Result<String, String> {
    let _one = memory_folder_lock();
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
        if rel.components().any(|c| !matches!(c, std::path::Component::Normal(_))) || (!settings && rel.extension().is_none_or(|x| x != "md")) {
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
    let out = crate::engine::background_command("git")
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
#[tauri::command(async)]
pub fn memory_git_commit(app: AppHandle, msg: String, snapshot: String) -> Result<Option<String>, String> {
    let _one = memory_folder_lock();
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
#[tauri::command(async)]
pub fn memory_git_log(app: AppHandle, limit: Option<u32>) -> Vec<MemoryVersion> {
    let _one = memory_folder_lock();
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
#[tauri::command(async)]
pub fn memory_git_show(app: AppHandle, sha: String) -> Result<String, String> {
    let _one = memory_folder_lock();
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
    let Some(home) = crate::engine::user_home() else { return vec![] };
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
#[tauri::command(async)]
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

/// The app state, one file per part under `<data>/state/`: each task (`t.<slot>.json`), each of
/// the state's other fields (`f.<name>.json`) and the index of both (`index.json`). A save writes
/// only the parts that changed: the whole state (40+ MB after a few weeks of jobs) used to be
/// written again every couple of seconds while a job ran, 4 MB/s around the clock.
fn state_dir(app: &AppHandle) -> PathBuf {
    data_dir(app).join("state")
}

/// What the parts folder holds, as last written or read.
#[derive(Default)]
pub struct Held {
    fields: std::collections::HashMap<String, String>,
    tasks: std::collections::HashMap<String, String>,
    index: String,
}
static HELD: std::sync::Mutex<Option<Held>> = std::sync::Mutex::new(None);

/// What a save lacked (the app sends those next): the native side started fresh or dropped them.
#[derive(serde::Serialize, Default, Debug, PartialEq)]
pub struct Missing {
    fields: Vec<String>,
    tasks: Vec<String>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct Index {
    fields: Vec<String>,
    tasks: Vec<String>,
}

/// A part's file name. Only lower-case letters, digits, `-` and `_` are kept as they are (the
/// disk may not tell cases apart): anything else is `%XX`.
fn part_file(kind: &str, name: &str) -> String {
    let mut out = format!("{kind}.");
    for b in name.bytes() {
        if b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out.push_str(".json");
    out
}

/// Write the parts that changed; once nothing is missing, the index too, and the parts no longer
/// in it go. `names`: every field of the state besides its tasks; `order`: every task's slot.
pub fn save_parts(
    dir: &Path,
    held: &mut Held,
    names: &[String],
    fields: std::collections::HashMap<String, String>,
    order: &[String],
    tasks: std::collections::HashMap<String, String>,
) -> Result<Missing, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    for (k, v) in fields {
        if held.fields.get(&k) != Some(&v) {
            write_atomic(&dir.join(part_file("f", &k)), v.as_bytes())?;
            held.fields.insert(k, v);
        }
    }
    for (k, v) in tasks {
        if held.tasks.get(&k) != Some(&v) {
            write_atomic(&dir.join(part_file("t", &k)), v.as_bytes())?;
            held.tasks.insert(k, v);
        }
    }
    let missing = Missing {
        fields: names.iter().filter(|k| !held.fields.contains_key(*k)).cloned().collect(),
        tasks: order.iter().filter(|k| !held.tasks.contains_key(*k)).cloned().collect(),
    };
    if !missing.fields.is_empty() || !missing.tasks.is_empty() {
        return Ok(missing);
    }
    let index = serde_json::to_string(&Index { fields: names.to_vec(), tasks: order.to_vec() }).map_err(|e| e.to_string())?;
    if index != held.index {
        write_atomic(&dir.join("index.json"), index.as_bytes())?;
        held.index = index;
        let names: std::collections::HashSet<&String> = names.iter().collect();
        let order: std::collections::HashSet<&String> = order.iter().collect();
        held.fields.retain(|k, _| names.contains(k));
        held.tasks.retain(|k, _| order.contains(k));
        let keep: std::collections::HashSet<String> =
            held.fields.keys().map(|k| part_file("f", k)).chain(held.tasks.keys().map(|k| part_file("t", k))).collect();
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if (name.starts_with("f.") || name.starts_with("t.")) && name.ends_with(".json") && !keep.contains(&name) {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    Ok(missing)
}

/// The whole state as one JSON text, put together from its parts (None: no parts folder yet).
/// What was read is held, so the first save after a start writes only what changed since.
pub fn load_parts(dir: &Path, held: &mut Held) -> Option<String> {
    let index_text = std::fs::read_to_string(dir.join("index.json")).ok()?;
    let index: Index = serde_json::from_str(&index_text).ok()?;
    let mut out = String::from("{\"tasks\":[");
    let mut first = true;
    for slot in &index.tasks {
        let Ok(t) = std::fs::read_to_string(dir.join(part_file("t", slot))) else { continue };
        if !first {
            out.push(',');
        }
        first = false;
        out.push_str(&t);
        held.tasks.insert(slot.clone(), t);
    }
    out.push(']');
    for name in &index.fields {
        let Ok(f) = std::fs::read_to_string(dir.join(part_file("f", name))) else { continue };
        out.push(',');
        out.push_str(&serde_json::to_string(name).ok()?);
        out.push(':');
        out.push_str(&f);
        held.fields.insert(name.clone(), f);
    }
    out.push('}');
    held.index = index_text;
    Some(out)
}

#[tauri::command(async)]
pub fn state_load(app: AppHandle) -> Option<String> {
    let mut guard = HELD.lock().unwrap_or_else(|e| e.into_inner());
    let held = guard.insert(Held::default());
    load_parts(&state_dir(&app), held).or_else(|| std::fs::read_to_string(state_file(&app)).ok())
}

/// Written via a temp file so a crash mid-write never leaves half a file.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    std::fs::write(&tmp, bytes).and_then(|_| std::fs::rename(&tmp, path)).map_err(|e| e.to_string())
}

/// Save the state from its parts (see src/state/persist.ts): only what changed crosses the
/// bridge and only what changed is written. Returns what it lacked (nothing written for the index then).
#[tauri::command(async)]
pub fn state_save_parts(
    app: AppHandle,
    names: Vec<String>,
    fields: std::collections::HashMap<String, String>,
    order: Vec<String>,
    tasks: std::collections::HashMap<String, String>,
) -> Result<Missing, String> {
    let mut guard = HELD.lock().unwrap_or_else(|e| e.into_inner());
    let held = guard.get_or_insert_with(Default::default);
    let missing = save_parts(&state_dir(&app), held, &names, fields, &order, tasks)?;
    // the one-file state of older versions: kept once, aside, after the first whole save
    if missing.fields.is_empty() && missing.tasks.is_empty() {
        let old = state_file(&app);
        if old.exists() {
            let _ = std::fs::rename(&old, data_dir(&app).join("state-before-parts.json"));
        }
    }
    Ok(missing)
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
#[tauri::command(async)]
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

/// Choose an existing local folder. Cancellation leaves the current project alone.
#[tauri::command]
pub async fn pick_folder(prompt: String) -> Option<String> {
    #[cfg(not(target_os = "macos"))]
    { rfd::AsyncFileDialog::new().set_title(prompt).pick_folder().await.map(|f| f.path().display().to_string()) }
    #[cfg(target_os = "macos")]
    { pick_folder_mac(prompt) }
}

#[cfg(target_os = "macos")]
fn pick_folder_mac(prompt: String) -> Option<String> {
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
    #[cfg(not(target_os = "macos"))]
    { rfd::AsyncFileDialog::new().set_title(prompt).pick_files().await.unwrap_or_default().into_iter().map(|f| f.path().display().to_string()).collect() }
    #[cfg(target_os = "macos")]
    { pick_files_mac(prompt) }
}

#[cfg(target_os = "macos")]
fn pick_files_mac(prompt: String) -> Vec<String> {
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
    #[cfg(windows)]
    windows::reveal(&path);
    #[cfg(target_os = "linux")]
    linux::reveal(&path);
    #[cfg(target_os = "macos")]
    let _ = Command::new("/usr/bin/open").arg("-R").arg(path).spawn();
}

/// The system's default browser for a web page; Mail or the phone for mailto: and tel:.
/// No other scheme is handed out (an agent's link must not launch an app).
#[tauri::command]
pub fn open_url(url: String) {
    if ["https://", "http://", "mailto:", "tel:"].iter().any(|p| url.starts_with(p)) {
        #[cfg(windows)]
        windows::open_url(&url);
        #[cfg(target_os = "linux")]
        let _ = linux::open(&url);
        #[cfg(target_os = "macos")]
        let _ = Command::new("/usr/bin/open").arg(url).spawn();
    }
}

/// A page of Windows Settings (`privacy-microphone`): one the app names, never an agent's link.
#[cfg(windows)]
pub(crate) fn open_windows_settings(page: &str) {
    windows::open_url(&format!("ms-settings:{page}"));
}

/// Opens the licenses of the open-source software in the app (Settings › 정보) in the default text app.
#[tauri::command]
pub fn open_notices(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    // a development build reads it where scripts/bundle.mjs wrote it
    let file = [dir.join("THIRD_PARTY_NOTICES.txt"), dir.join("resources").join("notices").join("THIRD_PARTY_NOTICES.txt")]
        .into_iter()
        .find(|p| p.is_file())
        .ok_or("라이선스 파일이 없어요")?;
    #[cfg(windows)]
    crate::engine::system_command("notepad.exe").arg(file).spawn().map_err(|e| e.to_string())?;
    #[cfg(target_os = "linux")]
    linux::open(&file.to_string_lossy())?;
    #[cfg(target_os = "macos")]
    Command::new("/usr/bin/open").arg("-t").arg(file).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

fn which(name: &str) -> Option<PathBuf> {
    std::env::split_paths(user_path()).filter(|d| !d.as_os_str().is_empty()).map(|d| d.join(name)).find(|p| p.is_file())
}

/// Opens a file or folder in the user's editor (Cursor, VS Code, Zed), else the default app.
#[tauri::command]
pub fn open_in_editor(path: String) -> Result<(), String> {
    #[cfg(windows)]
    let path = windows::native(&path);
    // Windows installers put a .cmd shim on PATH (running it opens a console); the app is a few folders up
    #[cfg(windows)]
    let editors = [("cursor.cmd", "Cursor.exe"), ("code.cmd", "Code.exe"), ("zed.exe", "zed.exe")]
        .map(|(shim, exe)| which(shim).and_then(|s| s.ancestors().take(5).map(|d| d.join(exe)).find(|p| p.is_file())));
    #[cfg(not(windows))]
    let editors = ["cursor", "code", "zed"].map(which);
    for editor in editors {
        if let Some(bin) = editor {
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
    #[cfg(windows)]
    let mut fallback = windows::editor_fallback(Path::new(&path));
    #[cfg(target_os = "linux")]
    let mut fallback = linux::editor_fallback(Path::new(&path));
    #[cfg(target_os = "macos")]
    let mut fallback = Command::new("/usr/bin/open");
    fallback.arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// A script that opens a shell in `path` with the space's environment (its git
/// identity, GitHub login, ssh keys, CLI shims first on PATH).
#[cfg(not(windows))]
fn shell_script(path: &str, env: &[(String, String)]) -> String {
    let q = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let sh = crate::engine::DEFAULT_SHELL;
    let mut lines = vec![format!("#!{sh}"), format!("cd {} || exit 1", q(path))];
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
        "exec \"${{SHELL:-{sh}}}\" -l -c {}",
        q(&format!("export PATH={}:\"$PATH\"; exec \"${{SHELL:-{sh}}}\" -i", q(&shims)))
    ));
    lines.join("\n") + "\n"
}

#[cfg(not(windows))]
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
    #[cfg(windows)]
    { let _ = app; windows::terminal(&path, &env.unwrap_or_default()) }
    #[cfg(target_os = "linux")]
    {
        let script = match env.filter(|e| !e.is_empty()) {
            Some(env) => Some(space_shell_script(&app, &path, &env)?),
            None => None,
        };
        linux::terminal(&path, script.as_deref())
    }
    #[cfg(target_os = "macos")]
    { open_mac_terminal(app, path, env) }
}

#[cfg(target_os = "macos")]
fn open_mac_terminal(app: AppHandle, path: String, env: Option<Vec<(String, String)>>) -> Result<(), String> {
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
    #[cfg(windows)]
    let mut curl = crate::engine::system_command("curl.exe");
    #[cfg(not(windows))]
    let mut curl = Command::new("/usr/bin/curl");
    let mut child = curl
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
#[tauri::command(async)]
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
    use super::read_lines_from;

    #[test]
    fn state_is_saved_part_by_part_and_read_back_whole() {
        use super::{load_parts, part_file, save_parts, Held};
        let dir = std::env::temp_dir().join(format!("ondra-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let m = |kv: &[(&str, &str)]| kv.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<std::collections::HashMap<_, _>>();
        let s = |l: &[&str]| l.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let mut held = Held::default();
        let missing = save_parts(&dir, &mut held, &s(&["version", "space"]), m(&[("version", "3"), ("space", "\"home\"")]), &s(&["b", "a"]), m(&[("a", r#"{"id":"a"}"#), ("b", r#"{"id":"b"}"#)])).unwrap();
        assert!(missing.fields.is_empty() && missing.tasks.is_empty());
        let text = load_parts(&dir, &mut Held::default()).unwrap();
        assert_eq!(text, r#"{"tasks":[{"id":"b"},{"id":"a"}],"version":3,"space":"home"}"#);
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["tasks"][1]["id"], "a");

        // only a changed part is written again
        let a = dir.join(part_file("t", "a"));
        let before = std::fs::metadata(&a).unwrap().modified().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        save_parts(&dir, &mut held, &s(&["version", "space"]), m(&[("space", "\"work\"")]), &s(&["b", "a"]), m(&[("a", r#"{"id":"a"}"#), ("b", r#"{"id":"b","x":1}"#)])).unwrap();
        assert_eq!(std::fs::metadata(&a).unwrap().modified().unwrap(), before);
        assert_eq!(load_parts(&dir, &mut Held::default()).unwrap(), r#"{"tasks":[{"id":"b","x":1},{"id":"a"}],"version":3,"space":"work"}"#);

        // a native side that starts fresh asks for what it lacks, and writes no index until it has it
        let mut fresh = Held::default();
        let missing = save_parts(&dir, &mut fresh, &s(&["version"]), m(&[]), &s(&["a", "c"]), m(&[("c", r#"{"id":"c"}"#)])).unwrap();
        assert_eq!((missing.fields, missing.tasks), (s(&["version"]), s(&["a"])));
        assert!(load_parts(&dir, &mut Held::default()).unwrap().contains(r#""space":"work""#));

        // read back, it holds what's there: a save of the same parts writes nothing, and a task gone goes from the folder
        let mut back = Held::default();
        load_parts(&dir, &mut back).unwrap();
        let missing = save_parts(&dir, &mut back, &s(&["version", "space"]), m(&[]), &s(&["a"]), m(&[])).unwrap();
        assert!(missing.fields.is_empty() && missing.tasks.is_empty());
        assert!(!dir.join(part_file("t", "b")).exists());
        assert_eq!(load_parts(&dir, &mut Held::default()).unwrap(), r#"{"tasks":[{"id":"a"}],"version":3,"space":"work"}"#);

        // names the disk could confuse stay apart
        assert_ne!(part_file("f", "memoryNow"), part_file("f", "memorynow"));
        assert_eq!(part_file("t", "tmw1#2"), "t.tmw1%232.json");
        let _ = std::fs::remove_dir_all(&dir);
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

#[cfg(all(test, not(windows)))]
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
        let out = std::process::Command::new(crate::engine::DEFAULT_SHELL)
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
