//! In-app terminals. A PTY per id, output streamed to the UI as UTF-8 text
//! (`pty:data`), exit as `pty:exit`. Also used to log an account in: the
//! engine's own interactive UI runs in a PTY and `/login` is typed for the user.

use crate::engine::{engine_bin, engine_env, home, user_path, user_var, with_sidecars};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde_json::json;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, State};

struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct Ptys {
    map: Mutex<HashMap<String, Pty>>,
}

impl Ptys {
    pub fn kill_all(&self) {
        if let Ok(mut map) = self.map.lock() {
            for (_, mut p) in map.drain() {
                let _ = p.child.kill();
            }
        }
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize { rows: rows.max(2), cols: cols.max(10), pixel_width: 0, pixel_height: 0 }
}

/// Decodes as much valid UTF-8 as possible, keeping an incomplete trailing
/// sequence in `pending` for the next read. Invalid bytes become U+FFFD.
fn take_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(pending) {
            Ok(s) => {
                out.push_str(s);
                pending.clear();
                return out;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                out.push_str(std::str::from_utf8(&pending[..valid]).unwrap_or_default());
                match e.error_len() {
                    // Incomplete sequence at the end: wait for more bytes.
                    None => {
                        pending.drain(..valid);
                        return out;
                    }
                    Some(bad) => {
                        out.push('\u{FFFD}');
                        pending.drain(..valid + bad);
                    }
                }
            }
        }
    }
}

fn spawn(
    app: AppHandle,
    ptys: &Ptys,
    id: String,
    mut cmd: CommandBuilder,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    if let Some(mut old) = ptys.map.lock().unwrap().remove(&id) {
        let _ = old.child.kill();
    }
    let pair = native_pty_system().openpty(size(cols, rows)).map_err(|e| e.to_string())?;
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("LANG", user_var("LANG").unwrap_or_else(|| "en_US.UTF-8".into()));
    let child = pair.slave.spawn_command(cmd).map_err(|e| format!("터미널을 시작하지 못했습니다: {e}"))?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    ptys.map.lock().unwrap().insert(id.clone(), Pty { master: pair.master, writer, child });

    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let text = take_utf8(&mut pending);
                    if !text.is_empty() {
                        let _ = app.emit("pty:data", json!({ "id": id, "data": text }));
                    }
                }
            }
        }
        use tauri::Manager;
        let code = app
            .state::<Ptys>()
            .map
            .lock()
            .ok()
            .and_then(|mut m| m.remove(&id))
            .and_then(|mut p| p.child.wait().ok())
            .map(|s| s.exit_code());
        let _ = app.emit("pty:exit", json!({ "id": id, "code": code }));
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn pty_open(
    app: AppHandle,
    ptys: State<'_, Ptys>,
    id: String,
    cwd: String,
    command: Option<String>,
    args: Vec<String>,
    env: Vec<(String, String)>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut cmd = match command {
        Some(c) => {
            let mut b = CommandBuilder::new(c);
            b.args(&args);
            b
        }
        None => {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
            let mut b = CommandBuilder::new(shell);
            b.arg("-l");
            b.args(&args);
            b
        }
    };
    let cwd = if cwd.is_empty() { home().display().to_string() } else { cwd };
    cmd.cwd(&cwd);
    cmd.env("PATH", with_sidecars(user_path()));
    for (k, v) in env {
        if k == "PATH" {
            cmd.env("PATH", format!("{v}:{}", with_sidecars(user_path())));
        } else {
            cmd.env(k, v);
        }
    }
    spawn(app, &ptys, id, cmd, cols, rows)
}

/// The engine's interactive UI for one account, with `/login` typed in.
#[tauri::command]
pub fn pty_open_login(app: AppHandle, ptys: State<'_, Ptys>, id: String, account_id: String, cols: u16, rows: u16) -> Result<(), String> {
    let bin = engine_bin(&app).filter(|b| b.is_file()).ok_or("엔진 파일이 앱에 없습니다")?;
    let mut cmd = CommandBuilder::new(bin);
    cmd.arg("--no-extensions");
    cmd.cwd(home());
    for (k, v) in engine_env(&app) {
        cmd.env(k, v);
    }
    if let Some(dir) = crate::store::account_dir(&app, &account_id) {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        cmd.env("PI_CODING_AGENT_DIR", dir);
    }
    spawn(app.clone(), &ptys, id.clone(), cmd, cols, rows)?;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1200));
        use tauri::Manager;
        if let Some(p) = app.state::<Ptys>().map.lock().unwrap().get_mut(&id) {
            let _ = p.writer.write_all(b"/login\r");
            let _ = p.writer.flush();
        }
    });
    Ok(())
}

#[tauri::command]
pub fn pty_write(ptys: State<'_, Ptys>, id: String, data: String) -> Result<(), String> {
    let mut map = ptys.map.lock().unwrap();
    let p = map.get_mut(&id).ok_or("터미널이 닫혔습니다")?;
    p.writer.write_all(data.as_bytes()).and_then(|_| p.writer.flush()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(ptys: State<'_, Ptys>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = ptys.map.lock().unwrap();
    let p = map.get(&id).ok_or("터미널이 닫혔습니다")?;
    p.master.resize(size(cols, rows)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_close(ptys: State<'_, Ptys>, id: String) {
    if let Some(mut p) = ptys.map.lock().unwrap().remove(&id) {
        let _ = p.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::take_utf8;

    #[test]
    fn utf8_split_across_reads() {
        let bytes = "한글".as_bytes();
        let mut pending = bytes[..2].to_vec();
        assert_eq!(take_utf8(&mut pending), "");
        pending.extend_from_slice(&bytes[2..]);
        assert_eq!(take_utf8(&mut pending), "한글");
        let mut bad = vec![b'a', 0xff, b'b'];
        assert_eq!(take_utf8(&mut bad), "a\u{FFFD}b");
    }
}
