//! Remote control: runs the `ondra-remote` helper (Ondra's own private network, see
//! remote/host) while this Mac works on others or lets them in, passes its events to the
//! window as "remote" and the window's commands to it.
use std::{
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter};

struct Running {
    child: Child,
    stdin: ChildStdin,
}

static HELPER: Mutex<Option<Running>> = Mutex::new(None);

/// Start the helper (if it isn't running). Its events arrive as "remote".
#[tauri::command]
pub fn remote_start(app: AppHandle) -> Result<(), String> {
    let mut slot = HELPER.lock().map_err(|e| e.to_string())?;
    if let Some(r) = slot.as_mut() {
        if r.child.try_wait().ok().flatten().is_none() {
            return Ok(());
        }
    }
    let bin = crate::tools::sidecar("ondra-remote").ok_or("ondra-remote is not bundled")?;
    let dir = crate::engine::data_dir(&app).join("remote");
    let mut child = Command::new(bin)
        .arg("--data")
        .arg(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                let _ = app.emit("remote", v);
            }
        }
        let _ = app.emit("remote", serde_json::json!({ "ev": "stopped" }));
    });
    *slot = Some(Running { child, stdin });
    Ok(())
}

/// Stop it: every phone is cut off until it's on again.
#[tauri::command]
pub fn remote_stop() -> Result<(), String> {
    if let Some(mut r) = HELPER.lock().map_err(|e| e.to_string())?.take() {
        drop(r.stdin);
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
    Ok(())
}

/// One command to the helper ({"cmd":"send","conn":1,"data":{…}} …).
#[tauri::command]
pub fn remote_cmd(cmd: serde_json::Value) -> Result<(), String> {
    let mut slot = HELPER.lock().map_err(|e| e.to_string())?;
    let r = slot.as_mut().ok_or("remote control is off")?;
    let mut line = cmd.to_string();
    line.push('\n');
    r.stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/// The Mac's name as people know it ("성윤의 MacBook Pro").
#[tauri::command]
pub fn remote_host_name() -> String {
    Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Mac".into())
}
