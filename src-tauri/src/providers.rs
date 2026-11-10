//! Direct connections: any OpenAI-, Anthropic- or Google-compatible address
//! (Ollama, LM Studio, vLLM, OpenRouter, a company gateway…) used as an account.
//!
//! Each connection is written as one provider in the account's engine
//! `models.json` (its `PI_CODING_AGENT_DIR`), merged with whatever else is there.
//! Keys and header values never go into that file: they live in the macOS
//! keychain and the file names them with the engine's `!command` form, which
//! the engine runs when it sends a request. Nothing here prints or logs a key.
//!
//! Listing models and the connection check run here rather than in the webview,
//! so localhost and servers without CORS work.

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::AppHandle;

pub const SERVICE: &str = "dev.3xhaust.ondra.provider";
const SECURITY: &str = "/usr/bin/security";
/// what a keyless provider gets: the engine lists a provider's models only once it has some key
pub const NO_KEY: &str = "none";

// ───────────── keychain

/// Characters a keychain account name may have here: it is pasted into a shell command.
fn safe_name(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | ':'))
}

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

/// Stores (or replaces) a secret. It goes to `security` on stdin as hex, never on a command line.
pub fn secret_set(service: &str, account: &str, value: &str) -> Result<(), String> {
    if !safe_name(service) || !safe_name(account) {
        return Err("bad keychain name".into());
    }
    let mut child = Command::new(SECURITY)
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    {
        let mut stdin = child.stdin.take().ok_or("stdin")?;
        // -U replaces an existing item; the creator (/usr/bin/security) stays trusted, so the
        // engine's `security find-generic-password` reads it without asking
        let line = format!("add-generic-password -U -s {service} -a {account} -l \"Ondra provider key\" -X {}\n", hex(value));
        stdin.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("keychain write failed".into());
    }
    if secret_exists(service, account) { Ok(()) } else { Err("keychain write failed".into()) }
}

/// Whether an item is there (attributes only; the secret is not read).
pub fn secret_exists(service: &str, account: &str) -> bool {
    Command::new(SECURITY)
        .args(["find-generic-password", "-s", service, "-a", account])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// The secret, for a request made from here (listing models, the check). Never returned to the webview.
pub fn secret_get(service: &str, account: &str) -> Option<String> {
    let out = Command::new(SECURITY)
        .args(["find-generic-password", "-s", service, "-a", account, "-w"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let mut v = String::from_utf8(out.stdout).ok()?;
    if v.ends_with('\n') {
        v.pop();
    }
    (!v.is_empty()).then_some(v)
}

pub fn secret_delete(service: &str, account: &str) {
    // a name can have several items (made twice by hand): delete until none is left
    for _ in 0..8 {
        let ok = Command::new(SECURITY)
            .args(["delete-generic-password", "-s", service, "-a", account])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success());
        if !ok {
            break;
        }
    }
}

/// The engine's command form for a keychain item: `!security find-generic-password … -w`.
pub fn secret_ref(service: &str, account: &str) -> String {
    format!("!{SECURITY} find-generic-password -s '{service}' -a '{account}' -w")
}

/// The keychain account a `secret_ref` value names, when it is one of ours.
pub fn ref_account(service: &str, value: &str) -> Option<String> {
    let rest = value.strip_prefix(&format!("!{SECURITY} find-generic-password -s '{service}' -a '"))?;
    let (acct, tail) = rest.split_once('\'')?;
    (tail == " -w" && safe_name(acct)).then(|| acct.to_string())
}

/// keychain account names for one connection: the key, and each header by name
pub fn key_account(account_id: &str, provider: &str) -> String {
    format!("{account_id}/{provider}")
}
fn header_account(account_id: &str, provider: &str, header: &str) -> String {
    format!("{account_id}/{provider}/h/{header}")
}

/// Every keychain item of ours a provider entry names.
pub fn refs_in(service: &str, entry: &Value) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(a) = entry.get("apiKey").and_then(Value::as_str).and_then(|v| ref_account(service, v)) {
        out.push(a);
    }
    if let Some(h) = entry.get("headers").and_then(Value::as_object) {
        out.extend(h.values().filter_map(Value::as_str).filter_map(|v| ref_account(service, v)));
    }
    out
}

// ───────────── models.json

/// models.json may have comments (the engine allows them); they are dropped on write.
fn strip_comments(s: &str) -> String {
    let (mut out, mut chars) = (String::with_capacity(s.len()), s.chars().peekable());
    let mut in_str = false;
    while let Some(c) = chars.next() {
        if in_str {
            out.push(c);
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_str = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                for n in chars.by_ref() {
                    if n == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut prev = ' ';
                for n in chars.by_ref() {
                    if prev == '*' && n == '/' {
                        break;
                    }
                    prev = n;
                }
            }
            _ => out.push(c),
        }
    }
    out
}

/// The file as an object with a `providers` object; an unreadable file is an error, never overwritten.
fn parse_models(text: Option<&str>) -> Result<Map<String, Value>, String> {
    let Some(text) = text.filter(|t| !t.trim().is_empty()) else {
        let mut m = Map::new();
        m.insert("providers".into(), json!({}));
        return Ok(m);
    };
    let v: Value = serde_json::from_str(text)
        .or_else(|_| serde_json::from_str(&strip_comments(text)))
        .map_err(|_| "models.json을 읽을 수 없어요".to_string())?;
    let Value::Object(mut root) = v else { return Err("models.json을 읽을 수 없어요".into()) };
    match root.get("providers") {
        None => {
            root.insert("providers".into(), json!({}));
        }
        Some(Value::Object(_)) => {}
        Some(_) => return Err("models.json을 읽을 수 없어요".into()),
    }
    Ok(root)
}

/// Puts one provider into the file, keeping every other provider and top-level field.
pub fn merge_provider(text: Option<&str>, id: &str, entry: Value) -> Result<String, String> {
    let mut root = parse_models(text)?;
    root.get_mut("providers").and_then(Value::as_object_mut).ok_or("providers")?.insert(id.to_string(), entry);
    serde_json::to_string_pretty(&Value::Object(root)).map(|s| s + "\n").map_err(|e| e.to_string())
}

/// Takes one provider out; returns the new text and the entry that was there.
pub fn remove_provider(text: Option<&str>, id: &str) -> Result<(String, Option<Value>), String> {
    let mut root = parse_models(text)?;
    let old = root.get_mut("providers").and_then(Value::as_object_mut).ok_or("providers")?.remove(id);
    let s = serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())?;
    Ok((s + "\n", old))
}

/// Provider ids in the file (names only).
pub fn provider_ids(text: &str) -> Vec<String> {
    parse_models(Some(text))
        .ok()
        .and_then(|r| r.get("providers").and_then(Value::as_object).map(|p| p.keys().cloned().collect()))
        .unwrap_or_default()
}

pub fn provider_entry(text: Option<&str>, id: &str) -> Option<Value> {
    parse_models(text).ok()?.get("providers")?.get(id).cloned()
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(".models.json.tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn models_path(dir: &Path) -> PathBuf {
    dir.join("models.json")
}

/// Removes every keychain item the folder's models.json names (before the folder goes).
pub fn forget_secrets(dir: &Path) {
    let Ok(text) = std::fs::read_to_string(models_path(dir)) else { return };
    let Ok(root) = parse_models(Some(&text)) else { return };
    for entry in root.get("providers").and_then(Value::as_object).map(|p| p.values().cloned().collect::<Vec<_>>()).unwrap_or_default() {
        for acct in refs_in(SERVICE, &entry) {
            secret_delete(SERVICE, &acct);
        }
    }
}

// ───────────── saving a connection

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderIn {
    name: String,
    /// None = keep the stored value
    value: Option<String>,
}

fn valid_provider_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}
fn valid_header(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Writes the connection into `dir/models.json`. `entry` comes without `apiKey` and
/// `headers`: those are set here from the keychain. `key`: Some("") clears it,
/// Some(k) stores k, None keeps what is stored.
pub fn save_in(service: &str, dir: &Path, account_id: &str, provider: &str, mut entry: Value, key: Option<String>, headers: Vec<HeaderIn>) -> Result<(), String> {
    if !valid_provider_id(provider) || !safe_name(account_id) {
        return Err("bad id".into());
    }
    let path = models_path(dir);
    let text = std::fs::read_to_string(&path).ok();
    let old = provider_entry(text.as_deref(), provider);
    let obj = entry.as_object_mut().ok_or("entry")?;
    obj.remove("apiKey");
    obj.remove("headers");

    let key_acct = key_account(account_id, provider);
    let api_key = match key.as_deref().map(str::trim) {
        Some("") => {
            secret_delete(service, &key_acct);
            NO_KEY.to_string()
        }
        Some(k) => {
            secret_set(service, &key_acct, k)?;
            secret_ref(service, &key_acct)
        }
        None if secret_exists(service, &key_acct) => secret_ref(service, &key_acct),
        None => NO_KEY.to_string(),
    };
    obj.insert("apiKey".into(), Value::String(api_key));

    let mut out = Map::new();
    for h in &headers {
        if !valid_header(&h.name) {
            return Err("bad header".into());
        }
        let acct = header_account(account_id, provider, &h.name);
        match h.value.as_deref() {
            Some(v) if !v.trim().is_empty() => secret_set(service, &acct, v.trim())?,
            Some(_) => continue,
            None if secret_exists(service, &acct) => {}
            None => continue,
        }
        out.insert(h.name.clone(), Value::String(secret_ref(service, &acct)));
    }
    // headers that were there and are gone now
    if let Some(old) = &old {
        let keep: Vec<String> = out.values().filter_map(Value::as_str).filter_map(|v| ref_account(service, v)).collect();
        for acct in refs_in(service, old) {
            if acct != key_acct && !keep.contains(&acct) {
                secret_delete(service, &acct);
            }
        }
    }
    if !out.is_empty() {
        obj.insert("headers".into(), Value::Object(out));
    }
    let next = merge_provider(text.as_deref(), provider, entry)?;
    write_atomic(&path, &next)
}

pub fn remove_in(service: &str, dir: &Path, account_id: &str, provider: &str) -> Result<(), String> {
    let path = models_path(dir);
    let text = std::fs::read_to_string(&path).ok();
    let (next, old) = remove_provider(text.as_deref(), provider)?;
    if let Some(old) = old {
        for acct in refs_in(service, &old) {
            secret_delete(service, &acct);
        }
    }
    secret_delete(service, &key_account(account_id, provider));
    if text.is_some() {
        write_atomic(&path, &next)?;
    }
    Ok(())
}

fn own_dir(app: &AppHandle, account_id: &str) -> Result<PathBuf, String> {
    // the user's own ~/.pi/agent is never written: a connection is always an Ondra-made account
    crate::store::account_dir(app, account_id).ok_or_else(|| "bad account".to_string())
}

#[tauri::command]
pub fn provider_save(app: AppHandle, account_id: String, provider: String, entry: Value, key: Option<String>, headers: Vec<HeaderIn>) -> Result<(), String> {
    let dir = own_dir(&app, &account_id)?;
    save_in(SERVICE, &dir, &account_id, &provider, entry, key, headers)
}

#[tauri::command]
pub fn provider_remove(app: AppHandle, account_id: String, provider: String) -> Result<(), String> {
    let dir = own_dir(&app, &account_id)?;
    remove_in(SERVICE, &dir, &account_id, &provider)
}

// ───────────── talking to the server

/// Where to ask, and with what. A key or header value that is None is read from
/// the keychain item of `stored` (editing a saved connection).
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    base_url: String,
    api: String,
    key: Option<String>,
    #[serde(default)]
    headers: Vec<HeaderIn2>,
    stored: Option<StoredRef>,
}
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HeaderIn2 {
    name: String,
    value: Option<String>,
}
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StoredRef {
    account_id: String,
    provider: String,
}

/// Why a request didn't go through, for a plain sentence in the UI.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Fail {
    /// unreachable · timeout · auth · notFound · model · rate · server · http · badResponse · badUrl
    pub kind: &'static str,
    pub status: Option<u16>,
    pub detail: String,
}
fn fail(kind: &'static str, status: Option<u16>, detail: impl Into<String>) -> Fail {
    Fail { kind, status, detail: detail.into() }
}

struct Resolved {
    base: String,
    api: String,
    key: Option<String>,
    headers: Vec<(String, String)>,
}

fn resolve(t: Target) -> Result<Resolved, Fail> {
    let base = t.base_url.trim().trim_end_matches('/').to_string();
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err(fail("badUrl", None, ""));
    }
    let from_store = |acct: &str| secret_get(SERVICE, acct);
    let key = match (&t.key, &t.stored) {
        (Some(k), _) => Some(k.trim().to_string()).filter(|k| !k.is_empty()),
        (None, Some(s)) => from_store(&key_account(&s.account_id, &s.provider)),
        (None, None) => None,
    };
    let mut headers = Vec::new();
    for h in t.headers {
        if !valid_header(&h.name) {
            continue;
        }
        let v = match (h.value, &t.stored) {
            (Some(v), _) => Some(v.trim().to_string()).filter(|v| !v.is_empty()),
            (None, Some(s)) => from_store(&header_account(&s.account_id, &s.provider, &h.name)),
            (None, None) => None,
        };
        if let Some(v) = v {
            headers.push((h.name, v));
        }
    }
    Ok(Resolved { base, api: t.api, key, headers })
}

fn client(timeout: Duration) -> Result<reqwest::Client, Fail> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent(concat!("Ondra/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(8))
        .timeout(timeout)
        .build()
        .map_err(|e| fail("http", None, e.to_string()))
}

fn anthropic_root(base: &str) -> &str {
    base.strip_suffix("/v1").unwrap_or(base)
}

fn with_auth(r: &Resolved, mut req: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    match r.api.as_str() {
        "anthropic-messages" => {
            req = req.header("anthropic-version", "2023-06-01");
            if let Some(k) = &r.key {
                req = req.header("x-api-key", k);
            }
        }
        "google-generative-ai" => {
            if let Some(k) = &r.key {
                req = req.header("x-goog-api-key", k);
            }
        }
        _ => {
            if let Some(k) = &r.key {
                req = req.bearer_auth(k);
            }
        }
    }
    for (k, v) in &r.headers {
        req = req.header(k, v);
    }
    req
}

/// A short error text from the server, with any key taken out.
fn detail_of(body: &str, r: &Resolved) -> String {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            let e = v.get("error").cloned().unwrap_or(v.clone());
            e.get("message").and_then(Value::as_str).map(str::to_string).or_else(|| e.as_str().map(str::to_string)).or_else(|| v.get("detail").and_then(Value::as_str).map(str::to_string))
        })
        .unwrap_or_else(|| body.trim().to_string());
    let mut msg: String = msg.chars().filter(|c| !c.is_control()).take(240).collect();
    for s in r.key.iter().chain(r.headers.iter().map(|(_, v)| v)) {
        if s.len() >= 4 {
            msg = msg.replace(s.as_str(), "•••");
        }
    }
    msg
}

fn net_fail(e: reqwest::Error) -> Fail {
    if e.is_timeout() {
        fail("timeout", None, "")
    } else if e.is_connect() {
        fail("unreachable", None, "")
    } else if e.is_builder() {
        fail("badUrl", None, "")
    } else {
        fail("unreachable", None, "")
    }
}

fn status_fail(status: u16, body: &str, r: &Resolved) -> Fail {
    let d = detail_of(body, r);
    let low = d.to_lowercase();
    let about_model = low.contains("model") && (low.contains("not found") || low.contains("does not exist") || low.contains("unknown") || low.contains("not available") || low.contains("no such") || low.contains("invalid model"));
    match status {
        401 | 403 => fail("auth", Some(status), d),
        _ if about_model => fail("model", Some(status), d),
        404 => fail("notFound", Some(status), d),
        429 => fail("rate", Some(status), d),
        500..=599 => fail("server", Some(status), d),
        _ => fail("http", Some(status), d),
    }
}

async fn send(r: &Resolved, req: reqwest::RequestBuilder) -> Result<(u16, String), Fail> {
    let res = with_auth(r, req).send().await.map_err(net_fail)?;
    let status = res.status().as_u16();
    let body = res.text().await.map_err(net_fail)?;
    Ok((status, body))
}

// ── listing models

#[derive(Serialize, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<bool>,
}

fn num(v: Option<&Value>) -> Option<u64> {
    v.and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|f| f as u64)).or_else(|| v.as_str().and_then(|s| s.parse().ok()))).filter(|n| *n > 0)
}
fn strs(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_lowercase).collect()).unwrap_or_default()
}

/// Not a chat model: embeddings, speech, images, moderation.
fn not_chat(id: &str, m: &Value) -> bool {
    let low = id.to_lowercase();
    let kind = m.get("type").and_then(Value::as_str).unwrap_or_default().to_lowercase();
    if matches!(kind.as_str(), "embedding" | "embeddings" | "image" | "audio" | "moderation" | "rerank") {
        return true;
    }
    let methods = strs(m.get("supportedGenerationMethods"));
    if !methods.is_empty() && !methods.iter().any(|x| x == "generatecontent") {
        return true;
    }
    ["embed", "whisper", "tts", "dall-e", "moderation", "rerank", "text-to-speech", "transcribe"].iter().any(|w| low.contains(w))
}

/// Models in a `/models` (OpenAI, OpenRouter, LM Studio, vLLM, Together, Anthropic, Gemini)
/// or `/api/tags` (Ollama) reply.
pub fn parse_models_reply(body: &Value) -> Vec<Found> {
    let list = body
        .get("data")
        .and_then(Value::as_array)
        .or_else(|| body.get("models").and_then(Value::as_array))
        .or_else(|| body.as_array());
    let Some(list) = list else { return vec![] };
    let mut out: Vec<Found> = Vec::new();
    for m in list {
        let raw = m.get("id").or_else(|| m.get("model")).or_else(|| m.get("name")).and_then(Value::as_str).unwrap_or_default();
        let id = raw.strip_prefix("models/").unwrap_or(raw).trim().to_string();
        if id.is_empty() || not_chat(&id, m) || out.iter().any(|f| f.id == id) {
            continue;
        }
        let params = strs(m.get("supported_parameters"));
        let caps = strs(m.get("capabilities"));
        let mods = strs(m.pointer("/architecture/input_modalities"));
        let name = m
            .get("display_name")
            .or_else(|| m.get("displayName"))
            .or_else(|| m.get("name").filter(|_| m.get("id").is_some()))
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|n| n != &id && n != raw);
        let tools = if !params.is_empty() {
            Some(params.iter().any(|p| p == "tools" || p == "tool_choice"))
        } else if !caps.is_empty() {
            Some(caps.iter().any(|c| c == "tools" || c == "tool_use" || c == "function_calling"))
        } else {
            None
        };
        let reasoning = if !params.is_empty() {
            Some(params.iter().any(|p| p == "reasoning" || p == "include_reasoning" || p == "reasoning_effort"))
        } else if !caps.is_empty() {
            Some(caps.iter().any(|c| c == "thinking" || c == "reasoning"))
        } else {
            m.get("thinking").and_then(Value::as_bool)
        };
        let image = if !mods.is_empty() {
            Some(mods.iter().any(|x| x == "image"))
        } else if !caps.is_empty() {
            Some(caps.iter().any(|c| c == "vision" || c == "image"))
        } else {
            None
        };
        out.push(Found {
            id,
            name,
            context_window: num(m.get("context_length"))
                .or_else(|| num(m.get("context_window")))
                .or_else(|| num(m.get("max_context_length")))
                .or_else(|| num(m.get("max_model_len")))
                .or_else(|| num(m.get("inputTokenLimit")))
                .or_else(|| num(m.pointer("/top_provider/context_length"))),
            max_tokens: num(m.pointer("/top_provider/max_completion_tokens")).or_else(|| num(m.get("outputTokenLimit"))).or_else(|| num(m.get("max_output_tokens"))),
            tools,
            reasoning,
            image,
        });
    }
    out
}

/// `http://localhost:11434/v1` → `http://localhost:11434`
fn ollama_root(base: &str) -> &str {
    base.strip_suffix("/v1").unwrap_or(base)
}

async fn list_models(r: &Resolved) -> Result<Vec<Found>, Fail> {
    let http = client(Duration::from_secs(15))?;
    let url = match r.api.as_str() {
        "anthropic-messages" => format!("{}/v1/models?limit=1000", anthropic_root(&r.base)),
        "google-generative-ai" => format!("{}/models?pageSize=1000", r.base),
        _ => format!("{}/models", r.base),
    };
    let first = send(r, http.get(&url)).await;
    let first_err = match first {
        Ok((200..=299, body)) => match serde_json::from_str::<Value>(&body) {
            Ok(v) => {
                let found = parse_models_reply(&v);
                if !found.is_empty() {
                    return Ok(found);
                }
                fail("badResponse", Some(200), "")
            }
            Err(_) => fail("badResponse", Some(200), ""),
        },
        Ok((status, body)) => status_fail(status, &body, r),
        Err(e) => e,
    };
    // Ollama's own list, for servers where /v1/models is missing or empty
    if r.api == "openai-completions" && !matches!(first_err.kind, "unreachable" | "timeout" | "auth") {
        if let Ok((200..=299, body)) = send(r, http.get(format!("{}/api/tags", ollama_root(&r.base)))).await {
            if let Ok(v) = serde_json::from_str::<Value>(&body) {
                let found = parse_models_reply(&v);
                if !found.is_empty() {
                    return Ok(found);
                }
            }
        }
    }
    Err(first_err)
}

#[tauri::command]
pub async fn provider_models(target: Target) -> Result<Vec<Found>, Fail> {
    let r = resolve(target)?;
    list_models(&r).await
}

// ── the check

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Checked {
    /// whether the model called the one tool it was given; None = couldn't tell
    pub tools: Option<bool>,
    pub ms: u64,
}

const PING: &str = "Reply with OK.";
const CALL: &str = "Call the ping tool now.";

fn request_for(r: &Resolved, http: &reqwest::Client, model: &str, tool: bool, reasoning: bool, legacy_max: bool) -> reqwest::RequestBuilder {
    let base = &r.base;
    match r.api.as_str() {
        "anthropic-messages" => {
            let mut body = json!({ "model": model, "max_tokens": if tool { 256 } else { 16 }, "messages": [{ "role": "user", "content": if tool { CALL } else { PING } }] });
            if tool {
                body["tools"] = json!([{ "name": "ping", "description": "Answers ping.", "input_schema": { "type": "object", "properties": { "text": { "type": "string" } } } }]);
                body["tool_choice"] = json!({ "type": "tool", "name": "ping" });
            }
            http.post(format!("{}/v1/messages", anthropic_root(base))).json(&body)
        }
        "google-generative-ai" => {
            let mut body = json!({ "contents": [{ "role": "user", "parts": [{ "text": if tool { CALL } else { PING } }] }], "generationConfig": { "maxOutputTokens": if tool { 512 } else { 16 } } });
            if tool {
                body["tools"] = json!([{ "functionDeclarations": [{ "name": "ping", "description": "Answers ping.", "parameters": { "type": "OBJECT", "properties": { "text": { "type": "STRING" } } } }] }]);
                body["toolConfig"] = json!({ "functionCallingConfig": { "mode": "ANY" } });
            }
            http.post(format!("{base}/models/{model}:generateContent")).json(&body)
        }
        "openai-responses" => {
            let mut body = json!({ "model": model, "input": if tool { CALL } else { PING }, "max_output_tokens": if tool { 512 } else { 16 } });
            if tool {
                body["tools"] = json!([{ "type": "function", "name": "ping", "description": "Answers ping.", "parameters": { "type": "object", "properties": { "text": { "type": "string" } } } }]);
                body["tool_choice"] = json!("required");
            }
            if reasoning {
                body["reasoning"] = json!({ "effort": "low" });
            }
            http.post(format!("{base}/responses")).json(&body)
        }
        _ => {
            // reasoning models think before they answer: leave room so the check sees the answer
            let max = if tool || reasoning { 1024 } else { 16 };
            let mut body = json!({ "model": model, "stream": false, "messages": [{ "role": "user", "content": if tool { CALL } else { PING } }] });
            body[if legacy_max { "max_completion_tokens" } else { "max_tokens" }] = json!(max);
            if tool {
                body["tools"] = json!([{ "type": "function", "function": { "name": "ping", "description": "Answers ping.", "parameters": { "type": "object", "properties": { "text": { "type": "string" } } } } }]);
            }
            if reasoning {
                body["reasoning_effort"] = json!("low");
            }
            http.post(format!("{base}/chat/completions")).json(&body)
        }
    }
}

/// Whether a 2xx reply to the tool request holds a call: Some(true) called, Some(false) answered
/// in words, None cut off before it got there.
pub fn called_tool(api: &str, body: &Value) -> Option<bool> {
    match api {
        "anthropic-messages" => {
            let called = body.get("content").and_then(Value::as_array).is_some_and(|c| c.iter().any(|b| b.get("type").and_then(Value::as_str) == Some("tool_use")));
            if called { Some(true) } else if body.get("stop_reason").and_then(Value::as_str) == Some("max_tokens") { None } else { Some(false) }
        }
        "google-generative-ai" => {
            let parts = body.pointer("/candidates/0/content/parts").and_then(Value::as_array);
            let called = parts.is_some_and(|p| p.iter().any(|x| x.get("functionCall").is_some()));
            if called { Some(true) } else if body.pointer("/candidates/0/finishReason").and_then(Value::as_str) == Some("MAX_TOKENS") { None } else { Some(false) }
        }
        "openai-responses" => {
            let out = body.get("output").and_then(Value::as_array);
            let called = out.is_some_and(|o| o.iter().any(|x| x.get("type").and_then(Value::as_str) == Some("function_call")));
            if called { Some(true) } else if body.get("status").and_then(Value::as_str) == Some("incomplete") { None } else { Some(false) }
        }
        _ => {
            let choice = body.pointer("/choices/0");
            let called = choice.and_then(|c| c.pointer("/message/tool_calls")).and_then(Value::as_array).is_some_and(|a| !a.is_empty());
            if called {
                Some(true)
            } else if choice.and_then(|c| c.get("finish_reason")).and_then(Value::as_str) == Some("length") {
                None
            } else {
                Some(false)
            }
        }
    }
}

/// An error that is about tools (the server has none for this model) rather than about the connection.
fn about_tools(d: &str) -> bool {
    let d = d.to_lowercase();
    d.contains("tool") || d.contains("function call") || d.contains("function_call")
}

/// A field the server didn't take, so the request can go again without it.
fn rejects(d: &str, field: &str) -> bool {
    let d = d.to_lowercase();
    d.contains(field) && (d.contains("unsupported") || d.contains("not supported") || d.contains("unrecognized") || d.contains("unknown") || d.contains("invalid") || d.contains("extra") || d.contains("not allowed") || d.contains("use"))
}

/// `opts` = (send reasoning_effort, use max_completion_tokens); what the server refused is kept for the next request.
async fn ask(r: &Resolved, http: &reqwest::Client, model: &str, tool: bool, opts: &mut (bool, bool)) -> Result<Value, Fail> {
    for _ in 0..3 {
        let (reasoning, legacy) = *opts;
        let (status, body) = send(r, request_for(r, http, model, tool, reasoning, legacy)).await?;
        if (200..300).contains(&status) {
            return serde_json::from_str::<Value>(&body).map_err(|_| fail("badResponse", Some(status), ""));
        }
        let d = detail_of(&body, r);
        if status == 400 && reasoning && rejects(&d, "reasoning") {
            opts.0 = false;
            continue;
        }
        if status == 400 && !legacy && rejects(&d, "max_tokens") {
            opts.1 = true;
            continue;
        }
        return Err(status_fail(status, &body, r));
    }
    Err(fail("http", Some(400), ""))
}

async fn check(r: &Resolved, model: &str, reasoning: bool) -> Result<Checked, Fail> {
    let model = model.trim();
    if model.is_empty() {
        return Err(fail("model", None, ""));
    }
    // local servers load the model on the first request: give it time
    let http = client(Duration::from_secs(120))?;
    let start = std::time::Instant::now();
    let mut opts = (reasoning, false);
    ask(r, &http, model, false, &mut opts).await?;
    let ms = start.elapsed().as_millis() as u64;
    let tools = match ask(r, &http, model, true, &mut opts).await {
        Ok(v) => called_tool(&r.api, &v),
        Err(f) if matches!(f.kind, "http" | "notFound" | "model" | "server") && about_tools(&f.detail) => Some(false),
        Err(_) => None,
    };
    Ok(Checked { tools, ms })
}

#[tauri::command]
pub async fn provider_check(target: Target, model: String, reasoning: bool) -> Result<Checked, Fail> {
    let r = resolve(target)?;
    check(&r, &model, reasoning).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::net::TcpListener;

    #[test]
    fn merges_into_the_file_and_keeps_the_rest() {
        let had = r#"{
          // a comment the engine allows
          "providers": { "mine": { "baseUrl": "http://x/v1", "api": "openai-completions", "models": [{ "id": "a" }] } },
          "extra": 1
        }"#;
        let out = merge_provider(Some(had), "direct-ollama", json!({ "baseUrl": "http://localhost:11434/v1", "api": "openai-completions", "apiKey": "none", "models": [{ "id": "llama3" }] })).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["extra"], 1);
        assert_eq!(v["providers"]["mine"]["models"][0]["id"], "a");
        assert_eq!(v["providers"]["direct-ollama"]["models"][0]["id"], "llama3");
        // replacing the same id
        let again = merge_provider(Some(&out), "direct-ollama", json!({ "baseUrl": "http://h/v1", "api": "openai-completions" })).unwrap();
        let v: Value = serde_json::from_str(&again).unwrap();
        assert_eq!(v["providers"]["direct-ollama"]["baseUrl"], "http://h/v1");
        assert!(v["providers"]["direct-ollama"].get("models").is_none());
        assert_eq!(v["providers"].as_object().unwrap().len(), 2);
        // a missing or empty file
        let fresh: Value = serde_json::from_str(&merge_provider(None, "p", json!({})).unwrap()).unwrap();
        assert_eq!(fresh, json!({ "providers": { "p": {} } }));
        // removing
        let (gone, old) = remove_provider(Some(&again), "direct-ollama").unwrap();
        assert!(old.is_some());
        let v: Value = serde_json::from_str(&gone).unwrap();
        assert!(v["providers"].get("direct-ollama").is_none());
        assert_eq!(v["providers"]["mine"]["baseUrl"], "http://x/v1");
        assert_eq!(provider_ids(&gone), vec!["mine".to_string()]);
    }

    #[test]
    fn an_unreadable_file_is_left_alone() {
        assert!(merge_provider(Some("{ not json"), "p", json!({})).is_err());
        assert!(merge_provider(Some("[1,2]"), "p", json!({})).is_err());
        assert!(merge_provider(Some(r#"{"providers": 3}"#), "p", json!({})).is_err());
        assert!(strip_comments(r#"{"a": "http://x//y" /* c */}"#).contains("http://x//y"));
    }

    #[test]
    fn keychain_refs_round_trip() {
        let r = secret_ref(SERVICE, "acc-1/direct-x");
        assert_eq!(r, "!/usr/bin/security find-generic-password -s 'dev.3xhaust.ondra.provider' -a 'acc-1/direct-x' -w");
        assert_eq!(ref_account(SERVICE, &r).as_deref(), Some("acc-1/direct-x"));
        assert_eq!(ref_account("other", &r), None);
        assert_eq!(ref_account(SERVICE, "sk-literal"), None);
        let entry = json!({ "apiKey": r, "headers": { "X-A": secret_ref(SERVICE, "acc-1/direct-x/h/X-A"), "X-B": "plain" } });
        assert_eq!(refs_in(SERVICE, &entry), vec!["acc-1/direct-x", "acc-1/direct-x/h/X-A"]);
        assert!(!safe_name("a b"));
        assert!(!safe_name("a'b"));
    }

    #[test]
    fn reads_model_lists_from_each_kind_of_server() {
        // OpenRouter: context, tools, reasoning, images
        let or = json!({ "data": [
            { "id": "anthropic/claude-x", "name": "Claude X", "context_length": 200000, "top_provider": { "max_completion_tokens": 64000 },
              "supported_parameters": ["tools", "reasoning", "max_tokens"], "architecture": { "input_modalities": ["text", "image"] } },
            { "id": "some/plain", "context_length": 8192, "supported_parameters": ["max_tokens"] },
            { "id": "openai/text-embedding-3-small" }
        ]});
        let f = parse_models_reply(&or);
        assert_eq!(f.len(), 2);
        assert_eq!(f[0], Found { id: "anthropic/claude-x".into(), name: Some("Claude X".into()), context_window: Some(200000), max_tokens: Some(64000), tools: Some(true), reasoning: Some(true), image: Some(true) });
        assert_eq!(f[1].tools, Some(false));
        // OpenAI-style (Ollama /v1/models, vLLM, LM Studio): ids only
        let oa = json!({ "object": "list", "data": [{ "id": "llama3.1:8b", "object": "model", "owned_by": "library" }, { "id": "qwen3:4b", "max_model_len": 32768 }] });
        let f = parse_models_reply(&oa);
        assert_eq!(f.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["llama3.1:8b", "qwen3:4b"]);
        assert_eq!(f[0].tools, None);
        assert_eq!(f[1].context_window, Some(32768));
        // Ollama /api/tags
        let tags = json!({ "models": [{ "name": "gemma3:4b", "model": "gemma3:4b", "details": {} }, { "name": "nomic-embed-text:latest", "model": "nomic-embed-text:latest" }] });
        assert_eq!(parse_models_reply(&tags).iter().map(|m| m.id.clone()).collect::<Vec<_>>(), ["gemma3:4b"]);
        // Together: a bare array
        let tg = json!([{ "id": "meta/llama", "type": "chat", "context_length": 131072 }, { "id": "x/embed", "type": "embedding" }]);
        assert_eq!(parse_models_reply(&tg).len(), 1);
        // Anthropic
        let an = json!({ "data": [{ "id": "claude-sonnet-4-5", "display_name": "Claude Sonnet 4.5", "type": "model" }] });
        assert_eq!(parse_models_reply(&an)[0].name.as_deref(), Some("Claude Sonnet 4.5"));
        // Gemini
        let gm = json!({ "models": [
            { "name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro", "inputTokenLimit": 1048576, "outputTokenLimit": 65536, "supportedGenerationMethods": ["generateContent"], "thinking": true },
            { "name": "models/text-embedding-004", "supportedGenerationMethods": ["embedContent"] }
        ]});
        let f = parse_models_reply(&gm);
        assert_eq!(f.len(), 1);
        assert_eq!((f[0].id.as_str(), f[0].context_window, f[0].max_tokens, f[0].reasoning), ("gemini-2.5-pro", Some(1048576), Some(65536), Some(true)));
        // LM Studio's own capabilities
        let lm = json!({ "data": [{ "id": "qwen2.5-7b", "type": "llm", "capabilities": ["tool_use"], "max_context_length": 32768 }] });
        assert_eq!(parse_models_reply(&lm)[0].tools, Some(true));
        assert!(parse_models_reply(&json!({ "error": "x" })).is_empty());
    }

    #[test]
    fn tells_a_tool_call_from_words() {
        let call = json!({ "choices": [{ "finish_reason": "tool_calls", "message": { "tool_calls": [{ "id": "1", "type": "function", "function": { "name": "ping", "arguments": "{}" } }] } }] });
        let words = json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "OK" } }] });
        let cut = json!({ "choices": [{ "finish_reason": "length", "message": { "content": "" } }] });
        assert_eq!(called_tool("openai-completions", &call), Some(true));
        assert_eq!(called_tool("openai-completions", &words), Some(false));
        assert_eq!(called_tool("openai-completions", &cut), None);
        assert_eq!(called_tool("anthropic-messages", &json!({ "content": [{ "type": "tool_use" }] })), Some(true));
        assert_eq!(called_tool("openai-responses", &json!({ "output": [{ "type": "function_call" }] })), Some(true));
        assert_eq!(called_tool("google-generative-ai", &json!({ "candidates": [{ "content": { "parts": [{ "functionCall": {} }] } }] })), Some(true));
    }

    // ── a tiny HTTP server for the requests

    type Handler = fn(&str, &str, &str) -> (u16, String);

    /// Serves `n` requests with `h(method, path, body)` on a free port; returns the base and what it saw.
    fn serve(n: usize, h: Handler) -> (String, std::sync::mpsc::Receiver<(String, String, String, String)>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            for s in l.incoming().take(n) {
                let mut s = s.unwrap();
                let mut r = BufReader::new(s.try_clone().unwrap());
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                let mut parts = line.split_whitespace();
                let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
                let (mut len, mut auth) = (0usize, String::new());
                loop {
                    let mut h = String::new();
                    r.read_line(&mut h).unwrap();
                    let h = h.trim_end();
                    if h.is_empty() {
                        break;
                    }
                    let low = h.to_lowercase();
                    if let Some(v) = low.strip_prefix("content-length:") {
                        len = v.trim().parse().unwrap_or(0);
                    }
                    if low.starts_with("authorization:") || low.starts_with("x-api-key:") || low.starts_with("x-team:") {
                        auth.push_str(h);
                        auth.push('\n');
                    }
                }
                let mut body = vec![0; len];
                r.read_exact(&mut body).unwrap();
                let body = String::from_utf8_lossy(&body).to_string();
                let (status, reply) = h(&method, &path, &body);
                let _ = tx.send((method, path, body, auth));
                let _ = write!(s, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
            }
        });
        (format!("http://127.0.0.1:{port}/v1"), rx)
    }

    fn target(base: &str, api: &str, key: Option<&str>) -> Resolved {
        Resolved { base: base.into(), api: api.into(), key: key.map(str::to_string), headers: vec![("X-Team".into(), "blue".into())] }
    }

    #[test]
    fn lists_models_and_falls_back_to_ollama_tags() {
        // /v1/models is missing: /api/tags answers
        let (base, seen) = serve(2, |_, path, _| match path {
            "/api/tags" => (200, r#"{"models":[{"name":"llama3.2:3b","model":"llama3.2:3b"}]}"#.into()),
            _ => (404, r#"{"error":"404 page not found"}"#.into()),
        });
        let found = tauri::async_runtime::block_on(list_models(&target(&base, "openai-completions", None))).unwrap();
        assert_eq!(found[0].id, "llama3.2:3b");
        assert_eq!(seen.recv().unwrap().1, "/v1/models");
        assert_eq!(seen.recv().unwrap().1, "/api/tags");

        // a key and headers go along; a wrong key is said so
        let (base, seen) = serve(1, |_, _, _| (401, r#"{"error":{"message":"Incorrect API key provided: sk-secret-1234"}}"#.into()));
        let err = tauri::async_runtime::block_on(list_models(&target(&base, "openai-completions", Some("sk-secret-1234")))).unwrap_err();
        assert_eq!(err.kind, "auth");
        assert!(!err.detail.contains("sk-secret-1234"), "the key is scrubbed: {}", err.detail);
        let (_, _, _, auth) = seen.recv().unwrap();
        assert!(auth.contains("Bearer sk-secret-1234") && auth.to_lowercase().contains("x-team: blue"));
    }

    #[test]
    fn nothing_listening_is_unreachable() {
        let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let err = tauri::async_runtime::block_on(list_models(&target(&format!("http://127.0.0.1:{port}/v1"), "openai-completions", None))).unwrap_err();
        assert_eq!(err.kind, "unreachable");
    }

    #[test]
    fn checks_the_model_and_whether_it_calls_a_tool() {
        // a reasoning model: reasoning in reasoning_content, content starting with "\n\n", a tool call when asked
        let (base, seen) = serve(2, |_, _, body| {
            let v: Value = serde_json::from_str(body).unwrap();
            if v.get("tools").is_some() {
                (200, r#"{"choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","reasoning_content":"call it","content":"","tool_calls":[{"id":"c1","type":"function","function":{"name":"ping","arguments":"{}"}}]}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}"#.into())
            } else {
                (200, r#"{"choices":[{"index":0,"finish_reason":"stop","message":{"role":"assistant","reasoning_content":"easy","content":"\n\nOK"}}]}"#.into())
            }
        });
        let ok = tauri::async_runtime::block_on(check(&target(&base, "openai-completions", Some("k")), "think-1", true)).unwrap();
        assert_eq!(ok.tools, Some(true));
        let (m, path, body, _) = seen.recv().unwrap();
        assert_eq!((m.as_str(), path.as_str()), ("POST", "/v1/chat/completions"));
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!((v["model"].as_str(), v["reasoning_effort"].as_str()), (Some("think-1"), Some("low")));

        // Ollama with a model that has no tools: the tool request is refused
        let (base, _) = serve(2, |_, _, body| {
            if body.contains("\"tools\"") {
                (400, r#"{"error":{"message":"registry.ollama.ai/library/gemma:2b does not support tools","type":"api_error"}}"#.into())
            } else {
                (200, r#"{"choices":[{"finish_reason":"stop","message":{"content":"OK"}}]}"#.into())
            }
        });
        let ok = tauri::async_runtime::block_on(check(&target(&base, "openai-completions", None), "gemma:2b", false)).unwrap();
        assert_eq!(ok.tools, Some(false));

        // a model the server doesn't have
        let (base, _) = serve(1, |_, _, _| (404, r#"{"error":{"message":"model \"nope\" not found, try pulling it first"}}"#.into()));
        let err = tauri::async_runtime::block_on(check(&target(&base, "openai-completions", None), "nope", false)).unwrap_err();
        assert_eq!(err.kind, "model");

        // a server that won't take reasoning_effort: asked again without it
        let (base, seen) = serve(3, |_, _, body| {
            if body.contains("reasoning_effort") {
                (400, r#"{"error":{"message":"Unrecognized request argument supplied: reasoning_effort"}}"#.into())
            } else {
                (200, r#"{"choices":[{"finish_reason":"stop","message":{"content":"OK"}}]}"#.into())
            }
        });
        let ok = tauri::async_runtime::block_on(check(&target(&base, "openai-completions", None), "m", true)).unwrap();
        assert_eq!(ok.tools, Some(false));
        assert!(seen.recv().unwrap().2.contains("reasoning_effort"));
        assert!(!seen.recv().unwrap().2.contains("reasoning_effort"));
    }

    #[test]
    fn anthropic_requests_go_to_v1_messages() {
        let (base, seen) = serve(2, |_, _, body| {
            if body.contains("\"tools\"") {
                (200, r#"{"content":[{"type":"tool_use","id":"t","name":"ping","input":{}}],"stop_reason":"tool_use"}"#.into())
            } else {
                (200, r#"{"content":[{"type":"text","text":"OK"}],"stop_reason":"end_turn"}"#.into())
            }
        });
        // the base may or may not end in /v1
        let ok = tauri::async_runtime::block_on(check(&target(&base, "anthropic-messages", Some("ak")), "claude-x", false)).unwrap();
        assert_eq!(ok.tools, Some(true));
        let (_, path, _, auth) = seen.recv().unwrap();
        assert_eq!(path, "/v1/messages");
        assert!(auth.to_lowercase().contains("x-api-key: ak"));
    }

    /// A running Ollama, if there is one (read-only: lists models). `cargo test -- --ignored local_ollama`
    #[test]
    #[ignore]
    fn local_ollama_lists_models() {
        let found = tauri::async_runtime::block_on(list_models(&Resolved { base: "http://localhost:11434/v1".into(), api: "openai-completions".into(), key: None, headers: vec![] })).unwrap();
        assert!(!found.is_empty());
        eprintln!("ollama: {:?}", found.iter().map(|f| f.id.as_str()).collect::<Vec<_>>());
    }

    /// Writes into the real login keychain under a test service name, then deletes it.
    #[test]
    fn keychain_wrapper_stores_reads_and_deletes() {
        let svc = "dev.3xhaust.ondra.provider.test";
        let acct = format!("test-{}/direct-x", std::process::id());
        let secret = "sk-test-\"quoted\" value with spaces";
        secret_set(svc, &acct, secret).unwrap();
        assert!(secret_exists(svc, &acct));
        assert_eq!(secret_get(svc, &acct).as_deref(), Some(secret));
        // the engine's command form reads the same value
        let cmd = secret_ref(svc, &acct);
        let out = Command::new("/bin/sh").arg("-c").arg(&cmd[1..]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim_end_matches('\n'), secret);
        secret_set(svc, &acct, "second").unwrap();
        assert_eq!(secret_get(svc, &acct).as_deref(), Some("second"));

        // save → models.json names it; remove → item and entry gone
        let dir = std::env::temp_dir().join(format!("ondra-prov-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("models.json"), r#"{"providers":{"other":{"baseUrl":"http://o/v1","api":"openai-completions"}}}"#).unwrap();
        let id = format!("test-{}", std::process::id());
        save_in(svc, &dir, &id, "direct-x", json!({ "baseUrl": "http://h/v1", "api": "openai-completions", "models": [{ "id": "m" }] }), Some("k-1".into()), vec![HeaderIn { name: "X-Team".into(), value: Some("blue".into()) }]).unwrap();
        let text = std::fs::read_to_string(dir.join("models.json")).unwrap();
        assert!(!text.contains("k-1") && !text.contains("blue"), "no secret in the file");
        let entry = provider_entry(Some(&text), "direct-x").unwrap();
        assert_eq!(entry["apiKey"], secret_ref(svc, &key_account(&id, "direct-x")));
        assert!(provider_entry(Some(&text), "other").is_some());
        assert_eq!(secret_get(svc, &key_account(&id, "direct-x")).as_deref(), Some("k-1"));
        // editing without a new key keeps it; dropping the header deletes its item
        save_in(svc, &dir, &id, "direct-x", json!({ "baseUrl": "http://h2/v1", "api": "openai-completions" }), None, vec![]).unwrap();
        let text = std::fs::read_to_string(dir.join("models.json")).unwrap();
        assert_eq!(provider_entry(Some(&text), "direct-x").unwrap()["apiKey"], secret_ref(svc, &key_account(&id, "direct-x")));
        assert!(!secret_exists(svc, &header_account(&id, "direct-x", "X-Team")));
        remove_in(svc, &dir, &id, "direct-x").unwrap();
        assert!(!secret_exists(svc, &key_account(&id, "direct-x")));
        let text = std::fs::read_to_string(dir.join("models.json")).unwrap();
        assert!(provider_entry(Some(&text), "direct-x").is_none() && provider_entry(Some(&text), "other").is_some());
        // no key: a placeholder, nothing in the keychain
        save_in(svc, &dir, &id, "direct-y", json!({ "baseUrl": "http://h/v1", "api": "openai-completions" }), Some(String::new()), vec![]).unwrap();
        let text = std::fs::read_to_string(dir.join("models.json")).unwrap();
        assert_eq!(provider_entry(Some(&text), "direct-y").unwrap()["apiKey"], NO_KEY);

        secret_delete(svc, &acct);
        assert!(!secret_exists(svc, &acct));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
