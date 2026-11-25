//! Secrets in the desktop's Secret Service (GNOME Keyring, KWallet) through libsecret's
//! `secret-tool`. A value goes in on stdin and out on stdout, never on a command line; models.json
//! holds only the engine's `!secret-tool lookup …` command for a provider key.
use std::io::Write;
use std::process::{Command, Stdio};

const SECRET_TOOL: &str = "/usr/bin/secret-tool";

fn tool(args: &[&str]) -> Command {
    let mut cmd = Command::new(SECRET_TOOL);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd
}

/// Stores (or replaces) the item named by `service` and `account`.
pub(crate) fn store(service: &str, account: &str, label: &str, value: &str) -> Result<(), String> {
    let mut child = tool(&["store", &format!("--label={label}"), "service", service, "account", account])
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { "secret-tool이 없어요: libsecret-tools를 설치해 주세요".to_string() } else { e.to_string() })?;
    child.stdin.take().ok_or("stdin")?.write_all(value.as_bytes()).map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() && lookup(service, account).as_deref() == Some(value) { Ok(()) } else { Err("키링에 저장하지 못했어요".into()) }
}

pub(crate) fn lookup(service: &str, account: &str) -> Option<String> {
    let out = tool(&["lookup", "service", service, "account", account]).stdout(Stdio::piped()).output().ok()?;
    out.status.success().then(|| String::from_utf8(out.stdout).ok()).flatten()
}

pub(crate) fn clear(service: &str, account: &str) {
    let _ = tool(&["clear", "service", service, "account", account]).status();
}

pub fn secret_set(service: &str, account: &str, value: &str) -> Result<(), String> {
    if !super::safe_name(service) || !super::safe_name(account) {
        return Err("bad keychain name".into());
    }
    store(service, account, "Ondra provider key", value)
}

pub fn secret_exists(service: &str, account: &str) -> bool {
    tool(&["lookup", "service", service, "account", account]).status().is_ok_and(|s| s.success())
}

pub fn secret_get(service: &str, account: &str) -> Option<String> {
    lookup(service, account).filter(|v| !v.is_empty())
}

pub fn secret_delete(service: &str, account: &str) {
    clear(service, account);
}

pub fn secret_ref(service: &str, account: &str) -> Result<String, String> {
    if !super::safe_name(service) || !super::safe_name(account) {
        return Err("bad keychain name".into());
    }
    Ok(format!("!{SECRET_TOOL} lookup service '{service}' account '{account}'"))
}

pub fn ref_account(service: &str, value: &str) -> Option<String> {
    let rest = value.strip_prefix(&format!("!{SECRET_TOOL} lookup service '{service}' account '"))?;
    let acct = rest.strip_suffix('\'')?;
    super::safe_name(acct).then(|| acct.to_string())
}
