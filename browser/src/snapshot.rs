// `snapshot`: the page's accessibility tree as indented lines, with refs (`@e3`) for the
// things a command can act on.
//
//   - role "name" [prop=value, ref=eN]: value
//
// Refs stay the same for the same element across snapshots of one page.

use crate::daemon::Daemon;
use crate::page_js::{CLICKABLE_JS, DEEP_QUERY_JS};
use crate::tab::{RefEntry, Tab};
use crate::util::*;
use serde_json::{json, Value};
use std::collections::HashMap;

pub struct SnapOptions {
    pub compact: bool,
    pub interactive: bool,
    pub selector: Option<String>,
    pub urls: bool,
    pub depth: i64,
}

impl Default for SnapOptions {
    fn default() -> Self {
        // Swift's Int.max, as the --delta key spells it
        SnapOptions { compact: false, interactive: false, selector: None, urls: false, depth: i64::MAX }
    }
}

/// Roles that get a ref.
const REF_ROLES: &[&str] = &[
    "link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "DisclosureTriangle", "heading", "listbox",
    "MenuListOption", "ToggleButton", "PopUpButton",
];

/// Wrappers that say nothing on their own: their children take their place.
const HOISTED: &[&str] = &["generic", "none", "GenericContainer", "Ignored", "IgnoredRole", "Section", "RootWebArea", "WebArea"];

struct Line {
    text: String,
    has_ref: bool,
    is_text: bool,
    kids: Vec<Line>,
}

fn ids(n: &Json, k: &str) -> Vec<String> {
    n.arr(k).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn name_of(n: &Json) -> String {
    n.obj("name").and_then(|x| x.str("value")).unwrap_or_default().to_string()
}

fn prop<'a>(n: &'a Json, name: &str) -> Option<&'a Value> {
    n.arr("properties")?.iter().filter_map(|p| p.as_object()).find(|p| p.str("name") == Some(name))?.obj("value")?.get("value")
}

impl Daemon {
    /// The clickable plain elements: backend node id → why.
    fn clickables(&self, tab: &Tab) -> HashMap<i64, String> {
        let mut out = HashMap::new();
        let Ok(r) = self.call("Runtime.evaluate", obj!({ "expression": CLICKABLE_JS, "returnByValue": false }), tab) else { return out };
        let Some(obj) = r.obj("result").and_then(|x| x.str("objectId")).map(String::from) else { return out };
        let why: Vec<String> = self.on(tab, &obj, "function(){return this.why}").ok().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
        let els = self.call_on(tab, &obj, "function(){return this.els}", vec![], false).ok().and_then(|r| r.str("objectId").map(String::from));
        self.release(tab, &obj);
        let Some(els) = els else { return out };
        if let Ok(props) = self.call("Runtime.getProperties", obj!({ "objectId": els, "ownProperties": true }), tab) {
            for p in props.arr("result").cloned().unwrap_or_default() {
                let p = p.as_object().cloned().unwrap_or_default();
                let (Some(i), Some(oid)) = (p.str("name").and_then(|n| n.parse::<usize>().ok()), p.obj("value").and_then(|v| v.str("objectId"))) else { continue };
                if i >= why.len() {
                    continue;
                }
                if let Ok(d) = self.call("DOM.describeNode", obj!({ "objectId": oid }), tab) {
                    if let Some(b) = d.obj("node").and_then(|n| n.int("backendNodeId")) {
                        out.insert(b, why[i].clone());
                    }
                }
            }
        }
        self.release(tab, &els);
        out
    }

    /// Every accessibility node of the page, frames included: id → node, and the root's id.
    pub fn ax_tree(&self, tab: &Tab) -> Res<(HashMap<String, Json>, Option<String>)> {
        let r = self.cdp.call("Accessibility.getFullAXTree", Json::new(), Some(&tab.session_id), 60.0)?;
        let mut nodes: HashMap<String, Json> = HashMap::new();
        let mut root = None;
        for n in r.arr("nodes").cloned().unwrap_or_default() {
            let Some(n) = n.as_object().cloned() else { continue };
            let Some(id) = n.str("nodeId").map(String::from) else { continue };
            if root.is_none() && n.str("parentId").is_none() {
                root = Some(id.clone());
            }
            nodes.insert(id, n);
        }
        // same-process frames: graft each frame's tree under its <iframe>
        if let Some(top) = self.call("Page.getFrameTree", Json::new(), tab).ok().and_then(|t| t.obj("frameTree").cloned()) {
            fn collect(f: &Json, out: &mut Vec<String>) {
                for c in f.arr("childFrames").cloned().unwrap_or_default() {
                    let c = c.as_object().cloned().unwrap_or_default();
                    if let Some(id) = c.obj("frame").and_then(|f| f.str("id")) {
                        out.push(id.into());
                    }
                    collect(&c, out);
                }
            }
            let mut frames = Vec::new();
            collect(&top, &mut frames);
            if !frames.is_empty() {
                let by_backend: HashMap<i64, String> = nodes.iter().filter_map(|(id, n)| n.int("backendDOMNodeId").map(|b| (b, id.clone()))).collect();
                let _ = self.call("DOM.enable", Json::new(), tab);
                for (i, fid) in frames.iter().take(20).enumerate() {
                    let Ok(owner) = self.call("DOM.getFrameOwner", obj!({ "frameId": fid }), tab) else { continue };
                    let Some(host_id) = owner.int("backendNodeId").and_then(|b| by_backend.get(&b)).cloned() else { continue };
                    let Ok(sub) = self.call("Accessibility.getFullAXTree", obj!({ "frameId": fid }), tab) else { continue };
                    let mut sub_root = None;
                    for n in sub.arr("nodes").cloned().unwrap_or_default() {
                        let Some(mut m) = n.as_object().cloned() else { continue };
                        let Some(id) = m.str("nodeId").map(String::from) else { continue };
                        let key = format!("f{i}-{id}");
                        let kids: Vec<String> = ids(&m, "childIds").iter().map(|c| format!("f{i}-{c}")).collect();
                        m.insert("childIds".into(), json!(kids));
                        if sub_root.is_none() && m.str("parentId").is_none() {
                            sub_root = Some(key.clone());
                        }
                        nodes.insert(key, m);
                    }
                    if let (Some(s), Some(host)) = (sub_root, nodes.get_mut(&host_id)) {
                        let mut kids = ids(host, "childIds");
                        kids.push(s);
                        host.insert("childIds".into(), json!(kids));
                    }
                }
            }
        }
        Ok((nodes, root))
    }

    pub fn snapshot(&self, tab: &Tab, o: &SnapOptions) -> Res<(String, Json)> {
        let clicks = self.clickables(tab);
        let (nodes, root_id) = self.ax_tree(tab)?;
        let Some(mut start) = root_id else { return Ok((String::new(), Json::new())) };
        if let Some(sel) = &o.selector {
            let el = self.element(tab, sel)?;
            let d = self.call("DOM.describeNode", obj!({ "objectId": el }), tab);
            self.release(tab, &el);
            let Some(b) = d?.obj("node").and_then(|n| n.int("backendNodeId")) else { return Err(format!("nothing matches {sel}")) };
            if let Some((k, _)) = nodes.iter().find(|(_, n)| n.int("backendDOMNodeId") == Some(b)) {
                start = k.clone();
            }
        }

        let text_of = |id: &str, limit: usize| -> String {
            let mut parts: Vec<String> = Vec::new();
            let mut total = 0usize;
            fn walk(id: &str, nodes: &HashMap<String, Json>, parts: &mut Vec<String>, total: &mut usize, limit: usize) {
                if *total >= limit {
                    return;
                }
                let Some(n) = nodes.get(id) else { return };
                if n.obj("role").and_then(|r| r.str("value")) == Some("StaticText") {
                    let s = name_of(n);
                    if !s.is_empty() {
                        *total += s.chars().count();
                        parts.push(s);
                        return;
                    }
                }
                for c in ids(n, "childIds") {
                    walk(&c, nodes, parts, total, limit);
                }
            }
            walk(id, &nodes, &mut parts, &mut total, limit);
            clip(&parts.join(" "), limit)
        };

        let mut refs_out = Json::new();
        struct Ctx<'a> {
            d: &'a Daemon,
            tab: &'a Tab,
            o: &'a SnapOptions,
            nodes: &'a HashMap<String, Json>,
            clicks: &'a HashMap<i64, String>,
            text_of: &'a dyn Fn(&str, usize) -> String,
        }
        fn build(c: &Ctx, id: &str, depth: i64, parent_name: &str, out: &mut Vec<Line>, refs_out: &mut Json) {
            let Some(n) = c.nodes.get(id) else { return };
            if depth > c.o.depth {
                return;
            }
            let role = n.obj("role").and_then(|r| r.str("value")).unwrap_or_default().to_string();
            let backend = n.int("backendDOMNodeId");
            let why = backend.and_then(|b| c.clicks.get(&b)).cloned();
            let kids = ids(n, "childIds");
            if role == "InlineTextBox" || (role == "LineBreak" && c.o.compact) {
                return;
            }
            let ignored = n.bool("ignored") == Some(true);
            let mut name = name_of(n).trim().to_string();
            if (ignored && why.is_none()) || (HOISTED.contains(&role.as_str()) && why.is_none() && (name.is_empty() || role == "RootWebArea" || role == "WebArea")) {
                for k in &kids {
                    build(c, k, depth, parent_name, out, refs_out);
                }
                return;
            }
            let pad = "  ".repeat(depth as usize);
            if role == "StaticText" {
                if name.is_empty() || parent_name.contains(&name) {
                    return;
                }
                out.push(Line { text: format!("{pad}- StaticText \"{}\"", quote_for_snapshot(&clip(&name, 300))), has_ref: false, is_text: true, kids: vec![] });
                return;
            }
            let mut attrs: Vec<String> = Vec::new();
            if let Some(l) = prop(n, "level") {
                attrs.push(format!("level={}", crate::commands::plain(l)));
            }
            if let Some(x) = prop(n, "checked") {
                attrs.push(format!("checked={}", crate::commands::plain(x)));
            }
            if let Some(e) = prop(n, "expanded").and_then(|v| v.as_bool()) {
                attrs.push(format!("expanded={e}"));
            }
            if prop(n, "selected").and_then(|v| v.as_bool()) == Some(true) {
                attrs.push("selected".into());
            }
            if let Some(p) = prop(n, "pressed") {
                attrs.push(format!("pressed={}", crate::commands::plain(p)));
            }
            if prop(n, "disabled").and_then(|v| v.as_bool()) == Some(true) {
                attrs.push("disabled".into());
            }
            if prop(n, "required").and_then(|v| v.as_bool()) == Some(true) {
                attrs.push("required".into());
            }
            if prop(n, "invalid").and_then(|v| v.as_str()).is_some_and(|i| i != "false") {
                attrs.push("invalid".into());
            }
            if prop(n, "readonly").and_then(|v| v.as_bool()) == Some(true) {
                attrs.push("readonly".into());
            }
            let mut has_ref = false;
            if let Some(b) = backend.filter(|_| REF_ROLES.contains(&role.as_str()) || why.is_some()) {
                if why.is_some() && name.is_empty() && c.o.interactive {
                    name = (c.text_of)(id, 80);
                }
                let r = c.tab.s().ref_for(b, &role, &name);
                attrs.push(format!("ref={r}"));
                refs_out.insert(r, json!({ "role": role, "name": name }));
                has_ref = true;
            }
            if c.o.urls && role == "link" {
                if let Some(u) = prop(n, "url").and_then(|v| v.as_str()).filter(|u| !u.is_empty()) {
                    attrs.push(format!("url={u}"));
                }
            }
            let mut line = format!("{pad}- {role}");
            if !name.is_empty() {
                line += &format!(" \"{}\"", quote_for_snapshot(&clip(&name, 300)));
            }
            if !attrs.is_empty() {
                line += &format!(" [{}]", attrs.join(", "));
            }
            let mut shown_value = String::new();
            if let Some(v) = n.obj("value").and_then(|v| v.get("value")).filter(|v| !v.is_null()) {
                let s = crate::commands::plain(v).replace('\n', " ");
                if !s.is_empty() && role != "heading" && role != "link" {
                    line += &format!(": {}", clip(&s, 200));
                    shown_value = s;
                }
            }
            if let Some(w) = &why {
                line += &format!(" clickable [{w}]");
            }
            // text that only repeats the name or the value adds nothing
            let said = if name.is_empty() && shown_value.is_empty() { String::new() } else { format!("{name}\u{1}{shown_value}") };
            let mut me = Line { text: line, has_ref, is_text: false, kids: vec![] };
            for k in &kids {
                build(c, k, depth + 1, &said, &mut me.kids, refs_out);
            }
            out.push(me);
        }

        let ctx = Ctx { d: self, tab, o, nodes: &nodes, clicks: &clicks, text_of: &text_of };
        let _ = ctx.d;
        let mut top = Vec::new();
        build(&ctx, &start, 0, "", &mut top, &mut refs_out);

        fn any_ref(l: &Line) -> bool {
            l.has_ref || l.kids.iter().any(any_ref)
        }
        fn emit(l: &Line, parent_kept: bool, ref_depth: usize, o: &SnapOptions, lines: &mut Vec<String>) {
            if o.interactive {
                if l.has_ref {
                    lines.push("  ".repeat(ref_depth) + l.text.trim_matches(' '));
                }
                for k in &l.kids {
                    emit(k, true, ref_depth + usize::from(l.has_ref), o, lines);
                }
                return;
            }
            if o.compact {
                if l.is_text {
                    if parent_kept {
                        lines.push(l.text.clone());
                    }
                    return;
                }
                if !any_ref(l) {
                    return;
                }
            }
            lines.push(l.text.clone());
            for k in &l.kids {
                emit(k, true, ref_depth, o, lines);
            }
        }
        let mut lines = Vec::new();
        for l in &top {
            emit(l, false, 0, o, &mut lines);
        }
        // a hoisted wrapper leaves its children deeper than their new parent: re-indent
        let mut out = Vec::new();
        let mut stack: Vec<(usize, i64)> = Vec::new(); // (raw depth, shown depth)
        for raw in lines {
            let spaces = raw.chars().take_while(|c| *c == ' ').count();
            let d = spaces / 2;
            while stack.last().is_some_and(|l| l.0 >= d) {
                stack.pop();
            }
            let shown = stack.last().map(|l| l.1).unwrap_or(-1) + 1;
            stack.push((d, shown));
            out.push("  ".repeat(shown as usize) + &raw[spaces..]);
        }
        Ok((out.join("\n"), refs_out))
    }

    /// A ref's element now. A node the page replaced is found again by its role and name
    /// when exactly one matches.
    fn resolve_ref(&self, tab: &Tab, r: &str) -> Res<String> {
        let Some(entry) = tab.s().refs.get(r).cloned() else { return Err(format!("Unknown ref: {r}")) };
        if let Ok(x) = self.call("DOM.resolveNode", obj!({ "backendNodeId": entry.backend_id }), tab) {
            if let Some(oid) = x.obj("object").and_then(|o| o.str("objectId")) {
                let connected = self.on(tab, oid, "function(){return this.isConnected}").ok().and_then(|v| v.as_bool()).unwrap_or(true);
                if connected {
                    return Ok(oid.into());
                }
            }
        }
        let (nodes, _) = self.ax_tree(tab)?;
        let same: Vec<&Json> = nodes
            .values()
            .filter(|n| n.bool("ignored") != Some(true) && n.obj("role").and_then(|x| x.str("value")) == Some(entry.role.as_str()) && name_of(n).trim() == entry.name && n.int("backendDOMNodeId").is_some())
            .collect();
        if same.is_empty() {
            return Err(format!("{r} ({} \"{}\") is no longer on the page; take a new snapshot", entry.role, entry.name));
        }
        if same.len() != 1 {
            return Err(format!("{r} ({} \"{}\") now matches {} elements; take a new snapshot", entry.role, entry.name, same.len()));
        }
        let b = same[0].int("backendDOMNodeId").unwrap();
        {
            let mut s = tab.s();
            s.ref_of.remove(&entry.backend_id);
            s.ref_of.insert(b, r.into());
            s.refs.insert(r.into(), RefEntry { backend_id: b, role: entry.role.clone(), name: entry.name.clone() });
        }
        let x = self.call("DOM.resolveNode", obj!({ "backendNodeId": b }), tab)?;
        x.obj("object").and_then(|o| o.str("objectId")).map(String::from).ok_or_else(|| format!("{r} could not be found"))
    }

    /// `@e3`, `e3`, `ref=e3`, or a CSS selector (also `text=…`, `xpath=…`): the element's remote object id.
    pub fn element(&self, tab: &Tab, target: &str) -> Res<String> {
        let mut t = target.trim_matches(' ');
        t = t.strip_prefix("ref=").unwrap_or(t);
        t = t.strip_prefix('@').unwrap_or(t);
        if t.len() > 1 && t.starts_with('e') && t[1..].chars().all(|c| c.is_ascii_digit()) {
            return self.resolve_ref(tab, t);
        }
        let r = self.call("Runtime.evaluate", obj!({ "expression": format!("({DEEP_QUERY_JS})({}, false)", quote(target)), "returnByValue": false }), tab)?;
        if let Some(ex) = r.obj("exceptionDetails") {
            return Err(ex.obj("exception").and_then(|e| e.str("description")).map(String::from).unwrap_or_else(|| format!("Invalid selector: {target}")));
        }
        let res = r.obj("result").cloned().unwrap_or_default();
        match res.str("objectId") {
            Some(oid) if res.str("subtype") != Some("null") => Ok(oid.into()),
            _ => Err(format!("Element not found: {target}")),
        }
    }
}
