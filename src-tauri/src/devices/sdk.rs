//! The Android SDK for a computer that has none (no Android Studio). adb comes in by itself the
//! first time the device hub or the `device` tool needs it (a few MB); the emulator and a system
//! image (about a gigabyte and a half) come in once the user agrees to the license. Both straight
//! from Google's repository, the XML sdkmanager reads, so no Java is needed. They live in
//! `<data dir>/android/sdk`, never in the app bundle. An SDK the user installed comes first
//! (`super::sdk`); this one is used only for what that one lacks, and then whole, never mixed.

use serde::Serialize;
use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter};

const REPO: &str = "https://dl.google.com/android/repository/repository2-3.xml";
/// AOSP images: the smallest (no Google Play services)
const IMAGES: &str = "https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml";
const BASE: &str = "https://dl.google.com/android/repository/";
const IMAGES_BASE: &str = "https://dl.google.com/android/repository/sys-img/android/";
/// The AVD made for the downloaded image
pub const AVD: &str = "Pixel";

static DATA: OnceLock<PathBuf> = OnceLock::new();
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn init(app: &AppHandle) {
    set_data(crate::engine::data_dir(app));
    let _ = APP.set(app.clone());
}

/// The app's data folder, under which Ondra's SDK lives.
pub fn set_data(dir: PathBuf) {
    let _ = DATA.set(dir);
}

/// Where Ondra keeps its own Android SDK (None before the app set it up, as in tests).
pub fn managed() -> Option<PathBuf> {
    DATA.get().map(|d| d.join("android").join("sdk"))
}

// ───────────── Google's repository ─────────────

#[derive(Clone, Debug, PartialEq)]
pub struct Archive {
    pub url: String,
    pub size: u64,
    pub sha1: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Package {
    /// "platform-tools", "emulator", "system-images;android-36;default;x86_64"
    pub path: String,
    pub license: String,
    pub archive: Archive,
}

/// This computer in the repository's words: host-os and host-arch.
pub fn host() -> (&'static str, &'static str) {
    let os = if cfg!(target_os = "macos") { "macosx" } else if cfg!(windows) { "windows" } else { "linux" };
    let arch = if cfg!(target_arch = "aarch64") { "aarch64" } else { "x64" };
    (os, arch)
}

/// The system image ABI this computer runs fast.
pub fn abi() -> &'static str {
    if cfg!(target_arch = "aarch64") { "arm64-v8a" } else { "x86_64" }
}

/// The stable (channel-0) packages of one repository XML with an archive for this host,
/// and the license texts it carries.
pub fn parse(xml: &str, base: &str, os: &str, arch: &str) -> (Vec<Package>, HashMap<String, String>) {
    use quick_xml::{events::Event, Reader};
    let mut r = Reader::from_str(xml);
    let mut stack: Vec<String> = Vec::new();
    let (mut packages, mut licenses) = (Vec::new(), HashMap::new());
    // the package being read: path, channel, license, archives (os, arch, url, size, sha1)
    let mut path = String::new();
    let (mut channel, mut license) = (String::new(), String::new());
    let mut archives: Vec<(String, String, Archive)> = Vec::new();
    let mut cur: (String, String, Archive) = (String::new(), String::new(), Archive { url: String::new(), size: 0, sha1: String::new() });
    let mut license_id: Option<String> = None;
    let mut text = String::new();
    let attr = |e: &quick_xml::events::BytesStart, name: &str| e.try_get_attribute(name).ok().flatten().and_then(|a| a.unescape_value().ok()).map(|v| v.into_owned()).unwrap_or_default();
    loop {
        let ev = match r.read_event() {
            Ok(ev) => ev,
            Err(_) => break,
        };
        match ev {
            Event::Eof => break,
            Event::Start(e) => {
                let name = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                match name.as_str() {
                    "remotePackage" => {
                        path = attr(&e, "path");
                        (channel, license) = (String::new(), String::new());
                        archives.clear();
                    }
                    "archive" => cur = (String::new(), String::new(), Archive { url: String::new(), size: 0, sha1: String::new() }),
                    "license" => license_id = Some(attr(&e, "id")),
                    _ => {}
                }
                text.clear();
                stack.push(name);
            }
            Event::Empty(e) => {
                let name = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                match name.as_str() {
                    "channelRef" if stack.last().is_some_and(|p| p == "remotePackage") => channel = attr(&e, "ref"),
                    "uses-license" if stack.last().is_some_and(|p| p == "remotePackage") => license = attr(&e, "ref"),
                    _ => {}
                }
            }
            Event::Text(t) => text.push_str(&t.decode().unwrap_or_default()),
            Event::CData(t) => text.push_str(&String::from_utf8_lossy(&t)),
            Event::GeneralRef(g) => {
                let n = String::from_utf8_lossy(&g).into_owned();
                text.push_str(match n.as_str() {
                    "quot" => "\"",
                    "apos" => "'",
                    "amp" => "&",
                    "lt" => "<",
                    "gt" => ">",
                    _ => "",
                });
            }
            Event::End(_) => {
                let name = stack.pop().unwrap_or_default();
                let parent = stack.last().map(String::as_str).unwrap_or("");
                let value = text.trim().to_string();
                match (parent, name.as_str()) {
                    ("archive", "host-os") => cur.0 = value,
                    ("archive", "host-arch") => cur.1 = value,
                    ("complete", "size") => cur.2.size = value.parse().unwrap_or(0),
                    ("complete", "checksum") => cur.2.sha1 = value.to_lowercase(),
                    ("complete", "url") => cur.2.url = format!("{base}{value}"),
                    (_, "archive") => archives.push(std::mem::replace(&mut cur, (String::new(), String::new(), Archive { url: String::new(), size: 0, sha1: String::new() }))),
                    (_, "license") => {
                        if let Some(id) = license_id.take() {
                            licenses.insert(id, text.trim().to_string());
                        }
                    }
                    (_, "remotePackage") if channel == "channel-0" => {
                        let fits = |(o, a, _): &&(String, String, Archive)| (o.is_empty() || o == os) && (a.is_empty() || a == arch);
                        if let Some((_, _, a)) = archives.iter().find(fits) {
                            if !a.url.is_empty() && a.size > 0 && a.sha1.len() == 40 {
                                packages.push(Package { path: path.clone(), license: license.clone(), archive: a.clone() });
                            }
                        }
                    }
                    _ => {}
                }
                text.clear();
            }
            _ => {}
        }
    }
    (packages, licenses)
}

/// The newest stable AOSP image for `abi` ("system-images;android-36;default;x86_64").
pub fn newest_image<'a>(images: &'a [Package], abi: &str) -> Option<&'a Package> {
    let api = |p: &Package| -> Option<u32> {
        let mut parts = p.path.split(';');
        (parts.next()? == "system-images").then_some(())?;
        let api = parts.next()?.strip_prefix("android-")?.parse().ok()?;
        (parts.next()? == "default" && parts.next()? == abi).then_some(api)
    };
    images.iter().filter_map(|p| api(p).map(|a| (a, p))).max_by_key(|(a, _)| *a).map(|(_, p)| p)
}

/// What the emulator needs from the repository: the emulator and an image, with their licenses.
#[derive(Clone, Debug)]
pub struct Plan {
    pub tools: Option<Package>,
    pub emulator: Option<Package>,
    pub image: Option<Package>,
    pub licenses: HashMap<String, String>,
}

static PLAN: Mutex<Option<Plan>> = Mutex::new(None);

async fn fetch_text(url: &str) -> Result<String, String> {
    let http = crate::components::client()?;
    let res = http.get(url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    res.text().await.map_err(|e| e.to_string())
}

async fn plan() -> Result<Plan, String> {
    if let Some(p) = PLAN.lock().unwrap().clone() {
        return Ok(p);
    }
    let (os, arch) = host();
    let (repo, images) = (fetch_text(REPO).await?, fetch_text(IMAGES).await?);
    let (tools, mut licenses) = parse(&repo, BASE, os, arch);
    let (imgs, more) = parse(&images, IMAGES_BASE, os, arch);
    licenses.extend(more);
    let p = Plan {
        tools: tools.iter().find(|p| p.path == "platform-tools").cloned(),
        emulator: tools.iter().find(|p| p.path == "emulator").cloned(),
        image: newest_image(&imgs, abi()).cloned(),
        licenses,
    };
    *PLAN.lock().unwrap() = Some(p.clone());
    Ok(p)
}

// ───────────── getting a package in place ─────────────

/// Where a package goes in the SDK: `;` in its path is a folder level.
pub fn place(sdk: &Path, package: &str) -> PathBuf {
    package.split(';').fold(sdk.to_path_buf(), |p, part| p.join(part))
}

fn sha1_file(path: &Path) -> Result<String, String> {
    use sha1::{Digest, Sha1};
    let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha1::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Unpack a repository zip into `dest`, without its one top folder (`platform-tools/`,
/// `emulator/`, `x86_64/`), keeping what may run and the links between files.
pub fn unzip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| e.to_string())?;
        // enclosed_name refuses `..` and absolute paths
        let Some(name) = entry.enclosed_name() else { continue };
        let inner: PathBuf = name.components().skip(1).collect();
        if inner.as_os_str().is_empty() {
            continue;
        }
        let out = dest.join(&inner);
        if entry.is_dir() {
            std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mode = entry.unix_mode();
        #[cfg(unix)]
        if mode.is_some_and(|m| m & 0o170000 == 0o120000) {
            let mut target = String::new();
            entry.read_to_string(&mut target).map_err(|e| e.to_string())?;
            // a link may only point inside the package
            let at = out.parent().unwrap_or(dest).join(&target);
            if Path::new(&target).is_absolute() || !normalized(&at).starts_with(dest) {
                continue;
            }
            let _ = std::fs::remove_file(&out);
            std::os::unix::fs::symlink(&target, &out).map_err(|e| e.to_string())?;
            continue;
        }
        let mut f = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut f).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        if let Some(m) = mode {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(m & 0o7777 | 0o600));
        }
        #[cfg(not(unix))]
        let _ = mode;
    }
    Ok(())
}

/// `a/b/../c` → `a/c`, without touching the disk.
fn normalized(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}

/// One package into `<sdk>/<its place>`: downloaded (carried on when cut), checked, unpacked
/// next to the place and moved in with one rename.
async fn install(sdk: &Path, p: &Package, progress: &(dyn Fn(u64) + Sync)) -> Result<(), String> {
    let downloads = sdk.parent().ok_or("no parent")?.join("downloads");
    let file = p.archive.url.rsplit('/').next().unwrap_or("package.zip");
    let part = downloads.join(format!("{file}.part"));
    let (size, sha) = (p.archive.size, p.archive.sha1.clone());
    let check = move |f: &Path| -> Result<(), String> {
        let len = std::fs::metadata(f).map_err(|e| e.to_string())?.len();
        if len != size {
            return Err(format!("{len} bytes, not {size}"));
        }
        let got = sha1_file(f)?;
        if got != sha {
            return Err("checksum differs".into());
        }
        Ok(())
    };
    crate::components::fetch(&p.archive.url, size, &part, check, &|have| progress(have)).await?;
    let dest = place(sdk, &p.path);
    let tmp = dest.with_file_name(format!(".{}.{}.tmp", dest.file_name().and_then(|n| n.to_str()).unwrap_or("pkg"), std::process::id()));
    let (part2, tmp2, dest2) = (part.clone(), tmp.clone(), dest.clone());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _ = std::fs::remove_dir_all(&tmp2);
        if let Err(e) = unzip(&part2, &tmp2) {
            let _ = std::fs::remove_dir_all(&tmp2);
            return Err(e);
        }
        let _ = std::fs::remove_dir_all(&dest2);
        std::fs::rename(&tmp2, &dest2).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = std::fs::remove_file(&part);
    Ok(())
}

// ───────────── the AVD, without avdmanager ─────────────

/// An AVD for a downloaded image: `<avd home>/<name>.ini` and `<name>.avd/config.ini`, the files
/// avdmanager would write for a Pixel-sized phone.
pub fn make_avd(home: &Path, name: &str, image: &str, abi: &str) -> Result<(), String> {
    let mut parts = image.split(';').skip(1);
    let target = parts.next().ok_or("bad image")?.to_string();
    let tag = parts.next().ok_or("bad image")?.to_string();
    let dir = home.join(format!("{name}.avd"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let arch = if abi.starts_with("arm64") { "arm64" } else { "x86_64" };
    let config = [
        format!("AvdId={name}"),
        format!("avd.ini.displayname={name}"),
        "avd.ini.encoding=UTF-8".into(),
        format!("abi.type={abi}"),
        format!("hw.cpu.arch={arch}"),
        "hw.cpu.ncore=4".into(),
        "hw.ramSize=2048".into(),
        "disk.dataPartition.size=6G".into(),
        "hw.lcd.width=1080".into(),
        "hw.lcd.height=2400".into(),
        "hw.lcd.density=420".into(),
        "hw.initialOrientation=portrait".into(),
        "hw.keyboard=yes".into(),
        "hw.gpu.enabled=yes".into(),
        "hw.gpu.mode=auto".into(),
        "PlayStore.enabled=false".into(),
        format!("image.sysdir.1={}/", image.split(';').collect::<Vec<_>>().join("/")),
        format!("tag.id={tag}"),
        format!("target={target}"),
    ]
    .join("\n");
    std::fs::write(dir.join("config.ini"), config + "\n").map_err(|e| e.to_string())?;
    let ini = format!("avd.ini.encoding=UTF-8\npath={}\npath.rel=avd/{name}.avd\ntarget={target}\n", dir.display());
    std::fs::write(home.join(format!("{name}.ini")), ini).map_err(|e| e.to_string())
}

// ───────────── hardware acceleration ─────────────

/// Why an emulator can't run fast here, when it can't: "windows" (Windows Hypervisor Platform
/// is off) or "kvm" (no usable /dev/kvm). Ondra can't switch either on; the user can.
pub fn accel_missing(sdk: &Path) -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        return None;
    }
    let emu = sdk.join(format!("emulator/emulator{}", std::env::consts::EXE_SUFFIX));
    if emu.is_file() {
        let ok = crate::engine::background_command(&emu)
            .arg("-accel-check")
            .env("ANDROID_HOME", sdk)
            .env("ANDROID_SDK_ROOT", sdk)
            .stdin(std::process::Stdio::null())
            .output()
            .is_ok_and(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("usable"));
        return (!ok).then_some(if cfg!(windows) { "windows" } else { "kvm" });
    }
    #[cfg(windows)]
    {
        let on = crate::engine::background_command("powershell")
            .args(["-NoProfile", "-Command", "(Get-CimInstance Win32_ComputerSystem).HypervisorPresent"])
            .stdin(std::process::Stdio::null())
            .output()
            .is_ok_and(|o| String::from_utf8_lossy(&o.stdout).trim().eq_ignore_ascii_case("true"));
        (!on).then_some("windows")
    }
    #[cfg(not(windows))]
    {
        let ok = std::fs::OpenOptions::new().read(true).write(true).open("/dev/kvm").is_ok();
        (!ok).then_some("kvm")
    }
}

// ───────────── what the app and jobs see ─────────────

#[derive(Serialize, Clone, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// the SDK in use (the user's, else Ondra's)
    pub sdk: String,
    pub adb: bool,
    pub emulator: bool,
    /// an AVD to boot exists
    pub avd: bool,
    /// "adb" | "emulator" while that comes in
    pub busy: Option<String>,
    pub percent: i32,
    pub error: Option<String>,
    /// bytes the emulator and its image download (0: unknown, or nothing for this computer)
    pub size: u64,
    /// the license texts to agree to before the emulator comes in
    pub license: Option<String>,
    /// "windows" | "kvm" when the emulator can't run fast here (see accel_missing)
    pub accel: Option<String>,
}

#[derive(Default)]
struct Work {
    busy: Option<String>,
    percent: i32,
    error: Option<String>,
}
static WORK: Mutex<Work> = Mutex::new(Work { busy: None, percent: 0, error: None });

fn has(sdk: &Path, rel: &str) -> bool {
    sdk.join(format!("{rel}{}", std::env::consts::EXE_SUFFIX)).is_file()
}

/// Where things stand; with `full`, also the download size, license and acceleration (these ask
/// the repository and the system, so the device hub reads them only once nothing runs).
pub async fn status(full: bool) -> Status {
    let sdk = super::sdk();
    let mut s = Status {
        sdk: sdk.display().to_string(),
        adb: has(&sdk, "platform-tools/adb"),
        emulator: has(&sdk, "emulator/emulator"),
        avd: super::avd_names().iter().any(|n| !n.starts_with("ondra-")),
        ..Default::default()
    };
    {
        let w = WORK.lock().unwrap();
        (s.busy, s.percent, s.error) = (w.busy.clone(), w.percent, w.error.clone());
    }
    if !full {
        return s;
    }
    if !s.avd {
        if let Ok(p) = plan().await {
            if let Ok(list) = needed(&p, "emulator", &sdk) {
                s.size = list.iter().map(|x| x.archive.size).sum();
                let mut ids: Vec<&String> = list.iter().map(|x| &x.license).collect();
                ids.sort();
                ids.dedup();
                s.license = Some(ids.iter().filter_map(|id| p.licenses.get(*id)).cloned().collect::<Vec<_>>().join("\n\n────────\n\n"));
            }
        }
    }
    let sdk2 = sdk.clone();
    s.accel = tauri::async_runtime::spawn_blocking(move || accel_missing(&sdk2)).await.ok().flatten().map(String::from);
    s
}

fn emit() {
    if let Some(app) = APP.get() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = app.emit("android-sdk", status(false).await);
        });
    }
}

fn set_work(busy: Option<&str>, percent: i32, error: Option<String>) {
    *WORK.lock().unwrap() = Work { busy: busy.map(String::from), percent, error };
    emit();
}

/// Bring in adb ("adb", no question asked) or the emulator with its image and an AVD
/// ("emulator", once the user agreed), in the background. Nothing when it's there or coming.
pub fn get(what: &str) {
    let what = if what == "emulator" { "emulator" } else { "adb" };
    {
        let mut w = WORK.lock().unwrap();
        if w.busy.is_some() {
            return;
        }
        w.busy = Some(what.into());
        w.percent = 0;
        w.error = None;
    }
    emit();
    tauri::async_runtime::spawn(async move {
        let r = fetch_all(what).await;
        set_work(None, if r.is_ok() { 100 } else { 0 }, r.err());
    });
}

/// What has to come in for `what` while `current` is the SDK in use. The emulator comes only
/// into Ondra's own SDK, and only when the SDK in use has none (the user's emulator is theirs to
/// set up), together with its own adb and an image: Ondra's SDK is then used whole.
fn needed(p: &Plan, what: &str, current: &Path) -> Result<Vec<Package>, String> {
    let sdk = managed().ok_or("no data folder")?;
    let mut list = Vec::new();
    if what == "emulator" {
        if has(current, "emulator/emulator") && current != sdk {
            return Err("the Android SDK in use has its own emulator".into());
        }
        if !has(&sdk, "platform-tools/adb") {
            list.push(p.tools.clone().ok_or("no platform-tools for this computer")?);
        }
        if !has(&sdk, "emulator/emulator") {
            list.push(p.emulator.clone().ok_or("no Android emulator for this computer")?);
        }
        let image = p.image.clone().ok_or("no system image for this computer")?;
        if !place(&sdk, &image.path).join("system.img").is_file() {
            list.push(image);
        }
    } else if !has(current, "platform-tools/adb") && !has(&sdk, "platform-tools/adb") {
        list.push(p.tools.clone().ok_or("no platform-tools for this computer")?);
    }
    Ok(list)
}

async fn fetch_all(what: &str) -> Result<(), String> {
    let sdk = managed().ok_or("no data folder")?;
    let p = plan().await?;
    let list = needed(&p, what, &super::sdk())?;
    let total: u64 = list.iter().map(|x| x.archive.size).sum::<u64>().max(1);
    let mut before = 0u64;
    std::fs::create_dir_all(&sdk).map_err(|e| e.to_string())?;
    for pkg in &list {
        let base = before;
        install(&sdk, pkg, &|have| {
            let pc = (((base + have) * 100) / total).min(99) as i32;
            let changed = {
                let mut w = WORK.lock().unwrap();
                let c = w.percent != pc;
                w.percent = pc;
                c
            };
            if changed {
                emit();
            }
        })
        .await?;
        before += pkg.archive.size;
    }
    if what == "emulator" {
        // an SDK root the emulator accepts has a platforms folder, even an empty one
        let _ = std::fs::create_dir_all(sdk.join("platforms"));
        let image = p.image.ok_or("no system image for this computer")?;
        let home = super::avd_home();
        if !home.join(format!("{AVD}.ini")).is_file() {
            make_avd(&home, AVD, &image.path, abi())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn android_sdk_status(full: Option<bool>) -> Status {
    status(full.unwrap_or(false)).await
}

/// `what`: "adb" or "emulator" (only after the user agreed to the license and size).
#[tauri::command]
pub fn android_sdk_get(what: String) {
    get(&what);
}

/// Wait until nothing comes in any more (tests and the probe; jobs ask the status instead).
#[allow(dead_code)]
pub fn wait_idle(limit: Duration) -> bool {
    let t = std::time::Instant::now();
    while WORK.lock().unwrap().busy.is_some() {
        if t.elapsed() > limit {
            return false;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const REPO_XML: &str = r#"<?xml version="1.0"?>
<sdk:sdk-repository xmlns:sdk="http://schemas.android.com/sdk/android/repo/repository2/03">
<license id="android-sdk-license" type="text">Terms &quot;here&quot;</license>
<channel id="channel-0">stable</channel>
<remotePackage path="platform-tools"><uses-license ref="android-sdk-license"/><channelRef ref="channel-0"/>
<archives>
<archive><complete><size>10</size><checksum type="sha1">aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</checksum><url>pt-linux.zip</url></complete><host-os>linux</host-os></archive>
<archive><complete><size>20</size><checksum type="sha1">bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb</checksum><url>pt-win.zip</url></complete><host-os>windows</host-os></archive>
</archives></remotePackage>
<remotePackage path="emulator"><uses-license ref="android-sdk-preview-license"/><channelRef ref="channel-2"/>
<archives><archive><complete><size>1</size><checksum type="sha1">cccccccccccccccccccccccccccccccccccccccc</checksum><url>emu-canary.zip</url></complete><host-os>windows</host-os><host-arch>x64</host-arch></archive></archives></remotePackage>
<remotePackage path="emulator"><uses-license ref="android-sdk-license"/><channelRef ref="channel-0"/>
<archives>
<archive><complete><size>30</size><checksum type="sha1">dddddddddddddddddddddddddddddddddddddddd</checksum><url>emu-mac-arm.zip</url></complete><host-os>macosx</host-os><host-arch>aarch64</host-arch></archive>
<archive><complete><size>40</size><checksum type="sha1">eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee</checksum><url>emu-win.zip</url></complete><host-os>windows</host-os><host-arch>x64</host-arch></archive>
</archives></remotePackage>
</sdk:sdk-repository>"#;

    #[test]
    fn picks_the_stable_archive_for_this_host() {
        let (p, lic) = parse(REPO_XML, "https://x/", "windows", "x64");
        assert_eq!(p.len(), 2);
        assert_eq!(p[0].path, "platform-tools");
        assert_eq!(p[0].archive.url, "https://x/pt-win.zip");
        assert_eq!(p[1].path, "emulator");
        assert_eq!(p[1].archive, Archive { url: "https://x/emu-win.zip".into(), size: 40, sha1: "e".repeat(40) });
        assert_eq!(lic["android-sdk-license"], "Terms \"here\"");
        // no emulator built for Linux on ARM: only platform-tools
        let (p, _) = parse(REPO_XML, "https://x/", "linux", "aarch64");
        assert_eq!(p.iter().map(|x| x.path.as_str()).collect::<Vec<_>>(), ["platform-tools"]);
    }

    #[test]
    fn the_newest_aosp_image_for_the_abi() {
        let pkg = |path: &str| Package { path: path.into(), license: String::new(), archive: Archive { url: String::new(), size: 1, sha1: String::new() } };
        let list = [pkg("system-images;android-34;default;x86_64"), pkg("system-images;android-36;default;x86_64"), pkg("system-images;android-36;default;arm64-v8a"), pkg("system-images;android-37;google_apis;x86_64"), pkg("system-images;android-Baklava;default;x86_64")];
        assert_eq!(newest_image(&list, "x86_64").unwrap().path, "system-images;android-36;default;x86_64");
        assert_eq!(place(Path::new("/sdk"), "system-images;android-36;default;x86_64"), Path::new("/sdk/system-images/android-36/default/x86_64"));
    }

    #[test]
    fn unzips_without_the_top_folder_and_never_outside() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("ondra-sdk-unzip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let zip_path = dir.join("p.zip");
        {
            let mut w = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
            let exec = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
            w.add_directory("platform-tools/", exec).unwrap();
            w.start_file("platform-tools/adb", exec).unwrap();
            w.write_all(b"#!/bin/sh\n").unwrap();
            w.start_file("platform-tools/../../evil", exec).unwrap();
            w.write_all(b"x").unwrap();
            w.finish().unwrap();
        }
        let dest = dir.join("sdk/platform-tools");
        unzip(&zip_path, &dest).unwrap();
        assert!(dest.join("adb").is_file());
        assert!(!dir.join("evil").exists() && !dir.join("sdk/evil").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(dest.join("adb")).unwrap().permissions().mode() & 0o111, 0o111);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_avd_the_emulator_can_boot() {
        let home = std::env::temp_dir().join(format!("ondra-sdk-avd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        make_avd(&home, "Pixel", "system-images;android-36;default;x86_64", "x86_64").unwrap();
        let conf = std::fs::read_to_string(home.join("Pixel.avd/config.ini")).unwrap();
        assert!(conf.contains("image.sysdir.1=system-images/android-36/default/x86_64/"));
        assert!(conf.contains("abi.type=x86_64") && conf.contains("hw.cpu.arch=x86_64") && conf.contains("target=android-36") && conf.contains("tag.id=default"));
        let ini = std::fs::read_to_string(home.join("Pixel.ini")).unwrap();
        assert!(ini.contains(&format!("path={}", home.join("Pixel.avd").display())));
        let _ = std::fs::remove_dir_all(&home);
    }
}
