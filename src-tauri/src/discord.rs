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
const INTENTS: u64 = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
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
        files: d["attachments"].as_array().map(|a| a.iter().filter_map(|f| s(&f["url"])).collect()).unwrap_or_default(),
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
pub fn discord_token_set(token: String) -> Result<(), String> {
    let t = token.trim();
    if t.is_empty() {
        return crate::secrets::vault_delete(TOKEN_ITEM);
    }
    crate::secrets::vault_set(TOKEN_ITEM, t)
}

/// Use a saved secret (Settings › 시크릿, by name) as the bot token: the value moves here, natively,
/// so an agent that set it up for the user never sees it.
#[tauri::command]
pub fn discord_token_from_secret(name: String) -> Result<(), String> {
    let v = crate::secrets::saved_value(name.trim()).filter(|v| !v.trim().is_empty()).ok_or_else(|| format!("시크릿 {}이(가) 없어요", name.trim()))?;
    crate::secrets::vault_set(TOKEN_ITEM, v.trim())
}

#[tauri::command]
pub fn discord_token_has() -> bool {
    token().is_ok()
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

/// Take back what the bot said (the user asked it to: "그거 지워").
#[tauri::command]
pub async fn discord_delete(channel: String, message: String) -> Result<(), String> {
    rest(reqwest::Method::DELETE, &format!("/channels/{channel}/messages/{message}"), None).await.map(|_| ())
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
pub fn discord_start(app: AppHandle) -> Result<(), String> {
    let token = token()?;
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
        // a DM has no guild and no reply
        let dm = incoming(&json!({ "id": "m2", "channel_id": "c2", "content": "hi", "author": { "id": "u1", "username": "lyu", "bot": false } })).unwrap();
        assert_eq!((dm.guild, dm.reply_to), (None, None));
        assert!(incoming(&json!({ "id": "x" })).is_none());
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
