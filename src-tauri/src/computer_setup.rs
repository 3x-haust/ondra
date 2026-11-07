//! Explicit user enrollment. Engine spawning can only borrow an already authorized VM.
use crate::computer::{ComputerAssets, ComputerSetup, OwnedVm, SealedAsset, SetupRequest};
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, TryLockError,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{AppHandle, Manager, State};

mod assets {
    include!(concat!(env!("OUT_DIR"), "/computer_assets.rs"));
}

type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerStatus {
    phase: &'static str,
    busy: bool,
    prepared: bool,
    task_id: Option<String>,
    error: Option<&'static str>,
}

impl Default for ComputerStatus {
    fn default() -> Self {
        Self {
            phase: "idle",
            busy: false,
            prepared: false,
            task_id: None,
            error: None,
        }
    }
}

#[derive(Default)]
pub struct ComputerState {
    owner: Mutex<Option<ComputerSetup>>,
    status: Mutex<ComputerStatus>,
    closing: AtomicBool,
}

fn task_suffix(id: &str) -> Result<&str> {
    id.strip_prefix("t:")
        .filter(|id| {
            !id.is_empty()
                && id.len() <= 128
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
        })
        .ok_or("INVALID_TASK_ID")
}

fn lock_error<T>(error: TryLockError<T>) -> &'static str {
    match error {
        TryLockError::WouldBlock => "COMPUTER_BUSY",
        TryLockError::Poisoned(_) => "COMPUTER_STATE_FAILED",
    }
}

pub struct EngineAccess<'a> {
    state: &'a ComputerState,
    owner: MutexGuard<'a, Option<ComputerSetup>>,
}

impl EngineAccess<'_> {
    pub fn current_vm(&self, id: &str) -> Option<Arc<OwnedVm>> {
        task_suffix(id).ok()?;
        let status = self.state.status.lock().ok()?;
        if status.phase != "ready" || status.task_id.as_deref() != Some(id) {
            return None;
        }
        self.owner.as_ref()?.current_vm()
    }
}

struct Operation<'a> {
    state: &'a ComputerState,
    owner: MutexGuard<'a, Option<ComputerSetup>>,
    finished: bool,
}

impl Operation<'_> {
    fn finish(mut self, result: Result<()>) -> Result<ComputerStatus> {
        let mut status = self
            .state
            .status
            .lock()
            .map_err(|_| "COMPUTER_STATE_FAILED")?;
        status.busy = false;
        status.prepared = self.owner.is_some();
        status.error = result.err();
        if status.error.is_some() {
            status.phase = if self.owner.as_ref().is_some_and(ComputerSetup::setup_pending) {
                "setup"
            } else {
                "error"
            };
        }
        self.finished = true;
        result.map(|_| status.clone())
    }
}

impl Drop for Operation<'_> {
    fn drop(&mut self) {
        if !self.finished {
            if let Ok(mut status) = self.state.status.lock() {
                status.busy = false;
                status.phase = "error";
                status.error = Some("COMPUTER_WORKER_FAILED");
            }
        }
    }
}

impl ComputerState {
    fn begin(&self, phase: &'static str) -> Result<Operation<'_>> {
        let owner = self.owner.try_lock().map_err(lock_error)?;
        if self.closing.load(Ordering::Acquire) {
            return Err("COMPUTER_CLOSED");
        }
        let mut status = self.status.lock().map_err(|_| "COMPUTER_STATE_FAILED")?;
        status.busy = true;
        status.phase = phase;
        status.error = None;
        Ok(Operation {
            state: self,
            owner,
            finished: false,
        })
    }

    pub fn engine_access(&self) -> Result<EngineAccess<'_>> {
        let owner = self.owner.try_lock().map_err(lock_error)?;
        if self.closing.load(Ordering::Acquire) {
            return Err("COMPUTER_CLOSED");
        }
        Ok(EngineAccess { state: self, owner })
    }

    fn snapshot(&self) -> Result<ComputerStatus> {
        // Never wait for a long prepare/recovery or probe a VM it is replacing.
        let owner = match self.owner.try_lock() {
            Ok(owner) => Some(owner),
            Err(TryLockError::WouldBlock) => None,
            Err(TryLockError::Poisoned(_)) => return Err("COMPUTER_STATE_FAILED"),
        };
        let mut status = self
            .status
            .lock()
            .map_err(|_| "COMPUTER_STATE_FAILED")?
            .clone();
        if let Some(owner) = owner {
            if status.phase == "ready"
                && owner.as_ref().and_then(ComputerSetup::current_vm).is_none()
            {
                status.phase = "error";
                status.error = Some("GUEST_REVOKED");
            }
        }
        Ok(status)
    }

    fn prepare(&self, create: impl FnOnce() -> Result<ComputerSetup>) -> Result<ComputerStatus> {
        let mut operation = self.begin("preparing")?;
        let result = (|| {
            if operation.owner.is_some() {
                return Err("COMPUTER_ALREADY_PREPARED");
            }
            *operation.owner = Some(create()?);
            self.status
                .lock()
                .map_err(|_| "COMPUTER_STATE_FAILED")?
                .phase = "setup";
            Ok(())
        })();
        operation.finish(result)
    }

    /// Adopts the guest an earlier app run prepared. It stays powered off until a
    /// task starts it; a guest that never finished setup returns to setup.
    fn resume(&self, load: impl FnOnce() -> Result<ComputerSetup>) -> Result<ComputerStatus> {
        let mut operation = self.begin("preparing")?;
        let result = (|| {
            if operation.owner.is_some() {
                return Err("COMPUTER_ALREADY_PREPARED");
            }
            let setup = load()?;
            let pending = setup.setup_pending();
            *operation.owner = Some(setup);
            self.status
                .lock()
                .map_err(|_| "COMPUTER_STATE_FAILED")?
                .phase = if pending { "setup" } else { "stopped" };
            Ok(())
        })();
        operation.finish(result)
    }

    fn open_viewer(&self) -> Result<ComputerStatus> {
        let operation = self.begin("setup")?;
        let result = operation
            .owner
            .as_ref()
            .ok_or("COMPUTER_NOT_PREPARED")
            .and_then(ComputerSetup::open_setup_viewer);
        operation.finish(result)
    }

    fn start(&self, task_id: &str, recovery: bool) -> Result<ComputerStatus> {
        let suffix = task_suffix(task_id)?;
        let operation = self.begin(if recovery { "recovering" } else { "starting" })?;
        let result = (|| {
            let setup = operation.owner.as_ref().ok_or("COMPUTER_NOT_PREPARED")?;
            {
                let mut status = self.status.lock().map_err(|_| "COMPUTER_STATE_FAILED")?;
                if status.task_id.as_deref().is_some_and(|id| id != task_id) {
                    return Err("COMPUTER_TASK_MISMATCH");
                }
                if recovery && status.task_id.is_none() {
                    return Err("COMPUTER_NOT_STARTED");
                }
                // Bind before attempting a boot: failures never authorize another task.
                status.task_id = Some(task_id.to_owned());
            }
            if recovery {
                setup.recover(suffix)?;
            } else {
                setup.start(suffix)?;
            }
            if setup.current_vm().is_none() {
                return Err("GUEST_REVOKED");
            }
            self.status
                .lock()
                .map_err(|_| "COMPUTER_STATE_FAILED")?
                .phase = "ready";
            Ok(())
        })();
        operation.finish(result)
    }

    /// Serialize shutdown against enrollment and engine attachment. The engine
    /// callback revokes channels and reaps children before waiting for the VM runner.
    pub fn shutdown(&self, stop_engines: impl FnOnce()) -> Result<()> {
        self.closing.store(true, Ordering::Release);
        let mut owner = self.owner.lock().unwrap_or_else(|error| error.into_inner());
        stop_engines();
        let result = owner.as_ref().map_or(Ok(()), ComputerSetup::shutdown);
        drop(owner.take());
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *status = ComputerStatus {
            phase: "closed",
            error: result.err(),
            ..ComputerStatus::default()
        };
        result
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrepareRequest {
    restore_image: PathBuf,
    #[serde(default = "default_cpu")]
    cpu_count: u32,
    #[serde(default = "default_memory")]
    memory_bytes: u64,
    #[serde(default = "default_disk")]
    disk_bytes: u64,
    #[serde(default = "default_width")]
    width: u32,
    #[serde(default = "default_height")]
    height: u32,
}
fn default_cpu() -> u32 {
    4
}
fn default_memory() -> u64 {
    8 * 1024 * 1024 * 1024
}
fn default_disk() -> u64 {
    64 * 1024 * 1024 * 1024
}
fn default_width() -> u32 {
    1440
}
fn default_height() -> u32 {
    900
}

fn sealed_assets(app: &AppHandle) -> Result<ComputerAssets> {
    let entries = assets::COMPUTER_ASSETS.ok_or("COMPUTER_ASSETS_UNAVAILABLE")?;
    let directory = app
        .path()
        .resource_dir()
        .map_err(|_| "COMPUTER_ASSETS_UNAVAILABLE")?;
    let asset = |role| -> Result<SealedAsset> {
        let (_, path, sha256) = entries
            .iter()
            .find(|(name, _, _)| *name == role)
            .ok_or("COMPUTER_ASSETS_UNAVAILABLE")?;
        Ok(SealedAsset {
            path: directory.join(path),
            sha256: (*sha256).into(),
        })
    };
    Ok(ComputerAssets {
        runner: asset("runner")?,
        endpoint: asset("endpoint")?,
        provisioner: asset("provisioner")?,
        installer: asset("installer")?,
        desktop: asset("desktop")?,
        helper: asset("helper")?,
    })
}

fn fresh_directory(parent: &Path) -> Result<PathBuf> {
    use std::{
        ffi::{CStr, CString},
        os::unix::ffi::OsStrExt,
    };
    let template = parent.join("computer-XXXXXX");
    let mut bytes = CString::new(template.as_os_str().as_bytes())
        .map_err(|_| "COMPUTER_DIRECTORY_FAILED")?
        .into_bytes_with_nul();
    let created = unsafe { libc::mkdtemp(bytes.as_mut_ptr().cast()) };
    if created.is_null() {
        return Err("COMPUTER_DIRECTORY_FAILED");
    }
    // SAFETY: mkdtemp returned the NUL-terminated template above.
    let path = PathBuf::from(std::ffi::OsStr::from_bytes(
        unsafe { CStr::from_ptr(created) }.to_bytes(),
    ));
    std::fs::canonicalize(path).map_err(|_| "COMPUTER_DIRECTORY_FAILED")
}

/// The newest guest directory whose OS install finished.
fn newest_prepared(parent: &Path) -> Option<PathBuf> {
    std::fs::read_dir(parent)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name();
            let kind = entry.file_type().ok()?;
            if !kind.is_dir() || !name.to_str()?.starts_with("computer-") {
                return None;
            }
            let marker = std::fs::symlink_metadata(entry.path().join("vm/installed")).ok()?;
            marker.is_file().then_some(())?;
            Some((marker.modified().ok()?, entry.path()))
        })
        .max_by_key(|(modified, _)| *modified)
        .and_then(|(_, path)| std::fs::canonicalize(path).ok())
}

/// At app start, adopts the guest a previous run left behind, without booting it.
pub fn resume_existing(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(parent) = handle.path().app_data_dir() else {
            return;
        };
        let Some(root) = newest_prepared(&parent) else {
            return;
        };
        let state = handle.state::<ComputerState>();
        let _ = state.resume(|| {
            ComputerSetup::resume(sealed_assets(&handle)?, root.join("vm"), root.clone())
        });
    });
}

async fn worker(
    app: AppHandle,
    action: impl FnOnce(&ComputerState) -> Result<ComputerStatus> + Send + 'static,
) -> std::result::Result<ComputerStatus, String> {
    tauri::async_runtime::spawn_blocking(move || action(&app.state::<ComputerState>()))
        .await
        .map_err(|_| "COMPUTER_WORKER_FAILED".to_owned())?
        .map_err(str::to_owned)
}

#[tauri::command]
pub async fn computer_prepare(
    app: AppHandle,
    request: PrepareRequest,
) -> std::result::Result<ComputerStatus, String> {
    let handle = app.clone();
    worker(app, move |state| {
        state.prepare(|| {
            let assets = sealed_assets(&handle)?;
            let restore_image = std::fs::canonicalize(&request.restore_image)
                .map_err(|_| "RESTORE_IMAGE_UNAVAILABLE")?;
            let parent = handle
                .path()
                .app_data_dir()
                .map_err(|_| "COMPUTER_DIRECTORY_FAILED")?;
            std::fs::create_dir_all(&parent).map_err(|_| "COMPUTER_DIRECTORY_FAILED")?;
            let root = fresh_directory(&parent)?;
            ComputerSetup::prepare(
                assets,
                SetupRequest {
                    directory: root.join("vm"),
                    state_directory: root,
                    restore_image,
                    cpu_count: request.cpu_count,
                    memory_bytes: request.memory_bytes,
                    disk_bytes: request.disk_bytes,
                    width: request.width,
                    height: request.height,
                },
            )
        })
    })
    .await
}

#[tauri::command]
pub async fn computer_open_setup_viewer(
    app: AppHandle,
) -> std::result::Result<ComputerStatus, String> {
    worker(app, ComputerState::open_viewer).await
}
#[tauri::command]
pub async fn computer_start(
    app: AppHandle,
    task_id: String,
) -> std::result::Result<ComputerStatus, String> {
    worker(app, move |state| state.start(&task_id, false)).await
}
#[tauri::command]
pub async fn computer_recover(
    app: AppHandle,
    task_id: String,
) -> std::result::Result<ComputerStatus, String> {
    worker(app, move |state| state.start(&task_id, true)).await
}
#[tauri::command]
pub fn computer_status(
    state: State<'_, ComputerState>,
) -> std::result::Result<ComputerStatus, String> {
    state.snapshot().map_err(str::to_owned)
}
