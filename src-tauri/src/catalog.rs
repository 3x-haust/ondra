//! The engine's model catalog, kept fresh for each account. The engine adds the models newer than
//! its own build (GPT 6.2 on an engine built before it) from pi.dev's catalog, which it keeps per
//! login folder in models-store.json. It only fetches that catalog when it may use the network at
//! start, which the short-lived engine asked for an account's models never may. So a login made
//! here showed only the engine's built-in models until some later session happened to refresh it.
//! This fetches the catalog for each service the account signs in to, the way the engine does
//! (same file, same entry, same 4-hour window, the etag to revalidate), before its models are asked.
use serde_json::{json, Map, Value};
use std::path::Path;
use std::time::Duration;

const CATALOG: &str = "https://pi.dev/api/models/providers/";
/** the engine's REMOTE_CATALOG_REFRESH_INTERVAL_MS */
const FRESH_MS: i64 = 4 * 60 * 60 * 1000;

/// An HTTP date ("Wed, 18 Nov 2026 12:03:05 GMT") in ms since the epoch.
fn http_date_ms(s: &str) -> Option<i64> {
    let mut p = s.split_whitespace().skip(1);
    let (day, mon, year, time) = (p.next()?.parse().ok()?, p.next()?, p.next()?.parse().ok()?, p.next()?);
    let month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].iter().position(|m| *m == mon)? as u32 + 1;
    let mut t = time.split(':').map(|x| x.parse::<u32>().ok());
    let at = chrono::NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(t.next()??, t.next()??, t.next()??)?;
    Some(at.and_utc().timestamp_millis())
}

/// The catalog's models for one service, each marked with it (the engine's parseCatalog).
fn models_of(provider: &str, body: Value) -> Option<Vec<Value>> {
    let list = match body {
        Value::Array(a) => a,
        Value::Object(mut o) => match o.remove("models") {
            Some(Value::Array(a)) => a,
            Some(_) => return None,
            None => o.into_iter().map(|(_, v)| v).collect(),
        },
        _ => return None,
    };
    Some(
        list.into_iter()
            .filter_map(|m| match m {
                Value::Object(mut o) if o.contains_key("id") => {
                    o.insert("provider".into(), json!(provider));
                    Some(Value::Object(o))
                }
                _ => None,
            })
            .collect(),
    )
}

/// Whether a stored entry is due: never checked, never dated, or checked over 4 hours ago.
fn due(entry: Option<&Value>, now: i64) -> bool {
    let Some(e) = entry else { return true };
    match (e["checkedAt"].as_i64(), e["lastModified"].as_i64()) {
        (Some(at), Some(_)) => now - at >= FRESH_MS,
        _ => true,
    }
}

/// The entry to keep after one answer from the catalog (the engine's withRemoteCatalog).
fn next_entry(provider: &str, stored: Option<&Value>, status: u16, etag: Option<String>, last_modified: Option<&str>, body: Option<Value>, now: i64) -> Option<Value> {
    let mut kept = stored.cloned().unwrap_or_else(|| json!({ "models": [] }));
    match status {
        304 if stored.is_some() => kept["checkedAt"] = json!(now),
        404 | 501 => {
            kept["checkedAt"] = json!(now);
            kept["lastModified"] = json!(0);
            kept.as_object_mut()?.remove("etag");
        }
        200..=299 => {
            let models = models_of(provider, body?)?;
            let mut e = Map::new();
            e.insert("models".into(), Value::Array(models));
            e.insert("checkedAt".into(), json!(now));
            e.insert("lastModified".into(), json!(last_modified.and_then(http_date_ms).unwrap_or(0)));
            if let Some(tag) = etag {
                e.insert("etag".into(), json!(tag));
            }
            return Some(Value::Object(e));
        }
        // a failure: the cached list and its etag stay; the next ask tries again
        _ => kept["checkedAt"] = json!(now),
    }
    Some(kept)
}

/// Bring the catalog of each service this login folder signs in to up to date (quietly: a
/// failure leaves the store as it was).
pub async fn refresh(dir: &Path) {
    let Ok(auth) = std::fs::read_to_string(dir.join("auth.json")) else { return };
    let Ok(Value::Object(auth)) = serde_json::from_str::<Value>(&auth) else { return };
    let path = dir.join("models-store.json");
    let mut store = std::fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<Map<String, Value>>(&s).ok()).unwrap_or_default();
    let now = chrono::Utc::now().timestamp_millis();
    let Ok(http) = crate::components::client() else { return };
    let mut changed = false;
    for provider in auth.keys().filter(|p| p.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')) {
        let stored = store.get(provider);
        if !due(stored, now) {
            continue;
        }
        let mut req = http.get(format!("{CATALOG}{provider}")).header("accept", "application/json").timeout(Duration::from_secs(8));
        if let Some(tag) = stored.filter(|e| e["models"].as_array().is_some_and(|m| !m.is_empty())).and_then(|e| e["etag"].as_str()) {
            req = req.header("if-none-match", tag);
        }
        let Ok(res) = req.send().await else { continue };
        let status = res.status().as_u16();
        let header = |n: &str| res.headers().get(n).and_then(|v| v.to_str().ok()).map(str::to_string);
        let (etag, last_modified) = (header("etag"), header("last-modified"));
        let body = if res.status().is_success() { res.json::<Value>().await.ok() } else { None };
        if let Some(e) = next_entry(provider, stored, status, etag, last_modified.as_deref(), body, now) {
            store.insert(provider.clone(), e);
            changed = true;
        }
    }
    if changed {
        if let Ok(text) = serde_json::to_string_pretty(&Value::Object(store)) {
            // whole or not at all: an engine reading it never sees half a file
            let tmp = path.with_extension("json.ondra-tmp");
            if std::fs::write(&tmp, text).is_ok() {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
                }
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_date_the_catalog_was_last_changed() {
        assert_eq!(http_date_ms("Wed, 18 Nov 2026 12:03:05 GMT"), Some(1_795_003_385_000));
        assert_eq!(http_date_ms("not a date"), None);
    }

    #[test]
    fn marks_each_model_with_its_service_whatever_shape_the_catalog_has() {
        let one = |b: Value| models_of("openai-codex", b).unwrap().iter().map(|m| (m["id"].as_str().unwrap().to_string(), m["provider"].as_str().unwrap().to_string())).collect::<Vec<_>>();
        let want = vec![("gpt-6.2-sol".to_string(), "openai-codex".to_string())];
        assert_eq!(one(json!([{ "id": "gpt-6.2-sol", "provider": "x" }, "junk"])), want);
        assert_eq!(one(json!({ "models": [{ "id": "gpt-6.2-sol" }] })), want);
        assert_eq!(one(json!({ "gpt-6.2-sol": { "id": "gpt-6.2-sol" } })), want);
        assert!(models_of("openai-codex", json!("x")).is_none());
    }

    #[test]
    fn asks_again_only_after_four_hours_or_when_never_dated() {
        let now = 10 * FRESH_MS;
        assert!(due(None, now));
        assert!(due(Some(&json!({})), now));
        assert!(due(Some(&json!({ "checkedAt": now - 1 })), now));
        assert!(!due(Some(&json!({ "checkedAt": now - 1, "lastModified": 5 })), now));
        assert!(due(Some(&json!({ "checkedAt": now - FRESH_MS, "lastModified": 5 })), now));
    }

    #[test]
    fn keeps_what_it_had_on_a_failure_and_replaces_it_on_an_answer() {
        let had = json!({ "models": [{ "id": "a" }], "etag": "t", "lastModified": 7, "checkedAt": 1 });
        let failed = next_entry("p", Some(&had), 503, None, None, None, 9).unwrap();
        assert_eq!((failed["etag"].as_str(), failed["lastModified"].as_i64(), failed["checkedAt"].as_i64()), (Some("t"), Some(7), Some(9)));
        let same = next_entry("p", Some(&had), 304, None, None, None, 9).unwrap();
        assert_eq!((same["models"][0]["id"].as_str(), same["checkedAt"].as_i64()), (Some("a"), Some(9)));
        let gone = next_entry("p", Some(&had), 404, None, None, None, 9).unwrap();
        assert_eq!((gone["lastModified"].as_i64(), gone.get("etag")), (Some(0), None));
        let new = next_entry("p", Some(&had), 200, Some("u".into()), Some("Wed, 18 Nov 2026 12:03:05 GMT"), Some(json!([{ "id": "b" }])), 9).unwrap();
        assert_eq!((new["models"][0]["id"].as_str(), new["models"][0]["provider"].as_str(), new["etag"].as_str(), new["lastModified"].as_i64()), (Some("b"), Some("p"), Some("u"), Some(1_795_003_385_000)));
    }

    /// against pi.dev itself: `cargo test --lib catalog -- --ignored`
    #[test]
    #[ignore]
    fn a_fresh_login_folder_gets_the_catalog() {
        let dir = std::env::temp_dir().join(format!("ondra-catalog-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("auth.json"), r#"{"openai-codex":{}}"#).unwrap();
        std::fs::write(dir.join("models-store.json"), "{}").unwrap();
        tauri::async_runtime::block_on(refresh(&dir));
        let store: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("models-store.json")).unwrap()).unwrap();
        let e = &store["openai-codex"];
        assert!(e["models"].as_array().unwrap().iter().any(|m| m["id"].as_str().unwrap_or("").starts_with("gpt-")));
        assert!(e["lastModified"].as_i64().unwrap() > 0 && e["etag"].is_string());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
