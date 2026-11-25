// Every command a session runs.

use crate::daemon::{Daemon, Outcome, Request, Route};
use crate::snapshot::SnapOptions;
use crate::tab::Tab;
use crate::util::*;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Options pulled out of a command's words: `--flag value`, `--flag`, and the rest in order.
#[derive(Default)]
pub struct Args {
    pub pos: Vec<String>,
    pub opts: HashMap<String, String>,
    pub flags: HashSet<String>,
}

const VALUED: &[&str] = &[
    "wait-until", "selector", "depth", "timeout", "load", "text", "url", "fn", "state", "name", "type", "method", "status", "filter", "body", "allow-origin", "resource-type", "domain", "path", "same-site", "expires",
    "credential-provider", "item", "username-selector", "password-selector", "submit-selector", "username", "port", "index", "frame", "exact-name", "quality", "format",
];

fn short(w: &str) -> Option<&'static str> {
    Some(match w {
        "-c" => "compact",
        "-i" => "interactive",
        "-s" => "selector",
        "-u" => "urls",
        "-d" => "depth",
        "-f" => "full",
        "-n" => "name",
        _ => return None,
    })
}

impl Args {
    /// `VALUED` names take the next word as their value.
    pub fn new(words: &[String]) -> Args {
        let mut a = Args::default();
        let mut i = 0;
        while i < words.len() {
            let w = &words[i];
            if w.starts_with("--") && w.chars().count() > 2 {
                let name = &w[2..];
                if let Some((k, v)) = name.split_once('=') {
                    a.opts.insert(k.into(), v.into());
                    i += 1;
                    continue;
                }
                if VALUED.contains(&name) && i + 1 < words.len() {
                    a.opts.insert(name.into(), words[i + 1].clone());
                    i += 2;
                    continue;
                }
                a.flags.insert(name.into());
            } else if w.starts_with('-') && w.chars().count() == 2 && w.parse::<i64>().is_err() && short(w).is_some() {
                let s = short(w).unwrap();
                if VALUED.contains(&s) && i + 1 < words.len() {
                    a.opts.insert(s.into(), words[i + 1].clone());
                    i += 2;
                    continue;
                }
                a.flags.insert(s.into());
            } else {
                a.pos.push(w.clone());
            }
            i += 1;
        }
        a
    }

    pub fn has(&self, f: &str) -> bool {
        self.flags.contains(f)
    }
    pub fn get(&self, k: &str) -> Option<&str> {
        self.opts.get(k).map(String::as_str)
    }
    pub fn ms(&self, k: &str, def: f64) -> f64 {
        self.get(k).and_then(|v| v.parse().ok()).unwrap_or(def)
    }
    pub fn pos(&self, i: usize) -> Option<&str> {
        self.pos.get(i).map(String::as_str)
    }
    pub fn rest(&self, from: usize) -> String {
        self.pos.iter().skip(from).cloned().collect::<Vec<_>>().join(" ")
    }
}

pub fn err<T>(s: impl Into<String>) -> Res<T> {
    Err(s.into())
}

fn nav_outcome(info: Json) -> Outcome {
    let text = format!("✓ {}\n  {}", info.str("title").unwrap_or_default(), info.str("url").unwrap_or_default());
    Outcome::new(Value::Object(info), text)
}

/// Swift's `"\(double)"`: whole numbers keep one decimal place.
pub fn num(v: f64) -> String {
    if v.is_finite() && v == v.trunc() && v.abs() < 1e15 {
        format!("{v:.1}")
    } else {
        format!("{v}")
    }
}

/// A JSON value as the Swift tool prints it for people: strings bare, the rest as JSON.
pub fn plain(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        v => json_string(v),
    }
}

impl Daemon {
    pub fn run(&self, words: &[String], req: &Request) -> Res<Outcome> {
        let Some(cmd) = words.first().map(String::as_str) else { return err("no command") };
        let a = Args::new(&words[1..]);
        match cmd {
            "open" | "goto" | "navigate" => {
                let Some(url) = a.pos(0) else { return err("usage: open <url>") };
                let t = self.tab()?;
                let info = self.navigate(&t, url, a.get("wait-until").unwrap_or("load"), a.ms("timeout", 25000.0))?;
                Ok(nav_outcome(info))
            }
            "back" | "forward" => {
                let t = self.tab()?;
                let h = self.call("Page.getNavigationHistory", Json::new(), &t)?;
                let i = h.int("currentIndex").unwrap_or(0) + if cmd == "back" { -1 } else { 1 };
                let entries = h.arr("entries").cloned().unwrap_or_default();
                let id = (i >= 0).then(|| entries.get(i as usize)).flatten().and_then(|e| e.as_object()).and_then(|e| e.int("id"));
                let Some(id) = id else { return err(format!("no page to go {cmd} to")) };
                self.call("Page.navigateToHistoryEntry", obj!({ "entryId": id }), &t)?;
                sleep_ms(150.0);
                let _ = self.wait_lifecycle(&t, None, "domcontentloaded", 15000.0, None);
                Ok(nav_outcome(self.page_info(&t)?))
            }
            "reload" => {
                let t = self.tab()?;
                self.call("Page.reload", Json::new(), &t)?;
                sleep_ms(150.0);
                let _ = self.wait_lifecycle(&t, None, a.get("wait-until").unwrap_or("load"), 25000.0, None);
                Ok(nav_outcome(self.page_info(&t)?))
            }

            "snapshot" => {
                let t = self.tab()?;
                let mut o = SnapOptions { compact: a.has("compact"), interactive: a.has("interactive"), selector: a.get("selector").map(String::from), urls: a.has("urls"), ..Default::default() };
                if let Some(d) = a.get("depth").and_then(|d| d.parse().ok()) {
                    o.depth = d;
                }
                let (text, refs) = self.snapshot(&t, &o)?;
                // --delta: only what changed since the last snapshot taken the same way
                let key = format!("{}{}{}{}{}", o.compact, o.interactive, o.selector.clone().unwrap_or_default(), o.urls, o.depth);
                let lines: Vec<String> = text.split('\n').map(String::from).collect();
                let prev = t.s().last_snapshot.insert(key, lines.clone());
                if let (true, Some(prev)) = (a.has("delta"), prev) {
                    let mut left: HashMap<&str, i64> = HashMap::new();
                    for l in &prev {
                        *left.entry(l).or_default() += 1;
                    }
                    let mut added = Vec::new();
                    for l in &lines {
                        match left.get_mut(l.as_str()) {
                            Some(n) if *n > 0 => *n -= 1,
                            _ => added.push(format!("+ {}", l.trim())),
                        }
                    }
                    let mut right: HashMap<&str, i64> = HashMap::new();
                    for l in &lines {
                        *right.entry(l).or_default() += 1;
                    }
                    let mut removed = Vec::new();
                    for l in &prev {
                        match right.get_mut(l.as_str()) {
                            Some(n) if *n > 0 => *n -= 1,
                            _ => removed.push(format!("- {}", l.trim())),
                        }
                    }
                    removed.extend(added);
                    let diff = removed.join("\n");
                    let text = if diff.is_empty() { "(no change)".to_string() } else { diff.clone() };
                    return Ok(Outcome::new(json!({ "snapshot": diff, "delta": true, "refs": refs, "origin": t.url() }), text));
                }
                Ok(Outcome::new(json!({ "snapshot": text, "refs": refs, "origin": t.url() }), text))
            }

            "eval" => {
                let t = self.tab()?;
                let mut code = a.rest(0);
                if a.has("stdin") {
                    code = req.stdin.clone().unwrap_or_default();
                }
                if a.has("b") || a.has("base64") {
                    if let Ok(d) = base64::engine::general_purpose::STANDARD.decode(code.trim()) {
                        code = String::from_utf8_lossy(&d).into_owned();
                    }
                }
                if code.trim().is_empty() {
                    return err("usage: eval <js> | eval --stdin");
                }
                let v = self.eval_value_t(&t, &code, a.ms("timeout", 60000.0) / 1000.0)?;
                let text = if v.is_null() { String::new() } else { json_pretty(&v) };
                Ok(Outcome::new(json!({ "result": v, "origin": t.url() }), text))
            }

            "click" | "dblclick" | "hover" | "focus" | "check" | "uncheck" | "scrollintoview" | "scrollIntoView" => {
                let Some(sel) = a.pos(0) else { return err(format!("usage: {cmd} <selector|@ref>")) };
                let t = self.tab()?;
                let el = self.element(&t, sel)?;
                let r = self.act(&t, &el, cmd, &a);
                self.release(&t, &el);
                r?;
                Ok(Outcome::done())
            }
            "fill" | "type" => {
                if a.pos.is_empty() {
                    return err(format!("usage: {cmd} <selector|@ref> <text>"));
                }
                let t = self.tab()?;
                let el = self.element(&t, &a.pos[0])?;
                let text = a.rest(1);
                let r = (|| {
                    self.guard_password(&t, &el)?;
                    if cmd == "fill" {
                        self.fill(&t, &el, &text)
                    } else {
                        self.focus(&t, &el)?;
                        self.type_keys(&t, &text)
                    }
                })();
                self.release(&t, &el);
                r?;
                Ok(Outcome::done())
            }
            "press" | "key" => {
                let Some(k) = a.pos(0) else { return err("usage: press <key>") };
                let t = self.tab()?;
                self.press(&t, k)?;
                Ok(Outcome::done())
            }
            "keyboard" => {
                let t = self.tab()?;
                let sub = a.pos(0).unwrap_or_default();
                let text = a.rest(1);
                match sub {
                    "type" => self.type_keys(&t, &text)?,
                    "inserttext" | "insertText" | "insert" => {
                        self.call("Input.insertText", obj!({ "text": text }), &t)?;
                    }
                    "down" | "up" => {
                        let (mods, def) = crate::keys::parse_combo(&text)?;
                        self.key_event(&t, if sub == "down" { "keyDown" } else { "keyUp" }, &def, mods)?;
                    }
                    _ => return err("usage: keyboard type|inserttext <text>"),
                }
                Ok(Outcome::done())
            }
            "select" => {
                if a.pos.len() < 2 {
                    return err("usage: select <selector|@ref> <value...>");
                }
                let t = self.tab()?;
                let el = self.element(&t, &a.pos[0])?;
                let r = self.call_on(&t, &el, SELECT_JS, vec![json!(a.pos[1..])], true);
                self.release(&t, &el);
                let r = r?;
                Ok(Outcome::data(json!({ "selected": r.get("value").cloned().unwrap_or(json!([])) })))
            }
            "upload" => {
                if a.pos.len() < 2 {
                    return err("usage: upload <selector|@ref> <files...>");
                }
                let t = self.tab()?;
                let el = self.element(&t, &a.pos[0])?;
                let r = (|| {
                    let files: Vec<String> = a.pos[1..].iter().map(|f| absolute_path(f, &req.cwd)).collect();
                    if let Some(f) = files.iter().find(|f| !std::path::Path::new(f).exists()) {
                        return err(format!("no such file: {f}"));
                    }
                    let mut target = el.clone();
                    let is_input = self.on(&t, &el, "function(){return this.tagName==='INPUT'&&this.type==='file'}")?.as_bool().unwrap_or(false);
                    if !is_input {
                        let inner = self.call_on(&t, &el, "function(){return this.querySelector('input[type=file]')}", vec![], false)?;
                        let Some(oid) = inner.str("objectId") else { return err(format!("{} is not a file input", a.pos[0])) };
                        target = oid.into();
                    }
                    self.call("DOM.setFileInputFiles", obj!({ "files": files, "objectId": target }), &t)?;
                    Ok(Outcome::data(json!({ "files": files })))
                })();
                self.release(&t, &el);
                r
            }
            "drag" => {
                if a.pos.len() < 2 {
                    return err("usage: drag <from> <to>");
                }
                let t = self.tab()?;
                let from = self.element(&t, &a.pos[0])?;
                let to = match self.element(&t, &a.pos[1]) {
                    Ok(e) => e,
                    Err(e) => {
                        self.release(&t, &from);
                        return Err(e);
                    }
                };
                let r = (|| {
                    let p1 = self.point(&t, &from)?;
                    let p2 = self.point(&t, &to)?;
                    self.mouse(&t, "mouseMoved", p1.0, p1.1, None, 0, 0)?;
                    self.mouse(&t, "mousePressed", p1.0, p1.1, Some("left"), 1, 0)?;
                    for i in 1..=10 {
                        let f = i as f64 / 10.0;
                        self.mouse(&t, "mouseMoved", p1.0 + (p2.0 - p1.0) * f, p1.1 + (p2.1 - p1.1) * f, Some("left"), 0, 1)?;
                    }
                    self.mouse(&t, "mouseReleased", p2.0, p2.1, Some("left"), 1, 0)
                })();
                self.release(&t, &to);
                self.release(&t, &from);
                r?;
                Ok(Outcome::done())
            }
            "download" => {
                if a.pos.len() < 2 {
                    return err("usage: download <selector|@ref> <path>");
                }
                let t = self.tab()?;
                self.download(&t, &a.pos[0], &absolute_path(&a.pos[1], &req.cwd), a.ms("timeout", 60000.0))
            }
            "scroll" => {
                let t = self.tab()?;
                let dir = a.pos(0).unwrap_or("down").to_lowercase();
                let px = a.pos(1).map(|p| p.parse().unwrap_or(300.0)).unwrap_or(300.0);
                let (dx, dy) = match dir.as_str() {
                    "up" => (0.0, -px),
                    "down" => (0.0, px),
                    "left" => (-px, 0.0),
                    "right" => (px, 0.0),
                    _ => return err("usage: scroll up|down|left|right [px]"),
                };
                let mut at = self.viewport_center(&t)?;
                if let Some(sel) = a.get("selector") {
                    let el = self.element(&t, sel)?;
                    let p = self.point(&t, &el);
                    self.release(&t, &el);
                    at = p?;
                }
                self.call("Input.dispatchMouseEvent", obj!({ "type": "mouseWheel", "x": at.0, "y": at.1, "deltaX": dx, "deltaY": dy }), &t)?;
                sleep_ms(100.0);
                Ok(Outcome::done())
            }
            "mouse" => {
                let t = self.tab()?;
                let sub = a.pos(0).unwrap_or_default();
                let n: Vec<f64> = a.pos.iter().skip(1).filter_map(|x| x.parse().ok()).collect();
                let at = t.s().mouse;
                match sub {
                    "move" => {
                        if n.len() < 2 {
                            return err("usage: mouse move <x> <y>");
                        }
                        self.mouse(&t, "mouseMoved", n[0], n[1], None, 0, 0)?;
                    }
                    "down" | "up" => {
                        let b = a.pos(1).unwrap_or("left");
                        self.mouse(&t, if sub == "down" { "mousePressed" } else { "mouseReleased" }, at.0, at.1, Some(b), 1, 0)?;
                    }
                    "wheel" => {
                        self.call("Input.dispatchMouseEvent", obj!({ "type": "mouseWheel", "x": at.0, "y": at.1, "deltaY": n.first().copied().unwrap_or(0.0), "deltaX": n.get(1).copied().unwrap_or(0.0) }), &t)?;
                    }
                    _ => return err("usage: mouse move|down|up|wheel"),
                }
                Ok(Outcome::done())
            }
            "wait" => self.wait(&a),

            "screenshot" => {
                let t = self.tab()?;
                let mut path = a.pos(0).map(String::from);
                let mut full = a.has("full");
                if path.as_deref() == Some("--full") {
                    path = None;
                    full = true;
                }
                let file = path.map(|p| absolute_path(&p, &req.cwd)).unwrap_or_else(|| std::env::temp_dir().join(format!("screenshot-{}.png", now_ms() as i64)).display().to_string());
                let lower = file.to_lowercase();
                let jpeg = lower.ends_with(".jpg") || lower.ends_with(".jpeg");
                let mut params = obj!({ "format": if jpeg { "jpeg" } else { "png" }, "captureBeyondViewport": full });
                if jpeg {
                    params.insert("quality".into(), json!(a.get("quality").and_then(|q| q.parse::<i64>().ok()).unwrap_or(85)));
                }
                if full {
                    let m = self.call("Page.getLayoutMetrics", Json::new(), &t)?;
                    let size = m.obj("cssContentSize").or(m.obj("contentSize")).cloned().unwrap_or_default();
                    params.insert("clip".into(), json!({ "x": 0, "y": 0, "width": size.dbl("width").unwrap_or(1280.0), "height": size.dbl("height").unwrap_or(800.0).min(16000.0), "scale": 1 }));
                }
                if let Some(sel) = a.get("selector") {
                    let el = self.element(&t, sel)?;
                    let q = self.quads(&t, &el);
                    self.release(&t, &el);
                    let q = q?;
                    params.insert("clip".into(), json!({ "x": q.x, "y": q.y, "width": q.w, "height": q.h, "scale": 1 }));
                }
                let r = self.cdp.call("Page.captureScreenshot", params, Some(&t.session_id), 60.0)?;
                let d = r.str("data").and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok()).ok_or("no picture came back")?;
                if let Some(dir) = std::path::Path::new(&file).parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                std::fs::write(&file, d).map_err(|e| e.to_string())?;
                Ok(Outcome::new(json!({ "path": file }), format!("✓ Screenshot saved to {file}")))
            }
            "pdf" => {
                let Some(p) = a.pos(0) else { return err("usage: pdf <path>") };
                let t = self.tab()?;
                let file = absolute_path(p, &req.cwd);
                let r = self.cdp.call("Page.printToPDF", obj!({ "printBackground": true }), Some(&t.session_id), 120.0)?;
                let d = r.str("data").and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok()).ok_or("no PDF came back")?;
                std::fs::write(&file, d).map_err(|e| e.to_string())?;
                Ok(Outcome::new(json!({ "path": file }), format!("✓ PDF saved to {file}")))
            }

            "get" => self.get(&a),
            "is" => {
                if a.pos.len() < 2 {
                    return err("usage: is visible|enabled|checked <selector|@ref>");
                }
                let f = match a.pos[0].as_str() {
                    "visible" => "function(){const r=this.getBoundingClientRect();const s=getComputedStyle(this);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}",
                    "enabled" => "function(){return !this.disabled && this.getAttribute('aria-disabled')!=='true'}",
                    "checked" => "function(){return !!(this.checked || this.getAttribute('aria-checked')==='true')}",
                    _ => return err("usage: is visible|enabled|checked <selector|@ref>"),
                };
                let t = self.tab()?;
                let el = self.element(&t, &a.pos[1])?;
                let v = self.on(&t, &el, f);
                self.release(&t, &el);
                let v = v?.as_bool().unwrap_or(false);
                let mut data = Json::new();
                data.insert(a.pos[0].clone(), json!(v));
                Ok(Outcome::new(Value::Object(data), v.to_string()))
            }
            "find" => self.find(&a),
            "a11y" => self.a11y(&a),
            "vitals" => self.vitals(&a),

            "set" => self.setting(&a),
            "network" => self.network(&a),
            "cookies" => self.cookies(&a),
            "storage" => self.storage(&a),
            "console" => {
                let t = self.tab()?;
                if a.has("clear") {
                    t.s().console.clear();
                    return Ok(Outcome::new(json!({ "cleared": true }), "✓ Cleared"));
                }
                let msgs = t.s().console.clone();
                let text = msgs.iter().map(|m| format!("[{}] {}", m["type"].as_str().unwrap_or("log"), m["text"].as_str().unwrap_or_default())).collect::<Vec<_>>().join("\n");
                Ok(Outcome::new(json!({ "messages": msgs }), text))
            }
            "errors" => {
                let t = self.tab()?;
                if a.has("clear") {
                    t.s().errors.clear();
                    return Ok(Outcome::new(json!({ "cleared": true }), "✓ Cleared"));
                }
                let errs = t.s().errors.clone();
                let text = errs.iter().map(|m| m["text"].as_str().unwrap_or_default().to_string()).collect::<Vec<_>>().join("\n");
                Ok(Outcome::new(json!({ "errors": errs }), text))
            }

            "tab" | "tabs" => self.tab_command(&a),
            "record" => self.record(&a, req),
            "stream" => self.stream_command(&a),
            "session" => Ok(self.session_info()),
            "auth" => self.auth(&a),
            "close" | "quit" | "exit" => {
                // the reply goes out first; then the session ends (a shared browser and its tabs stay)
                self.release_port();
                self.later(|d| {
                    sleep_ms(200.0);
                    d.shutdown(0)
                });
                Ok(Outcome::new(json!({ "closed": true }), "✓ Session closed"))
            }
            _ => err(format!("Unknown command: {cmd} (ondra-browser --help lists them)")),
        }
    }

    // ───────────── elements ─────────────

    pub fn release(&self, tab: &Tab, oid: &str) {
        self.cdp.send("Runtime.releaseObject", obj!({ "objectId": oid }), Some(&tab.session_id));
    }

    pub fn quads(&self, tab: &Tab, el: &str) -> Res<Rect> {
        let _ = self.call("DOM.scrollIntoViewIfNeeded", obj!({ "objectId": el }), tab);
        let r = self.call("DOM.getContentQuads", obj!({ "objectId": el }), tab)?;
        for q in r.arr("quads").cloned().unwrap_or_default() {
            let q: Vec<f64> = q.as_array().map(|a| a.iter().filter_map(|x| x.as_f64()).collect()).unwrap_or_default();
            if q.len() != 8 {
                continue;
            }
            let xs = [q[0], q[2], q[4], q[6]];
            let ys = [q[1], q[3], q[5], q[7]];
            let (x0, x1) = (xs.iter().cloned().fold(f64::MAX, f64::min), xs.iter().cloned().fold(f64::MIN, f64::max));
            let (y0, y1) = (ys.iter().cloned().fold(f64::MAX, f64::min), ys.iter().cloned().fold(f64::MIN, f64::max));
            let rect = Rect { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
            if rect.w >= 1.0 && rect.h >= 1.0 {
                return Ok(rect);
            }
        }
        err("Element is not visible (it has no size on screen)")
    }

    pub fn point(&self, tab: &Tab, el: &str) -> Res<(f64, f64)> {
        let r = self.quads(tab, el)?;
        Ok((r.x + r.w / 2.0, r.y + r.h / 2.0))
    }

    pub fn viewport_center(&self, tab: &Tab) -> Res<(f64, f64)> {
        let m = self.call("Page.getLayoutMetrics", Json::new(), tab)?;
        let v = m.obj("cssLayoutViewport").or(m.obj("layoutViewport")).cloned().unwrap_or_default();
        Ok((v.dbl("clientWidth").unwrap_or(1280.0) / 2.0, v.dbl("clientHeight").unwrap_or(800.0) / 2.0))
    }

    /// `buttons` 0 means: the pressed button's own (for mousePressed), else none given.
    pub fn mouse(&self, tab: &Tab, kind: &str, x: f64, y: f64, button: Option<&str>, clicks: i64, buttons: i64) -> Res<()> {
        let button = button.unwrap_or("none");
        let mut p = obj!({ "type": kind, "x": x, "y": y, "button": button, "clickCount": clicks });
        if buttons != 0 {
            p.insert("buttons".into(), json!(buttons));
        } else if kind == "mousePressed" {
            p.insert("buttons".into(), json!(if button == "right" { 2 } else { 1 }));
        }
        self.call("Input.dispatchMouseEvent", p, tab)?;
        tab.s().mouse = (x, y);
        Ok(())
    }

    pub fn click(&self, tab: &Tab, el: &str, count: i64) -> Res<()> {
        let (x, y) = self.point(tab, el)?;
        self.mouse(tab, "mouseMoved", x, y, None, 0, 0)?;
        for i in 1..=count {
            self.mouse(tab, "mousePressed", x, y, Some("left"), i, 0)?;
            self.mouse(tab, "mouseReleased", x, y, Some("left"), i, 0)?;
        }
        Ok(())
    }

    pub fn focus(&self, tab: &Tab, el: &str) -> Res<()> {
        self.call_on(tab, el, "function(){ this.scrollIntoView({block:'center', inline:'nearest'}); this.focus(); }", vec![], true)?;
        Ok(())
    }

    pub fn act(&self, tab: &Tab, el: &str, cmd: &str, _a: &Args) -> Res<()> {
        match cmd {
            "click" => self.click(tab, el, 1)?,
            "dblclick" => self.click(tab, el, 2)?,
            "hover" => {
                let (x, y) = self.point(tab, el)?;
                self.mouse(tab, "mouseMoved", x, y, None, 0, 0)?;
            }
            "focus" => self.focus(tab, el)?,
            "scrollintoview" | "scrollIntoView" => {
                self.call_on(tab, el, "function(){ this.scrollIntoView({block:'center', inline:'nearest'}) }", vec![], true)?;
            }
            "check" | "uncheck" => {
                let checked = || -> Res<bool> {
                    Ok(self.on(tab, el, "function(){return !!(this.checked || this.getAttribute('aria-checked')==='true' || (this.querySelector&&this.querySelector('input:checked')))}")?.as_bool().unwrap_or(false))
                };
                let want = cmd == "check";
                if checked()? != want {
                    self.click(tab, el, 1)?;
                    if checked()? != want {
                        self.call_on(tab, el, "function(){ (this.matches('input')?this:this.querySelector('input')||this).click() }", vec![], true)?;
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// No typing into a password field: sign-in goes through `auth login`.
    pub fn guard_password(&self, tab: &Tab, el: &str) -> Res<()> {
        let pw = self.on(tab, el, "function(){return this.tagName==='INPUT'&&this.type==='password'}").ok().and_then(|v| v.as_bool()).unwrap_or(false);
        if pw {
            return err("That is a password field: sign in with `ondra-browser auth login <site> --credential-provider keychain --no-navigate --url <login page>`");
        }
        Ok(())
    }

    pub fn fill(&self, tab: &Tab, el: &str, text: &str) -> Res<()> {
        self.focus(tab, el)?;
        // clear what is there the way a person would (select all, delete), so frameworks see it
        self.call_on(tab, el, CLEAR_JS, vec![], true)?;
        self.call("Input.dispatchKeyEvent", obj!({ "type": "keyDown", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8 }), tab)?;
        self.call("Input.dispatchKeyEvent", obj!({ "type": "keyUp", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8 }), tab)?;
        if !text.is_empty() {
            self.call("Input.insertText", obj!({ "text": text }), tab)?;
        }
        // a field that kept its old value (a script resets it): set it and say so to the page
        self.call_on(tab, el, SET_VALUE_JS, vec![json!(text)], true)?;
        Ok(())
    }

    pub fn key_event(&self, tab: &Tab, kind: &str, def: &crate::keys::KeyDef, mods: i64) -> Res<()> {
        self.key_event_with(tab, kind, def, mods, None, &[])
    }

    pub fn key_event_with(&self, tab: &Tab, kind: &str, def: &crate::keys::KeyDef, mods: i64, text: Option<&str>, commands: &[String]) -> Res<()> {
        let mut p = obj!({ "type": kind, "key": def.key, "code": def.code, "windowsVirtualKeyCode": def.key_code, "nativeVirtualKeyCode": def.key_code, "modifiers": mods });
        if let Some(t) = text {
            p.insert("text".into(), json!(t));
            p.insert("unmodifiedText".into(), json!(t));
        }
        if !commands.is_empty() {
            p.insert("commands".into(), json!(commands));
        }
        self.call("Input.dispatchKeyEvent", p, tab)?;
        Ok(())
    }

    pub fn press(&self, tab: &Tab, combo: &str) -> Res<()> {
        let (mods, def) = crate::keys::parse_combo(combo)?;
        let cmd = crate::keys::editing_command(mods, &def);
        let text = if mods & 6 == 0 { def.text.clone().map(|t| if mods & 8 != 0 { t.to_uppercase() } else { t }) } else { None };
        let commands: Vec<String> = cmd.into_iter().collect();
        self.key_event_with(tab, if text.is_some() { "keyDown" } else { "rawKeyDown" }, &def, mods, text.as_deref(), &commands)?;
        self.key_event(tab, "keyUp", &def, mods)
    }

    pub fn type_keys(&self, tab: &Tab, text: &str) -> Res<()> {
        for ch in text.chars() {
            let s = ch.to_string();
            if s == "\n" {
                self.press(tab, "Enter")?;
                continue;
            }
            match crate::keys::key_def(&s).filter(|d| !d.code.is_empty()) {
                Some(def) => {
                    self.key_event_with(tab, "keyDown", &def, 0, Some(&s), &[])?;
                    self.key_event(tab, "keyUp", &def, 0)?;
                }
                None => {
                    self.call("Input.insertText", obj!({ "text": s }), tab)?;
                }
            }
        }
        Ok(())
    }

    // ───────────── wait ─────────────

    fn wait(&self, a: &Args) -> Res<Outcome> {
        let t = self.tab()?;
        let timeout = a.ms("timeout", 25000.0);
        let ready = |t: &Tab| self.eval_value(t, "document.readyState").ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
        if let Some(load) = a.get("load") {
            if load.eq_ignore_ascii_case("networkidle") {
                poll(timeout, 100.0, "the network to go quiet", || {
                    let r = ready(&t) == "complete";
                    let idle = {
                        let s = t.s();
                        s.inflight.is_empty() && now_ms() - s.last_net >= 500.0
                    };
                    Ok((r && idle).then_some(()))
                })?;
            } else {
                let want: &[&str] = if load.eq_ignore_ascii_case("load") { &["complete"] } else { &["interactive", "complete"] };
                poll(timeout, 50.0, load, || Ok(want.contains(&ready(&t).as_str()).then_some(())))?;
            }
            return Ok(Outcome::done());
        }
        let truthy = |expr: &str| self.eval_value(&t, expr).ok().and_then(|v| v.as_bool()).unwrap_or(false);
        if let Some(text) = a.get("text") {
            let expr = format!("(document.body?.innerText||'').includes({})", quote(text));
            poll(timeout, 100.0, &format!("text \"{text}\""), || Ok(truthy(&expr).then_some(())))?;
            return Ok(Outcome::done());
        }
        if let Some(u) = a.get("url") {
            poll(timeout, 100.0, &format!("the URL to match {u}"), || {
                let now = self.eval_value(&t, "location.href").ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
                Ok((glob_match(u, &now) || now.contains(u)).then_some(()))
            })?;
            return Ok(Outcome::done());
        }
        if let Some(f) = a.get("fn") {
            let expr = format!("(async () => {{ try {{ return !!({f}); }} catch (e) {{ return false }} }})()");
            poll(timeout, 100.0, "the condition", || Ok(truthy(&expr).then_some(())))?;
            return Ok(Outcome::done());
        }
        let Some(what) = a.pos(0) else { return err("usage: wait <ms|selector|@ref> | --load <state> | --text <t> | --url <pattern> | --fn <js>") };
        if let Ok(ms) = what.parse::<f64>() {
            sleep_ms(ms.min(120000.0));
            return Ok(Outcome::done());
        }
        let state = a.get("state").unwrap_or("visible");
        poll(timeout, 100.0, &format!("{what} to be {state}"), || {
            let el = self.element(&t, what).ok();
            let r = match state {
                "attached" => el.is_some(),
                "detached" => el.is_none(),
                _ => match &el {
                    None => state == "hidden",
                    Some(e) => {
                        let vis = self.on(&t, e, VISIBLE_JS).ok().and_then(|v| v.as_bool()).unwrap_or(false);
                        if state == "hidden" {
                            !vis
                        } else {
                            vis
                        }
                    }
                },
            };
            if let Some(e) = &el {
                self.release(&t, e);
            }
            Ok(r.then_some(()))
        })?;
        Ok(Outcome::done())
    }

    // ───────────── get / find ─────────────

    fn get(&self, a: &Args) -> Res<Outcome> {
        let t = self.tab()?;
        let what = a.pos(0).unwrap_or_default();
        let s_of = |v: Res<Value>| -> Res<String> { Ok(v?.as_str().unwrap_or_default().to_string()) };
        match what {
            "url" => {
                let u = self.eval_value(&t, "location.href").ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| t.url());
                Ok(Outcome::new(json!({ "url": u }), u))
            }
            "title" => {
                let s = s_of(self.eval_value(&t, "document.title"))?;
                Ok(Outcome::new(json!({ "title": s }), s))
            }
            "cdp-url" => Ok(Outcome::new(json!({ "url": self.cdp.endpoint }), self.cdp.endpoint.clone())),
            "count" => {
                let Some(sel) = a.pos(1) else { return err("usage: get count <selector>") };
                let n = self.eval_value(&t, &format!("({})({}, true).length", crate::page_js::DEEP_QUERY_JS, quote(sel)))?.as_i64().unwrap_or(0);
                Ok(Outcome::new(json!({ "count": n }), n.to_string()))
            }
            "text" | "html" | "value" | "attr" | "box" | "styles" => {
                let sel_index = if what == "attr" { 2 } else { 1 };
                let Some(sel) = a.pos(sel_index) else { return err(format!("usage: get {what} {}<selector|@ref>", if what == "attr" { "<name> " } else { "" })) };
                let el = self.element(&t, sel)?;
                let r = (|| match what {
                    "text" => {
                        let s = s_of(self.on(&t, &el, TEXT_JS))?;
                        Ok(Outcome::new(json!({ "text": s }), s))
                    }
                    "html" => {
                        let s = s_of(self.on(&t, &el, "function(){return this.outerHTML}"))?;
                        Ok(Outcome::new(json!({ "html": s }), s))
                    }
                    "value" => {
                        self.guard_password(&t, &el)?;
                        let s = s_of(self.on(&t, &el, "function(){return this.value ?? ''}"))?;
                        Ok(Outcome::new(json!({ "value": s }), s))
                    }
                    "attr" => {
                        let v = self.call_on(&t, &el, "function(n){return this.getAttribute(n)}", vec![json!(a.pos[1])], true)?.get("value").cloned().unwrap_or(Value::Null);
                        let text = plain(&v);
                        Ok(Outcome::new(json!({ "value": v }), text))
                    }
                    "box" => {
                        let r = self.quads(&t, &el)?;
                        let b = json!({ "x": r.x, "y": r.y, "width": r.w, "height": r.h });
                        let text = json_string(&b);
                        Ok(Outcome::new(b, text))
                    }
                    _ => {
                        let v = self.on(&t, &el, STYLES_JS)?;
                        let v = if v.is_null() { json!({}) } else { v };
                        let text = json_pretty(&v);
                        Ok(Outcome::new(json!({ "styles": v }), text))
                    }
                })();
                self.release(&t, &el);
                r
            }
            _ => err("usage: get url|title|text|html|value|attr|count|box|styles [selector]"),
        }
    }

    /// `find <locator> <value> <action> [text]`: role, text, label, placeholder, alt, title,
    /// testid, first, last, nth.
    fn find(&self, a: &Args) -> Res<Outcome> {
        let t = self.tab()?;
        let mut p: std::collections::VecDeque<String> = a.pos.iter().cloned().collect();
        if p.len() < 2 {
            return err("usage: find <role|text|label|placeholder|alt|title|testid|first|last|nth> <value> [action] [text]");
        }
        let how = p.pop_front().unwrap();
        let mut nth = 0i64;
        if how == "nth" {
            nth = p.pop_front().and_then(|n| n.parse().ok()).unwrap_or(0);
        }
        let Some(value) = p.pop_front() else { return err(format!("find {how}: what to look for?")) };
        let action = p.pop_front().unwrap_or_else(|| "click".into());
        let text = p.into_iter().collect::<Vec<_>>().join(" ");
        let exact = a.has("exact");
        let object_of = |r: Json| -> Option<String> {
            let res = r.obj("result")?;
            if res.str("subtype") == Some("null") {
                None
            } else {
                res.str("objectId").map(String::from)
            }
        };
        let el: Option<String> = match how.as_str() {
            "role" => {
                let (nodes, _) = self.ax_tree(&t)?;
                let want = a.get("name").map(|n| n.to_lowercase());
                let name_of = |n: &Json| n.obj("name").and_then(|x| x.str("value")).unwrap_or_default().to_lowercase();
                let mut hits: Vec<&Json> = nodes
                    .values()
                    .filter(|n| {
                        n.bool("ignored") != Some(true)
                            && n.obj("role").and_then(|r| r.str("value")) == Some(value.as_str())
                            && n.int("backendDOMNodeId").is_some()
                            && match &want {
                                None => true,
                                Some(w) => {
                                    let nm = name_of(n).trim().to_string();
                                    if exact {
                                        &nm == w
                                    } else {
                                        nm.contains(w.as_str())
                                    }
                                }
                            }
                    })
                    .collect();
                hits.sort_by_key(|n| n.int("backendDOMNodeId").unwrap_or(0));
                // the exact name first when there is one
                let pick = hits.iter().find(|n| Some(name_of(n)) == want).or(hits.first()).copied();
                let Some(b) = pick.and_then(|n| n.int("backendDOMNodeId")) else {
                    return err(format!("no {value}{} on the page", want.map(|w| format!(" named \"{w}\"")).unwrap_or_default()));
                };
                self.call("DOM.resolveNode", obj!({ "backendNodeId": b }), &t)?.obj("object").and_then(|o| o.str("objectId")).map(String::from)
            }
            "first" | "last" | "nth" => {
                let idx = if how == "last" { "all.length - 1".to_string() } else { nth.to_string() };
                let expr = format!("(() => {{ const all = ({})({}, true); return all[{idx}] || null }})()", crate::page_js::DEEP_QUERY_JS, quote(&value));
                object_of(self.call("Runtime.evaluate", obj!({ "expression": expr }), &t)?)
            }
            _ => {
                let v = quote(&value);
                let js = match how.as_str() {
                    "text" => format!("(() => {{ const t = {v}.toLowerCase(); let best = null; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT); for (let n = w.currentNode; n; n = w.nextNode()) {{ const s = (n.innerText || '').trim().toLowerCase(); if ({exact} ? s === t : s.includes(t)) best = n; }} return best; }})()"),
                    "label" => format!("(() => {{ const t = {v}.toLowerCase(); for (const l of document.querySelectorAll('label')) {{ if (l.textContent.trim().toLowerCase().includes(t)) return l.control || l.querySelector('input,select,textarea') || l; }} return document.querySelector(`[aria-label*=\"${{{v}}}\" i]`); }})()"),
                    "placeholder" => format!("document.querySelector(`[placeholder*=\"${{{v}}}\" i]`)"),
                    "alt" => format!("document.querySelector(`[alt*=\"${{{v}}}\" i]`)"),
                    "title" => format!("document.querySelector(`[title*=\"${{{v}}}\" i]`)"),
                    "testid" => format!("document.querySelector(`[data-testid=\"${{{v}}}\"],[data-test-id=\"${{{v}}}\"],[data-test=\"${{{v}}}\"]`)"),
                    _ => return err(format!("find: unknown locator {how}")),
                };
                object_of(self.call("Runtime.evaluate", obj!({ "expression": js }), &t)?)
            }
        };
        let Some(el) = el else { return err(format!("find {how} {value}: nothing matches")) };
        let r = (|| {
            match action.as_str() {
                "click" | "dblclick" | "hover" | "focus" | "check" | "uncheck" | "scrollintoview" => self.act(&t, &el, &action, a)?,
                "fill" => {
                    self.guard_password(&t, &el)?;
                    self.fill(&t, &el, &text)?;
                }
                "type" => {
                    self.guard_password(&t, &el)?;
                    self.focus(&t, &el)?;
                    self.type_keys(&t, &text)?;
                }
                "text" => {
                    let s = self.on(&t, &el, TEXT_JS)?.as_str().unwrap_or_default().to_string();
                    return Ok(Outcome::new(json!({ "text": s }), s));
                }
                _ => return err(format!("find: unknown action {action}")),
            }
            Ok(Outcome::done())
        })();
        self.release(&t, &el);
        r
    }

    // ───────────── settings ─────────────

    fn setting(&self, a: &Args) -> Res<Outcome> {
        let what = a.pos(0).unwrap_or_default();
        let v: Vec<String> = a.pos.iter().skip(1).cloned().collect();
        self.change_setting(what, &v)?;
        self.apply_all()?;
        Ok(Outcome::done())
    }

    fn change_setting(&self, what: &str, v: &[String]) -> Res<()> {
        let mut s = self.st();
        match what {
            "viewport" => {
                let (Some(w), Some(h)) = (v.first().and_then(|x| x.parse::<i64>().ok()), v.get(1).and_then(|x| x.parse::<i64>().ok())) else { return err("usage: set viewport <w> <h> [scale]") };
                let scale = v.get(2).map(|x| x.parse::<f64>().unwrap_or(1.0)).unwrap_or(1.0);
                s.viewport = Some(obj!({ "width": w, "height": h, "deviceScaleFactor": scale, "mobile": false }));
            }
            "device" => {
                let name = v.join(" ").to_lowercase();
                let ios = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
                let devices: [(&str, i64, i64, f64, &str); 6] = [
                    ("desktop", 1280, 800, 1.0, ""),
                    ("ipad", 820, 1180, 2.0, "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
                    ("iphone 15", 393, 852, 3.0, ios),
                    ("iphone 15 pro max", 430, 932, 3.0, ios),
                    ("iphone se", 375, 667, 2.0, ios),
                    ("pixel 7", 412, 915, 2.625, "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"),
                ];
                let Some(d) = devices.iter().find(|d| d.0 == name) else {
                    let known = devices.iter().map(|d| d.0).collect::<Vec<_>>().join(", ");
                    return err(format!("unknown device {name}; known: {known}, or use set viewport"));
                };
                s.viewport = Some(obj!({ "width": d.1, "height": d.2, "deviceScaleFactor": d.3, "mobile": name != "desktop" }));
                s.user_agent = (!d.4.is_empty()).then(|| d.4.to_string());
            }
            "media" => {
                let mut scheme = s.color_scheme.clone();
                let mut motion = s.media.iter().any(|m| m["name"] == "prefers-reduced-motion");
                for w in v {
                    match w.to_lowercase().as_str() {
                        "dark" | "light" => scheme = Some(w.to_lowercase()),
                        "reduced-motion" | "reduce" => motion = true,
                        "no-reduced-motion" | "no-preference" => motion = false,
                        "reset" => {
                            scheme = None;
                            motion = false;
                        }
                        _ => return err("usage: set media [dark|light] [reduced-motion]"),
                    }
                }
                let mut feats = Vec::new();
                if let Some(sc) = &scheme {
                    feats.push(json!({ "name": "prefers-color-scheme", "value": sc }));
                }
                if motion {
                    feats.push(json!({ "name": "prefers-reduced-motion", "value": "reduce" }));
                }
                s.media = feats;
                s.color_scheme = scheme;
            }
            "offline" => s.offline = v.first().map(|x| x.to_lowercase()).unwrap_or_else(|| "on".into()) != "off",
            "headers" => {
                let Ok(j) = serde_json::from_str::<Json>(&v.join(" ")) else { return err("usage: set headers <json>") };
                s.extra_headers = j;
            }
            "credentials" => {
                if v.len() < 2 {
                    return err("usage: set credentials <user> <pass>");
                }
                let b = base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", v[0], v[1]));
                s.extra_headers.insert("Authorization".into(), json!(format!("Basic {b}")));
            }
            "geo" | "geolocation" => {
                let (Some(lat), Some(lng)) = (v.first().and_then(|x| x.parse::<f64>().ok()), v.get(1).and_then(|x| x.parse::<f64>().ok())) else { return err("usage: set geo <lat> <lng>") };
                s.geo = Some(obj!({ "latitude": lat, "longitude": lng, "accuracy": 10 }));
            }
            "useragent" | "user-agent" => s.user_agent = Some(v.join(" ")),
            _ => return err("usage: set viewport|device|media|offline|headers|credentials|geo|useragent ..."),
        }
        Ok(())
    }

    // ───────────── network ─────────────

    fn network(&self, a: &Args) -> Res<Outcome> {
        let sub = a.pos(0).unwrap_or_default();
        match sub {
            "route" => {
                let Some(pattern) = a.pos(1) else { return err("usage: network route <url> [--abort|--body <json>] [--resource-type <csv>]") };
                let types: Vec<String> = a.get("resource-type").unwrap_or_default().to_lowercase().split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
                let r = Route { pattern: pattern.into(), abort: a.has("abort") || a.get("body").is_none(), body: a.get("body").map(String::from), allow_origin: a.get("allow-origin").map(String::from), types };
                self.st().routes.push(r);
                self.apply_all()?;
                Ok(Outcome::data(json!({ "routed": pattern })))
            }
            "unroute" => {
                {
                    let mut s = self.st();
                    match a.pos(1) {
                        Some(p) => s.routes.retain(|r| r.pattern != p),
                        None => s.routes.clear(),
                    }
                }
                self.apply_all()?;
                Ok(Outcome::done())
            }
            "requests" => {
                let t = self.tab()?;
                if a.has("clear") {
                    let mut s = t.s();
                    s.requests.clear();
                    s.order.clear();
                    return Ok(Outcome::new(json!({ "cleared": true }), "✓ Cleared"));
                }
                let types: HashSet<String> = a.get("type").unwrap_or_default().to_lowercase().split(',').filter(|x| !x.is_empty()).map(String::from).collect();
                let methods: HashSet<String> = a.get("method").unwrap_or_default().to_uppercase().split(',').filter(|x| !x.is_empty()).map(String::from).collect();
                let (mut lo, mut hi) = (0i64, 999i64);
                if let Some(st) = a.get("status") {
                    let parts: Vec<i64> = st.split('-').filter_map(|x| x.parse().ok()).collect();
                    if parts.len() == 2 {
                        (lo, hi) = (parts[0], parts[1]);
                    } else if parts.len() == 1 {
                        (lo, hi) = (parts[0], parts[0]);
                    }
                }
                let filter = a.get("filter");
                let list: Vec<crate::tab::NetRequest> = {
                    let s = t.s();
                    s.order.iter().filter_map(|id| s.requests.get(id).cloned()).collect()
                };
                let list: Vec<_> = list
                    .into_iter()
                    .filter(|r| {
                        (types.is_empty() || types.contains(&r.resource_type.to_lowercase()))
                            && (methods.is_empty() || methods.contains(&r.method))
                            && (a.get("status").is_none() || r.status.is_some_and(|x| x >= lo && x <= hi))
                            && filter.is_none_or(|f| r.url.contains(f) || glob_match(f, &r.url))
                    })
                    .collect();
                let rows: Vec<Value> = list
                    .iter()
                    .map(|r| {
                        let mut j = obj!({ "requestId": r.id, "url": r.url, "method": r.method, "resourceType": r.resource_type, "headers": r.headers, "timestamp": r.timestamp, "status": r.status, "mimeType": r.mime_type });
                        if let Some(h) = &r.response_headers {
                            j.insert("responseHeaders".into(), h.clone());
                        }
                        if let Some(f) = &r.failed {
                            j.insert("failed".into(), json!(f));
                        }
                        Value::Object(j)
                    })
                    .collect();
                let text = list
                    .iter()
                    .map(|r| format!("[{}] {} {} ({}) {}", r.id, r.method, r.url, r.resource_type, r.status.map(|x| x.to_string()).or(r.failed.clone()).unwrap_or_else(|| "pending".into())))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Outcome::new(json!({ "requests": rows }), text))
            }
            "request" => {
                let Some(id) = a.pos(1) else { return err("usage: network request <id>") };
                let t = self.tab()?;
                let Some(r) = t.s().requests.get(id).cloned() else { return err(format!("no request {id} (network requests lists them)")) };
                let mut j = obj!({ "requestId": r.id, "url": r.url, "method": r.method, "resourceType": r.resource_type, "headers": r.headers, "status": r.status, "mimeType": r.mime_type, "responseHeaders": r.response_headers.clone().unwrap_or(json!({})) });
                if let Some(p) = &r.post_data {
                    j.insert("postData".into(), json!(p));
                }
                if let Ok(b) = self.call("Network.getResponseBody", obj!({ "requestId": r.id }), &t) {
                    let mut body = b.str("body").unwrap_or_default().to_string();
                    if b.bool("base64Encoded") == Some(true) {
                        let n = body.len() * 3 / 4;
                        body = base64::engine::general_purpose::STANDARD.decode(&body).ok().and_then(|d| String::from_utf8(d).ok()).unwrap_or_else(|| format!("(binary, {n} bytes)"));
                    }
                    if body.chars().count() > 200_000 {
                        body = body.chars().take(200_000).collect::<String>() + "…";
                    }
                    j.insert("body".into(), json!(body));
                }
                let v = Value::Object(j);
                let text = json_pretty(&v);
                Ok(Outcome::new(v, text))
            }
            _ => err("usage: network route|unroute|requests|request ..."),
        }
    }

    // ───────────── cookies / storage ─────────────

    fn cookies(&self, a: &Args) -> Res<Outcome> {
        let sub = a.pos(0).unwrap_or("get");
        let list_of = |r: Json| -> Vec<Value> { r.arr("cookies").cloned().unwrap_or_default() };
        match sub {
            "get" => {
                let list = if let Some(u) = a.get("url") {
                    let t = self.tab()?;
                    list_of(self.call("Network.getCookies", obj!({ "urls": [u] }), &t)?)
                } else if let Some(t) = self.active().filter(|t| !t.gone()) {
                    let u = t.url();
                    let params = if u.starts_with("http") { obj!({ "urls": [u] }) } else { Json::new() };
                    list_of(self.call("Network.getCookies", params, &t)?)
                } else {
                    list_of(self.cdp.call("Storage.getCookies", Json::new(), None, 30.0)?)
                };
                let text = list.iter().map(|c| format!("{}={} ({})", c["name"].as_str().unwrap_or_default(), c["value"].as_str().unwrap_or_default(), c["domain"].as_str().unwrap_or_default())).collect::<Vec<_>>().join("\n");
                Ok(Outcome::new(json!({ "cookies": list }), text))
            }
            "set" => {
                if a.pos.len() < 3 {
                    return err("usage: cookies set <name> <value> [--url u | --domain d] [--path p] [--secure] [--http-only] [--same-site s] [--expires ts]");
                }
                let mut c = obj!({ "name": a.pos[1], "value": a.pos[2], "path": a.get("path").unwrap_or("/") });
                if let Some(u) = a.get("url") {
                    c.insert("url".into(), json!(u));
                }
                if let Some(d) = a.get("domain") {
                    c.insert("domain".into(), json!(d));
                }
                if !c.contains_key("url") && !c.contains_key("domain") {
                    let Some(u) = self.active().map(|t| t.url()).filter(|u| u.starts_with("http")) else { return err("cookies set needs --url or --domain") };
                    c.insert("url".into(), json!(u));
                }
                if a.has("secure") {
                    c.insert("secure".into(), json!(true));
                }
                if a.has("http-only") || a.has("httpOnly") {
                    c.insert("httpOnly".into(), json!(true));
                }
                if let Some(s) = a.get("same-site") {
                    let mut ch = s.chars();
                    let v = ch.next().map(|f| f.to_uppercase().collect::<String>() + &ch.as_str().to_lowercase()).unwrap_or_default();
                    c.insert("sameSite".into(), json!(v));
                }
                if let Some(e) = a.get("expires").and_then(|e| e.parse::<f64>().ok()) {
                    c.insert("expires".into(), json!(e));
                }
                self.cdp.call("Storage.setCookies", obj!({ "cookies": [c] }), None, 30.0)?;
                Ok(Outcome::done())
            }
            "clear" => {
                self.cdp.call("Storage.clearCookies", Json::new(), None, 30.0)?;
                Ok(Outcome::done())
            }
            _ => err("usage: cookies [get|set|clear]"),
        }
    }

    fn storage(&self, a: &Args) -> Res<Outcome> {
        let kind = a.pos(0).unwrap_or_default();
        if kind != "local" && kind != "session" {
            return err("usage: storage local|session [key | set <k> <v> | clear]");
        }
        let t = self.tab()?;
        let s = if kind == "local" { "localStorage" } else { "sessionStorage" };
        let p = &a.pos[1..];
        let js = match p.first().map(String::as_str) {
            None => format!("Object.fromEntries(Object.entries({s}))"),
            Some("set") => {
                if p.len() < 3 {
                    return err(format!("usage: storage {kind} set <key> <value>"));
                }
                format!("({s}.setItem({}, {}), true)", quote(&p[1]), quote(&p[2..].join(" ")))
            }
            Some("clear") => format!("({s}.clear(), true)"),
            Some("remove") | Some("delete") => {
                if p.len() < 2 {
                    return err(format!("usage: storage {kind} remove <key>"));
                }
                format!("({s}.removeItem({}), true)", quote(&p[1]))
            }
            Some(k) => format!("{s}.getItem({})", quote(k)),
        };
        let v = self.eval_value(&t, &js)?;
        let text = if v.is_null() { String::new() } else { json_pretty(&v) };
        Ok(Outcome::new(json!({ "result": v }), text))
    }

    // ───────────── tabs ─────────────

    fn tab_command(&self, a: &Args) -> Res<Outcome> {
        let sub = a.pos(0).unwrap_or("list");
        let by_number = |s: &str| -> Res<String> {
            let n: i64 = s.strip_prefix('t').unwrap_or(s).parse().unwrap_or(-1);
            let list = self.pages()?;
            if let Some(hit) = list.iter().find(|p| p.str("targetId").map(|t| self.tab_number(t)) == Some(n)) {
                return Ok(hit.str("targetId").unwrap().to_string());
            }
            if let Some(hit) = list.iter().find(|p| p.str("targetId") == Some(s)) {
                return Ok(hit.str("targetId").unwrap().to_string());
            }
            err(format!("no tab {s} (tab list shows them)"))
        };
        match sub {
            "list" | "ls" => {
                let list = self.pages()?;
                let act = self.active().map(|t| t.target_id.clone());
                let (mut rows, mut lines) = (Vec::new(), Vec::new());
                for p in list {
                    let Some(tid) = p.str("targetId") else { continue };
                    let n = self.tab_number(tid);
                    let is = Some(tid) == act.as_deref();
                    let (title, url) = (p.str("title").unwrap_or_default(), p.str("url").unwrap_or_default());
                    rows.push(json!({ "tabId": format!("t{n}"), "targetId": tid, "title": title, "url": url, "active": is, "type": "page" }));
                    lines.push(format!("{} [t{n}] {title} - {url}", if is { "→" } else { " " }));
                }
                Ok(Outcome::new(json!({ "tabs": rows }), lines.join("\n")))
            }
            "new" => {
                let t = self.new_tab(a.pos(1).unwrap_or("about:blank"))?;
                let info = self.page_info(&t)?;
                let n = self.tab_number(&t.target_id);
                let url = info.str("url").unwrap_or_default();
                Ok(Outcome::new(json!({ "tabId": format!("t{n}"), "url": url }), format!("✓ t{n} {url}")))
            }
            "close" => {
                let tid = if let Some(x) = a.pos(1) {
                    Some(by_number(x)?)
                } else if let Some(act) = self.active().filter(|t| !t.gone()) {
                    Some(act.target_id.clone())
                } else if self.config.pin {
                    match read_state(&self.config.session).str("targetId").map(String::from) {
                        Some(saved) if self.pages()?.iter().any(|p| p.str("targetId") == Some(saved.as_str())) => Some(saved),
                        _ => None,
                    }
                } else {
                    None
                };
                let Some(tid) = tid else { return Ok(Outcome::new(json!({ "closed": false }), "no tab to close")) };
                self.cdp.call("Target.closeTarget", obj!({ "targetId": tid }), None, 30.0)?;
                if self.active().is_some_and(|t| t.target_id == tid) {
                    self.st().active = None;
                    if let Some(s) = self.stream() {
                        s.tab_changed();
                    }
                    if self.config.pin {
                        update_state(&self.config.session, |st| {
                            st.remove("targetId");
                        });
                    }
                }
                Ok(Outcome::data(json!({ "closed": true })))
            }
            _ => {
                let tid = by_number(sub)?;
                let t = self.attach(&tid)?;
                self.make_active(&t);
                let _ = self.cdp.call("Target.activateTarget", obj!({ "targetId": tid }), None, 30.0);
                let info = self.page_info(&t)?;
                let n = self.tab_number(&tid);
                let (url, title) = (info.str("url").unwrap_or_default(), info.str("title").unwrap_or_default());
                Ok(Outcome::new(json!({ "tabId": format!("t{n}"), "url": url, "title": title }), format!("✓ t{n} {title} - {url}")))
            }
        }
    }

    // ───────────── session / stream ─────────────

    fn session_info(&self) -> Outcome {
        let tab = self.active().map(|t| json!({ "targetId": t.target_id, "url": t.url() }));
        let d = json!({ "session": self.config.session, "pid": std::process::id(), "active": true, "cdp": self.cdp.endpoint, "tab": tab, "stream": self.stream().map(|s| s.port), "pinned": self.config.pin });
        let text = json_pretty(&d);
        Outcome::new(d, text)
    }

    fn stream_command(&self, a: &Args) -> Res<Outcome> {
        match a.pos(0).unwrap_or("status") {
            "status" => {
                let s = self.stream();
                let act = self.active();
                let d = json!({
                    "enabled": s.is_some(),
                    "connected": !self.cdp.closed() && act.as_ref().is_some_and(|t| !t.gone()),
                    "port": s.as_ref().map(|s| s.port),
                    "screencasting": act.as_ref().is_some_and(|t| t.s().screencasting),
                    "clients": s.as_ref().map(|s| s.client_count()).unwrap_or(0),
                });
                let text = json_pretty(&d);
                Ok(Outcome::new(d, text))
            }
            "enable" => {
                if self.stream().is_none() {
                    let port = a.get("port").and_then(|p| p.parse().ok()).unwrap_or(self.config.stream_port);
                    let s = crate::stream::StreamServer::start(&self.arc(), port)?;
                    *self.stream.lock().unwrap() = Some(s);
                }
                self.tab()?;
                let port = self.stream().map(|s| s.port).unwrap_or(0);
                Ok(Outcome::new(json!({ "port": port }), format!("✓ Streaming on ws://127.0.0.1:{port}")))
            }
            "disable" => {
                if let Some(s) = self.stream.lock().unwrap().take() {
                    s.stop();
                }
                Ok(Outcome::done())
            }
            _ => err("usage: stream status|enable|disable"),
        }
    }

    // ───────────── downloads ─────────────

    fn download(&self, t: &Arc<Tab>, sel: &str, path: &str, timeout_ms: f64) -> Res<Outcome> {
        let dir = base_dir().join(format!("dl-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        self.cdp.call("Browser.setDownloadBehavior", obj!({ "behavior": "allowAndName", "downloadPath": dir.display().to_string(), "eventsEnabled": true }), None, 30.0)?;
        self.st().downloads.clear();
        let el = self.element(t, sel)?;
        let r = self.click(t, &el, 1);
        self.release(t, &el);
        r?;
        let done = poll(timeout_ms, 100.0, "the download", || {
            let s = self.st();
            if let Some(d) = s.downloads.values().find(|d| d.str("state") == Some("canceled")) {
                return err(format!("the download was canceled ({})", d.str("suggestedFilename").unwrap_or_default()));
            }
            Ok(s.downloads.values().find(|d| d.str("state") == Some("completed")).cloned())
        })?;
        let Some(guid) = done.str("guid") else { return err("download finished without a file") };
        let _ = std::fs::remove_file(path);
        let from = dir.join(guid);
        if std::fs::rename(&from, path).is_err() {
            // another drive: copy, then remove
            std::fs::copy(&from, path).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&from);
        }
        let _ = self.cdp.call("Browser.setDownloadBehavior", obj!({ "behavior": "default" }), None, 30.0);
        Ok(Outcome::new(json!({ "path": path }), format!("✓ Downloaded to {path}")))
    }
}

const SELECT_JS: &str = r#"function(vals) {
  const s = this.tagName === 'SELECT' ? this : this.querySelector('select');
  if (!s) throw new Error('not a <select>');
  const picked = [];
  for (const o of s.options) {
    const hit = vals.some(v => o.value === v || o.label.trim() === v || o.textContent.trim() === v);
    if (hit && (s.multiple || !picked.length)) { o.selected = true; picked.push(o.value); } else if (s.multiple) o.selected = false;
  }
  if (!picked.length) throw new Error('no option matches ' + vals.join(', '));
  if (!s.multiple) s.value = picked[0];
  s.dispatchEvent(new Event('input', { bubbles: true }));
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return picked;
}"#;

const CLEAR_JS: &str = r#"function() {
  if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return; }
  if (typeof this.select === 'function') this.select();
}"#;

const SET_VALUE_JS: &str = r#"function(v) {
  if (this.isContentEditable || !('value' in this) || this.value === v) return;
  const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  set ? set.call(this, v) : (this.value = v);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
}"#;

#[derive(Clone, Copy)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

const VISIBLE_JS: &str = "function(){const r=this.getBoundingClientRect();const s=getComputedStyle(this);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}";
const TEXT_JS: &str = "function(){return (this.innerText ?? this.textContent ?? '').trim()}";
const STYLES_JS: &str = "function(){const s=getComputedStyle(this);const o={};for(const k of ['display','visibility','color','backgroundColor','fontSize','fontWeight','fontFamily','width','height','position','opacity'])o[k]=s[k];return o}";
