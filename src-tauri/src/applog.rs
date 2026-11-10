//! The app's log: one file a day under `<data>/logs` (`ondra-YYYY-MM-DD.log`), a week kept.
//! The app writes what happened (errors, engines ending, jobs failing, updates) and reads the
//! newest part back for a feedback report. Lines arrive already redacted from the app side.

use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::AppHandle;

const MAX_FILE: u64 = 8 * 1024 * 1024;
const REPO: &str = "3x-haust/ondra";

fn dir(app: &AppHandle) -> PathBuf {
    let d = crate::engine::data_dir(app).join("logs");
    let _ = fs::create_dir_all(&d);
    d
}

fn day_ok(day: &str) -> bool {
    day.len() == 10 && day.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() })
}

/// Append lines to that day's file; files from before `keep_from` are removed.
#[tauri::command]
pub fn log_append(app: AppHandle, day: String, lines: Vec<String>, keep_from: Option<String>) -> Result<(), String> {
    if !day_ok(&day) {
        return Err("bad day".into());
    }
    let d = dir(&app);
    if let Some(keep) = keep_from.filter(|k| day_ok(k)) {
        if let Ok(rd) = fs::read_dir(&d) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if let Some(day) = name.strip_prefix("ondra-").and_then(|n| n.strip_suffix(".log")) {
                    if day_ok(day) && day < keep.as_str() {
                        let _ = fs::remove_file(e.path());
                    }
                }
            }
        }
    }
    let path = d.join(format!("ondra-{day}.log"));
    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_FILE {
        return Ok(());
    }
    let mut f = OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    let mut text = lines.join("\n");
    text.push('\n');
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())
}

/// The newest part of the log, up to `max_bytes`, oldest line first (whole lines only).
#[tauri::command]
pub fn logs_recent(app: AppHandle, max_bytes: usize) -> String {
    let d = dir(&app);
    let mut files: Vec<PathBuf> = fs::read_dir(&d)
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().map(|x| x == "log").unwrap_or(false)).collect())
        .unwrap_or_default();
    files.sort();
    let mut out: Vec<String> = Vec::new();
    let mut left = max_bytes;
    for p in files.iter().rev() {
        if left == 0 {
            break;
        }
        let Ok(mut f) = fs::File::open(p) else { continue };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        let take = (len as usize).min(left);
        let _ = f.seek(SeekFrom::Start(len - take as u64));
        let mut buf = Vec::with_capacity(take);
        let _ = f.read_to_end(&mut buf);
        let mut s = String::from_utf8_lossy(&buf).to_string();
        // a cut first line is dropped
        if (take as u64) < len {
            if let Some(i) = s.find('\n') {
                s = s[i + 1..].to_string();
            }
        }
        left -= take;
        out.push(s);
    }
    out.reverse();
    out.join("")
}

/// The macOS version (the web view's user agent is frozen at 10.15.7).
#[tauri::command]
pub fn os_version() -> String {
    Command::new("sw_vers").arg("-productVersion").output().ok().map(|o| format!("macOS {}", String::from_utf8_lossy(&o.stdout).trim())).unwrap_or_else(|| "macOS".into())
}

/// File an issue on the app's repository with the user's own GitHub CLI login. Returns its URL.
/// "NO_GH" when the CLI is missing or not signed in: the app opens the new-issue page instead.
#[tauri::command]
pub async fn feedback_issue(title: String, body: String) -> Result<String, String> {
    let ok = Command::new("gh").env("PATH", crate::engine::user_path()).args(["auth", "status"]).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    if !ok {
        return Err("NO_GH".into());
    }
    let mut c = Command::new("gh")
        .env("PATH", crate::engine::user_path())
        .args(["issue", "create", "-R", REPO, "--title", &title, "--body-file", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "NO_GH".to_string())?;
    if let Some(mut i) = c.stdin.take() {
        let _ = i.write_all(body.as_bytes());
    }
    let out = c.wait_with_output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).lines().last().unwrap_or("").trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(err.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("gh failed").to_string())
    }
}
