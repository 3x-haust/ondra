// Shared pieces of ondra-browser: errors, JSON, paths, globs, small helpers.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub type Json = Map<String, Value>;
pub type Res<T> = Result<T, String>;

/// Typed reads of a JSON object, like the Swift tool's dictionary helpers.
pub trait Get {
    fn str(&self, k: &str) -> Option<&str>;
    fn int(&self, k: &str) -> Option<i64>;
    fn dbl(&self, k: &str) -> Option<f64>;
    fn bool(&self, k: &str) -> Option<bool>;
    fn obj(&self, k: &str) -> Option<&Json>;
    fn arr(&self, k: &str) -> Option<&Vec<Value>>;
}

impl Get for Json {
    fn str(&self, k: &str) -> Option<&str> {
        self.get(k)?.as_str()
    }
    fn int(&self, k: &str) -> Option<i64> {
        let v = self.get(k)?;
        v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
    }
    fn dbl(&self, k: &str) -> Option<f64> {
        self.get(k)?.as_f64()
    }
    fn bool(&self, k: &str) -> Option<bool> {
        self.get(k)?.as_bool()
    }
    fn obj(&self, k: &str) -> Option<&Json> {
        self.get(k)?.as_object()
    }
    fn arr(&self, k: &str) -> Option<&Vec<Value>> {
        self.get(k)?.as_array()
    }
}

/// `json!({...})` as an object.
#[macro_export]
macro_rules! obj {
    ($($t:tt)*) => {
        match serde_json::json!($($t)*) { serde_json::Value::Object(m) => m, _ => unreachable!() }
    };
}

/// Whole numbers as integers (37, not 37.0), as the Swift build prints them.
pub fn whole(v: Value) -> Value {
    match v {
        Value::Number(n) => match n.as_f64() {
            Some(f) if n.is_f64() && f.fract() == 0.0 && f.abs() < 9e15 => Value::from(f as i64),
            _ => Value::Number(n),
        },
        Value::Array(a) => Value::Array(a.into_iter().map(whole).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, whole(v))).collect()),
        v => v,
    }
}

pub fn json_string(v: &Value) -> String {
    serde_json::to_string(&whole(v.clone())).unwrap_or_else(|_| "null".into())
}

pub fn json_pretty(v: &Value) -> String {
    serde_json::to_string_pretty(&whole(v.clone())).unwrap_or_else(|_| "null".into())
}

pub fn quote(s: &str) -> String {
    json_string(&Value::String(s.to_string()))
}

// ───────────── where sessions live ─────────────

/// Session state files and logs: one folder per user.
pub fn base_dir() -> &'static Path {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        #[cfg(unix)]
        let dir = PathBuf::from(format!("/tmp/ondra-browser-{}", unsafe { libc::getuid() }));
        #[cfg(windows)]
        let dir = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("ondra-browser");
        let _ = std::fs::create_dir_all(&dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        }
        dir
    })
}

pub fn safe_name(session: &str) -> String {
    let mut s: String = session.chars().map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') { c } else { '_' }).collect();
    if s.is_empty() {
        s = "default".into();
    }
    if s.chars().count() > 72 {
        // FNV-1a: the same long name maps to the same file in every process
        let h = s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3));
        s = format!("{}-{}", s.chars().take(56).collect::<String>(), radix36(h));
    }
    s
}

fn radix36(mut n: u64) -> String {
    let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = Vec::new();
    loop {
        out.push(digits[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

pub fn state_path(session: &str) -> PathBuf {
    base_dir().join(format!("{}.json", safe_name(session)))
}
pub fn log_path(session: &str) -> PathBuf {
    base_dir().join(format!("{}.log", safe_name(session)))
}
pub fn lock_path(session: &str) -> PathBuf {
    base_dir().join(format!("{}.lock", safe_name(session)))
}

pub fn read_state(session: &str) -> Json {
    std::fs::read(state_path(session)).ok().and_then(|d| serde_json::from_slice::<Json>(&d).ok()).unwrap_or_default()
}

pub fn write_state(session: &str, state: &Json) {
    let path = state_path(session);
    let tmp = path.with_extension("json.tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    if let Ok(mut f) = opts.open(&tmp) {
        use std::io::Write;
        let _ = f.write_all(json_string(&Value::Object(state.clone())).as_bytes());
        drop(f);
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Change the state file in place (read, change, write).
pub fn update_state(session: &str, f: impl FnOnce(&mut Json)) {
    let mut st = read_state(session);
    f(&mut st);
    write_state(session, &st);
}

// ───────────── text ─────────────

/// `*` matches any run of characters (slashes too), `?` one character. Case-insensitive.
pub fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.to_lowercase().replace("**", "*").chars().collect();
    let t: Vec<char> = text.to_lowercase().chars().collect();
    let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, None::<usize>, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

pub fn clip(s: &str, n: usize) -> String {
    let one = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= n {
        one
    } else {
        one.chars().take(n - 1).collect::<String>() + "…"
    }
}

pub fn quote_for_snapshot(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " ")
}

/// A path given by the client, made absolute against the client's working directory.
pub fn absolute_path(p: &str, cwd: &str) -> String {
    // Git Bash spells C:\x as /c/x
    #[cfg(windows)]
    let p = &{
        let b = p.as_bytes();
        if b.len() >= 2 && b[0] == b'/' && b[1].is_ascii_alphabetic() && (b.len() == 2 || b[2] == b'/') {
            format!("{}:{}", (b[1] as char).to_ascii_uppercase(), if b.len() == 2 { "/" } else { &p[2..] })
        } else {
            p.to_string()
        }
    };
    let expanded = match p.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') || rest.starts_with('\\') => home().map(|h| format!("{}{rest}", h.display())).unwrap_or_else(|| p.to_string()),
        _ => p.to_string(),
    };
    let path = Path::new(&expanded);
    if path.is_absolute() {
        return expanded;
    }
    Path::new(cwd).join(path).display().to_string()
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

pub fn sleep_ms(ms: f64) {
    if ms > 0.0 {
        std::thread::sleep(Duration::from_micros((ms * 1000.0) as u64));
    }
}

/// Poll `check` until it returns a value or the time is up.
pub fn poll<T>(timeout_ms: f64, every_ms: f64, what: &str, mut check: impl FnMut() -> Res<Option<T>>) -> Res<T> {
    let until = now_ms() + timeout_ms;
    loop {
        if let Some(v) = check()? {
            return Ok(v);
        }
        if now_ms() >= until {
            return Err(format!("Timed out after {} ms waiting for {what}", timeout_ms as i64));
        }
        sleep_ms(every_ms);
    }
}

/// A program on PATH.
pub fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ""] } else { &[""] };
    for dir in std::env::split_paths(&path) {
        for ext in exts {
            let p = dir.join(format!("{name}{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// Split a command line the way a shell would (quotes and backslashes; no expansion).
pub fn shell_split(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let (mut has, mut esc) = (false, false);
    let mut quote: Option<char> = None;
    for ch in s.chars() {
        if esc {
            cur.push(ch);
            esc = false;
            continue;
        }
        if ch == '\\' && quote != Some('\'') {
            esc = true;
            has = true;
            continue;
        }
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                cur.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            has = true;
            continue;
        }
        if ch.is_whitespace() {
            if has || !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
                has = false;
            }
            continue;
        }
        cur.push(ch);
    }
    if has || !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// A random hex token (the key to a session's port).
pub fn token() -> String {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// A command for a program this tool starts in the background: never a console window on Windows.
pub fn quiet_command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

pub fn log(s: &str) {
    eprintln!("[{}] {s}", now_ms() as i64 / 1000);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs() {
        assert!(glob_match("*://*doubleclick.net/*", "https://ad.doubleclick.net/x"));
        assert!(glob_match("**/done", "http://a/b/done"));
        assert!(!glob_match("*.png", "a.jpg"));
    }

    #[test]
    fn splits() {
        assert_eq!(shell_split(r#"fill @e3 "김 철수" 'a b' c\ d"#), vec!["fill", "@e3", "김 철수", "a b", "c d"]);
        assert_eq!(shell_split("x ''"), vec!["x", ""]);
    }

    #[test]
    fn names() {
        assert_eq!(safe_name("w-a/b"), "w-a_b");
        let long = "x".repeat(100);
        assert_eq!(safe_name(&long), safe_name(&long));
        assert!(safe_name(&long).len() < 72);
    }
}
