//! The pets: small transparent windows ("pet-0", "pet-1", …, one per pet picked) that live on the
//! whole screen, over other apps.
//! It walks the bottom of the screen and the tops of other apps' windows, falls, is picked up
//! and sleeps; it says when a job is done or needs the user. Its behaviour runs in the pet
//! window's own page (src/pet); here are only what a page can't do itself:
//!   - move and size its window every frame (pet_frame)
//!   - the other apps' windows on screen, for ledges to stand on (pet_windows)
//!   - the pets on disk (<data>/pets/<id>/pet.json + GIFs) and the folder jobs make them in
//!   - the main window's word passed on (pet_set / pet_say) and the pet's click passed back (pet_clicked)
use serde::Serialize;
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
#[cfg(not(target_os = "macos"))]
use tauri::{LogicalPosition, LogicalSize};

/// the last config the main window set: the pet page asks for it when it loads
static CONFIG: Mutex<Option<Value>> = Mutex::new(None);

pub fn pets_dir(app: &AppHandle) -> std::path::PathBuf {
    let dir = crate::engine::data_dir(app).join("pets");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[derive(Serialize)]
pub struct PetOnDisk {
    id: String,
    dir: String,
    /// pet.json as written (the page checks it)
    json: String,
}

/// The pets jobs made: every folder in <data>/pets with a pet.json.
#[tauri::command]
pub fn pet_list(app: AppHandle) -> Vec<PetOnDisk> {
    let dir = pets_dir(&app);
    let mut out = vec![];
    let Ok(rd) = std::fs::read_dir(&dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        let Ok(json) = std::fs::read_to_string(p.join("pet.json")) else { continue };
        let id = e.file_name().to_string_lossy().to_string();
        if id.starts_with('.') {
            continue;
        }
        out.push(PetOnDisk { id, dir: p.display().to_string(), json });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// A pet made by a job, thrown away: its folder in <data>/pets (only a plain folder name there).
#[tauri::command]
pub fn pet_delete(app: AppHandle, id: String) -> Result<(), String> {
    if id.is_empty() || id.starts_with('.') || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.') {
        return Err("bad pet id".into());
    }
    let dir = pets_dir(&app).join(&id);
    if !dir.join("pet.json").exists() {
        return Err("no such pet".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pet_folder(app: AppHandle) -> String {
    pets_dir(&app).display().to_string()
}

/// most pets on screen at once
const MAX_PETS: usize = 5;

/// One pet's window: transparent, no frame, over everything, on every desktop, never taking focus.
fn open_pet(app: &AppHandle, i: usize) -> Option<tauri::WebviewWindow> {
    let label = format!("pet-{i}");
    if let Some(w) = app.get_webview_window(&label) {
        return Some(w);
    }
    tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App(format!("index.html#pet/{i}").into()))
        .title("Ondra 펫")
        .inner_size(96.0, 96.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .visible_on_all_workspaces(true)
        .accept_first_mouse(true)
        .shadow(false)
        .visible(false)
        .build()
        .ok()
}

/// The main window sets what the pets are (on, which ones, how big): a window per pet is opened (or
/// closed), shown, and told.
#[tauri::command]
pub async fn pet_set(app: AppHandle, config: Value) {
    let on = config.get("on").and_then(|v| v.as_bool()).unwrap_or(false);
    let n = if on { config.get("ids").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(1).clamp(1, MAX_PETS) } else { 0 };
    *CONFIG.lock().unwrap() = Some(config.clone());
    for (label, w) in app.webview_windows() {
        let Some(i) = label.strip_prefix("pet-").and_then(|s| s.parse::<usize>().ok()) else { continue };
        if i >= n {
            let _ = w.close();
        }
    }
    for i in 0..n {
        if let Some(w) = open_pet(&app, i) {
            let _ = w.emit_to(w.label(), "pet:config", config.clone());
            if !w.is_visible().unwrap_or(false) {
                let _ = w.show();
            }
        }
    }
}

#[tauri::command]
pub fn pet_get() -> Option<Value> {
    CONFIG.lock().unwrap().clone()
}

/// Something for the pets to say or do (a job ended, needs an answer, the answer came): every pet
/// reacts, the first one says it.
#[tauri::command]
pub fn pet_say(app: AppHandle, word: Value) {
    for (label, w) in app.webview_windows() {
        if label.starts_with("pet-") {
            let _ = w.emit_to(w.label(), "pet:say", word.clone());
        }
    }
}

/// The pet was clicked on what it said: the main window opens that job.
#[tauri::command]
pub fn pet_clicked(app: AppHandle, word: Value) {
    let _ = app.emit_to("main", "pet:open", word);
    if let Some(w) = app.get_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// From the pet, quietly: an answer to a job's question, or "hide me". The main window acts on it.
#[tauri::command]
pub fn pet_tell(app: AppHandle, word: Value) {
    let _ = app.emit_to("main", "pet:tell", word);
}

/// Where the pet's window is, in screen points (top-left origin), and how big. On macOS place and size
/// change in one step (setFrame): two steps (size, then position) show the window at the new size in
/// the old place for a frame, and the pet blinks and jumps.
#[tauri::command]
pub fn pet_frame(app: AppHandle, window: tauri::WebviewWindow, x: f64, y: f64, w: f64, h: f64) {
    let win = window;
    let (w, h) = (w.max(1.0), h.max(1.0));
    #[cfg(target_os = "macos")]
    {
        let Ok(ns) = win.ns_window() else { return };
        let addr = ns as usize;
        let _ = app.run_on_main_thread(move || mac::set_frame(addr, x, y, w, h));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = win.set_size(LogicalSize::new(w, h));
        let _ = win.set_position(LogicalPosition::new(x, y));
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Rect {
    id: i64,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

/// Other apps' windows on screen, front to back, in points with the top-left origin
/// (the window server's own coordinates: no permission is needed for bounds).
#[tauri::command]
pub fn pet_windows() -> Vec<Rect> {
    #[cfg(target_os = "macos")]
    {
        mac::windows()
    }
    #[cfg(not(target_os = "macos"))]
    {
        vec![]
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Rect;
    use objc2::runtime::AnyObject;
    use objc2::msg_send;
    use objc2_foundation::NSString;
    use std::ffi::c_void;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: *const c_void);
    }
    /// The pet window's frame, from top-left screen points to Cocoa's (origin at the main screen's bottom left),
    /// in one call. Main thread only.
    pub fn set_frame(ns: usize, x: f64, y: f64, w: f64, h: f64) {
        use objc2::runtime::AnyClass;
        use objc2_foundation::{NSPoint, NSRect, NSSize};
        let Some(ns) = (unsafe { (ns as *mut AnyObject).as_ref() }) else { return };
        let Some(screen_cls) = AnyClass::get(c"NSScreen") else { return };
        unsafe {
            let screens: *mut AnyObject = msg_send![screen_cls, screens];
            let Some(screens) = screens.as_ref() else { return };
            let main: *mut AnyObject = msg_send![screens, firstObject];
            let Some(main) = main.as_ref() else { return };
            let f: NSRect = msg_send![main, frame];
            let now: NSRect = msg_send![ns, frame];
            let r = NSRect::new(NSPoint::new(x, f.size.height - y - h), NSSize::new(w, h));
            if (now.origin.x - r.origin.x).abs() < 0.5 && (now.origin.y - r.origin.y).abs() < 0.5 && (now.size.width - w).abs() < 0.5 && (now.size.height - h).abs() < 0.5 {
                return;
            }
            let _: () = msg_send![ns, setFrame: r, display: true];
        }
    }

    /// kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements
    const OPTIONS: u32 = 1 | 16;

    unsafe fn get(dict: &AnyObject, key: &str) -> Option<&'static AnyObject> {
        let k = NSString::from_str(key);
        let v: *mut AnyObject = msg_send![dict, objectForKey: &*k];
        unsafe { v.as_ref() }
    }
    unsafe fn num(o: Option<&AnyObject>) -> Option<f64> {
        let o = o?;
        Some(msg_send![o, doubleValue])
    }

    pub fn windows() -> Vec<Rect> {
        let me = std::process::id() as f64;
        let mut out = vec![];
        unsafe {
            let list = CGWindowListCopyWindowInfo(OPTIONS, 0);
            if list.is_null() {
                return out;
            }
            // a CFArray of CFDictionary is an NSArray of NSDictionary (toll-free bridged)
            let arr = &*(list as *const AnyObject);
            let n: usize = msg_send![arr, count];
            for i in 0..n {
                let d: *mut AnyObject = msg_send![arr, objectAtIndex: i];
                let Some(d) = d.as_ref() else { continue };
                // layer 0: ordinary app windows (not the menu bar, the Dock or overlays)
                if num(get(d, "kCGWindowLayer")) != Some(0.0) {
                    continue;
                }
                if num(get(d, "kCGWindowOwnerPID")) == Some(me) {
                    continue;
                }
                if num(get(d, "kCGWindowAlpha")).unwrap_or(1.0) < 0.1 {
                    continue;
                }
                let Some(b) = get(d, "kCGWindowBounds") else { continue };
                let (Some(x), Some(y), Some(w), Some(h)) = (num(get(b, "X")), num(get(b, "Y")), num(get(b, "Width")), num(get(b, "Height"))) else { continue };
                if w < 80.0 || h < 40.0 {
                    continue;
                }
                let id = num(get(d, "kCGWindowNumber")).unwrap_or(0.0) as i64;
                out.push(Rect { id, x, y, w, h });
            }
            CFRelease(list);
        }
        out
    }
}
