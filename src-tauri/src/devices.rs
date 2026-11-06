// Device hub: iOS simulators and Android emulators/phones, in one list.
// Jobs make new simulators, use them and shut them down; this lets the user see
// and drive that from the app (boot, shut down, delete, a live screenshot).
use serde::Serialize;
use std::{
    path::PathBuf,
    process::{Command, Stdio},
};
use tauri::AppHandle;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// iOS: UDID. Android: the AVD name (emulator) or the adb serial (phone).
    pub id: String,
    pub name: String,
    /// "ios" | "android"
    pub platform: String,
    /// "simulator" | "emulator" | "phone"
    pub kind: String,
    /// e.g. "iOS 26.3", "sdk_gphone64_arm64"
    pub runtime: String,
    pub booted: bool,
    /// adb serial while an emulator runs (emulator-5554)
    pub serial: Option<String>,
    /// ms since epoch, iOS only
    pub last_used: Option<i64>,
}

fn sdk() -> PathBuf {
    std::env::var("ANDROID_HOME")
        .or_else(|_| std::env::var("ANDROID_SDK_ROOT"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs_home().join("Library/Android/sdk"))
}
/// What makes an emulator light for testing: drawn on the Mac's GPU (headless,
/// plain `-gpu auto` falls back to drawing in software on the CPU), no sound, no
/// boot animation. Its window is the device hub, so it has none of its own.
pub const LEAN: [&str; 5] = ["-no-window", "-gpu", "auto-no-window", "-no-audio", "-no-boot-anim"];

/// The Android SDK jobs see: the real one, except that an emulator a job starts
/// (by its own script or a repo's test runner) boots lean (`LEAN`) unless it
/// asked otherwise. Its screen shows in the device hub instead of a separate app
/// on the user's desktop. Everything else links to the real SDK, so builds and
/// adb work as before.
pub fn job_sdk(data: &std::path::Path) -> Option<PathBuf> {
    let real = sdk();
    let real_emu = real.join("emulator/emulator");
    if !real_emu.exists() {
        return None;
    }
    let dir = data.join("android-sdk");
    let emu = dir.join("emulator");
    std::fs::create_dir_all(&emu).ok()?;
    let link_all = |from: &std::path::Path, to: &std::path::Path, skip: &str| {
        for e in std::fs::read_dir(from).into_iter().flatten().flatten() {
            let name = e.file_name();
            let at = to.join(&name);
            if name != skip && std::fs::symlink_metadata(&at).is_err() {
                let _ = std::os::unix::fs::symlink(e.path(), at);
            }
        }
    };
    link_all(&real, &dir, "emulator");
    link_all(&real.join("emulator"), &emu, "emulator");
    let real_emu = real_emu.display().to_string().replace('\'', "'\\''");
    let script = format!(
        "#!/bin/sh\n# Ondra: an emulator a job boots runs lean (no window, GPU drawing, no sound or boot animation); the device hub shows it\nreal='{real_emu}'\nboot=; win=; gpu=; audio=; anim=\nfor a in \"$@\"; do case \"$a\" in -avd|@*) boot=1;; -no-window|-qt-hide-window) win=1;; -gpu) gpu=1;; -no-audio|-audio) audio=1;; -no-boot-anim) anim=1;; esac; done\n[ -z \"$boot\" ] && exec \"$real\" \"$@\"\nextra=\n[ -z \"$win\" ] && extra=\"$extra -no-window\"\n[ -z \"$gpu\" ] && extra=\"$extra -gpu auto-no-window\"\n[ -z \"$audio\" ] && extra=\"$extra -no-audio\"\n[ -z \"$anim\" ] && extra=\"$extra -no-boot-anim\"\nexec \"$real\" $extra \"$@\"\n"
    );
    let path = emu.join("emulator");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(script.as_str()) {
        let _ = std::fs::remove_file(&path);
        std::fs::write(&path, script).ok()?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).ok()?;
    }
    Some(dir)
}

fn dirs_home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}
fn adb() -> PathBuf {
    sdk().join("platform-tools/adb")
}
fn emulator() -> PathBuf {
    sdk().join("emulator/emulator")
}

fn out(cmd: &mut Command) -> Option<String> {
    let o = cmd.stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// "2026-11-03T10:20:30Z" → ms (good enough for sorting; no chrono dependency)
fn chrono_like(s: &str) -> Option<i64> {
    let d: Vec<i64> = s.split(|c: char| !c.is_ascii_digit()).filter(|x| !x.is_empty()).take(6).filter_map(|x| x.parse().ok()).collect();
    if d.len() < 6 {
        return None;
    }
    let (y, m, day) = (d[0], d[1], d[2]);
    let a = (14 - m) / 12;
    let yy = y + 4800 - a;
    let mm = m + 12 * a - 3;
    let jdn = day + (153 * mm + 2) / 5 + 365 * yy + yy / 4 - yy / 100 + yy / 400 - 32045;
    let days = jdn - 2440588;
    Some(((days * 86400) + d[3] * 3600 + d[4] * 60 + d[5]) * 1000)
}

fn ios() -> Vec<Device> {
    let Some(json) = out(Command::new("xcrun").args(["simctl", "list", "devices", "-j"])) else { return vec![] };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&json) else { return vec![] };
    let mut list = vec![];
    if let Some(map) = v["devices"].as_object() {
        for (runtime, devs) in map {
            // com.apple.CoreSimulator.SimRuntime.iOS-26-3 → iOS 26.3
            let rt = runtime.rsplit('.').next().unwrap_or(runtime).replacen('-', " ", 1).replace('-', ".");
            for d in devs.as_array().into_iter().flatten() {
                if d["isAvailable"].as_bool() == Some(false) {
                    continue;
                }
                list.push(Device {
                    id: d["udid"].as_str().unwrap_or_default().into(),
                    name: d["name"].as_str().unwrap_or_default().into(),
                    platform: "ios".into(),
                    kind: "simulator".into(),
                    runtime: rt.clone(),
                    booted: d["state"].as_str() == Some("Booted"),
                    serial: None,
                    last_used: d["lastBootedAt"].as_str().or(d["lastUsedAt"].as_str()).and_then(chrono_like),
                });
            }
        }
    }
    list
}

/// An emulator's AVD name: asked once per connection (serial + adb's transport id,
/// which changes when another emulator takes the port), not on every listing.
fn avd_of(serial: &str, key: &str, model: &str, live: &[String]) -> String {
    static NAMES: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());
    let mut names = NAMES.lock().unwrap_or_else(|e| e.into_inner());
    names.retain(|(k, _)| live.iter().any(|l| l == k));
    if let Some((_, n)) = names.iter().find(|(k, _)| k == key) {
        return n.clone();
    }
    let asked = out(Command::new(adb()).args(["-s", serial, "emu", "avd", "name"])).and_then(|s| s.lines().next().map(|l| l.trim().to_string())).filter(|s| !s.is_empty());
    match asked {
        Some(n) => {
            names.push((key.to_string(), n.clone()));
            n
        }
        None => model.to_string(),
    }
}

fn android() -> Vec<Device> {
    let mut list: Vec<Device> = vec![];
    // what runs now: emulators (with their AVD name) and phones
    let mut running: Vec<(String, String, String)> = vec![]; // (serial, avd or model, kind)
    if let Some(txt) = out(Command::new(adb()).args(["devices", "-l"])) {
        let key = |l: &str| format!("{} {}", l.split_whitespace().next().unwrap_or(""), l.split_whitespace().find(|p| p.starts_with("transport_id:")).unwrap_or(""));
        let live: Vec<String> = txt.lines().skip(1).map(key).collect();
        for line in txt.lines().skip(1) {
            let mut parts = line.split_whitespace();
            let (Some(serial), Some(state)) = (parts.next(), parts.next()) else { continue };
            if state != "device" {
                continue;
            }
            let model = line.split_whitespace().find_map(|p| p.strip_prefix("model:")).unwrap_or(serial).to_string();
            if serial.starts_with("emulator-") {
                running.push((serial.into(), avd_of(serial, &key(line), &model, &live), "emulator".into()));
            } else {
                running.push((serial.into(), model, "phone".into()));
            }
        }
    }
    if let Some(txt) = out(Command::new(emulator()).arg("-list-avds")) {
        for avd in txt.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("INFO")) {
            let run = running.iter().find(|r| r.2 == "emulator" && r.1 == avd);
            list.push(Device {
                id: avd.into(),
                name: avd.replace('_', " "),
                platform: "android".into(),
                kind: "emulator".into(),
                runtime: "Android 에뮬레이터".into(),
                booted: run.is_some(),
                serial: run.map(|r| r.0.clone()),
                last_used: None,
            });
        }
    }
    for (serial, model, kind) in running.iter().filter(|r| r.2 == "phone") {
        list.push(Device {
            id: serial.clone(),
            name: model.replace('_', " "),
            platform: "android".into(),
            kind: kind.clone(),
            runtime: "Android 기기".into(),
            booted: true,
            serial: Some(serial.clone()),
            last_used: None,
        });
    }
    list
}

#[tauri::command]
pub async fn devices_list() -> Vec<Device> {
    let a = tauri::async_runtime::spawn_blocking(ios);
    let b = tauri::async_runtime::spawn_blocking(android);
    let mut all = a.await.unwrap_or_default();
    all.extend(b.await.unwrap_or_default());
    all
}

fn run(cmd: &mut Command) -> Result<(), String> {
    let o = cmd.stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if o.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&o.stderr).trim().chars().take(300).collect())
    }
}

#[tauri::command]
pub async fn device_boot(platform: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if platform == "ios" {
            // no Simulator.app: the hub shows the screen and takes touches itself, and the
            // app would draw a second copy of it (hundreds of MB and GPU time) for nobody
            match run(Command::new("xcrun").args(["simctl", "boot", &id])) {
                Err(e) if !e.contains("current state: Booted") => Err(e),
                _ => Ok(()),
            }
        } else {
            Command::new(emulator())
                .args(["-avd", &id])
                .args(LEAN)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn device_shutdown(platform: String, id: String, serial: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if platform == "ios" {
            run(Command::new("xcrun").args(["simctl", "shutdown", &id]))
        } else {
            let s = serial.ok_or("실행 중이 아니에요")?;
            run(Command::new(adb()).args(["-s", &s, "emu", "kill"]))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn device_delete(platform: String, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if platform == "ios" {
            run(Command::new("xcrun").args(["simctl", "delete", &id]))
        } else {
            let avdmanager = sdk().join("cmdline-tools/latest/bin/avdmanager");
            if avdmanager.is_file() {
                run(Command::new(avdmanager).args(["delete", "avd", "-n", &id]))
            } else {
                // without cmdline-tools: remove the AVD folder and its .ini
                let dir = dirs_home().join(".android/avd");
                std::fs::remove_dir_all(dir.join(format!("{id}.avd"))).map_err(|e| e.to_string())?;
                std::fs::remove_file(dir.join(format!("{id}.ini"))).map_err(|e| e.to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A fresh screenshot of a running device, as a PNG file.
#[tauri::command]
pub async fn device_shot(app: AppHandle, platform: String, id: String, serial: Option<String>) -> Result<String, String> {
    // under app data so the page can show it (asset scope)
    let dir = crate::engine::data_dir(&app).join("devices");
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
        let path = dir.join(format!("{safe}.{}", if platform == "ios" { "jpg" } else { "png" }));
        let p = path.display().to_string();
        if platform == "ios" {
            run(Command::new("xcrun").args(["simctl", "io", &id, "screenshot", "--type=jpeg", &p]))?;
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

// ───────────── driving a device from the app (tap, swipe, type, home, back)
//
// The page sends positions as fractions of the screen (0..1), so it doesn't need
// to know the device's size. Android: adb input in pixels. iOS: the touch helper
// in `live`, which takes fractions as they are.

pub mod live;

fn android_size(serial: &str) -> Option<(f64, f64)> {
    let txt = out(Command::new(adb()).args(["-s", serial, "shell", "wm", "size"]))?;
    // "Override size" wins over "Physical size"
    let line = txt.lines().find(|l| l.starts_with("Override")).or_else(|| txt.lines().find(|l| l.contains("size")))?;
    let (w, h) = line.rsplit(' ').next()?.split_once('x')?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

/// `adb shell input text` takes one shell word: spaces as %s, shell characters dropped.
fn android_text(t: &str) -> String {
    t.replace(' ', "%s").replace(['\'', '"', '`', '$', '\\', ';', '&', '|', '<', '>', '(', ')'], "")
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn device_input(
    platform: String,
    id: String,
    serial: Option<String>,
    action: String,
    x: Option<f64>,
    y: Option<f64>,
    x2: Option<f64>,
    y2: Option<f64>,
    text: Option<String>,
    ms: Option<u32>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (fx, fy, fx2, fy2) = (x.unwrap_or(0.5), y.unwrap_or(0.5), x2.unwrap_or(0.5), y2.unwrap_or(0.5));
        if platform == "ios" {
            return live::ios_input(&id, &action, (fx, fy, fx2, fy2), text);
        }
        let s = serial.ok_or("실행 중이 아니에요")?;
        let (w, h) = android_size(&s).ok_or("화면 크기를 못 읽었어요")?;
        // wm size is the portrait size; input takes the turned one
        let (w, h) = if live::landscape(&id) { (w.max(h), w.min(h)) } else { (w, h) };
        let p = |f: f64, n: f64| ((f.clamp(0.0, 1.0) * n).round() as i64).to_string();
        let args: Vec<String> = match action.as_str() {
            "tap" => vec!["tap".into(), p(fx, w), p(fy, h)],
            "swipe" => vec!["swipe".into(), p(fx, w), p(fy, h), p(fx2, w), p(fy2, h), ms.unwrap_or(250).clamp(80, 2000).to_string()],
            "text" => vec!["text".into(), android_text(&text.unwrap_or_default())],
            "home" => vec!["keyevent".into(), "3".into()],
            "back" => vec!["keyevent".into(), "4".into()],
            "enter" => vec!["keyevent".into(), "66".into()],
            _ => return Err("모르는 조작이에요".into()),
        };
        let mut cmd = Command::new(adb());
        cmd.args(["-s", &s, "shell", "input"]).args(&args);
        run(&mut cmd)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_job_emulator_boots_without_a_window() {
        let root = std::env::temp_dir().join(format!("ondra-sdk-test-{}", std::process::id()));
        let real = root.join("real");
        std::fs::create_dir_all(real.join("emulator")).unwrap();
        std::fs::create_dir_all(real.join("platform-tools")).unwrap();
        let fake = real.join("emulator/emulator");
        std::fs::write(&fake, "#!/bin/sh\necho \"$@\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        // only this test reads ANDROID_HOME
        unsafe { std::env::set_var("ANDROID_HOME", &real) };

        let sdk = job_sdk(&root.join("data")).unwrap();
        let run = |args: &[&str]| String::from_utf8(Command::new(sdk.join("emulator/emulator")).args(args).output().unwrap().stdout).unwrap();

        let lean = "-no-window -gpu auto-no-window -no-audio -no-boot-anim";
        assert_eq!(run(&["-avd", "pixel", "-port", "5600"]).trim(), format!("{lean} -avd pixel -port 5600"));
        assert_eq!(run(&["@pixel"]).trim(), format!("{lean} @pixel"));
        // what the job asked for wins
        assert_eq!(run(&["-avd", "pixel", "-no-window", "-gpu", "swiftshader_indirect"]).trim(), "-no-audio -no-boot-anim -avd pixel -no-window -gpu swiftshader_indirect");
        assert_eq!(run(&["-list-avds"]).trim(), "-list-avds");
        assert!(sdk.join("platform-tools").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
