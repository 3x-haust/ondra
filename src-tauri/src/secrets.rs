//! Secrets: values a job's commands may use but the model never reads.
//!
//! The user enters a name and a value in Settings › 시크릿, for every job (global) or for one
//! project. The value goes straight into the login keychain (service `ai.ondra.secret`, account
//! `NAME` or `<project id>/NAME`); only the names are kept in `<data dir>/secrets.json`. A
//! project's secret can also be written into that project's `.env` (KEY=value), so the app runs
//! the same outside Ondra; it is never written there while `.env` isn't ignored by git, unless
//! the user lets Ondra add it to `.gitignore` first.
//!
//! When a job's engine starts, `inject` reads the values here, in the native process, and puts
//! the global ones and its project's (which win) in that engine's environment, so `$NAME` works
//! in its commands. The page never gets a value back. `extensions/secrets.ts` (inside the
//! engine) takes every value out of what the tools return before the model sees it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

const SERVICE: &str = "ai.ondra.secret";
/// Set on a job's engine env: "1" (global secrets) or "p:<project id>" (global and that project's).
pub const MARKER: &str = "ONDRA_SECRETS";
/// What the engine is told: the names it holds (comma-separated).
pub const NAMES: &str = "ONDRA_SECRET_NAMES";
const MAX_VALUE: usize = 32 * 1024;
/// The error the page answers with a question: `.env` would be committed.
pub const NOT_IGNORED: &str = "ENV_NOT_IGNORED";

#[derive(Default, Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Saved {
    #[serde(default)]
    pub global: Vec<String>,
    #[serde(default)]
    pub projects: BTreeMap<String, Vec<String>>,
}

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

fn valid_project(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Reads secrets.json; the first version kept a plain list of global names.
fn parse(text: &str) -> Saved {
    let mut s = serde_json::from_str::<Saved>(text)
        .or_else(|_| serde_json::from_str::<Vec<String>>(text).map(|global| Saved { global, ..Default::default() }))
        .unwrap_or_default();
    s.global.retain(|n| valid_name(n).is_ok());
    s.projects.retain(|id, names| {
        names.retain(|n| valid_name(n).is_ok());
        valid_project(id) && !names.is_empty()
    });
    s
}

fn read_saved(app: &AppHandle) -> Saved {
    std::fs::read_to_string(names_file(app)).map(|t| parse(&t)).unwrap_or_default()
}

fn write_saved(app: &AppHandle, saved: &Saved) -> Result<(), String> {
    let path = names_file(app);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(saved).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("시크릿 목록을 저장하지 못했어요: {e}"))
}

fn account(project: Option<&str>, name: &str) -> String {
    match project {
        Some(p) => format!("{p}/{name}"),
        None => name.to_string(),
    }
}

#[cfg(target_os = "macos")]
mod store {
    use security_framework::passwords::{delete_generic_password, get_generic_password, set_generic_password};

    pub fn set(account: &str, value: &str) -> Result<(), String> {
        set_generic_password(super::SERVICE, account, value.as_bytes()).map_err(|e| format!("키체인에 저장하지 못했어요: {e}"))
    }
    pub fn get(account: &str) -> Option<String> {
        get_generic_password(super::SERVICE, account).ok().and_then(|b| String::from_utf8(b).ok())
    }
    pub fn delete(account: &str) {
        let _ = delete_generic_password(super::SERVICE, account);
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

// ───────────────── .env

/// How a value is written in .env: bare when it is plain, else in double quotes.
pub fn dotenv_value(value: &str) -> String {
    if !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || "_-./:@+=,%~".contains(c)) {
        return value.to_string();
    }
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '$' => out.push_str("\\$"),
            '`' => out.push_str("\\`"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The value a .env line holds for `name`, as dotenv tools read it (enough to compare).
fn line_value(line: &str, name: &str) -> Option<String> {
    let t = line.trim_start();
    let t = t.strip_prefix("export ").map(str::trim_start).unwrap_or(t);
    let rest = t.strip_prefix(name)?.trim_start().strip_prefix('=')?.trim();
    if let Some(q) = rest.strip_prefix('"').and_then(|r| r.strip_suffix('"')) {
        return Some(q.replace("\\n", "\n").replace("\\\"", "\"").replace("\\$", "$").replace("\\`", "`").replace("\\\\", "\\"));
    }
    if let Some(q) = rest.strip_prefix('\'').and_then(|r| r.strip_suffix('\'')) {
        return Some(q.to_string());
    }
    Some(rest.split(" #").next().unwrap_or("").trim().to_string())
}

/// `text` with `name` set to `value`: its line replaced where it is, else added at the end.
pub fn dotenv_set(text: &str, name: &str, value: &str) -> String {
    let line = format!("{name}={}", dotenv_value(value));
    let mut found = false;
    let mut out: Vec<String> = text
        .lines()
        .map(|l| {
            if !found && line_value(l, name).is_some() {
                found = true;
                line.clone()
            } else {
                l.to_string()
            }
        })
        .collect();
    if !found {
        out.push(line);
    }
    let mut s = out.join("\n");
    s.push('\n');
    s
}

/// `text` without `name`'s line, when that line still holds `value` (a line the user changed by
/// hand since is theirs and stays).
pub fn dotenv_remove(text: &str, name: &str, value: &str) -> Option<String> {
    let mut removed = false;
    let kept: Vec<&str> = text
        .lines()
        .filter(|l| {
            let mine = !removed && line_value(l, name).as_deref() == Some(value);
            removed |= mine;
            !mine
        })
        .collect();
    removed.then(|| if kept.is_empty() { String::new() } else { format!("{}\n", kept.join("\n")) })
}

/// Whether git would commit `.env` in `folder`: inside a repo and not ignored.
fn env_would_be_committed(folder: &Path) -> bool {
    let git = |args: &[&str]| Command::new("git").arg("-C").arg(folder).args(args).output();
    let in_repo = git(&["rev-parse", "--is-inside-work-tree"]).map(|o| o.status.success()).unwrap_or(false);
    // check-ignore exits 0 when the path is ignored
    in_repo && !git(&["check-ignore", "-q", ".env"]).map(|o| o.status.success()).unwrap_or(false)
}

fn add_to_gitignore(folder: &Path) -> Result<(), String> {
    let path = folder.join(".gitignore");
    let mut text = std::fs::read_to_string(&path).unwrap_or_default();
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(".env\n");
    std::fs::write(&path, text).map_err(|e| format!(".gitignore를 고치지 못했어요: {e}"))
}

fn write_env(folder: &Path, name: &str, value: &str, add_ignore: bool) -> Result<(), String> {
    if !folder.is_dir() {
        return Err("프로젝트 폴더를 찾지 못했어요".into());
    }
    if env_would_be_committed(folder) {
        if !add_ignore {
            return Err(format!("{NOT_IGNORED}: .env가 .gitignore에 없어서 커밋될 수 있어요"));
        }
        add_to_gitignore(folder)?;
    }
    let path = folder.join(".env");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    std::fs::write(&path, dotenv_set(&text, name, value)).map_err(|e| format!(".env에 쓰지 못했어요: {e}"))
}

// ───────────────── finding what a project already has

/// The project's own .env files, `.env` first so the more specific ones (.env.local, …) win.
fn env_files(folder: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(folder)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file())
        .filter(|p| {
            let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            (n == ".env" || n.starts_with(".env.")) && !["example", "sample", "template", "dist", "defaults"].iter().any(|x| n.ends_with(x))
        })
        .collect();
    files.sort_by_key(|p| (p.file_name().map(|n| n != ".env").unwrap_or(true), p.clone()));
    files
}

/// KEY=value pairs of a .env text, in order.
pub fn dotenv_pairs(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|l| {
            let t = l.trim_start();
            if t.starts_with('#') {
                return None;
            }
            let t = t.strip_prefix("export ").map(str::trim_start).unwrap_or(t);
            let key = t.split('=').next()?.trim();
            let ok = !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-') && t.contains('=');
            if !ok {
                return None;
            }
            line_value(l, key).map(|v| (key.to_string(), v))
        })
        .collect()
}

/// Whether a key (or its value) looks like it holds a secret.
pub fn looks_secret(key: &str, value: &str) -> bool {
    let k = key.to_ascii_uppercase();
    let words = ["KEY", "SECRET", "TOKEN", "PASSW", "PWD", "PRIVATE", "AUTH", "CREDENTIAL", "SESSION", "COOKIE", "DSN", "SIGNING", "WEBHOOK"];
    // a connection string with a password in it (postgres://user:pass@host)
    let url_with_password = value.contains("://") && value.split("://").nth(1).is_some_and(|r| r.split('/').next().is_some_and(|h| h.contains(':') && h.contains('@')));
    words.iter().any(|w| k.contains(w)) || url_with_password
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub name: String,
    /// the file its value comes from (the last one that sets it)
    pub file: String,
    /// looks like a key, token or password
    pub secret: bool,
    /// can be saved under this name (uppercase, not reserved)
    pub valid: bool,
}

/// Each key the project's .env files set, with its last value (never sent to the page).
fn found_in(folder: &Path) -> BTreeMap<String, (String, String)> {
    let mut out = BTreeMap::new();
    for path in env_files(folder) {
        let file = path.file_name().and_then(|n| n.to_str()).unwrap_or(".env").to_string();
        if let Ok(text) = std::fs::read_to_string(&path) {
            for (k, v) in dotenv_pairs(&text) {
                out.insert(k, (file.clone(), v));
            }
        }
    }
    out
}

/// What the project's .env files hold: names, where from, whether they look secret. No values.
#[tauri::command]
pub fn secret_scan(folder: String) -> Vec<Found> {
    found_in(Path::new(&folder))
        .into_iter()
        .filter(|(_, (_, v))| !v.is_empty())
        .map(|(name, (file, v))| Found { secret: looks_secret(&name, &v), valid: valid_name(&name).is_ok(), name, file })
        .collect()
}

/// Copies the chosen keys from the project's .env files into the keychain as that project's
/// secrets (.env itself stays as it is). Returns the saved lists and how many were taken.
#[tauri::command]
pub fn secret_import(app: AppHandle, project: String, folder: String, names: Vec<String>) -> Result<Saved, String> {
    if !valid_project(&project) {
        return Err("프로젝트를 알 수 없어요".into());
    }
    let found = found_in(Path::new(&folder));
    let mut saved = read_saved(&app);
    let list = saved.projects.entry(project.clone()).or_default();
    for name in names {
        let Some((_, value)) = found.get(&name).filter(|(_, v)| !v.is_empty() && v.len() <= MAX_VALUE) else { continue };
        if valid_name(&name).is_err() {
            continue;
        }
        store::set(&account(Some(&project), &name), value)?;
        if !list.contains(&name) {
            list.push(name);
        }
    }
    list.sort();
    saved.projects.retain(|_, l| !l.is_empty());
    write_saved(&app, &saved)?;
    Ok(saved)
}

// ───────────────── commands

/// The saved names (never the values): global, and per project id.
#[tauri::command]
pub fn secret_list(app: AppHandle) -> Saved {
    read_saved(&app)
}

/// Saves (or replaces) one secret. The value goes to the keychain and, for a project when asked,
/// its `.env`; nowhere else.
#[tauri::command]
pub fn secret_set(
    app: AppHandle,
    name: String,
    value: String,
    project: Option<String>,
    folder: Option<String>,
    write_dotenv: Option<bool>,
    add_ignore: Option<bool>,
) -> Result<Saved, String> {
    let name = name.trim().to_string();
    valid_name(&name)?;
    let project = project.filter(|p| !p.is_empty());
    if project.as_deref().is_some_and(|p| !valid_project(p)) {
        return Err("프로젝트를 알 수 없어요".into());
    }
    if value.is_empty() {
        return Err("값이 비어 있어요".into());
    }
    if value.len() > MAX_VALUE {
        return Err("값이 너무 길어요 (32KB까지)".into());
    }
    // .env first: when git would commit it, nothing is saved until the user answers
    if project.is_some() && write_dotenv.unwrap_or(false) {
        if let Some(folder) = folder.as_deref().filter(|f| !f.is_empty()) {
            write_env(Path::new(folder), &name, &value, add_ignore.unwrap_or(false))?;
        }
    }
    store::set(&account(project.as_deref(), &name), &value)?;
    let mut saved = read_saved(&app);
    let list = match &project {
        Some(p) => saved.projects.entry(p.clone()).or_default(),
        None => &mut saved.global,
    };
    if !list.contains(&name) {
        list.push(name);
        list.sort();
    }
    write_saved(&app, &saved)?;
    Ok(saved)
}

/// Removes one secret; for a project, also its `.env` line when that line still holds the value.
#[tauri::command]
pub fn secret_delete(app: AppHandle, name: String, project: Option<String>, folder: Option<String>) -> Result<Saved, String> {
    let project = project.filter(|p| !p.is_empty());
    let acct = account(project.as_deref(), &name);
    if let (Some(_), Some(folder)) = (&project, folder.as_deref().filter(|f| !f.is_empty())) {
        let path = Path::new(folder).join(".env");
        if let (Some(value), Ok(text)) = (store::get(&acct), std::fs::read_to_string(&path)) {
            if let Some(next) = dotenv_remove(&text, &name, &value) {
                std::fs::write(&path, next).map_err(|e| format!(".env를 고치지 못했어요: {e}"))?;
            }
        }
    }
    store::delete(&acct);
    let mut saved = read_saved(&app);
    match &project {
        Some(p) => {
            if let Some(list) = saved.projects.get_mut(p) {
                list.retain(|n| n != &name);
            }
            saved.projects.retain(|_, l| !l.is_empty());
        }
        None => saved.global.retain(|n| n != &name),
    }
    write_saved(&app, &saved)?;
    Ok(saved)
}

/// Which secrets a job gets: the global ones, then its project's over them.
pub fn chosen(saved: &Saved, project: Option<&str>) -> Vec<(String, Option<String>)> {
    let mut out: BTreeMap<String, Option<String>> = saved.global.iter().map(|n| (n.clone(), None)).collect();
    if let Some(p) = project {
        for n in saved.projects.get(p).into_iter().flatten() {
            out.insert(n.clone(), Some(p.to_string()));
        }
    }
    out.into_iter().collect()
}

/// For a job's engine (the env carries MARKER): adds each secret it gets that the keychain still
/// has, plus the list of their names. Without the marker nothing changes.
pub fn inject(app: &AppHandle, cmd: &mut Command, env: &[(String, String)]) {
    let Some(marker) = env.iter().rev().find(|(k, _)| k == MARKER).map(|(_, v)| v.as_str()) else { return };
    let project = marker.strip_prefix("p:").filter(|p| valid_project(p));
    let mut held = Vec::new();
    for (name, from) in chosen(&read_saved(app), project) {
        // a space's own env (set by the user for that space) wins over a secret of the same name
        if env.iter().any(|(k, _)| k == &name) {
            continue;
        }
        if let Some(value) = store::get(&account(from.as_deref(), &name)) {
            cmd.env(&name, value);
            held.push(name);
        }
    }
    cmd.env(NAMES, held.join(","));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(valid_name("STRIPE_KEY").is_ok());
        assert!(valid_name("_X1").is_ok());
        for bad in ["", "stripe", "1KEY", "A-B", "PATH", "ONDRA_TOKEN", "PI_X", "DYLD_X", "NODE_OPTIONS", "A B"] {
            assert!(valid_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn reads_old_and_new_lists() {
        assert_eq!(parse(r#"["A_KEY","bad"]"#), Saved { global: vec!["A_KEY".into()], ..Default::default() });
        let s = parse(r#"{"global":["G"],"projects":{"p1":["P"],"p2":[],"../x":["Q"]}}"#);
        assert_eq!(s.global, vec!["G"]);
        assert_eq!(s.projects.keys().collect::<Vec<_>>(), vec!["p1"]);
        assert_eq!(parse("not json"), Saved::default());
    }

    #[test]
    fn project_wins_over_global() {
        let s = parse(r#"{"global":["A","B"],"projects":{"p1":["B","C"]}}"#);
        assert_eq!(chosen(&s, Some("p1")), vec![("A".into(), None), ("B".into(), Some("p1".into())), ("C".into(), Some("p1".into()))]);
        assert_eq!(chosen(&s, None), vec![("A".into(), None), ("B".into(), None)]);
    }

    #[test]
    fn finds_pairs_and_secrets() {
        let pairs = dotenv_pairs("# c\nexport A_KEY=\"x y\"\nPORT=3000 # web\nbad line\nlower.case=1\nDATABASE_URL=postgres://u:p@h/db\n");
        assert_eq!(pairs, vec![("A_KEY".into(), "x y".into()), ("PORT".into(), "3000".into()), ("lower.case".into(), "1".into()), ("DATABASE_URL".into(), "postgres://u:p@h/db".into())]);
        assert!(looks_secret("A_KEY", "x"));
        assert!(looks_secret("DATABASE_URL", "postgres://u:p@h/db"));
        assert!(!looks_secret("DATABASE_URL", "postgres://h/db"));
        assert!(!looks_secret("PORT", "3000"));
    }

    #[test]
    fn env_files_in_order() {
        let dir = std::env::temp_dir().join(format!("ondra-sec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (f, t) in [(".env.local", "A_KEY=local\n"), (".env", "A_KEY=base\nB_TOKEN=b\n"), (".env.example", "C_KEY=ex\n")] {
            std::fs::write(dir.join(f), t).unwrap();
        }
        let found = found_in(&dir);
        assert_eq!(found.get("A_KEY"), Some(&(".env.local".to_string(), "local".to_string())));
        assert!(found.contains_key("B_TOKEN") && !found.contains_key("C_KEY"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dotenv_lines() {
        assert_eq!(dotenv_value("sk_live_123"), "sk_live_123");
        assert_eq!(dotenv_value("a b\"$`\\\nz"), "\"a b\\\"\\$\\`\\\\\\nz\"");
        let text = "# keys\nexport STRIPE_KEY=old\nPORT=3000";
        assert_eq!(dotenv_set(text, "STRIPE_KEY", "new"), "# keys\nSTRIPE_KEY=new\nPORT=3000\n");
        assert_eq!(dotenv_set(text, "NEW_KEY", "v w"), "# keys\nexport STRIPE_KEY=old\nPORT=3000\nNEW_KEY=\"v w\"\n");
        assert_eq!(dotenv_set("", "A", "1"), "A=1\n");
        // a STRIPE_KEY_2 line is a different key
        assert_eq!(dotenv_set("STRIPE_KEY_2=x", "STRIPE_KEY", "y"), "STRIPE_KEY_2=x\nSTRIPE_KEY=y\n");
        let written = dotenv_set("PORT=3000\n", "TOKEN", "a \"q\" $x");
        assert_eq!(dotenv_remove(&written, "TOKEN", "a \"q\" $x").as_deref(), Some("PORT=3000\n"));
        // changed by hand since: left alone
        assert_eq!(dotenv_remove("TOKEN=mine\n", "TOKEN", "ondra"), None);
    }
}
