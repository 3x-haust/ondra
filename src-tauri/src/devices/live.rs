// Live device screens and input.
//
// iOS: `ondra-simhelper` (src-tauri/helpers/simhelper.swift) reads the simulator's
// framebuffer and sends JPEG frames only when the screen changes; a second, long-lived
// helper per simulator injects touches, buttons and keys through SimulatorKit's HID
// client. Android: `adb exec-out screencap` in a loop, and `adb shell input`.
//
// Frames go to the page over a Tauri channel as raw bytes; an empty frame means the
// stream ended (the page then falls back to screenshots).
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use tauri::ipc::{Channel, InvokeResponseBody};

use super::{adb, run};

const TRIPLE: &str = if cfg!(target_arch = "aarch64") { "aarch64-apple-darwin" } else { "x86_64-apple-darwin" };

/// The bundled helper; in development also straight from src-tauri/binaries.
fn simhelper() -> Result<PathBuf, String> {
    crate::tools::sidecar("ondra-simhelper")
        .or_else(|| {
            let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!("binaries/ondra-simhelper-{TRIPLE}"));
            p.exists().then_some(p)
        })
        .ok_or_else(|| "시뮬레이터 도우미가 없어요. src-tauri/helpers/build.sh 로 만들어 주세요.".to_string())
}

fn kill(mut c: Child) {
    let _ = c.kill();
    let _ = c.wait();
}

// ───────────── screen streams

enum Stream {
    Proc(Child),
    Flag(Arc<AtomicBool>),
}
fn streams() -> &'static Mutex<HashMap<u64, Stream>> {
    static S: OnceLock<Mutex<HashMap<u64, Stream>>> = OnceLock::new();
    S.get_or_init(Default::default)
}
static NEXT: AtomicU64 = AtomicU64::new(1);

fn end_stream(token: u64) {
    let s = streams().lock().ok().and_then(|mut m| m.remove(&token));
    match s {
        Some(Stream::Proc(c)) => kill(c),
        Some(Stream::Flag(f)) => f.store(true, Ordering::Relaxed),
        None => {}
    }
}

/// Start sending a device's screen to `on_frame`. Returns a token for `device_stream_stop`.
/// `max` caps the longest side in pixels (iOS); `fps` caps the frame rate.
#[tauri::command]
pub async fn device_stream(platform: String, id: String, serial: Option<String>, max: u32, fps: u32, on_frame: Channel<InvokeResponseBody>) -> Result<u64, String> {
    let token = NEXT.fetch_add(1, Ordering::Relaxed);
    let fps = fps.clamp(1, 60);
    if platform == "ios" {
        let mut child = Command::new(simhelper()?)
            .args(["stream", &id, &fps.to_string(), &max.clamp(320, 4000).to_string()])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut out = child.stdout.take().ok_or("no stdout")?;
        if let Ok(mut m) = streams().lock() {
            m.insert(token, Stream::Proc(child));
        }
        std::thread::spawn(move || {
            let mut len = [0u8; 4];
            while out.read_exact(&mut len).is_ok() {
                let n = u32::from_be_bytes(len) as usize;
                if n == 0 || n > 64 << 20 {
                    break;
                }
                let mut buf = vec![0u8; n];
                if out.read_exact(&mut buf).is_err() || on_frame.send(InvokeResponseBody::Raw(buf)).is_err() {
                    break;
                }
            }
            let _ = on_frame.send(InvokeResponseBody::Raw(vec![]));
            end_stream(token);
        });
    } else {
        let serial = serial.ok_or("실행 중이 아니에요")?;
        let stop = Arc::new(AtomicBool::new(false));
        if let Ok(mut m) = streams().lock() {
            m.insert(token, Stream::Flag(stop.clone()));
        }
        let every = Duration::from_millis(1000 / fps as u64);
        std::thread::spawn(move || {
            let mut fails = 0;
            while !stop.load(Ordering::Relaxed) {
                let t = Instant::now();
                // PNG straight from the device: no temp file, no extra copy
                let o = Command::new(adb()).args(["-s", &serial, "exec-out", "screencap", "-p"]).stdin(Stdio::null()).stderr(Stdio::null()).output();
                match o {
                    Ok(o) if o.status.success() && o.stdout.len() > 8 => {
                        fails = 0;
                        if stop.load(Ordering::Relaxed) || on_frame.send(InvokeResponseBody::Raw(o.stdout)).is_err() {
                            break;
                        }
                    }
                    _ => {
                        fails += 1;
                        if fails > 3 {
                            break;
                        }
                    }
                }
                if let Some(rest) = every.checked_sub(t.elapsed()) {
                    std::thread::sleep(rest);
                }
            }
            if !stop.load(Ordering::Relaxed) {
                let _ = on_frame.send(InvokeResponseBody::Raw(vec![]));
            }
            end_stream(token);
        });
    }
    Ok(token)
}

#[tauri::command]
pub fn device_stream_stop(token: u64) {
    end_stream(token);
}

// ───────────── iOS input: one touch helper per simulator, kept open

struct Touch {
    child: Child,
    stdin: ChildStdin,
}
fn touches() -> &'static Mutex<HashMap<String, Touch>> {
    static T: OnceLock<Mutex<HashMap<String, Touch>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

/// Start the helper and wait for its "ready" line: frames written before it are lost.
fn spawn_touch(id: &str) -> Result<Touch, String> {
    let mut child = Command::new(simhelper()?)
        .args(["touch", id])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let out = child.stdout.take().ok_or("no stdout")?;
    let err = child.stderr.take().ok_or("no stderr")?;
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    let tx2 = tx.clone();
    std::thread::spawn(move || {
        let mut line = String::new();
        let ok = BufReader::new(out).read_line(&mut line).is_ok() && line.trim() == "ready";
        let _ = tx.send(if ok { Ok(()) } else { Err("입력 도우미가 멈췄어요".into()) });
    });
    std::thread::spawn(move || {
        // the helper's last error, if it quits before it's ready
        let mut last = String::new();
        for l in BufReader::new(err).lines().map_while(Result::ok) {
            if l.starts_with("error:") {
                last = l.trim_start_matches("error:").trim().to_string();
            }
        }
        if !last.is_empty() {
            let _ = tx2.send(Err(format!("입력을 못 보냈어요: {last}")));
        }
    });
    match rx.recv_timeout(Duration::from_secs(8)) {
        Ok(Ok(())) => {
            let stdin = child.stdin.take().ok_or("no stdin")?;
            Ok(Touch { child, stdin })
        }
        Ok(Err(e)) => {
            kill(child);
            Err(e)
        }
        Err(_) => {
            kill(child);
            Err("입력 도우미가 응답하지 않아요".into())
        }
    }
}

/// Write frames to the simulator's touch helper, starting (or restarting) it as needed.
fn touch_send(id: &str, frames: &[Vec<u8>]) -> Result<(), String> {
    let mut map = touches().lock().map_err(|e| e.to_string())?;
    for attempt in 0..2 {
        if !map.contains_key(id) {
            let t = spawn_touch(id)?;
            map.insert(id.to_string(), t);
        }
        let t = map.get_mut(id).unwrap();
        let alive = t.child.try_wait().map(|s| s.is_none()).unwrap_or(false);
        let ok = alive && frames.iter().all(|f| t.stdin.write_all(f).is_ok()) && t.stdin.flush().is_ok();
        if ok {
            return Ok(());
        }
        if let Some(t) = map.remove(id) {
            kill(t.child);
        }
        if attempt == 1 {
            break;
        }
    }
    Err("입력을 못 보냈어요".into())
}

fn coord(kind: u8, x: f64, y: f64) -> Vec<u8> {
    let mut b = vec![kind];
    b.extend_from_slice(&(x.clamp(0.0, 1.0) as f32).to_be_bytes());
    b.extend_from_slice(&(y.clamp(0.0, 1.0) as f32).to_be_bytes());
    b
}
fn words(kind: u8, a: u32, b: u32) -> Vec<u8> {
    let mut v = vec![kind];
    v.extend_from_slice(&a.to_be_bytes());
    v.extend_from_slice(&b.to_be_bytes());
    v
}
fn key_frame(mods: u8, usage: u32) -> Vec<u8> {
    let mut v = vec![9, mods, 0, 0, 0];
    v.extend_from_slice(&usage.to_be_bytes());
    v
}

/// Start the input helper ahead of the first touch, so that one isn't late.
#[tauri::command]
pub async fn device_input_warm(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || touch_send(&id, &[])).await.map_err(|e| e.to_string())?
}

/// One step of a live touch on an iOS simulator: "down" | "move" | "up", x/y as 0..1.
/// The page sends them one after another (it waits for each), so they stay in order.
#[tauri::command]
pub async fn device_touch(id: String, phase: String, x: f64, y: f64) -> Result<(), String> {
    let kind = match phase.as_str() {
        "down" => 1,
        "move" => 2,
        "up" => 3,
        _ => return Err("모르는 조작이에요".into()),
    };
    tauri::async_runtime::spawn_blocking(move || touch_send(&id, &[coord(kind, x, y)])).await.map_err(|e| e.to_string())?
}

/// Stop the simulator's input helper (the page closed the device).
#[tauri::command]
pub fn device_release(id: String) {
    let t = touches().lock().ok().and_then(|mut m| m.remove(&id));
    if let Some(t) = t {
        kill(t.child);
    }
}

/// HID keyboard usage (page 7) for a physical key (KeyboardEvent.code).
fn hid_code(code: &str) -> Option<u32> {
    if let Some(c) = code.strip_prefix("Key").filter(|c| c.len() == 1).and_then(|c| c.chars().next()).filter(char::is_ascii_uppercase) {
        return Some(0x04 + (c as u32 - 'A' as u32));
    }
    if let Some(d) = code.strip_prefix("Digit").and_then(|d| d.parse::<u32>().ok()).filter(|d| *d <= 9) {
        return Some(if d == 0 { 0x27 } else { 0x1D + d });
    }
    Some(match code {
        "Enter" | "NumpadEnter" => 0x28,
        "Escape" => 0x29,
        "Backspace" => 0x2A,
        "Tab" => 0x2B,
        "Space" => 0x2C,
        "Minus" => 0x2D,
        "Equal" => 0x2E,
        "BracketLeft" => 0x2F,
        "BracketRight" => 0x30,
        "Backslash" => 0x31,
        "Semicolon" => 0x33,
        "Quote" => 0x34,
        "Backquote" => 0x35,
        "Comma" => 0x36,
        "Period" => 0x37,
        "Slash" => 0x38,
        "Delete" => 0x4C,
        "ArrowRight" => 0x4F,
        "ArrowLeft" => 0x50,
        "ArrowDown" => 0x51,
        "ArrowUp" => 0x52,
        _ => return None,
    })
}

/// Text goes through the simulator's pasteboard and ⌘V, so any language works.
fn ios_paste(id: &str, text: &str) -> Result<(), String> {
    let mut c = Command::new("xcrun").args(["simctl", "pbcopy", id]).stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
    if let Some(mut i) = c.stdin.take() {
        i.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    }
    if !c.wait().map(|s| s.success()).unwrap_or(false) {
        return Err("글자를 못 보냈어요".into());
    }
    // pbcopy exiting doesn't mean the device has it yet (and some Xcode/runtime pairs
    // drop it): wait until the device's pasteboard shows the text, then press ⌘V
    let t = Instant::now();
    loop {
        let now = super::out(Command::new("xcrun").args(["simctl", "pbpaste", id])).unwrap_or_default();
        if now.trim_end_matches('\n') == text.trim_end_matches('\n') {
            break;
        }
        if t.elapsed() > Duration::from_millis(1500) {
            return Err("시뮬레이터 클립보드에 글자를 못 넣었어요. 화면을 누르고 직접 타이핑해 주세요.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    touch_send(id, &[key_frame(0x08, 0x19)])
}

/// tap / swipe / text / home / back / enter on an iOS simulator.
pub fn ios_input(id: &str, action: &str, (x, y, x2, y2): (f64, f64, f64, f64), text: Option<String>) -> Result<(), String> {
    match action {
        "tap" => {
            touch_send(id, &[coord(1, x, y)])?;
            std::thread::sleep(Duration::from_millis(60));
            touch_send(id, &[coord(3, x, y)])
        }
        "swipe" | "back" => {
            // back: a swipe in from the left edge
            let (x, y, x2, y2) = if action == "back" { (0.005, 0.5, 0.7, 0.5) } else { (x, y, x2, y2) };
            touch_send(id, &[coord(1, x, y)])?;
            for i in 1..=12 {
                std::thread::sleep(Duration::from_millis(16));
                let k = i as f64 / 12.0;
                touch_send(id, &[coord(2, x + (x2 - x) * k, y + (y2 - y) * k)])?;
            }
            touch_send(id, &[coord(3, x2, y2)])
        }
        "text" => ios_paste(id, &text.unwrap_or_default()),
        // consumer-page Menu: the legacy home button does nothing on Face ID phones (iOS 26)
        "home" => touch_send(id, &[words(4, 0x0C, 0x40)]),
        "enter" => touch_send(id, &[key_frame(0, 0x28)]),
        _ => Err("모르는 조작이에요".into()),
    }
}

/// One key typed on the computer while the device screen has focus: KeyboardEvent's
/// `key` (a character or a name like "Enter") and `code` (the physical key).
/// iOS gets the physical key, like a hardware keyboard, so the device's own input
/// source (Korean, English, ...) decides what it types.
#[tauri::command]
pub async fn device_key(platform: String, id: String, serial: Option<String>, key: String, code: String, shift: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if platform == "ios" {
            return match hid_code(&code) {
                Some(u) => touch_send(&id, &[key_frame(if shift { 0x02 } else { 0 }, u)]),
                None if key.chars().count() == 1 => ios_paste(&id, &key),
                None => Ok(()),
            };
        } else {
            let s = serial.ok_or("실행 중이 아니에요")?;
            let code = match key.as_str() {
                "Enter" => Some("66"),
                "Backspace" => Some("67"),
                "Tab" => Some("61"),
                "Escape" => Some("111"),
                "Delete" => Some("112"),
                "ArrowUp" => Some("19"),
                "ArrowDown" => Some("20"),
                "ArrowLeft" => Some("21"),
                "ArrowRight" => Some("22"),
                _ => None,
            };
            let mut cmd = Command::new(adb());
            cmd.args(["-s", &s, "shell", "input"]);
            match code {
                Some(c) => cmd.args(["keyevent", c]),
                None if key == " " => cmd.args(["keyevent", "62"]),
                None => cmd.args(["text", &super::android_text(&key)]),
            };
            run(&mut cmd)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

// ───────────── toolbar: keyboard, rotation, screenshot, recording

fn state() -> &'static Mutex<HashMap<String, (bool, u8)>> {
    // per device: software keyboard shown, rotation step
    static S: OnceLock<Mutex<HashMap<String, (bool, u8)>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Show or hide the simulator's on-screen keyboard. Returns whether it is now shown.
#[tauri::command]
pub async fn device_keyboard(id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let shown = !state().lock().map(|m| m.get(&id).map(|s| s.0).unwrap_or(false)).unwrap_or(false);
        let o = Command::new(simhelper()?).args(["keyboard", if shown { "show" } else { "hide" }, &id]).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
        if !o.status.success() {
            return Err("키보드를 못 바꿨어요".into());
        }
        if let Ok(mut m) = state().lock() {
            m.entry(id).or_default().0 = shown;
        }
        Ok(shown)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Whether the device was turned to landscape from here.
pub fn landscape(id: &str) -> bool {
    state().lock().map(|m| m.get(id).map(|s| s.1 == 1).unwrap_or(false)).unwrap_or(false)
}

/// Whether the device is turned to landscape (from here), for a page that just opened.
#[tauri::command]
pub fn device_landscape(id: String) -> bool {
    landscape(&id)
}

/// Turn the device a quarter: portrait ↔ landscape. Returns true when it is now landscape.
/// (An iOS simulator's framebuffer stays portrait; the page turns the picture.)
#[tauri::command]
pub async fn device_rotate(platform: String, id: String, serial: Option<String>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let step = state().lock().map(|m| m.get(&id).map(|s| s.1).unwrap_or(0)).unwrap_or(0);
        let next = (step + 1) % 2;
        if platform == "ios" {
            let o = Command::new(simhelper()?)
                .args(["rotate", if next == 1 { "landscapeLeft" } else { "portrait" }, &id])
                .stdin(Stdio::null())
                .output()
                .map_err(|e| e.to_string())?;
            if !o.status.success() {
                return Err("화면을 못 돌렸어요".into());
            }
        } else {
            let s = serial.ok_or("실행 중이 아니에요")?;
            run(Command::new(adb()).args(["-s", &s, "shell", "settings", "put", "system", "accelerometer_rotation", "0"]))?;
            run(Command::new(adb()).args(["-s", &s, "shell", "settings", "put", "system", "user_rotation", &next.to_string()]))?;
        }
        if let Ok(mut m) = state().lock() {
            m.entry(id).or_default().1 = next;
        }
        Ok(next == 1)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ~/Desktop/<name> <date time>.<ext>, like Simulator's own screenshots.
fn desktop_file(name: &str, ext: &str) -> PathBuf {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    let dir = [home.join("Desktop"), home.clone()].into_iter().find(|d| d.is_dir()).unwrap_or(home);
    let stamp = Command::new("date").arg("+%Y-%m-%d %H.%M.%S").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let safe: String = name.chars().map(|c| if c == '/' || c == ':' { '-' } else { c }).collect();
    dir.join(format!("{safe} {stamp}.{ext}"))
}

/// Save a full-size screenshot to the Desktop. Returns its path.
#[tauri::command]
pub async fn device_screenshot(platform: String, id: String, serial: Option<String>, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = desktop_file(&name, "png");
        let p = path.display().to_string();
        if platform == "ios" {
            run(Command::new("xcrun").args(["simctl", "io", &id, "screenshot", "--type=png", &p]))?;
        } else {
            let s = serial.ok_or("실행 중이 아니에요")?;
            let o = Command::new(adb()).args(["-s", &s, "exec-out", "screencap", "-p"]).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
            if !o.status.success() || o.stdout.is_empty() {
                return Err("화면을 못 가져왔어요".into());
            }
            std::fs::write(&path, o.stdout).map_err(|e| e.to_string())?;
        }
        Ok(p)
    })
    .await
    .map_err(|e| e.to_string())?
}

struct Rec {
    child: Child,
    path: PathBuf,
    serial: Option<String>,
}
fn recs() -> &'static Mutex<HashMap<String, Rec>> {
    static R: OnceLock<Mutex<HashMap<String, Rec>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// Start or stop recording the screen. Returns the saved file when it stops, "" when it starts.
#[tauri::command]
pub async fn device_record(platform: String, id: String, serial: Option<String>, name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let running = recs().lock().ok().and_then(|mut m| m.remove(&id));
        if let Some(mut r) = running {
            // stop: SIGINT lets the recorder finish the file
            if let Some(s) = &r.serial {
                let _ = run(Command::new(adb()).args(["-s", s, "shell", "pkill", "-INT", "screenrecord"]));
            } else {
                let _ = Command::new("kill").args(["-INT", &r.child.id().to_string()]).status();
            }
            let t = Instant::now();
            while r.child.try_wait().map(|s| s.is_none()).unwrap_or(false) && t.elapsed() < Duration::from_secs(10) {
                std::thread::sleep(Duration::from_millis(100));
            }
            kill(r.child);
            if let Some(s) = &r.serial {
                std::thread::sleep(Duration::from_millis(600));
                run(Command::new(adb()).args(["-s", s, "pull", "/sdcard/ondra-record.mp4", &r.path.display().to_string()]))?;
                let _ = run(Command::new(adb()).args(["-s", s, "shell", "rm", "-f", "/sdcard/ondra-record.mp4"]));
            }
            return if r.path.exists() { Ok(r.path.display().to_string()) } else { Err("녹화 파일을 못 만들었어요".into()) };
        }
        let (child, path, serial) = if platform == "ios" {
            let path = desktop_file(&name, "mov");
            let c = Command::new("xcrun")
                .args(["simctl", "io", &id, "recordVideo", "--codec=h264", "--force", &path.display().to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            (c, path, None)
        } else {
            let s = serial.ok_or("실행 중이 아니에요")?;
            let c = Command::new(adb())
                .args(["-s", &s, "shell", "screenrecord", "/sdcard/ondra-record.mp4"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            (c, desktop_file(&name, "mp4"), Some(s))
        };
        recs().lock().map_err(|e| e.to_string())?.insert(id, Rec { child, path, serial });
        Ok(String::new())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Ids of devices being recorded right now (the page shows a stop button for them).
#[tauri::command]
pub fn device_recording() -> Vec<String> {
    recs().lock().map(|m| m.keys().cloned().collect()).unwrap_or_default()
}
