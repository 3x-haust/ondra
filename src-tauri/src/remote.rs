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

fn devices_file(app: &AppHandle) -> std::path::PathBuf {
    crate::engine::data_dir(app).join("remote").join("devices.json")
}

/// The Macs allowed in, read from the helper's own list: shown even while it isn't running.
#[tauri::command]
pub fn remote_devices(app: AppHandle) -> serde_json::Value {
    let list = std::fs::read(devices_file(&app)).ok().and_then(|b| serde_json::from_slice(&b).ok());
    list.filter(serde_json::Value::is_array).unwrap_or_else(|| serde_json::json!([]))
}

/// The list without that Mac (a list that can't be read counts as empty).
fn forget_in(bytes: &[u8], id: &str) -> Vec<serde_json::Value> {
    let list: Vec<serde_json::Value> = serde_json::from_slice(bytes).unwrap_or_default();
    list.into_iter().filter(|d| d.get("id").and_then(|v| v.as_str()) != Some(id)).collect()
}

/// Forget a Mac allowed in. The running helper does it (it holds the list and cuts that Mac
/// off); when it isn't running the file is changed here. The new list, when changed here.
#[tauri::command]
pub fn remote_forget(app: AppHandle, id: String) -> Result<Option<serde_json::Value>, String> {
    // held throughout, so the helper can't start (and read the old file) halfway
    let mut slot = HELPER.lock().map_err(|e| e.to_string())?;
    if let Some(r) = slot.as_mut() {
        if r.child.try_wait().ok().flatten().is_none() {
            let line = format!("{}\n", serde_json::json!({ "cmd": "revoke", "id": id }));
            return r.stdin.write_all(line.as_bytes()).map(|_| None).map_err(|e| e.to_string());
        }
    }
    let path = devices_file(&app);
    let list = match std::fs::read(&path) {
        Ok(b) => forget_in(&b, &id),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
        Err(e) => return Err(e.to_string()),
    };
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&list).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(Some(serde_json::Value::Array(list)))
}

/// The Mac's name as people know it ("Alex의 MacBook Pro").
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

static AWAKE: Mutex<Option<Child>> = Mutex::new(None);

/// Keep this Mac from sleeping while others may work on it (on power only): a `caffeinate` tied to this app, so it never outlives it.
#[tauri::command]
pub fn remote_awake(on: bool) -> Result<(), String> {
    let mut slot = AWAKE.lock().map_err(|e| e.to_string())?;
    if let Some(mut c) = slot.take() {
        let _ = c.kill();
        let _ = c.wait();
    }
    if on {
        let child = Command::new("/usr/bin/caffeinate")
            .args(["-s", "-i", "-w", &std::process::id().to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        *slot = Some(child);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::forget_in;

    #[test]
    fn forgets_one_device_and_keeps_the_rest() {
        let file = br#"[{"id":"a","name":"Air","addedAt":1,"lastSeen":2},{"id":"b","name":"Pro","addedAt":1,"lastSeen":2}]"#;
        let rest = forget_in(file, "a");
        assert_eq!(rest.len(), 1);
        assert_eq!(rest[0]["id"], "b");
        // its other fields stay as the helper wrote them
        assert_eq!(rest[0]["lastSeen"], 2);
        assert_eq!(forget_in(file, "zzz").len(), 2);
        assert!(forget_in(b"not json", "a").is_empty());
    }
}
