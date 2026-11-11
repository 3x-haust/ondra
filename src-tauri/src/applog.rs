//! The app's log: one file a day under `<data>/logs` (`ondra-YYYY-MM-DD.log`), a week kept.
//! The app writes what happened (errors, engines ending, jobs failing, updates) and reads the
//! newest part back for a feedback report. Lines arrive already redacted from the app side.

use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;

const MAX_FILE: u64 = 8 * 1024 * 1024;

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

/// "2026-11-11 10:20:01" and "2026-11-11" in local time, the way the app side writes them.
fn now() -> (String, String) {
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    let t = unsafe { libc::time(std::ptr::null_mut()) };
    unsafe { libc::localtime_r(&t, &mut tm) };
    let day = format!("{:04}-{:02}-{:02}", tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday);
    (format!("{day} {:02}:{:02}:{:02}", tm.tm_hour, tm.tm_min, tm.tm_sec), day)
}

/// One line in the app's format; the home folder's name never reaches the file.
fn line(at: &str, level: &str, src: &str, msg: &str, home: &str) -> String {
    let msg = if home.len() > 1 { msg.replace(home, "~") } else { msg.to_string() };
    let msg: String = msg.split('\n').map(str::trim).collect::<Vec<_>>().join(" ⏎ ").chars().take(2000).collect();
    format!("{at} {level:<5} [{src}] {msg}\n")
}

/// A native panic goes to the log as well (where and what), for a feedback report.
pub fn install_panic_hook(app: &AppHandle) {
    let d = dir(app);
    let home = std::env::var("HOME").unwrap_or_default();
    let was = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let (at, day) = now();
        let thread = std::thread::current().name().unwrap_or("?").to_string();
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(d.join(format!("ondra-{day}.log"))) {
            let _ = f.write_all(line(&at, "ERROR", "native", &format!("panic in {thread}: {info}"), &home).as_bytes());
        }
        was(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_native_line_reads_like_the_apps_and_hides_the_home_folder() {
        let l = line("2026-11-11 10:20:01", "ERROR", "native", "panic at /Users/me/x.rs:1\n  boom", "/Users/me");
        assert_eq!(l, "2026-11-11 10:20:01 ERROR [native] panic at ~/x.rs:1 ⏎ boom\n");
        assert!(day_ok(&now().1));
    }
}
