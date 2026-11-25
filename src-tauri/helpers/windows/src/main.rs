//! Local, single-window computer host. Only the operations below exist on this wire.
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

#[cfg(windows)]
mod desktop;

#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
enum Op {
    Launch { app: String },
    Observe { pid: u32, full: bool },
    Prepare { pid: u32, action: Scroll },
    Act { pid: u32, action: Scroll },
    Release { pid: u32 },
}
#[derive(Deserialize, PartialEq, Clone)]
#[serde(deny_unknown_fields)]
struct Scroll {
    kind: Kind,
    #[serde(rename = "ref")]
    element: String,
    direction: Direction,
    amount: u8,
}
#[derive(Deserialize, PartialEq, Clone)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Scroll,
}
#[derive(Deserialize, PartialEq, Clone)]
#[serde(rename_all = "lowercase")]
enum Direction {
    Up,
    Down,
}

type Result<T> = std::result::Result<T, &'static str>;
const UNSUPPORTED: &str = "WINDOWS_UNSUPPORTED";
#[cfg(windows)]
const UNSAFE: &str = "WINDOW_NOT_VERIFIABLE";

fn app_name(s: &str) -> bool {
    s.len() >= 5
        && s.len() <= 124
        && s.to_ascii_lowercase().ends_with(".exe")
        && (s.as_bytes()[0].is_ascii_alphanumeric() || s.starts_with('_'))
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_. -".contains(&b))
}

fn decode(v: &mut Value) -> Result<Op> {
    v.as_object_mut().ok_or(UNSUPPORTED)?.remove("id");
    let op: Op = serde_json::from_value(v.take()).map_err(|_| UNSUPPORTED)?;
    match &op {
        Op::Launch { app } if !app_name(app) => Err(UNSUPPORTED),
        Op::Prepare { action, .. } | Op::Act { action, .. } if action.amount != 1 => {
            Err(UNSUPPORTED)
        }
        _ => Ok(op),
    }
}

fn main() {
    if std::env::args_os().nth(1).is_some() {
        if std::env::args_os()
            .skip(1)
            .eq([std::ffi::OsString::from("--version")])
        {
            println!("ondra-cuhost {}", env!("CARGO_PKG_VERSION"));
        }
        return;
    }
    #[cfg(windows)]
    let mut host = desktop::Host::default();
    for line in io::stdin()
        .lock()
        .lines()
        .map_while(std::result::Result::ok)
    {
        let mut req: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        let id = req.get("id").cloned();
        let r: Result<Value> = decode(&mut req).and_then(|op| {
            #[cfg(windows)]
            {
                host.run(op)
            }
            #[cfg(not(windows))]
            {
                let _ = op;
                Err(UNSUPPORTED)
            }
        });
        let reply = match r {
            Ok(result) => json!({"version":1,"id":id,"ok":true,"result":result}),
            Err(code) => {
                json!({"version":1,"id":id,"ok":false,"error":{"code":code,"message": match code {
                "APP_NOT_FOUND" => "Choose one already-running .exe with a visible main window.",
                "AMBIGUOUS_APP" => "Multiple matching windows; leave one visible window and start again.",
                "STALE_REF" => "The selected control changed. Observe before acting again.",
                "USER_ACTIVE" => "The user is working in this app. Wait, then observe; no scroll was sent.",
                "ACTION_OUTCOME_UNKNOWN" => "The scroll may have been delivered. Observe; never blindly retry.",
                "WINDOW_NOT_VERIFIABLE" => "The window or its controls could not be verified as an ordinary visible list/document. Nothing from this window was returned.",
                _ => "This Windows helper supports only attach, observation and ref-based UI Automation scrolling."}}})
            }
        };
        let mut out = io::stdout().lock();
        if writeln!(out, "{reply}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_basename_only() {
        assert!(app_name("A list viewer.exe"));
        for app in [
            "-x.exe",
            "",
            "*.exe",
            "..\\a.exe",
            "C:/a.exe",
            "a.exe -flag",
            "a",
        ] {
            assert!(!app_name(app));
        }
    }
    #[test]
    fn no_input_or_approval_protocol_even_for_direct_requests() {
        for op in [
            "commit-approval",
            "targets",
            "target",
            "resume",
            "look",
            "press",
            "exec",
        ] {
            assert!(decode(&mut json!({"op":op,"id":"2"})).is_err());
        }
        let mut r = json!({"op":"act","pid":2,"action":{"kind":"scroll","ref":"s1","direction":"up","amount":1}});
        assert!(decode(&mut r.clone()).is_ok());
        r["action"]["text"] = json!("abc");
        assert!(decode(&mut r).is_err());
    }
}
