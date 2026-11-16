// What a web link in the chat points at, for the card that shows when the pointer rests on it:
// the page's title, its one-line description, the site's name and icon. Read from the page's own
// <head> (no outside service in between), only for public http(s) addresses, a little at a time.
use base64::Engine;
use serde::Serialize;
use std::time::Duration;

const PAGE_BYTES: usize = 512 * 1024;
const ICON_BYTES: usize = 128 * 1024;

#[derive(Serialize, Default, Debug, PartialEq)]
pub struct LinkCard {
    pub title: Option<String>,
    pub description: Option<String>,
    pub site: Option<String>,
    /// the site's icon as a data: URL
    pub icon: Option<String>,
}

/// Only pages on the open web: no localhost, no addresses on this network, no other schemes.
pub fn public(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://")) else { return false };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or("");
    let host = if host.starts_with('[') { host } else { host.split(':').next().unwrap_or("") }.to_ascii_lowercase();
    if host.is_empty() || host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") || !host.contains('.') && !host.starts_with('[') {
        return false;
    }
    if host.starts_with('[') {
        return false; // IPv6 literals: none of ours to show
    }
    if let Ok(ip) = host.parse::<std::net::Ipv4Addr>() {
        return !(ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast() || ip.octets()[0] == 100 && (64..128).contains(&ip.octets()[1]));
    }
    true
}

fn client() -> Result<reqwest::Client, ()> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent(concat!("Mozilla/5.0 (Macintosh) Ondra/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::custom(|a| if a.previous().len() > 4 || !public(a.url().as_str()) { a.stop() } else { a.follow() }))
        .build()
        .map_err(|_| ())
}

/// up to `max` bytes of `url`'s body, with the type it says it is and where it ended up
async fn get(http: &reqwest::Client, url: &str, max: usize) -> Option<(Vec<u8>, String, String)> {
    if !public(url) {
        return None;
    }
    let mut res = http.get(url).header("Accept-Language", "ko,en;q=0.8").send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let kind = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
    let at = res.url().to_string();
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = res.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() >= max {
            body.truncate(max);
            break;
        }
    }
    Some((body, kind, at))
}

fn decode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest.find(';').filter(|&e| e <= 10);
        let Some(e) = end else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..e];
        let ch = match name {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            _ if name.starts_with("#x") || name.starts_with("#X") => u32::from_str_radix(&name[2..], 16).ok().and_then(char::from_u32),
            _ if name.starts_with('#') => name[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[e + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// the attributes of one tag (`<meta …>` without the brackets), names lowercased
fn attrs(tag: &str) -> Vec<(String, String)> {
    let b = tag.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'/' {
            i += 1;
        }
        let name = tag[start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                i += 1;
                let s = i;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                value = tag[s..i].to_string();
                i += 1;
            } else {
                let s = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                value = tag[s..i].to_string();
            }
        }
        if !name.is_empty() {
            out.push((name, value));
        }
    }
    out
}

/// Every `<name …>` tag in `html` (case-insensitive), as its attribute text.
fn tags<'a>(html: &'a str, lower: &'a str, name: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    let open = format!("<{name}");
    let mut from = 0;
    std::iter::from_fn(move || loop {
        let i = from + lower[from..].find(&open)?;
        let after = i + open.len();
        let end = after + lower[after..].find('>')?;
        from = end;
        if lower.as_bytes().get(after).is_some_and(|c| c.is_ascii_whitespace()) {
            return Some(&html[after..end]);
        }
    })
}

/// A URL found in a page, made absolute against the page's own address.
fn absolute(base: &str, href: &str) -> Option<String> {
    let href = href.trim();
    if href.starts_with("http://") || href.starts_with("https://") {
        return Some(href.to_string());
    }
    let (scheme, rest) = base.split_once("://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    if let Some(h) = href.strip_prefix("//") {
        return Some(format!("{scheme}://{h}"));
    }
    if href.starts_with('/') {
        return Some(format!("{scheme}://{host}{href}"));
    }
    if href.is_empty() || href.starts_with("data:") || href.contains(':') {
        return None;
    }
    let path = rest[host.len()..].split(['?', '#']).next().unwrap_or("/");
    let dir = &path[..path.rfind('/').map_or(0, |i| i + 1)];
    Some(format!("{scheme}://{host}{}{href}", if dir.is_empty() { "/" } else { dir }))
}

/// What the page's <head> says about it, and where its icon is.
pub fn read_head(html: &str, at: &str) -> (LinkCard, Option<String>) {
    let lower = html.to_ascii_lowercase();
    let head_end = lower.find("</head>").unwrap_or(html.len());
    let (html, lower) = (&html[..head_end], &lower[..head_end]);
    let mut card = LinkCard::default();
    let mut og_title = None;
    let mut og_desc = None;
    let mut desc = None;
    for t in tags(html, lower, "meta") {
        let a = attrs(t);
        let get = |k: &str| a.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        let key = get("property").or_else(|| get("name")).unwrap_or("").to_ascii_lowercase();
        let Some(content) = get("content").map(decode).filter(|c| !c.is_empty()) else { continue };
        match key.as_str() {
            "og:title" | "twitter:title" if og_title.is_none() => og_title = Some(content),
            "og:description" | "twitter:description" if og_desc.is_none() => og_desc = Some(content),
            "description" if desc.is_none() => desc = Some(content),
            "og:site_name" if card.site.is_none() => card.site = Some(content),
            _ => {}
        }
    }
    let title = lower.find("<title").and_then(|i| {
        let open = i + lower[i..].find('>')? + 1;
        let close = open + lower[open..].find("</title")?;
        Some(decode(&html[open..close])).filter(|t| !t.is_empty())
    });
    card.title = og_title.or(title).map(|t| clip(&t, 200));
    card.description = og_desc.or(desc).map(|d| clip(&d, 300));
    // a big square icon reads better than a 16px favicon
    let mut icon: Option<(i32, String)> = None;
    for t in tags(html, lower, "link") {
        let a = attrs(t);
        let get = |k: &str| a.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        let rel = get("rel").unwrap_or("").to_ascii_lowercase();
        let Some(href) = get("href") else { continue };
        let rank = if rel.contains("apple-touch-icon") { 3 } else if rel.split_whitespace().any(|r| r == "icon") { if href.ends_with(".svg") { 1 } else { 2 } } else { continue };
        if icon.as_ref().is_none_or(|(r, _)| rank > *r) {
            if let Some(u) = absolute(at, &decode(href)) {
                icon = Some((rank, u));
            }
        }
    }
    let icon = icon.map(|(_, u)| u).or_else(|| absolute(at, "/favicon.ico"));
    (card, icon)
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut t: String = s.chars().take(max - 1).collect();
    t.push('…');
    t
}

#[tauri::command]
pub async fn link_card(url: String) -> Option<LinkCard> {
    if !public(&url) {
        return None;
    }
    let http = client().ok()?;
    let (body, kind, at) = get(&http, &url, PAGE_BYTES).await?;
    if !kind.is_empty() && !kind.contains("html") {
        return None;
    }
    let (mut card, icon) = read_head(&String::from_utf8_lossy(&body), &at);
    if let Some(u) = icon {
        if let Some((bytes, kind, _)) = get(&http, &u, ICON_BYTES).await {
            let kind = kind.split(';').next().unwrap_or("").trim().to_string();
            let svg = kind.contains("svg") || u.ends_with(".svg");
            // an SVG icon is drawn as an <img>, where it cannot run anything
            let kind = if svg { "image/svg+xml".to_string() } else if kind.starts_with("image/") { kind } else if u.ends_with(".ico") { "image/x-icon".to_string() } else { String::new() };
            if !kind.is_empty() && !bytes.is_empty() && bytes.len() < ICON_BYTES {
                card.icon = Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)));
            }
        }
    }
    Some(card)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_public_web_pages() {
        assert!(public("https://www.example.com/a?b"));
        assert!(public("http://news.ycombinator.com"));
        for u in ["file:///etc/passwd", "http://localhost:3000", "http://127.0.0.1/", "http://192.168.0.10/admin", "http://10.0.0.1", "http://printer.local/", "http://[::1]/", "https://intranet/", "http://169.254.169.254/latest", "http://100.100.1.1/"] {
            assert!(!public(u), "{u}");
        }
    }

    #[test]
    fn reads_the_head() {
        let html = r#"<html><head><meta charset="utf-8"><title>Plain &amp; title</title>
            <meta property="og:title" content="The &quot;real&quot; title">
            <meta name=description content='What it is about'>
            <meta property="og:site_name" content="Example">
            <link rel="icon" href="/fav.png"><link rel="apple-touch-icon" href="touch.png">
            </head><body><meta name="description" content="not this"></body></html>"#;
        let (card, icon) = read_head(html, "https://example.com/docs/page.html");
        assert_eq!(card.title.as_deref(), Some("The \"real\" title"));
        assert_eq!(card.description.as_deref(), Some("What it is about"));
        assert_eq!(card.site.as_deref(), Some("Example"));
        assert_eq!(icon.as_deref(), Some("https://example.com/docs/touch.png"));
    }

    #[test]
    fn falls_back_to_the_title_and_the_favicon() {
        let (card, icon) = read_head("<head><TITLE>\n  Only   a title </TITLE></head>", "https://a.example.org/x");
        assert_eq!(card.title.as_deref(), Some("Only a title"));
        assert_eq!(card.description, None);
        assert_eq!(icon.as_deref(), Some("https://a.example.org/favicon.ico"));
    }

    #[test]
    #[ignore]
    fn a_real_page() {
        let card = tauri::async_runtime::block_on(link_card("https://github.com/deepseek-ai/chat-demo".into())).expect("a card");
        eprintln!("{:?} {:?} {:?} icon={}", card.title, card.description, card.site, card.icon.as_ref().map_or(0, |i| i.len()));
        assert!(card.title.is_some() && card.icon.is_some());
    }
}
