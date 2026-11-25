//! Native Windows actions. Paths and URLs never go through a shell command line.

use std::{os::windows::process::CommandExt, path::{Path, PathBuf}, process::Command};

fn explorer() -> Command {
    let root = std::env::var_os("SystemRoot").expect("Windows system directory");
    Command::new(PathBuf::from(root).join("explorer.exe"))
}

/// Explorer reads `C:/a/b` as a bad path and opens its default folder instead
pub(super) fn native(path: &str) -> String {
    path.replace('/', "\\")
}

pub(super) fn reveal(path: &str) {
    let _ = explorer().arg("/select,").arg(native(path)).spawn();
}

pub(super) fn open_url(url: &str) {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    use std::ptr::{null, null_mut};
    if url.contains('\0') { return; }
    let wide: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    // Only the URL schemes accepted by store::open_url reach the system handler.
    unsafe { ShellExecuteW(null_mut(), null(), wide.as_ptr(), null(), null(), SW_SHOWNORMAL); }
}

pub(super) fn editor_fallback(path: &Path) -> Command {
    // A file association could execute a .cmd or .exe. Open files as text instead.
    if path.is_dir() { explorer() } else { crate::engine::system_command("notepad.exe") }
}

pub(super) fn terminal(path: &str, env: &[(String, String)]) -> Result<(), String> {
    let mut cmd = Command::new(std::env::var_os("ComSpec").unwrap_or_else(|| "cmd.exe".into()));
    crate::git::space_env_into(&mut cmd, env);
    cmd.current_dir(path).creation_flags(0x00000010) // CREATE_NEW_CONSOLE
        .spawn().map(|_| ()).map_err(|e| e.to_string())
}
