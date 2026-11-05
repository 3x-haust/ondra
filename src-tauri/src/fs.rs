//! The Files panel: every file in a task's folder (what git tracks plus new
//! files it doesn't ignore; a capped walk outside git) and reading one file.

use crate::engine::user_path;
use serde::Serialize;
use std::{path::Path, process::Command};

const MAX_FILES: usize = 20_000;
const MAX_READ: u64 = 2 * 1024 * 1024;
const SKIP: &[&str] = &[".git", ".ondra", "node_modules", "target", ".next", "dist", "build", ".venv", "__pycache__", ".DS_Store"];

fn git_files(cwd: &str) -> Option<Vec<String>> {
    let out = Command::new("git")
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
        .current_dir(cwd)
        .env("PATH", user_path())
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut v: Vec<String> = out.stdout.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
    v.sort();
    v.dedup();
    v.truncate(MAX_FILES);
    Some(v)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if SKIP.contains(&name.as_str()) {
            continue;
        }
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            walk(root, &p, out);
        } else if ft.is_file() {
            if let Ok(rel) = p.strip_prefix(root) {
                out.push(rel.display().to_string());
            }
        }
    }
}

fn list(cwd: &str) -> Vec<String> {
    if let Some(v) = git_files(cwd) {
        return v;
    }
    let mut out = Vec::new();
    walk(Path::new(cwd), Path::new(cwd), &mut out);
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    /// None when the file is binary or too big to show.
    text: Option<String>,
    size: u64,
    binary: bool,
}

fn read(path: &str) -> Result<FileText, String> {
    let meta = std::fs::metadata(path).map_err(|_| "파일이 없어요".to_string())?;
    let size = meta.len();
    if size > MAX_READ {
        return Ok(FileText { text: None, size, binary: false });
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let binary = bytes.iter().take(8000).any(|b| *b == 0);
    Ok(FileText { text: (!binary).then(|| String::from_utf8_lossy(&bytes).into_owned()), size, binary })
}

#[tauri::command]
pub async fn fs_files(cwd: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || list(&cwd)).await.unwrap_or_default()
}

#[tauri::command]
pub async fn fs_read(path: String) -> Result<FileText, String> {
    tauri::async_runtime::spawn_blocking(move || read(&path)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_and_reads() {
        let root = std::env::temp_dir().join(format!("fs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join("src/a.ts"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("node_modules/x/i.js"), "x").unwrap();
        std::fs::write(root.join("b.bin"), [0u8, 1, 2]).unwrap();
        let files = list(&root.display().to_string());
        assert_eq!(files, vec!["b.bin".to_string(), "src/a.ts".to_string()]);
        let t = read(&root.join("src/a.ts").display().to_string()).unwrap();
        assert_eq!(t.text.as_deref(), Some("one\ntwo\n"));
        assert!(read(&root.join("b.bin").display().to_string()).unwrap().binary);
        assert!(read(&root.join("nope").display().to_string()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// A pasted image (bytes from the clipboard) saved where the agents can read it.
/// Returns the file's path.
#[tauri::command]
pub async fn save_paste(app: tauri::AppHandle, bytes: Vec<u8>, ext: String) -> Result<String, String> {
    let ext: String = ext.chars().filter(|c| c.is_ascii_alphanumeric()).take(5).collect();
    let ext = if ext.is_empty() { "png".to_string() } else { ext };
    if bytes.len() > 30 * 1024 * 1024 {
        return Err("이미지가 너무 커요".into());
    }
    let dir = crate::engine::data_dir(&app).join("attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("paste-{stamp}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Make a new project folder (main can start a project somewhere new). Only inside home.
#[tauri::command]
pub fn ensure_dir(path: String) -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let p = if let Some(rest) = path.strip_prefix("~/") { format!("{home}/{rest}") } else { path };
    let pb = std::path::PathBuf::from(&p);
    if !pb.is_absolute() || !pb.starts_with(&home) || pb.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("홈 폴더 안의 절대 경로만 만들 수 있어요".into());
    }
    std::fs::create_dir_all(&pb).map_err(|e| e.to_string())?;
    Ok(p)
}
