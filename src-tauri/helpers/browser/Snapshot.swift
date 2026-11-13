// `snapshot`: the page's accessibility tree as indented lines, with refs (`@e3`) for the
// things a command can act on.
//
//   - role "name" [prop=value, ref=eN]: value
//
// Refs stay the same for the same element across snapshots of one page.

import Foundation

struct SnapOptions {
    var compact = false
    var interactive = false
    var selector: String?
    var urls = false
    var depth = Int.max
}

/// Roles that get a ref.
let refRoles: Set<String> = [
    "link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider",
    "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem",
    "DisclosureTriangle", "heading", "listbox", "MenuListOption", "ToggleButton", "PopUpButton",
]

/// Wrappers that say nothing on their own: their children take their place.
private let hoisted: Set<String> = ["generic", "none", "GenericContainer", "Ignored", "IgnoredRole", "Section", "RootWebArea", "WebArea"]

/// Elements a person can click that the accessibility tree calls plain (a div with a click
/// handler or a pointer cursor). Each with why.
private let clickableJS = #"""
(() => {
  const els = [], why = [];
  const NATIVE = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|OPTION|SUMMARY|LABEL|VIDEO|AUDIO|IFRAME|HTML|BODY)$/;
  const ROLES = /^(button|link|checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option|textbox|combobox|slider|spinbutton|searchbox|treeitem)$/;
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (els.length >= 300) return;
      if (el.shadowRoot) walk(el.shadowRoot);
      if (NATIVE.test(el.tagName) || ROLES.test(el.getAttribute('role') || '')) continue;
      const w = [];
      const cs = getComputedStyle(el);
      const up = el.parentElement || (el.getRootNode() && el.getRootNode().host);
      if (cs.cursor === 'pointer' && !(up && getComputedStyle(up).cursor === 'pointer')) w.push('cursor:pointer');
      if (el.hasAttribute('onclick') || typeof el.onclick === 'function') w.push('onclick');
      const ti = el.getAttribute('tabindex');
      if (ti !== null && +ti >= 0 && !el.isContentEditable) w.push('tabindex');
      if (!w.length) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      els.push(el); why.push(w.join(', '));
    }
  };
  walk(document);
  return { els, why };
})()
"""#

/// The JS that finds one element by CSS, looking into open shadow roots too.
let deepQueryJS = #"""
(sel, all) => {
  const out = [];
  const visit = (root) => {
    try { for (const el of root.querySelectorAll(sel)) { out.push(el); if (!all && out.length) return true; } } catch (e) { throw new Error('Invalid selector: ' + sel); }
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot && visit(el.shadowRoot)) return true;
    return false;
  };
  if (sel.startsWith('xpath=') || sel.startsWith('//') || sel.startsWith('(//')) {
    const x = sel.replace(/^xpath=/, '');
    const r = document.evaluate(x, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < r.snapshotLength; i++) out.push(r.snapshotItem(i));
  } else if (sel.startsWith('text=')) {
    const t = sel.slice(5).replace(/^"|"$/g, '').trim().toLowerCase();
    const w = document.createTreeWalker(document.body || document, NodeFilter.SHOW_ELEMENT);
    let best = null;
    for (let n = w.currentNode; n; n = w.nextNode()) {
      const s = (n.innerText || n.textContent || '').trim().toLowerCase();
      if (s.includes(t)) best = n;
    }
    if (best) out.push(best);
  } else visit(document);
  return all ? out : (out[0] || null);
}
"""#

extension Daemon {
    /// The clickable plain elements: backend node id → why.
    private func clickables(_ tab: Tab) -> [Int: String] {
        guard let r = try? cdp.call("Runtime.evaluate", ["expression": clickableJS, "returnByValue": false], session: tab.sessionId),
              let obj = r.obj("result")?.str("objectId") else { return [:] }
        defer { cdp.send("Runtime.releaseObject", ["objectId": obj], session: tab.sessionId) }
        guard let why = (try? callOn(tab, obj, "function(){return this.why}"))?["value"] as? [String],
              let els = (try? callOn(tab, obj, "function(){return this.els}", byValue: false))?.str("objectId"),
              let props = try? cdp.call("Runtime.getProperties", ["objectId": els, "ownProperties": true], session: tab.sessionId)
        else { return [:] }
        var out: [Int: String] = [:]
        for p in props.arr("result") as? [JSON] ?? [] {
            guard let i = Int(p.str("name") ?? ""), i < why.count, let oid = p.obj("value")?.str("objectId") else { continue }
            if let d = try? cdp.call("DOM.describeNode", ["objectId": oid], session: tab.sessionId), let b = d.obj("node")?.int("backendNodeId") {
                out[b] = why[i]
            }
        }
        cdp.send("Runtime.releaseObject", ["objectId": els], session: tab.sessionId)
        return out
    }

    /// Every accessibility node of the page, frames included: id → node, and the root's id.
    func axTree(_ tab: Tab) throws -> ([String: JSON], String?) {
        let r = try cdp.call("Accessibility.getFullAXTree", session: tab.sessionId, timeout: 60)
        var nodes: [String: JSON] = [:]
        var root: String?
        for n in r.arr("nodes") as? [JSON] ?? [] {
            guard let id = n.str("nodeId") else { continue }
            nodes[id] = n
            if root == nil && n.str("parentId") == nil { root = id }
        }
        // same-process frames: graft each frame's tree under its <iframe>
        if let tree = try? cdp.call("Page.getFrameTree", session: tab.sessionId), let top = tree.obj("frameTree") {
            var frames: [String] = []
            func collect(_ f: JSON) {
                for c in f.arr("childFrames") as? [JSON] ?? [] {
                    if let id = c.obj("frame")?.str("id") { frames.append(id) }
                    collect(c)
                }
            }
            collect(top)
            if !frames.isEmpty {
                var byBackend: [Int: String] = [:]
                for (id, n) in nodes { if let b = n.int("backendDOMNodeId") { byBackend[b] = id } }
                _ = try? cdp.call("DOM.enable", session: tab.sessionId)
                for (i, fid) in frames.prefix(20).enumerated() {
                    guard let owner = try? cdp.call("DOM.getFrameOwner", ["frameId": fid], session: tab.sessionId),
                          let ob = owner.int("backendNodeId"), let hostId = byBackend[ob],
                          let sub = try? cdp.call("Accessibility.getFullAXTree", ["frameId": fid], session: tab.sessionId) else { continue }
                    var subRoot: String?
                    for n in sub.arr("nodes") as? [JSON] ?? [] {
                        guard let id = n.str("nodeId") else { continue }
                        let key = "f\(i)-\(id)"
                        var m = n
                        m["childIds"] = (n.arr("childIds") as? [String] ?? []).map { "f\(i)-\($0)" }
                        nodes[key] = m
                        if subRoot == nil && n.str("parentId") == nil { subRoot = key }
                    }
                    if let s = subRoot, var host = nodes[hostId] {
                        host["childIds"] = (host.arr("childIds") as? [String] ?? []) + [s]
                        nodes[hostId] = host
                    }
                }
            }
        }
        return (nodes, root)
    }

    func snapshot(_ tab: Tab, _ o: SnapOptions) throws -> (String, JSON) {
        let clicks = clickables(tab)
        let (nodes, rootId) = try axTree(tab)
        guard var start = rootId else { return ("", [:]) }
        if let sel = o.selector {
            let el = try element(tab, sel)
            let d = try cdp.call("DOM.describeNode", ["objectId": el], session: tab.sessionId)
            cdp.send("Runtime.releaseObject", ["objectId": el], session: tab.sessionId)
            guard let b = d.obj("node")?.int("backendNodeId") else { throw BrowserError("nothing matches \(sel)") }
            if let hit = nodes.first(where: { $0.value.int("backendDOMNodeId") == b })?.key { start = hit }
        }

        final class Line {
            var depth: Int
            let text: String
            let hasRef: Bool
            let isText: Bool
            var kids: [Line] = []
            init(depth: Int, text: String, hasRef: Bool, isText: Bool) { self.depth = depth; self.text = text; self.hasRef = hasRef; self.isText = isText }
        }
        var refsOut: JSON = [:]

        func prop(_ n: JSON, _ name: String) -> Any? {
            for p in n.arr("properties") as? [JSON] ?? [] where p.str("name") == name {
                return p.obj("value")?["value"]
            }
            return nil
        }
        func textOf(_ id: String, _ limit: Int = 80) -> String {
            var parts: [String] = []
            var total = 0
            func walk(_ id: String) {
                guard total < limit, let n = nodes[id] else { return }
                if n.obj("role")?.str("value") == "StaticText", let s = n.obj("name")?.str("value"), !s.isEmpty {
                    parts.append(s); total += s.count; return
                }
                for c in n.arr("childIds") as? [String] ?? [] { walk(c) }
            }
            walk(id)
            return clip(parts.joined(separator: " "), limit)
        }

        func build(_ id: String, _ depth: Int, _ parentName: String, into out: inout [Line]) {
            guard let n = nodes[id], depth <= o.depth else { return }
            let role = n.obj("role")?.str("value") ?? ""
            let backend = n.int("backendDOMNodeId")
            let why = backend.flatMap { clicks[$0] }
            let kids = n.arr("childIds") as? [String] ?? []
            if role == "InlineTextBox" || role == "LineBreak" && o.compact { return }
            let ignored = n.bool("ignored") == true
            var name = (n.obj("name")?["value"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if (ignored && why == nil) || (hoisted.contains(role) && why == nil && (name.isEmpty || role == "RootWebArea" || role == "WebArea")) {
                for c in kids { build(c, depth, parentName, into: &out) }
                return
            }
            if role == "StaticText" {
                guard !name.isEmpty, !(parentName.contains(name)) else { return }
                out.append(Line(depth: depth, text: "\(String(repeating: "  ", count: depth))- StaticText \"\(quoteForSnapshot(clip(name, 300)))\"", hasRef: false, isText: true))
                return
            }
            var attrs: [String] = []
            if let l = prop(n, "level") { attrs.append("level=\(l)") }
            if let c = prop(n, "checked") { attrs.append("checked=\(c)") }
            if let e = prop(n, "expanded") as? Bool { attrs.append("expanded=\(e)") }
            if let s = prop(n, "selected") as? Bool, s { attrs.append("selected") }
            if let p = prop(n, "pressed") { attrs.append("pressed=\(p)") }
            if let d = prop(n, "disabled") as? Bool, d { attrs.append("disabled") }
            if let r = prop(n, "required") as? Bool, r { attrs.append("required") }
            if let i = prop(n, "invalid") as? String, i != "false" { attrs.append("invalid") }
            if let r = prop(n, "readonly") as? Bool, r { attrs.append("readonly") }
            var ref: String?
            if let backend, refRoles.contains(role) || why != nil {
                if why != nil && name.isEmpty && o.interactive { name = textOf(id) }
                ref = tab.with { tab.ref(for: backend, role: role, name: name) }
                attrs.append("ref=\(ref!)")
                refsOut[ref!] = ["role": role, "name": name]
            }
            if o.urls, role == "link", let u = prop(n, "url") as? String, !u.isEmpty { attrs.append("url=\(u)") }
            var line = "\(String(repeating: "  ", count: depth))- \(role)"
            if !name.isEmpty { line += " \"\(quoteForSnapshot(clip(name, 300)))\"" }
            if !attrs.isEmpty { line += " [\(attrs.joined(separator: ", "))]" }
            var shownValue = ""
            if let v = n.obj("value")?["value"], !(v is NSNull) {
                let s = "\(v)".replacingOccurrences(of: "\n", with: " ")
                if !s.isEmpty && role != "heading" && role != "link" { line += ": \(clip(s, 200))"; shownValue = s }
            }
            if let why { line += " clickable [\(why)]" }
            let me = Line(depth: depth, text: line, hasRef: ref != nil, isText: false)
            // text that only repeats the name or the value adds nothing
            let said = name.isEmpty && shownValue.isEmpty ? "" : name + "\u{1}" + shownValue
            for c in kids { build(c, depth + 1, said, into: &me.kids) }
            out.append(me)
        }

        var top: [Line] = []
        build(start, 0, "", into: &top)

        func anyRef(_ l: Line) -> Bool { l.hasRef || l.kids.contains(where: anyRef) }
        var lines: [String] = []
        func emit(_ l: Line, parentKept: Bool, refDepth: Int) {
            if o.interactive {
                if l.hasRef {
                    let indent = String(repeating: "  ", count: refDepth)
                    lines.append(indent + l.text.trimmingCharacters(in: .whitespaces))
                }
                for k in l.kids { emit(k, parentKept: true, refDepth: refDepth + (l.hasRef ? 1 : 0)) }
                return
            }
            if o.compact {
                if l.isText { if parentKept { lines.append(l.text) }; return }
                guard anyRef(l) else { return }
            }
            lines.append(l.text)
            for k in l.kids { emit(k, parentKept: true, refDepth: refDepth) }
        }
        for l in top { emit(l, parentKept: false, refDepth: 0) }
        // a hoisted wrapper leaves its children deeper than their new parent: re-indent
        var out: [String] = []
        var stack: [(Int, Int)] = []  // (raw depth, shown depth)
        for raw in lines {
            let spaces = raw.prefix { $0 == " " }.count
            let d = spaces / 2
            while let last = stack.last, last.0 >= d { stack.removeLast() }
            let shown = (stack.last?.1 ?? -1) + 1
            stack.append((d, shown))
            out.append(String(repeating: "  ", count: shown) + raw.dropFirst(spaces))
        }
        return (out.joined(separator: "\n"), refsOut)
    }

    /// A ref's element now. A node the page replaced is found again by its role and name
    /// when exactly one matches.
    func resolveRef(_ tab: Tab, _ ref: String) throws -> String {
        guard let entry = tab.with({ tab.refs[ref] }) else {
            throw BrowserError("Unknown ref: \(ref)")
        }
        if let r = try? cdp.call("DOM.resolveNode", ["backendNodeId": entry.backendId], session: tab.sessionId),
           let oid = r.obj("object")?.str("objectId") {
            let connected = (try? callOn(tab, oid, "function(){return this.isConnected}"))?["value"] as? Bool ?? true
            if connected { return oid }
        }
        let (nodes, _) = try axTree(tab)
        let same = nodes.values.filter {
            $0.bool("ignored") != true && $0.obj("role")?.str("value") == entry.role
                && ($0.obj("name")?["value"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines) == entry.name
                && $0.int("backendDOMNodeId") != nil
        }
        guard !same.isEmpty else { throw BrowserError("\(ref) (\(entry.role) \"\(entry.name)\") is no longer on the page; take a new snapshot") }
        guard same.count == 1, let b = same[0].int("backendDOMNodeId") else {
            throw BrowserError("\(ref) (\(entry.role) \"\(entry.name)\") now matches \(same.count) elements; take a new snapshot")
        }
        tab.with {
            tab.refOf[entry.backendId] = nil
            tab.refOf[b] = ref
            tab.refs[ref] = RefEntry(backendId: b, role: entry.role, name: entry.name)
        }
        let r = try cdp.call("DOM.resolveNode", ["backendNodeId": b], session: tab.sessionId)
        guard let oid = r.obj("object")?.str("objectId") else { throw BrowserError("\(ref) could not be found") }
        return oid
    }

    /// `@e3`, `e3`, `ref=e3`, or a CSS selector (also `text=…`, `xpath=…`): the element's remote object id.
    func element(_ tab: Tab, _ target: String) throws -> String {
        var t = target.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("ref=") { t = String(t.dropFirst(4)) }
        if t.hasPrefix("@") { t = String(t.dropFirst()) }
        if t.range(of: #"^e\d+$"#, options: .regularExpression) != nil {
            return try resolveRef(tab, t)
        }
        let r = try cdp.call("Runtime.evaluate", ["expression": "(\(deepQueryJS))(\(jsonString(target)), false)", "returnByValue": false], session: tab.sessionId)
        if let ex = r.obj("exceptionDetails") {
            throw BrowserError(ex.obj("exception")?.str("description") ?? "Invalid selector: \(target)")
        }
        guard let oid = r.obj("result")?.str("objectId"), r.obj("result")?.str("subtype") != "null" else {
            throw BrowserError("Element not found: \(target)")
        }
        return oid
    }
}
