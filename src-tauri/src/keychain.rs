//! A credential provider for agent-browser's `auth login --credential-provider
//! keychain`, so a job can sign in without ever seeing the password.
//!
//! agent-browser runs this binary as a plugin (`ondra --keychain-credential`)
//! over the `agent-browser.plugin.v1` stdio protocol: one JSON request on
//! stdin, one JSON reply on stdout. The password goes macOS keychain →
//! this process → agent-browser (memory) → the page's password field. It is
//! never printed anywhere else, logged, or written to disk, and agent-browser
//! itself keeps plugin credentials out of its output.
//!
//! Lookup: the login keychain (the user's default search list) by the host
//! of the login URL, then by its parent domains (`accounts.example.com` →
//! `example.com`); internet passwords first, then generic passwords whose
//! service is that host. `--item <account>` picks one account when a site has
//! several. Reading the secret goes through `/usr/bin/security`, so macOS asks
//! the user to allow it; nothing here can skip that prompt.

use std::io::{Read, Write};
use std::process::{Command, Stdio};

pub const FLAG: &str = "--keychain-credential";
const PROTOCOL: &str = "agent-browser.plugin.v1";
const SECURITY: &str = "/usr/bin/security";

/// Entry point for plugin mode. `args` are what follows the flag: an optional
/// keychain file to search instead of the default list (used by tests).
pub fn plugin_main(args: &[String]) -> i32 {
    // Only the bundled agent-browser gets an answer: run by hand (or by an
    // agent's shell) this would print the secret.
    if !called_by_agent_browser() {
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

#[cfg(not(target_os = "macos"))]
fn exe_of(_pid: u32) -> Option<std::path::PathBuf> {
    None
}

/// The parent process is the agent-browser that ships next to this binary.
fn called_by_agent_browser() -> bool {
    let Some(parent) = exe_of(std::os::unix::process::parent_id()).and_then(|p| p.canonicalize().ok()) else { return false };
    let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(|d| d.to_path_buf())) else { return false };
    let bundled = ["agent-browser", "agent-browser-aarch64-apple-darwin", "agent-browser-x86_64-apple-darwin"];
    bundled.iter().any(|name| dir.join(name).canonicalize().is_ok_and(|p| p == parent))
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

    #[test]
    fn blobs() {
        assert_eq!(parse_blob("\"me@x.com\"").as_deref(), Some("me@x.com"));
        assert_eq!(parse_blob("0x6E616D65  \"name\"").as_deref(), Some("name"));
        assert_eq!(parse_blob("<NULL>"), None);
    }
}
