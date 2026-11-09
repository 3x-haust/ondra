//! The big parts that seldom change (the agent engine, the browser, the binary analyzer) live
//! outside the app, in `<data dir>/components/<name>/<version>/`, so an app update carries only
//! the app. The app ships `components.json` (name, version, sha256, size and url of each).
//!
//! At launch each one is made ready in the background, in order: already installed; else cloned
//! from the app bundle (the dmg's app carries them, so a fresh install works offline and nothing
//! downloads twice); else downloaded, resumed when cut, checked against its sha256, unpacked next
//! to the old version and moved into place with one rename. The old version stays until the new
//! one is in, and goes only when no running process uses it.
//!
//! Everything that runs a component finds it through [`path`]: the installed version, the copy in
//! the bundle, the repo's `src-tauri/resources/<name>` in a development build, or the newest
//! version installed before (offline, with the new one not in yet).

use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Condvar, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
pub struct Component {
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub size: u64,
    pub url: String,
}

#[derive(Deserialize, Serialize, Default, Debug, PartialEq)]
pub struct Manifest {
    #[serde(default)]
    pub components: Vec<Component>,
}

impl Manifest {
    pub fn get(&self, name: &str) -> Option<&Component> {
        self.components.iter().find(|c| c.name == name)
    }
}

/// A name or version is used as a folder name: plain characters only, never `..` or a path.
fn plain(s: &str) -> bool {
    !s.is_empty() && s.len() <= 96 && !s.starts_with('.') && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn parse_manifest(text: &str) -> Result<Manifest, String> {
    let m: Manifest = serde_json::from_str(text).map_err(|e| format!("components.json: {e}"))?;
    for (i, c) in m.components.iter().enumerate() {
        if !plain(&c.name) || !plain(&c.version) {
            return Err(format!("components.json: bad name or version: {} {}", c.name, c.version));
        }
        if c.sha256.len() != 64 || !c.sha256.chars().all(|x| matches!(x, '0'..='9' | 'a'..='f')) {
            return Err(format!("components.json: {} has no sha256", c.name));
        }
        if !c.url.starts_with("https://") || c.size == 0 {
            return Err(format!("components.json: {} has no https url or size", c.name));
        }
        if m.components[..i].iter().any(|o| o.name == c.name) {
            return Err(format!("components.json: {} twice", c.name));
        }
    }
    Ok(m)
}

/// Dotted numbers compare as numbers (157.0.8103.38 is newer than 157.0.8103.9); what follows
/// the first `-` (a content hash) only breaks ties.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let (an, ar) = a.split_once('-').unwrap_or((a, ""));
    let (bn, br) = b.split_once('-').unwrap_or((b, ""));
    let (mut x, mut y) = (an.split('.'), bn.split('.'));
    loop {
        match (x.next(), y.next()) {
            (None, None) => return ar.cmp(br),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(p), Some(q)) => {
                let o = match (p.parse::<u64>(), q.parse::<u64>()) {
                    (Ok(m), Ok(n)) => m.cmp(&n),
                    _ => p.cmp(q),
                };
                if o != Ordering::Equal {
                    return o;
                }
            }
        }
    }
}

pub fn sha256_file(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// The downloaded archive is exactly the one the manifest names.
pub fn verify(path: &Path, size: u64, sha256: &str) -> Result<(), String> {
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if len != size {
        return Err(format!("size {len}, expected {size}"));
    }
    let got = sha256_file(path).map_err(|e| e.to_string())?;
    if got != sha256 {
        return Err(format!("checksum {got}, expected {sha256}"));
    }
    Ok(())
}

/// A folder holds the whole component (what each one runs is there).
pub fn complete(name: &str, dir: &Path) -> bool {
    match name {
        "engine" => dir.join("ondra-engine").is_file() && dir.join("package.json").is_file(),
        "chrome" => crate::tools::chrome_in(dir).is_some(),
        "binary-analysis" => dir.join("bin/radare2").is_file(),
        _ => dir.is_dir(),
    }
}

/// The first complete folder among the candidates, in order.
pub fn resolve(candidates: impl IntoIterator<Item = PathBuf>, complete: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    candidates.into_iter().find(|d| complete(d))
}

/// Versions installed under `<root>/<name>`, newest first (dot folders are unfinished work).
pub fn installed(dir: &Path) -> Vec<String> {
    let mut list: Vec<String> = std::fs::read_dir(dir)
        .map(|r| r.flatten().filter(|e| e.path().is_dir()).filter_map(|e| e.file_name().into_string().ok()).filter(|n| plain(n)).collect())
        .unwrap_or_default();
    list.sort_by(|a, b| compare_versions(b, a));
    list
}

/// Where to look, in order: the version this app wants, the bundle's copy, the repo (development
/// builds only), then any version installed before.
pub fn candidates(root: Option<&Path>, want: Option<&str>, bundle: Option<&Path>, dev: Option<&Path>, name: &str) -> Vec<PathBuf> {
    let mut list = Vec::new();
    if let (Some(root), Some(v)) = (root, want) {
        list.push(root.join(name).join(v));
    }
    if let Some(b) = bundle {
        list.push(b.join("components").join(name));
    }
    if let Some(d) = dev {
        list.push(d.join(name));
    }
    if let Some(root) = root {
        list.extend(installed(&root.join(name)).into_iter().filter(|v| Some(v.as_str()) != want).map(|v| root.join(name).join(v)));
    }
    list
}

// ───────────── this app's manifest and folders ─────────────

static MANIFEST: OnceLock<Manifest> = OnceLock::new();

/// What this build needs. Development builds use the repo's resources and never download.
pub fn manifest(app: &AppHandle) -> &'static Manifest {
    MANIFEST.get_or_init(|| {
        if cfg!(debug_assertions) {
            return Manifest::default();
        }
        let file = app.path().resource_dir().ok().map(|d| d.join("components.json"));
        let text = file.and_then(|f| std::fs::read_to_string(f).ok()).unwrap_or_default();
        if text.is_empty() {
            return Manifest::default();
        }
        parse_manifest(&text).unwrap_or_else(|e| {
            eprintln!("{e}");
            Manifest::default()
        })
    })
}

fn root(app: &AppHandle) -> Option<PathBuf> {
    (!cfg!(debug_assertions)).then(|| crate::engine::data_dir(app).join("components"))
}

fn dev_dir() -> Option<PathBuf> {
    cfg!(debug_assertions).then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"))
}

/// The folder `name` runs from, if any copy of it is here.
pub fn path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let want = manifest(app).get(name).map(|c| c.version.as_str());
    let bundle = app.path().resource_dir().ok();
    resolve(candidates(root(app).as_deref(), want, bundle.as_deref(), dev_dir().as_deref(), name), |d| complete(name, d))
}

/// Where the wanted version will be once it is in (for a tool that waits for it).
pub fn expected(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let c = manifest(app).get(name)?;
    Some(root(app)?.join(name).join(&c.version))
}

// ───────────── progress, for the window and for whoever waits ─────────────

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Queued,
    Copying,
    Downloading,
    Ready,
    Failed,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub name: String,
    pub version: String,
    pub state: State,
    /// 0..=100 while downloading
    pub percent: i32,
    pub size: u64,
    pub error: Option<String>,
}

#[derive(Default)]
struct Board {
    list: Mutex<Vec<Status>>,
    changed: Condvar,
}

fn board() -> &'static Board {
    static B: OnceLock<Board> = OnceLock::new();
    B.get_or_init(Board::default)
}

fn set(app: &AppHandle, name: &str, state: State, percent: i32, error: Option<String>) {
    let b = board();
    let list = {
        let mut list = b.list.lock().unwrap();
        let Some(s) = list.iter_mut().find(|s| s.name == name) else { return };
        if s.state == state && s.percent == percent && s.error == error {
            return;
        }
        (s.state, s.percent, s.error) = (state, percent, error);
        list.clone()
    };
    b.changed.notify_all();
    let _ = app.emit("components:status", list);
}

#[tauri::command]
pub fn components_status() -> Vec<Status> {
    board().list.lock().unwrap().clone()
}

/// Block until `name` is ready, failed for now, or `limit` passed. A component this build doesn't
/// manage (development, or one still inside the app) counts as ready.
pub fn wait(name: &str, limit: Duration) -> State {
    let b = board();
    let until = Instant::now() + limit;
    let mut list = b.list.lock().unwrap();
    loop {
        let state = list.iter().find(|s| s.name == name).map_or(State::Ready, |s| s.state);
        let now = Instant::now();
        if matches!(state, State::Ready | State::Failed) || now >= until {
            return state;
        }
        list = b.changed.wait_timeout(list, until - now).unwrap().0;
    }
}

/// Wait for `name` only when no copy of it is usable: while a newer version comes in, the one
/// installed before keeps working.
pub fn wait_usable(app: &AppHandle, name: &str, limit: Duration) -> State {
    if path(app, name).is_some() {
        return State::Ready;
    }
    wait(name, limit)
}

/// Wait (off the main thread) for a component a job is about to use.
#[tauri::command]
pub async fn components_wait(app: AppHandle, name: String) -> State {
    tauri::async_runtime::spawn_blocking(move || wait_usable(&app, &name, Duration::from_secs(15 * 60))).await.unwrap_or(State::Failed)
}

// ───────────── getting each one in place ─────────────

/// Make every component ready, in the background (release builds with a manifest only).
pub fn start(app: &AppHandle) {
    let Some(root) = root(app) else { return };
    let wanted = manifest(app).components.clone();
    if wanted.is_empty() {
        return;
    }
    *board().list.lock().unwrap() = wanted
        .iter()
        .map(|c| {
            let ready = complete(&c.name, &root.join(&c.name).join(&c.version));
            Status { name: c.name.clone(), version: c.version.clone(), state: if ready { State::Ready } else { State::Queued }, percent: if ready { 100 } else { 0 }, size: c.size, error: None }
        })
        .collect();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut pending = wanted;
        let mut pause = Duration::from_secs(10);
        loop {
            let mut failed = Vec::new();
            for c in pending {
                match prepare(&app, &root, &c).await {
                    Ok(()) => set(&app, &c.name, State::Ready, 100, None),
                    Err(e) => {
                        eprintln!("component {} {}: {e}", c.name, c.version);
                        set(&app, &c.name, State::Failed, 0, Some(e));
                        failed.push(c);
                    }
                }
            }
            let (root2, keep) = (root.clone(), manifest(&app).components.clone());
            let _ = tauri::async_runtime::spawn_blocking(move || clean(&root2, &keep)).await;
            if failed.is_empty() {
                return;
            }
            // no network, or GitHub hiccuped: try again later, less and less often
            tokio_sleep(pause).await;
            pause = (pause * 3).min(Duration::from_secs(10 * 60));
            pending = failed;
        }
    });
}

async fn tokio_sleep(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// One component into `<root>/<name>/<version>`, unless it is there already.
async fn prepare(app: &AppHandle, root: &Path, c: &Component) -> Result<(), String> {
    let home = root.join(&c.name);
    let dir = home.join(&c.version);
    if complete(&c.name, &dir) {
        return Ok(());
    }
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    // another Ondra (a second copy of the app) may be on the same component: one at a time
    let lock = {
        let at = home.join(".lock");
        blocking(move || Lock::take(&at)).await??
    };
    let result = async {
        if complete(&c.name, &dir) {
            return Ok(());
        }
        sweep(&home);
        let bundled = app.path().resource_dir().ok().map(|d| d.join("components").join(&c.name)).filter(|d| complete(&c.name, d));
        if let Some(src) = bundled {
            set(app, &c.name, State::Copying, 0, None);
            let (name, dir2) = (c.name.clone(), dir.clone());
            return blocking(move || install_from(&name, &dir2, |tmp| clone_tree(&src, tmp))).await?;
        }
        set(app, &c.name, State::Downloading, 0, None);
        let part = root.join(".downloads").join(format!("{}-{}.part", c.name, c.version));
        let fetching = home.join(".fetching");
        download(c, &part, &|percent| {
            set(app, &c.name, State::Downloading, percent, None);
            // a tool waiting for this component sees it's still coming
            let _ = std::fs::write(&fetching, b"");
        })
        .await?;
        set(app, &c.name, State::Copying, 100, None);
        let (name, dir2, part2) = (c.name.clone(), dir.clone(), part.clone());
        blocking(move || install_from(&name, &dir2, |tmp| unpack(&part2, tmp))).await??;
        let _ = std::fs::remove_file(&part);
        Ok(())
    }
    .await;
    let _ = std::fs::remove_file(home.join(".fetching"));
    drop(lock);
    result
}

/// Fill a hidden folder next to the final one, check it, then rename it into place.
pub fn install_from(name: &str, dir: &Path, fill: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
    let home = dir.parent().ok_or("no parent")?;
    let version = dir.file_name().and_then(|n| n.to_str()).ok_or("no version")?;
    let tmp = home.join(format!(".{version}.{}.tmp", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let filled = fill(&tmp).and_then(|_| if complete(name, &tmp) { Ok(()) } else { Err(format!("{name} {version} is incomplete")) });
    // a copy out of an app installed from the dmg carries its quarantine flag; the app was
    // opened already, and its parts should start the way they did inside it
    if filled.is_ok() {
        let _ = Command::new("/usr/bin/xattr").args(["-dr", "com.apple.quarantine"]).arg(&tmp).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    if let Err(e) = filled {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(e);
    }
    if complete(name, dir) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Ok(());
    }
    // a folder under that name without its program (left by hand, or by an older build) is no copy
    if dir.exists() {
        let _ = std::fs::remove_dir_all(dir);
    }
    std::fs::rename(&tmp, dir).map_err(|e| {
        let _ = std::fs::remove_dir_all(&tmp);
        e.to_string()
    })
}

/// Copy-on-write clone (APFS: instant and takes no space); a plain copy across volumes.
fn clone_tree(src: &Path, tmp: &Path) -> Result<(), String> {
    let quiet = |c: &mut Command| c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success());
    if quiet(Command::new("/bin/cp").arg("-cRp").arg(src).arg(tmp)) {
        return Ok(());
    }
    let _ = std::fs::remove_dir_all(tmp);
    if quiet(Command::new("/usr/bin/ditto").arg(src).arg(tmp)) {
        return Ok(());
    }
    Err(format!("could not copy {}", src.display()))
}

/// The archive is a tar (xz) of the component folder's contents.
fn unpack(archive: &Path, tmp: &Path) -> Result<(), String> {
    std::fs::create_dir_all(tmp).map_err(|e| e.to_string())?;
    let out = Command::new("/usr/bin/tar").arg("-xf").arg(archive).arg("-C").arg(tmp).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!("unpack: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(())
}

/// Unfinished work an earlier run left (we hold the lock, so it's no one's now).
fn sweep(home: &Path) {
    for e in std::fs::read_dir(home).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if n.starts_with('.') && n.ends_with(".tmp") {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

fn client() -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent(concat!("Ondra/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

/// Download into `part`, carrying on from what an earlier try left. A part that turns out wrong
/// is thrown away and fetched once more from the start.
pub async fn download(c: &Component, part: &Path, progress: &(dyn Fn(i32) + Sync)) -> Result<(), String> {
    std::fs::create_dir_all(part.parent().ok_or("no parent")?).map_err(|e| e.to_string())?;
    let http = client()?;
    let mut fresh = false;
    loop {
        fetch_part(&http, c, part, progress).await?;
        let (p, size, sha) = (part.to_path_buf(), c.size, c.sha256.clone());
        match blocking(move || verify(&p, size, &sha)).await? {
            Ok(()) => return Ok(()),
            Err(e) if fresh => {
                let _ = std::fs::remove_file(part);
                return Err(e);
            }
            Err(_) => {
                let _ = std::fs::remove_file(part);
                fresh = true;
            }
        }
    }
}

async fn fetch_part(http: &reqwest::Client, c: &Component, part: &Path, progress: &(dyn Fn(i32) + Sync)) -> Result<(), String> {
    use futures_util::StreamExt;
    let mut have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    if have > c.size {
        let _ = std::fs::remove_file(part);
        have = 0;
    }
    if have == c.size {
        return Ok(());
    }
    let mut req = http.get(&c.url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let append = match res.status().as_u16() {
        206 if have > 0 => true,
        200 => false,
        // what we have can't be carried on: start over next time
        416 => {
            let _ = std::fs::remove_file(part);
            return Err("range not satisfiable".into());
        }
        s => return Err(format!("HTTP {s}")),
    };
    if !append {
        have = 0;
    }
    let mut file = std::fs::OpenOptions::new().create(true).write(true).append(append).truncate(!append).open(part).map_err(|e| e.to_string())?;
    let mut stream = res.bytes_stream();
    let mut beat = Instant::now() - Duration::from_secs(10);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        have += chunk.len() as u64;
        if have > c.size {
            drop(file);
            let _ = std::fs::remove_file(part);
            return Err("more bytes than expected".into());
        }
        if beat.elapsed() >= Duration::from_millis(500) {
            beat = Instant::now();
            progress(((have * 100) / c.size).min(99) as i32);
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    Ok(())
}

// ───────────── old versions ─────────────

/// Commands of every running process (a process runs from a folder when its command names it).
fn running() -> Vec<String> {
    Command::new("/bin/ps")
        .args(["-axww", "-o", "command="])
        .stderr(Stdio::null())
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::to_string).collect())
        .unwrap_or_default()
}

/// Which installed versions may go: everything but the wanted one and the newest other one,
/// and never one a running process uses.
pub fn removable(installed: &[String], want: &str, in_use: impl Fn(&str) -> bool) -> Vec<String> {
    let mut others = installed.iter().filter(|v| v.as_str() != want);
    let _previous = others.next();
    others.filter(|v| !in_use(v)).cloned().collect()
}

fn clean(root: &Path, keep: &[Component]) {
    let procs = running();
    for c in keep {
        let home = root.join(&c.name);
        let list = installed(&home);
        for v in removable(&list, &c.version, |v| {
            let dir = format!("{}/", home.join(v).display());
            procs.iter().any(|p| p.contains(&dir))
        }) {
            let _ = std::fs::remove_dir_all(home.join(v));
        }
    }
    // half downloads of versions no one wants any more
    for e in std::fs::read_dir(root.join(".downloads")).into_iter().flatten().flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if !keep.iter().any(|c| n == format!("{}-{}.part", c.name, c.version)) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// ───────────── one process at a time per component ─────────────

struct Lock(#[allow(dead_code)] std::fs::File);

impl Lock {
    fn take(at: &Path) -> Result<Lock, String> {
        let file = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(at).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        {
            use std::os::fd::AsRawFd;
            // SAFETY: flock on a descriptor we own; it is released when the file closes.
            if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
        }
        Ok(Lock(file))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ondra-components-{tag}-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const SHA: &str = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

    fn entry(name: &str, version: &str) -> String {
        format!(r#"{{"name":"{name}","version":"{version}","sha256":"{SHA}","size":11,"url":"https://github.com/3x-haust/ondra/releases/download/v1.0.0/{name}-{version}.tar.xz"}}"#)
    }

    #[test]
    fn reads_the_manifest() {
        let m = parse_manifest(&format!(r#"{{"components":[{},{}]}}"#, entry("chrome", "157.0.8103.38"), entry("engine", "1.5.0-ab12cd34ef56"))).unwrap();
        assert_eq!(m.components.len(), 2);
        assert_eq!(m.get("engine").unwrap().version, "1.5.0-ab12cd34ef56");
        assert!(m.get("nothing").is_none());
        assert_eq!(parse_manifest("{}").unwrap(), Manifest::default());
    }

    #[test]
    fn refuses_a_manifest_that_could_escape_or_lie() {
        for bad in [
            entry("../x", "1"),
            entry("chrome", "../../etc"),
            entry("chrome", ".hidden"),
            entry("chrome", "a/b"),
            entry("", "1"),
            entry("chrome", "1").replace(SHA, "abc"),
            entry("chrome", "1").replace(SHA, &SHA.to_uppercase()),
            entry("chrome", "1").replace("https://", "http://"),
            entry("chrome", "1").replace("\"size\":11", "\"size\":0"),
        ] {
            assert!(parse_manifest(&format!(r#"{{"components":[{bad}]}}"#)).is_err(), "{bad}");
        }
        assert!(parse_manifest(&format!(r#"{{"components":[{},{}]}}"#, entry("chrome", "1"), entry("chrome", "2"))).is_err());
        assert!(parse_manifest("not json").is_err());
    }

    #[test]
    fn compares_versions_as_numbers() {
        assert_eq!(compare_versions("157.0.8103.38", "157.0.8103.9"), Ordering::Greater);
        assert_eq!(compare_versions("6.2.6", "6.10.0"), Ordering::Less);
        assert_eq!(compare_versions("1.5.0-aaaa", "1.5.0-aaaa"), Ordering::Equal);
        assert_eq!(compare_versions("1.5.0-bbbb", "1.5.0-aaaa"), Ordering::Greater);
        assert_eq!(compare_versions("1.5.0-zzzz", "1.6.0-aaaa"), Ordering::Less);
        assert_eq!(compare_versions("1.5", "1.5.1"), Ordering::Less);
        assert_eq!(compare_versions("2", "10"), Ordering::Less);
    }

    #[test]
    fn checks_the_archive() {
        let d = tmp("verify");
        let f = d.join("a.tar.xz");
        std::fs::write(&f, b"hello world").unwrap();
        assert_eq!(sha256_file(&f).unwrap(), SHA);
        assert!(verify(&f, 11, SHA).is_ok());
        assert!(verify(&f, 12, SHA).unwrap_err().contains("size"));
        std::fs::write(&f, b"hello worle").unwrap();
        assert!(verify(&f, 11, SHA).unwrap_err().contains("checksum"));
        assert!(verify(&d.join("missing"), 11, SHA).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    fn analyzer(dir: &Path) {
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::write(dir.join("bin/radare2"), b"").unwrap();
    }

    #[test]
    fn finds_the_installed_version_first_then_the_bundle_then_the_repo() {
        let d = tmp("resolve");
        let (root, bundle, dev) = (d.join("data"), d.join("Resources"), d.join("repo"));
        let want = root.join("binary-analysis/6.2.6-new");
        let in_bundle = bundle.join("components/binary-analysis");
        let in_repo = dev.join("binary-analysis");
        let found = |dev: Option<&Path>| resolve(candidates(Some(&root), Some("6.2.6-new"), Some(&bundle), dev, "binary-analysis"), |p| complete("binary-analysis", p));
        assert_eq!(found(Some(&dev)), None);
        analyzer(&in_repo);
        assert_eq!(found(Some(&dev)), Some(in_repo.clone()));
        // a release build has no repo to fall back on
        assert_eq!(found(None), None);
        analyzer(&in_bundle);
        assert_eq!(found(Some(&dev)), Some(in_bundle.clone()));
        // a folder without its program is not a component (an unfinished copy)
        std::fs::create_dir_all(&want).unwrap();
        assert_eq!(found(Some(&dev)), Some(in_bundle.clone()));
        analyzer(&want);
        assert_eq!(found(Some(&dev)), Some(want.clone()));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn falls_back_to_the_newest_version_installed_before() {
        let d = tmp("older");
        let root = d.join("data");
        for v in ["6.2.5-a", "6.2.9-b", "6.2.10-c"] {
            analyzer(&root.join("binary-analysis").join(v));
        }
        // unfinished work is never picked
        analyzer(&root.join("binary-analysis/.6.3.0-d.1.tmp"));
        assert_eq!(installed(&root.join("binary-analysis")), vec!["6.2.10-c", "6.2.9-b", "6.2.5-a"]);
        let found = resolve(candidates(Some(&root), Some("7.0.0-new"), None, None, "binary-analysis"), |p| complete("binary-analysis", p));
        assert_eq!(found, Some(root.join("binary-analysis/6.2.10-c")));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn keeps_the_wanted_and_previous_versions_and_any_in_use() {
        let list: Vec<String> = ["9", "8", "7", "6"].iter().map(|s| s.to_string()).collect();
        assert_eq!(removable(&list, "9", |_| false), vec!["7", "6"]);
        assert_eq!(removable(&list, "9", |v| v == "6"), vec!["7"]);
        // the wanted one isn't installed yet: the newest installed stays as the fallback
        assert_eq!(removable(&list, "10", |_| false), vec!["8", "7", "6"]);
        assert!(removable(&list[..1], "9", |_| false).is_empty());
    }

    #[test]
    fn moves_a_finished_copy_into_place_and_leaves_nothing_of_a_failed_one() {
        let d = tmp("install");
        let dir = d.join("binary-analysis/6.2.6-x");
        std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
        assert!(install_from("binary-analysis", &dir, |tmp| {
            std::fs::create_dir_all(tmp).unwrap();
            Ok(())
        })
        .unwrap_err()
        .contains("incomplete"));
        assert!(!dir.exists());
        assert!(install_from("binary-analysis", &dir, |_| Err("cut".into())).is_err());
        assert!(std::fs::read_dir(dir.parent().unwrap()).unwrap().next().is_none(), "nothing left behind");
        install_from("binary-analysis", &dir, |tmp| {
            analyzer(tmp);
            Ok(())
        })
        .unwrap();
        assert!(complete("binary-analysis", &dir));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn unpacks_an_archive_and_clones_a_bundled_copy() {
        let d = tmp("unpack");
        let src = d.join("src");
        analyzer(&src);
        std::fs::write(src.join("bin/radare2"), b"r2").unwrap();
        let archive = d.join("a.tar.xz");
        let ok = Command::new("/usr/bin/tar").arg("-cJf").arg(&archive).arg("-C").arg(&src).arg(".").status().unwrap();
        assert!(ok.success());
        let dir = d.join("binary-analysis/1");
        std::fs::create_dir_all(dir.parent().unwrap()).unwrap();
        install_from("binary-analysis", &dir, |tmp| unpack(&archive, tmp)).unwrap();
        assert_eq!(std::fs::read(dir.join("bin/radare2")).unwrap(), b"r2");
        let cloned = d.join("binary-analysis/2");
        install_from("binary-analysis", &cloned, |tmp| clone_tree(&src, tmp)).unwrap();
        assert_eq!(std::fs::read(cloned.join("bin/radare2")).unwrap(), b"r2");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A tiny HTTP server for `body`: honours `Range` when `ranges` is on. Returns its url and
    /// the Range header each request carried.
    fn serve(body: Vec<u8>, ranges: bool, requests: usize) -> (String, std::sync::Arc<Mutex<Vec<Option<String>>>>) {
        use std::io::{BufRead, BufReader};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/c.tar.xz", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(requests) {
                let mut stream = stream.unwrap();
                let mut range = None;
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some(v) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                        range = Some(v.trim().trim_end_matches('-').to_string());
                    }
                }
                log.lock().unwrap().push(range.clone());
                let from = range.filter(|_| ranges).and_then(|r| r.parse::<usize>().ok());
                let (status, part) = match from {
                    Some(n) => ("206 Partial Content", &body[n..]),
                    None => ("200 OK", &body[..]),
                };
                let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", part.len());
                stream.write_all(head.as_bytes()).unwrap();
                stream.write_all(part).unwrap();
            }
        });
        (url, seen)
    }

    fn component(url: &str, body: &[u8]) -> Component {
        use sha2::{Digest, Sha256};
        let sha256 = Sha256::digest(body).iter().map(|b| format!("{b:02x}")).collect();
        Component { name: "chrome".into(), version: "1".into(), sha256, size: body.len() as u64, url: url.into() }
    }

    #[test]
    fn downloads_resumes_and_starts_over_when_the_part_is_wrong() {
        let body: Vec<u8> = (0..200_000u32).map(|i| (i * 7 % 251) as u8).collect();
        let d = tmp("download");
        let part = d.join(".downloads/chrome-1.part");
        let run = |c: &Component| tauri::async_runtime::block_on(download(c, &part, &|_| {}));

        // from nothing
        let (url, seen) = serve(body.clone(), true, 1);
        run(&component(&url, &body)).unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), body);
        assert_eq!(*seen.lock().unwrap(), vec![None]);

        // a cut download carries on from where it stopped
        std::fs::write(&part, &body[..80_000]).unwrap();
        let (url, seen) = serve(body.clone(), true, 1);
        run(&component(&url, &body)).unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), body);
        assert_eq!(*seen.lock().unwrap(), vec![Some("80000".to_string())]);

        // a part that was wrong fails the checksum: thrown away, fetched again in full
        let mut bad = body[..80_000].to_vec();
        bad[10] ^= 0xff;
        std::fs::write(&part, &bad).unwrap();
        let (url, seen) = serve(body.clone(), true, 2);
        run(&component(&url, &body)).unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), body);
        assert_eq!(*seen.lock().unwrap(), vec![Some("80000".to_string()), None]);

        // a server that ignores Range sends it all: written from the start
        std::fs::write(&part, &body[..80_000]).unwrap();
        let (url, _) = serve(body.clone(), false, 1);
        run(&component(&url, &body)).unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), body);

        // what the server sends is not what the manifest names: nothing stays
        let (url, _) = serve(body.clone(), true, 2);
        let mut other = component(&url, &body);
        other.sha256 = SHA.into();
        let _ = std::fs::remove_file(&part);
        assert!(run(&other).unwrap_err().contains("checksum"));
        assert!(!part.exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
