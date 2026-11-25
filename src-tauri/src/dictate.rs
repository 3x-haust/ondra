//! Dictation for the composer's mic button: runs the `ondra-dictate` helper, the microphone
//! and speech recognition on this computer, no audio sent off it: on the Mac
//! helpers/dictate.swift (Apple's on-device recognition), on Windows and Linux the dictate/
//! crate (a speech model it fetches into the app's models folder the first time). One at a
//! time. Its lines go to the window as "dictate" events, each with the id the window started
//! it under, so a late line from an earlier run is told apart; {"id", "end": true} follows
//! the last one.
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter};
#[cfg(not(target_os = "macos"))]
use tauri::Manager;

/// Seconds a dictation records at most; the helper stops itself there.
const MAX_SECONDS: u32 = 120;

struct Running {
    id: u64,
    child: Child,
    stdin: Option<ChildStdin>,
}

static HELPER: Mutex<Option<Running>> = Mutex::new(None);

/// The bundled helper; in development also straight from src-tauri/binaries.
fn helper() -> Result<PathBuf, String> {
    const ARCH: &str = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x86_64" };
    const OS: &str = if cfg!(target_os = "macos") { "apple-darwin" } else if cfg!(windows) { "pc-windows-msvc" } else { "unknown-linux-gnu" };
    const BUILD: &str = if cfg!(target_os = "macos") { "src-tauri/helpers/build.sh" } else { "pnpm tauri build" };
    crate::tools::sidecar("ondra-dictate")
        .or_else(|| {
            let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("binaries/ondra-dictate-{ARCH}-{OS}{}", std::env::consts::EXE_SUFFIX));
            p.exists().then_some(p)
        })
        .ok_or_else(|| format!("받아쓰기 도우미가 없어요. {BUILD} 로 만들어 주세요."))
}

/// Where the Windows and Linux helper keeps its speech model: the machine's own app data
/// (on Windows the local one, not the roaming profile).
#[cfg(not(target_os = "macos"))]
fn models(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| crate::engine::data_dir(app)).join("models")
}

fn kill(mut r: Running) {
    let _ = r.child.kill();
    let _ = r.child.wait();
}

/// A line of the helper's as the event the window gets: its object with the run's id.
fn tagged(line: &str, id: u64) -> Option<serde_json::Value> {
    let mut v = serde_json::from_str::<serde_json::Value>(line).ok()?;
    v.as_object_mut()?.insert("id".into(), id.into());
    Some(v)
}

/// Start dictating in `lang` (a BCP 47 tag, "ko-KR"). One that was running is dropped.
#[tauri::command]
pub fn dictate_start(app: AppHandle, id: u64, lang: String) -> Result<(), String> {
    if lang.is_empty() || lang.len() > 16 || !lang.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("bad language {lang}"));
    }
    let mut slot = HELPER.lock().map_err(|e| e.to_string())?;
    if let Some(r) = slot.take() {
        kill(r);
    }
    let mut cmd = crate::engine::background_command(helper()?);
    cmd.args(["--lang", &lang, "--max", &MAX_SECONDS.to_string()]);
    #[cfg(not(target_os = "macos"))]
    cmd.arg("--models").arg(models(&app));
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().ok_or("no stdout")?;
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(v) = tagged(&line, id) {
                let _ = app.emit("dictate", v);
            }
        }
        // reaped here unless a newer one (or a cancel) took its place and did that
        if let Ok(mut slot) = HELPER.lock() {
            if slot.as_ref().is_some_and(|r| r.id == id) {
                if let Some(r) = slot.take() {
                    kill(r);
                }
            }
        }
        let _ = app.emit("dictate", serde_json::json!({ "id": id, "end": true }));
    });
    *slot = Some(Running { id, child, stdin });
    Ok(())
}

/// Stop recording: the helper sends what it heard as {"final"} and exits.
#[tauri::command]
pub fn dictate_stop(id: u64) -> Result<(), String> {
    let mut slot = HELPER.lock().map_err(|e| e.to_string())?;
    let Some(r) = slot.as_mut().filter(|r| r.id == id) else { return Ok(()) };
    // the closed pipe says the same if the write is lost
    if let Some(mut stdin) = r.stdin.take() {
        let _ = stdin.write_all(b"stop\n");
    }
    Ok(())
}

/// Drop it, and what it heard.
#[tauri::command]
pub fn dictate_cancel(id: u64) -> Result<(), String> {
    let mut slot = HELPER.lock().map_err(|e| e.to_string())?;
    if slot.as_ref().is_some_and(|r| r.id == id) {
        if let Some(r) = slot.take() {
            kill(r);
        }
    }
    Ok(())
}

/// The window was closed or the app quits: the microphone is let go at once.
pub fn stop_all() {
    if let Some(r) = HELPER.lock().ok().and_then(|mut s| s.take()) {
        kill(r);
    }
}

#[cfg(test)]
mod tests {
    use super::tagged;

    #[test]
    fn lines_carry_the_run_id() {
        assert_eq!(tagged(r#"{"partial":"안녕"}"#, 7).unwrap(), serde_json::json!({ "partial": "안녕", "id": 7 }));
        assert!(tagged("not json", 7).is_none());
        assert!(tagged("[1,2]", 7).is_none());
    }
}
