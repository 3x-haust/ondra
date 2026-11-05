//! Reads (never writes) what other agent tools on this Mac already know:
//! global rules, skills, memory notes and recent sessions from Claude Code,
//! Codex, pi, 3xhaustPi, OmO, Cursor and opencode, so Ondra starts set up and
//! old sessions can be picked up again. Tokens are never copied.

use crate::engine::{home, user_var};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

const TEXT_CAP: usize = 32 * 1024;
const SESSIONS_PER_SOURCE: usize = 60;
const HEAD_BYTES: u64 = 256 * 1024;
const TAIL_BYTES: u64 = 64 * 1024;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportSession {
    source: &'static str,
    path: String,
    cwd: String,
    title: String,
    updated_at: u64,
    messages: u64,
}

#[derive(Serialize)]
pub struct Rule {
    path: String,
    text: String,
}

#[derive(Serialize)]
pub struct Skill {
    name: String,
    path: String,
    description: String,
}

#[derive(Serialize)]
pub struct Memory {
    path: String,
    project: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    id: &'static str,
    name: &'static str,
    found: bool,
    root: String,
    rules: Vec<Rule>,
    skills: Vec<Skill>,
    memories: Vec<Memory>,
    sessions: Vec<ImportSession>,
    logged_in: bool,
}

impl ImportSource {
    fn new(id: &'static str, name: &'static str, root: &Path) -> Self {
        ImportSource {
            id,
            name,
            found: root.is_dir(),
            root: root.display().to_string(),
            rules: vec![],
            skills: vec![],
            memories: vec![],
            sessions: vec![],
            logged_in: false,
        }
    }
}

// ───────────── small file helpers ─────────────

fn read_capped(path: &Path) -> Option<String> {
    let mut f = File::open(path).ok()?;
    let mut buf = Vec::new();
    f.by_ref().take(TEXT_CAP as u64).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    (!text.trim().is_empty()).then_some(text)
}

fn add_rule(src: &mut ImportSource, path: PathBuf) {
    if let Some(text) = read_capped(&path) {
        src.rules.push(Rule { path: path.display().to_string(), text });
    }
}

fn mtime_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Reads `name`/`description` from a SKILL.md front matter.
fn skill_meta(md: &Path) -> (Option<String>, String) {
    let Some(text) = read_capped(md) else { return (None, String::new()) };
    let mut name = None;
    let mut desc = String::new();
    if let Some(rest) = text.strip_prefix("---") {
        for line in rest.lines().take_while(|l| l.trim() != "---") {
            if let Some(v) = line.strip_prefix("name:") {
                name = Some(v.trim().trim_matches(['"', '\'']).to_string());
            } else if let Some(v) = line.strip_prefix("description:") {
                desc = v.trim().trim_matches(['"', '\'']).to_string();
            }
        }
    }
    (name, desc.chars().take(300).collect())
}

/// Skills: folders (or symlinks to folders) holding a SKILL.md.
fn add_skills(src: &mut ImportSource, dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut found: Vec<Skill> = vec![];
    for e in entries.flatten() {
        let md = e.path().join("SKILL.md");
        if !md.is_file() {
            continue;
        }
        let (name, description) = skill_meta(&md);
        let name = name.unwrap_or_else(|| e.file_name().to_string_lossy().into_owned());
        if src.skills.iter().any(|s| s.name == name) {
            continue;
        }
        found.push(Skill { name, path: md.display().to_string(), description });
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    src.skills.extend(found);
}

fn add_memories(src: &mut ImportSource, dir: &Path, project: &str) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "md"))
        .collect();
    files.sort();
    for p in files {
        if let Some(text) = read_capped(&p) {
            src.memories.push(Memory { path: p.display().to_string(), project: project.to_string(), text });
        }
    }
}

/// All files under `dir` (to `depth` levels) matching `keep`, newest first, at most `limit`.
fn newest_files(dir: &Path, depth: usize, keep: &dyn Fn(&Path) -> bool, limit: usize) -> Vec<(PathBuf, SystemTime)> {
    fn walk(dir: &Path, depth: usize, keep: &dyn Fn(&Path) -> bool, out: &mut Vec<(PathBuf, SystemTime)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let p = e.path();
            if ft.is_dir() {
                if depth > 0 {
                    walk(&p, depth - 1, keep, out);
                }
            } else if ft.is_file() && keep(&p) {
                if let Ok(t) = e.metadata().and_then(|m| m.modified()) {
                    out.push((p, t));
                }
            }
        }
    }
    let mut out = vec![];
    walk(dir, depth, keep, &mut out);
    out.sort_by(|a, b| b.1.cmp(&a.1));
    out.truncate(limit);
    out
}

fn is_jsonl(p: &Path) -> bool {
    p.extension().is_some_and(|x| x == "jsonl")
}

/// Complete lines from the first HEAD_BYTES of a file, plus the size.
fn head_lines(path: &Path) -> (Vec<String>, u64) {
    let Ok(f) = File::open(path) else { return (vec![], 0) };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut buf = Vec::new();
    let _ = f.take(HEAD_BYTES).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if size > HEAD_BYTES && !buf.ends_with(b"\n") {
        lines.pop();
    }
    (lines, size)
}

/// Complete lines from the last TAIL_BYTES of a file.
fn tail_lines(path: &Path) -> Vec<String> {
    let Ok(mut f) = File::open(path) else { return vec![] };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    if size <= HEAD_BYTES {
        return vec![];
    }
    let _ = f.seek(SeekFrom::Start(size - TAIL_BYTES));
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf);
    text.lines().skip(1).map(str::to_string).collect()
}

/// Message count from the head, scaled up by file size when only the head was read.
fn scale(count: u64, size: u64) -> u64 {
    if size > HEAD_BYTES && count > 0 { count * size / HEAD_BYTES } else { count }
}

fn one_line(s: &str) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > 120 { format!("{}…", flat.chars().take(119).collect::<String>()) } else { flat }
}

/// Injected wrappers (system reminders, environment blocks) are not what the user typed.
fn is_noise(text: &str) -> bool {
    let t = text.trim_start();
    t.is_empty()
        || t.starts_with('<')
        || t.starts_with("The above is the conversation")
        || t.starts_with("Caveat:")
        || t.starts_with("# AGENTS.md")
        || t.starts_with("[Request interrupted")
        || t.starts_with("This session is being continued")
}

/// Text of a content field that is either a string or a list of blocks.
fn content_text(c: &Value, kinds: &[&str]) -> String {
    match c {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str).is_some_and(|t| kinds.contains(&t)))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

// ───────────── Claude Code ─────────────


fn claude_session(path: &Path) -> ImportSession {
    let (lines, size) = head_lines(path);
    let (mut cwd, mut first_user) = (String::new(), String::new());
    let (mut custom, mut ai) = (String::new(), String::new());
    let mut count = 0;
    let mut scan_title = |v: &Value| match v.get("type").and_then(Value::as_str) {
        Some("custom-title") => {
            if let Some(t) = v.get("customTitle").and_then(Value::as_str) {
                custom = t.to_string();
            }
        }
        Some("ai-title") => {
            if let Some(t) = v.get("aiTitle").and_then(Value::as_str) {
                ai = t.to_string();
            }
        }
        _ => {}
    };
    for line in &lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        if cwd.is_empty() {
            if let Some(c) = v.get("cwd").and_then(Value::as_str) {
                cwd = c.to_string();
            }
        }
        scan_title(&v);
        match v.get("type").and_then(Value::as_str) {
            Some("user") | Some("assistant") => {
                count += 1;
                if first_user.is_empty()
                    && v.get("type").and_then(Value::as_str) == Some("user")
                    && v.get("isMeta").and_then(Value::as_bool) != Some(true)
                {
                    let text = v.pointer("/message/content").map(|c| content_text(c, &["text"])).unwrap_or_default();
                    if !is_noise(&text) {
                        first_user = text;
                    }
                }
            }
            _ => {}
        }
    }
    for line in tail_lines(path) {
        if let Ok(v) = serde_json::from_str::<Value>(&line) {
            scan_title(&v);
        }
    }
    let title = [custom, ai, first_user].into_iter().find(|t| !t.trim().is_empty()).unwrap_or_default();
    ImportSession {
        source: "claude",
        path: path.display().to_string(),
        cwd,
        title: one_line(&title),
        updated_at: mtime_ms(path),
        messages: scale(count, size),
    }
}

fn keychain_has(service: &str) -> bool {
    Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

fn scan_claude() -> ImportSource {
    let roots = roots(home().join(".claude"), "CLAUDE_CONFIG_DIR");
    let mut src = ImportSource::new("claude", "Claude Code", &roots[0]);
    src.found = roots.iter().any(|r| r.is_dir());
    if let Some(r) = roots.iter().find(|r| r.is_dir()) {
        src.root = r.display().to_string();
    }
    let mut files = vec![];
    for root in &roots {
        add_rule(&mut src, root.join("CLAUDE.md"));
        add_skills(&mut src, &root.join("skills"));
        let projects = root.join("projects");
        files.extend(newest_files(&projects, 1, &is_jsonl, SESSIONS_PER_SOURCE));
        if let Ok(entries) = std::fs::read_dir(&projects) {
            for e in entries.flatten() {
                let mem = e.path().join("memory");
                if !mem.is_dir() {
                    continue;
                }
                // The folder name encodes the project path lossily; a session's cwd is exact.
                let project = newest_files(&e.path(), 0, &is_jsonl, 1)
                    .first()
                    .map(|(p, _)| claude_session(p).cwd)
                    .filter(|c| !c.is_empty())
                    .unwrap_or_else(|| e.file_name().to_string_lossy().replace('-', "/"));
                add_memories(&mut src, &mem, &project);
            }
        }
        if root.join(".credentials.json").is_file() {
            src.logged_in = true;
        }
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.truncate(SESSIONS_PER_SOURCE * 2);
    src.sessions = files.iter().map(|(p, _)| claude_session(p)).filter(keep_session).take(SESSIONS_PER_SOURCE).collect();
    src.logged_in = src.logged_in || keychain_has("Claude Code-credentials");
    src
}

// ───────────── Codex ─────────────

/// The default folder plus whatever the user's shell points the tool at.
fn roots(default: PathBuf, var: &str) -> Vec<PathBuf> {
    let mut list = vec![default];
    if let Some(dir) = user_var(var) {
        list.push(PathBuf::from(dir));
    }
    let mut seen = vec![];
    list.retain(|r| {
        let key = std::fs::canonicalize(r).unwrap_or_else(|_| r.clone());
        let keep = !seen.contains(&key);
        seen.push(key);
        keep
    });
    list
}

/// Sessions run by test suites in temp folders are noise.
fn is_temp(cwd: &str) -> bool {
    ["/var/folders/", "/private/var/folders/", "/tmp/", "/private/tmp/"].iter().any(|p| cwd.starts_with(p))
}

fn keep_session(s: &ImportSession) -> bool {
    !s.title.is_empty() && !is_temp(&s.cwd)
}

fn codex_titles(root: &Path) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Ok(f) = File::open(root.join("session_index.jsonl")) else { return map };
    for line in BufReader::new(f).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if let (Some(id), Some(name)) = (v.get("id").and_then(Value::as_str), v.get("thread_name").and_then(Value::as_str)) {
            map.insert(id.to_string(), name.to_string());
        }
    }
    map
}

fn codex_session(path: &Path, titles: &HashMap<String, String>) -> ImportSession {
    // Codex lines can be megabytes (images inlined), so stream instead of reading a
    // fixed head, skip parsing huge lines unless they are the user's message, and
    // stop once the title is known.
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let (mut cwd, mut first_user) = (String::new(), String::new());
    let (mut count, mut read) = (0u64, 0u64);
    if let Ok(f) = File::open(path) {
        let mut r = BufReader::new(f);
        let mut buf = Vec::new();
        while read < 8 * 1024 * 1024 {
            buf.clear();
            let Ok(n) = r.read_until(b'\n', &mut buf) else { break };
            if n == 0 {
                break;
            }
            read += n as u64;
            let head = &buf[..buf.len().min(400)];
            let has = |needle: &[u8]| head.windows(needle.len()).any(|w| w == needle);
            let user_line = has(b"\"role\":\"user\"");
            if buf.len() > 256 * 1024 && !has(b"\"user_message\"") && !(user_line && first_user.is_empty()) {
                if user_line || has(b"\"role\":\"assistant\"") {
                    count += 1;
                }
                continue;
            }
            let Ok(v) = serde_json::from_slice::<Value>(&buf) else { continue };
            let p = v.get("payload").cloned().unwrap_or(Value::Null);
            match (v.get("type").and_then(Value::as_str), p.get("type").and_then(Value::as_str)) {
                (Some("session_meta"), _) if cwd.is_empty() => {
                    cwd = p.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string();
                }
                (Some("event_msg"), Some("user_message")) if first_user.is_empty() => {
                    let text = p.get("message").and_then(Value::as_str).unwrap_or_default();
                    if !is_noise(text) {
                        first_user = text.to_string();
                    }
                }
                (Some("response_item"), Some("message")) => {
                    let role = p.get("role").and_then(Value::as_str).unwrap_or_default();
                    if role == "user" || role == "assistant" {
                        count += 1;
                    }
                    // Newer Codex has no user_message event: take the typed parts of the first
                    // user item, skipping injected blocks such as <image …> or <environment_context>.
                    if role == "user" && first_user.is_empty() {
                        if let Some(items) = p.get("content").and_then(Value::as_array) {
                            let typed: Vec<&str> = items
                                .iter()
                                .filter_map(|b| b.get("text").and_then(Value::as_str))
                                .filter(|t| !is_noise(t))
                                .collect();
                            first_user = typed.join(" ");
                        }
                    }
                }
                _ => {}
            }
            if !first_user.is_empty() && read > HEAD_BYTES {
                break;
            }
        }
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let title = titles
        .iter()
        .find(|(id, _)| name.contains(id.as_str()))
        .map(|(_, t)| t.clone())
        .unwrap_or(first_user);
    let messages = if read > 0 && read < size { count * size / read } else { count };
    ImportSession {
        source: "codex",
        path: path.display().to_string(),
        cwd,
        title: one_line(&title),
        updated_at: mtime_ms(path),
        messages,
    }
}

fn scan_codex() -> ImportSource {
    let roots = roots(home().join(".codex"), "CODEX_HOME");
    let mut src = ImportSource::new("codex", "Codex", &roots[0]);
    src.found = roots.iter().any(|r| r.is_dir());
    let keep = |p: &Path| is_jsonl(p) && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("rollout-"));
    let mut files = vec![];
    let mut titles = HashMap::new();
    for root in roots.iter().filter(|r| r.is_dir()) {
        add_rule(&mut src, root.join("AGENTS.md"));
        add_rule(&mut src, root.join("AGENTS.override.md"));
        add_skills(&mut src, &root.join("skills"));
        for name in ["MEMORY.md", "memory_summary.md"] {
            let p = root.join("memories").join(name);
            if let Some(text) = read_capped(&p) {
                src.memories.push(Memory { path: p.display().to_string(), project: String::new(), text });
            }
        }
        titles.extend(codex_titles(root));
        // Older rollouts are zstd-compressed (.jsonl.zst) and skipped.
        files.extend(newest_files(&root.join("sessions"), 4, &keep, SESSIONS_PER_SOURCE * 2));
        src.logged_in |= root.join("auth.json").is_file();
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    files.truncate(SESSIONS_PER_SOURCE * 2);
    src.sessions = files.iter().map(|(p, _)| codex_session(p, &titles)).filter(keep_session).take(SESSIONS_PER_SOURCE).collect();
    src
}

// ───────────── pi family (pi, OmO) ─────────────

fn pi_session(source: &'static str, path: &Path) -> ImportSession {
    let (lines, size) = head_lines(path);
    let (mut cwd, mut first_user, mut name) = (String::new(), String::new(), String::new());
    let mut count = 0;
    for line in &lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("session") if cwd.is_empty() => {
                cwd = v.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string();
            }
            Some("session_info") => {
                if let Some(n) = v.get("name").and_then(Value::as_str) {
                    name = n.to_string();
                }
            }
            Some("message") => {
                let role = v.pointer("/message/role").and_then(Value::as_str).unwrap_or_default();
                if role == "user" || role == "assistant" {
                    count += 1;
                }
                if role == "user" && first_user.is_empty() {
                    let text = v.pointer("/message/content").map(|c| content_text(c, &["text"])).unwrap_or_default();
                    if !is_noise(&text) {
                        first_user = text;
                    }
                }
            }
            _ => {}
        }
    }
    ImportSession {
        source,
        path: path.display().to_string(),
        cwd,
        title: one_line(if name.is_empty() { &first_user } else { &name }),
        updated_at: mtime_ms(path),
        messages: scale(count, size),
    }
}

fn scan_pi() -> ImportSource {
    let root = user_var("PI_CODING_AGENT_DIR").map(PathBuf::from).unwrap_or_else(|| home().join(".pi/agent"));
    let mut src = ImportSource::new("pi", "pi", &root);
    if !src.found {
        return src;
    }
    add_rule(&mut src, root.join("AGENTS.md"));
    add_rule(&mut src, root.join("SYSTEM.md"));
    add_skills(&mut src, &root.join("skills"));
    src.sessions = newest_files(&root.join("sessions"), 2, &is_jsonl, SESSIONS_PER_SOURCE * 3)
        .iter()
        .map(|(p, _)| pi_session("pi", p))
        .filter(keep_session)
        .take(SESSIONS_PER_SOURCE)
        .collect();
    src.logged_in = root.join("auth.json").is_file();
    src
}

fn scan_3xhaust() -> ImportSource {
    let root = home().join(".3xhaust");
    let mut src = ImportSource::new("3xhaust", "3xhaustPi", &root);
    if !src.found {
        return src;
    }
    add_rule(&mut src, root.join("system-prompt.md"));
    add_rule(&mut src, root.join("AGENTS.md"));
    add_skills(&mut src, &root.join("skills"));
    // 3xhaustPi's native sessions live in pi's session store (listed under pi).
    src.logged_in = root.join("auth.json").is_file();
    src
}

fn scan_omo() -> ImportSource {
    let root = home().join(".omo");
    let mut src = ImportSource::new("omo", "OmO", &root);
    if !src.found {
        return src;
    }
    add_rule(&mut src, root.join("AGENTS.md"));
    add_rule(&mut src, root.join("agent/AGENTS.md"));
    add_skills(&mut src, &root.join("skills"));
    add_skills(&mut src, &root.join("agent/skills"));
    add_memories(&mut src, &root.join("memory"), "");
    src.sessions = newest_files(&root.join("sessions"), 2, &is_jsonl, SESSIONS_PER_SOURCE * 2)
        .iter()
        .map(|(p, _)| pi_session("omo", p))
        .filter(keep_session)
        .take(SESSIONS_PER_SOURCE)
        .collect();
    src.logged_in = root.join("auth.json").is_file() || root.join("agent/auth.json").is_file();
    src
}

// ───────────── Cursor ─────────────

fn scan_cursor() -> ImportSource {
    let root = home().join(".cursor");
    let mut src = ImportSource::new("cursor", "Cursor", &root);
    if !src.found {
        return src;
    }
    if let Ok(entries) = std::fs::read_dir(root.join("rules")) {
        let mut files: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x == "md" || x == "mdc"))
            .collect();
        files.sort();
        for p in files {
            add_rule(&mut src, p);
        }
    }
    add_skills(&mut src, &root.join("skills"));
    src.logged_in = home().join("Library/Application Support/Cursor").is_dir();
    src
}

// ───────────── opencode ─────────────

fn opencode_db() -> PathBuf {
    home().join(".local/share/opencode/opencode.db")
}

/// Runs a read-only query with the system sqlite3 and returns its JSON rows.
fn sqlite_json(db: &Path, sql: &str) -> Vec<Value> {
    let uri = format!("file:{}?immutable=1", db.display());
    let Ok(out) = Command::new("/usr/bin/sqlite3")
        .args(["-json", &uri, sql])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return vec![];
    };
    serde_json::from_slice::<Vec<Value>>(&out.stdout).unwrap_or_default()
}

fn sql_str(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn scan_opencode() -> ImportSource {
    let config = home().join(".config/opencode");
    let data = home().join(".local/share/opencode");
    let mut src = ImportSource::new("opencode", "opencode", if config.is_dir() { &config } else { &data });
    src.found = config.is_dir() || data.is_dir();
    if !src.found {
        return src;
    }
    add_rule(&mut src, config.join("AGENTS.md"));
    add_skills(&mut src, &config.join("skill"));
    add_skills(&mut src, &config.join("skills"));
    src.logged_in = data.join("auth.json").is_file();
    let db = opencode_db();
    if db.is_file() {
        let rows = sqlite_json(
            &db,
            &format!(
                "select s.id, s.title, s.directory, s.time_updated, (select count(*) from message m where m.session_id = s.id) as n \
                 from session s where s.parent_id is null and s.time_archived is null order by s.time_updated desc limit {SESSIONS_PER_SOURCE}"
            ),
        );
        src.sessions = rows
            .iter()
            .filter_map(|r| {
                Some(ImportSession {
                    source: "opencode",
                    path: format!("{}#{}", db.display(), r.get("id")?.as_str()?),
                    cwd: r.get("directory").and_then(Value::as_str).unwrap_or_default().to_string(),
                    title: one_line(r.get("title").and_then(Value::as_str).unwrap_or_default()),
                    updated_at: r.get("time_updated").and_then(Value::as_u64).unwrap_or(0),
                    messages: r.get("n").and_then(Value::as_u64).unwrap_or(0),
                })
            })
            .filter(keep_session)
            .collect();
    }
    src
}

pub fn scan() -> Vec<ImportSource> {
    let jobs: Vec<fn() -> ImportSource> = vec![scan_claude, scan_codex, scan_pi, scan_3xhaust, scan_omo, scan_cursor, scan_opencode];
    let handles: Vec<_> = jobs.into_iter().map(std::thread::spawn).collect();
    handles.into_iter().filter_map(|h| h.join().ok()).collect()
}

#[tauri::command]
pub async fn scan_agents() -> Vec<ImportSource> {
    tauri::async_runtime::spawn_blocking(scan).await.unwrap_or_default()
}

// ───────────── transcripts ─────────────

#[derive(Serialize, Clone)]
pub struct Turn {
    role: &'static str,
    text: String,
}

#[derive(Serialize, Default)]
pub struct Transcript {
    cwd: String,
    turns: Vec<Turn>,
}

const MAX_TURNS: usize = 120;
const MAX_TRANSCRIPT: usize = 60 * 1024;
const MAX_TURN_TEXT: usize = 4000;
const MAX_READ: u64 = 40 * 1024 * 1024;

struct Collector {
    turns: VecDeque<Turn>,
}

impl Collector {
    fn push(&mut self, role: &'static str, text: &str) {
        let text = text.trim();
        if text.is_empty() || (role == "user" && is_noise(text)) {
            return;
        }
        let text: String = if text.chars().count() > MAX_TURN_TEXT {
            format!("{}…", text.chars().take(MAX_TURN_TEXT).collect::<String>())
        } else {
            text.to_string()
        };
        self.turns.push_back(Turn { role, text });
        if self.turns.len() > MAX_TURNS * 2 {
            self.turns.pop_front();
        }
    }

    fn finish(mut self, cwd: String) -> Transcript {
        while self.turns.len() > MAX_TURNS {
            self.turns.pop_front();
        }
        let mut total: usize = self.turns.iter().map(|t| t.text.len()).sum();
        while total > MAX_TRANSCRIPT && self.turns.len() > 1 {
            if let Some(t) = self.turns.pop_front() {
                total -= t.text.len();
            }
        }
        Transcript { cwd, turns: self.turns.into_iter().collect() }
    }
}

/// One short line for a tool call.
fn tool_line(name: &str, input: &Value) -> String {
    let pick = |keys: &[&str]| keys.iter().find_map(|k| input.get(*k).and_then(Value::as_str)).map(str::to_string);
    let detail = pick(&["command", "cmd", "file_path", "path", "filePath", "pattern", "url", "query", "description"])
        .or_else(|| {
            input.get("command").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" "))
        })
        .unwrap_or_else(|| match input {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            v => v.to_string(),
        });
    let detail = one_line(&detail);
    if detail.is_empty() { name.to_string() } else { format!("{name}: {detail}") }
}

/// Lines of a jsonl file, reading only the last MAX_READ bytes of huge ones.
fn jsonl_values(path: &Path) -> impl Iterator<Item = Value> {
    let file = File::open(path).ok();
    let reader = file.map(|mut f| {
        let size = f.metadata().map(|m| m.len()).unwrap_or(0);
        let skip_partial = size > MAX_READ;
        if skip_partial {
            let _ = f.seek(SeekFrom::Start(size - MAX_READ));
        }
        let mut r = BufReader::new(f);
        if skip_partial {
            let mut junk = Vec::new();
            let _ = r.read_until(b'\n', &mut junk);
        }
        r
    });
    reader
        .into_iter()
        .flat_map(|r| r.lines().map_while(Result::ok))
        .filter_map(|l| serde_json::from_str::<Value>(&l).ok())
}

fn transcript_claude(path: &Path) -> Transcript {
    let mut c = Collector { turns: VecDeque::new() };
    let mut cwd = String::new();
    for v in jsonl_values(path) {
        if cwd.is_empty() {
            if let Some(x) = v.get("cwd").and_then(Value::as_str) {
                cwd = x.to_string();
            }
        }
        if v.get("isSidechain").and_then(Value::as_bool) == Some(true) || v.get("isMeta").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(content) = v.pointer("/message/content") else { continue };
        match v.get("type").and_then(Value::as_str) {
            Some("user") => c.push("user", &content_text(content, &["text"])),
            Some("assistant") => {
                if let Value::Array(blocks) = content {
                    for b in blocks {
                        match b.get("type").and_then(Value::as_str) {
                            Some("text") => c.push("assistant", b.get("text").and_then(Value::as_str).unwrap_or_default()),
                            Some("tool_use") => c.push(
                                "tool",
                                &tool_line(b.get("name").and_then(Value::as_str).unwrap_or("tool"), b.get("input").unwrap_or(&Value::Null)),
                            ),
                            _ => {}
                        }
                    }
                } else {
                    c.push("assistant", &content_text(content, &["text"]));
                }
            }
            _ => {}
        }
    }
    c.finish(cwd)
}

fn transcript_codex(path: &Path) -> Transcript {
    let mut c = Collector { turns: VecDeque::new() };
    let mut cwd = String::new();
    for v in jsonl_values(path) {
        let Some(p) = v.get("payload") else { continue };
        match (v.get("type").and_then(Value::as_str), p.get("type").and_then(Value::as_str)) {
            (Some("session_meta"), _) => {
                if cwd.is_empty() {
                    cwd = p.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string();
                }
            }
            (Some("response_item"), Some("message")) => {
                let text = p.get("content").map(|x| content_text(x, &["input_text", "output_text", "text"])).unwrap_or_default();
                match p.get("role").and_then(Value::as_str) {
                    Some("user") => c.push("user", &text),
                    Some("assistant") => c.push("assistant", &text),
                    _ => {}
                }
            }
            (Some("response_item"), Some("function_call")) => {
                let name = p.get("name").and_then(Value::as_str).unwrap_or("tool");
                let args = p
                    .get("arguments")
                    .and_then(Value::as_str)
                    .and_then(|a| serde_json::from_str::<Value>(a).ok())
                    .unwrap_or(Value::Null);
                c.push("tool", &tool_line(name, &args));
            }
            (Some("response_item"), Some("custom_tool_call")) => {
                let name = p.get("name").and_then(Value::as_str).unwrap_or("tool");
                c.push("tool", &tool_line(name, p.get("input").unwrap_or(&Value::Null)));
            }
            _ => {}
        }
    }
    c.finish(cwd)
}

fn transcript_pi(path: &Path) -> Transcript {
    let mut c = Collector { turns: VecDeque::new() };
    let mut cwd = String::new();
    for v in jsonl_values(path) {
        match v.get("type").and_then(Value::as_str) {
            Some("session") => {
                if cwd.is_empty() {
                    cwd = v.get("cwd").and_then(Value::as_str).unwrap_or_default().to_string();
                }
            }
            Some("message") => {
                let Some(content) = v.pointer("/message/content") else { continue };
                match v.pointer("/message/role").and_then(Value::as_str) {
                    Some("user") => c.push("user", &content_text(content, &["text"])),
                    Some("assistant") => {
                        if let Value::Array(blocks) = content {
                            for b in blocks {
                                match b.get("type").and_then(Value::as_str) {
                                    Some("text") => c.push("assistant", b.get("text").and_then(Value::as_str).unwrap_or_default()),
                                    Some("toolCall") => c.push(
                                        "tool",
                                        &tool_line(
                                            b.get("name").and_then(Value::as_str).unwrap_or("tool"),
                                            b.get("arguments").unwrap_or(&Value::Null),
                                        ),
                                    ),
                                    _ => {}
                                }
                            }
                        } else {
                            c.push("assistant", &content_text(content, &["text"]));
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    c.finish(cwd)
}

fn transcript_opencode(path: &str) -> Transcript {
    let Some((db, id)) = path.rsplit_once('#') else { return Transcript::default() };
    let db = Path::new(db);
    let cwd = sqlite_json(db, &format!("select directory from session where id = {}", sql_str(id)))
        .first()
        .and_then(|r| r.get("directory").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_default();
    let rows = sqlite_json(
        db,
        &format!(
            "select m.data as m, p.data as p from part p join message m on m.id = p.message_id \
             where p.session_id = {} order by p.time_created, p.id",
            sql_str(id)
        ),
    );
    let mut c = Collector { turns: VecDeque::new() };
    for r in rows {
        let m: Value = r.get("m").and_then(Value::as_str).and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null);
        let p: Value = r.get("p").and_then(Value::as_str).and_then(|s| serde_json::from_str(s).ok()).unwrap_or(Value::Null);
        let role = m.get("role").and_then(Value::as_str).unwrap_or_default();
        match p.get("type").and_then(Value::as_str) {
            Some("text") if p.get("synthetic").and_then(Value::as_bool) != Some(true) => {
                let text = p.get("text").and_then(Value::as_str).unwrap_or_default();
                c.push(if role == "user" { "user" } else { "assistant" }, text);
            }
            Some("tool") => c.push(
                "tool",
                &tool_line(p.get("tool").and_then(Value::as_str).unwrap_or("tool"), p.pointer("/state/input").unwrap_or(&Value::Null)),
            ),
            _ => {}
        }
    }
    c.finish(cwd)
}

pub fn transcript(source: &str, path: &str) -> Transcript {
    match source {
        "claude" => transcript_claude(Path::new(path)),
        "codex" => transcript_codex(Path::new(path)),
        "pi" | "omo" | "3xhaust" => transcript_pi(Path::new(path)),
        "opencode" => transcript_opencode(path),
        _ => Transcript::default(),
    }
}

#[tauri::command]
pub async fn read_transcript(source: String, path: String) -> Transcript {
    tauri::async_runtime::spawn_blocking(move || transcript(&source, &path)).await.unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs against this machine's real tool folders: `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn scan_this_machine() {
        let t = std::time::Instant::now();
        let sources = scan();
        println!("scan took {:?}", t.elapsed());
        for s in &sources {
            println!(
                "{:9} found={} logged_in={} rules={} skills={} memories={} sessions={}",
                s.id,
                s.found,
                s.logged_in,
                s.rules.len(),
                s.skills.len(),
                s.memories.len(),
                s.sessions.len()
            );
            for sess in s.sessions.iter().take(2) {
                println!("    {} | {} | {} msgs | {}", sess.title, sess.cwd, sess.messages, sess.path);
            }
        }
        for s in &sources {
            if let Some(sess) = s.sessions.first() {
                let t = std::time::Instant::now();
                let tr = transcript(s.id, &sess.path);
                println!(
                    "transcript {} → {} turns, cwd {}, {:?}; last: {:?}",
                    s.id,
                    tr.turns.len(),
                    tr.cwd,
                    t.elapsed(),
                    tr.turns.last().map(|x| (x.role, x.text.chars().take(80).collect::<String>()))
                );
            }
        }
    }
}
