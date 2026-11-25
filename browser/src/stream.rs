// The session's tab, live: a WebSocket server on 127.0.0.1 that sends screencast frames
// and takes mouse/keyboard input, and the recorder that turns the same frames into a video.
//
// Server → client:  {"type":"frame","data":<jpeg base64>,"metadata":{deviceWidth,deviceHeight,…}}
//                   {"type":"url","url":…}
// Client → server:  {"type":"input_mouse","eventType":"mousePressed",x,y,button,clickCount}
//                   {"type":"viewport","width":…,"height":…}: lay the page out at the viewer's size
//                   {"type":"input_keyboard","eventType":"keyDown",key,code,text,modifiers}
//                   {"type":"input_touch","eventType":"touchStart",touchPoints:[{x,y}]}
// `ws://127.0.0.1:<port>/?maxFps=10` caps the frames one client gets.

use crate::commands::{err, Args};
use crate::daemon::{Daemon, Outcome, Request};
use crate::util::*;
use base64::Engine;
use serde_json::json;
use std::io::Write;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tungstenite::handshake::server::{Request as HsRequest, Response as HsResponse};
use tungstenite::protocol::Role;
use tungstenite::{Message, WebSocket};

pub struct WsClient {
    writer: Mutex<WebSocket<TcpStream>>,
    raw: TcpStream,
    max_fps: f64,
    last_sent: Mutex<f64>,
    pending: Mutex<Option<String>>,
    alive: AtomicBool,
}

impl WsClient {
    fn send(&self, text: &str) {
        if !self.alive.load(Ordering::SeqCst) {
            return;
        }
        let mut w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
        if w.send(Message::text(text.to_string())).is_err() {
            self.alive.store(false, Ordering::SeqCst);
        }
    }

    fn close(&self) {
        if self.alive.swap(false, Ordering::SeqCst) {
            let _ = self.raw.shutdown(Shutdown::Both);
        }
    }
}

pub struct StreamServer {
    daemon: Weak<Daemon>,
    pub port: u16,
    clients: Mutex<Vec<Arc<WsClient>>>,
    /// CDP session id of the tab being screencast
    casting_on: Mutex<Option<String>>,
    stopped: AtomicBool,
}

impl StreamServer {
    pub fn start(daemon: &Arc<Daemon>, port: u16) -> Res<Arc<StreamServer>> {
        let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|_| format!("stream: cannot listen on port {port}"))?;
        let port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let s = Arc::new(StreamServer {
            daemon: Arc::downgrade(daemon),
            port,
            clients: Mutex::new(Vec::new()),
            casting_on: Mutex::new(None),
            stopped: AtomicBool::new(false),
        });
        let me = s.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if me.stopped.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(c) = conn else { continue };
                let _ = c.set_nodelay(true);
                let me = me.clone();
                std::thread::spawn(move || me.serve(c));
            }
        });
        let me = Arc::downgrade(&s);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(50));
            let Some(s) = me.upgrade() else { return };
            if s.stopped.load(Ordering::SeqCst) {
                return;
            }
            s.flush();
        });
        Ok(s)
    }

    pub fn client_count(&self) -> usize {
        self.clients.lock().unwrap().len()
    }

    fn all(&self) -> Vec<Arc<WsClient>> {
        self.clients.lock().unwrap().clone()
    }

    pub fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        let all = std::mem::take(&mut *self.clients.lock().unwrap());
        for c in all {
            c.close();
        }
        // wake the accept loop so it lets go of the port
        let _ = TcpStream::connect_timeout(&([127, 0, 0, 1], self.port).into(), Duration::from_millis(500));
        self.update_casting(false);
    }

    // ───────────── one client ─────────────

    fn serve(self: Arc<Self>, stream: TcpStream) {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let mut target = String::from("/");
        let ws = tungstenite::accept_hdr(stream, |req: &HsRequest, resp: HsResponse| {
            target = req.uri().to_string();
            Ok(resp)
        });
        let Ok(mut reader) = ws else { return };
        let _ = reader.get_ref().set_read_timeout(None);
        let fps = target.split_once('?').map(|(_, q)| q).unwrap_or_default().split('&').find_map(|kv| kv.strip_prefix("maxFps=")).and_then(|v| v.parse::<f64>().ok()).unwrap_or(10.0);
        let (Ok(raw), Ok(w)) = (reader.get_ref().try_clone(), reader.get_ref().try_clone()) else { return };
        let client = Arc::new(WsClient {
            writer: Mutex::new(WebSocket::from_raw_socket(w, Role::Server, None)),
            raw,
            max_fps: fps.clamp(0.5, 60.0),
            last_sent: Mutex::new(0.0),
            pending: Mutex::new(None),
            alive: AtomicBool::new(true),
        });
        {
            let mut cs = self.clients.lock().unwrap();
            if self.stopped.load(Ordering::SeqCst) {
                return;
            }
            cs.push(client.clone());
        }
        self.welcome(&client);
        self.update_casting(false);
        while client.alive.load(Ordering::SeqCst) {
            match reader.read() {
                Ok(Message::Text(t)) => self.input(t.as_str()),
                Ok(Message::Binary(b)) => self.input(&String::from_utf8_lossy(&b)),
                Ok(Message::Close(_)) | Err(_) => break,
                Ok(_) => {}
            }
        }
        client.close();
        let left = {
            let mut cs = self.clients.lock().unwrap();
            cs.retain(|c| !Arc::ptr_eq(c, &client));
            cs.is_empty()
        };
        self.update_casting(false);
        if left {
            if let Some(d) = self.daemon.upgrade() {
                std::thread::spawn(move || d.unfit());
            }
        }
    }

    /// A new viewer sees the page at once: its address and a picture (headless Chrome only
    /// sends a frame when something changes).
    fn welcome(&self, c: &Arc<WsClient>) {
        let Some(d) = self.daemon.upgrade() else { return };
        let Some(tab) = d.active().filter(|t| !t.gone()) else { return };
        c.send(&json_string(&json!({ "type": "url", "url": tab.url() })));
        let last = tab.s().last_frame.clone();
        if let Some((data, meta)) = last {
            c.send(&json_string(&json!({ "type": "frame", "data": data, "metadata": meta })));
            *c.last_sent.lock().unwrap() = now_ms();
            return;
        }
        let c = c.clone();
        std::thread::spawn(move || {
            let Ok(r) = d.cdp.call("Page.captureScreenshot", obj!({ "format": "jpeg", "quality": 70 }), Some(&tab.session_id), 10.0) else { return };
            let Some(data) = r.str("data") else { return };
            let m = d.cdp.call("Page.getLayoutMetrics", Json::new(), Some(&tab.session_id), 5.0).unwrap_or_default();
            let v = m.obj("cssVisualViewport").or(m.obj("visualViewport")).cloned().unwrap_or_default();
            let meta = json!({ "deviceWidth": v.dbl("clientWidth").unwrap_or(1280.0), "deviceHeight": v.dbl("clientHeight").unwrap_or(800.0), "pageScaleFactor": 1, "offsetTop": 0, "scrollOffsetX": v.dbl("pageX").unwrap_or(0.0), "scrollOffsetY": v.dbl("pageY").unwrap_or(0.0) });
            c.send(&json_string(&json!({ "type": "frame", "data": data, "metadata": meta })));
        });
    }

    fn input(&self, text: &str) {
        let Some(d) = self.daemon.upgrade() else { return };
        let Some(tab) = d.active().filter(|t| !t.gone()) else { return };
        let Ok(m) = serde_json::from_str::<Json>(text) else { return };
        d.touch();
        let sid = Some(tab.session_id.as_str());
        match m.str("type") {
            Some("input_mouse") => {
                let kind = m.str("eventType").unwrap_or("mouseMoved");
                let mut p = obj!({ "type": kind, "x": m.dbl("x").unwrap_or(0.0), "y": m.dbl("y").unwrap_or(0.0), "button": m.str("button").unwrap_or("none"), "clickCount": m.int("clickCount").unwrap_or(0), "modifiers": m.int("modifiers").unwrap_or(0) });
                if let Some(dx) = m.dbl("deltaX") {
                    p.insert("deltaX".into(), json!(dx));
                }
                if let Some(dy) = m.dbl("deltaY") {
                    p.insert("deltaY".into(), json!(dy));
                }
                if kind == "mousePressed" {
                    p.insert("buttons".into(), json!(1));
                }
                d.cdp.send("Input.dispatchMouseEvent", p, sid);
            }
            Some("input_keyboard") => {
                let mut p = obj!({ "type": m.str("eventType").unwrap_or("keyDown"), "modifiers": m.int("modifiers").unwrap_or(0) });
                for k in ["key", "code", "text"] {
                    if let Some(v) = m.str(k) {
                        p.insert(k.into(), json!(v));
                    }
                }
                if let Some(kc) = m.int("keyCode").or(m.int("windowsVirtualKeyCode")) {
                    p.insert("windowsVirtualKeyCode".into(), json!(kc));
                }
                d.cdp.send("Input.dispatchKeyEvent", p, sid);
            }
            Some("input_touch") => {
                d.cdp.send("Input.dispatchTouchEvent", obj!({ "type": m.str("eventType").unwrap_or("touchStart"), "touchPoints": m.get("touchPoints").cloned().unwrap_or(json!([])) }), sid);
            }
            Some("viewport") => {
                // the panel's page area, so the page fills it (Daemon::fit)
                if let (Some(w), Some(h)) = (m.int("width"), m.int("height")) {
                    std::thread::spawn(move || d.fit(w, h));
                }
            }
            _ => {}
        }
    }

    // ───────────── frames ─────────────

    pub fn frame(&self, data: &str, meta: &Json) {
        let msg = json_string(&json!({ "type": "frame", "data": data, "metadata": meta }));
        let now = now_ms();
        for c in self.all() {
            let mut last = c.last_sent.lock().unwrap();
            if now - *last >= 1000.0 / c.max_fps {
                *last = now;
                drop(last);
                *c.pending.lock().unwrap() = None;
                c.send(&msg);
            } else {
                *c.pending.lock().unwrap() = Some(msg.clone());
            }
        }
    }

    /// The last frame a client skipped for its cap goes out when its turn comes, so a
    /// page that stops changing is shown as it ended.
    fn flush(&self) {
        let now = now_ms();
        for c in self.all() {
            let mut last = c.last_sent.lock().unwrap();
            if now - *last < 1000.0 / c.max_fps {
                continue;
            }
            let Some(p) = c.pending.lock().unwrap().take() else { continue };
            *last = now;
            drop(last);
            c.send(&p);
        }
    }

    pub fn url(&self, u: &str) {
        let msg = json_string(&json!({ "type": "url", "url": u }));
        for c in self.all() {
            c.send(&msg);
        }
    }

    pub fn tab_changed(&self) {
        self.update_casting(true);
        if let Some(t) = self.daemon.upgrade().and_then(|d| d.active()).filter(|t| !t.gone()) {
            self.url(&t.url());
        }
    }

    /// Screencast the active tab while anyone watches or records; stop otherwise.
    pub fn update_casting(&self, force: bool) {
        let Some(d) = self.daemon.upgrade() else { return };
        let recording = d.recorder.lock().unwrap_or_else(|e| e.into_inner()).is_some();
        let want = (self.client_count() > 0 || recording) && !self.stopped.load(Ordering::SeqCst);
        let tab = d.active().filter(|t| !t.gone());
        let target = if want { tab.as_ref().map(|t| t.session_id.clone()) } else { None };
        let current = std::mem::replace(&mut *self.casting_on.lock().unwrap(), target.clone());
        if current == target && !force {
            return;
        }
        if let Some(cur) = current.as_ref().filter(|c| Some(*c) != target.as_ref()) {
            d.cdp.send("Page.stopScreencast", Json::new(), Some(cur));
            if let Some(t) = d.st().tabs.get(cur).cloned() {
                t.s().screencasting = false;
            }
        }
        if let (Some(target), Some(tab)) = (&target, &tab) {
            d.cdp.send("Page.startScreencast", obj!({ "format": "jpeg", "quality": 75, "maxWidth": 1600, "maxHeight": 1200, "everyNthFrame": 1 }), Some(target));
            tab.s().screencasting = true;
            if current.as_ref() != Some(target) && self.client_count() > 0 {
                for c in self.all() {
                    self.welcome(&c);
                }
            }
        }
    }
}

// ───────────── recording ─────────────

const FPS: u64 = 10;

pub struct Recorder {
    pub path: String,
    proc: Mutex<Child>,
    input: Arc<Mutex<Option<ChildStdin>>>,
    latest: Arc<Mutex<Option<Vec<u8>>>>,
    frames: Arc<AtomicUsize>,
    stopped: Arc<AtomicBool>,
}

fn encoders(ffmpeg: &std::path::Path) -> String {
    quiet_command(ffmpeg).args(["-hide_banner", "-encoders"]).stderr(Stdio::null()).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
}

impl Recorder {
    pub fn new(path: &str) -> Res<Recorder> {
        let install = if cfg!(windows) {
            "winget install ffmpeg"
        } else if cfg!(target_os = "macos") {
            "brew install ffmpeg"
        } else {
            "install the ffmpeg package"
        };
        let Some(ffmpeg) = which("ffmpeg") else { return err(format!("recording needs ffmpeg on PATH ({install})")) };
        let ext = std::path::Path::new(path).extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
        let enc = encoders(&ffmpeg);
        let codec: Vec<&str> = match ext.as_str() {
            "webm" => {
                if enc.contains("libvpx-vp9") {
                    vec!["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1"]
                } else if enc.contains("libvpx") {
                    vec!["-c:v", "libvpx", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "8"]
                } else {
                    return err("this ffmpeg cannot write .webm (no libvpx); record to .mp4 instead");
                }
            }
            "mp4" | "mov" | "m4v" => {
                if enc.contains("libx264") {
                    vec!["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
                } else {
                    vec!["-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
                }
            }
            _ => return err("record to a .webm or .mp4 file"),
        };
        if let Some(dir) = std::path::Path::new(path).parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let fps = FPS.to_string();
        let mut args: Vec<&str> = vec!["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", &fps, "-c:v", "mjpeg", "-i", "-", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-r", &fps];
        args.extend(codec);
        args.push(path);
        let mut child = quiet_command(&ffmpeg).args(&args).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
        let r = Recorder {
            path: path.into(),
            input: Arc::new(Mutex::new(child.stdin.take())),
            proc: Mutex::new(child),
            latest: Arc::new(Mutex::new(None)),
            frames: Arc::new(AtomicUsize::new(0)),
            stopped: Arc::new(AtomicBool::new(false)),
        };
        let (input, latest, frames, stopped) = (r.input.clone(), r.latest.clone(), r.frames.clone(), r.stopped.clone());
        // one frame per tick, the latest again when nothing changed: the video keeps real time
        std::thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let f = latest.lock().unwrap().clone();
                if let Some(f) = f {
                    let mut i = input.lock().unwrap();
                    let Some(w) = i.as_mut() else { return };
                    if w.write_all(&f).is_err() {
                        return;
                    }
                    frames.fetch_add(1, Ordering::SeqCst);
                }
                std::thread::sleep(Duration::from_millis(1000 / FPS));
            }
        });
        Ok(r)
    }

    pub fn frame(&self, b64: &str) {
        if let Ok(d) = base64::engine::general_purpose::STANDARD.decode(b64) {
            *self.latest.lock().unwrap() = Some(d);
        }
    }

    /// Finish the file. Seconds recorded, and whether ffmpeg wrote it.
    pub fn stop(&self) -> (f64, bool) {
        self.stopped.store(true, Ordering::SeqCst);
        self.input.lock().unwrap().take();
        let mut p = self.proc.lock().unwrap();
        let until = now_ms() + 60000.0;
        let mut ok = false;
        while now_ms() < until {
            if let Ok(Some(s)) = p.try_wait() {
                ok = s.success();
                break;
            }
            sleep_ms(50.0);
        }
        if !ok && matches!(p.try_wait(), Ok(None)) {
            let _ = p.kill();
        }
        (self.frames.load(Ordering::SeqCst) as f64 / FPS as f64, ok)
    }
}

impl Daemon {
    pub fn record(&self, a: &Args, req: &Request) -> Res<Outcome> {
        match a.pos(0).unwrap_or_default() {
            "start" => {
                let Some(f) = a.pos(1) else { return err("usage: record start <file.webm|file.mp4> [url]") };
                if self.recorder.lock().unwrap().is_some() {
                    return err("already recording; record stop first");
                }
                let t = self.tab()?;
                let file = absolute_path(f, &req.cwd);
                let r = Recorder::new(&file)?;
                // the page as it is now is the first frame
                if let Ok(shot) = self.call("Page.captureScreenshot", obj!({ "format": "jpeg", "quality": 80 }), &t) {
                    if let Some(d) = shot.str("data") {
                        r.frame(d);
                    }
                }
                *self.recorder.lock().unwrap() = Some(r);
                if self.stream().is_none() {
                    if let Ok(s) = StreamServer::start(&self.arc(), 0) {
                        *self.stream.lock().unwrap() = Some(s);
                    }
                }
                if let Some(s) = self.stream() {
                    s.update_casting(true);
                }
                if let Some(u) = a.pos(2) {
                    self.navigate(&t, u, "load", 25000.0)?;
                }
                Ok(Outcome::new(json!({ "path": file }), format!("✓ Recording to {file}")))
            }
            "stop" => {
                let Some(r) = self.recorder.lock().unwrap().take() else { return err("not recording") };
                if let Some(s) = self.stream() {
                    s.update_casting(false);
                }
                let (secs, ok) = r.stop();
                if !ok || !std::path::Path::new(&r.path).exists() {
                    return err(format!("ffmpeg could not write {}", r.path));
                }
                Ok(Outcome::new(json!({ "path": r.path, "seconds": secs }), format!("✓ Saved {} ({secs:.1} s)", r.path)))
            }
            _ => err("usage: record start <file> [url] | record stop"),
        }
    }
}
