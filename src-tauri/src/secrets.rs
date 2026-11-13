//! Secrets: values a job's commands may use but the model never reads.
//!
//! The user enters a name and a value in Settings › 시크릿. The value goes straight into the
//! login keychain (service `ai.ondra.secret`, account = the name); only the names are kept in
//! `<data dir>/secrets.json`. When a job's engine starts, `inject` reads the values here, in the
//! native process, and puts them in that engine's environment, so `$NAME` works in its shell
//! commands. The page never gets a value back. `extensions/secrets.ts` (inside the engine)
//! then takes every value out of what the tools return before the model sees it.

use std::path::PathBuf;
use std::process::Command;
use tauri::AppHandle;

const SERVICE: &str = "ai.ondra.secret";
/// The flag worker_env sets for a job's engine: inject the secrets there.
pub const MARKER: &str = "ONDRA_SECRETS";
/// What the engine is told: the names it holds (comma-separated).
pub const NAMES: &str = "ONDRA_SECRET_NAMES";
const MAX_VALUE: usize = 32 * 1024;

fn names_file(app: &AppHandle) -> PathBuf {
    crate::engine::data_dir(app).join("secrets.json")
}

/// A name a shell can use as a variable and that doesn't shadow what the engine, the shell or
/// Ondra itself needs.
pub fn valid_name(name: &str) -> Result<(), String> {
    let mut chars = name.chars();
    let ok_first = chars.next().is_some_and(|c| c.is_ascii_uppercase() || c == '_');
    if !ok_first || !name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_') || name.len() > 64 {
        return Err("이름은 영어 대문자, 숫자, _ 로 써요 (예: STRIPE_KEY)".into());
    }
    const RESERVED: &[&str] = &["PATH", "HOME", "USER", "SHELL", "TMPDIR", "PWD", "LANG", "TERM", "LOGNAME", "IFS", "PS1", "PS4", "BASH_ENV", "ENV", "ZDOTDIR", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES"];
    if RESERVED.contains(&name) || name.starts_with("ONDRA_") || name.starts_with("PI_") || name.starts_with("DYLD_") || name.starts_with("LD_") {
        return Err(format!("{name}은(는) 앱과 셸이 쓰는 이름이라 시크릿으로 쓸 수 없어요"));
    }
    Ok(())
}

fn read_names(app: &AppHandle) -> Vec<String> {
    std::fs::read_to_string(names_file(app))
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|n| valid_name(n).is_ok())
        .collect()
}

fn write_names(app: &AppHandle, names: &[String]) -> Result<(), String> {
    let path = names_file(app);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(names).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("시크릿 목록을 저장하지 못했어요: {e}"))
}

#[cfg(target_os = "macos")]
mod store {
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    pub fn set(name: &str, value: &str) -> Result<(), String> {
        set_generic_password(super::SERVICE, name, value.as_bytes()).map_err(|e| format!("키체인에 저장하지 못했어요: {e}"))
    }
    pub fn get(name: &str) -> Option<String> {
        get_generic_password(super::SERVICE, name).ok().and_then(|b| String::from_utf8(b).ok())
    }
    pub fn delete(name: &str) {
        let _ = delete_generic_password(super::SERVICE, name);
    }
}

#[cfg(not(target_os = "macos"))]
mod store {
    pub fn set(_: &str, _: &str) -> Result<(), String> {
        Err("시크릿은 macOS에서만 쓸 수 있어요".into())
    }
    pub fn get(_: &str) -> Option<String> {
        None
    }
    pub fn delete(_: &str) {}
}

/// The names the user saved (never the values).
#[tauri::command]
pub fn secret_list(app: AppHandle) -> Vec<String> {
    read_names(&app)
}

/// Saves (or replaces) one secret. The value goes to the keychain and nowhere else.
#[tauri::command]
pub fn secret_set(app: AppHandle, name: String, value: String) -> Result<Vec<String>, String> {
    let name = name.trim().to_string();
    valid_name(&name)?;
    if value.is_empty() {
        return Err("값이 비어 있어요".into());
    }
    if value.len() > MAX_VALUE {
        return Err("값이 너무 길어요 (32KB까지)".into());
    }
    store::set(&name, &value)?;
    let mut names = read_names(&app);
    if !names.contains(&name) {
        names.push(name);
        names.sort();
    }
    write_names(&app, &names)?;
    Ok(names)
}

#[tauri::command]
pub fn secret_delete(app: AppHandle, name: String) -> Result<Vec<String>, String> {
    store::delete(&name);
    let names: Vec<String> = read_names(&app).into_iter().filter(|n| n != &name).collect();
    write_names(&app, &names)?;
    Ok(names)
}

/// For a job's engine (the env carries MARKER): drops the marker and adds each saved secret
/// the keychain still has, plus the list of their names. Without the marker nothing changes.
pub fn inject(app: &AppHandle, cmd: &mut Command, env: &[(String, String)]) {
    if !env.iter().any(|(k, v)| k == MARKER && v == "1") {
        return;
    }
    let mut held = Vec::new();
    for name in read_names(app) {
        // a space's own env (set by the user for that space) wins over a secret of the same name
        if env.iter().any(|(k, _)| k == &name) {
            continue;
        }
        if let Some(value) = store::get(&name) {
            cmd.env(&name, value);
            held.push(name);
        }
    }
    cmd.env(NAMES, held.join(","));
}

#[cfg(test)]
mod tests {
    use super::valid_name;

    #[test]
    fn names() {
        assert!(valid_name("STRIPE_KEY").is_ok());
        assert!(valid_name("_X1").is_ok());
        for bad in ["", "stripe", "1KEY", "A-B", "PATH", "ONDRA_TOKEN", "PI_X", "DYLD_X", "NODE_OPTIONS", "A B"] {
            assert!(valid_name(bad).is_err(), "{bad}");
        }
    }
}
