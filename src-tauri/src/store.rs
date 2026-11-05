//! Small file-backed helpers: the app state file, per-worker artifact folders,
//! per-account engine login folders (one `PI_CODING_AGENT_DIR` per account so
//! several subscriptions sit side by side), folder picking and opening things,
//! and the inbox folder other tools can drop tasks into.

use crate::engine::{data_dir, home, user_path};
use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{AppHandle, Emitter};

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
        out
    })
    .await
    .unwrap_or_default()
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
#[tauri::command]
pub fn state_save(app: AppHandle, json: String) -> Result<(), String> {
    let path = state_file(&app);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).and_then(|_| std::fs::rename(&tmp, &path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn artifacts_dir(app: AppHandle, worker_id: String) -> String {
    let safe: String = worker_id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
    let dir = data_dir(&app).join("artifacts").join(safe);
    let _ = std::fs::create_dir_all(&dir);
    dir.display().to_string()
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
    let dir = account_dir(&app, &account_id).unwrap_or_else(default_agent_dir);
    let Ok(text) = std::fs::read_to_string(dir.join("auth.json")) else { return vec![] };
    let Ok(serde_json::Value::Object(map)) = serde_json::from_str(&text) else { return vec![] };
    let mut keys: Vec<String> = map.keys().cloned().collect();
    keys.sort();
    keys
}

/// Deletes an Ondra-made account folder. The user's own ~/.pi/agent is never touched.
#[tauri::command]
pub fn account_remove(app: AppHandle, account_id: String) {
    if let Some(dir) = account_dir(&app, &account_id) {
        if dir.starts_with(data_dir(&app)) {
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

#[tauri::command]
pub fn open_url(url: String) {
    if url.starts_with("https://") || url.starts_with("http://") {
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

/// Opens a terminal window in a folder: Ghostty, iTerm, Warp, else Terminal.
#[tauri::command]
pub fn open_in_terminal(path: String) -> Result<(), String> {
    let has = |app: &str| Path::new(&format!("/Applications/{app}.app")).exists();
    let mut cmd = Command::new("/usr/bin/open");
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
                        });
                    }
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
                        out.push(Limit { provider: "anthropic".into(), window: mins, used, resets_at });
                    }
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
