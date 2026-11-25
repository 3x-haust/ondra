// ondra-browser: Ondra's browser tool for agents. Drives Chrome over the DevTools protocol.
//
//   ondra-browser [--session <name>] [--json] <command> [args]
//
// The same tool as the Swift build macOS ships (src-tauri/helpers/browser): the same commands,
// output and environment, for Windows and Linux. Each session has a small daemon (started on
// first use, gone after a while idle) that keeps the connection, the session's tab, its refs and
// logs between commands. With ONDRA_BROWSER_CDP it attaches to a running browser (the app's
// shared one) instead of starting its own; with ONDRA_BROWSER_PIN_TAB=1 the session works in a
// tab of its own.
//
// Environment: ONDRA_BROWSER_SESSION, ONDRA_BROWSER_CDP, ONDRA_BROWSER_PIN_TAB,
// ONDRA_BROWSER_IDLE_TIMEOUT_MS, ONDRA_BROWSER_EXECUTABLE_PATH, ONDRA_BROWSER_INIT_SCRIPTS
// (comma-separated JS files run in every page before its own scripts),
// ONDRA_BROWSER_KEYCHAIN (the credential helper for `auth login`), ONDRA_BROWSER_STREAM_PORT.

#[macro_use]
mod util;
mod audit;
mod auth;
mod cdp;
mod commands;
mod daemon;
mod keys;
mod snapshot;
mod stream;
mod tab;

mod page_js {
    include!(concat!(env!("OUT_DIR"), "/page_js.rs"));
}

use daemon::{Config, Daemon, Request};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, IsTerminal, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use util::*;

const VERSION: &str = "1.0.0";

const HELP: &str = r#"ondra-browser 1.0.0: drive a browser tab from the command line

Usage: ondra-browser [--session <name>] [--json] <command> [args]

Look
  snapshot [-c] [-i] [-s <css>] [-u] [-d <n>] [--delta]
                                               accessibility tree with refs (@e3); -c compact,
                                               -i controls only, -s one region, -u link targets,
                                               --delta only what changed since the last one
  get url|title|text|html|value|attr <name>|count|box|styles [<sel>]
  is visible|enabled|checked <sel>
  screenshot [path] [--full] [--selector <css>]
  pdf <path>
  eval <js> | eval --stdin                     run JavaScript in the page (await works)
  console [--clear]  errors [--clear]          the page's console messages and errors
  a11y [url] [--selector <css>]                accessibility check (WCAG 2.2 A/AA rules): violations
                                               with impact, rule id and the elements
  vitals [url]                                 LCP, CLS, INP, FCP, TTFB and load times

Act  (<sel> is a ref like @e3, a CSS selector, text=…, or xpath=…)
  open <url> [--wait-until load|domcontentloaded|networkidle]
  back  forward  reload
  click <sel>  dblclick <sel>  hover <sel>  focus <sel>  scrollintoview <sel>
  fill <sel> <text>                            clear, then type the text
  type <sel> <text>                            type key by key
  press <key>                                  Enter, Tab, Escape, Control+a, Shift+Tab …
  keyboard type <text> | keyboard inserttext <text>
  check <sel>  uncheck <sel>  select <sel> <value...>
  upload <sel> <files...>  download <sel> <path>  drag <from> <to>
  scroll up|down|left|right [px] [--selector <css>]
  mouse move <x> <y> | mouse down|up [button] | mouse wheel <dy> [dx]
  find role|text|label|placeholder|alt|title|testid <value> [action] [text] [--name <n>] [--exact]
  find first|last <css> [action] | find nth <n> <css> [action]

Wait
  wait <ms> | wait <sel> [--state visible|hidden|attached|detached]
  wait --load load|domcontentloaded|networkidle
  wait --text <text> | wait --url <pattern> | wait --fn <js>      (--timeout <ms>, default 25000)

Tabs and session
  tab [list] | tab new [url] | tab <tN> | tab close [tN]
  session list | session info
  close [--all]                                end this session (a shared browser keeps its tabs)

Network and state
  network route <url-glob> [--abort | --body <json> [--allow-origin <o>]] [--resource-type image,font,…]
  network unroute [url-glob]
  network requests [--clear] [--filter <text>] [--type xhr,fetch] [--method GET] [--status 400-599]
  network request <id>                         one request with its response body
  cookies [get [--url u]] | cookies set <name> <value> [--url|--domain|--path|--secure|--http-only|--same-site|--expires]
  cookies clear
  storage local|session [<key> | set <k> <v> | remove <k> | clear]
  set viewport <w> <h> [scale] | set device <name> | set media [dark|light] [reduced-motion]
  set offline on|off | set headers <json> | set geo <lat> <lng> | set useragent <ua>

Sign-in, recording, streaming
  auth login <site> --credential-provider keychain [--url <login page>] [--no-navigate] [--item <account>]
       [--username-selector <css>] [--password-selector <css>] [--submit-selector <css>]
  record start <file.webm|file.mp4> [url] | record stop       (needs ffmpeg)
  stream status | stream enable [--port <n>] | stream disable

Batch
  batch [--bail] ["cmd args" ...]              or a JSON array of commands on stdin; with --json
                                               one row per command: {command, success, result, error}

Global: --session <name>, --json, --cdp <port|url>, --no-pin-tab, --version"#;

fn usage(cmd: &str) -> Option<&'static str> {
    Some(match cmd {
        "open" => "open <url> [--wait-until load|domcontentloaded|networkidle] [--timeout <ms>]",
        "snapshot" => "snapshot [-c|--compact] [-i|--interactive] [-s|--selector <css>] [-u|--urls] [-d|--depth <n>] [--delta]",
        "a11y" => "a11y [url] [--selector <css>]   accessibility violations: impact, rule, how many, the first element",
        "vitals" => "vitals [url]   LCP, CLS, INP, FCP, TTFB, load",
        "click" => "click <sel>   (<sel>: @e3, CSS, text=…, xpath=…)",
        "fill" => "fill <sel> <text>   clear the field, then type the text",
        "type" => "type <sel> <text>   type key by key into the field",
        "press" => "press <key>   Enter, Tab, Escape, ArrowDown, Control+a, Shift+Tab …",
        "wait" => "wait <ms> | wait <sel> [--state visible|hidden|attached|detached] | wait --load load|domcontentloaded|networkidle | wait --text <t> | wait --url <glob> | wait --fn <js>   [--timeout <ms>]",
        "eval" => "eval <js> | eval --stdin   (the value of the last expression; promises are awaited)",
        "get" => "get url|title|text <sel>|html <sel>|value <sel>|attr <name> <sel>|count <css>|box <sel>|styles <sel>",
        "screenshot" => "screenshot [path] [--full] [--selector <css>]",
        "tab" => "tab [list] | tab new [url] | tab <tN> | tab close [tN]",
        "network" => "network route <glob> [--abort|--body <json>] [--resource-type <csv>] | network unroute [glob] | network requests [--clear] [--filter t] [--type xhr,fetch] [--method GET] [--status 400-599] | network request <id>",
        "find" => "find role|text|label|placeholder|alt|title|testid <value> [click|fill|type|hover|focus|check|uncheck|text] [text] [--name <n>] [--exact]; find first|last <css> [action]; find nth <n> <css> [action]",
        "auth" => "auth login <site> --credential-provider keychain [--url <login page>] [--no-navigate] [--item <account>] [--username-selector css] [--password-selector css] [--submit-selector css]",
        "record" => "record start <file.webm|file.mp4> [url] | record stop",
        "upload" => "upload <sel> <files...>",
        "select" => "select <sel> <value or label...>",
        "set" => "set viewport <w> <h> [scale] | set device <name> | set media [dark|light] [reduced-motion] | set offline on|off | set headers <json> | set credentials <u> <p> | set geo <lat> <lng> | set useragent <ua>",
        "cookies" => "cookies [get [--url u]] | cookies set <name> <value> [--url u|--domain d] [--path p] [--secure] [--http-only] [--same-site s] [--expires ts] | cookies clear",
        "storage" => "storage local|session [<key> | set <k> <v> | remove <k> | clear]",
        "batch" => "batch [--bail] [--json] [\"cmd args\" ...]   (or a JSON array of commands on stdin)",
        "stream" => "stream status | stream enable [--port <n>] | stream disable",
        "session" => "session list | session info",
        "close" => "close [--all]",
        "scroll" => "scroll up|down|left|right [px] [--selector <css>]",
        "mouse" => "mouse move <x> <y> | mouse down|up [left|right|middle] | mouse wheel <dy> [dx]",
        "keyboard" => "keyboard type <text> | keyboard inserttext <text>",
        "download" => "download <sel> <path>",
        _ => return None,
    })
}

fn out(s: &str) {
    if s.is_empty() {
        return;
    }
    let mut o = std::io::stdout().lock();
    let _ = o.write_all(s.as_bytes());
    if !s.ends_with('\n') {
        let _ = o.write_all(b"\n");
    }
    let _ = o.flush();
}

fn err_out(s: &str) {
    let mut o = std::io::stderr().lock();
    let _ = o.write_all(s.as_bytes());
    if !s.ends_with('\n') {
        let _ = o.write_all(b"\n");
    }
}

/// One JSON line each way.
fn write_line(s: &mut TcpStream, v: &Value) -> bool {
    let mut line = json_string(v);
    line.push('\n');
    s.write_all(line.as_bytes()).is_ok()
}

fn read_line(s: &TcpStream) -> Option<Json> {
    let mut r = BufReader::new(s);
    let mut line = String::new();
    match r.read_line(&mut line) {
        Ok(n) if n > 0 => serde_json::from_str(line.trim_end()).ok(),
        _ => None,
    }
}

// ───────────── the daemon side ─────────────

static TERM: AtomicBool = AtomicBool::new(false);

#[cfg(unix)]
extern "C" fn on_term(_: libc::c_int) {
    TERM.store(true, Ordering::SeqCst);
}

fn run_daemon(session: &str, cdp: Option<String>, pin: bool) -> ! {
    let config = Config::from_env(session, cdp.clone(), pin);
    let daemon = match Daemon::start(config) {
        Ok(d) => d,
        Err(e) => {
            update_state(session, |st| {
                st.insert("startError".into(), Value::String(e.clone()));
                st.remove("pid");
            });
            err_out(&format!("start failed: {e}"));
            std::process::exit(1)
        }
    };
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(l) => l,
        Err(e) => {
            err_out(&e.to_string());
            std::process::exit(1)
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let key = token();
    *daemon.own_port.lock().unwrap() = port;
    update_state(session, |st| {
        st.insert("session".into(), json!(session));
        st.insert("pid".into(), json!(std::process::id()));
        st.insert("cdp".into(), cdp.clone().map(Value::String).unwrap_or(Value::Null));
        st.remove("startError");
        st.insert("started".into(), json!(now_ms()));
        st.insert("port".into(), json!(port));
        st.insert("token".into(), json!(key));
    });

    #[cfg(unix)]
    unsafe {
        libc::signal(libc::SIGTERM, on_term as *const () as libc::sighandler_t);
        libc::signal(libc::SIGPIPE, libc::SIG_IGN);
    }

    let d = daemon.clone();
    let name = session.to_string();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        if TERM.load(Ordering::SeqCst) {
            d.shutdown(0);
        }
        d.idle_check();
        // the state file no longer names this daemon's port (removed or taken over): it is no longer reachable
        let own = *d.own_port.lock().unwrap() as i64;
        if own == 0 || read_state(&name).int("port") != Some(own) {
            *d.own_port.lock().unwrap() = 0;
            d.later(|d| d.shutdown(0));
        }
    });
    for conn in listener.incoming() {
        let Ok(mut c) = conn else {
            sleep_ms(50.0);
            continue;
        };
        let d = daemon.clone();
        let (cdp, key) = (cdp.clone(), key.clone());
        std::thread::spawn(move || {
            let _ = c.set_read_timeout(Some(Duration::from_secs(30)));
            let Some(msg) = read_line(&c) else { return };
            if msg.str("token") != Some(key.as_str()) {
                write_line(&mut c, &json!({ "success": false, "error": "not this session's key" }));
                return;
            }
            let req_cdp = msg.str("cdp").map(String::from);
            if req_cdp != cdp || msg.bool("pin").unwrap_or(pin) != pin {
                // the caller wants another browser (the app restarted it elsewhere): make way
                d.release_port();
                write_line(&mut c, &json!({ "restart": true }));
                let _g = d.q.lock().unwrap_or_else(|e| e.into_inner());
                d.shutdown(0);
            }
            let args = msg.arr("args").map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
            let req = Request { args, cwd: msg.str("cwd").unwrap_or("/").into(), stdin: msg.str("stdin").map(String::from) };
            let reply = whole(d.handle(req));
            let _ = c.set_write_timeout(Some(Duration::from_secs(60)));
            write_line(&mut c, &reply);
        });
    }
    std::process::exit(0)
}

// ───────────── the CLI side ─────────────

struct Client {
    session: String,
    cdp: Option<String>,
    pin: bool,
}

fn pid_alive(pid: i64) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
            if h.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code) != 0 && code == STILL_ACTIVE as u32;
            CloseHandle(h);
            ok
        }
    }
}

/// The session's daemon: its port and key, while it runs.
fn endpoint(session: &str) -> Option<(u16, String)> {
    let st = read_state(session);
    let (port, key, pid) = (st.int("port")?, st.str("token")?.to_string(), st.int("pid")?);
    pid_alive(pid).then_some((port as u16, key))
}

fn connect(session: &str) -> Option<(TcpStream, String)> {
    let (port, key) = endpoint(session)?;
    let s = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2)).ok()?;
    Some((s, key))
}

/// Start the daemon with nothing of ours: on Windows, a child inherits every inheritable handle
/// (rust-lang/rust#38227), and a daemon holding the CLI's stdout keeps the caller's pipe open.
#[cfg(windows)]
fn keep_std_handles_to_ourselves() {
    use windows_sys::Win32::Foundation::{SetHandleInformation, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::System::Console::{GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    for h in [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
        unsafe {
            let handle = GetStdHandle(h);
            if !handle.is_null() {
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
            }
        }
    }
}

impl Client {
    fn running(&self) -> bool {
        connect(&self.session).is_some()
    }

    /// Start the session's daemon if it is not running (one at a time per session).
    fn ensure(&self) -> Res<()> {
        if self.running() {
            return Ok(());
        }
        let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(lock_path(&self.session)).ok();
        if let Some(l) = &lock {
            let _ = l.lock();
        }
        if self.running() {
            return Ok(());
        }
        update_state(&self.session, |st| {
            st.remove("startError");
        });
        // the log keeps the last daemon's end (why it stopped) unless it grew large
        let logp = log_path(&self.session);
        let big = std::fs::metadata(&logp).map(|m| m.len() > 1 << 20).unwrap_or(false);
        let logf = std::fs::OpenOptions::new().create(true).append(!big).write(true).truncate(big).open(&logp).map_err(|e| e.to_string())?;
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let mut cmd = std::process::Command::new(&exe);
        cmd.args(["__daemon", &self.session, self.cdp.as_deref().unwrap_or(""), if self.pin { "1" } else { "0" }])
            .stdin(std::process::Stdio::null())
            .stdout(logf.try_clone().map_err(|e| e.to_string())?)
            .stderr(logf);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            keep_std_handles_to_ourselves();
            cmd.creation_flags(0x0800_0000 | 0x0000_0200); // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
        }
        let mut child = cmd.spawn().map_err(|e| format!("could not start the session: {e}"))?;
        let until = now_ms() + 45000.0;
        while now_ms() < until {
            if self.running() {
                // the daemon goes on by itself; nobody waits for it
                std::thread::spawn(move || child.wait());
                return Ok(());
            }
            if let Ok(Some(_)) = child.try_wait() {
                let why = read_state(&self.session)
                    .str("startError")
                    .map(String::from)
                    .or_else(|| std::fs::read_to_string(&logp).ok().and_then(|t| t.lines().filter(|l| !l.is_empty()).last().map(String::from)))
                    .unwrap_or_else(|| "it exited".into());
                return Err(format!("the browser session could not start: {why}"));
            }
            sleep_ms(40.0);
        }
        Err("the browser session did not start within 45 s".into())
    }

    fn send(&self, msg: &Json) -> Res<Json> {
        for attempt in 0..2 {
            self.ensure()?;
            let Some((mut s, key)) = connect(&self.session) else { continue };
            let _ = s.set_read_timeout(Some(Duration::from_secs(900)));
            let mut m = msg.clone();
            m.insert("token".into(), Value::String(key));
            if !write_line(&mut s, &Value::Object(m)) {
                continue;
            }
            let Some(reply) = read_line(&s) else {
                return Err("no response came back from the browser session (it may have stopped); try again".into());
            };
            if reply.bool("restart") == Some(true) && attempt == 0 {
                // the old daemon is going away; wait for it to go
                let until = now_ms() + 5000.0;
                while self.running() && now_ms() < until {
                    sleep_ms(50.0);
                }
                continue;
            }
            return Ok(reply);
        }
        Err("Failed to read from the browser session; try again".into())
    }

    fn send_if_running(&self, msg: &Json) -> Option<Json> {
        let (mut s, key) = connect(&self.session)?;
        let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
        let mut m = msg.clone();
        m.insert("cdp".into(), read_state(&self.session).get("cdp").cloned().filter(|v| v.is_string()).unwrap_or(Value::Null));
        m.insert("pin".into(), Value::Null);
        m.insert("cwd".into(), json!("/"));
        m.insert("token".into(), Value::String(key));
        write_line(&mut s, &Value::Object(m));
        read_line(&s)
    }
}

fn live_sessions() -> Vec<String> {
    let mut names = Vec::new();
    for e in std::fs::read_dir(base_dir()).into_iter().flatten().flatten() {
        let f = e.file_name().to_string_lossy().to_string();
        if !f.ends_with(".json") {
            continue;
        }
        let Some(st) = std::fs::read(e.path()).ok().and_then(|d| serde_json::from_slice::<Json>(&d).ok()) else { continue };
        let Some(name) = st.str("session") else { continue };
        if connect(name).is_some() {
            names.push(name.to_string());
        }
    }
    names.sort();
    names
}

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(String::as_str) == Some("__daemon") && argv.len() >= 4 {
        let cdp = Some(argv[2].clone()).filter(|c| !c.is_empty());
        run_daemon(&argv[1].clone(), cdp, argv[3] == "1");
    }
    let env = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
    let mut json = false;
    let mut session = env("ONDRA_BROWSER_SESSION").unwrap_or_else(|| "default".into());
    let mut cdp = env("ONDRA_BROWSER_CDP");
    let mut pin = ["1", "true", "yes"].contains(&env("ONDRA_BROWSER_PIN_TAB").unwrap_or_default().to_lowercase().as_str());
    let mut words = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        match a {
            "--json" => json = true,
            "--session" if i + 1 < argv.len() => {
                session = argv[i + 1].clone();
                i += 1;
            }
            "--cdp" if i + 1 < argv.len() => {
                cdp = Some(argv[i + 1].clone());
                i += 1;
            }
            "--no-pin-tab" => pin = false,
            "--pin-tab" => pin = true,
            _ => words.push(a.to_string()),
        }
        i += 1;
    }
    argv = words;
    if argv.is_empty() || ["--help", "-h", "help"].contains(&argv[0].as_str()) {
        out(HELP);
        return 0;
    }
    if ["--version", "-V", "version"].contains(&argv[0].as_str()) {
        out(&if json { json_string(&json!({ "success": true, "data": { "version": VERSION }, "error": null })) } else { format!("ondra-browser {VERSION}") });
        return 0;
    }
    if argv.len() >= 2 && (argv.iter().any(|a| a == "--help") || argv.last().map(String::as_str) == Some("-h")) {
        let u = usage(&argv[0]).map(String::from).unwrap_or_else(|| format!("{} … (ondra-browser --help lists every command)", argv[0]));
        out(&format!("usage: ondra-browser {u}"));
        return 0;
    }

    let finish = |ok: bool, data: Value, text: &str, error: Option<&str>| -> i32 {
        if json {
            out(&json_string(&json!({ "success": ok, "data": if ok { data } else { Value::Null }, "error": error })));
        } else if ok {
            out(text);
        } else {
            err_out(&format!("✗ {}", error.unwrap_or("failed")));
        }
        if ok {
            0
        } else {
            1
        }
    };

    let client = Client { session: session.clone(), cdp: cdp.clone(), pin };
    let cmd = argv[0].as_str();
    let sub = argv.get(1).map(String::as_str).unwrap_or("");

    // answered without starting anything
    if cmd == "session" && (sub == "list" || sub == "ls") {
        let names = live_sessions();
        return finish(true, json!({ "sessions": names }), &names.join("\n"), None);
    }
    if cmd == "close" && argv.iter().any(|a| a == "--all") {
        for name in live_sessions() {
            let _ = Client { session: name, cdp: None, pin: false }.send_if_running(&obj!({ "args": ["close"] }));
        }
        return finish(true, json!({ "closed": true }), "✓ Closed every session", None);
    }
    if !client.running() {
        if cmd == "close" {
            return finish(true, json!({ "closed": true }), "✓ Session closed", None);
        }
        if cmd == "session" {
            return finish(true, json!({ "session": session, "active": false, "pid": null }), &format!("no session {session} running"), None);
        }
        if cmd == "stream" && (sub == "status" || sub.is_empty()) {
            return finish(true, json!({ "enabled": false, "connected": false, "port": null }), "not streaming (no session running)", None);
        }
    }

    let wants_stdin = (cmd == "batch" && !argv.iter().skip(1).any(|a| !a.starts_with("--"))) || (cmd == "eval" && argv.iter().any(|a| a == "--stdin"));
    let mut stdin_text = None;
    if wants_stdin && !std::io::stdin().is_terminal() {
        let mut s = String::new();
        let _ = std::io::stdin().read_to_string(&mut s);
        stdin_text = Some(s);
    }
    let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "/".into());
    let msg = obj!({ "args": argv, "cwd": cwd, "stdin": stdin_text, "cdp": cdp, "pin": pin });
    let reply = match client.send(&msg) {
        Ok(r) => r,
        Err(e) => return finish(false, Value::Null, "", Some(&e)),
    };
    let ok = reply.bool("success") == Some(true);
    if reply.bool("batch") == Some(true) {
        if json {
            out(&json_string(reply.get("data").unwrap_or(&json!([]))));
        } else {
            out(reply.str("text").unwrap_or_default());
        }
        return if ok { 0 } else { 1 };
    }
    finish(ok, reply.get("data").cloned().unwrap_or(Value::Null), reply.str("text").unwrap_or_default(), reply.str("error"))
}
