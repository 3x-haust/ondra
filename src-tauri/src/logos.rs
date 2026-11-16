//! Official logos for the boxes of an `arch` diagram, from the internet, kept on disk.
//!
//! The diagram draws a simple-icons glyph (or nothing) first and asks here for the
//! brand's own colour mark. Sources, in order (after caru-ini/stack-diagram, MIT):
//!   1. svgl              api.svgl.app?search=… , an exact title match only
//!   2. devicon           cdn.jsdelivr.net/gh/devicons/devicon/icons/{s}/{s}-original.svg
//!   3. gilbarbara/logos  cdn.jsdelivr.net/gh/gilbarbara/logos/logos/{s}-icon.svg, then {s}.svg
//!
//! Only brand names reach this command (the UI sends a block's `logo` or the title of a
//! brand a label matched, never other text). Requests go to those hosts only, a file is
//! at most `MAX_BYTES`, SVG or PNG, and an SVG is cleaned (`sanitize_svg`) before it is
//! kept or shown: no script, event handler, outside link or foreignObject is left.
//! Found logos stay in `<data>/logos/`; a brand no source has is remembered for a day.
//! A network failure is not remembered, so the next diagram simply tries again.

use base64::Engine;
use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::AppHandle;

const MAX_BYTES: usize = 512 * 1024;
const MISS_SECS: u64 = 24 * 60 * 60;
const HOSTS: [&str; 3] = ["api.svgl.app", "svgl.app", "cdn.jsdelivr.net"];

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Official {
    /// data: URL of the mark (for a light background when the source has two)
    pub light: String,
    /// data: URL of the source's variant for a dark background
    pub dark: Option<String>,
    /// "dark" / "light" when the whole mark is that dark or light, so it would vanish on
    /// a background of the same tone (the UI turns it over there)
    pub tone: Option<String>,
    /// where it came from: svgl · devicon · gilbarbara
    pub source: String,
}

#[derive(Serialize, Deserialize)]
struct Cached {
    at: u64,
    logo: Option<Official>,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// The official logo for a brand name, from the disk cache or the internet.
#[tauri::command]
pub async fn logo_fetch(app: AppHandle, name: String) -> Option<Official> {
    let key = cache_key(&name)?;
    let dir = crate::engine::data_dir(&app).join("logos");
    let file = dir.join(format!("{key}.json"));
    if let Some(c) = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Cached>(&b).ok()) {
        if c.logo.is_some() || now().saturating_sub(c.at) < MISS_SECS {
            return c.logo;
        }
    }
    let found = lookup(name.trim()).await.ok()?;
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_vec(&Cached { at: now(), logo: found.clone() }) {
        let tmp = dir.join(format!(".{key}.tmp"));
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, &file);
        }
    }
    found
}

// ───────────── names → where to look

/// Lowercase letters and digits only: how titles are compared.
pub fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
}

/// A brand name fit to look up and to name a cache file: short, plain characters only.
/// Anything else (a sentence, a path, an address) is never sent anywhere.
pub fn cache_key(name: &str) -> Option<String> {
    let name = name.trim();
    if name.is_empty() || name.len() > 60 || !name.chars().all(|c| c.is_ascii_alphanumeric() || " .+-_".contains(c)) {
        return None;
    }
    let mut key = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            key.push(c.to_ascii_lowercase());
        } else if c == '+' {
            key.push_str("plus");
        } else if !key.is_empty() && !key.ends_with('-') {
            key.push('-');
        }
    }
    let key = key.trim_end_matches('-').to_string();
    (!key.is_empty()).then_some(key)
}

/// File names the CDNs use for a brand: "Node.js" → nodejs, node-js, node.
pub fn slugs(name: &str) -> Vec<String> {
    let lower = name.trim().to_ascii_lowercase();
    let plain: String = lower.chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    let dashed = lower.split(|c: char| !c.is_ascii_alphanumeric()).filter(|w| !w.is_empty()).collect::<Vec<_>>().join("-");
    let mut out = vec![plain.clone(), dashed];
    if plain.len() > 4 && plain.ends_with("js") {
        out.push(plain[..plain.len() - 2].to_string());
    }
    let mut seen = Vec::new();
    for s in out {
        if !s.is_empty() && !seen.contains(&s) {
            seen.push(s);
        }
    }
    seen
}

/// What to ask svgl's search, and the titles that count as the brand. Its search matches
/// title substrings ("nextjs" misses "Next.js"), so the name is also tried with its
/// separators as spaces and without a trailing "js"; only an exact title is taken.
pub fn svgl_queries(name: &str) -> (Vec<String>, Vec<String>) {
    let name = name.trim();
    let spaced = name.split(|c: char| "-_.".contains(c)).filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    let mut queries = vec![name.to_string(), spaced];
    let mut targets = vec![norm(name)];
    let n = norm(name);
    if n.len() > 4 && n.ends_with("js") {
        // "Vue.js" → "Vue": the last two letters, then a separator left before them
        let cut = name.char_indices().rev().filter(|(_, c)| c.is_ascii_alphanumeric()).nth(1).map_or(0, |(i, _)| i);
        let bare = name[..cut].trim_end_matches(['.', '-', '_', ' ']);
        queries.push(bare.to_string());
        targets.push(n[..n.len() - 2].to_string());
    }
    let mut q: Vec<String> = Vec::new();
    for s in queries {
        if !s.is_empty() && !q.contains(&s) {
            q.push(s);
        }
    }
    (q, targets)
}

/// The search URL for one svgl query.
pub fn svgl_url(query: &str) -> String {
    let mut u = reqwest::Url::parse("https://api.svgl.app/").expect("static url");
    u.query_pairs_mut().append_pair("search", query);
    u.to_string()
}

/// svgl's answer → (mark for light backgrounds, mark for dark ones) of the item whose
/// title is the brand exactly. Links elsewhere than svgl are not followed.
pub fn svgl_pick(items: &serde_json::Value, targets: &[String]) -> Option<(String, Option<String>)> {
    let ok = |u: &str| allowed(u).then(|| u.to_string());
    for it in items.as_array()? {
        let title = it.get("title").and_then(|t| t.as_str()).unwrap_or_default();
        if !targets.contains(&norm(title)) {
            continue;
        }
        match it.get("route")? {
            serde_json::Value::String(u) => return ok(u).map(|u| (u, None)),
            serde_json::Value::Object(m) => {
                let light = m.get("light").and_then(|v| v.as_str()).and_then(ok);
                let dark = m.get("dark").and_then(|v| v.as_str()).and_then(ok);
                return match (light, dark) {
                    (Some(l), d) => Some((l, d)),
                    (None, Some(d)) => Some((d, None)),
                    _ => None,
                };
            }
            _ => return None,
        }
    }
    None
}

/// The fallbacks after svgl, in order, with their source names.
pub fn cdn_urls(name: &str) -> Vec<(&'static str, String)> {
    let s = slugs(name);
    let mut out: Vec<(&'static str, String)> = s.iter().map(|s| ("devicon", format!("https://cdn.jsdelivr.net/gh/devicons/devicon/icons/{s}/{s}-original.svg"))).collect();
    for s in &s {
        out.push(("gilbarbara", format!("https://cdn.jsdelivr.net/gh/gilbarbara/logos/logos/{s}-icon.svg")));
        out.push(("gilbarbara", format!("https://cdn.jsdelivr.net/gh/gilbarbara/logos/logos/{s}.svg")));
    }
    out
}

/// https to one of the sources' hosts, nothing else.
pub fn allowed(url: &str) -> bool {
    reqwest::Url::parse(url).is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| HOSTS.contains(&h)) && u.port().is_none())
}

// ───────────── fetching

fn client() -> Result<reqwest::Client, ()> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent(concat!("Ondra/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::custom(|a| {
            if a.previous().len() > 3 || !allowed(a.url().as_str()) { a.stop() } else { a.follow() }
        }))
        .build()
        .map_err(|_| ())
}

/// The body of `url`: Ok(None) when the source says it has no such file (or it is too
/// big), Err when the network or the server failed (worth trying again later).
async fn get(http: &reqwest::Client, url: &str) -> Result<Option<Vec<u8>>, ()> {
    if !allowed(url) {
        return Ok(None);
    }
    let mut res = http.get(url).send().await.map_err(|_| ())?;
    let status = res.status();
    if status.is_redirection() || matches!(status.as_u16(), 400 | 403 | 404 | 410) {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(());
    }
    if res.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Ok(None);
    }
    let mut body = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|_| ())? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BYTES {
            return Ok(None);
        }
    }
    Ok(Some(body))
}

async fn lookup(name: &str) -> Result<Option<Official>, ()> {
    let http = client()?;
    let mut failed = false;
    let (queries, targets) = svgl_queries(name);
    'svgl: for q in &queries {
        let items = match get(&http, &svgl_url(q)).await {
            Ok(Some(b)) => serde_json::from_slice::<serde_json::Value>(&b).unwrap_or_default(),
            Ok(None) => continue,
            Err(()) => {
                failed = true;
                continue;
            }
        };
        if let Some((light, dark)) = svgl_pick(&items, &targets) {
            match get(&http, &light).await {
                Ok(Some(b)) => {
                    if let Some((light, tone)) = mark(&b, true) {
                        let dark = match dark {
                            Some(u) => get(&http, &u).await.ok().flatten().and_then(|b| mark(&b, true)).map(|m| m.0),
                            None => None,
                        };
                        let tone = if dark.is_some() { None } else { tone };
                        return Ok(Some(Official { light, dark, tone, source: "svgl".into() }));
                    }
                }
                Ok(None) => {}
                Err(()) => failed = true,
            }
            break 'svgl;
        }
    }
    for (source, url) in cdn_urls(name) {
        match get(&http, &url).await {
            Ok(Some(b)) => {
                if let Some((light, tone)) = mark(&b, false) {
                    return Ok(Some(Official { light, dark: None, tone, source: source.into() }));
                }
            }
            Ok(None) => {}
            Err(()) => failed = true,
        }
    }
    if failed { Err(()) } else { Ok(None) }
}

/// A fetched file as a data: URL with its tone: a cleaned SVG or a PNG, roughly square
/// (a wide wordmark would be a speck in a box's logo spot). `trusted_shape`: svgl's marks
/// are icons already, keep them whatever their proportions.
fn mark(bytes: &[u8], trusted_shape: bool) -> Option<(String, Option<String>)> {
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    if bytes.len() < 50 {
        return None;
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let (w, h) = png_size(bytes)?;
        if !trusted_shape && !squarish(w as f64, h as f64) {
            return None;
        }
        return Some((format!("data:image/png;base64,{}", b64(bytes)), None));
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let svg = sanitize_svg(text)?;
    if !trusted_shape && aspect(&svg).is_some_and(|a| !squarish(a, 1.0)) {
        return None;
    }
    let tone = tone(&svg).map(str::to_string);
    Some((format!("data:image/svg+xml;base64,{}", b64(svg.as_bytes())), tone))
}

fn squarish(w: f64, h: f64) -> bool {
    w > 0.0 && h > 0.0 && (0.4..=2.5).contains(&(w / h))
}

fn png_size(b: &[u8]) -> Option<(u32, u32)> {
    if b.len() < 24 || &b[12..16] != b"IHDR" {
        return None;
    }
    Some((u32::from_be_bytes(b[16..20].try_into().ok()?), u32::from_be_bytes(b[20..24].try_into().ok()?)))
}

/// width / height of a cleaned SVG, from its viewBox (or width and height).
pub fn aspect(svg: &str) -> Option<f64> {
    let mut r = Reader::from_str(svg);
    loop {
        match r.read_event().ok()? {
            Event::Start(e) | Event::Empty(e) if e.local_name().as_ref().eq_ignore_ascii_case(b"svg") => {
                let attr = |n: &str| e.attributes().flatten().find(|a| a.key.as_ref().eq_ignore_ascii_case(n.as_bytes())).and_then(|a| a.unescape_value().ok().map(|v| v.to_string()));
                if let Some(vb) = attr("viewBox") {
                    let n: Vec<f64> = vb.split(|c: char| c == ',' || c.is_whitespace()).filter_map(|s| s.parse().ok()).collect();
                    if n.len() == 4 && n[3] > 0.0 {
                        return Some(n[2] / n[3]);
                    }
                }
                let num = |s: Option<String>| s.and_then(|s| s.trim_end_matches("px").parse::<f64>().ok());
                return match (num(attr("width")), num(attr("height"))) {
                    (Some(w), Some(h)) if h > 0.0 => Some(w / h),
                    _ => None,
                };
            }
            Event::Eof => return None,
            _ => {}
        }
    }
}

// ───────────── cleaning an SVG

/// Elements that draw. Anything else goes, with everything inside it.
const KEEP: [&str; 37] = [
    "svg", "g", "defs", "title", "desc", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan",
    "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "symbol", "use", "style", "image", "filter",
    "feblend", "fecolormatrix", "fecomposite", "feflood", "fegaussianblur", "femerge", "femergenode", "feoffset", "fedropshadow",
    "femorphology", "fetile", "metadata",
];
/// Elements dropped while what they hold stays (a link around the drawing).
const UNWRAP: [&str; 2] = ["a", "switch"];

/// A CSS text (a style attribute or a <style> element) with no outside reference in it.
fn css_ok(css: &str) -> bool {
    let l = css.to_ascii_lowercase();
    if ["@import", "expression(", "javascript:", "behavior:", "-moz-binding"].iter().any(|w| l.contains(w)) {
        return false;
    }
    // url(…) only to the picture's own parts: url(#id)
    let mut rest = l.as_str();
    while let Some(i) = rest.find("url(") {
        rest = &rest[i + 4..];
        if !rest.trim_start().trim_start_matches(['\'', '"']).starts_with('#') {
            return false;
        }
    }
    true
}

/// Keep this attribute on this element?
fn attr_ok(element: &str, name: &str, value: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let v = value.trim().to_ascii_lowercase();
    // event handlers; xmlns is written fresh on the root; other tools' namespaces go
    // with their elements (sodipodi:, inkscape:…), so their attributes must go too
    if n.starts_with("on") || n == "xmlns" || n.contains(':') && !(n.starts_with("xlink:") || n == "xml:space" || n == "xmlns:xlink") {
        return false;
    }
    if n == "href" || n == "xlink:href" || n == "src" {
        // a link to its own parts, or (on <image>) a picture carried inside the file
        let raster = ["data:image/png;", "data:image/jpeg;", "data:image/gif;", "data:image/webp;"].iter().any(|p| v.starts_with(p));
        return v.starts_with('#') || element == "image" && raster;
    }
    !v.contains("javascript:") && !v.contains("data:") && css_ok(&v)
}

enum Verdict {
    Keep(String, String),
    Unwrap,
    Drop,
}

fn verdict(e: &BytesStart) -> Verdict {
    let Ok(name) = std::str::from_utf8(e.name().as_ref()).map(str::to_string) else { return Verdict::Drop };
    let (prefix, local) = name.split_once(':').unwrap_or(("", name.as_str()));
    let local = local.to_ascii_lowercase();
    if !prefix.is_empty() && prefix != "svg" {
        return Verdict::Drop;
    }
    if KEEP.contains(&local.as_str()) {
        Verdict::Keep(name.clone(), local)
    } else if UNWRAP.contains(&local.as_str()) {
        Verdict::Unwrap
    } else {
        Verdict::Drop
    }
}

fn esc(s: &str) -> String {
    quick_xml::escape::escape(s).into_owned()
}

/// `<name a="…"` with only the attributes worth keeping (the caller closes it).
fn open_tag(e: &BytesStart, name: &str, local: &str, root: bool, out: &mut String) {
    out.push('<');
    out.push_str(name);
    if root {
        out.push_str(" xmlns=\"http://www.w3.org/2000/svg\"");
    }
    for a in e.attributes().flatten() {
        let (Ok(key), Ok(value)) = (std::str::from_utf8(a.key.as_ref()), a.unescape_value()) else { continue };
        if attr_ok(local, key, &value) {
            out.push_str(&format!(" {key}=\"{}\"", esc(&value)));
        }
    }
}

/// The SVG with only what draws left in it: no script, no event handler, no
/// foreignObject, no link or url() outside itself, no DOCTYPE (so no entities).
/// None when it isn't an SVG or can't be read.
pub fn sanitize_svg(src: &str) -> Option<String> {
    if src.len() > MAX_BYTES {
        return None;
    }
    let mut r = Reader::from_str(src);
    let mut out = String::with_capacity(src.len());
    // per open element: its name when written, None when unwrapped
    let mut stack: Vec<Option<String>> = Vec::new();
    let mut skip = 0usize; // depth inside a dropped element
    let mut style: Option<String> = None; // the text of an open <style>
    let mut drew = false;
    loop {
        match r.read_event().ok()? {
            Event::Eof => break,
            Event::Start(e) => {
                if skip > 0 {
                    skip += 1;
                    continue;
                }
                match verdict(&e) {
                    // the root must be <svg>
                    Verdict::Keep(_, local) if stack.is_empty() && local != "svg" => return None,
                    Verdict::Keep(name, local) => {
                        open_tag(&e, &name, &local, stack.is_empty(), &mut out);
                        out.push('>');
                        if local == "style" {
                            style = Some(String::new());
                        }
                        stack.push(Some(name));
                    }
                    _ if stack.is_empty() => return None,
                    Verdict::Unwrap => stack.push(None),
                    Verdict::Drop => skip = 1,
                }
            }
            Event::Empty(e) => {
                if skip > 0 {
                    continue;
                }
                match verdict(&e) {
                    _ if stack.is_empty() => return None,
                    Verdict::Keep(name, local) => {
                        open_tag(&e, &name, &local, false, &mut out);
                        out.push_str("/>");
                        drew = true;
                    }
                    _ => {}
                }
            }
            Event::End(_) => {
                if skip > 0 {
                    skip -= 1;
                    continue;
                }
                if let Some(css) = style.take() {
                    if css_ok(&css) {
                        out.push_str(&esc(&css));
                    }
                }
                if let Some(name) = stack.pop()? {
                    out.push_str("</");
                    out.push_str(&name);
                    out.push('>');
                    // something inside the root was kept
                    drew |= !stack.is_empty();
                }
                if stack.is_empty() {
                    break;
                }
            }
            Event::Text(t) => {
                if skip == 0 && !stack.is_empty() {
                    let text = t.decode().ok()?;
                    match style.as_mut() {
                        Some(css) => css.push_str(&text),
                        None => out.push_str(&esc(&text)),
                    }
                }
            }
            Event::CData(t) => {
                if skip == 0 && !stack.is_empty() {
                    let text = t.decode().ok()?;
                    match style.as_mut() {
                        Some(css) => css.push_str(&text),
                        None => out.push_str(&esc(&text)),
                    }
                }
            }
            Event::GeneralRef(g) => {
                if skip > 0 || stack.is_empty() {
                    continue;
                }
                // &#…; and the five XML ones; any other entity is dropped, never expanded
                let ch = if g.is_char_ref() {
                    g.resolve_char_ref().ok().flatten()
                } else {
                    match g.decode().ok()?.as_ref() {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        _ => None,
                    }
                };
                if let Some(c) = ch {
                    match style.as_mut() {
                        Some(css) => css.push(c),
                        None => out.push_str(&esc(&c.to_string())),
                    }
                }
            }
            // declarations, processing instructions, comments, DOCTYPE (and its entities)
            _ => {}
        }
    }
    (drew && stack.is_empty()).then_some(out)
}

// ───────────── tone

/// A paint value's colour: Some(None) when it paints nothing of its own, None when it
/// is a colour this can't read (counted as a colour).
fn paint_rgb(v: &str) -> Option<Option<(u8, u8, u8)>> {
    let v = v.trim().to_ascii_lowercase();
    if v.is_empty() || ["none", "transparent", "currentcolor", "inherit"].contains(&v.as_str()) || v.starts_with("url(") {
        return Some(None);
    }
    if let Some(h) = v.strip_prefix('#') {
        let h: String = if h.len() == 3 || h.len() == 4 { h.chars().take(3).flat_map(|c| [c, c]).collect() } else { h.chars().take(6).collect() };
        if h.len() != 6 {
            return None;
        }
        let p = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
        return Some(Some((p(0)?, p(2)?, p(4)?)));
    }
    if let Some(body) = v.strip_prefix("rgb(").or_else(|| v.strip_prefix("rgba(")) {
        let n: Vec<u8> = body.trim_end_matches(')').split([',', ' ', '/']).filter(|s| !s.is_empty()).take(3).filter_map(|s| s.parse::<f64>().ok().map(|f| f.clamp(0.0, 255.0) as u8)).collect();
        return (n.len() == 3).then_some(Some((n[0], n[1], n[2])));
    }
    match v.as_str() {
        "black" => Some(Some((0, 0, 0))),
        "white" => Some(Some((255, 255, 255))),
        _ => None,
    }
}

/// "dark" / "light" when every paint in the SVG is of that tone: greys, or colours as dark
/// as Sentry's ink purple (no paint at all is black); else None. Such a mark would vanish
/// on a background of the same tone, so the UI turns its lightness over (keeping its hue).
pub fn tone(svg: &str) -> Option<&'static str> {
    let l = svg.to_ascii_lowercase();
    let mut lum = Vec::new();
    for prop in ["fill", "stroke", "stop-color"] {
        let mut from = 0;
        while let Some(i) = l[from..].find(prop) {
            let at = from + i;
            from = at + prop.len();
            let before = l[..at].chars().last().unwrap_or(' ');
            if before.is_ascii_alphanumeric() || before == '-' {
                continue;
            }
            let rest = l[from..].trim_start();
            let Some(rest) = rest.strip_prefix('=').or_else(|| rest.strip_prefix(':')) else { continue };
            let rest = rest.trim_start().trim_start_matches(['"', '\'']);
            let end = rest.find(['"', '\'', ';', '}', '<', '!']).unwrap_or(rest.len());
            match paint_rgb(&rest[..end]) {
                Some(Some((r, g, b))) => {
                    let y = 0.2126 * r as f64 + 0.7152 * g as f64 + 0.0722 * b as f64;
                    let grey = r.max(g).max(b) - r.min(g).min(b) <= 24;
                    // a colour counts only when it is about as dark as black or as light as white
                    if !grey && (75.0..=215.0).contains(&y) {
                        return None;
                    }
                    lum.push(if grey { y } else if y < 75.0 { y.min(60.0) } else { y.max(230.0) });
                }
                Some(None) => {}
                None => return None,
            }
        }
    }
    if unpainted_shape(svg) {
        lum.push(0.0); // drawn in the default black
    }
    if lum.iter().all(|&x| x < 90.0) {
        Some("dark")
    } else if lum.iter().all(|&x| x > 200.0) {
        Some("light")
    } else {
        None
    }
}

/// Is a shape drawn with no fill of its own or from a group around it (so in black)?
/// Shapes in defs, masks and clip paths don't count; a class may paint it, so it counts as painted.
fn unpainted_shape(svg: &str) -> bool {
    let mut r = Reader::from_str(svg);
    // per open element: (fill given here or above, inside defs/mask/clipPath…)
    let mut stack: Vec<(bool, bool)> = vec![(false, false)];
    loop {
        let (e, empty) = match r.read_event() {
            Ok(Event::Start(e)) => (e, false),
            Ok(Event::Empty(e)) => (e, true),
            Ok(Event::End(_)) => {
                stack.pop();
                if stack.is_empty() {
                    return false;
                }
                continue;
            }
            Ok(Event::Eof) | Err(_) => return false,
            _ => continue,
        };
        let local = String::from_utf8_lossy(e.local_name().as_ref()).to_ascii_lowercase();
        let (filled, hidden) = *stack.last().unwrap_or(&(false, false));
        let own = e.attributes().flatten().any(|a| {
            let k = a.key.as_ref().to_ascii_lowercase();
            k == b"fill" || k == b"class" || k == b"style" && a.unescape_value().is_ok_and(|v| v.to_ascii_lowercase().contains("fill"))
        });
        let hidden = hidden || ["defs", "mask", "clippath", "symbol", "pattern", "marker", "lineargradient", "radialgradient"].contains(&local.as_str());
        if !hidden && !filled && !own && ["path", "circle", "rect", "ellipse", "polygon", "polyline", "text"].contains(&local.as_str()) {
            return true;
        }
        if !empty {
            stack.push((filled || own, hidden));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_become_the_sources_file_names() {
        assert_eq!(slugs("Node.js"), ["nodejs", "node-js", "node"]);
        assert_eq!(slugs("PostgreSQL"), ["postgresql"]);
        assert_eq!(slugs("GitHub Actions"), ["githubactions", "github-actions"]);
        assert_eq!(norm("Next.js"), "nextjs");
        let urls = cdn_urls("Hono");
        assert_eq!(urls[0], ("devicon", "https://cdn.jsdelivr.net/gh/devicons/devicon/icons/hono/hono-original.svg".to_string()));
        assert_eq!(urls[1].1, "https://cdn.jsdelivr.net/gh/gilbarbara/logos/logos/hono-icon.svg");
        assert_eq!(urls[2].1, "https://cdn.jsdelivr.net/gh/gilbarbara/logos/logos/hono.svg");
        assert!(urls.iter().all(|(_, u)| allowed(u)));
    }

    #[test]
    fn svgl_is_asked_a_few_ways_and_only_an_exact_title_counts() {
        let (q, t) = svgl_queries("next-js");
        assert_eq!(q, ["next-js", "next js", "next"]);
        assert_eq!(t, ["nextjs", "next"]);
        assert_eq!(svgl_queries("Clerk").0, ["Clerk"]);
        assert_eq!(svgl_queries("Vue.js").0, ["Vue.js", "Vue js", "Vue"]);
        assert_eq!(svgl_queries("Redisjs").0, ["Redisjs", "Redis"]);
        assert_eq!(svgl_url("Better Auth"), "https://api.svgl.app/?search=Better+Auth");
        let items = serde_json::json!([
            {"title": "Vercel Analytics", "route": "https://svgl.app/library/va.svg"},
            {"title": "Vercel", "route": {"light": "https://svgl.app/library/vercel.svg", "dark": "https://svgl.app/library/vercel_dark.svg"}},
        ]);
        assert_eq!(svgl_pick(&items, &["vercel".into()]), Some(("https://svgl.app/library/vercel.svg".into(), Some("https://svgl.app/library/vercel_dark.svg".into()))));
        assert_eq!(svgl_pick(&items, &["verce".into()]), None);
        // a route elsewhere than svgl is not followed
        let odd = serde_json::json!([{"title": "Neon", "route": "https://evil.example/neon.svg"}]);
        assert_eq!(svgl_pick(&odd, &["neon".into()]), None);
    }

    #[test]
    fn only_plain_brand_names_are_looked_up() {
        assert_eq!(cache_key("Node.js").as_deref(), Some("node-js"));
        assert_eq!(cache_key("C++").as_deref(), Some("cplusplus"));
        assert_eq!(cache_key("../../etc/passwd"), None);
        assert_eq!(cache_key("주문 서비스"), None);
        assert_eq!(cache_key("https://internal.corp/x"), None);
        assert_eq!(cache_key(&"a".repeat(61)), None);
        assert!(!allowed("http://cdn.jsdelivr.net/x.svg"));
        assert!(!allowed("https://cdn.jsdelivr.net.evil.com/x.svg"));
        assert!(!allowed("https://cdn.jsdelivr.net:8443/x.svg"));
    }

    #[test]
    fn sanitizer_keeps_the_drawing_and_drops_everything_active() {
        let dirty = r##"<?xml version="1.0"?>
<!DOCTYPE svg [<!ENTITY x "boom">]>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:sodipodi="http://x" viewBox="0 0 24 24" onload="alert(1)" sodipodi:docname="a.svg">
  <script>alert(1)</script>
  <sodipodi:namedview id="n"/>
  <style>.a{fill:#f00} .b{fill:url(#g)}</style>
  <defs><linearGradient id="g"><stop offset="0" stop-color="#00f"/></linearGradient></defs>
  <foreignObject><div xmlns="http://www.w3.org/1999/xhtml">hi</div></foreignObject>
  <a href="javascript:alert(1)"><path class="a" d="M0 0h24v24z" onclick="x()"/></a>
  <use href="#g"/><use xlink:href="https://evil.example/s.svg#a"/>
  <image href="https://evil.example/t.png"/><image href="data:image/png;base64,AAAA"/>
  <rect style="fill:url(https://evil.example/p)" width="1" height="1"/>
  <animate attributeName="href" to="javascript:alert(1)"/>
  <text>A &amp; B &x; &#65;</text>
</svg>"##;
        let s = sanitize_svg(dirty).unwrap();
        for bad in ["script", "alert", "onload", "onclick", "foreignObject", "sodipodi", "evil.example", "javascript", "animate", "DOCTYPE", "boom"] {
            assert!(!s.contains(bad), "{bad} left in {s}");
        }
        assert!(s.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(s.contains("xmlns:xlink"));
        assert!(s.contains(r#"<path class="a" d="M0 0h24v24z"/>"#));
        assert!(s.contains(".a{fill:#f00} .b{fill:url(#g)}"));
        assert!(s.contains(r##"<use href="#g"/>"##));
        assert!(s.contains("data:image/png;base64,AAAA"));
        assert!(s.contains("A &amp; B  A</text>"));
        assert_eq!(aspect(&s), Some(1.0));
    }

    #[test]
    fn sanitizer_refuses_what_is_not_an_svg() {
        assert_eq!(sanitize_svg("<html><body>404</body></html>"), None);
        assert_eq!(sanitize_svg("<svg><path d='M0 0'></svg>"), None);
        assert_eq!(sanitize_svg("not xml"), None);
        assert_eq!(sanitize_svg("<svg viewBox='0 0 1 1'></svg>"), None);
        // written with end tags only (svgl's Next.js mark is), ids with colons
        let s = sanitize_svg(r#"<svg viewBox="0 0 180 180"><mask id=":r8:m" style="mask-type: alpha;"><circle r="90"></circle></mask><g mask="url(#:r8:m)"><circle fill="black" r="90"></circle></g></svg>"#).unwrap();
        assert!(s.contains(r#"<g mask="url(#:r8:m)"><circle fill="black" r="90"></circle></g>"#), "{s}");
        // a <style> reaching outside goes whole
        let s = sanitize_svg("<svg><style>@import url(https://x/y.css);</style><path d='M0 0'/></svg>").unwrap();
        assert!(!s.contains("import"));
    }

    #[test]
    fn a_one_grey_mark_says_its_tone() {
        assert_eq!(tone(r#"<svg><path d="M0 0"/></svg>"#), Some("dark"));
        assert_eq!(tone(r##"<svg><path fill="#000" d="M0 0"/><path style="fill:#1a1a1a"/></svg>"##), Some("dark"));
        assert_eq!(tone(r##"<svg><path fill="#fff"/><path fill="white" fill-rule="evenodd"/></svg>"##), Some("light"));
        assert_eq!(tone(r##"<svg><path fill="#00e599"/><path fill="#000"/></svg>"##), None);
        assert_eq!(tone(r##"<svg><path fill="#888"/></svg>"##), None);
        // Sentry's ink purple is as dark as black on a dark screen; Stripe's purple is not
        assert_eq!(tone(r##"<svg><path fill="#362D59"/></svg>"##), Some("dark"));
        assert_eq!(tone(r##"<svg><path fill="#635BFF"/></svg>"##), None);
        assert_eq!(tone(r##"<svg><path fill="#7B42BC"/></svg>"##), None);
        // a black circle (no fill given) under a white mark: both tones, nothing to turn
        let next = r##"<svg viewBox="0 0 128 128"><circle cx="64" cy="64" r="64"/><path fill="url(#a)" d="M1 1"/><defs><linearGradient id="a"><stop stop-color="#fff"/></linearGradient><clipPath id="c"><rect width="1" height="1"/></clipPath></defs></svg>"##;
        assert_eq!(tone(next), None);
        // white only, with an unfilled shape in a clip path: still white
        assert_eq!(tone(r##"<svg><defs><clipPath id="c"><rect/></clipPath></defs><g fill="#fff"><path d="M0 0"/></g></svg>"##), Some("light"));
    }

    #[test]
    fn wide_wordmarks_are_not_taken_from_the_cdns() {
        let wide = br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 60"><path d="M0 0h300v60z"/></svg>"#;
        assert!(mark(wide, false).is_none());
        assert!(mark(wide, true).is_some());
        let square = br##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path fill="#e33" d="M0 0h64v64z"/></svg>"##;
        let (url, tone) = mark(square, false).unwrap();
        assert!(url.starts_with("data:image/svg+xml;base64,"));
        assert_eq!(tone, None);
    }

    /// The real sources, over the network: `cargo test --lib logos -- --ignored`.
    /// LOGO_NAMES="Next.js,Neon" LOGO_DUMP=out.json writes what each name gets.
    #[test]
    #[ignore]
    fn live_sources_answer() {
        let names = std::env::var("LOGO_NAMES").unwrap_or_else(|_| "Vercel,Hono,Neon,Clerk,Stripe,GitHub Actions,PostgreSQL".into());
        let mut got = serde_json::Map::new();
        for name in names.split(',').map(str::trim).filter(|n| !n.is_empty()) {
            let logo = tauri::async_runtime::block_on(lookup(name)).ok().flatten();
            println!("{name:<20} {}", logo.as_ref().map_or("-".to_string(), |l| format!("{} dark:{} tone:{:?} {}B", l.source, l.dark.is_some(), l.tone, l.light.len())));
            got.insert(name.to_string(), serde_json::to_value(logo).unwrap());
        }
        if let Ok(out) = std::env::var("LOGO_DUMP") {
            std::fs::write(out, serde_json::to_vec_pretty(&got).unwrap()).unwrap();
        }
        assert!(got.get("Vercel").is_none_or(|v| v["dark"].is_string()), "svgl gives Vercel a dark variant");
        assert!(got.values().filter(|v| !v.is_null()).count() * 2 >= got.len(), "most brands found");
    }
}
