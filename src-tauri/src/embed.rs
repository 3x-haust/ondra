//! Local text embeddings for memory search (meaning, not just words).
//! A small multilingual retrieval model (multilingual-e5-small, 384 numbers per
//! text, Korean and English in one space) runs on this Mac; it is
//! downloaded once into <data dir>/models on first use. Nothing leaves the machine
//! except that one download.

use fastembed::{EmbeddingModel, TextEmbedding, InitOptions};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

fn slot() -> &'static Mutex<Option<TextEmbedding>> {
    static M: OnceLock<Mutex<Option<TextEmbedding>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(None))
}

/// When the model was last used (seconds since the epoch).
static LAST_USE: AtomicU64 = AtomicU64::new(0);
/// The model and its working memory take 600+ MB once loaded; it is put away after this long
/// unused and loaded again (about a second) when a search needs it.
const IDLE_SECS: u64 = 180;

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn load(app: &AppHandle) -> Result<(), String> {
    LAST_USE.store(now_secs(), Ordering::Relaxed);
    let mut g = slot().lock().map_err(|e| e.to_string())?;
    if g.is_none() {
        let dir = crate::engine::data_dir(app).join("models");
        let _ = std::fs::create_dir_all(&dir);
        let m = TextEmbedding::try_new(InitOptions::new(EmbeddingModel::MultilingualE5Small).with_cache_dir(dir).with_show_download_progress(false))
            .map_err(|e| format!("임베딩 모델을 불러오지 못했어요: {e}"))?;
        *g = Some(m);
        // a watch while it is loaded: put it away once it sits unused
        std::thread::spawn(|| loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            if now_secs().saturating_sub(LAST_USE.load(Ordering::Relaxed)) < IDLE_SECS {
                continue;
            }
            // busy embedding (it holds the lock): look again later
            let Ok(mut g) = slot().try_lock() else { continue };
            // used again just now (between the look and the lock): keep it
            if now_secs().saturating_sub(LAST_USE.load(Ordering::Relaxed)) < IDLE_SECS {
                continue;
            }
            *g = None;
            return;
        });
    }
    Ok(())
}

/// Vectors for texts (unit length, so a dot product is the cosine).
#[tauri::command]
pub async fn embed_texts(app: AppHandle, texts: Vec<String>, query: Option<bool>) -> Result<Vec<Vec<f32>>, String> {
    if texts.is_empty() {
        return Ok(vec![]);
    }
    // e5 wants to know which side a text is on
    let tag = if query.unwrap_or(false) { "query: " } else { "passage: " };
    let texts: Vec<String> = texts.into_iter().map(|t| format!("{tag}{t}")).collect();
    tauri::async_runtime::spawn_blocking(move || {
        load(&app)?;
        let mut g = slot().lock().map_err(|e| e.to_string())?;
        let m = g.as_mut().ok_or("no model")?;
        let mut out = m.embed(texts, Some(32)).map_err(|e| e.to_string())?;
        LAST_USE.store(now_secs(), Ordering::Relaxed);
        for v in out.iter_mut() {
            let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
            if n > 0.0 {
                v.iter_mut().for_each(|x| *x /= n);
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}
