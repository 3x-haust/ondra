// `a11y`: accessibility checks on the page (WCAG 2.2 A/AA rules that can be checked from
// the DOM), and `vitals`: the page's load and responsiveness numbers. The scripts are the
// Swift tool's (see build.rs).

use crate::commands::{num, Args};
use crate::daemon::{Daemon, Outcome};
use crate::page_js::{A11Y_JS, VITALS_JS};
use crate::util::*;
use serde_json::Value;

impl Daemon {
    pub fn a11y(&self, a: &Args) -> Res<Outcome> {
        let t = self.tab()?;
        if let Some(url) = a.pos(0) {
            self.navigate(&t, url, "load", 25000.0)?;
        }
        let sel = a.get("selector").map(quote).unwrap_or_else(|| "null".into());
        let v = self.eval_value_t(&t, &format!("({A11Y_JS})({sel})"), 120.0)?.as_object().cloned().unwrap_or_default();
        let lines: Vec<String> = v
            .arr("violations")
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|x| x.as_object())
            .map(|x| {
                let nodes = x.arr("nodes").cloned().unwrap_or_default();
                let first = nodes.first().and_then(|n| n.get("target")).and_then(|t| t.get(0)).and_then(|t| t.as_str()).unwrap_or_default().to_string();
                format!("{} {} ×{} {first} — {}", x.str("impact").unwrap_or_default(), x.str("id").unwrap_or_default(), nodes.len(), x.str("help").unwrap_or_default())
            })
            .collect();
        let text = if lines.is_empty() { format!("✓ No violations ({} rules checked)", v.int("rules").unwrap_or(0)) } else { lines.join("\n") };
        Ok(Outcome::new(Value::Object(v), text))
    }

    pub fn vitals(&self, a: &Args) -> Res<Outcome> {
        let t = self.tab()?;
        if let Some(url) = a.pos(0) {
            self.navigate(&t, url, "load", 25000.0)?;
        }
        let v = self.eval_value(&t, VITALS_JS)?.as_object().cloned().unwrap_or_default();
        let ms = |k: &str| v.int(k).map(|x| format!("{x} ms")).unwrap_or_else(|| "–".into());
        let cls = v.dbl("cls").map(num).unwrap_or_else(|| "–".into());
        let text = format!("LCP {} · CLS {cls} · INP {} · FCP {} · TTFB {} · load {}", ms("lcp"), ms("inp"), ms("fcp"), ms("ttfb"), ms("load"));
        Ok(Outcome::new(Value::Object(v), text))
    }
}
