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
    /// per project: keys of its .env the user deleted here, so the automatic import leaves them
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub skipped: BTreeMap<String, Vec<String>>,
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

/// A project secret is "NAME" (typed here, or from the project's own .env) or "dir/sub:NAME"
/// (from the .env of that folder inside the project): (folder, name).
pub fn split_item(item: &str) -> (&str, &str) {
    item.rsplit_once(':').unwrap_or(("", item))
}

fn item_of(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}:{name}") }
}

pub fn valid_item(item: &str) -> bool {
    let (dir, name) = split_item(item);
    let dir_ok = dir.is_empty()
        || (!dir.starts_with('/') && !dir.contains(':') && !dir.contains(',') && !dir.contains('=') && dir.split('/').all(|p| !p.is_empty() && p != "." && p != ".."));
    dir_ok && valid_name(name).is_ok()
}

/// Reads secrets.json; the first version kept a plain list of global names.
fn parse(text: &str) -> Saved {
    let mut s = serde_json::from_str::<Saved>(text)
        .or_else(|_| serde_json::from_str::<Vec<String>>(text).map(|global| Saved { global, ..Default::default() }))
        .unwrap_or_default();
    s.global.retain(|n| valid_name(n).is_ok());
    for map in [&mut s.projects, &mut s.skipped] {
        map.retain(|id, names| {
            names.retain(|n| valid_item(n));
            valid_project(id) && !names.is_empty()
        });
    }
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

/// Every secret value in one keychain item (service `ai.ondra.secret`, account `vault`, a JSON
/// map from account to value), read once per run and kept in memory: macOS asks about an app's
/// access once per item, so one item means one question at most (a dev build, re-signed on every
/// rebuild, is asked again; a signed release isn't asked at all).
#[cfg(target_os = "macos")]
mod store {
    use security_framework::passwords::{get_generic_password, set_generic_password};
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    const VAULT: &str = "vault";
    /// errSecItemNotFound: no vault yet, which is an empty one
    const NOT_FOUND: i32 = -25300;
    static CACHE: Mutex<Option<BTreeMap<String, String>>> = Mutex::new(None);

    fn load() -> Result<BTreeMap<String, String>, String> {
        let mut cache = CACHE.lock().unwrap();
        if let Some(v) = cache.as_ref() {
            return Ok(v.clone());
        }
        let vault = match get_generic_password(super::SERVICE, VAULT) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "키체인의 시크릿을 읽지 못했어요".to_string())?,
            Err(e) if e.code() == NOT_FOUND => BTreeMap::new(),
            // denied or locked: nothing is written over what is there
            Err(e) => return Err(format!("키체인을 열지 못했어요: {e}")),
        };
        *cache = Some(vault.clone());
        Ok(vault)
    }

    fn save(vault: BTreeMap<String, String>) -> Result<(), String> {
        let json = serde_json::to_vec(&vault).map_err(|e| e.to_string())?;
        set_generic_password(super::SERVICE, VAULT, &json).map_err(|e| format!("키체인에 저장하지 못했어요: {e}"))?;
        *CACHE.lock().unwrap() = Some(vault);
        Ok(())
    }

    pub fn set_many(pairs: Vec<(String, String)>) -> Result<(), String> {
        if pairs.is_empty() {
            return Ok(());
        }
        let mut vault = load()?;
        vault.extend(pairs);
        save(vault)
    }
    pub fn set(account: &str, value: &str) -> Result<(), String> {
        set_many(vec![(account.to_string(), value.to_string())])
    }
    pub fn get(account: &str) -> Option<String> {
        load().ok()?.get(account).cloned()
    }
    pub fn has(account: &str) -> bool {
        load().is_ok_and(|v| v.contains_key(account))
    }
    /// The vault can be read (asking the user if macOS wants to).
    pub fn check() -> Result<(), String> {
        load().map(|_| ())
    }
    pub fn delete(account: &str) -> Result<(), String> {
        let mut vault = load()?;
        if vault.remove(account).is_some() {
            save(vault)?;
        }
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod store {
    pub fn set_many(_: Vec<(String, String)>) -> Result<(), String> {
        Err("시크릿은 macOS에서만 쓸 수 있어요".into())
    }
    pub fn set(_: &str, _: &str) -> Result<(), String> {
        Err("시크릿은 macOS에서만 쓸 수 있어요".into())
    }
    pub fn get(_: &str) -> Option<String> {
        None
    }
    pub fn has(_: &str) -> bool {
        false
    }
    pub fn check() -> Result<(), String> {
        Err("시크릿은 macOS에서만 쓸 수 있어요".into())
    }
    pub fn delete(_: &str) -> Result<(), String> {
        Ok(())
    }
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

/// Folders not worth looking into for a project's own .env files.
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "out", "vendor", "venv", "__pycache__", "Pods", "DerivedData", "coverage", "bower_components", "jspm_packages", "site-packages"];
const MAX_DEPTH: usize = 6;
const MAX_DIRS: usize = 4000;

/// The project folder and every folder under it that may hold a .env of its own, as (path from
/// the project, absolute path). Hidden folders (.git, .next, …) and build output are skipped.
pub fn env_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let mut out = vec![(String::new(), root.to_path_buf())];
    let mut queue = vec![(String::new(), root.to_path_buf(), 0usize)];
    let mut seen = 0;
    while let Some((rel, dir, depth)) = queue.pop() {
        if depth >= MAX_DEPTH || seen >= MAX_DIRS {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let Ok(kind) = e.file_type() else { continue };
            // a link could lead out of the project or around in a circle
            if !kind.is_dir() || kind.is_symlink() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
                continue;
            }
            seen += 1;
            let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            out.push((r.clone(), e.path()));
            queue.push((r, e.path(), depth + 1));
        }
    }
    out.sort();
    out
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

/// Each key the project's .env files set, with its last value (never sent to the page).
/// Keyed by item ("NAME", "dir/sub:NAME"): the file it comes from and its value.
fn found_in(folder: &Path) -> BTreeMap<String, (String, String)> {
    let mut out = BTreeMap::new();
    for (rel, dir) in env_dirs(folder) {
        for path in env_files(&dir) {
            let file = path.file_name().and_then(|n| n.to_str()).unwrap_or(".env").to_string();
            let file = if rel.is_empty() { file } else { format!("{rel}/{file}") };
            if let Ok(text) = std::fs::read_to_string(&path) {
                for (k, v) in dotenv_pairs(&text) {
                    out.insert(item_of(&rel, &k), (file.clone(), v));
                }
            }
        }
    }
    out
}

/// The keys of a project's .env that the automatic import takes: secret-looking, usable as a
/// name, not saved for it yet and not deleted here before.
pub fn to_take(saved: &Saved, project: &str, found: &BTreeMap<String, (String, String)>) -> Vec<String> {
    let has = |map: &BTreeMap<String, Vec<String>>, n: &String| map.get(project).is_some_and(|l| l.contains(n));
    found
        .iter()
        .filter(|(n, (_, v))| !v.is_empty() && v.len() <= MAX_VALUE && looks_secret(split_item(n).1, v) && valid_item(n))
        .map(|(n, _)| n.clone())
        .filter(|n| !has(&saved.projects, n) && !has(&saved.skipped, n))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Synced {
    pub saved: Saved,
    /// "project id/NAME" for each key taken this time
    pub added: Vec<String>,
}

/// Takes the keys, tokens and passwords this Mac's projects already keep in their .env files
/// into the keychain as each project's secrets (the files stay as they are). Runs when Settings ›
/// 시크릿 opens; values never leave this process.
#[tauri::command]
pub fn secret_sync(app: AppHandle, projects: Vec<(String, String)>) -> Result<Synced, String> {
    // a vault that can't be opened (denied, locked) changes nothing
    store::check()?;
    let mut saved = read_saved(&app);
    let mut added = Vec::new();
    let mut values = Vec::new();
    for (id, folder) in projects {
        if !valid_project(&id) || !Path::new(&folder).is_dir() {
            continue;
        }
        // listed but without a value (a vault that was reset): taken again
        if let Some(list) = saved.projects.get_mut(&id) {
            list.retain(|item| store::has(&account(Some(&id), item)));
        }
        let found = found_in(Path::new(&folder));
        for name in to_take(&saved, &id, &found) {
            values.push((account(Some(&id), &name), found[&name].1.clone()));
            let list = saved.projects.entry(id.clone()).or_default();
            list.push(name.clone());
            list.sort();
            added.push(format!("{id}/{name}"));
        }
    }
    saved.projects.retain(|_, l| !l.is_empty());
    store::set_many(values)?;
    write_saved(&app, &saved)?;
    Ok(Synced { saved, added })
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
    if let Some(p) = &project {
        if let Some(l) = saved.skipped.get_mut(p) {
            l.retain(|n| n != &name);
        }
        saved.skipped.retain(|_, l| !l.is_empty());
    }
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
        let (dir, key) = split_item(&name);
        if let Some(value) = store::get(&acct).filter(|_| valid_item(&name)) {
            for path in env_files(&Path::new(folder).join(dir)) {
                let Ok(text) = std::fs::read_to_string(&path) else { continue };
                if let Some(next) = dotenv_remove(&text, key, &value) {
                    std::fs::write(&path, next).map_err(|e| format!(".env를 고치지 못했어요: {e}"))?;
                }
            }
        }
    }
    store::delete(&acct)?;
    let mut saved = read_saved(&app);
    match &project {
        Some(p) => {
            if let Some(list) = saved.projects.get_mut(p) {
                list.retain(|n| n != &name);
            }
            saved.projects.retain(|_, l| !l.is_empty());
            // still in its .env (a line changed by hand): the automatic import must not bring it back
            if folder.as_deref().is_some_and(|f| found_in(Path::new(f)).contains_key(&name)) {
                let l = saved.skipped.entry(p.clone()).or_default();
                if !l.contains(&name) {
                    l.push(name.clone());
                }
            }
        }
        None => saved.global.retain(|n| n != &name),
    }
    write_saved(&app, &saved)?;
    Ok(saved)
}

/// One saved secret, where it lives: a project's item, or a global name (no project).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Place {
    pub project: Option<String>,
    pub item: String,
}

/// Saved secrets with the same value, shown as one.
#[derive(Serialize, Debug, PartialEq)]
pub struct Group {
    /// the variable names they go by, without repeats
    pub names: Vec<String>,
    pub places: Vec<Place>,
}

/// Puts places with equal values together; `value` reads one (None: gone from the keychain, alone).
pub fn group_by_value(places: Vec<Place>, value: impl Fn(&Place) -> Option<String>) -> Vec<Group> {
    use sha2::{Digest, Sha256};
    let mut groups: Vec<(Option<[u8; 32]>, Group)> = Vec::new();
    for place in places {
        let key = value(&place).map(|v| Sha256::digest(v.as_bytes()).into());
        let name = split_item(&place.item).1.to_string();
        match groups.iter_mut().find(|(k, _)| key.is_some() && k == &key) {
            Some((_, g)) => {
                if !g.names.contains(&name) {
                    g.names.push(name);
                }
                g.places.push(place);
            }
            None => groups.push((key, Group { names: vec![name], places: vec![place] })),
        }
    }
    let mut out: Vec<Group> = groups.into_iter().map(|(_, g)| g).collect();
    out.sort_by(|a, b| a.names[0].cmp(&b.names[0]));
    out
}

/// Every saved secret (global and every project's), those with the same value together. Values
/// are compared here and never sent.
#[tauri::command]
pub fn secret_overview(app: AppHandle) -> Vec<Group> {
    let saved = read_saved(&app);
    let mut places: Vec<Place> = saved.global.iter().map(|n| Place { project: None, item: n.clone() }).collect();
    for (p, items) in &saved.projects {
        places.extend(items.iter().map(|i| Place { project: Some(p.clone()), item: i.clone() }));
    }
    group_by_value(places, |pl| store::get(&account(pl.project.as_deref(), &pl.item)))
}

/// Which secrets a job gets, as (variable name, keychain account): the global ones, then its
/// project's over them; of a project's items with the same name, the one nearest the project's
/// top (its own .env, or typed here) wins. The rest are only hidden from output: `masked`.
pub struct Chosen {
    pub set: Vec<(String, String)>,
    pub masked: Vec<(String, String)>,
}

pub fn chosen(saved: &Saved, project: Option<&str>) -> Chosen {
    let mut set: BTreeMap<String, (usize, String)> = saved.global.iter().map(|n| (n.clone(), (usize::MAX, n.clone()))).collect();
    let mut masked = Vec::new();
    if let Some(p) = project {
        let mut items: Vec<&String> = saved.projects.get(p).into_iter().flatten().collect();
        // nearest first: no folder, then fewer levels, then by path
        items.sort_by_key(|i| {
            let d = split_item(i).0;
            (if d.is_empty() { 0 } else { d.matches('/').count() + 1 }, d.to_string())
        });
        let mut taken = std::collections::BTreeSet::new();
        for item in items {
            let name = split_item(item).1.to_string();
            let acct = account(Some(p), item);
            if taken.insert(name.clone()) {
                if let Some((rank, old)) = set.insert(name, (0, acct)) {
                    if rank == usize::MAX {
                        masked.push((old.clone(), old));
                    }
                }
            } else {
                masked.push((item.clone(), acct));
            }
        }
    }
    Chosen { set: set.into_iter().map(|(n, (_, a))| (n, a)).collect(), masked }
}

/// What the engine is told about values it holds only to hide them: `VAR=label` pairs.
pub const MASKS: &str = "ONDRA_SECRET_MASKS";

/// For a job's engine (the env carries MARKER): adds each secret it gets that the keychain still
/// has, plus the list of their names; the values it doesn't get as a variable (a deeper folder's
/// key of the same name) go in as ONDRA_SECRET_MASK_n so they are hidden from output too.
pub fn inject(app: &AppHandle, cmd: &mut Command, env: &[(String, String)]) {
    let Some(marker) = env.iter().rev().find(|(k, _)| k == MARKER).map(|(_, v)| v.as_str()) else { return };
    let project = marker.strip_prefix("p:").filter(|p| valid_project(p));
    let picked = chosen(&read_saved(app), project);
    let mut held = Vec::new();
    for (name, acct) in picked.set {
        // a space's own env (set by the user for that space) wins over a secret of the same name
        if env.iter().any(|(k, _)| k == &name) {
            continue;
        }
        if let Some(value) = store::get(&acct) {
            cmd.env(&name, value);
            held.push(name);
        }
    }
    let mut masks = Vec::new();
    for (i, (label, acct)) in picked.masked.into_iter().enumerate() {
        if let Some(value) = store::get(&acct) {
            let var = format!("ONDRA_SECRET_MASK_{i}");
            cmd.env(&var, value);
            masks.push(format!("{var}={label}"));
        }
    }
    cmd.env(NAMES, held.join(","));
    cmd.env(MASKS, masks.join(","));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_values_together() {
        let pl = |p: Option<&str>, i: &str| Place { project: p.map(String::from), item: i.into() };
        let values = |p: &Place| match p.item.as_str() {
            "API_KEY" | "Deploy:OPENAI_KEY" => Some("same".to_string()),
            "GONE" => None,
            _ => Some(p.item.clone()),
        };
        let g = group_by_value(vec![pl(None, "API_KEY"), pl(Some("p1"), "API_KEY"), pl(Some("p2"), "Deploy:OPENAI_KEY"), pl(Some("p1"), "DB_TOKEN"), pl(None, "GONE"), pl(Some("p1"), "GONE")], values);
        assert_eq!(g.len(), 4);
        assert_eq!(g[0].names, vec!["API_KEY", "OPENAI_KEY"]);
        assert_eq!(g[0].places.len(), 3);
        // without a value nothing is merged
        assert_eq!(g.iter().filter(|x| x.names == ["GONE"]).count(), 2);
    }

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
        assert!(valid_item("Deploy/Front:API_KEY") && valid_item("API_KEY"));
        assert!(!valid_item("../x:API_KEY") && !valid_item("/abs:API_KEY") && !valid_item("a//b:K") && !valid_item("Deploy:lower"));
        assert_eq!(parse("not json"), Saved::default());
    }

    #[test]
    fn project_wins_over_global() {
        let s = parse(r#"{"global":["A","B"],"projects":{"p1":["B","C"]}}"#);
        let c = chosen(&s, Some("p1"));
        assert_eq!(c.set, vec![("A".into(), "A".into()), ("B".into(), "p1/B".into()), ("C".into(), "p1/C".into())]);
        assert_eq!(c.masked, vec![("B".into(), "B".into())]);
        assert_eq!(chosen(&s, None).set, vec![("A".into(), "A".into()), ("B".into(), "B".into())]);
        // the project's own .env first, a deeper folder's key of the same name only hidden
        let s = parse(r#"{"projects":{"p1":["Deploy/Front:API_KEY","API_KEY","Deploy:API_KEY","Deploy/Front:WEB_TOKEN"]}}"#);
        let c = chosen(&s, Some("p1"));
        assert_eq!(c.set, vec![("API_KEY".into(), "p1/API_KEY".into()), ("WEB_TOKEN".into(), "p1/Deploy/Front:WEB_TOKEN".into())]);
        assert_eq!(c.masked, vec![("Deploy:API_KEY".into(), "p1/Deploy:API_KEY".into()), ("Deploy/Front:API_KEY".into(), "p1/Deploy/Front:API_KEY".into())]);
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
    fn takes_only_new_secret_keys() {
        let mut saved = parse(r#"{"projects":{"p1":["OLD_KEY"]},"skipped":{"p1":["GONE_TOKEN"]}}"#);
        let found: BTreeMap<String, (String, String)> = [("OLD_KEY", "a"), ("NEW_KEY", "b"), ("GONE_TOKEN", "c"), ("PORT", "3000"), ("lower_key", "d"), ("EMPTY_KEY", "")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), (".env".to_string(), v.to_string())))
            .collect();
        assert_eq!(to_take(&saved, "p1", &found), vec!["NEW_KEY"]);
        assert_eq!(to_take(&saved, "p2", &found), vec!["GONE_TOKEN", "NEW_KEY", "OLD_KEY"]);
        saved.skipped.clear();
        assert_eq!(to_take(&saved, "p1", &found), vec!["GONE_TOKEN", "NEW_KEY"]);
    }

    #[test]
    fn env_files_in_order() {
        let dir = std::env::temp_dir().join(format!("ondra-sec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (f, t) in [(".env.local", "A_KEY=local\n"), (".env", "A_KEY=base\nB_TOKEN=b\n"), (".env.example", "C_KEY=ex\n")] {
            std::fs::write(dir.join(f), t).unwrap();
        }
        for (d, t) in [("Deploy/Front", "A_KEY=front\n"), ("node_modules/pkg", "N_KEY=n\n"), (".hidden", "H_KEY=h\n")] {
            std::fs::create_dir_all(dir.join(d)).unwrap();
            std::fs::write(dir.join(d).join(".env"), t).unwrap();
        }
        let found = found_in(&dir);
        assert_eq!(found.get("A_KEY"), Some(&(".env.local".to_string(), "local".to_string())));
        assert_eq!(found.get("Deploy/Front:A_KEY"), Some(&("Deploy/Front/.env".to_string(), "front".to_string())));
        assert!(found.contains_key("B_TOKEN") && !found.contains_key("C_KEY"));
        assert!(!found.keys().any(|k| k.contains("N_KEY") || k.contains("H_KEY")));
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
