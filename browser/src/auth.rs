// `auth login <site> --credential-provider keychain`: fill a login form from the system's
// password store (the macOS keychain, Windows Credential Manager, the Secret Service on Linux).
// The password goes store → the app's credential helper → this process → the page's field.
// It is never printed, logged, returned or written anywhere.

use crate::commands::{err, Args};
use crate::daemon::{Daemon, Outcome};
use crate::page_js::{FIND_FIELDS_JS, SUBMIT_JS};
use crate::tab::Tab;
use crate::util::*;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::Stdio;

const SET_PASSWORD_JS: &str = r#"function(v) {
  if (this.value === v) return;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  set ? set.call(this, v) : (this.value = v);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
}"#;

type Fields = (Option<String>, Option<String>);

impl Daemon {
    /// The account and password for a URL, from the credential helper the app names.
    fn credential(&self, url: &str, item: Option<&str>) -> Res<(String, String)> {
        let Some(helper) = self.config.keychain.as_deref().filter(|h| std::path::Path::new(h).is_file()) else {
            return err("keychain sign-in is not available here (no credential helper)");
        };
        let mut p = quiet_command(helper).arg("--keychain-credential").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
        let req = json!({ "protocol": "ondra.keychain.v1", "type": "credential.resolve", "request": { "url": url, "itemRef": item } });
        if let Some(mut i) = p.stdin.take() {
            let _ = i.write_all(json_string(&req).as_bytes());
        }
        // the user may be looking at an approval prompt
        let mut out = Vec::new();
        if let Some(mut o) = p.stdout.take() {
            let _ = o.read_to_end(&mut out);
        }
        let _ = p.wait();
        let reply: Json = serde_json::from_slice(&out).map_err(|_| "the keychain gave no answer".to_string())?;
        let c = reply.obj("credential");
        match (reply.bool("success"), c.and_then(|c| c.str("password")).filter(|p| !p.is_empty())) {
            (Some(true), Some(pw)) => Ok((c.and_then(|c| c.str("username")).unwrap_or_default().to_string(), pw.to_string())),
            _ => {
                let why = reply.str("error").unwrap_or("not found");
                err(if why == "not found" { "no saved password for this site in the keychain (or the user denied it)".to_string() } else { format!("keychain: {why}") })
            }
        }
    }

    /// The field's page is on the site the credential was looked up for (or one of its subdomains).
    fn same_site(&self, t: &Tab, field: &str, url: &str) -> Res<()> {
        let r = self.call_on(t, field, "function(){ return this.ownerDocument.location.href; }", vec![], true)?;
        let page = r.str("value").unwrap_or_default().to_string();
        let (want, have) = (host_of(url), host_of(&page));
        let related = !want.is_empty() && (have == want || have.ends_with(&format!(".{want}")) || want.ends_with(&format!(".{have}")) && have.contains('.'));
        if related {
            Ok(())
        } else {
            err(format!("the sign-in form is on {} but the password is for {}; open the login page for that site first", if have.is_empty() { "an unknown page" } else { &have }, want))
        }
    }

    fn fields(&self, t: &Tab, user_sel: Option<&str>, pass_sel: Option<&str>) -> Res<Fields> {
        let q = |s: Option<&str>| s.map(quote).unwrap_or_else(|| "null".into());
        let r = self.call("Runtime.evaluate", obj!({ "expression": format!("({FIND_FIELDS_JS})({}, {})", q(user_sel), q(pass_sel)) }), t)?;
        let Some(obj) = r.obj("result").and_then(|x| x.str("objectId")).map(String::from) else { return Ok((None, None)) };
        let res = (|| {
            let u = self.call_on(t, &obj, "function(){return this.user}", vec![], false)?;
            let p = self.call_on(t, &obj, "function(){return this.pass}", vec![], false)?;
            let id = |x: &Json| if x.str("subtype") == Some("null") { None } else { x.str("objectId").map(String::from) };
            Ok((id(&u), id(&p)))
        })();
        self.release(t, &obj);
        res
    }

    fn submit(&self, t: &Tab, field: &str, sel: Option<&str>) -> Res<()> {
        let r = self.call_on(t, field, SUBMIT_JS, vec![sel.map(|s| json!(s)).unwrap_or(Value::Null)], false)?;
        if r.str("subtype") != Some("null") {
            if let Some(b) = r.str("objectId") {
                let ok = self.click(t, b, 1).is_ok();
                self.release(t, b);
                if ok {
                    return Ok(());
                }
            }
        }
        self.focus(t, field)?;
        self.press(t, "Enter")
    }

    pub fn auth(&self, a: &Args) -> Res<Outcome> {
        if a.pos(0) != Some("login") {
            return err("usage: auth login <site> --credential-provider keychain [--url <login page>] [--no-navigate] [--item <account>]");
        }
        let site = a.pos(1).unwrap_or_default().to_string();
        if a.get("credential-provider").unwrap_or("keychain") != "keychain" {
            return err("the only credential provider is keychain");
        }
        let t = self.tab()?;
        if !a.has("no-navigate") {
            if let Some(u) = a.get("url") {
                self.navigate(&t, u, "domcontentloaded", 25000.0)?;
            }
        }
        let mut url = a.get("url").map(String::from).unwrap_or_else(|| t.url());
        if !url.contains("://") {
            url = if site.is_empty() { t.url() } else { format!("https://{site}") };
        }
        let (user_sel, pass_sel, submit_sel) = (a.get("username-selector"), a.get("password-selector"), a.get("submit-selector"));

        // the form may still be rendering
        let (user0, pass0) = poll(15000.0, 100.0, "a login form", || {
            let f = self.fields(&t, user_sel, pass_sel)?;
            Ok((f.1.is_some() || f.0.is_some()).then_some(f))
        })?;
        let (account, password) = self.credential(&url, a.get("item"))?;
        let (mut user, mut pass) = (user0, pass0);
        let mut filled_user = false;
        if let Some(u) = &user {
            if !account.is_empty() {
                self.same_site(&t, u, &url)?;
                self.fill(&t, u, &account)?;
                filled_user = true;
            }
        }
        if pass.is_none() {
            if let Some(u) = user.take() {
                // a two-step sign-in: the account first, then the password page
                self.submit(&t, &u, submit_sel)?;
                self.release(&t, &u);
                pass = Some(poll(20000.0, 100.0, "the password field", || {
                    let f = self.fields(&t, None, pass_sel).ok();
                    if let Some(u) = f.as_ref().and_then(|f| f.0.as_ref()) {
                        self.release(&t, u);
                    }
                    Ok(f.and_then(|f| f.1))
                })?);
            }
        }
        let Some(pw) = pass else { return err("no password field on the page") };
        // the page may have moved on (a redirect, the second step of a sign-in): fill only the site the password is for
        self.same_site(&t, &pw, &url)?;
        self.focus(&t, &pw)?;
        self.call_on(&t, &pw, "function(){ if (typeof this.select === 'function') this.select(); }", vec![], true)?;
        {
            let mut st = t.s();
            st.signed_in = true;
            for r in st.requests.values_mut() {
                r.post_data = None;
            }
        }
        self.call("Input.insertText", obj!({ "text": password }), &t)?;
        self.call_on(&t, &pw, SET_PASSWORD_JS, vec![json!(password)], true)?;
        self.submit(&t, &pw, submit_sel)?;
        self.release(&t, &pw);
        if let Some(u) = &user {
            self.release(&t, u);
        }
        sleep_ms(500.0);
        let _ = self.wait_lifecycle(&t, None, "domcontentloaded", 15000.0, None);
        let info = self.page_info(&t).unwrap_or_default();
        let now = info.str("url").unwrap_or_default().to_string();
        let who = if account.is_empty() { String::new() } else { format!(" as {account}") };
        Ok(Outcome::new(json!({ "site": site, "account": account, "filledUsername": filled_user, "url": now }), format!("✓ Filled the sign-in form{who} from the keychain; now on {now}")))
    }
}

/// `https://user@accounts.example.com:8443/login?x` → `accounts.example.com`.
fn host_of(url: &str) -> String {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if authority.starts_with('[') { authority.split(']').next().unwrap_or_default().trim_start_matches('[') } else { authority.split(':').next().unwrap_or_default() };
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    #[test]
    fn hosts() {
        assert_eq!(super::host_of("https://me@Login.Example.com:8443/x?y"), "login.example.com");
        assert_eq!(super::host_of("http://127.0.0.1:8765/login.html"), "127.0.0.1");
        assert_eq!(super::host_of("about:blank"), "about");
    }
}
