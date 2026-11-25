//! Native Linux actions: the desktop's own handlers through xdg-open, and its terminal.
//! Paths and URLs are arguments, never parts of a shell command line.

use std::{path::Path, process::{Command, Stdio}};

fn xdg_open(target: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new("xdg-open");
    cmd.arg(target).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd
}

/// Freedesktop file managers select the item; xdg-open can only open its folder.
pub(super) fn reveal(path: &str) {
    let uri = format!("file://{}", path.split('/').map(percent).collect::<Vec<_>>().join("/"));
    let shown = Command::new("dbus-send")
        .args(["--session", "--print-reply", "--dest=org.freedesktop.FileManager1", "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1.ShowItems"])
        .arg(format!("array:string:{uri}"))
        .arg("string:")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if !shown {
        let p = Path::new(path);
        let _ = xdg_open(if p.is_dir() { p } else { p.parent().unwrap_or(p) }).spawn();
    }
}

fn percent(seg: &str) -> String {
    seg.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

pub(super) fn open(target: &str) -> Result<(), String> {
    xdg_open(target).spawn().map(|_| ()).map_err(|e| e.to_string())
}

pub(super) fn editor_fallback(path: &Path) -> Command {
    xdg_open(path)
}

/// The first terminal installed, in the folder. `script` (the space's shell, see
/// `shell_script`) runs with sh, so it needs no execute bit or a particular shell.
pub(crate) fn terminal(path: &str, script: Option<&str>) -> Result<(), String> {
    const TERMINALS: [&str; 9] = ["gnome-terminal", "konsole", "xfce4-terminal", "ptyxis", "kitty", "alacritty", "wezterm", "xterm", "x-terminal-emulator"];
    let term = TERMINALS.iter().find(|t| super::which(t).is_some()).ok_or("터미널 앱을 찾지 못했어요")?;
    let mut cmd = Command::new(super::which(term).unwrap());
    cmd.current_dir(path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    if let Some(script) = script {
        match *term {
            "gnome-terminal" | "ptyxis" | "kitty" => cmd.args(["--", "sh", script]),
            "xfce4-terminal" => cmd.args(["-x", "sh", script]),
            "wezterm" => cmd.args(["start", "--", "sh", script]),
            _ => cmd.args(["-e", "sh", script]),
        };
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}
