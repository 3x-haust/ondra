// browse: drive this job's browser tab in few, small, fast steps (ondra-browser underneath).
//
// The same tool as skills/browser-use/browse (Python), for Windows, where Python may be
// missing: the same commands, output and state file. Keep the two in step.

use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const DOC: &str = r#"browse: drive this job's browser tab in few, small, fast steps (ondra-browser underneath).

  browse open <url>              load light, wait for it to settle, then `look`        (one call)
  browse look [-s css] [--all] [--urls]
                                 the page's controls, lean: refs, roles, names, values;
                                 header/nav/footer link lists folded
  browse read [<url>] [css] [--section <heading>] [--outline] [--links] [--max <chars>]
                                 the main content as markdown (no menus, ads, footers);
                                 with a url, opens it first (light), all in one call
  browse do "<cmd>" ["<cmd>" ...] [--read [read options]]
                                 ondra-browser commands in one batch (stops at the first
                                 failure), wait for the page to settle, then `look` (on the
                                 same page only what changed), or `read` with --read
  browse visuals on|off          on: images, fonts, media, ads and animations come back
                                 (reloads the page); off: blocked again from the next page
  browse shot <file.png> [--full]
                                 a screenshot with visuals on (turns them on first)

Light is the default: images, media, fonts and ad/tracker requests are blocked and
motion is reduced in this tab only (other jobs and the app's browser panel are not
touched). Uses ONDRA_BROWSER_* from the environment, like plain ondra-browser."#;

const READ_JS: &str = include_str!("../../skills/browser-use/read.js");
const NET_JS: &str = include_str!("../../skills/browser-use/net.js");

// Blocked in light mode. Ads and trackers only: nothing a page needs to work.
const TRACKERS: &[&str] = &[
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "google-analytics.com", "googletagmanager.com", "amazon-adsystem.com", "adnxs.com", "criteo.com", "criteo.net", "taboola.com", "outbrain.com",
    "scorecardresearch.com", "chartbeat.com", "hotjar.com", "clarity.ms", "quantserve.com", "moatads.com", "adsrvr.org", "rubiconproject.com", "pubmatic.com", "permutive.app", "segment.io",
];

// Waits until the page stops changing: no DOM change for 300 ms, no fetch/XHR still
// open (net.js counts them), at most 4 s. In light mode also makes CSS motion instant.
const SETTLE: &str = r#"(async (light) => {
  const t0 = performance.now(); let last = t0;
  const mo = new MutationObserver(() => { last = performance.now(); });
  mo.observe(document.documentElement || document, { subtree: true, childList: true, characterData: true });
  const open = () => (window.__browseNet ? window.__browseNet.open : 0);
  while (performance.now() - t0 < 4000) {
    await new Promise((r) => setTimeout(r, 50));
    if (document.readyState !== "loading" && open() === 0 && performance.now() - last >= 300) break;
  }
  mo.disconnect();
  if (light && document.head && !document.getElementById("__browse_light")) {
    const s = document.createElement("style"); s.id = "__browse_light";
    s.textContent = "*,*::before,*::after{animation-duration:.01ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:.01ms!important;transition-delay:0s!important;scroll-behavior:auto!important}";
    document.head.appendChild(s);
  }
  return location.href;
})(%s)"#;

type Cmd = Vec<String>;
/// (command, ok, result | error)
type Row = (Cmd, bool, Value);

fn cmd(words: &[&str]) -> Cmd {
    words.iter().map(|w| w.to_string()).collect()
}

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1)
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

fn ab() -> String {
    env("BROWSE_BIN").unwrap_or_else(|| "ondra-browser".into())
}

fn state_dir() -> PathBuf {
    env("APP_SCRATCH_DIR").or_else(|| env("TMPDIR")).map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join(".browse")
}

fn state_path() -> PathBuf {
    let session = env("ONDRA_BROWSER_SESSION").unwrap_or_else(|| "default".into());
    let safe: String = session.chars().map(|c| if c.is_alphanumeric() || c == '_' || c == '.' || c == '-' { c } else { '_' }).collect();
    state_dir().join(format!("{safe}.json"))
}

type State = Map<String, Value>;

fn load_state() -> State {
    std::fs::read(state_path()).ok().and_then(|d| serde_json::from_slice(&d).ok()).unwrap_or_default()
}

fn save_state(st: &State) {
    let _ = std::fs::create_dir_all(state_dir());
    let _ = std::fs::write(state_path(), serde_json::to_string(st).unwrap_or_default());
}

fn routes() -> Vec<Cmd> {
    let mut r = vec![cmd(&["network", "route", "*", "--abort", "--resource-type", "image,media,font"])];
    for d in TRACKERS {
        r.push(vec!["network".into(), "route".into(), format!("*://*{d}/*"), "--abort".into()]);
    }
    r
}

/// Run commands in one ondra-browser call.
fn batch(cmds: &[Cmd], bail: bool) -> Vec<Row> {
    let mut args = vec!["batch", "--json"];
    if bail {
        args.push("--bail");
    }
    let t = std::time::Instant::now();
    let mut child = Command::new(ab()).args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap_or_else(|e| die(&format!("ondra-browser could not start: {e}")));
    if let Some(mut i) = child.stdin.take() {
        let _ = i.write_all(serde_json::to_string(cmds).unwrap_or_default().as_bytes());
    }
    let out = child.wait_with_output().unwrap_or_else(|e| die(&e.to_string()));
    if env("BROWSE_DEBUG").is_some() {
        let what: Vec<String> = cmds.iter().map(|c| c.join(" ").chars().take(40).collect()).collect();
        eprintln!("[{:.2}s] {}", t.elapsed().as_secs_f64(), what.join(" | ").chars().take(300).collect::<String>());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let Ok(Value::Array(rows)) = serde_json::from_str::<Value>(&stdout) else {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let msg = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            "ondra-browser gave no answer".into()
        };
        eprintln!("{msg}");
        std::process::exit(out.status.code().filter(|c| *c != 0).unwrap_or(1));
    };
    rows.into_iter()
        .map(|r| {
            let c: Cmd = r.get("command").and_then(|c| c.as_array()).map(|a| a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()).unwrap_or_default();
            let error = r.get("error").cloned().unwrap_or(Value::Null);
            let ok = r.get("success").and_then(|s| s.as_bool()).unwrap_or(error.is_null());
            let res = if error.is_null() { r.get("result").cloned().unwrap_or(Value::Null) } else { error };
            (c, ok, res)
        })
        .collect()
}

fn settle_cmd(st: &State) -> Cmd {
    let visual = st.get("visual").and_then(|v| v.as_bool()).unwrap_or(false);
    vec!["eval".into(), SETTLE.replace("%s", if visual { "false" } else { "true" })]
}

fn daemon_pid() -> Value {
    let out = Command::new(ab()).args(["session", "info", "--json"]).stdin(Stdio::null()).stderr(Stdio::null()).output();
    out.ok().and_then(|o| serde_json::from_slice::<Value>(&o.stdout).ok()).and_then(|v| v.get("data").and_then(|d| d.get("pid")).cloned()).unwrap_or(Value::Null)
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// What this tab's session needs once per session daemon: light mode's routes and reduced
/// motion. Returns (commands to run first, the open command for `url`).
fn setup(st: &mut State, url: Option<&str>) -> (Vec<Cmd>, Option<Cmd>) {
    let pid = daemon_pid();
    if !truthy(&pid) && std::env::var_os("ONDRA_BROWSER_INIT_SCRIPTS").is_none() {
        // the app sets this for every job; without it, a daemon this call starts gets net.js
        let p = state_dir().join("net.js");
        let _ = std::fs::create_dir_all(state_dir());
        if std::fs::write(&p, NET_JS).is_ok() {
            std::env::set_var("ONDRA_BROWSER_INIT_SCRIPTS", p);
        }
    }
    let visual = st.get("visual").map(truthy).unwrap_or(false);
    let mut cmds = Vec::new();
    if !visual && !(truthy(&pid) && st.get("light_pid") == Some(&pid)) {
        st.insert("pending".into(), json!(true));
        cmds = vec![cmd(&["network", "unroute"]), cmd(&["set", "media", "reduced-motion"])];
        cmds.extend(routes());
    }
    (cmds, url.map(|u| cmd(&["open", u, "--wait-until", "domcontentloaded"])))
}

fn setup_done(st: &mut State) {
    let pending = st.remove("pending").map(|v| truthy(&v)).unwrap_or(false);
    if pending && !st.get("visual").map(truthy).unwrap_or(false) {
        st.insert("light_pid".into(), daemon_pid());
    }
}

// ───────────── look: the snapshot without the decoration ─────────────

const INTERACTIVE: &[&str] = &["link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "DisclosureTriangle"];
const PROSE: &[&str] = &["paragraph", "cell", "definition", "term", "blockquote", "emphasis", "strong", "code", "Abbr", "superscript", "subscript", "mark", "time", "LabelText", "caption", "Figcaption"];
const CHROME: &[&str] = &["header", "nav", "footer", "aside"];
const FLAGS: &[&str] = &["checked", "selected", "expanded", "pressed", "disabled", "required", "invalid", "readonly"];

fn landmark(role: &str) -> Option<&'static str> {
    Some(match role {
        "banner" => "header",
        "navigation" => "nav",
        "contentinfo" => "footer",
        "complementary" => "aside",
        "main" => "main",
        "search" => "search",
        "dialog" | "alertdialog" => "dialog",
        _ => return None,
    })
}

#[derive(Clone, PartialEq)]
enum Attr {
    Flag,
    Val(String),
}

struct Node {
    role: String,
    name: String,
    attrs: Vec<(String, Attr)>,
    rest: String,
    kids: Vec<usize>,
    parent: Option<usize>,
}

impl Node {
    fn attr(&self, k: &str) -> Option<&Attr> {
        // the last one wins, as in a dict
        self.attrs.iter().rev().find(|(n, _)| n == k).map(|(_, v)| v)
    }
    fn has(&self, k: &str) -> bool {
        self.attr(k).is_some()
    }
    fn reff(&self) -> Option<String> {
        match self.attr("ref") {
            Some(Attr::Val(v)) => Some(v.clone()),
            Some(Attr::Flag) => Some("True".into()),
            None => None,
        }
    }
    fn level(&self) -> usize {
        match self.attr("level") {
            Some(Attr::Val(v)) if !v.is_empty() => v.parse().unwrap_or(2),
            Some(Attr::Flag) => 1,
            _ => 2,
        }
    }
}

struct Tree {
    n: Vec<Node>,
}

/// One snapshot line: `- role "name" [attrs]rest` (the Python tool's regex, by hand).
fn parse_line(raw: &str) -> Option<(usize, String, String, String, String)> {
    let ind = raw.chars().take_while(|c| c.is_whitespace()).count();
    let s: String = raw.chars().skip(ind).collect();
    let s = s.strip_prefix("- ")?;
    let role: String = s.chars().take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-').collect();
    if role.is_empty() {
        return None;
    }
    let mut rest = &s[role.len()..];
    let mut name = String::new();
    if let Some(r) = rest.strip_prefix(" \"") {
        // up to the first unescaped quote
        let mut end = None;
        let mut esc = false;
        for (i, c) in r.char_indices() {
            if esc {
                esc = false;
                continue;
            }
            if c == '\\' {
                esc = true;
            } else if c == '"' {
                end = Some(i);
                break;
            }
        }
        if let Some(e) = end {
            name = r[..e].to_string();
            rest = &r[e + 1..];
        }
    }
    let mut attrs = String::new();
    if let Some(r) = rest.strip_prefix(" [") {
        if let Some(e) = r.find(']') {
            attrs = r[..e].to_string();
            rest = &r[e + 1..];
        }
    }
    Some((ind, role, name, attrs, rest.to_string()))
}

fn parse(text: &str) -> Tree {
    let mut t = Tree { n: vec![Node { role: "root".into(), name: String::new(), attrs: vec![], rest: String::new(), kids: vec![], parent: None }] };
    let mut stack: Vec<(i64, usize)> = vec![(-1, 0)];
    for raw in text.lines() {
        let Some((ind, role, name, attrs, rest)) = parse_line(raw) else { continue };
        let a: Vec<(String, Attr)> = if attrs.is_empty() {
            vec![]
        } else {
            attrs
                .split(", ")
                .map(|part| match part.split_once('=') {
                    Some((k, v)) => (k.trim().to_string(), Attr::Val(v.to_string())),
                    None => (part.trim().to_string(), Attr::Flag),
                })
                .collect()
        };
        while stack.last().is_some_and(|l| l.0 >= ind as i64) {
            stack.pop();
        }
        let parent = stack.last().map(|l| l.1).unwrap_or(0);
        let id = t.n.len();
        t.n.push(Node { role, name: name.replace("\\\"", "\""), attrs: a, rest, kids: vec![], parent: Some(parent) });
        t.n[parent].kids.push(id);
        stack.push((ind as i64, id));
    }
    t
}

fn squash(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(s: &str, n: usize) -> String {
    let s = squash(s);
    if s.chars().count() <= n {
        s
    } else {
        s.chars().take(n - 1).collect::<String>() + "…"
    }
}

impl Tree {
    fn text_of(&self, id: usize, limit: usize) -> String {
        let mut out: Vec<String> = Vec::new();
        fn walk(t: &Tree, x: usize, out: &mut Vec<String>, limit: usize) {
            if out.iter().map(|s| s.chars().count()).sum::<usize>() > limit {
                return;
            }
            let n = &t.n[x];
            if n.role == "StaticText" && !n.name.is_empty() {
                out.push(n.name.clone());
            }
            for &k in &n.kids {
                walk(t, k, out, limit);
            }
        }
        walk(self, id, &mut out, limit);
        squash(&out.join(" "))
    }

    fn interactive(&self, id: usize) -> bool {
        let n = &self.n[id];
        if INTERACTIVE.contains(&n.role.as_str()) && n.has("ref") {
            return true;
        }
        n.role == "generic" && n.has("ref") && n.rest.contains("clickable")
    }

    fn descendants(&self, id: usize, role: &str, out: &mut Vec<usize>) {
        for &k in &self.n[id].kids {
            if self.n[k].role == role {
                out.push(k);
            } else {
                self.descendants(k, role, out);
            }
        }
    }
}

#[derive(Clone, PartialEq)]
enum Kind {
    Text,
    Alert,
    Heading,
    Control,
}

#[derive(Clone)]
struct Item {
    reg: String,
    kind: Kind,
    /// heading/text: the text; control: (role, name)
    text: String,
    role: String,
    reff: Option<String>,
    extra: String,
    prose: bool,
}

impl Item {
    fn key(&self) -> (String, String, String) {
        (self.reg.clone(), self.role.clone(), self.text.clone())
    }
}

fn starts_with_any(s: &str, p: &[&str]) -> bool {
    p.iter().any(|x| s.starts_with(x))
}

/// Fold the snapshot into the lines a model needs to act on the page.
fn lean(text: &str, all: bool, urls: bool) -> Vec<String> {
    let t = parse(text);
    let mut items: Vec<Item> = Vec::new();

    fn walk(t: &Tree, id: usize, region: &str, inter: &HashSet<String>, items: &mut Vec<Item>, urls: bool) {
        let n = &t.n[id];
        let mut role = n.role.clone();
        let reg = landmark(&role).map(String::from).unwrap_or_else(|| region.to_string());
        let with = |extra: &str| -> HashSet<String> {
            let mut s = inter.clone();
            s.insert(extra.to_string());
            s
        };
        if ["image", "img", "ListMarker", "StaticText", "LineBreak"].contains(&role.as_str()) && !t.interactive(id) {
            if role == "StaticText" && region == "dialog" && !n.name.trim().is_empty() {
                items.push(Item { reg, kind: Kind::Text, text: clip(&n.name, 160), role: String::new(), reff: None, extra: String::new(), prose: false });
            }
            return;
        }
        if (role == "alert" || role == "status") && !t.text_of(id, 80).is_empty() {
            items.push(Item { reg: reg.clone(), kind: Kind::Alert, text: clip(&t.text_of(id, 200), 200), role: String::new(), reff: None, extra: String::new(), prose: false });
        }
        if role == "heading" && !CHROME.contains(&reg.as_str()) {
            let name = if n.name.is_empty() { t.text_of(id, 80) } else { n.name.clone() };
            let kid = n.kids.iter().copied().find(|&k| t.n[k].role == "link" && t.n[k].has("ref"));
            if !name.is_empty() {
                items.push(Item { reg: reg.clone(), kind: Kind::Heading, text: clip(&name, 120), role: String::new(), reff: kid.and_then(|k| t.n[k].reff()), extra: "#".repeat(n.level()), prose: false });
            }
            let next = with(&name);
            for &k in &n.kids {
                if Some(k) != kid {
                    walk(t, k, &reg, &next, items, urls);
                }
            }
            return;
        }
        if t.interactive(id) {
            let mut name = n.name.clone();
            if name.is_empty() {
                name = t.text_of(id, 60);
            }
            if name.is_empty() {
                name = n.kids.iter().map(|&k| &t.n[k]).find(|k| (k.role == "image" || k.role == "img") && !k.name.is_empty()).map(|k| k.name.clone()).unwrap_or_default();
            }
            if role == "generic" {
                if name.is_empty() {
                    return;
                }
                role = "clickable".into();
            }
            let hk = if role == "link" { n.kids.iter().copied().find(|&k| t.n[k].role == "heading") } else { None };
            if let Some(h) = hk {
                let hn = &t.n[h];
                let hname = if hn.name.is_empty() { t.text_of(h, 80) } else { hn.name.clone() };
                if !CHROME.contains(&reg.as_str()) && clip(&hname, 120) == clip(&name, 120) {
                    // a link around a heading (a result's title): the heading, with the link's ref
                    items.push(Item { reg: reg.clone(), kind: Kind::Heading, text: clip(&name, 120), role: String::new(), reff: n.reff(), extra: "#".repeat(hn.level()), prose: false });
                    let next = with(&name);
                    for &k in &n.kids {
                        if k != h {
                            walk(t, k, &reg, &next, items, urls);
                        }
                    }
                    return;
                }
            }
            if inter.contains(&name) && ["button", "link", "clickable", "DisclosureTriangle"].contains(&role.as_str()) {
                // a button inside a link of the same name: one control
                for &k in &n.kids {
                    walk(t, k, &reg, inter, items, urls);
                }
                return;
            }
            let mut flags: Vec<String> = FLAGS
                .iter()
                .filter(|f| n.has(f))
                .map(|f| match n.attr(f) {
                    Some(Attr::Flag) => f.to_string(),
                    Some(Attr::Val(v)) if v == "true" => f.to_string(),
                    _ => format!("{f}=false"),
                })
                .collect();
            flags.retain(|f| !f.ends_with("=false") || starts_with_any(f, &["checked", "pressed"]) || (f.starts_with("expanded") && role != "combobox"));
            let v = n.rest.trim();
            let value = v.strip_prefix(':').map(|x| x.trim().to_string()).unwrap_or_default();
            let mut extra = String::new();
            let mut skip_kids = false;
            let mut opts = Vec::new();
            if role == "combobox" {
                t.descendants(id, "option", &mut opts);
            }
            if role == "combobox" && !opts.is_empty() {
                let names: Vec<String> = opts.iter().map(|&k| clip(&t.n[k].name, 40) + if t.n[k].has("selected") { "*" } else { "" }).collect();
                extra = format!(" options: {}", names.iter().take(30).cloned().collect::<Vec<_>>().join(", "));
                if names.len() > 30 {
                    extra += &format!(" +{}", names.len() - 30);
                }
                skip_kids = true;
            }
            if !flags.is_empty() {
                extra = format!(" [{}]{extra}", flags.join(", "));
            }
            if !value.is_empty() && value != name {
                extra += &format!(" = {}", clip(&value, 80));
            }
            if urls && role == "link" {
                if let Some(Attr::Val(u)) = n.attr("url").filter(|u| *u != &Attr::Val(String::new())) {
                    extra += &format!(" -> {u}");
                }
            }
            // a link in running text (a paragraph, a table cell) rather than a menu or a list of links
            let prose = role == "link"
                && n.parent.is_some_and(|p| {
                    let p = &t.n[p];
                    PROSE.contains(&p.role.as_str()) || (p.role == "listitem" && p.kids.iter().any(|&k| t.n[k].role == "StaticText" && !t.n[k].name.trim().is_empty()))
                });
            items.push(Item { reg: reg.clone(), kind: Kind::Control, text: clip(&name, 90), role: role.clone(), reff: n.reff(), extra, prose });
            if !skip_kids {
                let next = with(&name);
                for &k in &n.kids {
                    walk(t, k, &reg, &next, items, urls);
                }
            }
            return;
        }
        for &k in &n.kids {
            walk(t, k, &reg, inter, items, urls);
        }
    }

    walk(&t, 0, "", &HashSet::new(), &mut items, urls);
    if !all {
        // the same control again and again (a "Copy" button per code block): the first two, then a count
        let mut seen: HashMap<(String, String, String), usize> = HashMap::new();
        let mut kept = Vec::new();
        for it in items {
            if it.kind == Kind::Control && !it.prose {
                let c = seen.entry(it.key()).or_default();
                *c += 1;
                if *c > 2 {
                    continue;
                }
            }
            kept.push(it);
        }
        items = kept
            .into_iter()
            .map(|mut it| {
                let n = seen.get(&it.key()).copied().unwrap_or(0);
                if it.kind == Kind::Control && n > 2 && it.extra.is_empty() {
                    it.extra = format!(" (+{} alike)", n - 1);
                }
                it
            })
            .collect();
        // keep the "(+N alike)" note on the first of the repeated controls only
        let mut noted = HashSet::new();
        for it in items.iter_mut() {
            if it.kind == Kind::Control && it.extra.starts_with(" (+") && it.extra.ends_with(" alike)") {
                let k = it.key();
                if noted.contains(&k) {
                    it.extra.clear();
                }
                noted.insert(k);
            }
        }
    }

    let mut out: Vec<String> = Vec::new();
    let mut last_reg: Option<String> = None;
    let mut prose_run: Vec<String> = Vec::new();
    let flush = |out: &mut Vec<String>, run: &mut Vec<String>| {
        if run.is_empty() {
            return;
        }
        let cap = if all { run.len() } else { 6 };
        let more = if run.len() > cap { format!(" | +{} (look --all)", run.len() - cap) } else { String::new() };
        out.push(format!("in text: {}{more}", run.iter().take(cap).cloned().collect::<Vec<_>>().join(" | ")));
        run.clear();
    };
    let mut i = 0;
    while i < items.len() {
        let it = items[i].clone();
        if last_reg.as_deref() != Some(it.reg.as_str()) {
            flush(&mut out, &mut prose_run);
            out.push(format!("[{}]", if it.reg.is_empty() { "page" } else { &it.reg }));
            last_reg = Some(it.reg.clone());
        }
        match it.kind {
            Kind::Heading => {
                if it.extra.len() > 3 && !all {
                    i += 1;
                    continue;
                }
                flush(&mut out, &mut prose_run);
                out.push(format!("{} {}{}", it.extra, it.text, it.reff.as_ref().map(|r| format!(" @{r}")).unwrap_or_default()));
                i += 1;
                continue;
            }
            Kind::Text | Kind::Alert => {
                out.push(format!("{}{}", if it.kind == Kind::Alert { "! " } else { "" }, it.text));
                i += 1;
                continue;
            }
            Kind::Control => {}
        }
        let (role, name, r) = (it.role.clone(), it.text.clone(), it.reff.clone().unwrap_or_default());
        if it.prose && it.extra.is_empty() {
            if !prose_run.iter().any(|x| x.starts_with(&format!("{name} @"))) {
                prose_run.push(format!("{name} @{r}"));
            }
            i += 1;
            continue;
        }
        let mut j = i;
        // a run of links/buttons with the same state on one line
        if ["link", "button", "tab", "menuitem", "option", "clickable", "DisclosureTriangle"].contains(&role.as_str()) && (it.extra.is_empty() || it.extra.starts_with(" [")) && !it.extra.replace("=false", "").contains('=') {
            while j + 1 < items.len() && items[j + 1].reg == it.reg && items[j + 1].kind == Kind::Control && items[j + 1].role == role && items[j + 1].extra == it.extra && !items[j + 1].prose {
                j += 1;
            }
        }
        if j - i >= 2 {
            let run: Vec<String> = (i..=j).map(|k| format!("{} @{}", items[k].text, items[k].reff.clone().unwrap_or_default())).collect();
            let cap = if all {
                run.len()
            } else if CHROME.contains(&it.reg.as_str()) {
                8
            } else {
                15
            };
            let more = if run.len() > cap { format!(" | +{} more (look --all)", run.len() - cap) } else { String::new() };
            out.push(format!("{role}s{}: {}{more}", it.extra, run.iter().take(cap).cloned().collect::<Vec<_>>().join(" | ")));
            i = j + 1;
            continue;
        }
        out.push(if name.is_empty() { format!("{role} @{r}{}", it.extra) } else { format!("{role} \"{name}\" @{r}{}", it.extra) });
        i += 1;
    }
    flush(&mut out, &mut prose_run);
    out
}

fn snap_lines(result: &Value, all: bool, urls: bool) -> Vec<String> {
    match result.as_object() {
        Some(o) => lean(o.get("snapshot").and_then(|s| s.as_str()).unwrap_or_default(), all, urls),
        None => vec![py_str(result)],
    }
}

fn is_marker(line: &str) -> bool {
    line.starts_with('[') && line.ends_with(']') && !line.contains(' ')
}

/// [(region marker, [lines])] in order.
fn blocks(lines: &[String]) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    for line in lines {
        if is_marker(line) {
            out.push((line.clone(), vec![]));
        } else if let Some(l) = out.last_mut() {
            l.1.push(line.clone());
        } else {
            out.push(("[page]".into(), vec![line.clone()]));
        }
    }
    out
}

fn no_refs(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|x| {
            let mut s = String::new();
            let mut rest = x.as_str();
            while let Some(p) = rest.find(" @e") {
                let digits = rest[p + 3..].chars().take_while(|c| c.is_ascii_digit()).count();
                if digits == 0 {
                    s += &rest[..p + 3];
                    rest = &rest[p + 3..];
                    continue;
                }
                s += &rest[..p];
                rest = &rest[p + 3 + digits..];
            }
            s + rest
        })
        .collect()
}

fn host(url: &str) -> String {
    let Some(p) = url.find("://") else { return String::new() };
    if p == 0 || !url[..p].chars().all(|c| c.is_alphanumeric() || c == '_') {
        return String::new();
    }
    url[p + 3..].split('/').next().unwrap_or_default().to_string()
}

// difflib.SequenceMatcher (no junk, no autojunk): the opcodes Python's look diff uses.
fn matching_blocks(a: &[String], b: &[String]) -> Vec<(usize, usize, usize)> {
    let mut b2j: HashMap<&str, Vec<usize>> = HashMap::new();
    for (j, x) in b.iter().enumerate() {
        b2j.entry(x.as_str()).or_default().push(j);
    }
    let longest = |alo: usize, ahi: usize, blo: usize, bhi: usize| -> (usize, usize, usize) {
        let (mut bi, mut bj, mut bs) = (alo, blo, 0usize);
        let mut j2len: HashMap<usize, usize> = HashMap::new();
        for (i, ai) in a.iter().enumerate().take(ahi).skip(alo) {
            let mut new: HashMap<usize, usize> = HashMap::new();
            for &j in b2j.get(ai.as_str()).map(|v| v.as_slice()).unwrap_or(&[]) {
                if j < blo {
                    continue;
                }
                if j >= bhi {
                    break;
                }
                let k = j.checked_sub(1).and_then(|p| j2len.get(&p)).copied().unwrap_or(0) + 1;
                new.insert(j, k);
                if k > bs {
                    (bi, bj, bs) = (i + 1 - k, j + 1 - k, k);
                }
            }
            j2len = new;
        }
        (bi, bj, bs)
    };
    let mut queue = vec![(0, a.len(), 0, b.len())];
    let mut found = Vec::new();
    while let Some((alo, ahi, blo, bhi)) = queue.pop() {
        let (i, j, k) = longest(alo, ahi, blo, bhi);
        if k > 0 {
            found.push((i, j, k));
            if alo < i && blo < j {
                queue.push((alo, i, blo, j));
            }
            if i + k < ahi && j + k < bhi {
                queue.push((i + k, ahi, j + k, bhi));
            }
        }
    }
    found.sort();
    let (mut i1, mut j1, mut k1) = (0, 0, 0);
    let mut out = Vec::new();
    for (i2, j2, k2) in found {
        if i1 + k1 == i2 && j1 + k1 == j2 {
            k1 += k2;
        } else {
            if k1 > 0 {
                out.push((i1, j1, k1));
            }
            (i1, j1, k1) = (i2, j2, k2);
        }
    }
    if k1 > 0 {
        out.push((i1, j1, k1));
    }
    out.push((a.len(), b.len(), 0));
    out
}

/// (tag, i1, i2, j1, j2) for the parts that differ: "replace", "delete" or "insert".
fn opcodes(a: &[String], b: &[String]) -> Vec<(&'static str, usize, usize, usize, usize)> {
    let (mut i, mut j) = (0, 0);
    let mut out = Vec::new();
    for (ai, bj, size) in matching_blocks(a, b) {
        let tag = if i < ai && j < bj {
            "replace"
        } else if i < ai {
            "delete"
        } else if j < bj {
            "insert"
        } else {
            ""
        };
        if !tag.is_empty() {
            out.push((tag, i, ai, j, bj));
        }
        (i, j) = (ai + size, bj + size);
    }
    out
}

/// Print the look. On the page the last look was on: only what changed. On another page of
/// the same site: header/nav/footer blocks that didn't change are one line.
fn show_look(st: &mut State, url: &str, title: &str, lines: Vec<String>, full: bool, fold: bool) {
    let prev = st.get("last").and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let old: Vec<String> = prev.get("lines").and_then(|l| l.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let prev_url = prev.get("url").and_then(|u| u.as_str()).unwrap_or_default().to_string();
    let head = if title.is_empty() { url.to_string() } else { format!("{title} — {url}") };
    if !full && prev_url == url && !old.is_empty() {
        if old == lines {
            println!("{head}\n(no change on the page)");
        } else {
            let mut changed = HashSet::new();
            let mut gone = 0;
            for (op, a1, a2, b1, b2) in opcodes(&old, &lines) {
                if op == "replace" || op == "insert" {
                    changed.extend(b1..b2);
                }
                if op == "replace" || op == "delete" {
                    gone += a2 - a1;
                }
            }
            if changed.len() as f64 > lines.len() as f64 * 0.6 {
                println!("{head}\n{}", lines.join("\n"));
            } else {
                println!("{head}\n(same page; {} new/changed line(s), {gone} gone; `browse look` for all)", changed.len());
                let mut region = "[page]".to_string();
                let mut shown: Option<String> = None;
                for (i, line) in lines.iter().enumerate() {
                    if is_marker(line) {
                        region = line.clone();
                    } else if changed.contains(&i) {
                        if shown.as_ref() != Some(&region) {
                            println!("{region}");
                            shown = Some(region.clone());
                        }
                        println!("{line}");
                    }
                }
            }
        }
    } else {
        let mut out = vec![head];
        let seen: Vec<Vec<String>> = if fold && host(&prev_url) == host(url) { blocks(&old).into_iter().filter(|(r, _)| CHROME.contains(&r.trim_matches(['[', ']']))).map(|(_, b)| no_refs(&b)).collect() } else { vec![] };
        for (region, body) in blocks(&lines) {
            if CHROME.contains(&region.trim_matches(['[', ']'])) && body.concat().chars().count() > 60 && seen.contains(&no_refs(&body)) {
                out.push(format!("{region} (as on the last page)"));
            } else {
                out.push(region);
                out.extend(body);
            }
        }
        println!("{}", out.join("\n"));
    }
    st.insert("last".into(), json!({ "url": url, "lines": lines }));
}

// ───────────── Python's text for values (what the Python tool prints) ─────────────

fn py_float(f: f64) -> String {
    if f.is_finite() && f == f.trunc() && f.abs() < 1e16 {
        format!("{f:.1}")
    } else {
        format!("{f}")
    }
}

fn py_num(n: &serde_json::Number) -> String {
    if n.is_f64() {
        py_float(n.as_f64().unwrap_or(0.0))
    } else {
        n.to_string()
    }
}

/// `json.dumps(v, ensure_ascii=False)`
fn py_dumps(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => py_num(n),
        Value::String(s) => serde_json::to_string(s).unwrap_or_default(),
        Value::Array(a) => format!("[{}]", a.iter().map(py_dumps).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}: {}", serde_json::to_string(k).unwrap_or_default(), py_dumps(v))).collect::<Vec<_>>().join(", ")),
    }
}

fn py_repr_str(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::from(q);
    for c in s.chars() {
        match c {
            '\\' => out += "\\\\",
            '\n' => out += "\\n",
            '\r' => out += "\\r",
            '\t' => out += "\\t",
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => py_repr_str(s),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}: {}", py_repr_str(k), py_repr(v))).collect::<Vec<_>>().join(", ")),
        v => py_str(v),
    }
}

/// `str(v)`
fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => py_num(n),
        Value::String(s) => s.clone(),
        v => py_repr(v),
    }
}

fn take(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Print failures (and the output of commands that print something); true if one failed.
fn fail(rows: &[Row], quiet_ok: bool) -> bool {
    let mut bad = false;
    for (c, ok, res) in rows {
        if !ok {
            bad = true;
            println!("✗ {}: {}", take(&c.join(" "), 120), py_str(res));
        } else if !quiet_ok {
            if let Some(o) = res.as_object() {
                let r: Map<String, Value> = o.iter().filter(|(k, _)| !["lifecycle", "origin", "targetId"].contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect();
                match c.first().map(String::as_str) {
                    Some("eval") => println!("{}", take(&py_dumps(r.get("result").unwrap_or(&Value::Null)), 4000)),
                    Some("get") => println!("{}", take(&r.values().map(py_str).collect::<Vec<_>>().join(" "), 4000)),
                    _ => {}
                }
            }
        }
    }
    bad
}

fn ok(row: &Row) -> bool {
    row.1 && row.2.is_object()
}

fn field(row: &Row, k: &str) -> Value {
    row.2.get(k).cloned().unwrap_or(Value::Null)
}

fn field_str(row: &Row, k: &str) -> String {
    row.2.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

#[derive(Default, Clone)]
struct ReadOpts {
    sel: Option<String>,
    section: Option<String>,
    outline: bool,
    links: bool,
    max: i64,
    url: Option<String>,
}

fn read_opts(argv: &[String]) -> ReadOpts {
    let mut o = ReadOpts { max: 12000, ..Default::default() };
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if a == "--section" && i + 1 < argv.len() {
            o.section = Some(argv[i + 1].clone());
            i += 1;
        } else if a == "--max" && i + 1 < argv.len() {
            o.max = argv[i + 1].parse().unwrap_or_else(|_| die(&format!("invalid literal for int() with base 10: '{}'", argv[i + 1])));
            i += 1;
        } else if a == "--outline" {
            o.outline = true;
        } else if a == "--links" {
            o.links = true;
        } else if ["http://", "https://", "about:", "file:"].iter().any(|p| a.starts_with(p)) {
            o.url = Some(a.clone());
        } else if !a.starts_with('-') {
            o.sel = Some(a.clone());
        }
        i += 1;
    }
    o
}

fn read_js(o: &ReadOpts) -> String {
    let opts = json!({ "sel": o.sel, "section": o.section, "outline": o.outline, "links": o.links, "max": o.max });
    READ_JS.replace("__OPTS__", &py_dumps(&opts))
}

/// Run `pre`, let the page settle, then look (or read), all in one batch; again if the page
/// moved on meanwhile. Returns (rows of pre, whether something was shown).
fn settled_look(st: &mut State, pre: &[Cmd], bail: bool, full: bool, read: Option<&ReadOpts>) -> (Vec<Row>, bool) {
    let show = match read {
        Some(r) => vec!["eval".into(), read_js(r)],
        None => cmd(&["snapshot", "-c"]),
    };
    let tail = vec![settle_cmd(st), show, cmd(&["get", "title"]), cmd(&["get", "url"])];
    let all: Vec<Cmd> = pre.iter().cloned().chain(tail.iter().cloned()).collect();
    let mut rows = batch(&all, bail);
    if pre.last().is_some_and(|c| c.first().map(String::as_str) == Some("open")) && rows.iter().any(|r| !r.1 && py_str(&r.2).contains("tab_gone")) {
        // this job's tab was closed under it: open a new one and load the page there
        if batch(&[cmd(&["tab", "new"])], true).first().is_some_and(ok) {
            rows = batch(&all, bail);
        }
    }
    let n = pre.len().min(rows.len());
    let done: Vec<Row> = rows[..n].to_vec();
    let mut last: Vec<Row> = rows[n..].to_vec();
    for _ in 0..3 {
        if last.len() == 4 && last.iter().all(ok) && field(&last[0], "result") == field(&last[3], "url") {
            break;
        }
        let again: Vec<Cmd> = std::iter::once(cmd(&["wait", "--load", "domcontentloaded"])).chain(tail.iter().cloned()).collect();
        last = batch(&again, false).into_iter().skip(1).collect();
    }
    if last.len() < 4 || !ok(&last[1]) {
        let what = if last.len() > 1 { py_str(&last[1].2) } else { "no answer".into() };
        println!("✗ {}: {what}", if read.is_some() { "read" } else { "look" });
        return (done, false);
    }
    if read.is_some() {
        let r = field(&last[1], "result");
        println!("{}", if truthy(&r) { py_str(&r) } else { "(no readable text)".into() });
        st.remove("last");
        return (done, true);
    }
    let url = if ok(&last[3]) { field_str(&last[3], "url") } else { String::new() };
    let title = if ok(&last[2]) { field_str(&last[2], "title") } else { String::new() };
    let lines = snap_lines(&last[1].2, false, false);
    show_look(st, &url, &title, lines, full, true);
    (done, true)
}

fn opens(rows: &[Row]) -> Vec<Row> {
    rows.iter().filter(|r| r.0.first().map(String::as_str) == Some("open")).cloned().collect()
}

fn cmd_open(argv: &[String]) {
    let Some(url) = argv.first() else { die("usage: browse open <url>") };
    let mut st = load_state();
    let (mut pre, open) = setup(&mut st, Some(url));
    pre.extend(open);
    let (rows, shown) = settled_look(&mut st, &pre, false, true, None);
    setup_done(&mut st);
    save_state(&st);
    if fail(&opens(&rows), true) || !shown {
        std::process::exit(1);
    }
}

fn cmd_look(argv: &[String]) {
    let mut st = load_state();
    let (mut sel, mut all, mut urls) = (None, false, false);
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        if (a == "-s" || a == "--selector") && i + 1 < argv.len() {
            sel = Some(argv[i + 1].clone());
            i += 1;
        } else if a == "--all" {
            all = true;
        } else if a == "--urls" || a == "-u" {
            urls = true;
        }
        i += 1;
    }
    let mut snap = cmd(&["snapshot", "-c"]);
    if let Some(s) = &sel {
        snap.extend(["-s".to_string(), s.clone()]);
    }
    if urls {
        snap.push("-u".into());
    }
    let rows = batch(&[cmd(&["get", "title"]), cmd(&["get", "url"]), snap], true);
    if fail(&rows, true) {
        std::process::exit(1);
    }
    let (url, title) = (field_str(&rows[1], "url"), field_str(&rows[0], "title"));
    let lines = snap_lines(&rows[2].2, all || sel.is_some(), urls);
    if let Some(s) = sel {
        println!("{title} — {url} (inside {s})\n{}", lines.join("\n"));
    } else {
        show_look(&mut st, &url, &title, lines, true, false);
        save_state(&st);
    }
}

fn cmd_do(argv: &[String]) {
    if argv.is_empty() {
        die("usage: browse do \"<ondra-browser command>\" ...");
    }
    let mut st = load_state();
    let (mut argv, mut read) = (argv.to_vec(), None);
    if let Some(i) = argv.iter().position(|a| a == "--read") {
        read = Some(read_opts(&argv[i + 1..]));
        argv.truncate(i);
    }
    let mut cmds: Vec<Cmd> = Vec::new();
    for a in &argv {
        let a = a.trim();
        if a.starts_with('[') {
            let v: Vec<Value> = serde_json::from_str(a).unwrap_or_else(|e| die(&format!("browse do: {e}")));
            cmds.push(v.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect());
        } else {
            cmds.push(shlex(a));
        }
    }
    // a page change (open/navigate) inside the batch keeps light mode
    let nav = cmds.iter().position(|c| c.len() > 1 && ["open", "navigate", "goto"].contains(&c[0].as_str()));
    let mut pre = cmds.clone();
    if let Some(n) = nav {
        let (first, _) = setup(&mut st, Some(&cmds[n][1]));
        let mut navc: Cmd = cmds[n][..2].to_vec();
        navc.extend(cmd(&["--wait-until", "domcontentloaded"]));
        navc.extend(cmds[n][2..].iter().cloned());
        pre = first;
        pre.extend(cmds[..n].iter().cloned());
        pre.push(navc);
        pre.extend(cmds[n + 1..].iter().cloned());
    }
    let (rows, _) = settled_look(&mut st, &pre, true, false, read.as_ref());
    let acted: Vec<Row> = rows
        .into_iter()
        .filter(|r| {
            let two: Vec<&str> = r.0.iter().take(2).map(String::as_str).collect();
            two != ["network", "route"] && two != ["network", "unroute"] && r.0.first().map(String::as_str) != Some("set")
        })
        .collect();
    setup_done(&mut st);
    save_state(&st);
    if fail(&acted, false) {
        std::process::exit(1);
    }
}

/// `shlex.split`: POSIX shell words.
fn shlex(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut has = false;
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\'' => {
                has = true;
                for d in it.by_ref() {
                    if d == '\'' {
                        break;
                    }
                    cur.push(d);
                }
            }
            '"' => {
                has = true;
                while let Some(d) = it.next() {
                    if d == '"' {
                        break;
                    }
                    if d == '\\' && matches!(it.peek(), Some('"' | '\\' | '$' | '`')) {
                        cur.push(it.next().unwrap());
                        continue;
                    }
                    cur.push(d);
                }
            }
            '\\' => {
                has = true;
                if let Some(d) = it.next() {
                    cur.push(d);
                }
            }
            c if c.is_whitespace() => {
                if has || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    has = false;
                }
            }
            c => cur.push(c),
        }
    }
    if has || !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn cmd_read(argv: &[String]) {
    let mut st = load_state();
    let o = read_opts(argv);
    if let Some(u) = o.url.clone() {
        let (mut pre, open) = setup(&mut st, Some(&u));
        pre.extend(open);
        let (rows, shown) = settled_look(&mut st, &pre, false, false, Some(&o));
        setup_done(&mut st);
        save_state(&st);
        if fail(&opens(&rows), true) || !shown {
            std::process::exit(1);
        }
        return;
    }
    let rows = batch(&[vec!["eval".into(), read_js(&o)]], true);
    if fail(&rows, true) {
        std::process::exit(1);
    }
    let r = field(&rows[0], "result");
    println!("{}", if truthy(&r) { py_str(&r) } else { "(no readable text)".into() });
}

fn cmd_visuals(argv: &[String]) {
    let mut st = load_state();
    let on = argv.first().map(String::as_str).unwrap_or("on") != "off";
    st.insert("visual".into(), json!(on));
    if on {
        st.remove("light_pid");
        let rows = batch(&[cmd(&["network", "unroute"]), cmd(&["set", "media", "no-preference"]), cmd(&["get", "url"])], false);
        let url = rows.last().filter(|r| ok(r)).map(|r| field_str(r, "url")).unwrap_or_default();
        if ["http:", "https:", "file:"].iter().any(|p| url.starts_with(p)) {
            // load the page again with everything (a reload loses what was typed into it)
            let r = batch(&[cmd(&["open", &url, "--wait-until", "domcontentloaded"]), settle_cmd(&st)], false);
            fail(&r[..1.min(r.len())], true);
        }
        println!("visuals on: images, fonts, media, ads and animations load in this tab (page loaded again)");
    } else {
        println!("visuals off: blocked again from the next `browse open`");
    }
    st.remove("last");
    save_state(&st);
}

fn cmd_shot(argv: &[String]) {
    let Some(file) = argv.first() else { die("usage: browse shot <file.png> [--full]") };
    let st = load_state();
    if !st.get("visual").map(truthy).unwrap_or(false) {
        cmd_visuals(&["on".to_string()]);
    }
    let wait_imgs = "(async()=>{const t=Date.now();while(Date.now()-t<5000&&[...document.images].some(i=>i.loading!=='lazy'&&!i.complete))await new Promise(r=>setTimeout(r,100));await document.fonts.ready;return true})()";
    let mut shot = cmd(&["screenshot"]);
    if argv.iter().any(|a| a == "--full") {
        shot.push("--full".into());
    }
    shot.push(file.clone());
    let rows = batch(&[cmd(&["eval", wait_imgs]), shot], false);
    if fail(&rows[1.min(rows.len())..], true) {
        std::process::exit(1);
    }
    println!("saved {file}");
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.is_empty() || ["-h", "--help", "help"].contains(&argv[0].as_str()) {
        println!("{DOC}");
        return;
    }
    let rest = &argv[1..];
    match argv[0].as_str() {
        "open" | "goto" => cmd_open(rest),
        "look" | "snapshot" => cmd_look(rest),
        "do" => cmd_do(rest),
        "read" => cmd_read(rest),
        "visuals" => cmd_visuals(rest),
        "shot" | "screenshot" => cmd_shot(rest),
        c => die(&format!("browse: unknown command {} (open, look, read, do, visuals, shot); anything else: ondra-browser {c} ...", py_repr_str(c))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn diff_like_difflib() {
        // difflib.SequenceMatcher(a=..., b=..., autojunk=False).get_opcodes(), non-equal ones
        let a = s(&["x", "a", "b", "c", "d"]);
        let b = s(&["a", "b", "z", "d", "e"]);
        assert_eq!(opcodes(&a, &b), vec![("delete", 0, 1, 0, 0), ("replace", 3, 4, 2, 3), ("insert", 5, 5, 4, 5)]);
    }

    #[test]
    fn lines_parse() {
        let (ind, role, name, attrs, rest) = parse_line(r#"    - link "Say \"hi\"" [ref=e3, url=http://x/a]: v"#).unwrap();
        assert_eq!((ind, role.as_str(), name.as_str(), attrs.as_str(), rest.as_str()), (4, "link", r#"Say \"hi\""#, "ref=e3, url=http://x/a", ": v"));
    }

    #[test]
    fn python_text() {
        assert_eq!(py_dumps(&json!({"a": [1, "é", null], "b": 1.5})), r#"{"a": [1, "é", null], "b": 1.5}"#);
        assert_eq!(py_str(&json!({"x": 1.0, "y": true})), "{'x': 1.0, 'y': True}");
        assert_eq!(shlex(r#"fill @e3 "김 철수" 'a b'"#), s(&["fill", "@e3", "김 철수", "a b"]));
        assert_eq!(no_refs(&s(&["a @e12 b @x"])), s(&["a b @x"]));
    }
}
