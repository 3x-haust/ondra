//! The agent on Discord: a bot connection held here, in the native process.
//!
//! The bot token lives in the secrets vault (keychain, account `@discord/bot`): not a secret's
//! name a job can be given (those are `NAME` or `<project>/NAME`), so no job's engine ever gets
//! it, and the page never reads it back (only whether one is set).
//!
//! `discord_start` holds the gateway (websocket) open: hello → identify (or resume) → heartbeat,
//! reconnecting with a back-off when it drops. Each message the bot can see comes to the page as
//! a `discord` event; the page decides whether it is for the agent and answers through
//! `discord_send`. The page can't do this itself: its CSP allows no connection to Discord.

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio_tungstenite::tungstenite::Message;

const API: &str = "https://discord.com/api/v10";
const GATEWAY: &str = "wss://gateway.discord.gg/?v=10&encoding=json";
/// where the token is kept in the secrets vault
pub const TOKEN_ITEM: &str = "@discord/bot";
/// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
// guilds, guild messages, guild typing, DMs, DM typing, message content
const INTENTS: u64 = (1 << 0) | (1 << 9) | (1 << 11) | (1 << 12) | (1 << 14) | (1 << 15);
/// a Discord message holds at most this many characters
const MAX_LEN: usize = 2000;

/// the running connection (a new start ends the old one)
static RUN: Mutex<Option<tauri::async_runtime::JoinHandle<()>>> = Mutex::new(None);

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Author {
    pub id: String,
    pub name: String,
    pub bot: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Incoming {
    pub id: String,
    pub channel: String,
    /// none in a DM
    pub guild: Option<String>,
    pub author: Author,
    pub content: String,
    /// user ids mentioned
    pub mentions: Vec<String>,
    /// the author of the message this one replies to
    pub reply_to: Option<String>,
    /// the message this one replies to
    pub reply_msg: Option<String>,
    /// attachment links (images, files)
    pub files: Vec<String>,
    pub at: String,
}

/// A MESSAGE_CREATE's `d` as the page gets it; None for what isn't a message.
pub fn incoming(d: &Value) -> Option<Incoming> {
    let s = |v: &Value| v.as_str().map(str::to_string);
    let author = d.get("author")?;
    let name = s(&author["global_name"]).or_else(|| s(&author["username"])).unwrap_or_default();
    Some(Incoming {
        id: s(&d["id"])?,
        channel: s(&d["channel_id"])?,
        guild: s(&d["guild_id"]),
        author: Author { id: s(&author["id"])?, name, bot: author["bot"].as_bool().unwrap_or(false) },
        content: s(&d["content"]).unwrap_or_default(),
        mentions: d["mentions"].as_array().map(|a| a.iter().filter_map(|m| s(&m["id"])).collect()).unwrap_or_default(),
        reply_to: d["referenced_message"]["author"]["id"].as_str().map(str::to_string),
        reply_msg: d["message_reference"]["message_id"].as_str().or(d["referenced_message"]["id"].as_str()).map(str::to_string),
        // its own pictures and files, and those of a message it forwards
        files: std::iter::once(&d["attachments"])
            .chain(d["message_snapshots"].as_array().into_iter().flatten().map(|x| &x["message"]["attachments"]))
            .filter_map(|a| a.as_array())
            .flatten()
            .filter_map(|f| s(&f["url"]))
            .collect(),
        at: s(&d["timestamp"]).unwrap_or_default(),
    })
}

/// Split a long answer into Discord-sized pieces, at a line break when there is one.
pub fn pieces(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = text.trim();
    while rest.chars().count() > MAX_LEN {
        let cut = rest.char_indices().nth(MAX_LEN).map(|(i, _)| i).unwrap_or(rest.len());
        let head = &rest[..cut];
        let at = head.rfind('\n').filter(|&i| i > cut / 2).unwrap_or(cut);
        out.push(rest[..at].trim_end().to_string());
        rest = rest[at..].trim_start();
    }
    if !rest.is_empty() {
        out.push(rest.to_string());
    }
    out
}

/// What the page is told: a message, the bot's own identity once connected, or why it stopped.
fn emit(app: &AppHandle, ev: Value) {
    let _ = app.emit("discord", ev);
}

fn token() -> Result<String, String> {
    crate::secrets::vault_get(TOKEN_ITEM).filter(|t| !t.trim().is_empty()).ok_or_else(|| "디스코드 봇 토큰이 없어요".to_string())
}

fn client() -> Result<reqwest::Client, String> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent(concat!("DiscordBot (https://github.com/3x-haust/ondra, ", env!("CARGO_PKG_VERSION"), ")"))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

async fn rest(method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value, String> {
    let token = token()?;
    let http = client()?;
    for _ in 0..3 {
        let mut req = http.request(method.clone(), format!("{API}{path}")).header("Authorization", format!("Bot {token}"));
        if let Some(b) = &body {
            req = req.json(b);
        }
        let res = req.send().await.map_err(|e| format!("디스코드에 닿지 못했어요: {e}"))?;
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        // rate limited: wait as told, once or twice
        if status.as_u16() == 429 {
            let wait = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["retry_after"].as_f64()).unwrap_or(1.0);
            tokio::time::sleep(Duration::from_secs_f64(wait.min(10.0))).await;
            continue;
        }
        if !status.is_success() {
            let why = serde_json::from_str::<Value>(&text).ok().and_then(|v| v["message"].as_str().map(str::to_string)).unwrap_or(text);
            return Err(format!("디스코드가 거절했어요 ({status}): {why}"));
        }
        return Ok(serde_json::from_str(&text).unwrap_or(Value::Null));
    }
    Err("디스코드가 잠시 막았어요. 조금 뒤에 다시 해 주세요".into())
}

#[tauri::command]
pub async fn discord_token_set(token: String) -> Result<(), String> {
    crate::secrets::off_main(move || {
        let t = token.trim();
        if t.is_empty() {
            return crate::secrets::vault_delete(TOKEN_ITEM);
        }
        crate::secrets::vault_set(TOKEN_ITEM, t)
    })
    .await?
}

/// Use a saved secret (Settings › 시크릿, by name) as the bot token: the value moves here, natively,
/// so an agent that set it up for the user never sees it.
#[tauri::command]
pub async fn discord_token_from_secret(name: String) -> Result<(), String> {
    crate::secrets::off_main(move || {
        let v = crate::secrets::saved_value(name.trim()).filter(|v| !v.trim().is_empty()).ok_or_else(|| format!("시크릿 {}이(가) 없어요", name.trim()))?;
        crate::secrets::vault_set(TOKEN_ITEM, v.trim())
    })
    .await?
}

#[tauri::command]
pub async fn discord_token_has() -> bool {
    crate::secrets::off_main(|| token().is_ok()).await.unwrap_or(false)
}

/// Send `text` to a channel, as a reply to `reply_to` when given; the ids of what was sent.
#[tauri::command]
pub async fn discord_send(channel: String, text: String, reply_to: Option<String>) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    for (i, piece) in pieces(&text).into_iter().enumerate() {
        let mut body = json!({ "content": piece, "allowed_mentions": { "parse": [], "replied_user": false } });
        if let (0, Some(r)) = (i, &reply_to) {
            body["message_reference"] = json!({ "message_id": r, "fail_if_not_exists": false });
        }
        let sent = rest(reqwest::Method::POST, &format!("/channels/{channel}/messages"), Some(body)).await?;
        if let Some(id) = sent["id"].as_str() {
            ids.push(id.to_string());
        }
    }
    Ok(ids)
}

/// Who owns the bot's application (a team's owner for a team app): the user, when they made the bot.
#[tauri::command]
pub async fn discord_owner() -> Result<Option<String>, String> {
    let app = rest(reqwest::Method::GET, "/oauth2/applications/@me", None).await?;
    Ok(owner_of(&app))
}

pub fn owner_of(app: &Value) -> Option<String> {
    app["team"]["owner_user_id"].as_str().or(app["owner"]["id"].as_str()).map(str::to_string)
}

/// A reaction on a message (👀: "got it", without a line that only says so).
#[tauri::command]
pub async fn discord_react(channel: String, message: String, emoji: String) -> Result<(), String> {
    let e: String = emoji.bytes().map(|b| format!("%{b:02X}")).collect();
    rest(reqwest::Method::PUT, &format!("/channels/{channel}/messages/{message}/reactions/{e}/@me"), None).await.map(|_| ())
}

/// Its own reaction taken off (👀 once the message is answered).
#[tauri::command]
pub async fn discord_unreact(channel: String, message: String, emoji: String) -> Result<(), String> {
    let e: String = emoji.bytes().map(|b| format!("%{b:02X}")).collect();
    rest(reqwest::Method::DELETE, &format!("/channels/{channel}/messages/{message}/reactions/{e}/@me"), None).await.map(|_| ())
}

/// A file on Discord's own hosts (an attachment's link), and the name it is saved under; any
/// other link is never fetched.
fn discord_file(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let (host, path) = rest.split_once('/')?;
    if host != "cdn.discordapp.com" && host != "media.discordapp.net" {
        return None;
    }
    let last = path.split('?').next()?.rsplit('/').next().unwrap_or("");
    let name: String = last.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).take(80).collect();
    Some(if name.trim_matches('.').is_empty() { "file".into() } else { name })
}

/// A picture or file sent to it, saved where the page's pasted pictures go, so the model
/// reads it as a file instead of getting a link it can't open.
#[tauri::command]
pub async fn discord_save_file(app: AppHandle, url: String) -> Result<String, String> {
    let name = discord_file(&url).ok_or("디스코드 파일 링크가 아니에요")?;
    let res = client()?.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("{}", res.status()));
    }
    if res.content_length().unwrap_or(0) > 30 * 1024 * 1024 {
        return Err("파일이 너무 커요".into());
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > 30 * 1024 * 1024 {
        return Err("파일이 너무 커요".into());
    }
    let dir = crate::engine::data_dir(&app).join("attachments").join("discord");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let path = dir.join(format!("{stamp}-{name}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Take back what the bot said (the user asked it to: "그거 지워").
#[tauri::command]
pub async fn discord_delete(channel: String, message: String) -> Result<(), String> {
    rest(reqwest::Method::DELETE, &format!("/channels/{channel}/messages/{message}"), None).await.map(|_| ())
}

// ── the server itself, for the agent's own hands (engine/discordHands.ts): which servers it is
// in, their channels, and making or removing a channel. Needs the bot's Manage Channels permission.

/// A channel as the agent sees it: id, name, kind, the category it is under, its topic.
pub fn channel_brief(v: &Value) -> Value {
    let kind = match v["type"].as_u64() {
        Some(0) => "text",
        Some(2) => "voice",
        Some(4) => "category",
        Some(5) => "announcement",
        Some(13) => "stage",
        Some(15) => "forum",
        _ => "other",
    };
    json!({ "id": v["id"], "name": v["name"], "kind": kind, "category": v["parent_id"], "topic": v["topic"], "position": v["position"] })
}

#[tauri::command]
pub async fn discord_guilds() -> Result<Vec<Value>, String> {
    let got = rest(reqwest::Method::GET, "/users/@me/guilds", None).await?;
    Ok(got.as_array().map(|a| a.iter().map(|g| json!({ "id": g["id"], "name": g["name"] })).collect()).unwrap_or_default())
}

#[tauri::command]
pub async fn discord_channels(guild: String) -> Result<Vec<Value>, String> {
    let got = rest(reqwest::Method::GET, &format!("/guilds/{guild}/channels"), None).await?;
    let mut list: Vec<Value> = got.as_array().map(|a| a.iter().map(channel_brief).collect()).unwrap_or_default();
    list.sort_by_key(|c| c["position"].as_i64().unwrap_or(0));
    Ok(list)
}

/// See, send, read history, react: what a member of a private channel gets.
const MEMBER: u64 = (1 << 10) | (1 << 11) | (1 << 16) | (1 << 6);

/// The body that makes a channel. `only`: user ids that alone may see it (the bot is added), so
/// work posted there stays between the user and the agent.
pub fn channel_body(guild: &str, name: &str, kind: &str, category: Option<&str>, topic: Option<&str>, only: &[String], bot: &str) -> Value {
    let mut body = json!({ "name": name, "type": if kind == "category" { 4 } else { 0 } });
    if let Some(c) = category.filter(|c| !c.is_empty()) {
        body["parent_id"] = json!(c);
    }
    if let Some(t) = topic.filter(|t| !t.is_empty()) {
        body["topic"] = json!(t);
    }
    if !only.is_empty() {
        let mut over = vec![json!({ "id": guild, "type": 0, "deny": (1u64 << 10).to_string(), "allow": "0" })];
        for id in only.iter().map(String::as_str).chain([bot]) {
            over.push(json!({ "id": id, "type": 1, "allow": MEMBER.to_string(), "deny": "0" }));
        }
        body["permission_overwrites"] = json!(over);
    }
    body
}

#[tauri::command]
pub async fn discord_channel_create(guild: String, name: String, kind: Option<String>, category: Option<String>, topic: Option<String>, only: Option<Vec<String>>) -> Result<Value, String> {
    let only = only.unwrap_or_default();
    let bot = if only.is_empty() { String::new() } else { rest(reqwest::Method::GET, "/users/@me", None).await?["id"].as_str().unwrap_or_default().to_string() };
    let body = channel_body(&guild, &name, kind.as_deref().unwrap_or("text"), category.as_deref(), topic.as_deref(), &only, &bot);
    let made = rest(reqwest::Method::POST, &format!("/guilds/{guild}/channels"), Some(body)).await?;
    Ok(channel_brief(&made))
}

#[tauri::command]
pub async fn discord_channel_delete(channel: String) -> Result<(), String> {
    rest(reqwest::Method::DELETE, &format!("/channels/{channel}"), None).await.map(|_| ())
}

/// A picture from this Mac posted in a channel (a screenshot the work took), with an optional line.
/// Pictures only, up to 8 MB (what any server takes).
#[tauri::command]
pub async fn discord_send_file(channel: String, path: String, text: Option<String>) -> Result<Vec<String>, String> {
    let p = std::path::Path::new(&path);
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("image.png").to_string();
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => return Err("그림 파일만 올릴 수 있어요".into()),
    };
    let bytes = tokio::fs::read(p).await.map_err(|e| format!("파일을 못 읽었어요: {e}"))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("8MB가 넘어서 못 올려요".into());
    }
    let payload = json!({ "content": text.unwrap_or_default().chars().take(1900).collect::<String>(), "allowed_mentions": { "parse": [] } });
    let v = multipart(reqwest::Method::POST, &format!("/channels/{channel}/messages"), &payload, &[(name, mime.to_string(), bytes)]).await?;
    Ok(v["id"].as_str().map(|s| vec![s.to_string()]).unwrap_or_default())
}

/// A body with files (multipart: the body as payload_json, each file as files[n]), rate limits waited out.
async fn multipart(method: reqwest::Method, path: &str, payload: &Value, files: &[(String, String, Vec<u8>)]) -> Result<Value, String> {
    let token = token()?;
    let http = client()?;
    for _ in 0..3 {
        let mut form = reqwest::multipart::Form::new().text("payload_json", payload.to_string());
        for (i, (name, mime, bytes)) in files.iter().enumerate() {
            let part = reqwest::multipart::Part::bytes(bytes.clone()).file_name(name.clone()).mime_str(mime).map_err(|e| e.to_string())?;
            form = form.part(format!("files[{i}]"), part);
        }
        let res = http
            .request(method.clone(), format!("{API}{path}"))
            .header("Authorization", format!("Bot {token}"))
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("디스코드에 닿지 못했어요: {e}"))?;
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if status.as_u16() == 429 {
            let wait = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["retry_after"].as_f64()).unwrap_or(1.0);
            tokio::time::sleep(Duration::from_secs_f64(wait.min(10.0))).await;
            continue;
        }
        if !status.is_success() {
            let why = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["message"].as_str().map(str::to_string)).unwrap_or(body);
            return Err(format!("디스코드가 거절했어요 ({status}): {why}"));
        }
        return Ok(serde_json::from_str(&body).unwrap_or(Value::Null));
    }
    Err("디스코드가 잠시 막았어요. 조금 뒤에 다시 해 주세요".into())
}

/// Any call on Discord's bot API, for the agent's own `discord` tool: whatever a bot's code can do
/// (messages with buttons, menus, embeds and polls; reactions, pins, threads, roles, members,
/// channels, slash commands, events…) without a command per action. A path under the API only
/// (no host, no `..`); the token is added here and never comes back. `files`: local files sent
/// with the body (it becomes payload_json), never secret ones.
#[tauri::command]
pub async fn discord_api(method: String, path: String, body: Option<Value>, files: Option<Vec<String>>) -> Result<Value, String> {
    let m = api_method(&method)?;
    api_path(&path)?;
    let files = files.unwrap_or_default();
    if files.is_empty() {
        return rest(m, &path, body).await;
    }
    if files.len() > 10 {
        return Err("파일은 한 번에 10개까지예요".into());
    }
    let mut loaded = Vec::new();
    for f in &files {
        loaded.push(load_file(f).await?);
    }
    multipart(m, &path, &body.unwrap_or_else(|| json!({})), &loaded).await
}

pub fn api_method(m: &str) -> Result<reqwest::Method, String> {
    match m.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PUT" => Ok(reqwest::Method::PUT),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "DELETE" => Ok(reqwest::Method::DELETE),
        _ => Err("method는 GET, POST, PUT, PATCH, DELETE 중 하나예요".into()),
    }
}

/// a path under the API: "/channels/123/messages?limit=5", never another host
pub fn api_path(p: &str) -> Result<(), String> {
    let bad = !p.starts_with('/') || p.starts_with("//") || p.contains("..") || p.contains("://") || p.chars().any(|c| c.is_whitespace() || c == '\\' || c == '#');
    if bad {
        return Err("path는 /channels/… 처럼 API 아래 경로여야 해요".into());
    }
    Ok(())
}

/// files that hold keys or sign-ins never leave this Mac
pub fn secret_file(path: &str) -> bool {
    let l = path.to_ascii_lowercase();
    let name = l.rsplit('/').next().unwrap_or("");
    ["/.ssh/", "/.codex/", "/.aws/", "/.gnupg/", "/.config/gh/", "/.kube/", "/.docker/", "/library/keychains/", "/dev.3xhaust.ondra/secrets", "/dev.3xhaust.ondra/keys"].iter().any(|d| l.contains(d))
        || name.starts_with(".env")
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.contains("credential")
        || name.contains("secret")
        || [".pem", ".key", ".p12", ".keychain", ".keychain-db"].iter().any(|e| name.ends_with(e))
        || ["auth.json", "keys.json", "devbridge.token", ".netrc", ".npmrc", ".pypirc", "hosts.yml"].contains(&name)
}

async fn load_file(path: &str) -> Result<(String, String, Vec<u8>), String> {
    let full = match path.strip_prefix("~/") {
        Some(rest) => format!("{}/{rest}", std::env::var("HOME").unwrap_or_default()),
        None => path.to_string(),
    };
    // where it really is (a link can't carry a secret out)
    let real = tokio::fs::canonicalize(&full).await.map_err(|e| format!("파일을 못 찾았어요: {e}"))?;
    let real_s = real.to_string_lossy().to_string();
    if secret_file(&full) || secret_file(&real_s) {
        return Err("키나 로그인 정보가 든 파일은 올리지 않아요".into());
    }
    let bytes = tokio::fs::read(&real).await.map_err(|e| format!("파일을 못 읽었어요: {e}"))?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("25MB가 넘어서 못 올려요".into());
    }
    let name = real.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
    let mime = match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" => "text/plain",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .to_string();
    Ok((name, mime, bytes))
}

/// Interactions it acknowledged (a click on its button or menu, a slash command), kept 15 minutes
/// (Discord's limit) so its answer can go to one: id → (application, token). Never to the page.
static INTERACTIONS: Mutex<Vec<(String, String, String, std::time::Instant)>> = Mutex::new(Vec::new());

/// A click, a menu choice or a slash command, as the page is told (no token).
pub fn interaction_event(d: &Value) -> Option<Value> {
    let kind = match d["type"].as_u64()? {
        2 => "command",
        3 => "component",
        _ => return None,
    };
    let s = |v: &Value| v.as_str().filter(|x| !x.is_empty()).map(str::to_string);
    let user = d["member"].get("user").or_else(|| d.get("user"))?;
    let author = Author {
        id: s(&user["id"])?,
        name: s(&user["global_name"]).or_else(|| s(&user["username"])).unwrap_or_default(),
        bot: user["bot"].as_bool().unwrap_or(false),
    };
    let mut ev = json!({
        "id": s(&d["id"])?,
        "kind": kind,
        "channel": s(&d["channel_id"])?,
        "guild": d["guild_id"],
        "user": author,
    });
    if kind == "component" {
        ev["message"] = d["message"]["id"].clone();
        ev["custom_id"] = d["data"]["custom_id"].clone();
        if d["data"]["values"].is_array() {
            ev["values"] = d["data"]["values"].clone();
        }
    } else {
        ev["command"] = d["data"]["name"].clone();
        if d["data"]["options"].is_array() {
            ev["options"] = d["data"]["options"].clone();
        }
    }
    Some(json!({ "kind": "interaction", "interaction": ev }))
}

/// Discord waits 3 seconds for an answer: say "got it" at once (a click: nothing changes on the
/// message; a command: "… is thinking" until its answer replaces it).
async fn acknowledge(d: Value) {
    let (Some(id), Some(tok), Some(app), Some(kind)) = (d["id"].as_str(), d["token"].as_str(), d["application_id"].as_str(), d["type"].as_u64()) else { return };
    {
        let mut held = INTERACTIONS.lock().unwrap();
        held.retain(|x| x.3.elapsed() < Duration::from_secs(15 * 60));
        held.push((id.to_string(), app.to_string(), tok.to_string(), std::time::Instant::now()));
    }
    let Ok(http) = client() else { return };
    let kind = if kind == 2 { 5 } else { 6 };
    let _ = http.post(format!("{API}/interactions/{id}/{tok}/callback")).json(&json!({ "type": kind })).send().await;
}

/// Its answer to an interaction (the message a slash command shows; a follow-up to a click)
#[tauri::command]
pub async fn discord_interaction_reply(id: String, body: Value, follow_up: Option<bool>) -> Result<Value, String> {
    let held = INTERACTIONS.lock().unwrap().iter().find(|x| x.0 == id && x.3.elapsed() < Duration::from_secs(15 * 60)).map(|x| (x.1.clone(), x.2.clone()));
    let Some((app, tok)) = held else { return Err("그 상호작용은 끝났어요 (15분 지남)".into()) };
    if follow_up == Some(true) {
        rest(reqwest::Method::POST, &format!("/webhooks/{app}/{tok}"), Some(body)).await
    } else {
        rest(reqwest::Method::PATCH, &format!("/webhooks/{app}/{tok}/messages/@original"), Some(body)).await
    }
}

/// "… is typing" in a channel (lasts about 10 seconds)
#[tauri::command]
pub async fn discord_typing(channel: String) -> Result<(), String> {
    rest(reqwest::Method::POST, &format!("/channels/{channel}/typing"), None).await.map(|_| ())
}

/// The channel's last `limit` messages, oldest first (what was said before a message the agent answers).
#[tauri::command]
pub async fn discord_history(channel: String, before: Option<String>, limit: Option<u32>) -> Result<Vec<Incoming>, String> {
    let n = limit.unwrap_or(20).clamp(1, 50);
    let q = before.map(|b| format!("&before={b}")).unwrap_or_default();
    let got = rest(reqwest::Method::GET, &format!("/channels/{channel}/messages?limit={n}{q}"), None).await?;
    let mut list: Vec<Incoming> = got.as_array().map(|a| a.iter().filter_map(incoming).collect()).unwrap_or_default();
    list.reverse();
    Ok(list)
}

#[tauri::command]
pub fn discord_stop() {
    if let Some(h) = RUN.lock().unwrap().take() {
        h.abort();
    }
}

#[tauri::command]
pub async fn discord_start(app: AppHandle) -> Result<(), String> {
    let token = crate::secrets::off_main(token).await??;
    discord_stop();
    let handle = tauri::async_runtime::spawn(async move { hold(app, token).await });
    *RUN.lock().unwrap() = Some(handle);
    Ok(())
}

/// what a session needs to resume after a drop
#[derive(Default)]
struct Session {
    id: Option<String>,
    url: Option<String>,
    seq: Option<u64>,
}

enum Ended {
    /// connect again (resuming when it can)
    Again,
    /// a fresh session (the old one can't be resumed)
    Fresh,
    /// the token or the bot's settings are wrong: no point trying again
    Fatal(String),
}

async fn hold(app: AppHandle, token: String) {
    let tell = move |ev: Value| emit(&app, ev);
    hold_with(&tell, &token).await
}

async fn hold_with(tell: &(dyn Fn(Value) + Send + Sync), token: &str) {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let mut session = Session::default();
    let mut wait = 1u64;
    loop {
        let started = std::time::Instant::now();
        match once(tell, token, &mut session).await {
            Ended::Fatal(why) => {
                tell(json!({ "kind": "stopped", "why": why }));
                return;
            }
            Ended::Fresh => session = Session::default(),
            Ended::Again => {}
        }
        // up for a while: it was a normal drop, come back quickly
        if started.elapsed() > Duration::from_secs(60) {
            wait = 1;
        }
        tell(json!({ "kind": "reconnecting", "in": wait }));
        tokio::time::sleep(Duration::from_secs(wait)).await;
        wait = (wait * 2).min(60);
    }
}

/// Close codes that mean the bot itself is set up wrong (Discord's gateway close codes).
fn fatal_close(code: u16) -> Option<&'static str> {
    match code {
        4004 => Some("봇 토큰이 맞지 않아요"),
        4010 | 4011 => Some("봇이 너무 많은 서버에 있어요(샤딩 필요)"),
        4012 => Some("게이트웨이 버전이 맞지 않아요"),
        4013 => Some("잘못된 인텐트예요"),
        4014 => Some("개발자 포털에서 봇의 MESSAGE CONTENT INTENT를 켜 주세요"),
        _ => None,
    }
}

async fn once(tell: &(dyn Fn(Value) + Send + Sync), token: &str, session: &mut Session) -> Ended {
    let url = session.url.as_deref().map(|u| format!("{u}/?v=10&encoding=json")).unwrap_or_else(|| GATEWAY.to_string());
    let Ok(Ok((ws, _))) = tokio::time::timeout(Duration::from_secs(20), tokio_tungstenite::connect_async(url.as_str())).await else {
        return Ended::Again;
    };
    let (mut tx, mut rx) = ws.split();
    // hello: how often to beat
    let interval = loop {
        match tokio::time::timeout(Duration::from_secs(20), rx.next()).await {
            Ok(Some(Ok(Message::Text(t)))) => {
                let v: Value = serde_json::from_str(&t).unwrap_or(Value::Null);
                if v["op"] == 10 {
                    break v["d"]["heartbeat_interval"].as_u64().unwrap_or(41_250);
                }
            }
            _ => return Ended::Again,
        }
    };
    let hello = match (&session.id, session.seq) {
        (Some(id), Some(seq)) => json!({ "op": 6, "d": { "token": token, "session_id": id, "seq": seq } }),
        _ => json!({ "op": 2, "d": { "token": token, "intents": INTENTS, "properties": { "os": "macos", "browser": "ondra", "device": "ondra" } } }),
    };
    if tx.send(Message::Text(hello.to_string().into())).await.is_err() {
        return Ended::Again;
    }
    let mut beat = tokio::time::interval(Duration::from_millis(interval));
    beat.tick().await;
    let mut acked = true;
    loop {
        tokio::select! {
            _ = beat.tick() => {
                // no answer to the last beat: the connection is dead
                if !acked {
                    return Ended::Again;
                }
                acked = false;
                if tx.send(Message::Text(json!({ "op": 1, "d": session.seq }).to_string().into())).await.is_err() {
                    return Ended::Again;
                }
            }
            msg = rx.next() => {
                let text = match msg {
                    Some(Ok(Message::Text(t))) => t.to_string(),
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.map(|f| u16::from(f.code)).unwrap_or(1000);
                        if let Some(why) = fatal_close(code) {
                            return Ended::Fatal(why.to_string());
                        }
                        // 4007 bad seq, 4009 timed out: start over
                        return if matches!(code, 4007 | 4009) { Ended::Fresh } else { Ended::Again };
                    }
                    Some(Ok(_)) => continue,
                    _ => return Ended::Again,
                };
                let v: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                if let Some(s) = v["s"].as_u64() {
                    session.seq = Some(s);
                }
                match v["op"].as_u64() {
                    Some(0) => match v["t"].as_str() {
                        Some("READY") => {
                            session.id = v["d"]["session_id"].as_str().map(str::to_string);
                            session.url = v["d"]["resume_gateway_url"].as_str().map(|u| u.trim_end_matches('/').to_string());
                            let me = &v["d"]["user"];
                            tell(json!({ "kind": "ready", "id": me["id"], "name": me["global_name"].as_str().or(me["username"].as_str()) }));
                        }
                        Some("RESUMED") => tell(json!({ "kind": "resumed" })),
                        // someone started typing: it waits for the rest before it answers
                        Some("TYPING_START") => tell(json!({ "kind": "typing", "channel": v["d"]["channel_id"], "user": v["d"]["user_id"] })),
                        Some("INTERACTION_CREATE") => {
                            if let Some(ev) = interaction_event(&v["d"]) {
                                tauri::async_runtime::spawn(acknowledge(v["d"].clone()));
                                tell(ev);
                            }
                        }
                        Some("MESSAGE_CREATE") => {
                            if let Some(m) = incoming(&v["d"]) {
                                tell(json!({ "kind": "message", "message": m }));
                            }
                        }
                        _ => {}
                    },
                    // asked to beat now
                    Some(1) => {
                        let _ = tx.send(Message::Text(json!({ "op": 1, "d": session.seq }).to_string().into())).await;
                    }
                    Some(7) => return Ended::Again,
                    Some(9) => {
                        // invalid session: resumable or not, wait a little first (as Discord asks)
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        return if v["d"].as_bool() == Some(true) { Ended::Again } else { Ended::Fresh };
                    }
                    Some(11) => acked = true,
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn its_api_calls_stay_on_discords_api() {
        for ok in ["/channels/1/messages", "/channels/1/messages/2/reactions/%F0%9F%91%8D/@me", "/guilds/1/members?limit=5"] {
            assert!(super::api_path(ok).is_ok(), "{ok}");
        }
        for bad in ["https://evil.example/x", "//evil.example/x", "/channels/../../x", "channels/1", "/a b", "/x#y", "/x\\y"] {
            assert!(super::api_path(bad).is_err(), "{bad}");
        }
        assert!(super::api_method("patch").is_ok());
        assert!(super::api_method("TRACE").is_err());
    }

    #[test]
    fn files_with_keys_or_sign_ins_never_go_up() {
        for f in ["/Users/me/.codex/auth.json", "/Users/me/.ssh/id_ed25519", "/p/.env.local", "/p/server.pem", "/Users/me/Library/Application Support/dev.3xhaust.ondra/keys.json", "/p/aws-credentials.txt"] {
            assert!(super::secret_file(f), "{f}");
        }
        for f in ["/tmp/after.png", "/Users/me/p/report.pdf", "/p/README.md"] {
            assert!(!super::secret_file(f), "{f}");
        }
    }

    #[test]
    fn a_click_and_a_command_reach_the_page_without_their_token() {
        let click = serde_json::json!({ "id": "i1", "type": 3, "token": "SECRET", "application_id": "a", "channel_id": "c1", "guild_id": "g",
            "member": { "user": { "id": "u1", "username": "lyu" } }, "message": { "id": "m1" }, "data": { "custom_id": "pick:2", "component_type": 2 } });
        let ev = super::interaction_event(&click).unwrap();
        assert_eq!(ev["interaction"]["kind"], "component");
        assert_eq!(ev["interaction"]["custom_id"], "pick:2");
        assert_eq!(ev["interaction"]["message"], "m1");
        assert!(!ev.to_string().contains("SECRET"));
        let cmd = serde_json::json!({ "id": "i2", "type": 2, "token": "SECRET", "channel_id": "c1", "user": { "id": "u1", "username": "lyu" },
            "data": { "name": "status", "options": [{ "name": "detail", "value": true }] } });
        let ev = super::interaction_event(&cmd).unwrap();
        assert_eq!(ev["interaction"]["command"], "status");
        assert!(!ev.to_string().contains("SECRET"));
        assert!(super::interaction_event(&serde_json::json!({ "type": 1 })).is_none());
    }

    #[test]
    fn a_private_channel_is_seen_by_the_user_and_the_bot_only() {
        let b = super::channel_body("g1", "메타몽-작업", "text", Some("cat"), Some("일하는 곳"), &["u1".to_string()], "bot");
        assert_eq!(b["type"], 0);
        assert_eq!(b["parent_id"], "cat");
        let over = b["permission_overwrites"].as_array().unwrap();
        assert_eq!(over[0]["id"], "g1");
        assert_eq!(over[0]["deny"], "1024");
        let ids: Vec<&str> = over[1..].iter().map(|o| o["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["u1", "bot"]);
        assert!(over[1]["allow"].as_str().unwrap().parse::<u64>().unwrap() & 1024 != 0);
        let open = super::channel_body("g1", "잡담", "category", None, None, &[], "");
        assert_eq!(open["type"], 4);
        assert!(open.get("permission_overwrites").is_none());
        assert_eq!(super::channel_brief(&serde_json::json!({"id":"1","name":"a","type":4}))["kind"], "category");
    }

    use super::*;

    /// Against the real gateway: `DISCORD_TOKEN=… cargo test --lib discord::tests::live -- --ignored`
    #[test]
    #[ignore]
    fn live() {
        let token = std::env::var("DISCORD_TOKEN").expect("DISCORD_TOKEN");
        let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();
        let got = std::sync::Arc::new(Mutex::new(Vec::<Value>::new()));
        let seen = got.clone();
        let tell = move |ev: Value| seen.lock().unwrap().push(ev);
        rt.block_on(async {
            let _ = tokio::time::timeout(Duration::from_secs(15), hold_with(&tell, &token)).await;
        });
        let evs = got.lock().unwrap().clone();
        let ready = evs.iter().find(|e| e["kind"] == "ready").unwrap_or_else(|| panic!("no READY: {evs:?}"));
        println!("connected as {} ({})", ready["name"], ready["id"]);
    }

    #[test]
    fn reads_a_message_as_the_page_gets_it() {
        let d = json!({
            "id": "m1", "channel_id": "c1", "guild_id": "g1", "content": "<@99> 안녕", "timestamp": "2026-11-20T01:00:00Z",
            "author": { "id": "u1", "username": "lyu", "global_name": "성윤" },
            "mentions": [{ "id": "99" }],
            "referenced_message": { "id": "m0", "author": { "id": "99" } },
            "attachments": [{ "url": "https://cdn.discordapp.com/a.png" }]
        });
        let m = incoming(&d).unwrap();
        assert_eq!(m.author, Author { id: "u1".into(), name: "성윤".into(), bot: false });
        assert_eq!(m.guild.as_deref(), Some("g1"));
        assert_eq!(m.mentions, vec!["99"]);
        assert_eq!(m.reply_to.as_deref(), Some("99"));
        assert_eq!(m.reply_msg.as_deref(), Some("m0"));
        assert_eq!(m.files, vec!["https://cdn.discordapp.com/a.png"]);
        // a forwarded message's pictures come with it
        let fw = incoming(&json!({ "id": "m3", "channel_id": "c1", "content": "", "author": { "id": "u1", "username": "lyu" },
            "message_snapshots": [{ "message": { "attachments": [{ "url": "https://cdn.discordapp.com/f.png" }] } }] })).unwrap();
        assert_eq!(fw.files, vec!["https://cdn.discordapp.com/f.png"]);
        // a DM has no guild and no reply
        let dm = incoming(&json!({ "id": "m2", "channel_id": "c2", "content": "hi", "author": { "id": "u1", "username": "lyu", "bot": false } })).unwrap();
        assert_eq!((dm.guild, dm.reply_to), (None, None));
        assert!(incoming(&json!({ "id": "x" })).is_none());
    }

    #[test]
    fn only_discords_own_file_hosts_are_fetched() {
        assert!(discord_file("https://cdn.discordapp.com/attachments/1/2/a.png?ex=1").is_some());
        assert!(discord_file("https://media.discordapp.net/attachments/1/2/b.jpg").is_some());
        assert!(discord_file("https://evil.example/cdn.discordapp.com/a.png").is_none());
        assert!(discord_file("http://cdn.discordapp.com/a.png").is_none());
        // the saved name is the file's own, kept to safe characters
        assert_eq!(discord_file("https://cdn.discordapp.com/attachments/1/2/스크린 샷..png?x=1").unwrap(), "_____..png");
    }

    #[test]
    fn the_owner_is_the_apps_or_its_teams() {
        assert_eq!(owner_of(&json!({ "owner": { "id": "1" } })).as_deref(), Some("1"));
        assert_eq!(owner_of(&json!({ "owner": { "id": "team-bot" }, "team": { "owner_user_id": "2" } })).as_deref(), Some("2"));
        assert_eq!(owner_of(&json!({})), None);
    }

    #[test]
    fn splits_long_answers_at_a_line_break() {
        assert_eq!(pieces("짧아"), vec!["짧아"]);
        assert!(pieces("  ").is_empty());
        let long = format!("{}\n{}", "가".repeat(1500), "나".repeat(1500));
        let p = pieces(&long);
        assert_eq!(p, vec!["가".repeat(1500), "나".repeat(1500)]);
        // no line break: cut at the limit
        let p = pieces(&"다".repeat(4100));
        assert_eq!(p.iter().map(|s| s.chars().count()).collect::<Vec<_>>(), vec![2000, 2000, 100]);
    }

    #[test]
    fn a_wrong_token_or_missing_intent_stops_instead_of_retrying() {
        assert!(fatal_close(4004).is_some());
        assert!(fatal_close(4014).unwrap().contains("MESSAGE CONTENT"));
        assert!(fatal_close(1001).is_none());
        assert!(fatal_close(4009).is_none());
    }
}
