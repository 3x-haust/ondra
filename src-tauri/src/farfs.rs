//! Files carried between Macs (Settings › 연결). The Mac doing the work reads a piece of a
//! file to send; the Mac looking on keeps what it got in a cache of its own, and the Mac doing
//! the work keeps attachments sent to it. Pieces travel as base64 inside the JSON lines of the
//! remote helper, so each stays small and the job updates keep flowing between them.
//! Which paths another Mac may ask for is decided on the TypeScript side (engine/farHost.ts);
//! writes here only ever go into this app's own folders.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::Serialize;
use std::{
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

/// one piece, at most (a bigger one would hold up the job updates on the same line)
const MAX_PIECE: u64 = 1 << 20;
/// a file put together here, at most
const MAX_PUT: u64 = 256 << 20;
/// cached files of another Mac are dropped after a week unused
const CACHE_DAYS: u64 = 7;

fn ms(t: std::io::Result<SystemTime>) -> u64 {
    t.ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_millis() as u64)
}

#[derive(Serialize)]
pub struct Stat {
    size: u64,
    modified: u64,
    dir: bool,
}

#[derive(Serialize)]
pub struct Piece {
    /// the bytes, base64
    data: String,
    size: u64,
    modified: u64,
}

fn stat(path: &str) -> Option<Stat> {
    let m = std::fs::metadata(path).ok()?;
    Some(Stat { size: m.len(), modified: ms(m.modified()), dir: m.is_dir() })
}

fn piece(path: &str, offset: u64, len: u64) -> Result<Piece, String> {
    let mut f = std::fs::File::open(path).map_err(|_| "파일이 없어요".to_string())?;
    let m = f.metadata().map_err(|e| e.to_string())?;
    if m.is_dir() {
        return Err("폴더예요".into());
    }
    let size = m.len();
    let len = len.min(MAX_PIECE);
    let mut buf = Vec::with_capacity(len.min(size.saturating_sub(offset)) as usize);
    if offset < size {
        f.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        f.take(len).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    }
    Ok(Piece { data: STANDARD.encode(&buf), size, modified: ms(m.modified()) })
}

/// A file name that stays inside its folder: letters, digits and . - _ only, never "." or "..".
fn safe_name(name: &str) -> Option<String> {
    let s: String = name.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')).take(120).collect();
    let s = s.trim_start_matches('.').to_string();
    (!s.is_empty()).then_some(s)
}

fn dir_for(data: &Path, kind: &str) -> Result<PathBuf, String> {
    match kind {
        "cache" => Ok(data.join("remote").join("cache")),
        "upload" => Ok(data.join("attachments").join("remote")),
        _ => Err("unknown".into()),
    }
}

/// Put a piece into `dir/name` at `offset`: 0 starts the file over, the rest must follow on.
fn put(dir: &Path, name: &str, offset: u64, data: &str) -> Result<String, String> {
    let name = safe_name(name).ok_or("이름이 잘못됐어요")?;
    let bytes = STANDARD.decode(data).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_PIECE || offset + bytes.len() as u64 > MAX_PUT {
        return Err("파일이 너무 커요".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(&name);
    let mut f = if offset == 0 {
        std::fs::File::create(&path).map_err(|e| e.to_string())?
    } else {
        let f = std::fs::OpenOptions::new().append(true).open(&path).map_err(|e| e.to_string())?;
        // a piece out of order (or one sent twice) would garble the file
        if f.metadata().map_err(|e| e.to_string())?.len() != offset {
            return Err("조각 순서가 맞지 않아요".into());
        }
        f
    };
    f.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Cached files not used for a week go (looked at when a new one starts).
fn prune(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let old = SystemTime::now() - Duration::from_secs(CACHE_DAYS * 86_400);
    for e in rd.flatten() {
        let used = e.metadata().and_then(|m| m.accessed().or_else(|_| m.modified())).unwrap_or(SystemTime::now());
        if used < old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[tauri::command]
pub fn far_stat(path: String) -> Option<Stat> {
    stat(&path)
}

#[tauri::command]
pub async fn far_piece(path: String, offset: u64, len: u64) -> Result<Piece, String> {
    tauri::async_runtime::spawn_blocking(move || piece(&path, offset, len)).await.map_err(|e| e.to_string())?
}

/// Where each path really is (links followed); None when it doesn't exist.
#[tauri::command]
pub fn far_real(paths: Vec<String>) -> Vec<Option<String>> {
    paths.iter().map(|p| std::fs::canonicalize(p).ok().map(|r| r.display().to_string())).collect()
}

#[tauri::command]
pub async fn far_put(app: tauri::AppHandle, kind: String, name: String, offset: u64, data: String) -> Result<String, String> {
    let dir = dir_for(&crate::engine::data_dir(&app), &kind)?;
    tauri::async_runtime::spawn_blocking(move || {
        if offset == 0 && kind == "cache" {
            prune(&dir);
        }
        put(&dir, &name, offset, &data)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A file already cached from another Mac, if it is.
#[tauri::command]
pub fn far_cached(app: tauri::AppHandle, name: String) -> Option<String> {
    let path = dir_for(&crate::engine::data_dir(&app), "cache").ok()?.join(safe_name(&name)?);
    path.is_file().then(|| path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pieces_go_and_come_back() {
        let root = std::env::temp_dir().join(format!("farfs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let src = root.join("a.bin");
        let bytes: Vec<u8> = (0..3000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&src, &bytes).unwrap();
        let s = src.display().to_string();
        assert_eq!(stat(&s).unwrap().size, 3000);
        let a = piece(&s, 0, 1000).unwrap();
        let b = piece(&s, 1000, 5000).unwrap();
        assert_eq!(a.size, 3000);
        let out = root.join("out");
        assert!(put(&out, "x.bin", 0, &a.data).is_ok());
        // out of order: refused
        assert!(put(&out, "x.bin", 5, &b.data).is_err());
        let p = put(&out, "x.bin", 1000, &b.data).unwrap();
        assert_eq!(std::fs::read(p).unwrap(), bytes);
        // past the end: nothing, no error
        assert_eq!(piece(&s, 9999, 10).unwrap().data, "");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn names_stay_in_their_folder() {
        assert_eq!(safe_name("../../etc/passwd").as_deref(), Some("etcpasswd"));
        assert_eq!(safe_name("..").as_deref(), None);
        assert_eq!(safe_name("ok-1_a.png").as_deref(), Some("ok-1_a.png"));
        assert!(dir_for(Path::new("/d"), "elsewhere").is_err());
    }
}
