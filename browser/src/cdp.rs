// A Chrome DevTools Protocol client over one browser-level WebSocket, with flat sessions.
//
// `call` blocks the calling thread until the reply comes; events are delivered in order
// on their own thread, so an event handler may `send` (fire and forget) but must not `call`.

use crate::util::{Get, Json, Res};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tungstenite::protocol::{Role, WebSocketConfig};
use tungstenite::{Message, WebSocket};

pub type EventFn = Box<dyn Fn(&str, &Json, Option<&str>) + Send + Sync>;

pub struct Cdp {
    writer: Mutex<WebSocket<TcpStream>>,
    next_id: AtomicI64,
    pending: Mutex<HashMap<i64, Sender<Res<Json>>>>,
    closed: AtomicBool,
    pub endpoint: String,
    pub on_event: OnceLock<EventFn>,
    pub on_close: OnceLock<Box<dyn Fn() + Send + Sync>>,
}

fn config() -> WebSocketConfig {
    WebSocketConfig::default().max_message_size(Some(512 << 20)).max_frame_size(Some(512 << 20))
}

impl Cdp {
    /// `endpoint`: a DevTools port, `host:port`, an http(s) URL or a ws(s) URL.
    pub fn connect(endpoint: &str) -> Res<Arc<Cdp>> {
        let ws = resolve(endpoint)?;
        let rest = ws.strip_prefix("ws://").ok_or_else(|| format!("only ws:// endpoints are supported: {ws}"))?;
        let hostport = rest.split('/').next().unwrap_or_default().to_string();
        let addr = hostport.to_socket_addrs().map_err(|e| format!("bad CDP address {hostport}: {e}"))?.next().ok_or("no CDP address")?;
        let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| format!("no browser at {endpoint}: {e}"))?;
        let _ = stream.set_nodelay(true);
        let (reader, _) = tungstenite::client::client_with_config(ws.as_str(), stream, Some(config())).map_err(|e| format!("could not connect to the browser: {e}"))?;
        let raw = reader.get_ref().try_clone().map_err(|e| e.to_string())?;
        let writer = WebSocket::from_raw_socket(raw, Role::Client, Some(config()));
        let cdp = Arc::new(Cdp {
            writer: Mutex::new(writer),
            next_id: AtomicI64::new(0),
            pending: Mutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            endpoint: endpoint.to_string(),
            on_event: OnceLock::new(),
            on_close: OnceLock::new(),
        });
        let (tx, rx) = channel::<(String, Json, Option<String>)>();
        let me = Arc::downgrade(&cdp);
        std::thread::spawn(move || {
            // events, in order
            while let Ok((m, p, s)) = rx.recv() {
                let Some(c) = me.upgrade() else { return };
                if m == "\u{0}close" {
                    if let Some(f) = c.on_close.get() {
                        f();
                    }
                    continue;
                }
                if let Some(f) = c.on_event.get() {
                    f(&m, &p, s.as_deref());
                }
            }
        });
        let me = Arc::downgrade(&cdp);
        std::thread::spawn(move || {
            let mut reader = reader;
            loop {
                let msg = reader.read();
                let Some(c) = me.upgrade() else { return };
                let text = match msg {
                    Ok(Message::Text(t)) => t.to_string(),
                    Ok(Message::Binary(b)) => String::from_utf8_lossy(&b).into_owned(),
                    Ok(Message::Close(_)) | Err(_) => {
                        c.shut_down();
                        let _ = tx.send(("\u{0}close".into(), Json::new(), None));
                        return;
                    }
                    Ok(_) => continue,
                };
                let Ok(msg) = serde_json::from_str::<Json>(&text) else { continue };
                if let Some(id) = msg.int("id") {
                    let Some(p) = c.pending.lock().unwrap().remove(&id) else { continue };
                    let r = match msg.obj("error") {
                        Some(e) => {
                            let data = e.str("data").map(|d| format!(" ({d})")).unwrap_or_default();
                            Err(format!("{}{data}", e.str("message").unwrap_or("CDP error")))
                        }
                        None => Ok(msg.obj("result").cloned().unwrap_or_default()),
                    };
                    let _ = p.send(r);
                } else if let Some(method) = msg.str("method") {
                    let params = msg.obj("params").cloned().unwrap_or_default();
                    let _ = tx.send((method.to_string(), params, msg.str("sessionId").map(String::from)));
                }
            }
        });
        // the first call proves the socket is up
        cdp.call("Browser.getVersion", Json::new(), None, 10.0)?;
        Ok(cdp)
    }

    pub fn closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    fn shut_down(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        for (_, p) in self.pending.lock().unwrap().drain() {
            let _ = p.send(Err("the browser connection closed".into()));
        }
    }

    fn message(&self, method: &str, params: Json, session: Option<&str>) -> (i64, String) {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let mut m = crate::obj!({ "id": id, "method": method, "params": params });
        if let Some(s) = session {
            m.insert("sessionId".into(), Value::String(s.into()));
        }
        (id, Value::Object(m).to_string())
    }

    fn write(&self, text: String) -> Res<()> {
        let mut w = self.writer.lock().unwrap();
        w.send(Message::text(text)).map_err(|e| format!("send failed: {e}"))
    }

    pub fn call(&self, method: &str, params: Json, session: Option<&str>, timeout: f64) -> Res<Json> {
        if self.closed() {
            return Err("the browser connection closed".into());
        }
        let (id, text) = self.message(method, params, session);
        let (tx, rx) = channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = self.write(text) {
            self.pending.lock().unwrap().remove(&id);
            return Err(format!("{method}: {e}"));
        }
        match rx.recv_timeout(Duration::from_secs_f64(timeout)) {
            Ok(Ok(r)) => Ok(r),
            Ok(Err(e)) => Err(format!("{method}: {e}")),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(format!("the browser did not answer {method} within {} s", timeout as i64))
            }
        }
    }

    /// Fire and forget (for event handlers).
    pub fn send(&self, method: &str, params: Json, session: Option<&str>) {
        if self.closed() {
            return;
        }
        let (_, text) = self.message(method, params, session);
        let _ = self.write(text);
    }
}

/// The browser's WebSocket URL for an endpoint.
pub fn resolve(endpoint: &str) -> Res<String> {
    if endpoint.starts_with("ws://") || endpoint.starts_with("wss://") {
        return Ok(endpoint.to_string());
    }
    let base = if endpoint.parse::<u16>().is_ok() {
        format!("127.0.0.1:{endpoint}")
    } else {
        endpoint.trim_start_matches("http://").trim_end_matches('/').to_string()
    };
    if base.starts_with("https://") {
        return Err(format!("bad CDP endpoint {endpoint}"));
    }
    let hostport = base.split('/').next().unwrap_or_default();
    let body = http_get(hostport, "/json/version").map_err(|e| format!("no browser at {endpoint}: {e}"))?;
    let j: Json = serde_json::from_str(&body).map_err(|_| format!("no browser at {endpoint}"))?;
    j.str("webSocketDebuggerUrl").map(String::from).ok_or_else(|| format!("no browser at {endpoint}"))
}

/// A plain HTTP GET to a local DevTools endpoint; the body.
pub fn http_get(hostport: &str, path: &str) -> Res<String> {
    let addr = hostport.to_socket_addrs().map_err(|e| e.to_string())?.next().ok_or("no address")?;
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(5)).map_err(|e| e.to_string())?;
    let _ = s.set_read_timeout(Some(Duration::from_secs(6)));
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: {hostport}\r\nConnection: close\r\n\r\n").as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    let _ = s.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").ok_or("did not answer")?;
    if !head.lines().next().is_some_and(|l| l.contains(" 200")) {
        return Err(head.lines().next().unwrap_or("bad answer").to_string());
    }
    Ok(body.to_string())
}
