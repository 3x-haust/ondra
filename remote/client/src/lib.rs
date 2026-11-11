//! The phone's side of Ondra's remote control, in the browser: dials the Mac by its key
//! through the relay (end-to-end encrypted), says hello with the device's own key, then
//! carries lines of JSON both ways.
use futures_channel::mpsc;
use futures_util::StreamExt;
use iroh::{endpoint::presets, Endpoint, EndpointId, SecretKey};
use wasm_bindgen::prelude::*;

const ALPN: &[u8] = b"ondra/remote/1";

fn js(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

/// A new device key (32 bytes), to keep in the browser: it is how the Mac knows this phone.
#[wasm_bindgen(js_name = newKey)]
pub fn new_key() -> Vec<u8> {
    SecretKey::generate().to_bytes().to_vec()
}

/// This device's id (its public key), as the Mac lists it.
#[wasm_bindgen(js_name = deviceId)]
pub fn device_id(key: Vec<u8>) -> Result<String, JsValue> {
    let b: [u8; 32] = key.try_into().map_err(|_| js("bad key"))?;
    Ok(SecretKey::from_bytes(&b).public().to_string())
}

#[wasm_bindgen]
pub struct Session {
    out: mpsc::UnboundedSender<String>,
    endpoint: Endpoint,
}

#[wasm_bindgen]
impl Session {
    /// Send one JSON line to the Mac.
    pub fn send(&self, line: String) -> bool {
        self.out.unbounded_send(line).is_ok()
    }
    pub async fn close(self) {
        self.endpoint.close().await;
    }
}

/// Connect to the Mac `mac` (its id) as the device holding `key`; `hello` is the first line.
/// `on_line(line)` hears every line the Mac sends; `on_close(reason)` once when it ends.
#[wasm_bindgen]
pub async fn connect(mac: String, key: Vec<u8>, hello: String, on_line: js_sys::Function, on_close: js_sys::Function) -> Result<Session, JsValue> {
    let id: EndpointId = mac.trim().parse().map_err(js)?;
    let b: [u8; 32] = key.try_into().map_err(|_| js("bad key"))?;
    let endpoint = Endpoint::builder(presets::N0).secret_key(SecretKey::from_bytes(&b)).bind().await.map_err(js)?;
    let conn = endpoint.connect(id, ALPN).await.map_err(js)?;
    let (mut send, mut recv) = conn.open_bi().await.map_err(js)?;
    send.write_all(hello.as_bytes()).await.map_err(js)?;
    send.write_all(b"\n").await.map_err(js)?;

    let (out, mut out_rx) = mpsc::unbounded::<String>();
    wasm_bindgen_futures::spawn_local(async move {
        while let Some(line) = out_rx.next().await {
            if send.write_all(line.as_bytes()).await.is_err() || send.write_all(b"\n").await.is_err() {
                break;
            }
        }
        let _ = send.finish();
    });
    let closer = on_close.clone();
    wasm_bindgen_futures::spawn_local(async move {
        let mut pending: Vec<u8> = Vec::new();
        let mut chunk = vec![0u8; 64 * 1024];
        let reason = loop {
            match recv.read(&mut chunk).await {
                Ok(Some(n)) => {
                    pending.extend_from_slice(&chunk[..n]);
                    while let Some(at) = pending.iter().position(|&c| c == b'\n') {
                        let line: Vec<u8> = pending.drain(..=at).collect();
                        let text = String::from_utf8_lossy(&line[..line.len() - 1]).into_owned();
                        let _ = on_line.call1(&JsValue::NULL, &JsValue::from_str(&text));
                    }
                }
                Ok(None) => break "closed".to_string(),
                Err(e) => break e.to_string(),
            }
        };
        let _ = closer.call1(&JsValue::NULL, &JsValue::from_str(&reason));
    });
    Ok(Session { out, endpoint })
}
