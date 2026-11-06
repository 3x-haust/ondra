//! The in-app browser: a real webview inside the main window, laid over the
//! right panel where the page shows it. The page reports where that area is;
//! this moves, shows and hides the webview, and drives it (open, back, reload).
//! Sign-ins made here are copied into the shared browser the jobs use, so a
//! job that needs the site is signed in too.

use std::process::Stdio;

use serde::Serialize;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl};

const LABEL: &str = "inbrowser";
const HOME: &str = "https://www.google.com";

#[derive(Clone, Serialize)]
struct PageState {
    url: String,
    loading: bool,
}

fn webview(app: &AppHandle) -> Option<Webview> {
    app.get_webview(LABEL)
}

fn parse(url: &str) -> Option<Url> {
    Url::parse(url).ok().filter(|u| matches!(u.scheme(), "http" | "https"))
}

fn bounds(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(w.max(1.0), h.max(1.0)).into() }
}

/// Copy this site's cookies into the shared browser (logins carry over to jobs).
fn share_cookies(app: AppHandle, wv: Webview, url: Url) {
    std::thread::spawn(move || {
        let Ok(cookies) = wv.cookies_for_url(url) else { return };
        let Some(port) = crate::browser::port(&app) else { return };
        for c in cookies {
            let Some(mut cmd) = crate::tools::agent_browser(&app) else { return };
            for (k, v) in crate::browser::attach_env(port, &format!("ondra-cookies-{port}")) {
                cmd.env(k, v);
            }
            let domain = c.domain().unwrap_or_default().to_string();
            if domain.is_empty() {
                continue;
            }
            cmd.args(["cookies", "set", c.name(), c.value(), "--domain", &domain, "--path", c.path().unwrap_or("/")]);
            if c.secure() == Some(true) {
                cmd.arg("--secure");
            }
            if c.http_only() == Some(true) {
                cmd.arg("--http-only");
            }
            if let Some(s) = c.same_site() {
                cmd.args(["--same-site", &s.to_string()]);
            }
            if let Some(t) = c.expires_datetime() {
                cmd.args(["--expires", &t.unix_timestamp().to_string()]);
            }
            let _ = cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
        }
    });
}

/// Show the browser over the given area (logical px from the window's top left),
/// making it the first time. `url` opens a page.
#[tauri::command]
pub async fn inbrowser_show(app: AppHandle, x: f64, y: f64, w: f64, h: f64, url: Option<String>) -> Result<(), String> {
    let target = url.as_deref().and_then(parse);
    if let Some(wv) = webview(&app) {
        wv.set_bounds(bounds(x, y, w, h)).map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        if let Some(u) = target {
            wv.navigate(u).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let window = app.get_window("main").ok_or("창을 찾을 수 없어요")?;
    let start = target.unwrap_or_else(|| Url::parse(HOME).expect("home url"));
    let events = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(start)).on_page_load(move |wv, p| {
        let loading = matches!(p.event(), PageLoadEvent::Started);
        let _ = events.emit("inbrowser-page", PageState { url: p.url().to_string(), loading });
        if !loading {
            share_cookies(events.clone(), wv, p.url().clone());
        }
    });
    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w.max(1.0), h.max(1.0)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Hide it (the panel closed or shows something else); the page stays loaded.
#[tauri::command]
pub fn inbrowser_hide(app: AppHandle) {
    if let Some(wv) = webview(&app) {
        let _ = wv.hide();
    }
}

/// Open a page, or go back / forward / reload.
#[tauri::command]
pub fn inbrowser_go(app: AppHandle, action: String, url: Option<String>) -> Result<(), String> {
    let wv = webview(&app).ok_or("브라우저가 아직 없어요")?;
    match action.as_str() {
        "open" => wv.navigate(url.as_deref().and_then(parse).ok_or("주소가 올바르지 않아요")?),
        "back" => wv.eval("history.back()"),
        "forward" => wv.eval("history.forward()"),
        "reload" => wv.reload(),
        _ => return Err("unknown action".into()),
    }
    .map_err(|e| e.to_string())
}
