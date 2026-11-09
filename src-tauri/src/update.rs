//! Updates from GitHub Releases: the app reads `latest.json` from the newest
//! release, and installs the signed `.app.tar.gz` it points at, then restarts.
//! The package holds only the app (the engine, the browser and the analyzer are
//! components, see components.rs), and it is fetched in the background as soon as a
//! newer version is seen, so installing is only the swap and the restart: no network.
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Serialize)]
pub struct Available {
    version: String,
    notes: Option<String>,
}

#[derive(Serialize, Clone)]
struct Progress {
    version: String,
    /// 0..=100, or -1 while the size is unknown
    percent: i32,
}

/// the verified package of a newer version, ready to install
static READY: Mutex<Option<(Update, Vec<u8>)>> = Mutex::new(None);
/// the newer release the last check saw (so fetching it needs no second check)
static FOUND: Mutex<Option<Update>> = Mutex::new(None);
static FETCHING: AtomicBool = AtomicBool::new(false);

const LATEST: &str = "https://github.com/3x-haust/ondra/releases/latest/download/latest.json";

/// The newest release, if newer. GitHub's download CDN sometimes caches a failure (a 504) for the
/// plain address for a while; a second try asks with a query no one else used, which skips that cache.
async fn latest(app: &AppHandle) -> Result<Option<Update>, String> {
    let first = app.updater().map_err(|e| e.to_string())?.check().await;
    let found = match first {
        Ok(found) => found,
        Err(e) => {
            let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let url = tauri::Url::parse(&format!("{LATEST}?at={at}")).map_err(|_| e.to_string())?;
            let again = app.updater_builder().endpoints(vec![url]).map_err(|x| x.to_string())?.build().map_err(|x| x.to_string())?;
            again.check().await.map_err(|_| e.to_string())?
        }
    };
    *FOUND.lock().unwrap() = found.clone();
    Ok(found)
}

/// Download and verify, telling the window how far along it is.
async fn fetch(app: &AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    let version = update.version.clone();
    let (mut got, mut last) = (0u64, -2i32);
    let bytes = update
        .download(
            |n, total| {
                got += n as u64;
                let percent = total.filter(|t| *t > 0).map_or(-1, |t| ((got * 100) / t).min(100) as i32);
                if percent != last {
                    last = percent;
                    let _ = app.emit("update:progress", Progress { version: version.clone(), percent });
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    *READY.lock().unwrap() = Some((update.clone(), bytes.clone()));
    let _ = app.emit("update:ready", update.version.clone());
    Ok(bytes)
}

/// The newer version, if there is one. Development builds never update.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<Available>, String> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }
    let update = latest(&app).await?;
    Ok(update.map(|u| Available { version: u.version.clone(), notes: u.body.clone() }))
}

/// Fetch the newer version's package ahead of time. True once it is ready.
#[tauri::command]
pub async fn update_prepare(app: AppHandle) -> Result<bool, String> {
    if cfg!(debug_assertions) {
        return Ok(false);
    }
    // the check that just ran found it: no need to ask GitHub again
    let found = FOUND.lock().unwrap().clone();
    let update = match found {
        Some(u) => u,
        None => match latest(&app).await? {
            Some(u) => u,
            None => return Ok(false),
        },
    };
    if READY.lock().unwrap().as_ref().is_some_and(|(u, _)| u.version == update.version) {
        return Ok(true);
    }
    if FETCHING.swap(true, Ordering::SeqCst) {
        return Ok(false);
    }
    let done = fetch(&app, &update).await;
    FETCHING.store(false, Ordering::SeqCst);
    done.map(|_| true)
}

/// Install the newer version and restart into it. A package already fetched and verified
/// installs right away (the background checks every few minutes keep it the newest); only
/// without one does this ask GitHub and download first.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    // kept (not taken): if installing fails, a second press still has it
    let ready = READY.lock().unwrap().clone();
    let (update, bytes) = match ready {
        Some(r) => r,
        None => {
            let Some(update) = latest(&app).await? else { return Err("이미 최신 버전이에요".into()) };
            let bytes = fetch(&app, &update).await?;
            (update, bytes)
        }
    };
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}
