//! The Files panel: every file in a task's folder (what git tracks plus new
//! files it doesn't ignore; a capped walk outside git) and reading one file.

use crate::engine::user_path;
use serde::Serialize;
use std::path::Path;

const MAX_FILES: usize = 20_000;
const MAX_READ: u64 = 2 * 1024 * 1024;
const SKIP: &[&str] = &[".git", ".ondra", "node_modules", "target", ".next", "dist", "build", ".venv", "__pycache__", ".DS_Store"];

fn git_files(cwd: &str) -> Option<Vec<String>> {
    let out = crate::engine::background_command("git")
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

/// Resolve a file at the point of use, inside the canonical directory given to the panel.
pub(crate) fn scoped_file(root: &Path, rel: &Path) -> Option<std::path::PathBuf> {
    if rel.components().any(|p| !matches!(p, std::path::Component::Normal(_))) { return None; }
    let file = root.join(rel).canonicalize().ok()?;
    (file.starts_with(root) && file.is_file()).then_some(file)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<String>, scoped: bool) {
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
            // Do not descend through reparse points (including Windows junctions).
            if !scoped || p.canonicalize().is_ok_and(|real| real == p) {
                walk(root, &p, out, scoped);
            }
        } else if ft.is_file() {
            if let Ok(rel) = p.strip_prefix(root) {
                // The file tree and git both use '/' for relative paths on every host.
                out.push(rel.iter().map(|part| part.to_string_lossy()).collect::<Vec<_>>().join("/"));
            }
        }
    }
}

fn list(cwd: &str, root: Option<&Path>) -> Vec<String> {
    let mut out = git_files(cwd).unwrap_or_else(|| {
        let mut out = Vec::new();
        let dir = root.unwrap_or(Path::new(cwd));
        walk(dir, dir, &mut out, root.is_some());
        out
    });
    if let Some(root) = root {
        out.retain(|rel| scoped_file(root, Path::new(rel)).is_some());
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    /// None when the file is binary or too big to show.
    text: Option<String>,
    size: u64,
    binary: bool,
    /// last change, ms since 1970 (0 when unknown)
    modified: u64,
}

fn read(path: &str) -> Result<FileText, String> {
    let meta = std::fs::metadata(path).map_err(|_| "파일이 없어요".to_string())?;
    let size = meta.len();
    let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    if size > MAX_READ {
        return Ok(FileText { text: None, size, binary: false, modified });
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let binary = bytes.iter().take(8000).any(|b| *b == 0);
    Ok(FileText { text: (!binary).then(|| String::from_utf8_lossy(&bytes).into_owned()), size, binary, modified })
}

/// One line that matched a search across the folder.
#[derive(Serialize)]
pub struct Hit {
    path: String,
    line: usize,
    text: String,
}

const MAX_HITS: usize = 500;

/// Every line in the folder's files that contains `query` (case-insensitive),
/// like an editor's find in files. Binary and very large files are skipped.
fn grep(cwd: &str, query: &str, root: Option<&Path>) -> Vec<Hit> {
    let q = query.to_lowercase();
    let mut out = Vec::new();
    if q.trim().is_empty() {
        return out;
    }
    for rel in list(cwd, root) {
        let path = if let Some(root) = root {
            let Some(file) = scoped_file(root, Path::new(&rel)) else { continue };
            file
        } else { Path::new(cwd).join(&rel) };
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        if meta.len() > MAX_READ {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        if bytes.iter().take(8000).any(|b| *b == 0) {
            continue;
        }
        let text = String::from_utf8_lossy(&bytes);
        for (i, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&q) {
                let mut t = line.trim().to_string();
                if t.len() > 240 {
                    let mut end = 240;
                    while !t.is_char_boundary(end) {
                        end -= 1;
                    }
                    t.truncate(end);
                }
                out.push(Hit { path: rel.clone(), line: i + 1, text: t });
                if out.len() >= MAX_HITS {
                    return out;
                }
            }
        }
    }
    out
}

#[tauri::command]
pub async fn fs_grep(cwd: String, query: String, scoped: Option<bool>) -> Vec<Hit> {
    tauri::async_runtime::spawn_blocking(move || match scoped {
        Some(true) => Path::new(&cwd).canonicalize().map(|root| grep(&cwd, &query, Some(&root))).unwrap_or_default(),
        _ => grep(&cwd, &query, None),
    }).await.unwrap_or_default()
}

#[tauri::command]
pub async fn fs_files(cwd: String, scoped: Option<bool>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || match scoped {
        Some(true) => Path::new(&cwd).canonicalize().map(|root| list(&cwd, Some(&root))).unwrap_or_default(),
        _ => list(&cwd, None),
    }).await.unwrap_or_default()
}

/// Git repositories in a space's folder, one or two levels down
/// (`~/Work/acme`, `~/Work/projects/acme`), so main can tell which repo a
/// request is about. Worktree folders and hidden folders are left out.
pub fn repos(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let subdirs = |dir: &Path| -> Vec<std::path::PathBuf> {
        let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
        let mut v: Vec<_> = rd
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
            .filter(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                !n.starts_with('.') && !SKIP.contains(&n.as_str()) && n != "worktrees"
            })
            .map(|e| e.path())
            .collect();
        v.sort();
        v
    };
    for d in subdirs(root) {
        if d.join(".git").exists() {
            out.push(d.display().to_string());
            continue;
        }
        for d2 in subdirs(&d) {
            if d2.join(".git").exists() {
                out.push(d2.display().to_string());
            }
        }
        if out.len() >= 200 {
            break;
        }
    }
    out
}

#[tauri::command]
pub async fn fs_repos(root: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || repos(Path::new(&root))).await.unwrap_or_default()
}

#[cfg(test)]
mod repo_tests {
    use super::*;

    #[test]
    fn finds_repos_one_or_two_levels_down() {
        let root = std::env::temp_dir().join(format!("ondra-repos-{}", std::process::id()));
        for d in ["top/.git", "projects/acme/.git", "projects/notes", "worktrees/acme/feat/.git", ".hidden/.git", "projects/acme/sub/.git"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let found: Vec<_> = repos(&root).into_iter().map(std::path::PathBuf::from).collect();
        assert_eq!(found, vec![root.join("projects/acme"), root.join("top")]);
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// Save text the user edited. Refused when the file changed on disk since it was
/// opened (`expect` = the `modified` it was read with), so a job's edit isn't lost.
fn write(path: &str, text: &str, expect: Option<u64>) -> Result<u64, String> {
    let meta = std::fs::metadata(path).map_err(|_| "파일이 없어요".to_string())?;
    let now = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64);
    if let Some(e) = expect {
        if e != 0 && now != 0 && e != now {
            return Err("CHANGED".into());
        }
    }
    std::fs::write(path, text).map_err(|e| e.to_string())?;
    let after = std::fs::metadata(path).ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
    Ok(after.map_or(0, |d| d.as_millis() as u64))
}

#[tauri::command]
pub async fn fs_write(path: String, text: String, expect: Option<u64>) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || write(&path, &text, expect)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn fs_read(path: String) -> Result<FileText, String> {
    tauri::async_runtime::spawn_blocking(move || read(&path)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn copy_image_puts_the_picture_on_the_clipboard() {
        let pixels: Vec<u8> = vec![255, 0, 0, 255, 0, 0, 255, 255];
        let mut png = Vec::new();
        image::RgbaImage::from_raw(2, 1, pixels.clone()).unwrap().write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png).unwrap();
        copy_image(png).unwrap();
        let got = arboard::Clipboard::new().unwrap().get_image().unwrap();
        assert_eq!((got.width, got.height), (2, 1));
        assert_eq!(got.bytes.as_ref(), pixels.as_slice());
    }

    #[cfg(unix)]
    #[test]
    fn shared_files_and_search_only_follow_links_within_the_project() {
        let base = std::env::temp_dir().join(format!("ondra-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let project = base.join("project");
        std::fs::create_dir_all(&project).unwrap();
        assert!(std::process::Command::new("git").arg("init").arg("-q").current_dir(&project).status().unwrap().success());
        std::fs::write(project.join("readme"), "project update").unwrap();
        std::fs::write(base.join("notes"), "other update").unwrap();
        std::os::unix::fs::symlink("readme", project.join("alias")).unwrap();
        std::os::unix::fs::symlink("../notes", project.join("shared-notes")).unwrap();
        let root = project.canonicalize().unwrap();
        let dir = root.to_str().unwrap();
        assert_eq!(list(dir, Some(&root)), ["alias", "readme"]);
        let hits = grep(dir, "update", Some(&root));
        assert_eq!(hits.iter().map(|h| (h.path.as_str(), h.text.as_str())).collect::<Vec<_>>(), [("alias", "project update"), ("readme", "project update")]);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn lists_and_reads() {
        let root = std::env::temp_dir().join(format!("fs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join("src/a.ts"), "one\ntwo\n").unwrap();
        std::fs::write(root.join("node_modules/x/i.js"), "x").unwrap();
        std::fs::write(root.join("b.bin"), [0u8, 1, 2]).unwrap();
        let files = list(&root.display().to_string(), None);
        assert_eq!(files, vec!["b.bin".to_string(), "src/a.ts".to_string()]);
        let t = read(&root.join("src/a.ts").display().to_string()).unwrap();
        assert_eq!(t.text.as_deref(), Some("one\ntwo\n"));
        assert!(read(&root.join("b.bin").display().to_string()).unwrap().binary);
        assert!(read(&root.join("nope").display().to_string()).is_err());
        let hits = grep(&root.display().to_string(), "TWO", None);
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].path.as_str(), hits[0].line), ("src/a.ts", 2));
        let a = root.join("src/a.ts").display().to_string();
        let m = read(&a).unwrap().modified;
        let m2 = write(&a, "three\n", Some(m)).unwrap();
        assert_eq!(read(&a).unwrap().text.as_deref(), Some("three\n"));
        assert_eq!(write(&a, "stale\n", Some(m2.saturating_sub(5_000))).unwrap_err(), "CHANGED");
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

/// Files copied in Finder (or by a screenshot tool) as files, not as pictures: the web
/// view only gets their names, so read their paths from the macOS pasteboard.
#[tauri::command]
pub async fn clipboard_files() -> Vec<String> {
    const JS: &str = r#"ObjC.import("AppKit");
const urls = $.NSPasteboard.generalPasteboard.readObjectsForClassesOptions($([$.NSURL]), $({ NSPasteboardURLReadingFileURLsOnlyKey: true }));
const out = [];
if (urls) for (let i = 0; i < urls.count; i++) out.push(ObjC.unwrap(urls.objectAtIndex(i).path));
JSON.stringify(out)"#;
    let out = tauri::async_runtime::spawn_blocking(|| std::process::Command::new("/usr/bin/osascript").args(["-l", "JavaScript", "-e", JS]).output())
        .await
        .ok()
        .and_then(|r| r.ok());
    let Some(out) = out.filter(|o| o.status.success()) else { return vec![] };
    serde_json::from_slice::<Vec<String>>(&out.stdout)
        .unwrap_or_default()
        .into_iter()
        .filter(|p| std::path::Path::new(p).is_file())
        .collect()
}

/// A picture (PNG bytes) onto the system clipboard. The web view's own clipboard
/// refuses images once the click's permission has lapsed, which drawing the picture
/// takes long enough to do.
#[tauri::command]
pub fn copy_image(bytes: Vec<u8>) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > 60 * 1024 * 1024 {
        return Err("이미지가 비었거나 너무 커요".into());
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypePNG};
        use objc2_foundation::NSData;
        let data = NSData::with_bytes(&bytes);
        let board = NSPasteboard::generalPasteboard();
        board.clearContents();
        if unsafe { board.setData_forType(Some(&data), NSPasteboardTypePNG) } {
            Ok(())
        } else {
            Err("클립보드에 넣지 못했어요".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        // On Linux the app itself serves what it put on the clipboard: the board stays open for later pastes.
        static BOARD: std::sync::Mutex<Option<arboard::Clipboard>> = std::sync::Mutex::new(None);
        let picture = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).map_err(|_| "이미지를 읽지 못했어요".to_string())?.into_rgba8();
        let (width, height) = picture.dimensions();
        let data = arboard::ImageData { width: width as usize, height: height as usize, bytes: picture.into_raw().into() };
        let mut board = BOARD.lock().unwrap_or_else(|e| e.into_inner());
        if board.is_none() {
            *board = Some(arboard::Clipboard::new().map_err(|_| "클립보드를 열지 못했어요".to_string())?);
        }
        board.as_mut().map_or(Ok(()), |b| b.set_image(data)).map_err(|_| "클립보드에 넣지 못했어요".into())
    }
}

/// Make a new project folder (main can start a project somewhere new). Only inside home.
#[tauri::command]
pub fn ensure_dir(path: String) -> Result<String, String> {
    let home = crate::engine::user_home().ok_or("홈 폴더를 찾지 못했어요")?;
    let input = Path::new(&path);
    let pb = input.strip_prefix("~").map(|rest| home.join(rest)).unwrap_or_else(|_| input.to_owned());
    if !pb.is_absolute() || !pb.starts_with(&home) || pb.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("홈 폴더 안의 절대 경로만 만들 수 있어요".into());
    }
    std::fs::create_dir_all(&pb).map_err(|e| e.to_string())?;
    Ok(pb.display().to_string())
}

/// Save a picture the user asked for into ~/Downloads (a free name), and return its path.
#[tauri::command]
pub async fn save_download(bytes: Vec<u8>, name: String) -> Result<String, String> {
    if bytes.len() > 60 * 1024 * 1024 {
        return Err("파일이 너무 커요".into());
    }
    let clean: String = name.chars().filter(|c| !matches!(c, '/' | '\\' | ':' | '\0')).take(80).collect();
    let clean = if clean.trim().is_empty() { "ondra.png".to_string() } else { clean.trim().to_string() };
    let dir = crate::engine::home().join("Downloads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let p = Path::new(&clean);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("ondra").to_string();
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("png").to_string();
    let mut path = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} {n}.{ext}"));
        n += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// One space's own view of the job logs, for btw and the side chat: a folder
/// holding only that space's job and main-chat logs (hard links, so it costs no
/// space and grows as the logs do), so they never read the other space's.
#[tauri::command]
pub async fn space_logs(app: tauri::AppHandle, space: String, ids: Vec<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = crate::engine::data_dir(&app);
        let key = crate::browser::space_key(&space);
        let dest = data.join("spaces").join(&key).join("logs");
        std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        let ok = |s: &str| Path::new(s).file_name().is_some_and(|n| n == s) && !s.contains("..") && !(cfg!(windows) && s.contains(':'));
        let mut keep: std::collections::HashSet<String> = ids.into_iter().filter(|s| ok(s)).collect();
        // main chats of this space: captain-<space> and captain-<space>-<project>
        let sessions = data.join("sessions");
        if let Ok(dir) = std::fs::read_dir(&sessions) {
            for e in dir.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name == format!("captain-{key}") || name.starts_with(&format!("captain-{key}-")) {
                    keep.insert(name);
                }
            }
        }
        for id in &keep {
            let src = sessions.join(id);
            let Ok(files) = std::fs::read_dir(&src) else { continue };
            let to = dest.join(id);
            let _ = std::fs::create_dir_all(&to);
            for f in files.flatten() {
                let target = to.join(f.file_name());
                if f.path().is_file() && !target.exists() {
                    // a copy only if hard links aren't possible
                    if std::fs::hard_link(f.path(), &target).is_err() {
                        let _ = std::fs::copy(f.path(), &target);
                    }
                }
            }
        }
        // what isn't this space's (any more) goes
        if let Ok(dir) = std::fs::read_dir(&dest) {
            for e in dir.flatten() {
                if !keep.contains(&e.file_name().to_string_lossy().to_string()) {
                    let _ = std::fs::remove_dir_all(e.path());
                }
            }
        }
        Ok(dest.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
