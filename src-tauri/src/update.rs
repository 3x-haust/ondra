//! Updates from GitHub Releases: the app reads `latest.json` from the newest
//! release, and installs the signed `.app.tar.gz` it points at, then restarts.
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

#[derive(Serialize)]
pub struct Available {
    version: String,
    notes: Option<String>,
}

/// The newer version, if there is one. Development builds never update.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<Available>, String> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| Available { version: u.version.clone(), notes: u.body.clone() }))
}

/// Download, verify and install the newer version, then restart into it.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let Some(update) = update else { return Err("이미 최신 버전이에요".into()) };
    update.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}
