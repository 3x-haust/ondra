// One page (tab) a session is attached to: what its events tell us, kept for commands.

use crate::util::{json_string, now_ms, Get, Json};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};

#[derive(Clone)]
pub struct RefEntry {
    pub backend_id: i64,
    pub role: String,
    pub name: String,
}

#[derive(Clone)]
pub struct NetRequest {
    pub id: String,
    pub url: String,
    pub method: String,
    pub resource_type: String,
    pub headers: Value,
    pub post_data: Option<String>,
    pub status: Option<i64>,
    pub mime_type: Option<String>,
    pub response_headers: Option<Value>,
    pub failed: Option<String>,
    pub finished: bool,
    pub timestamp: f64,
}

#[derive(Default)]
pub struct TabState {
    pub url: String,
    pub title: String,
    pub main_frame_id: Option<String>,
    /// lifecycle events seen, per loader
    pub lifecycle: HashMap<String, HashSet<String>>,
    pub loader_id: Option<String>,
    /// main-frame navigations committed so far (a wait can tell a new document from the old one)
    pub navigations: i64,
    pub refs: HashMap<String, RefEntry>,
    pub ref_of: HashMap<i64, String>,
    pub next_ref: i64,
    pub requests: HashMap<String, NetRequest>,
    pub order: Vec<String>,
    pub inflight: HashSet<String>,
    pub last_net: f64,
    pub console: Vec<Value>,
    pub errors: Vec<Value>,
    /// the last snapshot's lines, per way of taking it (for --delta)
    pub last_snapshot: HashMap<String, Vec<String>>,
    pub mouse: (f64, f64),
    pub screencasting: bool,
    pub last_frame: Option<(String, Json)>,
    /// a keychain sign-in filled a form here: request bodies may hold the password, so none are kept
    pub signed_in: bool,
}

pub struct Tab {
    pub target_id: String,
    pub session_id: String,
    pub gone: AtomicBool,
    st: Mutex<TabState>,
}

impl Tab {
    pub fn new(target_id: String, session_id: String) -> Tab {
        Tab { target_id, session_id, gone: AtomicBool::new(false), st: Mutex::new(TabState { next_ref: 1, last_net: now_ms(), ..Default::default() }) }
    }

    pub fn s(&self) -> MutexGuard<'_, TabState> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn gone(&self) -> bool {
        self.gone.load(Ordering::SeqCst)
    }

    pub fn url(&self) -> String {
        self.s().url.clone()
    }

    /// Events for this tab's CDP session (called on the event thread).
    pub fn handle(&self, method: &str, p: &Json) {
        let mut s = self.s();
        match method {
            "Page.lifecycleEvent" => {
                if !(p.str("frameId") == s.main_frame_id.as_deref() || s.main_frame_id.is_none()) {
                    return;
                }
                let (Some(loader), Some(name)) = (p.str("loaderId"), p.str("name")) else { return };
                if name == "init" {
                    s.lifecycle.insert(loader.into(), HashSet::new());
                    s.loader_id = Some(loader.into());
                }
                s.lifecycle.entry(loader.into()).or_default().insert(name.into());
                if s.lifecycle.len() > 20 {
                    let keep = s.loader_id.clone();
                    s.lifecycle.retain(|k, _| Some(k) == keep.as_ref());
                }
            }
            "Page.frameNavigated" => {
                let Some(f) = p.obj("frame") else { return };
                if f.get("parentId").is_some_and(|v| !v.is_null()) {
                    return;
                }
                s.main_frame_id = f.str("id").map(String::from);
                s.navigations += 1;
                s.url = format!("{}{}", f.str("url").unwrap_or_default(), f.str("urlFragment").unwrap_or_default());
                if let Some(l) = f.str("loaderId") {
                    s.loader_id = Some(l.into());
                }
                s.refs.clear();
                s.ref_of.clear();
                s.next_ref = 1;
                s.last_snapshot.clear();
                s.console.clear();
                s.errors.clear();
            }
            "Page.navigatedWithinDocument" => {
                if p.str("frameId") == s.main_frame_id.as_deref() {
                    if let Some(u) = p.str("url") {
                        s.url = u.into();
                    }
                }
            }
            "Runtime.consoleAPICalled" => {
                let args: Vec<Json> = p.arr("args").map(|a| a.iter().filter_map(|x| x.as_object().cloned()).collect()).unwrap_or_default();
                let text = args.iter().map(remote_text).collect::<Vec<_>>().join(" ");
                let mut kind = p.str("type").unwrap_or("log").to_string();
                if kind == "warning" {
                    kind = "warn".into();
                }
                let shown: Vec<Value> = args.iter().map(|a| serde_json::json!({ "type": a.str("type").unwrap_or_default(), "value": a.get("value").cloned().unwrap_or(Value::Null) })).collect();
                s.console.push(serde_json::json!({ "type": kind, "text": text, "args": shown }));
                if s.console.len() > 1000 {
                    let n = s.console.len() - 1000;
                    s.console.drain(..n);
                }
            }
            "Runtime.exceptionThrown" => {
                let d = p.obj("exceptionDetails").cloned().unwrap_or_default();
                let text = d.obj("exception").and_then(|e| e.str("description")).or(d.str("text")).unwrap_or("error").to_string();
                let g = |k: &str| d.get(k).cloned().unwrap_or(Value::Null);
                s.errors.push(serde_json::json!({ "text": text, "line": g("lineNumber"), "column": g("columnNumber"), "url": g("url") }));
                if s.errors.len() > 500 {
                    let n = s.errors.len() - 500;
                    s.errors.drain(..n);
                }
            }
            "Network.requestWillBeSent" => {
                let (Some(id), Some(r)) = (p.str("requestId"), p.obj("request")) else { return };
                let kind = p.str("type").unwrap_or("Other").to_string();
                if !s.requests.contains_key(id) {
                    s.order.push(id.into());
                }
                // a redirect reuses the id: keep the latest hop
                let req = NetRequest {
                    id: id.into(),
                    url: r.str("url").unwrap_or_default().into(),
                    method: r.str("method").unwrap_or("GET").into(),
                    resource_type: kind.clone(),
                    headers: r.get("headers").cloned().unwrap_or(Value::Object(Json::new())),
                    post_data: if s.signed_in { None } else { r.str("postData").map(String::from) },
                    status: None,
                    mime_type: None,
                    response_headers: None,
                    failed: None,
                    finished: false,
                    timestamp: p.dbl("wallTime").map(|w| w * 1000.0).unwrap_or_else(now_ms),
                };
                s.requests.insert(id.into(), req);
                if kind != "WebSocket" && kind != "EventSource" {
                    s.inflight.insert(id.into());
                }
                s.last_net = now_ms();
                // the newest 500 (a few page loads); each keeps its headers
                if s.order.len() > 500 {
                    let n = s.order.len() - 500;
                    let old: Vec<String> = s.order.drain(..n).collect();
                    for o in old {
                        s.requests.remove(&o);
                    }
                }
            }
            "Network.responseReceived" => {
                let (Some(id), Some(r)) = (p.str("requestId"), p.obj("response")) else { return };
                if let Some(q) = s.requests.get_mut(id) {
                    q.status = r.int("status");
                    q.mime_type = r.str("mimeType").map(String::from);
                    q.response_headers = r.get("headers").cloned();
                }
                s.last_net = now_ms();
            }
            "Network.loadingFinished" | "Network.loadingFailed" => {
                let Some(id) = p.str("requestId") else { return };
                if let Some(q) = s.requests.get_mut(id) {
                    if method == "Network.loadingFailed" {
                        q.failed = Some(p.str("errorText").unwrap_or("failed").into());
                    }
                    q.finished = true;
                }
                s.inflight.remove(id);
                s.last_net = now_ms();
            }
            _ => {}
        }
    }
}

impl TabState {
    /// The ref for a node, made on first sight.
    pub fn ref_for(&mut self, backend_id: i64, role: &str, name: &str) -> String {
        let entry = RefEntry { backend_id, role: role.into(), name: name.into() };
        if let Some(r) = self.ref_of.get(&backend_id).cloned() {
            self.refs.insert(r.clone(), entry);
            return r;
        }
        let r = format!("e{}", self.next_ref);
        self.next_ref += 1;
        self.ref_of.insert(backend_id, r.clone());
        self.refs.insert(r.clone(), entry);
        r
    }
}

/// A console argument as text, the way DevTools shows it briefly.
pub fn remote_text(o: &Json) -> String {
    if let Some(v) = o.get("value") {
        return match v {
            Value::String(s) => s.clone(),
            Value::Null => "null".into(),
            v => json_string(v),
        };
    }
    if let Some(u) = o.str("unserializableValue") {
        return u.into();
    }
    if o.str("type") == Some("undefined") {
        return "undefined".into();
    }
    o.str("description").or(o.str("type")).unwrap_or_default().into()
}
