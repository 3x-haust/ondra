//! Per-provider DPAPI items. models.json contains only an engine `!command` reference.
//! Windows PowerShell's ProtectedData and the native writer both use CurrentUser scope
//! and the same public purpose string. No key is passed on a command line or inherited by jobs.
use crate::winvault;
use sha2::{Digest, Sha256};
use std::{io, path::PathBuf};

fn purpose(service: &str, account: &str) -> String {
    format!("{service}/{account}")
}
fn name(purpose: &str) -> String {
    format!("provider-{:x}.dpapi", Sha256::digest(purpose.as_bytes()))
}
fn path(service: &str, account: &str) -> io::Result<PathBuf> {
    if !super::safe_name(service) || !super::safe_name(account) {
        return Err(io::Error::other("bad credential name"));
    }
    winvault::file(&name(&purpose(service, account)))
}

pub fn secret_set(service: &str, account: &str, value: &str) -> Result<(), String> {
    path(service, account)
        .and_then(|p| {
            winvault::write_bound(&p, value.as_bytes(), purpose(service, account).as_bytes())
        })
        .map_err(|e| e.to_string())
}
pub fn secret_get(service: &str, account: &str) -> Option<String> {
    String::from_utf8(
        winvault::read_bound(
            &path(service, account).ok()?,
            purpose(service, account).as_bytes(),
        )
        .ok()?,
    )
    .ok()
}
pub fn secret_exists(service: &str, account: &str) -> bool {
    path(service, account).is_ok_and(|p| p.is_file())
}
pub fn secret_delete(service: &str, account: &str) {
    if let Ok(p) = path(service, account) {
        let _ = std::fs::remove_file(p);
    }
}

fn powershell() -> Result<String, String> {
    use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
    let mut buf = [0u16; 260];
    // Ask Windows, not the engine's PATH or current directory (the project's files).
    let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if n == 0 || n >= buf.len() {
        return Err("Windows 시스템 폴더를 찾을 수 없어요".into());
    }
    let dir = String::from_utf16(&buf[..n])
        .map_err(|e| e.to_string())?
        .replace('\\', "/");
    if dir.contains(['"', '%', '$', '`', '!']) {
        return Err("Windows 시스템 폴더 이름을 셸에서 쓸 수 없어요".into());
    }
    Ok(format!("\"{dir}/WindowsPowerShell/v1.0/powershell.exe\""))
}

pub fn secret_ref(service: &str, account: &str) -> Result<String, String> {
    if !super::safe_name(service) || !super::safe_name(account) {
        return Err("bad credential name".into());
    }
    let exe = powershell()?;
    let purpose = purpose(service, account);
    let file = name(&purpose);
    let folder = winvault::FOLDER;
    // No shell expansions ($, %, backticks) in the command: the engine can use cmd or Git Bash.
    // UTF-8 to the pipe regardless of the active Windows code page, without a newline or BOM.
    Ok(format!(
        r#"!{exe} -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Security; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(0); [Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes([IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'),'{folder}','{file}')),[Text.Encoding]::UTF8.GetBytes('{purpose}'),'CurrentUser')))""#
    ))
}

pub fn ref_account(service: &str, value: &str) -> Option<String> {
    let rest = value.split_once(&format!("UTF8.GetBytes('{service}/"))?.1;
    let (acct, _) = rest.split_once('\'')?;
    (super::safe_name(service)
        && super::safe_name(acct)
        && value == secret_ref(service, acct).ok()?)
    .then(|| acct.into())
}
