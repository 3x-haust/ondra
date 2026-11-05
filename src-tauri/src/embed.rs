//! Local text embeddings for memory search (meaning, not just words).
//! A small multilingual retrieval model (multilingual-e5-small, 384 numbers per
//! text, Korean and English in one space) runs on this Mac; it is
//! downloaded once into <data dir>/models on first use. Nothing leaves the machine
//! except that one download.

use fastembed::{EmbeddingModel, TextEmbedding, InitOptions};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;

fn slot() -> &'static Mutex<Option<TextEmbedding>> {
    static M: OnceLock<Mutex<Option<TextEmbedding>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(None))
}

fn load(app: &AppHandle) -> Result<(), String> {
    let mut g = slot().lock().map_err(|e| e.to_string())?;
    if g.is_none() {
        let dir = crate::engine::data_dir(app).join("models");
        let _ = std::fs::create_dir_all(&dir);
        let m = TextEmbedding::try_new(InitOptions::new(EmbeddingModel::MultilingualE5Small).with_cache_dir(dir).with_show_download_progress(false))
            .map_err(|e| format!("임베딩 모델을 불러오지 못했어요: {e}"))?;
        *g = Some(m);
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
