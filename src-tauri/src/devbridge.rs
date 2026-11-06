//! Debug builds only: a localhost door for driving the real app in tests
//! (no keystrokes, no screen reading). POST /eval with a JS expression; it runs
//! in the main window and the (awaited) value comes back as JSON.
//! Needs the token written to <data dir>/devbridge.token.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{mpsc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Manager};

type Waiters = Mutex<HashMap<u64, mpsc::Sender<String>>>;
fn waiters() -> &'static Waiters {
    static W: OnceLock<Waiters> = OnceLock::new();
    W.get_or_init(Default::default)
}

#[tauri::command]
pub fn dev_report(id: u64, value: String) {
    if let Some(tx) = waiters().lock().unwrap().remove(&id) {
        let _ = tx.send(value);
    }
}

pub fn start(app: AppHandle) {
    let token = format!("{:x}{:x}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    let dir = crate::engine::data_dir(&app);
    let _ = std::fs::write(dir.join("devbridge.token"), &token);
    std::thread::spawn(move || {
        let Ok(listener) = TcpListener::bind("127.0.0.1:17321") else { return };
        let mut seq = 0u64;
        for stream in listener.incoming().flatten() {
            seq += 1;
            let id = seq;
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                let mut stream = stream;
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut len = 0usize;
                let mut auth = false;
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() {
                    return;
                }
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    let l = line.to_ascii_lowercase();
                    if let Some(v) = l.strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                    if l.trim() == format!("x-token: {token}") {
                        auth = true;
                    }
                }
                let mut body = vec![0u8; len];
                let _ = reader.read_exact(&mut body);
                let reply = if !auth {
                    "\"unauthorized\"".to_string()
                } else {
                    let js = String::from_utf8_lossy(&body);
                    let (tx, rx) = mpsc::channel();
                    waiters().lock().unwrap().insert(id, tx);
                    let wrapped = format!(
                        "(async()=>{{let v;try{{v=await (async()=>{{ {js} }})();v=JSON.stringify(v===undefined?null:v)}}catch(e){{v=JSON.stringify('ERR '+(e&&e.stack||e))}}window.__TAURI_INTERNALS__.invoke('dev_report',{{id:{id},value:v}})}})()"
                    );
                    // the app's page (the window also holds the in-app browser, so it is no plain webview window)
                    match app.get_webview("main") {
                        Some(w) if w.eval(&wrapped).is_ok() => rx.recv_timeout(Duration::from_secs(120)).unwrap_or_else(|_| "\"timeout\"".into()),
                        _ => "\"no window\"".into(),
                    }
                };
                let _ = write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", reply.len(), reply);
            });
        }
    });
}
