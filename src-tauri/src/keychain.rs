//! The credential helper for ondra-browser's `auth login --credential-provider
//! keychain`, so a job can sign in without ever seeing the password.
//!
//! ondra-browser runs this binary as its helper (`ondra --keychain-credential`)
//! over the `ondra.keychain.v1` stdio protocol: one JSON request on stdin,
//! one JSON reply on stdout. The password goes from the system's password store
//! (the macOS keychain, Windows Credential Manager, the Secret Service on Linux) → this process →
//! ondra-browser (memory) → the page's password field. It is never printed
//! anywhere else, logged, or written to disk, and ondra-browser keeps it out
//! of every output.
//!
//! Lookup: the login keychain (the user's default search list) by the host
//! of the login URL, then by its parent domains (`accounts.example.com` →
//! `example.com`); internet passwords first, then generic passwords whose
//! service is that host. `--item <account>` picks one account when a site has
//! several. Reading the secret goes through `/usr/bin/security`, so macOS asks
//! the user to allow it; nothing here can skip that prompt.
//!
//! Windows: a generic credential whose target is the host or a parent domain
//! (`cmdkey /generic:example.com /user:me /pass`). Linux: a Secret Service item
//! with `server` set to the host and the account in `user`
//! (`secret-tool store --label=example.com server example.com user me`).

use std::io::{Read, Write};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

pub const FLAG: &str = "--keychain-credential";
const PROTOCOL: &str = "ondra.keychain.v1";
#[cfg(target_os = "macos")]
const SECURITY: &str = "/usr/bin/security";

/// Entry point for plugin mode. `args` are what follows the flag: an optional
/// keychain file to search instead of the default list (used by tests).
pub fn plugin_main(args: &[String]) -> i32 {
    // Only the bundled ondra-browser gets an answer: run by hand (or by an
    // agent's shell) this would print the secret.
    if !called_by_browser() {
        return reply_error("not allowed");
    }
    let keychain = args.first().filter(|a| !a.is_empty()).cloned();
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return reply_error("no request");
    }
    let Ok(req) = serde_json::from_str::<serde_json::Value>(&input) else { return reply_error("bad request") };
    if req.get("type").and_then(|t| t.as_str()) != Some("credential.resolve") {
        return reply_error("unsupported request");
    }
    let r = req.get("request").cloned().unwrap_or_default();
    let url = r.get("url").and_then(|v| v.as_str()).unwrap_or_default();
    let item = r.get("itemRef").and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty());
    let Some(host) = host_of(url).or_else(|| item.and_then(host_of)) else { return reply_error("no host") };
    // `--item` is the account; a URL there only names the site
    let account = item.filter(|i| host_of(i).is_none() || !i.contains("://"));
    match resolve(&host, account, keychain.as_deref()) {
        Some((username, password)) => {
            let out = serde_json::json!({
                "protocol": PROTOCOL,
                "success": true,
                "credential": { "username": username, "password": password },
            });
            let mut stdout = std::io::stdout();
            let ok = serde_json::to_writer(&mut stdout, &out).is_ok() && stdout.write_all(b"\n").is_ok();
            if ok { 0 } else { 1 }
        }
        None => reply_error("not found"),
    }
}

#[cfg(target_os = "macos")]
fn exe_of(pid: u32) -> Option<std::path::PathBuf> {
    unsafe extern "C" {
        fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, size: u32) -> i32;
    }
    let mut buf = vec![0u8; 4096];
    let n = unsafe { proc_pidpath(pid as i32, buf.as_mut_ptr().cast(), buf.len() as u32) };
    if n <= 0 {
        return None;
    }
    buf.truncate(n as usize);
    String::from_utf8(buf).ok().map(std::path::PathBuf::from)
}

#[cfg(target_os = "linux")]
fn exe_of(pid: u32) -> Option<std::path::PathBuf> {
    std::fs::read_link(format!("/proc/{pid}/exe")).ok()
}

#[cfg(windows)]
fn exe_of(pid: u32) -> Option<std::path::PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW};
    // SAFETY: a handle we open and close here; the buffer outlives the call.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return None;
        }
        let mut buf = vec![0u16; 1024];
        let mut n = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut n) != 0;
        CloseHandle(h);
        ok.then(|| std::ffi::OsString::from_wide(&buf[..n as usize]).into())
    }
}

#[cfg(unix)]
fn parent_pid() -> Option<u32> {
    Some(std::os::unix::process::parent_id())
}

#[cfg(windows)]
fn parent_pid() -> Option<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
    let me = std::process::id();
    // SAFETY: a snapshot handle we own, walked with a correctly sized entry.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return None;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = None;
        let mut more = Process32FirstW(snap, &mut e) != 0;
        while more {
            if e.th32ProcessID == me {
                found = Some(e.th32ParentProcessID);
                break;
            }
            more = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
        found
    }
}

/// The parent process is the ondra-browser that ships next to this binary.
fn called_by_browser() -> bool {
    let Some(parent) = parent_pid().and_then(exe_of).and_then(|p| p.canonicalize().ok()) else { return false };
    let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.to_path_buf())) else { return false };
    let suffix = std::env::consts::EXE_SUFFIX;
    let triples = ["", "-aarch64-apple-darwin", "-x86_64-apple-darwin", "-x86_64-pc-windows-msvc", "-aarch64-pc-windows-msvc", "-x86_64-unknown-linux-gnu", "-aarch64-unknown-linux-gnu"];
    triples.iter().any(|t| dir.join(format!("ondra-browser{t}{suffix}")).canonicalize().is_ok_and(|p| p == parent))
}

fn reply_error(message: &str) -> i32 {
    println!("{}", serde_json::json!({ "protocol": PROTOCOL, "success": false, "error": message }));
    1
}

/// `https://user@accounts.example.com:8443/login?x` → `accounts.example.com`.
fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if authority.starts_with('[') {
        authority.split(']').next()?.trim_start_matches('[')
    } else {
        authority.split(':').next()?
    };
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    (host.contains('.') || host == "localhost").then_some(host).filter(|h| !h.contains(' '))
}

/// The host, then each parent domain with at least two labels.
fn candidates(host: &str) -> Vec<String> {
    let mut out = vec![host.to_string()];
    if host.parse::<std::net::IpAddr>().is_ok() {
        return out;
    }
    let labels: Vec<&str> = host.split('.').collect();
    for i in 1..labels.len().saturating_sub(1) {
        out.push(labels[i..].join("."));
    }
    out
}

#[cfg(windows)]
fn resolve(host: &str, account: Option<&str>, _keychain: Option<&str>) -> Option<(String, String)> {
    candidates(host).iter().find_map(|h| windows_credential(h, account))
}

/// A generic credential named `target`: (user name, password).
#[cfg(windows)]
fn windows_credential(target: &str, account: Option<&str>) -> Option<(String, String)> {
    use windows_sys::Win32::Security::Credentials::{CRED_TYPE_GENERIC, CREDENTIALW, CredFree, CredReadW};
    let wide: Vec<u16> = target.encode_utf16().chain(std::iter::once(0)).collect();
    let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
    // SAFETY: CredReadW fills `cred` on success; it is read here and freed with CredFree.
    unsafe {
        if CredReadW(wide.as_ptr(), CRED_TYPE_GENERIC, 0, &mut cred) == 0 || cred.is_null() {
            return None;
        }
        let c = &*cred;
        let user = if c.UserName.is_null() {
            String::new()
        } else {
            let mut n = 0;
            while *c.UserName.add(n) != 0 {
                n += 1;
            }
            String::from_utf16_lossy(std::slice::from_raw_parts(c.UserName, n))
        };
        let blob = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
        // cmdkey and the Credential Manager store UTF-16; other tools may store UTF-8
        let utf16: Vec<u16> = blob.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
        let password = if blob.len() % 2 == 0 && !blob.is_empty() && String::from_utf16(&utf16).is_ok_and(|s| !s.contains('\0')) {
            String::from_utf16_lossy(&utf16)
        } else {
            String::from_utf8_lossy(blob).into_owned()
        };
        CredFree(cred.cast());
        let wanted = account.is_none_or(|a| a.eq_ignore_ascii_case(&user));
        (wanted && !password.is_empty()).then_some((user, password))
    }
}

#[cfg(target_os = "linux")]
fn resolve(host: &str, account: Option<&str>, _keychain: Option<&str>) -> Option<(String, String)> {
    candidates(host).iter().find_map(|h| {
        let mut attrs = vec![("server", h.as_str())];
        if let Some(a) = account {
            attrs.push(("user", a));
        }
        crate::providers::linux_keys::search(&attrs).into_iter().find_map(|(found, secret)| {
            let user = ["user", "username", "account"].iter().find_map(|k| found.get(*k).cloned()).unwrap_or_default();
            (!secret.is_empty()).then_some((user, secret))
        })
    })
}

#[cfg(target_os = "macos")]
fn resolve(host: &str, account: Option<&str>, keychain: Option<&str>) -> Option<(String, String)> {
    for h in candidates(host) {
        for kind in ["find-internet-password", "find-generic-password"] {
            let Some(acct) = find_account(kind, &h, account, keychain) else { continue };
            if let Some(pw) = read_secret(kind, &h, &acct, keychain) {
                return Some((acct, pw));
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
/// The account of the first matching item. Reading attributes needs no approval
/// and prints no secret.
fn find_account(kind: &str, host: &str, account: Option<&str>, keychain: Option<&str>) -> Option<String> {
    let mut cmd = Command::new(SECURITY);
    cmd.arg(kind).arg("-s").arg(host);
    if let Some(a) = account {
        cmd.arg("-a").arg(a);
    }
    if let Some(k) = keychain {
        cmd.arg(k);
    }
    let out = cmd.stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let found = text.lines().find_map(|l| l.trim().strip_prefix("\"acct\"<blob>=").map(parse_blob));
    match (found.flatten(), account) {
        (Some(a), _) => Some(a),
        (None, Some(a)) => Some(a.to_string()),
        (None, None) => Some(String::new()),
    }
}

#[cfg(target_os = "macos")]
/// `"name"`, `0x6E616D65  "name"` or `<NULL>` as printed by `security`.
fn parse_blob(v: &str) -> Option<String> {
    let v = v.trim();
    if let Some(hex) = v.strip_prefix("0x") {
        let hex: String = hex.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
        let bytes: Option<Vec<u8>> = (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()).collect();
        return bytes.and_then(|b| String::from_utf8(b).ok());
    }
    let inner = v.strip_prefix('"')?.strip_suffix('"')?;
    Some(inner.to_string())
}

#[cfg(target_os = "macos")]
/// The secret itself; this is the call macOS asks the user about.
fn read_secret(kind: &str, host: &str, account: &str, keychain: Option<&str>) -> Option<String> {
    let mut cmd = Command::new(SECURITY);
    cmd.arg(kind).arg("-s").arg(host);
    if !account.is_empty() {
        cmd.arg("-a").arg(account);
    }
    cmd.arg("-w");
    if let Some(k) = keychain {
        cmd.arg(k);
    }
    let out = cmd.stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let mut pw = String::from_utf8(out.stdout).ok()?;
    if pw.ends_with('\n') {
        pw.pop();
    }
    (!pw.is_empty()).then_some(pw)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts() {
        assert_eq!(host_of("https://User@Accounts.Example.com:8443/a?b").as_deref(), Some("accounts.example.com"));
        assert_eq!(host_of("example.com/login").as_deref(), Some("example.com"));
        assert_eq!(host_of("http://127.0.0.1:18731/x").as_deref(), Some("127.0.0.1"));
        assert_eq!(host_of("me@example.com").as_deref(), Some("example.com"));
        assert_eq!(host_of("alice"), None);
        assert_eq!(candidates("a.b.example.com"), vec!["a.b.example.com", "b.example.com", "example.com"]);
        assert_eq!(candidates("127.0.0.1"), vec!["127.0.0.1"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn blobs() {
        assert_eq!(parse_blob("\"me@x.com\"").as_deref(), Some("me@x.com"));
        assert_eq!(parse_blob("0x6E616D65  \"name\"").as_deref(), Some("name"));
        assert_eq!(parse_blob("<NULL>"), None);
    }
}
