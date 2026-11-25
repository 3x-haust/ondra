// A session's daemon: one CDP connection, the session's tab(s), refs, logs, routes and the
// live stream. The CLI talks to it over a loopback TCP port named in the session's state file
// (with a token only this user can read); commands run one at a time.

use crate::cdp::Cdp;
use crate::stream::{Recorder, StreamServer};
use crate::tab::Tab;
use crate::util::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

pub struct Config {
    pub session: String,
    pub cdp: Option<String>,
    pub pin: bool,
    pub idle_ms: f64,
    pub executable: Option<String>,
    pub init_scripts: Vec<String>,
    pub keychain: Option<String>,
    pub stream_port: u16,
}

impl Config {
    pub fn from_env(session: &str, cdp: Option<String>, pin: bool) -> Config {
        let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Config {
            session: session.into(),
            cdp,
            pin,
            idle_ms: env("ONDRA_BROWSER_IDLE_TIMEOUT_MS").and_then(|v| v.parse().ok()).unwrap_or(30.0 * 60.0 * 1000.0),
            executable: env("ONDRA_BROWSER_EXECUTABLE_PATH"),
            init_scripts: env("ONDRA_BROWSER_INIT_SCRIPTS").map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()).unwrap_or_default(),
            keychain: env("ONDRA_BROWSER_KEYCHAIN"),
            stream_port: env("ONDRA_BROWSER_STREAM_PORT").and_then(|v| v.parse().ok()).unwrap_or(0),
        }
    }
}

pub struct Route {
    pub pattern: String,
    pub abort: bool,
    pub body: Option<String>,
    pub allow_origin: Option<String>,
    pub types: Vec<String>,
}

/// What the client sent.
pub struct Request {
    pub args: Vec<String>,
    pub cwd: String,
    pub stdin: Option<String>,
}

/// One command's outcome: `data` for --json, `text` for people.
pub struct Outcome {
    pub data: Value,
    pub text: String,
}

impl Outcome {
    pub fn new(data: Value, text: impl Into<String>) -> Outcome {
        Outcome { data, text: text.into() }
    }
    pub fn done() -> Outcome {
        Outcome::new(json!({}), "✓ Done")
    }
    pub fn data(data: Value) -> Outcome {
        Outcome::new(data, "✓ Done")
    }
}

#[derive(Default)]
pub struct DState {
    pub tabs: HashMap<String, Arc<Tab>>, // by CDP session id
    pub active: Option<Arc<Tab>>,
    pub tab_ids: HashMap<String, i64>, // targetId → tN
    pub next_tab_id: i64,
    pub routes: Vec<Route>,
    pub media: Vec<Value>,
    pub color_scheme: Option<String>,
    pub extra_headers: Json,
    pub offline: bool,
    pub viewport: Option<Json>,
    /// the size the panel shows this session's tab at, while someone watches there and the
    /// job set no viewport of its own: the page fills the panel as in a real browser
    pub fitted: Option<Json>,
    pub geo: Option<Json>,
    pub user_agent: Option<String>,
    pub downloads: HashMap<String, Json>,
    /// a popup our tab opened (sign-in with Google, payment, OAuth) → the tab that opened it
    pub openers: HashMap<String, String>,
    /// said once, after the next command's own result: the tab commands act on changed by itself
    pub tab_note: Option<String>,
    pub last_use: f64,
    /// when the tabs were last tidied (see `tidy`)
    pub tidied_at: f64,
}

pub struct Daemon {
    pub config: Config,
    pub cdp: Arc<Cdp>,
    chrome: Mutex<Option<Child>>,
    profile_dir: Option<PathBuf>,
    /// commands run one at a time
    pub q: Mutex<()>,
    st: Mutex<DState>,
    pub stream: Mutex<Option<Arc<StreamServer>>>,
    pub recorder: Mutex<Option<Recorder>>,
    /// the port this daemon listens on (the state file names it while it is this daemon's)
    pub own_port: Mutex<u16>,
    pub me: Weak<Daemon>,
}

/// A session sits idle most of the time while its job thinks. A headless browser never
/// feels memory pressure on its own, so after a quiet spell each of our tabs collects its
/// garbage and drops what it can rebuild (decoded images, caches).
const TIDY_AFTER_MS: f64 = 30_000.0;

impl Daemon {
    pub fn start(config: Config) -> Res<Arc<Daemon>> {
        let (endpoint, chrome, profile) = match &config.cdp {
            Some(c) => (c.clone(), None, None),
            None => {
                let (child, port, profile) = launch_chrome(&config)?;
                (port.to_string(), Some(child), Some(profile))
            }
        };
        let cdp = Cdp::connect(&endpoint)?;
        let d = Arc::new_cyclic(|me| Daemon {
            config,
            cdp: cdp.clone(),
            chrome: Mutex::new(chrome),
            profile_dir: profile,
            q: Mutex::new(()),
            st: Mutex::new(DState { next_tab_id: 1, last_use: now_ms(), ..Default::default() }),
            stream: Mutex::new(None),
            recorder: Mutex::new(None),
            own_port: Mutex::new(0),
            me: me.clone(),
        });
        let w = Arc::downgrade(&d);
        let _ = cdp.on_event.set(Box::new(move |m, p, s| {
            if let Some(d) = w.upgrade() {
                d.event(m, p, s);
            }
        }));
        let w = Arc::downgrade(&d);
        let _ = cdp.on_close.set(Box::new(move || {
            if let Some(d) = w.upgrade() {
                log("the browser connection closed");
                d.shutdown(0);
            }
        }));
        cdp.call("Target.setDiscoverTargets", obj!({ "discover": true }), None, 30.0)?;
        if let Ok(s) = StreamServer::start(&d, d.config.stream_port) {
            *d.stream.lock().unwrap() = Some(s);
        }
        Ok(d)
    }

    pub fn st(&self) -> MutexGuard<'_, DState> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn arc(&self) -> Arc<Daemon> {
        self.me.upgrade().expect("daemon")
    }

    pub fn active(&self) -> Option<Arc<Tab>> {
        self.st().active.clone()
    }

    pub fn stream(&self) -> Option<Arc<StreamServer>> {
        self.stream.lock().unwrap().clone()
    }

    pub fn touch(&self) {
        self.st().last_use = now_ms();
    }

    /// Run `f` on the command queue, after whatever runs now (the Swift tool's `q.async`).
    pub fn later(&self, f: impl FnOnce(&Daemon) + Send + 'static) {
        let d = self.arc();
        std::thread::spawn(move || {
            let _g = d.q.lock().unwrap_or_else(|e| e.into_inner());
            f(&d);
        });
    }

    // ───────────── lifetime ─────────────

    pub fn shutdown(&self, code: i32) -> ! {
        if let Some(r) = self.recorder.lock().unwrap_or_else(|e| e.into_inner()).take() {
            r.stop();
        }
        if let Some(s) = self.stream.lock().unwrap_or_else(|e| e.into_inner()).take() {
            s.stop();
        }
        if let Some(mut c) = self.chrome.lock().unwrap_or_else(|e| e.into_inner()).take() {
            terminate(&mut c);
        }
        if let Some(p) = &self.profile_dir {
            let _ = std::fs::remove_dir_all(p);
        }
        self.release_port();
        let pid = std::process::id() as i64;
        update_state(&self.config.session, |st| {
            if st.int("pid") == Some(pid) {
                st.remove("pid");
            }
        });
        std::process::exit(code)
    }

    /// Stop taking new connections: the state file stops naming this daemon's port (only
    /// while it still does: a newer daemon may already have written its own).
    pub fn release_port(&self) -> bool {
        let mut own = self.own_port.lock().unwrap_or_else(|e| e.into_inner());
        if *own == 0 {
            return false;
        }
        let mine = *own as i64;
        let mut released = false;
        update_state(&self.config.session, |st| {
            if st.int("port") == Some(mine) {
                st.remove("port");
                st.remove("token");
                released = true;
            }
        });
        *own = 0;
        released
    }

    pub fn idle_check(&self) {
        let busy = self.stream().is_some_and(|s| s.client_count() > 0) || self.recorder.lock().unwrap().is_some();
        let (last, tidied) = {
            let mut s = self.st();
            if busy {
                s.last_use = now_ms();
            }
            (s.last_use, s.tidied_at)
        };
        if !busy && tidied < last && now_ms() - last > TIDY_AFTER_MS {
            self.st().tidied_at = now_ms();
            self.later(|d| d.tidy());
        }
        if self.config.idle_ms > 0.0 && now_ms() - last > self.config.idle_ms {
            log(&format!("idle for {} s, exiting", (self.config.idle_ms / 1000.0) as i64));
            let _g = self.q.lock().unwrap_or_else(|e| e.into_inner());
            self.shutdown(0);
        }
    }

    fn tidy(&self) {
        if now_ms() - self.st().last_use < TIDY_AFTER_MS {
            return; // a command came in meanwhile
        }
        let mine: Vec<Arc<Tab>> = self.st().tabs.values().filter(|t| !t.gone()).cloned().collect();
        for t in mine {
            let _ = self.cdp.call("HeapProfiler.collectGarbage", Json::new(), Some(&t.session_id), 10.0);
            let _ = self.cdp.call("Memory.simulatePressureNotification", obj!({ "level": "critical" }), Some(&t.session_id), 5.0);
        }
    }

    // ───────────── events ─────────────

    fn event(&self, method: &str, p: &Json, sid: Option<&str>) {
        if method == "Target.targetDestroyed" || method == "Target.detachedFromTarget" {
            let tid = p.str("targetId");
            let (dead, active, opener) = {
                let mut s = self.st();
                let dead: Vec<Arc<Tab>> = s.tabs.values().filter(|t| Some(t.target_id.as_str()) == tid || (sid.is_none() && Some(t.session_id.as_str()) == p.str("sessionId"))).cloned().collect();
                for t in &dead {
                    t.gone.store(true, std::sync::atomic::Ordering::SeqCst);
                    s.tabs.remove(&t.session_id);
                }
                let active = s.active.clone().filter(|a| dead.iter().any(|t| Arc::ptr_eq(t, a)));
                let opener = active.as_ref().and_then(|a| s.openers.get(&a.target_id).cloned());
                (dead, active, opener)
            };
            let _ = dead;
            if let (Some(a), Some(op)) = (&active, opener) {
                // the popup finished (signed in, paid) and closed itself: back to the tab that opened it
                let a = a.clone();
                self.later(move |d| d.popup_closed(&a, &op));
                return;
            }
            if active.is_some() {
                if let Some(s) = self.stream() {
                    s.tab_changed();
                }
                if self.config.pin {
                    update_state(&self.config.session, |st| {
                        st.remove("targetId");
                    });
                }
            }
            return;
        }
        if method == "Target.targetCreated" {
            if let Some(info) = p.obj("targetInfo") {
                let active_tid = self.active().map(|a| a.target_id.clone());
                if let (Some("page"), Some(tid), Some(op)) = (info.str("type"), info.str("targetId"), info.str("openerId")) {
                    if Some(op) == active_tid.as_deref() {
                        // window.open / target=_blank from the tab this session works in: Google's sign-in
                        // button and other OAuth flows finish in that popup, so commands and the panel follow it
                        let (tid, op) = (tid.to_string(), op.to_string());
                        self.later(move |d| d.follow_popup(&tid, &op));
                    }
                }
            }
            return;
        }
        if method == "Target.targetInfoChanged" {
            if let Some(info) = p.obj("targetInfo") {
                let tab = self.st().tabs.values().find(|t| Some(t.target_id.as_str()) == info.str("targetId")).cloned();
                if let (Some(t), Some(title)) = (tab, info.str("title")) {
                    t.s().title = title.into();
                }
            }
            return;
        }
        if method.starts_with("Browser.download") {
            if let Some(g) = p.str("guid") {
                let mut s = self.st();
                let e = s.downloads.entry(g.into()).or_default();
                for (k, v) in p {
                    e.insert(k.clone(), v.clone());
                }
            }
            return;
        }
        let Some(sid) = sid else { return };
        let Some(tab) = self.st().tabs.get(sid).cloned() else { return };
        if method == "Fetch.requestPaused" {
            self.route_paused(&tab, p);
            return;
        }
        let is_active = self.active().is_some_and(|a| Arc::ptr_eq(&a, &tab));
        if method == "Page.screencastFrame" {
            self.cdp.send("Page.screencastFrameAck", obj!({ "sessionId": p.int("sessionId").unwrap_or(0) }), Some(sid));
            let Some(data) = p.str("data").filter(|_| is_active) else { return };
            let meta = p.obj("metadata").cloned().unwrap_or_default();
            tab.s().last_frame = Some((data.to_string(), meta.clone()));
            if let Some(s) = self.stream() {
                s.frame(data, &meta);
            }
            if let Some(r) = self.recorder.lock().unwrap().as_ref() {
                r.frame(data);
            }
            return;
        }
        tab.handle(method, p);
        if is_active && (method == "Page.frameNavigated" || method == "Page.navigatedWithinDocument") {
            if let Some(s) = self.stream() {
                s.url(&tab.url());
            }
        }
    }

    fn route_paused(&self, tab: &Tab, p: &Json) {
        let Some(rid) = p.str("requestId") else { return };
        let url = p.obj("request").and_then(|r| r.str("url")).unwrap_or_default();
        let kind = p.str("resourceType").unwrap_or_default().to_lowercase();
        let pick = {
            let s = self.st();
            s.routes.iter().rev().find(|r| glob_match(&r.pattern, url) && (r.types.is_empty() || r.types.contains(&kind))).map(|r| (r.abort, r.body.clone(), r.allow_origin.clone()))
        };
        let sid = Some(tab.session_id.as_str());
        match pick {
            None => self.cdp.send("Fetch.continueRequest", obj!({ "requestId": rid }), sid),
            Some((true, _, _)) => self.cdp.send("Fetch.failRequest", obj!({ "requestId": rid, "errorReason": "BlockedByClient" }), sid),
            Some((false, body, origin)) => {
                let mut headers = vec![json!({ "name": "Content-Type", "value": "application/json" })];
                if let Some(o) = origin {
                    headers.push(json!({ "name": "Access-Control-Allow-Origin", "value": o }));
                    headers.push(json!({ "name": "Access-Control-Allow-Credentials", "value": "true" }));
                }
                use base64::Engine;
                let b64 = base64::engine::general_purpose::STANDARD.encode(body.unwrap_or_default());
                self.cdp.send("Fetch.fulfillRequest", obj!({ "requestId": rid, "responseCode": 200, "responseHeaders": headers, "body": b64 }), sid);
            }
        }
    }

    // ───────────── tabs ─────────────

    pub fn call(&self, method: &str, params: Json, tab: &Tab) -> Res<Json> {
        self.cdp.call(method, params, Some(&tab.session_id), 30.0)
    }

    pub fn pages(&self) -> Res<Vec<Json>> {
        let r = self.cdp.call("Target.getTargets", Json::new(), None, 30.0)?;
        Ok(r.arr("targetInfos")
            .map(|a| a.iter().filter_map(|x| x.as_object().cloned()).filter(|t| t.str("type") == Some("page") && !t.str("url").unwrap_or_default().starts_with("devtools://")).collect())
            .unwrap_or_default())
    }

    pub fn tab_number(&self, target_id: &str) -> i64 {
        let mut s = self.st();
        if let Some(n) = s.tab_ids.get(target_id) {
            return *n;
        }
        let n = s.next_tab_id;
        s.next_tab_id += 1;
        s.tab_ids.insert(target_id.into(), n);
        n
    }

    pub fn attached(&self, target_id: &str) -> Option<Arc<Tab>> {
        self.st().tabs.values().find(|t| t.target_id == target_id).cloned()
    }

    /// Attach to a page and set it up (domains, init scripts, routes, emulation).
    pub fn attach(&self, target_id: &str) -> Res<Arc<Tab>> {
        if let Some(t) = self.attached(target_id) {
            return Ok(t);
        }
        let r = self.cdp.call("Target.attachToTarget", obj!({ "targetId": target_id, "flatten": true }), None, 30.0)?;
        let sid = r.str("sessionId").ok_or("could not attach to the tab")?.to_string();
        let tab = Arc::new(Tab::new(target_id.into(), sid.clone()));
        self.st().tabs.insert(sid.clone(), tab.clone());
        self.tab_number(target_id);
        for m in ["Page.enable", "Runtime.enable", "Network.enable"] {
            self.call(m, Json::new(), &tab)?;
        }
        self.call("Page.setLifecycleEventsEnabled", obj!({ "enabled": true }), &tab)?;
        if let Ok(tree) = self.call("Page.getFrameTree", Json::new(), &tab) {
            if let Some(f) = tree.obj("frameTree").and_then(|t| t.obj("frame")) {
                let mut s = tab.s();
                s.main_frame_id = f.str("id").map(String::from);
                s.url = f.str("url").unwrap_or_default().into();
                s.loader_id = f.str("loaderId").map(String::from);
            }
        }
        for path in &self.config.init_scripts {
            if let Ok(src) = std::fs::read_to_string(path) {
                let _ = self.call("Page.addScriptToEvaluateOnNewDocument", obj!({ "source": src, "runImmediately": true }), &tab);
            }
        }
        self.apply_settings(&tab)?;
        Ok(tab)
    }

    pub fn apply_settings(&self, tab: &Tab) -> Res<()> {
        let (has_routes, feats, headers, off, vp, fit, geo, ua) = {
            let s = self.st();
            (!s.routes.is_empty(), s.media.clone(), s.extra_headers.clone(), s.offline, s.viewport.clone(), s.fitted.clone(), s.geo.clone(), s.user_agent.clone())
        };
        if has_routes {
            self.call("Fetch.enable", obj!({ "patterns": [{ "urlPattern": "*", "requestStage": "Request" }] }), tab)?;
        } else {
            let _ = self.call("Fetch.disable", Json::new(), tab);
        }
        self.call("Emulation.setEmulatedMedia", obj!({ "features": feats }), tab)?;
        self.call("Network.setExtraHTTPHeaders", obj!({ "headers": headers }), tab)?;
        let conditions = obj!({ "offline": off, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1 });
        if off {
            self.call("Network.emulateNetworkConditions", conditions, tab)?;
        } else {
            let _ = self.call("Network.emulateNetworkConditions", conditions, tab);
        }
        if let Some(vp) = vp {
            self.call("Emulation.setDeviceMetricsOverride", vp, tab)?;
        } else if let Some(fit) = fit {
            let _ = self.call("Emulation.setDeviceMetricsOverride", fit, tab);
        }
        if let Some(g) = geo {
            self.call("Emulation.setGeolocationOverride", g, tab)?;
        }
        if let Some(ua) = ua {
            self.call("Emulation.setUserAgentOverride", obj!({ "userAgent": ua }), tab)?;
        }
        Ok(())
    }

    pub fn apply_all(&self) -> Res<()> {
        let all: Vec<Arc<Tab>> = self.st().tabs.values().cloned().collect();
        for t in all {
            self.apply_settings(&t)?;
        }
        Ok(())
    }

    /// The panel shows the tab in a w×h area: lay the page out at that size (not when the
    /// job set its own viewport or device).
    pub fn fit(&self, w: i64, h: i64) {
        let size = obj!({ "width": w.clamp(320, 3840), "height": h.clamp(200, 3840), "deviceScaleFactor": 1, "mobile": false });
        let (own, same, all) = {
            let mut s = self.st();
            let same = s.fitted.as_ref().is_some_and(|f| f.int("width") == size.int("width") && f.int("height") == size.int("height"));
            s.fitted = Some(size.clone());
            (s.viewport.is_some(), same, s.tabs.values().filter(|t| !t.gone()).cloned().collect::<Vec<_>>())
        };
        if own || same {
            return;
        }
        for t in all {
            let _ = self.cdp.call("Emulation.setDeviceMetricsOverride", size.clone(), Some(&t.session_id), 5.0);
        }
    }

    /// Nobody watches any more: back to the browser's own size.
    pub fn unfit(&self) {
        let (was, own, all) = {
            let mut s = self.st();
            let was = s.fitted.take().is_some();
            (was, s.viewport.is_some(), s.tabs.values().filter(|t| !t.gone()).cloned().collect::<Vec<_>>())
        };
        if !was || own {
            return;
        }
        for t in all {
            let _ = self.cdp.call("Emulation.clearDeviceMetricsOverride", Json::new(), Some(&t.session_id), 5.0);
        }
    }

    pub fn make_active(&self, tab: &Arc<Tab>) {
        let changed = {
            let mut s = self.st();
            let changed = !s.active.as_ref().is_some_and(|a| Arc::ptr_eq(a, tab));
            s.active = Some(tab.clone());
            changed
        };
        if self.config.pin {
            let tid = tab.target_id.clone();
            update_state(&self.config.session, |st| {
                st.insert("targetId".into(), Value::String(tid));
            });
        }
        if changed {
            if let Some(s) = self.stream() {
                s.tab_changed();
            }
        }
    }

    fn follow_popup(&self, target_id: &str, opener: &str) {
        let Some(from) = self.active() else { return };
        if from.target_id != opener || from.gone() {
            return;
        }
        let Ok(tab) = self.attach(target_id) else { return };
        self.st().openers.insert(target_id.into(), opener.into());
        self.make_active(&tab);
        sleep_ms(300.0);
        let _ = self.wait_lifecycle(&tab, None, "domcontentloaded", 8000.0, None);
        let url = tab.url();
        let (o, t) = (self.tab_number(opener), self.tab_number(target_id));
        self.st().tab_note = Some(format!("→ t{o} opened a popup, t{t} {url}; commands now act on it (take a fresh snapshot). When it closes they go back to t{o}."));
    }

    fn popup_closed(&self, popup: &Arc<Tab>, opener: &str) {
        self.st().openers.remove(&popup.target_id);
        if !self.active().is_some_and(|a| Arc::ptr_eq(&a, popup)) {
            return;
        }
        if let Some(back) = self.attached(opener).filter(|b| !b.gone()) {
            self.make_active(&back);
            self.st().tab_note = Some(format!("→ the popup closed; commands act on t{} again (take a fresh snapshot).", self.tab_number(opener)));
            return;
        }
        if let Some(s) = self.stream() {
            s.tab_changed();
        }
        if self.config.pin {
            update_state(&self.config.session, |st| {
                st.remove("targetId");
            });
        }
    }

    pub fn new_tab(&self, url: &str) -> Res<Arc<Tab>> {
        let r = self.cdp.call("Target.createTarget", obj!({ "url": "about:blank", "background": true }), None, 30.0)?;
        let tid = r.str("targetId").ok_or("could not open a tab")?.to_string();
        let tab = self.attach(&tid)?;
        self.make_active(&tab);
        if url != "about:blank" {
            self.navigate(&tab, url, "load", 25000.0)?;
        }
        Ok(tab)
    }

    /// The tab commands act on. A pinned session keeps its own tab across daemons;
    /// one whose tab was closed while it ran says so (tab_gone).
    pub fn tab(&self) -> Res<Arc<Tab>> {
        if let Some(a) = self.active() {
            if a.gone() {
                return Err("tab_gone: this session's tab was closed. Run `ondra-browser tab new <url>` to open a new one.".into());
            }
            return Ok(a);
        }
        let list = self.pages()?;
        if self.config.pin {
            if let Some(tid) = read_state(&self.config.session).str("targetId").map(String::from) {
                if list.iter().any(|p| p.str("targetId") == Some(tid.as_str())) {
                    let t = self.attach(&tid)?;
                    self.make_active(&t);
                    return Ok(t);
                }
            }
            return self.new_tab("about:blank");
        }
        if let Some(tid) = list.first().and_then(|p| p.str("targetId")) {
            let t = self.attach(tid)?;
            self.make_active(&t);
            return Ok(t);
        }
        self.new_tab("about:blank")
    }

    // ───────────── page helpers ─────────────

    pub fn navigate(&self, tab: &Tab, url: &str, wait_until: &str, timeout_ms: f64) -> Res<Json> {
        let mut target = url.to_string();
        if !target.contains("://") && !target.starts_with("about:") && !target.starts_with("data:") && !target.starts_with("javascript:") {
            target = if target.starts_with("localhost") || target.starts_with("127.") { format!("http://{target}") } else { format!("https://{target}") };
        }
        let before = tab.s().navigations;
        let r = self.cdp.call("Page.navigate", obj!({ "url": target }), Some(&tab.session_id), timeout_ms / 1000.0 + 5.0)?;
        if let Some(e) = r.str("errorText").filter(|e| !e.is_empty() && *e != "net::ERR_ABORTED") {
            return Err(format!("{e} at {target}"));
        }
        if let Some(loader) = r.str("loaderId") {
            self.wait_lifecycle(tab, Some(loader), wait_until, timeout_ms, Some(before))?;
        }
        self.page_info(tab)
    }

    /// Wait for a lifecycle event of the page's load. A redirect or a script that navigates
    /// again starts a new loader: then the newest one counts. `navigated_from` (the count of
    /// navigations before ours) lets the document's readyState answer too, once a new
    /// document is in.
    pub fn wait_lifecycle(&self, tab: &Tab, loader: Option<&str>, until: &str, timeout_ms: f64, navigated_from: Option<i64>) -> Res<()> {
        let name = match until.to_lowercase().as_str() {
            "domcontentloaded" | "dom" => "DOMContentLoaded",
            "networkidle" | "idle" => "networkIdle",
            "commit" | "none" => return Ok(()),
            _ => "load",
        };
        let mut tick = 0;
        poll(timeout_ms, 50.0, &format!("{until} of the page"), || {
            if tab.gone() {
                return Err("tab_gone: the tab closed while loading".into());
            }
            let (seen, navigated) = {
                let s = tab.s();
                let has = |l: Option<&str>| -> bool {
                    let Some(set) = l.and_then(|l| s.lifecycle.get(l)) else { return false };
                    set.contains(name) || (name == "networkIdle" && set.contains("networkAlmostIdle") && s.inflight.is_empty())
                };
                let navigated = navigated_from.is_none_or(|n| s.navigations > n);
                // the newest loader counts only once a new document came in after ours
                let followed = loader.is_some() && navigated && s.loader_id.as_deref() != loader && has(s.loader_id.as_deref());
                (has(loader.or(s.loader_id.as_deref())) || followed, navigated)
            };
            if seen {
                return Ok(Some(()));
            }
            tick += 1;
            if navigated && name != "networkIdle" && tick % 10 == 0 {
                let state = self.eval_value_t(tab, "document.readyState", 5.0).ok();
                let state = state.as_ref().and_then(|v| v.as_str()).unwrap_or_default();
                if state == "complete" || (name == "DOMContentLoaded" && state == "interactive") {
                    return Ok(Some(()));
                }
            }
            Ok(None)
        })
    }

    pub fn page_info(&self, tab: &Tab) -> Res<Json> {
        let v = self.eval_value(tab, "({url: location.href, title: document.title})")?;
        let v = v.as_object().cloned().unwrap_or_default();
        let url = v.str("url").map(String::from).unwrap_or_else(|| tab.url());
        let title = v.str("title").unwrap_or_default().to_string();
        {
            let mut s = tab.s();
            s.url = url.clone();
            if v.str("title").is_some() {
                s.title = title.clone();
            }
        }
        Ok(obj!({ "url": url, "title": title }))
    }

    pub fn eval_value(&self, tab: &Tab, expr: &str) -> Res<Value> {
        self.eval_value_t(tab, expr, 30.0)
    }

    /// Run JS in the page; the value (by value), or an error with the page's message.
    pub fn eval_value_t(&self, tab: &Tab, expr: &str, timeout: f64) -> Res<Value> {
        let r = self.cdp.call(
            "Runtime.evaluate",
            obj!({ "expression": expr, "returnByValue": true, "awaitPromise": true, "userGesture": true, "allowUnsafeEvalBlockedByCSP": true }),
            Some(&tab.session_id),
            timeout,
        )?;
        if let Some(ex) = r.obj("exceptionDetails") {
            return Err(exception_text(ex));
        }
        Ok(value_of(r.obj("result").unwrap_or(&Json::new())))
    }

    /// Call `f` (a JS function source taking the element) on a remote object.
    pub fn call_on(&self, tab: &Tab, object_id: &str, f: &str, args: Vec<Value>, by_value: bool) -> Res<Json> {
        let args: Vec<Value> = args.into_iter().map(|v| json!({ "value": v })).collect();
        let r = self.call(
            "Runtime.callFunctionOn",
            obj!({ "objectId": object_id, "functionDeclaration": f, "arguments": args, "returnByValue": by_value, "awaitPromise": true, "userGesture": true }),
            tab,
        )?;
        if let Some(ex) = r.obj("exceptionDetails") {
            return Err(exception_text(ex));
        }
        Ok(r.obj("result").cloned().unwrap_or_default())
    }

    /// A function's value on an element (`call_on` by value).
    pub fn on(&self, tab: &Tab, el: &str, f: &str) -> Res<Value> {
        Ok(self.call_on(tab, el, f, vec![], true)?.get("value").cloned().unwrap_or(Value::Null))
    }

    // ───────────── requests ─────────────

    pub fn handle(&self, req: Request) -> Value {
        let key = req.args.iter().take(2).cloned().collect::<Vec<_>>().join(" ");
        // commands that only report never wait behind a running one
        if key == "stream status" || key == "session info" {
            return self.respond(&req);
        }
        let _g = self.q.lock().unwrap_or_else(|e| e.into_inner());
        self.touch();
        let r = self.respond(&req);
        self.touch();
        r
    }

    fn respond(&self, req: &Request) -> Value {
        if req.args.first().map(String::as_str) == Some("batch") {
            return self.run_batch(req);
        }
        match self.run(&req.args, req) {
            Ok(o) => {
                let mut text = o.text;
                if let Some(n) = self.st().tab_note.take() {
                    text += &format!("\n{n}");
                }
                json!({ "success": true, "data": o.data, "text": text })
            }
            Err(e) => json!({ "success": false, "error": e }),
        }
    }

    fn run_batch(&self, req: &Request) -> Value {
        let mut bail = false;
        let mut cmds: Vec<Vec<String>> = Vec::new();
        for a in req.args.iter().skip(1) {
            match a.as_str() {
                "--bail" => bail = true,
                "--json" | "--omit-command" => {}
                _ => cmds.push(shell_split(a)),
            }
        }
        if cmds.is_empty() {
            if let Some(s) = req.stdin.as_deref().filter(|s| !s.trim().is_empty()) {
                let Ok(Value::Array(list)) = serde_json::from_str::<Value>(s) else {
                    return json!({ "success": false, "error": "batch: stdin must be a JSON array of commands" });
                };
                for item in list {
                    match item {
                        Value::Array(a) => cmds.push(a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()),
                        Value::String(s) => cmds.push(shell_split(&s)),
                        _ => {}
                    }
                }
            }
        }
        let (mut rows, mut texts, mut all_ok) = (Vec::new(), Vec::new(), true);
        for c in cmds {
            match self.run(&c, req) {
                Ok(o) => {
                    rows.push(json!({ "command": c, "success": true, "result": o.data, "error": null }));
                    texts.push(o.text);
                }
                Err(e) => {
                    all_ok = false;
                    texts.push(format!("✗ {e}"));
                    rows.push(json!({ "command": c, "success": false, "result": null, "error": e }));
                    if bail {
                        break;
                    }
                }
            }
        }
        json!({ "success": all_ok, "data": rows, "text": texts.join("\n"), "batch": true })
    }
}

pub fn exception_text(ex: &Json) -> String {
    ex.obj("exception").and_then(|e| e.str("description")).or(ex.str("text")).unwrap_or("the script failed").to_string()
}

pub fn value_of(o: &Json) -> Value {
    if let Some(v) = o.get("value") {
        return v.clone();
    }
    if let Some(u) = o.str("unserializableValue") {
        return Value::String(u.into());
    }
    if o.str("type") == Some("undefined") {
        return Value::Null;
    }
    o.str("description").map(|d| Value::String(d.into())).unwrap_or(Value::Null)
}

/// Stop a process we started: politely first, then for good.
pub fn terminate(c: &mut Child) {
    #[cfg(unix)]
    {
        unsafe { libc::kill(c.id() as i32, libc::SIGTERM) };
        let until = now_ms() + 3000.0;
        while now_ms() < until {
            if matches!(c.try_wait(), Ok(Some(_))) {
                return;
            }
            sleep_ms(50.0);
        }
    }
    let _ = c.kill();
    let _ = c.wait();
}

// ───────────── a browser of its own (no shared one given) ─────────────

fn chrome_path(config: &Config) -> Option<PathBuf> {
    let mut options: Vec<PathBuf> = config.executable.iter().map(PathBuf::from).collect();
    #[cfg(target_os = "macos")]
    options.extend(
        ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]
            .map(PathBuf::from),
    );
    #[cfg(target_os = "linux")]
    options.extend(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].iter().filter_map(|n| which(n)));
    #[cfg(windows)]
    for (var, rel) in [
        ("ProgramFiles", r"Google\Chrome\Application\chrome.exe"),
        ("ProgramFiles(x86)", r"Google\Chrome\Application\chrome.exe"),
        ("LOCALAPPDATA", r"Google\Chrome\Application\chrome.exe"),
        ("ProgramFiles(x86)", r"Microsoft\Edge\Application\msedge.exe"),
        ("ProgramFiles", r"Microsoft\Edge\Application\msedge.exe"),
    ] {
        if let Some(base) = std::env::var_os(var) {
            options.push(PathBuf::from(base).join(rel));
        }
    }
    options.into_iter().find(|p| p.is_file())
}

/// Chrome for Testing's headless shell: headless already, and it takes no `--headless`.
pub fn is_headless_shell(exe: &std::path::Path) -> bool {
    exe.file_stem().is_some_and(|s| s == "chrome-headless-shell")
}

fn launch_chrome(config: &Config) -> Res<(Child, u16, PathBuf)> {
    let exe = chrome_path(config).ok_or("No Chrome found: set ONDRA_BROWSER_EXECUTABLE_PATH or ONDRA_BROWSER_CDP")?;
    let profile = base_dir().join(format!("{}-profile", safe_name(&config.session)));
    let _ = std::fs::remove_dir_all(&profile);
    std::fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let mut cmd = quiet_command(&exe);
    cmd.arg(format!("--user-data-dir={}", profile.display())).args([
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        "--use-mock-keychain",
        "--password-store=basic",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--window-size=1280,800",
    ]);
    if !is_headless_shell(&exe) {
        cmd.arg("--headless=new");
    }
    cmd.arg("about:blank").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("could not start Chrome: {e}"))?;
    let file = profile.join("DevToolsActivePort");
    let port = poll(20000.0, 100.0, "Chrome to start", || {
        if !matches!(child.try_wait(), Ok(None)) {
            return Err("Chrome exited right after starting".into());
        }
        Ok(std::fs::read_to_string(&file).ok().and_then(|t| t.lines().next().and_then(|l| l.trim().parse::<u16>().ok())))
    });
    match port {
        Ok(p) => Ok((child, p, profile)),
        Err(e) => {
            let _ = child.kill();
            Err(e)
        }
    }
}
