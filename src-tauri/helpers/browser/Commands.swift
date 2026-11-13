// Every command a session runs.

import CoreGraphics
import Foundation

/// Options pulled out of a command's words: `--flag value`, `--flag`, and the rest in order.
struct Args {
    var pos: [String] = []
    var opts: [String: String] = [:]
    var flags: Set<String> = []

    /// `valued` names take the next word as their value.
    init(_ words: [String], valued: Set<String>) {
        var i = 0
        while i < words.count {
            let w = words[i]
            if w.hasPrefix("--") && w.count > 2 {
                var name = String(w.dropFirst(2))
                if let eq = name.firstIndex(of: "=") {
                    opts[String(name[..<eq])] = String(name[name.index(after: eq)...])
                    i += 1; continue
                }
                if valued.contains(name), i + 1 < words.count {
                    opts[name] = words[i + 1]; i += 2; continue
                }
                if name.hasPrefix("no-") { name = String(name) }
                flags.insert(name)
            } else if w.hasPrefix("-") && w.count == 2 && Int(w) == nil, let short = Args.shorts[w] {
                if valued.contains(short), i + 1 < words.count { opts[short] = words[i + 1]; i += 2; continue }
                flags.insert(short)
            } else {
                pos.append(w)
            }
            i += 1
        }
    }

    static let shorts = ["-c": "compact", "-i": "interactive", "-s": "selector", "-u": "urls", "-d": "depth", "-f": "full", "-n": "name"]

    func has(_ f: String) -> Bool { flags.contains(f) }
    subscript(_ k: String) -> String? { opts[k] }
    func ms(_ k: String, _ def: Double) -> Double { opts[k].flatMap(Double.init) ?? def }
}

private let valued: Set<String> = [
    "wait-until", "selector", "depth", "timeout", "load", "text", "url", "fn", "state", "name", "type", "method",
    "status", "filter", "body", "allow-origin", "resource-type", "domain", "path", "same-site", "expires",
    "credential-provider", "item", "username-selector", "password-selector", "submit-selector", "username",
    "port", "index", "frame", "exact-name", "quality", "format",
]

extension Daemon {
    func run(_ words: [String], _ req: Request) throws -> Outcome {
        guard let cmd = words.first else { throw BrowserError("no command") }
        let rest = Array(words.dropFirst())
        let a = Args(rest, valued: valued)
        switch cmd {
        case "open", "goto", "navigate":
            guard let url = a.pos.first else { throw BrowserError("usage: open <url>") }
            let t = try tab()
            let info = try navigate(t, url, waitUntil: a["wait-until"] ?? "load", timeoutMs: a.ms("timeout", 25000))
            return Outcome(info, "✓ \(info.str("title") ?? "")\n  \(info.str("url") ?? "")")
        case "back", "forward":
            let t = try tab()
            let h = try cdp.call("Page.getNavigationHistory", session: t.sessionId)
            let i = (h.int("currentIndex") ?? 0) + (cmd == "back" ? -1 : 1)
            let entries = h.arr("entries") as? [JSON] ?? []
            guard i >= 0, i < entries.count, let id = entries[i].int("id") else { throw BrowserError("no page to go \(cmd) to") }
            try cdp.call("Page.navigateToHistoryEntry", ["entryId": id], session: t.sessionId)
            sleepMs(150)
            try? waitLifecycle(t, loader: nil, until: "domcontentloaded", timeoutMs: 15000)
            let info = try pageInfo(t)
            return Outcome(info, "✓ \(info.str("title") ?? "")\n  \(info.str("url") ?? "")")
        case "reload":
            let t = try tab()
            try cdp.call("Page.reload", session: t.sessionId)
            sleepMs(150)
            try? waitLifecycle(t, loader: nil, until: a["wait-until"] ?? "load", timeoutMs: 25000)
            let info = try pageInfo(t)
            return Outcome(info, "✓ \(info.str("title") ?? "")\n  \(info.str("url") ?? "")")

        case "snapshot":
            let t = try tab()
            var o = SnapOptions()
            o.compact = a.has("compact")
            o.interactive = a.has("interactive")
            o.selector = a["selector"]
            o.urls = a.has("urls")
            if let d = a["depth"].flatMap(Int.init) { o.depth = d }
            let (text, refs) = try snapshot(t, o)
            // --delta: only what changed since the last snapshot taken the same way
            let key = "\(o.compact)\(o.interactive)\(o.selector ?? "")\(o.urls)\(o.depth)"
            let prev = t.with { () -> [String]? in
                let p = t.lastSnapshot[key]
                t.lastSnapshot[key] = text.components(separatedBy: "\n")
                return p
            }
            if a.has("delta"), let prev {
                let now = text.components(separatedBy: "\n")
                var left: [String: Int] = [:]
                for l in prev { left[l, default: 0] += 1 }
                var added: [String] = []
                for l in now {
                    if let n = left[l], n > 0 { left[l] = n - 1 } else { added.append("+ " + l.trimmingCharacters(in: .whitespaces)) }
                }
                var right: [String: Int] = [:]
                for l in now { right[l, default: 0] += 1 }
                var removed: [String] = []
                for l in prev {
                    if let n = right[l], n > 0 { right[l] = n - 1 } else { removed.append("- " + l.trimmingCharacters(in: .whitespaces)) }
                }
                let diff = (removed + added).joined(separator: "\n")
                return Outcome(["snapshot": diff, "delta": true, "refs": refs, "origin": t.with { t.url }], diff.isEmpty ? "(no change)" : diff)
            }
            return Outcome(["snapshot": text, "refs": refs, "origin": t.with { t.url }], text)

        case "eval":
            let t = try tab()
            var code = a.pos.joined(separator: " ")
            if a.has("stdin") { code = req.stdin ?? "" }
            if a.has("b") || a.has("base64"), let d = Data(base64Encoded: code) { code = String(decoding: d, as: UTF8.self) }
            guard !code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw BrowserError("usage: eval <js> | eval --stdin") }
            let v = try evalValue(t, code, timeout: a.ms("timeout", 60000) / 1000)
            return Outcome(["result": v, "origin": t.with { t.url }], v is NSNull ? "" : jsonString(v, pretty: true))

        case "click", "dblclick", "hover", "focus", "check", "uncheck", "scrollintoview", "scrollIntoView":
            guard let sel = a.pos.first else { throw BrowserError("usage: \(cmd) <selector|@ref>") }
            let t = try tab()
            let el = try element(t, sel)
            defer { release(t, el) }
            try act(t, el, cmd, a)
            return Outcome()
        case "fill", "type":
            guard a.pos.count >= 1 else { throw BrowserError("usage: \(cmd) <selector|@ref> <text>") }
            let t = try tab()
            let el = try element(t, a.pos[0])
            defer { release(t, el) }
            let text = a.pos.dropFirst().joined(separator: " ")
            try guardPassword(t, el)
            if cmd == "fill" { try fill(t, el, text) } else { try focus(t, el); try typeKeys(t, text) }
            return Outcome()
        case "press", "key":
            guard let k = a.pos.first else { throw BrowserError("usage: press <key>") }
            let t = try tab()
            try press(t, k)
            return Outcome()
        case "keyboard":
            let t = try tab()
            let sub = a.pos.first ?? ""
            let text = a.pos.dropFirst().joined(separator: " ")
            switch sub {
            case "type": try typeKeys(t, text)
            case "inserttext", "insertText", "insert": try cdp.call("Input.insertText", ["text": text], session: t.sessionId)
            case "down", "up":
                let (mods, def) = try parseCombo(text)
                try keyEvent(t, sub == "down" ? "keyDown" : "keyUp", def, mods)
            default: throw BrowserError("usage: keyboard type|inserttext <text>")
            }
            return Outcome()
        case "select":
            guard a.pos.count >= 2 else { throw BrowserError("usage: select <selector|@ref> <value...>") }
            let t = try tab()
            let el = try element(t, a.pos[0])
            defer { release(t, el) }
            let r = try callOn(t, el, """
            function(vals) {
              const s = this.tagName === 'SELECT' ? this : this.querySelector('select');
              if (!s) throw new Error('not a <select>');
              const picked = [];
              for (const o of s.options) {
                const hit = vals.some(v => o.value === v || o.label.trim() === v || o.textContent.trim() === v);
                if (hit && (s.multiple || !picked.length)) { o.selected = true; picked.push(o.value); } else if (s.multiple) o.selected = false;
              }
              if (!picked.length) throw new Error('no option matches ' + vals.join(', '));
              if (!s.multiple) s.value = picked[0];
              s.dispatchEvent(new Event('input', { bubbles: true }));
              s.dispatchEvent(new Event('change', { bubbles: true }));
              return picked;
            }
            """, [Array(a.pos.dropFirst())])
            return Outcome(["selected": r["value"] ?? []])
        case "upload":
            guard a.pos.count >= 2 else { throw BrowserError("usage: upload <selector|@ref> <files...>") }
            let t = try tab()
            let el = try element(t, a.pos[0])
            defer { release(t, el) }
            let files = a.pos.dropFirst().map { absolutePath($0, cwd: req.cwd) }
            for f in files where !FileManager.default.fileExists(atPath: f) { throw BrowserError("no such file: \(f)") }
            var target = el
            let isInput = (try callOn(t, el, "function(){return this.tagName==='INPUT'&&this.type==='file'}"))["value"] as? Bool ?? false
            if !isInput {
                let inner = try callOn(t, el, "function(){return this.querySelector('input[type=file]')}", byValue: false)
                guard let oid = inner.str("objectId") else { throw BrowserError("\(a.pos[0]) is not a file input") }
                target = oid
            }
            try cdp.call("DOM.setFileInputFiles", ["files": files, "objectId": target], session: t.sessionId)
            return Outcome(["files": files])
        case "drag":
            guard a.pos.count >= 2 else { throw BrowserError("usage: drag <from> <to>") }
            let t = try tab()
            let from = try element(t, a.pos[0]); defer { release(t, from) }
            let to = try element(t, a.pos[1]); defer { release(t, to) }
            let p1 = try point(t, from), p2 = try point(t, to)
            try mouse(t, "mouseMoved", p1.0, p1.1)
            try mouse(t, "mousePressed", p1.0, p1.1, button: "left", clicks: 1)
            for i in 1...10 {
                let f = Double(i) / 10
                try mouse(t, "mouseMoved", p1.0 + (p2.0 - p1.0) * f, p1.1 + (p2.1 - p1.1) * f, button: "left", buttons: 1)
            }
            try mouse(t, "mouseReleased", p2.0, p2.1, button: "left", clicks: 1)
            return Outcome()
        case "download":
            guard a.pos.count >= 2 else { throw BrowserError("usage: download <selector|@ref> <path>") }
            let t = try tab()
            return try download(t, a.pos[0], absolutePath(a.pos[1], cwd: req.cwd), timeoutMs: a.ms("timeout", 60000))
        case "scroll":
            let t = try tab()
            let dir = (a.pos.first ?? "down").lowercased()
            let px = a.pos.count > 1 ? Double(a.pos[1]) ?? 300 : 300
            var dx = 0.0, dy = 0.0
            switch dir {
            case "up": dy = -px
            case "down": dy = px
            case "left": dx = -px
            case "right": dx = px
            default: throw BrowserError("usage: scroll up|down|left|right [px]")
            }
            var at = try viewportCenter(t)
            if let sel = a["selector"] { let el = try element(t, sel); at = try point(t, el); release(t, el) }
            try cdp.call("Input.dispatchMouseEvent", ["type": "mouseWheel", "x": at.0, "y": at.1, "deltaX": dx, "deltaY": dy], session: t.sessionId)
            sleepMs(100)
            return Outcome()
        case "mouse":
            let t = try tab()
            let sub = a.pos.first ?? ""
            let n = a.pos.dropFirst().compactMap(Double.init)
            let at = t.with { t.mouse }
            switch sub {
            case "move":
                guard n.count >= 2 else { throw BrowserError("usage: mouse move <x> <y>") }
                try mouse(t, "mouseMoved", n[0], n[1])
            case "down", "up":
                let b = a.pos.count > 1 ? a.pos[1] : "left"
                try mouse(t, sub == "down" ? "mousePressed" : "mouseReleased", at.x, at.y, button: b, clicks: 1)
            case "wheel":
                try cdp.call("Input.dispatchMouseEvent", ["type": "mouseWheel", "x": at.x, "y": at.y, "deltaY": n.first ?? 0, "deltaX": n.count > 1 ? n[1] : 0], session: t.sessionId)
            default: throw BrowserError("usage: mouse move|down|up|wheel")
            }
            return Outcome()

        case "wait":
            return try wait(a)

        case "screenshot":
            let t = try tab()
            var path = a.pos.first
            var full = a.has("full")
            if path == "--full" { path = nil; full = true }
            let file = path.map { absolutePath($0, cwd: req.cwd) } ?? "\(NSTemporaryDirectory())screenshot-\(Int(nowMs())).png"
            let jpeg = file.lowercased().hasSuffix(".jpg") || file.lowercased().hasSuffix(".jpeg")
            var params: JSON = ["format": jpeg ? "jpeg" : "png", "captureBeyondViewport": full]
            if jpeg { params["quality"] = Int(a["quality"] ?? "85") ?? 85 }
            if full {
                let m = try cdp.call("Page.getLayoutMetrics", session: t.sessionId)
                let size = m.obj("cssContentSize") ?? m.obj("contentSize") ?? [:]
                params["clip"] = ["x": 0, "y": 0, "width": size.dbl("width") ?? 1280, "height": min(size.dbl("height") ?? 800, 16000), "scale": 1]
            }
            if let sel = a["selector"] {
                let el = try element(t, sel); defer { release(t, el) }
                let q = try quads(t, el)
                params["clip"] = ["x": q.minX, "y": q.minY, "width": q.width, "height": q.height, "scale": 1]
            }
            let r = try cdp.call("Page.captureScreenshot", params, session: t.sessionId, timeout: 60)
            guard let b64 = r.str("data"), let d = Data(base64Encoded: b64) else { throw BrowserError("no picture came back") }
            try? FileManager.default.createDirectory(atPath: (file as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
            try d.write(to: URL(fileURLWithPath: file))
            return Outcome(["path": file], "✓ Screenshot saved to \(file)")
        case "pdf":
            guard let p = a.pos.first else { throw BrowserError("usage: pdf <path>") }
            let t = try tab()
            let file = absolutePath(p, cwd: req.cwd)
            let r = try cdp.call("Page.printToPDF", ["printBackground": true], session: t.sessionId, timeout: 120)
            guard let d = r.str("data").flatMap({ Data(base64Encoded: $0) }) else { throw BrowserError("no PDF came back") }
            try d.write(to: URL(fileURLWithPath: file))
            return Outcome(["path": file], "✓ PDF saved to \(file)")

        case "get":
            return try get(a)
        case "is":
            guard a.pos.count >= 2 else { throw BrowserError("usage: is visible|enabled|checked <selector|@ref>") }
            let t = try tab()
            let el = try element(t, a.pos[1]); defer { release(t, el) }
            let fn: String
            switch a.pos[0] {
            case "visible": fn = "function(){const r=this.getBoundingClientRect();const s=getComputedStyle(this);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}"
            case "enabled": fn = "function(){return !this.disabled && this.getAttribute('aria-disabled')!=='true'}"
            case "checked": fn = "function(){return !!(this.checked || this.getAttribute('aria-checked')==='true')}"
            default: throw BrowserError("usage: is visible|enabled|checked <selector|@ref>")
            }
            let v = try callOn(t, el, fn)["value"] as? Bool ?? false
            return Outcome([a.pos[0]: v], "\(v)")
        case "find":
            return try find(a)
        case "a11y":
            return try a11y(a)
        case "vitals":
            return try vitals(a)

        case "set":
            return try setting(a)
        case "network":
            return try network(a)
        case "cookies":
            return try cookies(a)
        case "storage":
            return try storage(a)
        case "console":
            let t = try tab()
            if a.has("clear") { t.with { t.console = [] }; return Outcome(["cleared": true], "✓ Cleared") }
            let msgs = t.with { t.console }
            return Outcome(["messages": msgs], msgs.map { "[\($0.str("type") ?? "log")] \($0.str("text") ?? "")" }.joined(separator: "\n"))
        case "errors":
            let t = try tab()
            if a.has("clear") { t.with { t.errors = [] }; return Outcome(["cleared": true], "✓ Cleared") }
            let errs = t.with { t.errors }
            return Outcome(["errors": errs], errs.map { $0.str("text") ?? "" }.joined(separator: "\n"))

        case "tab", "tabs":
            return try tabCommand(a)
        case "record":
            return try record(a, req)
        case "stream":
            return try streamCommand(a)
        case "session":
            return sessionInfo()
        case "auth":
            return try auth(a)
        case "close", "quit", "exit":
            // the reply goes out first; then the session ends (a shared browser and its tabs stay)
            releaseSocket()
            q.asyncAfter(deadline: .now() + 0.2) { self.shutdown(code: 0) }
            return Outcome(["closed": true], "✓ Session closed")
        default:
            throw BrowserError("Unknown command: \(cmd) (ondra-browser --help lists them)")
        }
    }

    // ───────────── elements ─────────────

    func release(_ tab: Tab, _ oid: String) {
        cdp.send("Runtime.releaseObject", ["objectId": oid], session: tab.sessionId)
    }

    func quads(_ tab: Tab, _ el: String) throws -> CGRect {
        _ = try? cdp.call("DOM.scrollIntoViewIfNeeded", ["objectId": el], session: tab.sessionId)
        let r = try cdp.call("DOM.getContentQuads", ["objectId": el], session: tab.sessionId)
        for q in r.arr("quads") as? [[Double]] ?? [] where q.count == 8 {
            let xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]]
            let rect = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
            if rect.width >= 1 && rect.height >= 1 { return rect }
        }
        throw BrowserError("Element is not visible (it has no size on screen)")
    }

    func point(_ tab: Tab, _ el: String) throws -> (Double, Double) {
        let r = try quads(tab, el)
        return (Double(r.midX), Double(r.midY))
    }

    func viewportCenter(_ tab: Tab) throws -> (Double, Double) {
        let m = try cdp.call("Page.getLayoutMetrics", session: tab.sessionId)
        let v = m.obj("cssLayoutViewport") ?? m.obj("layoutViewport") ?? [:]
        return ((v.dbl("clientWidth") ?? 1280) / 2, (v.dbl("clientHeight") ?? 800) / 2)
    }

    func mouse(_ tab: Tab, _ type: String, _ x: Double, _ y: Double, button: String = "none", clicks: Int = 0, buttons: Int? = nil) throws {
        var p: JSON = ["type": type, "x": x, "y": y, "button": button, "clickCount": clicks]
        if let buttons { p["buttons"] = buttons } else if type == "mousePressed" { p["buttons"] = button == "right" ? 2 : 1 }
        try cdp.call("Input.dispatchMouseEvent", p, session: tab.sessionId)
        tab.with { tab.mouse = (x, y) }
    }

    func click(_ tab: Tab, _ el: String, count: Int = 1) throws {
        let (x, y) = try point(tab, el)
        try mouse(tab, "mouseMoved", x, y)
        for i in 1...count {
            try mouse(tab, "mousePressed", x, y, button: "left", clicks: i)
            try mouse(tab, "mouseReleased", x, y, button: "left", clicks: i)
        }
    }

    func focus(_ tab: Tab, _ el: String) throws {
        _ = try callOn(tab, el, "function(){ this.scrollIntoView({block:'center', inline:'nearest'}); this.focus(); }")
    }

    func act(_ tab: Tab, _ el: String, _ cmd: String, _ a: Args) throws {
        switch cmd {
        case "click": try click(tab, el, count: 1)
        case "dblclick": try click(tab, el, count: 2)
        case "hover":
            let (x, y) = try point(tab, el)
            try mouse(tab, "mouseMoved", x, y)
        case "focus": try focus(tab, el)
        case "scrollintoview", "scrollIntoView":
            _ = try callOn(tab, el, "function(){ this.scrollIntoView({block:'center', inline:'nearest'}) }")
        case "check", "uncheck":
            let checked = { (try self.callOn(tab, el, "function(){return !!(this.checked || this.getAttribute('aria-checked')==='true' || (this.querySelector&&this.querySelector('input:checked')))}"))["value"] as? Bool ?? false }
            if try checked() != (cmd == "check") {
                try click(tab, el)
                if try checked() != (cmd == "check") {
                    _ = try callOn(tab, el, "function(){ (this.matches('input')?this:this.querySelector('input')||this).click() }")
                }
            }
        default: break
        }
    }

    /// No typing into a password field: sign-in goes through `auth login`.
    func guardPassword(_ tab: Tab, _ el: String) throws {
        let pw = (try? callOn(tab, el, "function(){return this.tagName==='INPUT'&&this.type==='password'}"))?["value"] as? Bool ?? false
        if pw { throw BrowserError("That is a password field: sign in with `ondra-browser auth login <site> --credential-provider keychain --no-navigate --url <login page>`") }
    }

    func fill(_ tab: Tab, _ el: String, _ text: String) throws {
        try focus(tab, el)
        // clear what is there the way a person would (select all, delete), so frameworks see it
        _ = try callOn(tab, el, """
        function() {
          if (this.isContentEditable) { const r = document.createRange(); r.selectNodeContents(this); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return; }
          if (typeof this.select === 'function') this.select();
        }
        """)
        try cdp.call("Input.dispatchKeyEvent", ["type": "keyDown", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8], session: tab.sessionId)
        try cdp.call("Input.dispatchKeyEvent", ["type": "keyUp", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8], session: tab.sessionId)
        if !text.isEmpty { try cdp.call("Input.insertText", ["text": text], session: tab.sessionId) }
        // a field that kept its old value (a script resets it): set it and say so to the page
        _ = try callOn(tab, el, """
        function(v) {
          if (this.isContentEditable || !('value' in this) || this.value === v) return;
          const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const set = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          set ? set.call(this, v) : (this.value = v);
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }
        """, [text])
    }

    func keyEvent(_ tab: Tab, _ type: String, _ def: KeyDef, _ mods: Int, text: String? = nil, commands: [String] = []) throws {
        var p: JSON = ["type": type, "key": def.key, "code": def.code, "windowsVirtualKeyCode": def.keyCode, "nativeVirtualKeyCode": def.keyCode, "modifiers": mods]
        if let text { p["text"] = text; p["unmodifiedText"] = text }
        if !commands.isEmpty { p["commands"] = commands }
        try cdp.call("Input.dispatchKeyEvent", p, session: tab.sessionId)
    }

    func press(_ tab: Tab, _ combo: String) throws {
        let (mods, def) = try parseCombo(combo)
        let cmd = editingCommand(mods, def)
        let text = (mods & 6 == 0) ? def.text.map { mods & 8 != 0 ? $0.uppercased() : $0 } : nil
        try keyEvent(tab, text != nil ? "keyDown" : "rawKeyDown", def, mods, text: text, commands: cmd.map { [$0] } ?? [])
        try keyEvent(tab, "keyUp", def, mods)
    }

    func typeKeys(_ tab: Tab, _ text: String) throws {
        for ch in text {
            let s = String(ch)
            if s == "\n" { try press(tab, "Enter"); continue }
            if let def = keyDef(s), def.code != "" {
                try keyEvent(tab, "keyDown", def, 0, text: s)
                try keyEvent(tab, "keyUp", def, 0)
            } else {
                try cdp.call("Input.insertText", ["text": s], session: tab.sessionId)
            }
        }
    }

    // ───────────── wait ─────────────

    func wait(_ a: Args) throws -> Outcome {
        let t = try tab()
        let timeout = a.ms("timeout", 25000)
        if let load = a["load"] {
            if load.lowercased() == "networkidle" {
                _ = try poll(timeoutMs: timeout, everyMs: 100, what: "the network to go quiet") { () -> Bool? in
                    let ready = (try? self.evalValue(t, "document.readyState")) as? String == "complete"
                    let idle = t.with { t.inflight.isEmpty && nowMs() - t.lastNet >= 500 }
                    return ready && idle ? true : nil
                }
            } else {
                let want = load.lowercased() == "load" ? ["complete"] : ["interactive", "complete"]
                _ = try poll(timeoutMs: timeout, everyMs: 50, what: "\(load)") { () -> Bool? in
                    want.contains((try? self.evalValue(t, "document.readyState")) as? String ?? "") ? true : nil
                }
            }
            return Outcome()
        }
        if let text = a["text"] {
            _ = try poll(timeoutMs: timeout, what: "text \"\(text)\"") { () -> Bool? in
                ((try? self.evalValue(t, "(document.body?.innerText||'').includes(\(jsonString(text)))")) as? Bool ?? false) ? true : nil
            }
            return Outcome()
        }
        if let u = a["url"] {
            _ = try poll(timeoutMs: timeout, what: "the URL to match \(u)") { () -> Bool? in
                let now = (try? self.evalValue(t, "location.href")) as? String ?? ""
                return globMatch(u, now) || now.contains(u) ? true : nil
            }
            return Outcome()
        }
        if let fn = a["fn"] {
            _ = try poll(timeoutMs: timeout, what: "the condition") { () -> Bool? in
                let v = try? self.evalValue(t, "(async () => { try { return !!(\(fn)); } catch (e) { return false } })()")
                return (v as? Bool ?? false) ? true : nil
            }
            return Outcome()
        }
        guard let what = a.pos.first else { throw BrowserError("usage: wait <ms|selector|@ref> | --load <state> | --text <t> | --url <pattern> | --fn <js>") }
        if let ms = Double(what) {
            sleepMs(min(ms, 120000))
            return Outcome()
        }
        let state = a["state"] ?? "visible"
        _ = try poll(timeoutMs: timeout, what: "\(what) to be \(state)") { () -> Bool? in
            let el = try? self.element(t, what)
            defer { if let el { self.release(t, el) } }
            switch state {
            case "attached": return el != nil ? true : nil
            case "detached": return el == nil ? true : nil
            default:
                guard let el else { return state == "hidden" ? true : nil }
                let vis = (try? self.callOn(t, el, "function(){const r=this.getBoundingClientRect();const s=getComputedStyle(this);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'}"))?["value"] as? Bool ?? false
                return (state == "hidden" ? !vis : vis) ? true : nil
            }
        }
        return Outcome()
    }

    // ───────────── get / find ─────────────

    func get(_ a: Args) throws -> Outcome {
        let t = try tab()
        let what = a.pos.first ?? ""
        switch what {
        case "url":
            let u = (try? evalValue(t, "location.href")) as? String ?? t.with { t.url }
            return Outcome(["url": u], u)
        case "title":
            let s = (try evalValue(t, "document.title")) as? String ?? ""
            return Outcome(["title": s], s)
        case "cdp-url":
            return Outcome(["url": cdp.endpoint], cdp.endpoint)
        case "count":
            guard a.pos.count > 1 else { throw BrowserError("usage: get count <selector>") }
            let n = (try evalValue(t, "(\(deepQueryJS))(\(jsonString(a.pos[1])), true).length")) as? Int ?? 0
            return Outcome(["count": n], "\(n)")
        case "text", "html", "value", "attr", "box", "styles":
            let selIndex = what == "attr" ? 2 : 1
            guard a.pos.count > selIndex else { throw BrowserError("usage: get \(what) \(what == "attr" ? "<name> " : "")<selector|@ref>") }
            let el = try element(t, a.pos[selIndex]); defer { release(t, el) }
            switch what {
            case "text":
                let s = try callOn(t, el, "function(){return (this.innerText ?? this.textContent ?? '').trim()}")["value"] as? String ?? ""
                return Outcome(["text": s], s)
            case "html":
                let s = try callOn(t, el, "function(){return this.outerHTML}")["value"] as? String ?? ""
                return Outcome(["html": s], s)
            case "value":
                try guardPassword(t, el)
                let s = try callOn(t, el, "function(){return this.value ?? ''}")["value"] as? String ?? ""
                return Outcome(["value": s], s)
            case "attr":
                let v = try callOn(t, el, "function(n){return this.getAttribute(n)}", [a.pos[1]])["value"] ?? NSNull()
                return Outcome(["value": v], v is NSNull ? "" : "\(v)")
            case "box":
                let r = try quads(t, el)
                let box: JSON = ["x": r.minX, "y": r.minY, "width": r.width, "height": r.height]
                return Outcome(box, jsonString(box))
            default:
                let v = try callOn(t, el, "function(){const s=getComputedStyle(this);const o={};for(const k of ['display','visibility','color','backgroundColor','fontSize','fontWeight','fontFamily','width','height','position','opacity'])o[k]=s[k];return o}")["value"] ?? [:]
                return Outcome(["styles": v], jsonString(v, pretty: true))
            }
        default:
            throw BrowserError("usage: get url|title|text|html|value|attr|count|box|styles [selector]")
        }
    }

    /// `find <locator> <value> <action> [text]`: role, text, label, placeholder, alt, title,
    /// testid, first, last, nth.
    func find(_ a: Args) throws -> Outcome {
        let t = try tab()
        var p = a.pos
        guard p.count >= 2 else { throw BrowserError("usage: find <role|text|label|placeholder|alt|title|testid|first|last|nth> <value> [action] [text]") }
        let how = p.removeFirst()
        var nth = 0
        if how == "nth" { nth = Int(p.removeFirst()) ?? 0 }
        guard !p.isEmpty else { throw BrowserError("find \(how): what to look for?") }
        let value = p.removeFirst()
        let action = p.isEmpty ? "click" : p.removeFirst()
        let text = p.joined(separator: " ")
        let exact = a.has("exact")
        var el: String?
        switch how {
        case "role":
            let (nodes, _) = try axTree(t)
            let want = a["name"]?.lowercased()
            let hits = nodes.values.filter { n in
                n.bool("ignored") != true && n.obj("role")?.str("value") == value && n.int("backendDOMNodeId") != nil && {
                    guard let w = want else { return true }
                    let nm = (n.obj("name")?["value"] as? String ?? "").lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
                    return exact ? nm == w : nm.contains(w)
                }()
            }.sorted { ($0.int("backendDOMNodeId") ?? 0) < ($1.int("backendDOMNodeId") ?? 0) }
            // the exact name first when there is one
            let pick = hits.first { ($0.obj("name")?["value"] as? String ?? "").lowercased() == want } ?? hits.first
            guard let b = pick?.int("backendDOMNodeId") else { throw BrowserError("no \(value)\(want.map { " named \"\($0)\"" } ?? "") on the page") }
            el = try cdp.call("DOM.resolveNode", ["backendNodeId": b], session: t.sessionId).obj("object")?.str("objectId")
        case "first", "last", "nth":
            let r = try cdp.call("Runtime.evaluate", ["expression": "(() => { const all = (\(deepQueryJS))(\(jsonString(value)), true); return all[\(how == "last" ? "all.length - 1" : String(nth))] || null })()"], session: t.sessionId)
            el = r.obj("result")?.str("subtype") == "null" ? nil : r.obj("result")?.str("objectId")
        default:
            let js: String
            let v = jsonString(value)
            switch how {
            case "text":
                js = "(() => { const t = \(v).toLowerCase(); let best = null; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT); for (let n = w.currentNode; n; n = w.nextNode()) { const s = (n.innerText || '').trim().toLowerCase(); if (\(exact) ? s === t : s.includes(t)) best = n; } return best; })()"
            case "label":
                js = "(() => { const t = \(v).toLowerCase(); for (const l of document.querySelectorAll('label')) { if (l.textContent.trim().toLowerCase().includes(t)) return l.control || l.querySelector('input,select,textarea') || l; } return document.querySelector(`[aria-label*=\"${\(v)}\" i]`); })()"
            case "placeholder": js = "document.querySelector(`[placeholder*=\"${\(v)}\" i]`)"
            case "alt": js = "document.querySelector(`[alt*=\"${\(v)}\" i]`)"
            case "title": js = "document.querySelector(`[title*=\"${\(v)}\" i]`)"
            case "testid": js = "document.querySelector(`[data-testid=\"${\(v)}\"],[data-test-id=\"${\(v)}\"],[data-test=\"${\(v)}\"]`)"
            default: throw BrowserError("find: unknown locator \(how)")
            }
            let r = try cdp.call("Runtime.evaluate", ["expression": js], session: t.sessionId)
            el = r.obj("result")?.str("subtype") == "null" ? nil : r.obj("result")?.str("objectId")
        }
        guard let el else { throw BrowserError("find \(how) \(value): nothing matches") }
        defer { release(t, el) }
        switch action {
        case "click", "dblclick", "hover", "focus", "check", "uncheck", "scrollintoview":
            try act(t, el, action, a)
        case "fill": try guardPassword(t, el); try fill(t, el, text)
        case "type": try guardPassword(t, el); try focus(t, el); try typeKeys(t, text)
        case "text":
            let s = try callOn(t, el, "function(){return (this.innerText ?? this.textContent ?? '').trim()}")["value"] as? String ?? ""
            return Outcome(["text": s], s)
        default: throw BrowserError("find: unknown action \(action)")
        }
        return Outcome()
    }

    // ───────────── settings ─────────────

    func setting(_ a: Args) throws -> Outcome {
        let what = a.pos.first ?? ""
        let v = Array(a.pos.dropFirst())
        try locked { try changeSetting(what, v) }
        try applyAll()
        return Outcome()
    }

    private func changeSetting(_ what: String, _ v: [String]) throws {
        switch what {
        case "viewport":
            guard v.count >= 2, let w = Int(v[0]), let h = Int(v[1]) else { throw BrowserError("usage: set viewport <w> <h> [scale]") }
            viewport = ["width": w, "height": h, "deviceScaleFactor": v.count > 2 ? Double(v[2]) ?? 1 : 1, "mobile": false]
        case "device":
            let name = v.joined(separator: " ").lowercased()
            let devices: [String: (Int, Int, Double, String)] = [
                "iphone se": (375, 667, 2, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
                "iphone 15": (393, 852, 3, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
                "iphone 15 pro max": (430, 932, 3, "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
                "pixel 7": (412, 915, 2.625, "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"),
                "ipad": (820, 1180, 2, "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"),
                "desktop": (1280, 800, 1, ""),
            ]
            guard let d = devices[name] else { throw BrowserError("unknown device \(name); known: \(devices.keys.sorted().joined(separator: ", ")), or use set viewport") }
            viewport = ["width": d.0, "height": d.1, "deviceScaleFactor": d.2, "mobile": name != "desktop"]
            userAgent = d.3.isEmpty ? nil : d.3
        case "media":
            var feats: [JSON] = []
            var scheme = colorScheme
            var motion = media.contains { $0.str("name") == "prefers-reduced-motion" }
            for w in v {
                switch w.lowercased() {
                case "dark", "light": scheme = w.lowercased()
                case "reduced-motion", "reduce": motion = true
                case "no-reduced-motion", "no-preference": motion = false
                case "reset": scheme = nil; motion = false
                default: throw BrowserError("usage: set media [dark|light] [reduced-motion]")
                }
            }
            if let s = scheme { feats.append(["name": "prefers-color-scheme", "value": s]) }
            if motion { feats.append(["name": "prefers-reduced-motion", "value": "reduce"]) }
            media = feats
            colorScheme = scheme
        case "offline":
            offline = (v.first ?? "on").lowercased() != "off"
        case "headers":
            guard let j = parseJSON(v.joined(separator: " ")) as? JSON else { throw BrowserError("usage: set headers <json>") }
            extraHeaders = j
        case "credentials":
            guard v.count >= 2 else { throw BrowserError("usage: set credentials <user> <pass>") }
            extraHeaders["Authorization"] = "Basic " + Data("\(v[0]):\(v[1])".utf8).base64EncodedString()
        case "geo", "geolocation":
            guard v.count >= 2, let lat = Double(v[0]), let lng = Double(v[1]) else { throw BrowserError("usage: set geo <lat> <lng>") }
            geo = ["latitude": lat, "longitude": lng, "accuracy": 10]
        case "useragent", "user-agent":
            userAgent = v.joined(separator: " ")
        default:
            throw BrowserError("usage: set viewport|device|media|offline|headers|credentials|geo|useragent ...")
        }
    }

    // ───────────── network ─────────────

    func network(_ a: Args) throws -> Outcome {
        let sub = a.pos.first ?? ""
        switch sub {
        case "route":
            guard a.pos.count > 1 else { throw BrowserError("usage: network route <url> [--abort|--body <json>] [--resource-type <csv>]") }
            let types = Set((a["resource-type"] ?? "").lowercased().split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty })
            let r = Route(pattern: a.pos[1], abort: a.has("abort") || a["body"] == nil, body: a["body"], allowOrigin: a["allow-origin"], types: types)
            lock.lock(); routes.append(r); lock.unlock()
            try applyAll()
            return Outcome(["routed": a.pos[1]])
        case "unroute":
            lock.lock()
            if a.pos.count > 1 { routes.removeAll { $0.pattern == a.pos[1] } } else { routes = [] }
            lock.unlock()
            try applyAll()
            return Outcome()
        case "requests":
            let t = try tab()
            if a.has("clear") { t.with { t.requests = [:]; t.order = [] }; return Outcome(["cleared": true], "✓ Cleared") }
            let types = Set((a["type"] ?? "").lowercased().split(separator: ",").map(String.init))
            let methods = Set((a["method"] ?? "").uppercased().split(separator: ",").map(String.init))
            var lo = 0, hi = 999
            if let s = a["status"] {
                let parts = s.split(separator: "-").compactMap { Int($0) }
                if parts.count == 2 { lo = parts[0]; hi = parts[1] } else if parts.count == 1 { lo = parts[0]; hi = parts[0] }
            }
            let filter = a["filter"]
            let list: [NetRequest] = t.with { t.order.compactMap { t.requests[$0] } }.filter { r in
                (types.isEmpty || types.contains(r.resourceType.lowercased())) && (methods.isEmpty || methods.contains(r.method))
                    && (a["status"] == nil || (r.status.map { $0 >= lo && $0 <= hi } ?? false))
                    && (filter == nil || r.url.contains(filter!) || globMatch(filter!, r.url))
            }
            let rows: [JSON] = list.map { r in
                var j: JSON = ["requestId": r.id, "url": r.url, "method": r.method, "resourceType": r.resourceType,
                               "headers": r.headers, "timestamp": r.timestamp, "status": r.status ?? NSNull(), "mimeType": r.mimeType ?? NSNull()]
                if let h = r.responseHeaders { j["responseHeaders"] = h }
                if let f = r.failed { j["failed"] = f }
                return j
            }
            let text = list.map { "[\($0.id)] \($0.method) \($0.url) (\($0.resourceType)) \($0.status.map(String.init) ?? $0.failed ?? "pending")" }.joined(separator: "\n")
            return Outcome(["requests": rows], text)
        case "request":
            guard a.pos.count > 1 else { throw BrowserError("usage: network request <id>") }
            let t = try tab()
            guard let r = t.with({ t.requests[a.pos[1]] }) else { throw BrowserError("no request \(a.pos[1]) (network requests lists them)") }
            var j: JSON = ["requestId": r.id, "url": r.url, "method": r.method, "resourceType": r.resourceType, "headers": r.headers,
                           "status": r.status ?? NSNull(), "mimeType": r.mimeType ?? NSNull(), "responseHeaders": r.responseHeaders ?? [:]]
            if let p = r.postData { j["postData"] = p }
            if let b = try? cdp.call("Network.getResponseBody", ["requestId": r.id], session: t.sessionId) {
                var body = b.str("body") ?? ""
                if b.bool("base64Encoded") == true { body = Data(base64Encoded: body).flatMap { String(data: $0, encoding: .utf8) } ?? "(binary, \(body.count * 3 / 4) bytes)" }
                j["body"] = body.count > 200_000 ? String(body.prefix(200_000)) + "…" : body
            }
            return Outcome(j, jsonString(j, pretty: true))
        default:
            throw BrowserError("usage: network route|unroute|requests|request ...")
        }
    }

    // ───────────── cookies / storage ─────────────

    func cookies(_ a: Args) throws -> Outcome {
        let sub = a.pos.first ?? "get"
        switch sub {
        case "get":
            var list: [JSON]
            if let u = a["url"] {
                let t = try tab()
                list = try cdp.call("Network.getCookies", ["urls": [u]], session: t.sessionId).arr("cookies") as? [JSON] ?? []
            } else if let t = active, !t.gone {
                let u = t.with { t.url }
                list = try cdp.call("Network.getCookies", u.hasPrefix("http") ? ["urls": [u]] : [:], session: t.sessionId).arr("cookies") as? [JSON] ?? []
            } else {
                list = try cdp.call("Storage.getCookies").arr("cookies") as? [JSON] ?? []
            }
            return Outcome(["cookies": list], list.map { "\($0.str("name") ?? "")=\($0.str("value") ?? "") (\($0.str("domain") ?? ""))" }.joined(separator: "\n"))
        case "set":
            guard a.pos.count >= 3 else { throw BrowserError("usage: cookies set <name> <value> [--url u | --domain d] [--path p] [--secure] [--http-only] [--same-site s] [--expires ts]") }
            var c: JSON = ["name": a.pos[1], "value": a.pos[2], "path": a["path"] ?? "/"]
            if let u = a["url"] { c["url"] = u }
            if let d = a["domain"] { c["domain"] = d }
            if c["url"] == nil && c["domain"] == nil {
                guard let t = active, t.with({ t.url }).hasPrefix("http") else { throw BrowserError("cookies set needs --url or --domain") }
                c["url"] = t.with { t.url }
            }
            if a.has("secure") { c["secure"] = true }
            if a.has("http-only") || a.has("httpOnly") { c["httpOnly"] = true }
            if let s = a["same-site"] { c["sameSite"] = s.prefix(1).uppercased() + s.dropFirst().lowercased() }
            if let e = a["expires"].flatMap(Double.init) { c["expires"] = e }
            try cdp.call("Storage.setCookies", ["cookies": [c]])
            return Outcome()
        case "clear":
            try cdp.call("Storage.clearCookies")
            return Outcome()
        default:
            throw BrowserError("usage: cookies [get|set|clear]")
        }
    }

    func storage(_ a: Args) throws -> Outcome {
        guard let kind = a.pos.first, kind == "local" || kind == "session" else { throw BrowserError("usage: storage local|session [key | set <k> <v> | clear]") }
        let t = try tab()
        let s = kind == "local" ? "localStorage" : "sessionStorage"
        let p = Array(a.pos.dropFirst())
        let js: String
        switch p.first {
        case nil: js = "Object.fromEntries(Object.entries(\(s)))"
        case "set":
            guard p.count >= 3 else { throw BrowserError("usage: storage \(kind) set <key> <value>") }
            js = "(\(s).setItem(\(jsonString(p[1])), \(jsonString(p[2...].joined(separator: " ")))), true)"
        case "clear": js = "(\(s).clear(), true)"
        case "remove", "delete":
            guard p.count >= 2 else { throw BrowserError("usage: storage \(kind) remove <key>") }
            js = "(\(s).removeItem(\(jsonString(p[1]))), true)"
        default: js = "\(s).getItem(\(jsonString(p[0])))"
        }
        let v = try evalValue(t, js)
        return Outcome(["result": v], v is NSNull ? "" : jsonString(v, pretty: true))
    }

    // ───────────── tabs ─────────────

    func tabCommand(_ a: Args) throws -> Outcome {
        let sub = a.pos.first ?? "list"
        func listing() throws -> Outcome {
            let list = try pages()
            let act = active?.targetId
            var rows: [JSON] = []
            var lines: [String] = []
            for p in list {
                guard let tid = p.str("targetId") else { continue }
                let n = tabNumber(tid)
                rows.append(["tabId": "t\(n)", "targetId": tid, "title": p.str("title") ?? "", "url": p.str("url") ?? "", "active": tid == act, "type": "page"])
                lines.append("\(tid == act ? "→" : " ") [t\(n)] \(p.str("title") ?? "") - \(p.str("url") ?? "")")
            }
            return Outcome(["tabs": rows], lines.joined(separator: "\n"))
        }
        func byNumber(_ s: String) throws -> String {
            let n = Int(s.hasPrefix("t") ? String(s.dropFirst()) : s) ?? -1
            let list = try pages()
            if let hit = list.first(where: { $0.str("targetId").map { tabNumber($0) } == n }) { return hit.str("targetId")! }
            if let hit = list.first(where: { $0.str("targetId") == s }) { return hit.str("targetId")! }
            throw BrowserError("no tab \(s) (tab list shows them)")
        }
        switch sub {
        case "list", "ls":
            return try listing()
        case "new":
            let t = try newTab(a.pos.count > 1 ? a.pos[1] : "about:blank")
            let info = try pageInfo(t)
            return Outcome(["tabId": "t\(tabNumber(t.targetId))", "url": info.str("url") ?? ""], "✓ t\(tabNumber(t.targetId)) \(info.str("url") ?? "")")
        case "close":
            var tid: String?
            if a.pos.count > 1 { tid = try byNumber(a.pos[1]) } else if let act = active, !act.gone { tid = act.targetId }
            else if config.pin, let saved = readState(config.session).str("targetId"), try pages().contains(where: { $0.str("targetId") == saved }) { tid = saved }
            guard let tid else { return Outcome(["closed": false], "no tab to close") }
            try cdp.call("Target.closeTarget", ["targetId": tid])
            if active?.targetId == tid {
                active = nil
                stream?.tabChanged()
                if config.pin { var st = readState(config.session); st["targetId"] = nil; writeState(config.session, st) }
            }
            return Outcome(["closed": true])
        default:
            let tid = try byNumber(sub)
            let t = try attach(tid)
            makeActive(t)
            _ = try? cdp.call("Target.activateTarget", ["targetId": tid])
            let info = try pageInfo(t)
            return Outcome(["tabId": "t\(tabNumber(tid))", "url": info.str("url") ?? "", "title": info.str("title") ?? ""], "✓ t\(tabNumber(tid)) \(info.str("title") ?? "") - \(info.str("url") ?? "")")
        }
    }

    // ───────────── session / stream ─────────────

    func sessionInfo() -> Outcome {
        let d: JSON = ["session": config.session, "pid": Int(getpid()), "active": true, "cdp": cdp.endpoint,
                       "tab": active.map { t in ["targetId": t.targetId, "url": t.with { t.url }] as JSON } ?? NSNull(),
                       "stream": stream.map { Int($0.port) } ?? NSNull(), "pinned": config.pin]
        return Outcome(d, jsonString(d, pretty: true))
    }

    func streamCommand(_ a: Args) throws -> Outcome {
        switch a.pos.first ?? "status" {
        case "status":
            let d: JSON = ["enabled": stream != nil, "connected": !cdp.closed && active.map { !$0.gone } == true,
                           "port": stream.map { Int($0.port) } ?? NSNull(), "screencasting": active.map { t in t.with { t.screencasting } } ?? false,
                           "clients": stream?.clientCount ?? 0]
            return Outcome(d, jsonString(d, pretty: true))
        case "enable":
            if stream == nil { stream = try StreamServer(daemon: self, port: UInt16(a["port"] ?? "") ?? config.streamPort) }
            _ = try tab()
            return Outcome(["port": Int(stream!.port)], "✓ Streaming on ws://127.0.0.1:\(stream!.port)")
        case "disable":
            stream?.stop()
            stream = nil
            return Outcome()
        default:
            throw BrowserError("usage: stream status|enable|disable")
        }
    }

    // ───────────── downloads ─────────────

    func download(_ t: Tab, _ sel: String, _ path: String, timeoutMs: Double) throws -> Outcome {
        let dir = "\(baseDir)/dl-\(getpid())"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try cdp.call("Browser.setDownloadBehavior", ["behavior": "allowAndName", "downloadPath": dir, "eventsEnabled": true])
        lock.lock(); downloads = [:]; lock.unlock()
        let el = try element(t, sel); defer { release(t, el) }
        try click(t, el)
        let done: JSON = try poll(timeoutMs: timeoutMs, what: "the download") { () -> JSON? in
            lock.lock(); defer { lock.unlock() }
            if let d = downloads.values.first(where: { $0.str("state") == "canceled" }) { throw BrowserError("the download was canceled (\(d.str("suggestedFilename") ?? ""))") }
            return downloads.values.first { $0.str("state") == "completed" }
        }
        guard let guid = done.str("guid") else { throw BrowserError("download finished without a file") }
        try? FileManager.default.removeItem(atPath: path)
        try FileManager.default.moveItem(atPath: "\(dir)/\(guid)", toPath: path)
        _ = try? cdp.call("Browser.setDownloadBehavior", ["behavior": "default"])
        return Outcome(["path": path], "✓ Downloaded to \(path)")
    }
}
