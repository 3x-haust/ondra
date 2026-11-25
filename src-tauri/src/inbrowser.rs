//! The in-app browser: a real webview inside the main window, laid over the
//! right panel where the page shows it. The page reports where that area is;
//! this moves, shows and hides the webview, and drives it (open, back, reload).
//! Sign-ins made here are copied into the shared browser the jobs use, so a
//! job that needs the site is signed in too.
//!
//! Each space has its own webview with its own cookie store, and copies only into
//! that space's browser: a login in one space never shows up in the other.

use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
#[cfg(target_os = "macos")]
use std::sync::OnceLock;

use serde::Serialize;
use tauri::webview::{Cookie, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl, WebviewWindowBuilder};

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

/// Safari's own user agent. The webview's default leaves out "Version/… Safari/…", and
/// Google's sign-in refuses such embedded browsers.
#[cfg(target_os = "macos")]
fn user_agent() -> &'static str {
    static UA: OnceLock<String> = OnceLock::new();
    UA.get_or_init(|| {
        let v = std::process::Command::new("/usr/bin/defaults")
            .args(["read", "/Applications/Safari.app/Contents/Info", "CFBundleShortVersionString"])
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "26.0".into());
        format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{v} Safari/605.1.15")
    })
}

// ───────────── popups: "Google 계정으로 계속하기", payments, OAuth ─────────────
//
// A page's window.open gets a real window that shares the page's WebKit session, so
// what it signs in lands in the page (and so in the jobs' browser). WebKit tells nobody
// when the popup closes itself, so its window.close goes through a navigation this
// catches, and the popups still open close once the page that opened them moves on
// (the sign-in finished and the site redirected).

const POPUP: &str = "ondra-popup";
const CLOSE_URL: &str = "https://ondra-popup.invalid/close";

fn popups(app: &AppHandle) -> Vec<tauri::WebviewWindow> {
    app.webview_windows().into_iter().filter(|(l, _)| l.starts_with(POPUP)).map(|(_, w)| w).collect()
}

/// popup label → the address its opener was on when it opened
static OPENED_ON: std::sync::Mutex<std::collections::BTreeMap<String, String>> = std::sync::Mutex::new(std::collections::BTreeMap::new());

/// each space's webview → the page it last finished loading
static PAGE_OF: std::sync::Mutex<std::collections::BTreeMap<String, String>> = std::sync::Mutex::new(std::collections::BTreeMap::new());

/// The opener finished loading `now`: close the popups it opened on another page.
fn close_left_popups(app: &AppHandle, opener: &str, now: &Url) {
    PAGE_OF.lock().unwrap().insert(opener.to_string(), now.to_string());
    let mut on = OPENED_ON.lock().unwrap();
    for w in popups(app) {
        let l = w.label().to_string();
        if on.get(&l).is_some_and(|u| !u.is_empty() && u != now.as_str()) {
            on.remove(&l);
            let _ = w.close();
        }
    }
    on.retain(|l, _| app.get_webview_window(l).is_some());
}

fn open_popup(app: &AppHandle, opened_on: &str, url: Url, features: tauri::webview::NewWindowFeatures) -> NewWindowResponse<tauri::Wry> {
    static N: AtomicU32 = AtomicU32::new(1);
    let label = format!("{POPUP}-{}", N.fetch_add(1, Ordering::Relaxed));
    let close_script = format!(
        "(() => {{ const close = () => {{ location.href = {CLOSE_URL:?}; }}; try {{ Object.defineProperty(window, 'close', {{ value: close }}); }} catch {{ window.close = close; }} }})();"
    );
    let me = app.clone();
    let mine = label.clone();
    let positioned = features.position().is_some();
    let mut b = WebviewWindowBuilder::new(app, &label, WebviewUrl::External("about:blank".parse().expect("blank")))
        .window_features(features)
        .title(url.host_str().unwrap_or("로그인"))
        .initialization_script(&close_script)
        .on_navigation(move |u| {
            if u.as_str() == CLOSE_URL {
                if let Some(w) = me.get_webview_window(&mine) {
                    let _ = w.close();
                }
                return false;
            }
            true
        })
        .on_document_title_changed(|w, title| {
            if !title.is_empty() {
                let _ = w.set_title(&title);
            }
        });
    #[cfg(target_os = "macos")]
    { b = b.user_agent(user_agent()); }
    if !positioned {
        b = b.center();
    }
    match b.build() {
        Ok(window) => {
            OPENED_ON.lock().unwrap().insert(label, opened_on.to_string());
            NewWindowResponse::Create { window }
        }
        Err(_) => NewWindowResponse::Deny,
    }
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
    let popup_app = app.clone();
    let popup_label = label(&space);
    let builder = WebviewBuilder::new(label(&space), WebviewUrl::External(start));
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(store_id(&space)).user_agent(user_agent());
    #[cfg(windows)]
    let builder = builder.data_directory(crate::engine::data_dir(&app).join("webviews").join(format!("space-{:x}", u128::from_be_bytes(store_id(&space)))));
    let builder = builder.on_new_window(move |url, features| {
            let on = PAGE_OF.lock().unwrap().get(&popup_label).cloned().unwrap_or_default();
            open_popup(&popup_app, &on, url, features)
        })
        .on_page_load(move |wv, p| {
            let loading = matches!(p.event(), PageLoadEvent::Started);
            if !loading {
                close_left_popups(&events, wv.label(), p.url());
            }
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
