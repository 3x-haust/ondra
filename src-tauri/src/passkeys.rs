//! Passkeys in the in-app browser, kept by Ondra itself.
//!
//! A WKWebView only reaches the Mac's own passkeys (iCloud Keychain) in an app Apple entitled as
//! a web browser, which Ondra is not, so WebAuthn there fails. Instead `passkeys.js` hands every
//! `navigator.credentials.create/get({ publicKey })` of the in-app browser's pages to the
//! `ondraPasskey` message handler here, which acts as the authenticator: a P-256 key per passkey,
//! made and used only after Touch ID (or the login password), with the page's origin taken from
//! WebKit, never from the page. The keys live in the keychain vault (`secrets.rs`), one item per
//! space, so a passkey made in one space never shows in the other, like its cookies. Jobs never
//! use them: a sign-in made with one reaches the jobs' browser as cookies.

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{ECDSA_P256_SHA256_ASN1_SIGNING, EcdsaKeyPair, KeyPair};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const SHIM: &str = include_str!("passkeys.js");

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Passkey {
    /// credential id, base64url
    pub id: String,
    pub rp_id: String,
    /// the site's user handle, base64url
    pub user_id: String,
    pub user_name: String,
    pub display_name: String,
    /// PKCS#8 private key, base64
    pub key: String,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Request {
    Create {
        rp_id: Option<String>,
        user_id: String,
        user_name: String,
        display_name: String,
        challenge: String,
        algs: Vec<i64>,
        exclude: Vec<String>,
    },
    Get {
        rp_id: Option<String>,
        challenge: String,
        allow: Vec<String>,
    },
}

/// The frame's origin as WebKit reports it (port 0: the scheme's default).
pub struct Origin {
    pub scheme: String,
    pub host: String,
    pub port: u16,
}

impl Origin {
    fn serialized(&self) -> String {
        if self.port == 0 { format!("{}://{}", self.scheme, self.host) } else { format!("{}://{}:{}", self.scheme, self.host, self.port) }
    }
}

/// A WebAuthn failure: the DOMException name the page gets, and its message.
#[derive(Debug, PartialEq)]
pub struct Fail(pub &'static str, pub String);

impl Fail {
    pub fn reply(&self) -> String {
        json!({ "error": self.0, "message": self.1 }).to_string()
    }
}

/// ES256, the only algorithm made here
const ES256: i64 = -7;
const UP: u8 = 0x01;
const UV: u8 = 0x04;
const AT: u8 = 0x40;

/// The RP ID a request from `origin` may use: the host itself or a parent domain of it, on a
/// secure origin.
pub fn rp_id(origin: &Origin, asked: Option<&str>) -> Result<String, Fail> {
    let host = origin.host.to_ascii_lowercase();
    let local = host == "localhost" || host.ends_with(".localhost");
    if origin.scheme != "https" && !(origin.scheme == "http" && local) {
        return Err(Fail("SecurityError", "Passkeys need a secure (https) page.".into()));
    }
    let rp = asked.map(str::to_ascii_lowercase).unwrap_or_else(|| host.clone());
    let parent = host.strip_suffix(rp.as_str()).is_some_and(|rest| rest.ends_with('.')) && rp.contains('.');
    if rp != host && !parent {
        return Err(Fail("SecurityError", format!("The RP ID \"{rp}\" is not this page's domain.")));
    }
    Ok(rp)
}

fn decode(s: &str) -> Result<Vec<u8>, Fail> {
    URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).map_err(|_| Fail("TypeError", "Invalid binary value.".into()))
}

fn sha256(data: &[u8]) -> [u8; 32] {
    let d = ring::digest::digest(&ring::digest::SHA256, data);
    d.as_ref().try_into().expect("32 bytes")
}

fn client_data(kind: &str, challenge: &str, origin: &Origin) -> Result<String, Fail> {
    let challenge = URL_SAFE_NO_PAD.encode(decode(challenge)?);
    Ok(format!(
        "{{\"type\":{},\"challenge\":{},\"origin\":{},\"crossOrigin\":false}}",
        json!(kind),
        json!(challenge),
        json!(origin.serialized())
    ))
}

// ───────────── CBOR, just what attestation needs ─────────────

fn cbor_head(out: &mut Vec<u8>, major: u8, n: u64) {
    let m = major << 5;
    match n {
        0..=23 => out.push(m | n as u8),
        24..=0xff => out.extend([m | 24, n as u8]),
        0x100..=0xffff => {
            out.push(m | 25);
            out.extend((n as u16).to_be_bytes());
        }
        _ => {
            out.push(m | 26);
            out.extend((n as u32).to_be_bytes());
        }
    }
}
fn cbor_int(out: &mut Vec<u8>, n: i64) {
    if n >= 0 { cbor_head(out, 0, n as u64) } else { cbor_head(out, 1, (-1 - n) as u64) }
}
fn cbor_bytes(out: &mut Vec<u8>, b: &[u8]) {
    cbor_head(out, 2, b.len() as u64);
    out.extend(b);
}
fn cbor_text(out: &mut Vec<u8>, s: &str) {
    cbor_head(out, 3, s.len() as u64);
    out.extend(s.as_bytes());
}

/// The public key as a COSE EC2 key (P-256, ES256), keys in CTAP2 canonical order.
fn cose_key(public: &[u8]) -> Vec<u8> {
    let (x, y) = (&public[1..33], &public[33..65]);
    let mut out = Vec::new();
    cbor_head(&mut out, 5, 5);
    for (k, v) in [(1, 2), (3, ES256), (-1, 1)] {
        cbor_int(&mut out, k);
        cbor_int(&mut out, v);
    }
    cbor_int(&mut out, -2);
    cbor_bytes(&mut out, x);
    cbor_int(&mut out, -3);
    cbor_bytes(&mut out, y);
    out
}

/// The public key as SubjectPublicKeyInfo DER, for `getPublicKey()`.
fn spki(public: &[u8]) -> Vec<u8> {
    const PREFIX: [u8; 26] = [
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
        0x01, 0x07, 0x03, 0x42, 0x00,
    ];
    [&PREFIX[..], public].concat()
}

fn auth_data(rp: &str, flags: u8, attested: Option<(&[u8], &[u8])>) -> Vec<u8> {
    let mut out = sha256(rp.as_bytes()).to_vec();
    out.push(flags | if attested.is_some() { AT } else { 0 });
    // the sign count stays 0, as with Apple's own passkeys
    out.extend(0u32.to_be_bytes());
    if let Some((id, public)) = attested {
        out.extend([0u8; 16]);
        out.extend((id.len() as u16).to_be_bytes());
        out.extend(id);
        out.extend(cose_key(public));
    }
    out
}

fn key_pair(p: &Passkey) -> Result<EcdsaKeyPair, Fail> {
    let pkcs8 = STANDARD.decode(&p.key).map_err(|_| Fail("UnknownError", "The passkey is damaged.".into()))?;
    EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &pkcs8, &SystemRandom::new()).map_err(|_| Fail("UnknownError", "The passkey is damaged.".into()))
}

/// Checks a create request before anyone is asked: its RP ID, an algorithm this makes, and none of
/// its excluded credentials kept here.
pub fn check_create(req: &Request, origin: &Origin, kept: &[Passkey]) -> Result<String, Fail> {
    let Request::Create { rp_id: asked, algs, exclude, user_id, .. } = req else { unreachable!() };
    let rp = rp_id(origin, asked.as_deref())?;
    let user = decode(user_id)?;
    if user.is_empty() || user.len() > 64 {
        return Err(Fail("TypeError", "The user id must be 1 to 64 bytes.".into()));
    }
    if !algs.is_empty() && !algs.contains(&ES256) {
        return Err(Fail("NotSupportedError", "Only ES256 passkeys can be made here.".into()));
    }
    if kept.iter().any(|p| p.rp_id == rp && exclude.contains(&p.id)) {
        return Err(Fail("InvalidStateError", "A passkey for this account is already saved.".into()));
    }
    Ok(rp)
}

/// Makes the passkey (after the user agreed) and the page's answer.
pub fn create(req: &Request, origin: &Origin, rp: &str) -> Result<(Passkey, String), Fail> {
    let Request::Create { user_id, user_name, display_name, challenge, .. } = req else { unreachable!() };
    let rng = SystemRandom::new();
    let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).map_err(|_| Fail("UnknownError", "The key could not be made.".into()))?;
    let mut id = [0u8; 16];
    rng.fill(&mut id).map_err(|_| Fail("UnknownError", "The key could not be made.".into()))?;
    let passkey = Passkey {
        id: URL_SAFE_NO_PAD.encode(id),
        rp_id: rp.to_string(),
        user_id: user_id.clone(),
        user_name: user_name.clone(),
        display_name: display_name.clone(),
        key: STANDARD.encode(pkcs8.as_ref()),
    };
    let public = key_pair(&passkey)?.public_key().as_ref().to_vec();
    let data = auth_data(rp, UP | UV, Some((&id, &public)));
    let mut attestation = Vec::new();
    cbor_head(&mut attestation, 5, 3);
    cbor_text(&mut attestation, "fmt");
    cbor_text(&mut attestation, "none");
    cbor_text(&mut attestation, "attStmt");
    cbor_head(&mut attestation, 5, 0);
    cbor_text(&mut attestation, "authData");
    cbor_bytes(&mut attestation, &data);
    let client = client_data("webauthn.create", challenge, origin)?;
    let reply = json!({
        "id": passkey.id,
        "clientDataJSON": URL_SAFE_NO_PAD.encode(&client),
        "attestationObject": URL_SAFE_NO_PAD.encode(&attestation),
        "authenticatorData": URL_SAFE_NO_PAD.encode(&data),
        "publicKey": URL_SAFE_NO_PAD.encode(spki(&public)),
    });
    Ok((passkey, reply.to_string()))
}

/// The passkeys a get request may use, and its RP ID.
pub fn candidates<'a>(req: &Request, origin: &Origin, kept: &'a [Passkey]) -> Result<(String, Vec<&'a Passkey>), Fail> {
    let Request::Get { rp_id: asked, allow, .. } = req else { unreachable!() };
    let rp = rp_id(origin, asked.as_deref())?;
    let found: Vec<&Passkey> = kept.iter().filter(|p| p.rp_id == rp && (allow.is_empty() || allow.contains(&p.id))).collect();
    if found.is_empty() {
        return Err(Fail("NotAllowedError", "Ondra has no passkey for this site.".into()));
    }
    Ok((rp, found))
}

/// Signs in with `passkey` (after the user agreed): the page's answer.
pub fn assert(req: &Request, origin: &Origin, passkey: &Passkey) -> Result<String, Fail> {
    let Request::Get { challenge, .. } = req else { unreachable!() };
    let data = auth_data(&passkey.rp_id, UP | UV, None);
    let client = client_data("webauthn.get", challenge, origin)?;
    let signed = [data.as_slice(), &sha256(client.as_bytes())].concat();
    let signature = key_pair(passkey)?.sign(&SystemRandom::new(), &signed).map_err(|_| Fail("UnknownError", "Signing failed.".into()))?;
    Ok(json!({
        "id": passkey.id,
        "clientDataJSON": URL_SAFE_NO_PAD.encode(&client),
        "authenticatorData": URL_SAFE_NO_PAD.encode(&data),
        "signature": URL_SAFE_NO_PAD.encode(signature.as_ref()),
        "userHandle": Value::String(passkey.user_id.clone()),
    })
    .to_string())
}

/// What a passkey is called in the prompts.
pub fn label(p: &Passkey) -> &str {
    if !p.user_name.is_empty() { &p.user_name } else if !p.display_name.is_empty() { &p.display_name } else { "이름 없는 계정" }
}

// ───────────── the message handler (macOS) ─────────────

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool, NSObject, ProtocolObject};
    use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::NSAlert;
    use objc2_foundation::{NSObjectProtocol, NSString, ns_string};
    use objc2_web_kit::{WKContentWorld, WKScriptMessage, WKScriptMessageHandlerWithReply, WKUserContentController, WKWebView};
    use std::sync::mpsc;
    use tauri::{AppHandle, Webview};

    #[link(name = "LocalAuthentication", kind = "framework")]
    unsafe extern "C" {}

    pub struct Ivars {
        app: AppHandle,
        space: String,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Ivars]
        struct Handler;

        unsafe impl NSObjectProtocol for Handler {}

        unsafe impl WKScriptMessageHandlerWithReply for Handler {
            #[unsafe(method(userContentController:didReceiveScriptMessage:replyHandler:))]
            unsafe fn did_receive(&self, _c: &WKUserContentController, message: &WKScriptMessage, reply: &DynBlock<dyn Fn(*mut AnyObject, *mut NSString)>) {
                let reply = Reply(reply.copy());
                let (frame, body) = unsafe { (message.frameInfo(), message.body()) };
                let origin = unsafe {
                    let o = frame.securityOrigin();
                    Origin { scheme: o.protocol().to_string(), host: o.host().to_string(), port: o.port() as u16 }
                };
                let main_frame = unsafe { frame.isMainFrame() };
                let body = body.downcast::<NSString>().map(|s| s.to_string()).unwrap_or_default();
                let app = self.ivars().app.clone();
                let space = self.ivars().space.clone();
                std::thread::spawn(move || {
                    let answer = if main_frame {
                        serve(&app, &space, &origin, &body).unwrap_or_else(|f| f.reply())
                    } else {
                        Fail("NotAllowedError", "Passkeys work only in the page itself, not in a frame.".into()).reply()
                    };
                    let _ = app.clone().run_on_main_thread(move || reply.send(&answer));
                });
            }
        }
    );

    /// The page's reply block, called once on the main thread.
    struct Reply(RcBlock<dyn Fn(*mut AnyObject, *mut NSString)>);
    // SAFETY: the block is only moved through the worker thread and called on the main thread.
    unsafe impl Send for Reply {}
    impl Reply {
        fn send(self, answer: &str) {
            let s = NSString::from_str(answer);
            self.0.call((Retained::as_ptr(&s) as *mut AnyObject, std::ptr::null_mut()));
        }
    }

    /// Starts answering WebAuthn for the space's in-app browser (once, when it is made; its popups
    /// share the same handler).
    pub fn attach(app: &AppHandle, wv: &Webview, space: &str) {
        let ivars = Ivars { app: app.clone(), space: crate::browser::space_key(space) };
        let _ = wv.with_webview(move |pv| {
            let Some(mtm) = MainThreadMarker::new() else { return };
            // SAFETY: on macOS the platform webview is wry's WKWebView, alive for this call.
            unsafe {
                let wk = &*(pv.inner() as *const WKWebView);
                let handler: Retained<Handler> = msg_send![super(Handler::alloc(mtm).set_ivars(ivars)), init];
                wk.configuration().userContentController().addScriptMessageHandlerWithReply_contentWorld_name(
                    ProtocolObject::from_ref(&*handler),
                    &WKContentWorld::pageWorld(mtm),
                    ns_string!("ondraPasskey"),
                );
            }
        });
    }

    fn vault_item(space: &str) -> String {
        format!("@passkeys/{space}")
    }

    fn kept(space: &str) -> Result<Vec<Passkey>, Fail> {
        let item = vault_item(space);
        let raw = tauri::async_runtime::block_on(crate::secrets::off_main(move || crate::secrets::vault_get(&item))).map_err(|e| Fail("UnknownError", e))?;
        Ok(raw.and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default())
    }

    fn keep(space: &str, passkey: Passkey) -> Result<(), Fail> {
        let item = vault_item(space);
        tauri::async_runtime::block_on(crate::secrets::off_main(move || {
            let mut all: Vec<Passkey> = crate::secrets::vault_get(&item).and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default();
            all.retain(|p| !(p.rp_id == passkey.rp_id && p.user_id == passkey.user_id));
            all.push(passkey);
            crate::secrets::vault_set(&item, &serde_json::to_string(&all).map_err(|e| e.to_string())?)
        }))
        .map_err(|e| Fail("UnknownError", e))?
        .map_err(|e| Fail("UnknownError", e))
    }

    fn serve(app: &AppHandle, space: &str, origin: &Origin, body: &str) -> Result<String, Fail> {
        let req: Request = serde_json::from_str(body).map_err(|_| Fail("TypeError", "Invalid publicKey options.".into()))?;
        let kept = kept(space)?;
        match &req {
            Request::Create { user_name, display_name, .. } => {
                let rp = check_create(&req, origin, &kept)?;
                let who = if user_name.is_empty() { display_name } else { user_name };
                confirm(&format!("{rp}에 쓸 패스키({who})를 저장"))?;
                let (passkey, reply) = create(&req, origin, &rp)?;
                keep(space, passkey)?;
                Ok(reply)
            }
            Request::Get { .. } => {
                let (rp, found) = candidates(&req, origin, &kept)?;
                let chosen = if found.len() == 1 { found[0] } else { found[pick(app, &rp, &found)?] };
                confirm(&format!("{rp}에 패스키({})로 로그인", label(chosen)))?;
                assert(&req, origin, chosen)
            }
        }
    }

    fn cancelled() -> Fail {
        Fail("NotAllowedError", "The request was cancelled.".into())
    }

    /// Touch ID, or the login password: macOS shows "Ondra … <reason>하려고 합니다".
    fn confirm(reason: &str) -> Result<(), Fail> {
        let (tx, rx) = mpsc::channel();
        let Some(class) = AnyClass::get(c"LAContext") else { return Err(cancelled()) };
        // SAFETY: LAContext's documented API; `context` outlives the reply, which is awaited below.
        let context: Retained<NSObject> = unsafe { msg_send![class, new] };
        let done = RcBlock::new(move |ok: Bool, _error: *mut AnyObject| {
            let _ = tx.send(ok.as_bool());
        });
        // LAPolicyDeviceOwnerAuthentication
        let policy: isize = 2;
        let _: () = unsafe { msg_send![&context, evaluatePolicy: policy, localizedReason: &*NSString::from_str(reason), reply: &*done] };
        if rx.recv().unwrap_or(false) { Ok(()) } else { Err(cancelled()) }
    }

    /// Which of the site's passkeys to sign in with.
    fn pick(app: &AppHandle, rp: &str, found: &[&Passkey]) -> Result<usize, Fail> {
        let names: Vec<String> = found.iter().map(|p| label(p).to_string()).collect();
        let title = format!("{rp}에 로그인할 계정을 골라 주세요");
        let (tx, rx) = mpsc::channel();
        app.run_on_main_thread(move || {
            let Some(mtm) = MainThreadMarker::new() else { return };
            let alert = NSAlert::new(mtm);
            alert.setMessageText(&NSString::from_str(&title));
            alert.setInformativeText(ns_string!("Ondra에 저장된 패스키예요."));
            for n in &names {
                alert.addButtonWithTitle(&NSString::from_str(n));
            }
            alert.addButtonWithTitle(ns_string!("취소"));
            // NSAlertFirstButtonReturn
            let _ = tx.send((alert.runModal() - 1000) as usize);
        })
        .map_err(|_| cancelled())?;
        rx.recv().ok().filter(|i| *i < found.len()).ok_or_else(cancelled)
    }
}

#[cfg(target_os = "macos")]
pub use native::attach;

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{ECDSA_P256_SHA256_ASN1, UnparsedPublicKey};

    fn origin(host: &str) -> Origin {
        Origin { scheme: "https".into(), host: host.into(), port: 0 }
    }

    fn create_req(exclude: Vec<String>, algs: Vec<i64>) -> Request {
        Request::Create {
            rp_id: None,
            user_id: URL_SAFE_NO_PAD.encode(b"user-1"),
            user_name: "kim".into(),
            display_name: "Kim".into(),
            challenge: URL_SAFE_NO_PAD.encode(b"challenge-1"),
            algs,
            exclude,
        }
    }

    #[test]
    fn rp_id_is_the_host_or_a_parent_on_https() {
        assert_eq!(rp_id(&origin("login.example.com"), None).unwrap(), "login.example.com");
        assert_eq!(rp_id(&origin("login.example.com"), Some("example.com")).unwrap(), "example.com");
        assert_eq!(rp_id(&origin("login.example.com"), Some("Example.COM")).unwrap(), "example.com");
        assert_eq!(rp_id(&origin("example.com"), Some("other.com")).unwrap_err().0, "SecurityError");
        assert_eq!(rp_id(&origin("badexample.com"), Some("example.com")).unwrap_err().0, "SecurityError");
        assert_eq!(rp_id(&origin("example.com"), Some("com")).unwrap_err().0, "SecurityError");
        let http = Origin { scheme: "http".into(), host: "example.com".into(), port: 0 };
        assert_eq!(rp_id(&http, None).unwrap_err().0, "SecurityError");
        let local = Origin { scheme: "http".into(), host: "localhost".into(), port: 3000 };
        assert_eq!(rp_id(&local, None).unwrap(), "localhost");
        assert_eq!(local.serialized(), "http://localhost:3000");
    }

    #[test]
    fn create_then_sign_in_verifies_with_the_attested_key() {
        let o = origin("webauthn.io");
        let req = create_req(vec![], vec![-8, -7]);
        let rp = check_create(&req, &o, &[]).unwrap();
        let (passkey, reply) = create(&req, &o, &rp).unwrap();
        let reply: Value = serde_json::from_str(&reply).unwrap();
        let client: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(reply["clientDataJSON"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(client, json!({ "type": "webauthn.create", "challenge": URL_SAFE_NO_PAD.encode(b"challenge-1"), "origin": "https://webauthn.io", "crossOrigin": false }));

        // attestationObject: {fmt: "none", attStmt: {}, authData}
        let att = URL_SAFE_NO_PAD.decode(reply["attestationObject"].as_str().unwrap()).unwrap();
        let data = URL_SAFE_NO_PAD.decode(reply["authenticatorData"].as_str().unwrap()).unwrap();
        let head = [&[0xa3, 0x63][..], b"fmt", &[0x64], b"none", &[0x67], b"attStmt", &[0xa0, 0x68], b"authData", &[0x58, data.len() as u8]].concat();
        assert_eq!(&att[..head.len()], head.as_slice());
        assert_eq!(&att[head.len()..], data.as_slice());

        // authData: rpIdHash | UP UV AT | count 0 | AAGUID | id | COSE key
        assert_eq!(&data[..32], sha256(b"webauthn.io"));
        assert_eq!(data[32], 0x45);
        assert_eq!(&data[33..37], [0, 0, 0, 0]);
        assert_eq!(&data[37..53], [0u8; 16]);
        let id = URL_SAFE_NO_PAD.decode(&passkey.id).unwrap();
        assert_eq!(&data[53..55], (id.len() as u16).to_be_bytes());
        assert_eq!(&data[55..55 + id.len()], id.as_slice());
        let cose = &data[55 + id.len()..];
        assert_eq!(&cose[..10], [0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]);
        let public = [&[4u8][..], &cose[10..42], &cose[45..77]].concat();
        assert_eq!(&cose[42..45], [0x22, 0x58, 0x20]);
        let spki_der = URL_SAFE_NO_PAD.decode(reply["publicKey"].as_str().unwrap()).unwrap();
        assert_eq!(&spki_der[26..], public.as_slice());

        let get = Request::Get { rp_id: Some("webauthn.io".into()), challenge: URL_SAFE_NO_PAD.encode(b"challenge-2"), allow: vec![] };
        let kept = vec![passkey.clone()];
        let (_, found) = candidates(&get, &o, &kept).unwrap();
        let answer: Value = serde_json::from_str(&assert(&get, &o, found[0]).unwrap()).unwrap();
        let client = URL_SAFE_NO_PAD.decode(answer["clientDataJSON"].as_str().unwrap()).unwrap();
        let data = URL_SAFE_NO_PAD.decode(answer["authenticatorData"].as_str().unwrap()).unwrap();
        assert_eq!(data.len(), 37);
        assert_eq!(data[32], 0x05);
        let sig = URL_SAFE_NO_PAD.decode(answer["signature"].as_str().unwrap()).unwrap();
        let signed = [data.as_slice(), &sha256(&client)].concat();
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, &public).verify(&signed, &sig).expect("signature verifies");
        assert_eq!(answer["userHandle"], json!(URL_SAFE_NO_PAD.encode(b"user-1")));
    }

    #[test]
    fn requests_this_cannot_serve_are_refused_before_asking() {
        let o = origin("example.com");
        assert_eq!(check_create(&create_req(vec![], vec![-257]), &o, &[]).unwrap_err().0, "NotSupportedError");
        let (passkey, _) = create(&create_req(vec![], vec![]), &o, "example.com").unwrap();
        let kept = vec![passkey.clone()];
        assert_eq!(check_create(&create_req(vec![passkey.id.clone()], vec![]), &o, &kept).unwrap_err().0, "InvalidStateError");
        let other = Request::Get { rp_id: None, challenge: "AA".into(), allow: vec!["nope".into()] };
        assert_eq!(candidates(&other, &o, &kept).unwrap_err().0, "NotAllowedError");
        let elsewhere = Request::Get { rp_id: None, challenge: "AA".into(), allow: vec![] };
        assert_eq!(candidates(&elsewhere, &origin("other.com"), &kept).unwrap_err().0, "NotAllowedError");
    }
}
