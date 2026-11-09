//! A small door from the engine's tools back into the app (memory search/save).
//! Localhost only, a random port and a random token per launch; workers get both
//! in their env (ONDRA_BRIDGE, ONDRA_BRIDGE_TOKEN). POST /call {op, worker, args}
//! is handed to the main window as a `bridge:call` event and answered with
//! `bridge_reply`. Only the ops the page handles exist; nothing is evaluated.

use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::{mpsc, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

type Waiters = Mutex<HashMap<u64, mpsc::Sender<String>>>;
fn waiters() -> &'static Waiters {
    static W: OnceLock<Waiters> = OnceLock::new();
    W.get_or_init(Default::default)
}
static DOOR: OnceLock<(u16, String)> = OnceLock::new();

#[tauri::command]
pub fn bridge_reply(id: u64, value: String) {
    if let Some(tx) = waiters().lock().unwrap().remove(&id) {
        let _ = tx.send(value);
    }
}

/// Env for a worker so its tools can reach the app.
pub fn env() -> Vec<(String, String)> {
    match DOOR.get() {
        Some((port, token)) => vec![("ONDRA_BRIDGE".into(), format!("http://127.0.0.1:{port}/call")), ("ONDRA_BRIDGE_TOKEN".into(), token.clone())],
        None => vec![],
    }
}

/// The same env for main's own engine (its job tools), which isn't started as a worker.
#[tauri::command]
pub fn bridge_env() -> Vec<(String, String)> {
    env()
}

fn token() -> String {
    let mut b = [0u8; 24];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut b);
    }
    b.iter().map(|x| format!("{x:02x}")).collect()
}

pub fn start(app: AppHandle) {
    let Ok(listener) = TcpListener::bind("127.0.0.1:0") else { return };
    let Ok(addr) = listener.local_addr() else { return };
    let secret = token();
    let _ = DOOR.set((addr.port(), secret.clone()));
    std::thread::spawn(move || {
        let mut seq = 0u64;
        for stream in listener.incoming().flatten() {
            seq += 1;
            let id = seq;
            let app = app.clone();
            let secret = secret.clone();
            std::thread::spawn(move || {
                let mut stream = stream;
                let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
                let Ok(clone) = stream.try_clone() else { return };
                let mut reader = BufReader::new(clone);
                let mut line = String::new();
                if reader.read_line(&mut line).is_err() || !line.starts_with("POST /call ") {
                    let _ = write!(stream, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                    return;
                }
                let (mut len, mut auth) = (0usize, false);
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    let l = line.to_ascii_lowercase();
                    if let Some(v) = l.strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0).min(4 * 1024 * 1024);
                    }
                    if line.trim().eq_ignore_ascii_case(&format!("x-token: {secret}")) {
                        auth = true;
                    }
                }
                let mut body = vec![0u8; len];
                let _ = reader.read_exact(&mut body);
                let (status, reply) = if !auth {
                    ("401 Unauthorized", "{\"error\":\"unauthorized\"}".to_string())
                } else {
                    match serde_json::from_slice::<serde_json::Value>(&body) {
                        Ok(call) => {
                            let (tx, rx) = mpsc::channel();
                            waiters().lock().unwrap().insert(id, tx);
                            let payload = serde_json::json!({ "id": id, "call": call });
                            if app.emit_to("main", "bridge:call", payload).is_ok() {
                                let r = rx.recv_timeout(Duration::from_secs(60)).unwrap_or_else(|_| "{\"error\":\"timeout\"}".into());
                                ("200 OK", r)
                            } else {
                                waiters().lock().unwrap().remove(&id);
                                ("503 Service Unavailable", "{\"error\":\"app not ready\"}".into())
                            }
                        }
                        Err(_) => ("400 Bad Request", "{\"error\":\"bad json\"}".into()),
                    }
                };
                let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", reply.len(), reply);
            });
        }
    });
}
