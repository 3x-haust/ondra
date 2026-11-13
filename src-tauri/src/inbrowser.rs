//! The in-app browser: a real webview inside the main window, laid over the
//! right panel where the page shows it. The page reports where that area is;
//! this moves, shows and hides the webview, and drives it (open, back, reload).
//! Sign-ins made here are copied into the shared browser the jobs use, so a
//! job that needs the site is signed in too.
//!
//! Each space has its own webview with its own cookie store, and copies only into
//! that space's browser: a login in one space never shows up in the other.

use std::process::Stdio;

use serde::Serialize;
use tauri::webview::{Cookie, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl};

const LABEL: &str = "inbrowser";
const HOME: &str = "https://www.google.com";

#[derive(Clone, Serialize)]
struct PageState {
    url: String,
    loading: bool,
    space: String,
}

fn label(space: &str) -> String {
    format!("{LABEL}-{}", crate::browser::space_key(space))
}

fn webview(app: &AppHandle, space: &str) -> Option<Webview> {
    app.get_webview(&label(space))
}

/// Every space's webview.
fn all(app: &AppHandle) -> Vec<Webview> {
    app.webviews().into_iter().filter(|(l, _)| l.starts_with(LABEL)).map(|(_, w)| w).collect()
}

/// The space's own WebKit data store (cookies, storage), stable across runs.
fn store_id(space: &str) -> [u8; 16] {
    let mut out = [0u8; 16];
    for (half, seed) in [(0usize, 0xcbf2_9ce4_8422_2325u64), (8, 0x9e37_79b9_7f4a_7c15)] {
        let mut h = seed;
        for b in format!("ondra-browser-{}", crate::browser::space_key(space)).bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        out[half..half + 8].copy_from_slice(&h.to_be_bytes());
    }
    out
}

fn parse(url: &str) -> Option<Url> {
    Url::parse(url).ok().filter(|u| matches!(u.scheme(), "http" | "https"))
}

fn bounds(x: f64, y: f64, w: f64, h: f64) -> Rect {
    Rect { position: LogicalPosition::new(x, y).into(), size: LogicalSize::new(w.max(1.0), h.max(1.0)).into() }
}

/// Copy cookies into the shared browser (logins carry over to jobs). Cookies
/// belong to the whole browser, so the command is not tied to any tab.
fn push_cookies(app: &AppHandle, space: &str, cookies: Vec<Cookie<'static>>) {
    let Some(port) = crate::browser::port(app, space) else { return };
    for c in cookies {
        let domain = c.domain().unwrap_or_default().to_string();
        if domain.is_empty() {
            continue;
        }
        let Some(mut cmd) = crate::tools::browser_command(app) else { return };
        for (k, v) in crate::browser::attach_env(port, &format!("ondra-cookies-{port}")) {
            cmd.env(k, v);
        }
        cmd.args(["--no-pin-tab", "cookies", "set", c.name(), c.value(), "--domain", &domain, "--path", c.path().unwrap_or("/")]);
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
}

fn share_cookies(app: AppHandle, space: String, wv: Webview, url: Url) {
    std::thread::spawn(move || {
        if let Ok(cookies) = wv.cookies_for_url(url) {
            push_cookies(&app, &space, cookies);
        }
    });
}

/// Copy the cookies for `url` (or all of them) now and wait until they are in:
/// the user says they signed in, and the job goes on right after.
#[tauri::command]
pub async fn inbrowser_share(app: AppHandle, url: Option<String>, space: Option<String>) -> Result<(), String> {
    let space = space.unwrap_or_default();
    let Some(wv) = webview(&app, &space) else { return Ok(()) };
    tauri::async_runtime::spawn_blocking(move || {
        let cookies = match url.as_deref().and_then(parse) {
            Some(u) => wv.cookies_for_url(u),
            None => wv.cookies(),
        };
        if let Ok(c) = cookies {
            push_cookies(&app, &space, c);
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Show the browser over the given area (logical px from the window's top left),
/// making it the first time. `url` opens a page.
#[tauri::command]
pub async fn inbrowser_show(app: AppHandle, x: f64, y: f64, w: f64, h: f64, url: Option<String>, space: Option<String>) -> Result<(), String> {
    let space = space.unwrap_or_default();
    let target = url.as_deref().and_then(parse);
    // only this space's page shows
    for other in all(&app) {
        if other.label() != label(&space) {
            let _ = other.hide();
        }
    }
    if let Some(wv) = webview(&app, &space) {
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
    let sp = space.clone();
    let builder = WebviewBuilder::new(label(&space), WebviewUrl::External(start)).data_store_identifier(store_id(&space)).on_page_load(move |wv, p| {
        let loading = matches!(p.event(), PageLoadEvent::Started);
        let _ = events.emit("inbrowser-page", PageState { url: p.url().to_string(), loading, space: sp.clone() });
        if !loading {
            share_cookies(events.clone(), sp.clone(), wv, p.url().clone());
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
    for wv in all(&app) {
        let _ = wv.hide();
    }
}

/// Open a page, or go back / forward / reload.
#[tauri::command]
pub fn inbrowser_go(app: AppHandle, action: String, url: Option<String>, space: Option<String>) -> Result<(), String> {
    let wv = webview(&app, &space.unwrap_or_default()).ok_or("브라우저가 아직 없어요")?;
    match action.as_str() {
        "open" => wv.navigate(url.as_deref().and_then(parse).ok_or("주소가 올바르지 않아요")?),
        "back" => wv.eval("history.back()"),
        "forward" => wv.eval("history.forward()"),
        "reload" => wv.reload(),
        _ => return Err("unknown action".into()),
    }
    .map_err(|e| e.to_string())
}
