//! The pets: small transparent windows ("pet-0", "pet-1", …, one per pet picked) that live on the
//! whole screen, over other apps.
//! It walks the bottom of the screen and the tops of other apps' windows, falls, is picked up
//! and sleeps; it says when a job is done or needs the user. Its behaviour runs in the pet
//! window's own page (src/pet); here are only what a page can't do itself:
//!   - move and size its window every frame (pet_frame)
//!   - the other apps' windows on screen, for ledges to stand on (pet_windows)
//!   - the pets on disk (<data>/pets/<id>/pet.json + GIFs) and the folder jobs make them in
//!   - a pet shared as one file (<name>.ondrapet: a zip of its pet.json and pictures) and taken in from one
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
#[tauri::command(async)]
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
    if !pet_id_ok(&id) {
        return Err("bad pet id".into());
    }
    let dir = pets_dir(&app).join(&id);
    if !dir.join("pet.json").exists() {
        return Err("no such pet".into());
    }
    std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

// ───────────── sharing a pet as one file

/// what a shared pet holds: its pet.json and its pictures (not source/ or preview.png: not shown)
const SHARE_EXT: &str = "ondrapet";
const SHARE_KINDS: [&str; 4] = ["json", "gif", "png", "webp"];
const SHARE_MAX_FILE: u64 = 10 * 1024 * 1024;
const SHARE_MAX_ALL: u64 = 60 * 1024 * 1024;
const SHARE_MAX_FILES: usize = 64;

fn pet_id_ok(id: &str) -> bool {
    !id.is_empty() && !id.starts_with('.') && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// a scratch folder of its own (removed when dropped)
struct Scratch(std::path::PathBuf);
impl Scratch {
    fn new(what: &str) -> Result<Self, String> {
        let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let p = std::env::temp_dir().join(format!("ondra-{what}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&p).map_err(|e| e.to_string())?;
        Ok(Self(p))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The files of a pet folder that are shared, checked: plain files (no links), a kind a pet uses, not too big.
fn share_files(dir: &std::path::Path) -> Result<Vec<std::path::PathBuf>, String> {
    let mut out = vec![];
    let mut all = 0u64;
    for e in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
        let kind = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
        if !meta.is_file() || name.starts_with('.') || name == "preview.png" || !SHARE_KINDS.contains(&kind.as_str()) {
            continue;
        }
        if meta.len() > SHARE_MAX_FILE {
            return Err(format!("{name}: 파일이 너무 커요"));
        }
        all += meta.len();
        out.push(p);
    }
    if all > SHARE_MAX_ALL || out.len() > SHARE_MAX_FILES {
        return Err("펫이 너무 커요".into());
    }
    if !out.iter().any(|p| p.file_name().is_some_and(|n| n == "pet.json")) {
        return Err("pet.json이 없어요".into());
    }
    Ok(out)
}

/// A pet as one file in Downloads (<its name>.ondrapet), to send to someone; its path.
#[tauri::command]
pub async fn pet_export(app: AppHandle, id: String) -> Result<String, String> {
    if !pet_id_ok(&id) {
        return Err("bad pet id".into());
    }
    let dir = pets_dir(&app).join(&id);
    let files = share_files(&dir)?;
    let name = std::fs::read_to_string(dir.join("pet.json"))
        .ok()
        .and_then(|j| serde_json::from_str::<Value>(&j).ok())
        .and_then(|v| v.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .unwrap_or_else(|| id.clone());
    let clean: String = name.chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '\0' | '.')).take(60).collect();
    let clean = if clean.trim().is_empty() { id.clone() } else { clean.trim().to_string() };
    // staged as <id>/…: the archive's one folder names the pet when it is taken in
    let scratch = Scratch::new("pet-export")?;
    let stage = scratch.0.join(&id);
    std::fs::create_dir_all(&stage).map_err(|e| e.to_string())?;
    for f in &files {
        std::fs::copy(f, stage.join(f.file_name().unwrap_or_default())).map_err(|e| e.to_string())?;
    }
    let out_dir = crate::engine::home().join("Downloads");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let mut out = out_dir.join(format!("{clean}.{SHARE_EXT}"));
    let mut n = 2;
    while out.exists() {
        out = out_dir.join(format!("{clean} {n}.{SHARE_EXT}"));
        n += 1;
    }
    let ok = std::process::Command::new("/usr/bin/ditto")
        .args(["-c", "-k", "--norsrc", "--keepParent"])
        .arg(&stage)
        .arg(&out)
        .status()
        .map_err(|e| e.to_string())?;
    if !ok.success() {
        return Err("펫 파일을 만들지 못했어요".into());
    }
    Ok(out.to_string_lossy().into_owned())
}

/// A shared pet file taken in: a new folder in <data>/pets (another id when that one is taken); its id.
/// Only its pet.json and pictures are kept, checked, whatever else the file holds.
#[tauri::command]
pub async fn pet_import(app: AppHandle, path: String) -> Result<String, String> {
    let src = std::path::PathBuf::from(&path);
    let meta = std::fs::metadata(&src).map_err(|_| "파일을 찾지 못했어요".to_string())?;
    if !meta.is_file() || meta.len() > SHARE_MAX_ALL {
        return Err("펫 파일이 아니에요".into());
    }
    let scratch = Scratch::new("pet-import")?;
    let ok = std::process::Command::new("/usr/bin/ditto").args(["-x", "-k"]).arg(&src).arg(&scratch.0).status().map_err(|e| e.to_string())?;
    if !ok.success() {
        return Err("펫 파일이 아니에요".into());
    }
    // pet.json at the top, or in the one folder there (not macOS's __MACOSX)
    let root = if scratch.0.join("pet.json").is_file() {
        scratch.0.clone()
    } else {
        let dirs: Vec<_> = std::fs::read_dir(&scratch.0)
            .map_err(|e| e.to_string())?
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()) && !e.file_name().to_string_lossy().starts_with("__MACOSX"))
            .map(|e| e.path())
            .collect();
        match dirs.as_slice() {
            [d] if d.join("pet.json").is_file() => d.clone(),
            _ => return Err("펫 파일이 아니에요 (pet.json이 없어요)".into()),
        }
    };
    let json = std::fs::read_to_string(root.join("pet.json")).map_err(|e| e.to_string())?;
    let spec: Value = serde_json::from_str(&json).map_err(|_| "pet.json을 읽지 못했어요".to_string())?;
    if !spec.get("actions").is_some_and(|a| a.is_object()) {
        return Err("pet.json에 동작이 없어요".into());
    }
    let files = share_files(&root)?;
    // its id: the folder it came in, else the file's name, as letters, digits and -
    let base = if root != scratch.0 { root.file_name() } else { src.file_stem() }.map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let mut id: String = base.to_ascii_lowercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
    id = id.trim_matches('-').chars().take(48).collect();
    if !pet_id_ok(&id) || id == "default" {
        id = "pet".into();
    }
    let pets = pets_dir(&app);
    let mut dest = pets.join(&id);
    let mut n = 2;
    while dest.exists() {
        dest = pets.join(format!("{id}-{n}"));
        n += 1;
    }
    std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    for f in &files {
        if let Err(e) = std::fs::copy(f, dest.join(f.file_name().unwrap_or_default())) {
            let _ = std::fs::remove_dir_all(&dest);
            return Err(e.to_string());
        }
    }
    Ok(dest.file_name().unwrap_or_default().to_string_lossy().into_owned())
}

/// pet files opened with Ondra (double-clicked in Finder) not yet taken in: the page asks for them when it
/// loads, and again on "pet:opened" (a file opened while it runs)
static OPENED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Files the system asked Ondra to open: the pet files among them wait for the page.
pub fn opened(app: &AppHandle, paths: Vec<std::path::PathBuf>) {
    let pets: Vec<String> = paths
        .into_iter()
        .filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case(SHARE_EXT)))
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    if pets.is_empty() {
        return;
    }
    if let Ok(mut q) = OPENED.lock() {
        q.extend(pets);
    }
    let _ = app.emit_to("main", "pet:opened", ());
}

#[tauri::command]
pub fn pet_opened() -> Vec<String> {
    OPENED.lock().map(|mut q| std::mem::take(&mut *q)).unwrap_or_default()
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
