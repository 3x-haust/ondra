//! ondra-remote: Ondra's own private network, so one Mac's Ondra can work on another.
//!
//! Each Mac holds a key: its address on the network. Macs find each other by key through
//! a relay and talk end-to-end encrypted (iroh: QUIC over hole-punched UDP, or relayed when
//! that can't be done). The same helper does both sides:
//!   - host: other Macs connect in. Only Macs the user allowed get in; one is allowed with a
//!     one-time code from the link Ondra copies, and 허용 pressed on this Mac.
//!   - client: it dials a host ("dial") and carries the window's lines to it.
//!
//! The app drives it over stdin/stdout, one JSON object per line:
//!   in:  {"cmd":"host","on"} {"cmd":"pair","code","ttl"} {"cmd":"unpair"} {"cmd":"approve","conn","ok"}
//!        {"cmd":"send","conn","data"} {"cmd":"revoke","id"} {"cmd":"drop","id"} {"cmd":"devices"}
//!        {"cmd":"dial","peer","name","pair"?,"bye"?} {"cmd":"peer-send","peer","data"} {"cmd":"hangup","peer"}
//!   out: {"ev":"ready","id"} {"ev":"devices","list"} {"ev":"pair","conn","device"}
//!        {"ev":"open","conn","device"} {"ev":"msg","conn","data"} {"ev":"close","conn"} {"ev":"bye","device"}
//!        {"ev":"peer","peer","state":"connecting|waiting|ok|denied|closed|bye","reason"?,"bye"?}
//!        {"ev":"peer-msg","peer","data"}
//! It exits when stdin closes (the app quit).
//!
//! Between Macs, the first lines: the one dialing says {"t":"hello","name","pair"?,"bye"?}; the host
//! answers {"t":"waiting"} {"t":"ok"} {"t":"denied","reason":"off|unknown|refused"} or, to a bye,
//! {"t":"bye"} (it forgot that Mac). A host ends a live connection with a reason the other side
//! reads: "revoked" (removed there), "dropped" (cut for now) or "off" (hosting turned off).
//! A field or answer a peer doesn't know is ignored, so an older Mac keeps working.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use iroh::{
    endpoint::{presets, Connection, ConnectionError},
    protocol::{AcceptError, ProtocolHandler, Router},
    Endpoint, SecretKey,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot, Mutex},
};

const ALPN: &[u8] = b"ondra/remote/1";
/// why a host ended a connection (the QUIC close reason the other side reads)
const REVOKED: &[u8] = b"revoked";
const DROPPED: &[u8] = b"dropped";
const OFF: &[u8] = b"off";
/// one line, at most (a long job's record fits; a flood doesn't)
const MAX_LINE: usize = 64 << 20;

#[derive(Clone, Serialize, Deserialize)]
struct Device {
    id: String,
    name: String,
    #[serde(rename = "addedAt")]
    added_at: u64,
    #[serde(rename = "lastSeen", default)]
    last_seen: u64,
}

struct Shared {
    dir: PathBuf,
    devices: Mutex<Vec<Device>>,
    pairing: Mutex<Option<(String, Instant)>>,
    approvals: Mutex<HashMap<u64, oneshot::Sender<bool>>>,
    conns: Mutex<HashMap<u64, (String, mpsc::UnboundedSender<String>, Connection)>>,
    next: AtomicU64,
    /** other Macs may come in (the user turned it on) */
    hosting: AtomicBool,
    out: mpsc::UnboundedSender<Value>,
    /// hosts this Mac dialed: what to send them
    peers: Mutex<HashMap<String, (mpsc::UnboundedSender<String>, Connection)>>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Shared {
    fn emit(&self, v: Value) {
        let _ = self.out.send(v);
    }
    async fn save_devices(&self) {
        let list = self.devices.lock().await.clone();
        let path = self.dir.join("devices.json");
        let tmp = self.dir.join("devices.json.tmp");
        if std::fs::write(&tmp, serde_json::to_vec_pretty(&list).unwrap_or_default()).is_ok() {
            let _ = std::fs::rename(tmp, path);
        }
        self.emit(json!({ "ev": "devices", "list": list }));
    }
}

/// The Mac's key: made once, kept in Ondra's data folder (readable by the user only).
fn load_key(dir: &Path) -> Result<SecretKey> {
    let path = dir.join("key");
    if let Ok(bytes) = std::fs::read(&path) {
        if let Ok(b) = <[u8; 32]>::try_from(bytes.as_slice()) {
            return Ok(SecretKey::from_bytes(&b));
        }
    }
    let key = SecretKey::generate();
    std::fs::write(&path, key.to_bytes()).context("write key")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(key)
}

#[derive(Clone)]
struct Remote(Arc<Shared>);

impl std::fmt::Debug for Remote {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Remote")
    }
}

impl ProtocolHandler for Remote {
    async fn accept(&self, conn: Connection) -> Result<(), AcceptError> {
        let s = self.0.clone();
        if let Err(e) = serve(s, conn).await {
            eprintln!("ondra-remote: {e:#}");
        }
        Ok(())
    }
}

/// What a Mac says first when it dials in.
#[derive(Debug, PartialEq)]
struct Hello {
    name: String,
    pair: String,
    /// it removed this Mac on its side: forget it here too
    bye: bool,
}

fn parse_hello(v: &Value) -> Hello {
    Hello {
        name: v.get("name").and_then(Value::as_str).unwrap_or("Mac").chars().take(60).collect(),
        pair: v.get("pair").and_then(Value::as_str).unwrap_or("").to_string(),
        bye: v.get("bye").and_then(Value::as_bool).unwrap_or(false),
    }
}

/// The word the app hears for a host's close reason (anything else is a plain "closed").
fn close_word(reason: &[u8]) -> Option<&'static str> {
    match reason {
        REVOKED => Some("revoked"),
        DROPPED => Some("dropped"),
        OFF => Some("off"),
        _ => None,
    }
}

/// The device list without that Mac; None when it wasn't in it.
fn without(list: &[Device], id: &str) -> Option<Vec<Device>> {
    list.iter().any(|d| d.id == id).then(|| list.iter().filter(|d| d.id != id).cloned().collect())
}

async fn serve(s: Arc<Shared>, conn: Connection) -> Result<()> {
    let peer = conn.remote_id().to_string();
    let (mut send, recv) = conn.accept_bi().await?;
    let mut lines = BufReader::new(recv);
    let mut buf = Vec::new();
    // the first line says who it is: {"t":"hello","name":"iPhone","pair":"<code>"}
    let hello = match read_line(&mut lines, &mut buf).await? {
        Some(v) => parse_hello(&v),
        None => return Ok(()),
    };
    // a Mac saying goodbye is forgotten even while hosting is off: leaving is always allowed
    if hello.bye {
        let gone = {
            let mut list = s.devices.lock().await;
            let gone = list.iter().find(|d| d.id == peer).cloned();
            if let Some(rest) = without(&list, &peer) {
                *list = rest;
            }
            gone
        };
        let reply: &[u8] = if let Some(d) = gone {
            s.save_devices().await;
            for (_, (p, _, c)) in s.conns.lock().await.iter() {
                if *p == peer {
                    c.close(1u32.into(), REVOKED);
                }
            }
            s.emit(json!({ "ev": "bye", "device": { "id": d.id, "name": d.name } }));
            b"{\"t\":\"bye\"}\n"
        } else {
            b"{\"t\":\"denied\",\"reason\":\"unknown\"}\n"
        };
        send.write_all(reply).await?;
        send.finish()?;
        let _ = tokio::time::timeout(Duration::from_secs(10), conn.closed()).await;
        return Ok(());
    }
    if !s.hosting.load(Ordering::Relaxed) {
        send.write_all(b"{\"t\":\"denied\",\"reason\":\"off\"}\n").await?;
        send.finish()?;
        conn.closed().await;
        return Ok(());
    }
    let name = hello.name;
    let id = s.next.fetch_add(1, Ordering::Relaxed);
    let known = s.devices.lock().await.iter().any(|d| d.id == peer);
    if !known {
        let code = hello.pair.as_str();
        let valid = {
            let p = s.pairing.lock().await;
            matches!(&*p, Some((c, until)) if !code.is_empty() && c == code && Instant::now() < *until)
        };
        if !valid {
            send.write_all(b"{\"t\":\"denied\",\"reason\":\"unknown\"}\n").await?;
            send.finish()?;
            conn.closed().await;
            return Ok(());
        }
        // the user says yes on the Mac (or it times out)
        let (tx, rx) = oneshot::channel();
        s.approvals.lock().await.insert(id, tx);
        s.emit(json!({ "ev": "pair", "conn": id, "device": { "id": peer, "name": name } }));
        send.write_all(b"{\"t\":\"waiting\"}\n").await?;
        let ok = tokio::time::timeout(Duration::from_secs(120), rx).await.ok().and_then(|r| r.ok()).unwrap_or(false);
        s.approvals.lock().await.remove(&id);
        if !ok {
            send.write_all(b"{\"t\":\"denied\",\"reason\":\"refused\"}\n").await?;
            send.finish()?;
            conn.closed().await;
            return Ok(());
        }
        *s.pairing.lock().await = None; // one code, one device
        s.devices.lock().await.push(Device { id: peer.clone(), name: name.clone(), added_at: now(), last_seen: now() });
        s.save_devices().await;
    } else {
        for d in s.devices.lock().await.iter_mut().filter(|d| d.id == peer) {
            d.last_seen = now();
            if !name.is_empty() {
                d.name = name.clone();
            }
        }
        s.save_devices().await;
    }
    send.write_all(b"{\"t\":\"ok\"}\n").await?;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    s.conns.lock().await.insert(id, (peer.clone(), tx, conn.clone()));
    s.emit(json!({ "ev": "open", "conn": id, "device": { "id": peer, "name": name } }));
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if send.write_all(line.as_bytes()).await.is_err() || send.write_all(b"\n").await.is_err() {
                break;
            }
        }
        let _ = send.finish();
    });
    loop {
        match read_line(&mut lines, &mut buf).await {
            Ok(Some(data)) => s.emit(json!({ "ev": "msg", "conn": id, "data": data })),
            _ => break,
        }
    }
    s.conns.lock().await.remove(&id);
    writer.abort();
    s.emit(json!({ "ev": "close", "conn": id }));
    Ok(())
}

/// A "peer" event; one from a dial that only says goodbye says so (`"bye": true`), so the app
/// can't take it for an older dial's.
fn peer_ev(peer: &str, state: &str, reason: Option<Value>, bye: bool) -> Value {
    let mut v = json!({ "ev": "peer", "peer": peer, "state": state });
    if let Some(r) = reason {
        v["reason"] = r;
    }
    if bye {
        v["bye"] = json!(true);
    }
    v
}

/// Connect to a host Mac and carry lines both ways until either side ends. A goodbye dial
/// (`"bye": true` in the hello) ends after the host's answer.
async fn dial(s: Arc<Shared>, ep: Endpoint, peer: String, hello: Value) -> Result<()> {
    let id: iroh::EndpointId = peer.parse().map_err(|e| anyhow!("{e}"))?;
    let bye = hello.get("bye").and_then(Value::as_bool).unwrap_or(false);
    if let Some((_, old)) = s.peers.lock().await.remove(&peer) {
        old.close(0u32.into(), b"again");
    }
    s.emit(peer_ev(&peer, "connecting", None, bye));
    let conn = ep.connect(id, ALPN).await?;
    let (mut send, recv) = conn.open_bi().await?;
    send.write_all(format!("{hello}\n").as_bytes()).await?;
    let mut lines = BufReader::new(recv);
    let mut buf = Vec::new();
    // the host says waiting (asking its user), ok, or denied
    loop {
        let Some(v) = read_line(&mut lines, &mut buf).await? else { return Err(anyhow!("closed")) };
        match v.get("t").and_then(Value::as_str) {
            Some("waiting") => s.emit(peer_ev(&peer, "waiting", None, bye)),
            // an older host let a goodbye in as a visit: say so and leave
            Some("ok") if bye => {
                s.emit(peer_ev(&peer, "ok", None, bye));
                conn.close(0u32.into(), b"bye");
                return Ok(());
            }
            Some("ok") => break,
            // it forgot this Mac, as asked
            Some("bye") => {
                s.emit(peer_ev(&peer, "bye", None, bye));
                conn.close(0u32.into(), b"bye");
                return Ok(());
            }
            Some("denied") => {
                s.emit(peer_ev(&peer, "denied", Some(v.get("reason").cloned().unwrap_or(Value::Null)), bye));
                conn.close(0u32.into(), b"denied");
                return Ok(());
            }
            _ => {}
        }
    }
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    s.peers.lock().await.insert(peer.clone(), (tx, conn.clone()));
    s.emit(json!({ "ev": "peer", "peer": peer, "state": "ok" }));
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if send.write_all(line.as_bytes()).await.is_err() || send.write_all(b"\n").await.is_err() {
                break;
            }
        }
        let _ = send.finish();
    });
    let reason = loop {
        match read_line(&mut lines, &mut buf).await {
            Ok(Some(data)) => s.emit(json!({ "ev": "peer-msg", "peer": peer, "data": data })),
            Ok(None) => break "closed".to_string(),
            Err(e) => break format!("{e:#}"),
        }
    };
    writer.abort();
    let mine = s.peers.lock().await.get(&peer).map(|(_, c)| c.stable_id() == conn.stable_id()).unwrap_or(false);
    if mine {
        s.peers.lock().await.remove(&peer);
        // the host said why it ended it: removed there or turned off is a "no"; cut for now is a close
        let why = match conn.close_reason() {
            Some(ConnectionError::ApplicationClosed(c)) => close_word(&c.reason),
            _ => None,
        };
        match why {
            Some(w @ ("revoked" | "off")) => s.emit(peer_ev(&peer, "denied", Some(json!(w)), false)),
            Some(w) => s.emit(peer_ev(&peer, "closed", Some(json!(w)), false)),
            None => s.emit(peer_ev(&peer, "closed", Some(json!(reason)), false)),
        }
    }
    Ok(())
}

async fn read_line<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R, buf: &mut Vec<u8>) -> Result<Option<Value>> {
    buf.clear();
    let mut limited = r.take(MAX_LINE as u64);
    let n = limited.read_until(b'\n', buf).await?;
    if n == 0 {
        return Ok(None);
    }
    if buf.last() != Some(&b'\n') && n >= MAX_LINE {
        return Err(anyhow!("line too long"));
    }
    Ok(Some(serde_json::from_slice(buf.trim_ascii())?))
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let dir = args.iter().position(|a| a == "--data").and_then(|i| args.get(i + 1)).map(PathBuf::from).ok_or_else(|| anyhow!("--data <dir>"))?;
    std::fs::create_dir_all(&dir)?;
    let devices: Vec<Device> = std::fs::read(dir.join("devices.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();

    let (out, mut out_rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(v) = out_rx.recv().await {
            let mut line = v.to_string();
            line.push('\n');
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            let _ = stdout.flush().await;
        }
    });
    let s = Arc::new(Shared {
        dir: dir.clone(),
        devices: Mutex::new(devices),
        pairing: Mutex::new(None),
        approvals: Mutex::new(HashMap::new()),
        conns: Mutex::new(HashMap::new()),
        next: AtomicU64::new(1),
        hosting: AtomicBool::new(false),
        out,
        peers: Mutex::new(HashMap::new()),
    });

    let key = load_key(&dir)?;
    let endpoint = Endpoint::builder(presets::N0).secret_key(key).alpns(vec![ALPN.to_vec()]).bind().await?;
    let router = Router::builder(endpoint).accept(ALPN, Remote(s.clone())).spawn();
    let me = router.endpoint().id().to_string();
    s.emit(json!({ "ev": "devices", "list": s.devices.lock().await.clone() }));
    {
        let s = s.clone();
        let ep = router.endpoint().clone();
        tokio::spawn(async move {
            // reachable through the relay: say so (until then the QR would lead nowhere)
            let _ = tokio::time::timeout(Duration::from_secs(20), ep.online()).await;
            s.emit(json!({ "ev": "ready", "id": me }));
        });
    }

    let mut stdin = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = stdin.next_line().await {
        let Ok(cmd) = serde_json::from_str::<Value>(&line) else { continue };
        let conn_id = cmd.get("conn").and_then(Value::as_u64).unwrap_or(0);
        match cmd.get("cmd").and_then(Value::as_str).unwrap_or("") {
            "pair" => {
                let code = cmd.get("code").and_then(Value::as_str).unwrap_or("").to_string();
                let ttl = cmd.get("ttl").and_then(Value::as_u64).unwrap_or(600);
                *s.pairing.lock().await = (!code.is_empty()).then(|| (code, Instant::now() + Duration::from_secs(ttl)));
            }
            "unpair" => *s.pairing.lock().await = None,
            "host" => {
                let on = cmd.get("on").and_then(Value::as_bool).unwrap_or(false);
                s.hosting.store(on, Ordering::Relaxed);
                if !on {
                    *s.pairing.lock().await = None;
                    for (_, (_, _, c)) in s.conns.lock().await.iter() {
                        c.close(2u32.into(), OFF);
                    }
                }
            }
            "approve" => {
                if let Some(tx) = s.approvals.lock().await.remove(&conn_id) {
                    let _ = tx.send(cmd.get("ok").and_then(Value::as_bool).unwrap_or(false));
                }
            }
            "send" => {
                if let Some(data) = cmd.get("data") {
                    if let Some((_, tx, _)) = s.conns.lock().await.get(&conn_id) {
                        let _ = tx.send(data.to_string());
                    }
                }
            }
            "revoke" => {
                let id = cmd.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                s.devices.lock().await.retain(|d| d.id != id);
                s.save_devices().await;
                for (_, (peer, _, c)) in s.conns.lock().await.iter() {
                    if *peer == id {
                        c.close(1u32.into(), REVOKED);
                    }
                }
            }
            // cut that Mac off for now: it stays allowed and may come back
            "drop" => {
                let id = cmd.get("id").and_then(Value::as_str).unwrap_or("");
                for (_, (peer, _, c)) in s.conns.lock().await.iter() {
                    if peer == id {
                        c.close(3u32.into(), DROPPED);
                    }
                }
            }
            "devices" => s.emit(json!({ "ev": "devices", "list": s.devices.lock().await.clone() })),
            "dial" => {
                let peer = cmd.get("peer").and_then(Value::as_str).unwrap_or("").trim().to_string();
                let bye = cmd.get("bye").and_then(Value::as_bool).unwrap_or(false);
                let mut hello = json!({ "t": "hello", "name": cmd.get("name").cloned().unwrap_or(json!("Mac")), "pair": cmd.get("pair").cloned().unwrap_or(Value::Null) });
                if bye {
                    hello["bye"] = json!(true);
                }
                let (s, ep) = (s.clone(), router.endpoint().clone());
                tokio::spawn(async move {
                    if let Err(e) = dial(s.clone(), ep, peer.clone(), hello).await {
                        s.emit(peer_ev(&peer, "closed", Some(json!(format!("{e:#}"))), bye));
                    }
                });
            }
            "peer-send" => {
                let peer = cmd.get("peer").and_then(Value::as_str).unwrap_or("");
                if let (Some(data), Some((tx, _))) = (cmd.get("data"), s.peers.lock().await.get(peer)) {
                    let _ = tx.send(data.to_string());
                }
            }
            "hangup" => {
                let peer = cmd.get("peer").and_then(Value::as_str).unwrap_or("");
                if let Some((_, c)) = s.peers.lock().await.remove(peer) {
                    c.close(0u32.into(), b"bye");
                }
            }
            _ => {}
        }
    }
    router.shutdown().await.ok();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dev(id: &str) -> Device {
        Device { id: id.into(), name: id.into(), added_at: 1, last_seen: 1 }
    }

    #[test]
    fn hello_reads_bye_and_defaults() {
        let h = parse_hello(&json!({ "t": "hello", "name": "Air", "pair": null, "bye": true }));
        assert_eq!(h, Hello { name: "Air".into(), pair: "".into(), bye: true });
        // an older Mac's hello: no bye
        let h = parse_hello(&json!({ "t": "hello", "pair": "abc" }));
        assert_eq!(h, Hello { name: "Mac".into(), pair: "abc".into(), bye: false });
        assert_eq!(parse_hello(&json!({ "name": "x".repeat(200) })).name.chars().count(), 60);
    }

    #[test]
    fn close_reasons() {
        assert_eq!(close_word(b"revoked"), Some("revoked"));
        assert_eq!(close_word(b"dropped"), Some("dropped"));
        assert_eq!(close_word(b"off"), Some("off"));
        assert_eq!(close_word(b"again"), None);
        assert_eq!(close_word(b""), None);
    }

    #[test]
    fn goodbye_dial_events_say_so() {
        assert_eq!(peer_ev("p", "ok", None, false), json!({ "ev": "peer", "peer": "p", "state": "ok" }));
        assert_eq!(peer_ev("p", "denied", Some(json!("off")), true), json!({ "ev": "peer", "peer": "p", "state": "denied", "reason": "off", "bye": true }));
    }

    #[test]
    fn forgetting_a_device() {
        let list = vec![dev("a"), dev("b")];
        let rest = without(&list, "a").unwrap();
        assert_eq!(rest.iter().map(|d| d.id.as_str()).collect::<Vec<_>>(), ["b"]);
        assert!(without(&list, "c").is_none());
    }
}
