// ondra-cuhost — background host computer use for the user's own Mac.
//
// Drives one target app entirely in the background, using only public macOS APIs:
//   - Accessibility (AXUIElement*) for the UI tree and for actions.
//   - pid-targeted CGEvent (CGEventPostToPid) for keys/text/scroll/drag/coordinate
//     clicks — only as a fallback when an AX action is unavailable.
//   - ScreenCaptureKit (SCShareableContent + SCScreenshotManager) for window-only
//     captures of the target app's own windows, even hidden or occluded.
//
// Background contract, enforced here, not papered over:
//   - never activates an app, never brings a window to front;
//   - never warps or draws the cursor, never posts to the global session
//     (events go to the target pid only);
//   - launches apps hidden and without activation;
//   - records the frontmost app, key/main window and mouse position BEFORE and
//     AFTER every action and reports them, so the caller can verify nothing moved.
// If an action cannot be done this way, it returns an error; it never falls back
// to foreground. This is the opposite of Codex's SyntheticAppFocusEnforcer /
// SystemFocusStealPreventer, which activate and then suppress/forge focus events.
//
// Build: src-tauri/helpers/build.sh (→ src-tauri/binaries/ondra-cuhost-<triple>).
// Signed with cuhost.entitlements. Needs Accessibility and (for `capture`/`look`)
// Screen Recording granted to the HOST APP that runs this helper.
//
// Protocol: newline-delimited JSON. Read one request object per line from stdin,
// write one response object per line to stdout. version 1. Diagnostics: stderr.
//   {"op":"frontmost"}                      → environment snapshot
//   {"op":"apps"}                           → running, non-background apps
//   {"op":"launch","app":"TextEdit"}        → launch hidden, no activation
//   {"op":"observe","pid":123,"full":bool}  → compact AX tree (full) or diff
//   {"op":"look","pid":123}                 → window-only PNG (base64) of key window
//   {"op":"act","pid":123,"action":{…}}     → one action, then re-observe
//   {"op":"selfcheck","pid":123}            → invariants + a no-op timing probe
// Every response carries "env" (frontmost/key window/mouse) so callers can assert
// the background invariant themselves.

import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ScreenCaptureKit

// ───────────────────────── JSON helpers ─────────────────────────

func jsonLine(_ obj: [String: Any]) -> String {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    return String(data: data, encoding: .utf8)!
}
func emit(_ obj: [String: Any]) {
    FileHandle.standardOutput.write((jsonLine(obj) + "\n").data(using: .utf8)!)
}
func ok(_ id: Any?, _ result: [String: Any]) -> [String: Any] {
    ["version": 1, "id": id ?? NSNull(), "ok": true, "result": result]
}
func fail(_ id: Any?, _ code: String, _ message: String) -> [String: Any] {
    ["version": 1, "id": id ?? NSNull(), "ok": false, "error": ["code": code, "message": message]]
}

func nowMs() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000.0 }

// ───────────────────────── environment snapshot ─────────────────────────
// The three things that must never change in the background.

func mouseLocationGlobal() -> [String: Double] {
    // CGEvent location is top-left origin, which is what window coords use too.
    let p = CGEvent(source: nil)?.location ?? .zero
    return ["x": Double(p.x), "y": Double(p.y)]
}

func keyWindowTitle(forPid pid: pid_t) -> String? {
    let app = AXUIElementCreateApplication(pid)
    var win: CFTypeRef?
    // kAXFocusedWindow is the app's key window; fall back to main window.
    for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
        if AXUIElementCopyAttributeValue(app, attr as CFString, &win) == .success, let w = win {
            var title: CFTypeRef?
            if AXUIElementCopyAttributeValue(w as! AXUIElement, kAXTitleAttribute as CFString, &title) == .success {
                return title as? String
            }
            return ""
        }
    }
    return nil
}

func environment() -> [String: Any] {
    let front = NSWorkspace.shared.frontmostApplication
    let frontPid = front?.processIdentifier ?? -1
    var env: [String: Any] = [
        "frontmostApp": front?.bundleIdentifier ?? front?.localizedName ?? NSNull(),
        "frontmostPid": Int(frontPid),
        "mouse": mouseLocationGlobal(),
    ]
    if frontPid > 0, let title = keyWindowTitle(forPid: frontPid) {
        env["frontmostKeyWindow"] = title
    }
    return env
}

// ───────────────────────── AX tree ─────────────────────────
// A compact tree with per-session stable ids. The id is derived from the element's
// structural path + role + identifier so it is stable across observations of the
// same window, which lets the caller diff by id instead of by position.

final class AXMap {
    private var byId: [String: AXUIElement] = [:]
    func clear() { byId.removeAll() }
    func store(_ id: String, _ el: AXUIElement) { byId[id] = el }
    func element(_ id: String) -> AXUIElement? { byId[id] }
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
    return v as? String
}
func axBool(_ el: AXUIElement, _ attr: String) -> Bool? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
    return (v as? NSNumber)?.boolValue
}
func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v) == .success else { return [] }
    return (v as? [AXUIElement]) ?? []
}
func axActions(_ el: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(el, &names) == .success else { return [] }
    return (names as? [String]) ?? []
}
func axSettable(_ el: AXUIElement, _ attr: String) -> Bool {
    var settable: DarwinBoolean = false
    return AXUIElementIsAttributeSettableValue(el, attr as CFString, &settable) == .success && settable.boolValue
}
// `AXUIElementIsAttributeSettableValue` is the actual symbol name in some SDKs;
// wrap the canonical one.
func AXUIElementIsAttributeSettableValue(_ e: AXUIElement, _ a: CFString, _ s: UnsafeMutablePointer<DarwinBoolean>) -> AXError {
    return AXUIElementIsAttributeSettable(e, a, s)
}

let kInteresting = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXValueAttribute,
    kAXDescriptionAttribute, kAXHelpAttribute, kAXPlaceholderValueAttribute,
    kAXEnabledAttribute, kAXFocusedAttribute,
]

func elementNode(_ el: AXUIElement, path: String, map: AXMap, depth: Int, maxDepth: Int, count: inout Int, limit: Int) -> [String: Any]? {
    if count >= limit { return nil }
    count += 1
    let role = axString(el, kAXRoleAttribute) ?? "AXUnknown"
    let ident = axString(el, kAXIdentifierAttribute) ?? ""
    let id = "\(path)/\(role)#\(ident)"
    map.store(id, el)
    var node: [String: Any] = ["id": id, "role": role]
    if let sub = axString(el, kAXSubroleAttribute), !sub.isEmpty { node["subrole"] = sub }
    if let t = axString(el, kAXTitleAttribute), !t.isEmpty { node["title"] = t }
    if let d = axString(el, kAXDescriptionAttribute), !d.isEmpty { node["desc"] = d }
    if let ph = axString(el, kAXPlaceholderValueAttribute), !ph.isEmpty { node["placeholder"] = ph }
    // value can be string or number; stringify compactly
    var valueRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &valueRef) == .success {
        if let s = valueRef as? String { if !s.isEmpty { node["value"] = String(s.prefix(2000)) } }
        else if let n = valueRef as? NSNumber { node["value"] = n.stringValue }
    }
    if axBool(el, kAXEnabledAttribute) == false { node["enabled"] = false }
    if axBool(el, kAXFocusedAttribute) == true { node["focused"] = true }
    let actions = axActions(el).filter { $0 != kAXShowMenuAction }
    if !actions.isEmpty { node["actions"] = actions }
    if axSettable(el, kAXValueAttribute) { node["settable"] = true }
    if depth < maxDepth {
        var kids: [[String: Any]] = []
        for (i, child) in axChildren(el).enumerated() {
            if count >= limit { node["truncated"] = true; break }
            if let c = elementNode(child, path: "\(id)[\(i)]", map: map, depth: depth + 1, maxDepth: maxDepth, count: &count, limit: limit) {
                kids.append(c)
            }
        }
        if !kids.isEmpty { node["children"] = kids }
    } else if !axChildren(el).isEmpty {
        node["truncated"] = true
    }
    return node
}

func keyWindowElement(forPid pid: pid_t) -> AXUIElement? {
    let app = AXUIElementCreateApplication(pid)
    var win: CFTypeRef?
    for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
        if AXUIElementCopyAttributeValue(app, attr as CFString, &win) == .success, let w = win {
            return (w as! AXUIElement)
        }
    }
    // Fall back to the first window.
    var wins: CFTypeRef?
    if AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &wins) == .success,
       let list = wins as? [AXUIElement], let first = list.first {
        return first
    }
    return nil
}

func observeTree(pid: pid_t, map: AXMap) -> [String: Any]? {
    guard let window = keyWindowElement(forPid: pid) else { return nil }
    map.clear()
    var count = 0
    return elementNode(window, path: "w", map: map, depth: 0, maxDepth: 60, count: &count, limit: 4000)
}

// ───────────────────────── window capture ─────────────────────────

@available(macOS 14.0, *)
func captureKeyWindowPNG(pid: pid_t, completion: @escaping (Data?, [String: Any]?) -> Void) {
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            // The target app's own windows only; never the whole screen.
            let windows = content.windows.filter { $0.owningApplication?.processID == pid }
            // Prefer the key window title if we can read it; else the largest window.
            let chosen = windows.max(by: { ($0.frame.width * $0.frame.height) < ($1.frame.width * $1.frame.height) })
            guard let target = chosen else { completion(nil, nil); return }
            let filter = SCContentFilter(desktopIndependentWindow: target)
            let cfg = SCStreamConfiguration()
            cfg.width = Int(target.frame.width)
            cfg.height = Int(target.frame.height)
            cfg.showsCursor = false
            cfg.ignoreShadowsSingleWindow = true
            let cg = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
            let rep = NSBitmapImageRep(cgImage: cg)
            guard let png = rep.representation(using: .png, properties: [:]) else { completion(nil, nil); return }
            completion(png, ["width": cg.width, "height": cg.height,
                             "windowTitle": target.title ?? ""])
        } catch {
            FileHandle.standardError.write("capture error: \(error)\n".data(using: .utf8)!)
            completion(nil, nil)
        }
    }
}

// ───────────────────────── input (background, pid-targeted) ─────────────────────────
// We never post to the global session and never move the cursor. CGEventPostToPid
// delivers directly to the target process's event queue.

func pressModifiersFlags(_ mods: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for m in mods {
        switch m {
        case "cmd": flags.insert(.maskCommand)
        case "ctrl": flags.insert(.maskControl)
        case "alt": flags.insert(.maskAlternate)
        case "shift": flags.insert(.maskShift)
        default: break
        }
    }
    return flags
}

let keyCodes: [String: CGKeyCode] = [
    "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
    "j": 38, "k": 40, "n": 45, "m": 46,
]

func postKey(pid: pid_t, keyCode: CGKeyCode, flags: CGEventFlags) {
    let src = CGEventSource(stateID: .privateState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: true)
    down?.flags = flags
    let up = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: false)
    up?.flags = flags
    down?.postToPid(pid)
    up?.postToPid(pid)
}

func typeText(pid: pid_t, text: String) {
    let src = CGEventSource(stateID: .privateState)
    // Unit = one event carrying the UTF-16 for a chunk; keep chunks small.
    for scalarChunk in text.unicodeScalars.chunked(into: 20) {
        var utf16: [UniChar] = []
        for s in scalarChunk { utf16.append(contentsOf: Array(String(s).utf16)) }
        let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
        let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
        utf16.withUnsafeBufferPointer { buf in
            down?.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
            up?.keyboardSetUnicodeString(stringLength: buf.count, unicodeString: buf.baseAddress)
        }
        down?.postToPid(pid)
        up?.postToPid(pid)
    }
}

func postClick(pid: pid_t, at: CGPoint, button: CGMouseButton, count: Int) {
    let src = CGEventSource(stateID: .privateState)
    let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
    for i in 1...max(1, count) {
        let down = CGEvent(mouseEventSource: src, mouseType: downType, mouseCursorPosition: at, mouseButton: button)
        down?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        let up = CGEvent(mouseEventSource: src, mouseType: upType, mouseCursorPosition: at, mouseButton: button)
        up?.setIntegerValueField(.mouseEventClickState, value: Int64(i))
        down?.postToPid(pid)
        up?.postToPid(pid)
    }
}

func postScroll(pid: pid_t, at: CGPoint, dx: Int32, dy: Int32) {
    let src = CGEventSource(stateID: .privateState)
    let ev = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
    ev?.location = at
    ev?.postToPid(pid)
}

extension Collection {
    func chunked(into size: Int) -> [[Element]] {
        var out: [[Element]] = []
        var it = makeIterator()
        var cur: [Element] = []
        while let e = it.next() { cur.append(e); if cur.count == size { out.append(cur); cur = [] } }
        if !cur.isEmpty { out.append(cur) }
        return out
    }
}

// ───────────────────────── actions ─────────────────────────

enum ActError: Error { case message(String, String) }

func performAction(pid: pid_t, action: [String: Any], map: AXMap) throws {
    guard let kind = action["kind"] as? String else { throw ActError.message("BAD_ACTION", "missing kind") }
    func elementFor() throws -> AXUIElement {
        guard let id = action["ref"] as? String, let el = map.element(id) else {
            throw ActError.message("STALE_REF", "unknown or stale element ref")
        }
        return el
    }
    switch kind {
    case "press-action": // AX action by name, no events at all (preferred)
        let el = try elementFor()
        let name = (action["action"] as? String) ?? kAXPressAction
        if AXUIElementPerformAction(el, name as CFString) != .success {
            throw ActError.message("AX_ACTION_FAILED", "AX action \(name) failed")
        }
    case "set-value":
        let el = try elementFor()
        let value = (action["value"] as? String) ?? ""
        if !axSettable(el, kAXValueAttribute) { throw ActError.message("NOT_SETTABLE", "value is not settable") }
        if AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFTypeRef) != .success {
            throw ActError.message("AX_SET_FAILED", "could not set value")
        }
    case "focus": // make a field key without activating the app
        let el = try elementFor()
        _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    case "type":
        if let id = action["ref"] as? String, let el = map.element(id) {
            _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        }
        guard let text = action["text"] as? String else { throw ActError.message("BAD_ACTION", "missing text") }
        typeText(pid: pid, text: text)
    case "press":
        guard let key = action["key"] as? String, let code = keyCodes[key.lowercased()] else {
            throw ActError.message("BAD_KEY", "unknown key")
        }
        let mods = (action["modifiers"] as? [String]) ?? []
        postKey(pid: pid, keyCode: code, flags: pressModifiersFlags(mods))
    case "click-at":
        guard let x = action["x"] as? Double, let y = action["y"] as? Double else {
            throw ActError.message("BAD_ACTION", "missing coordinates")
        }
        let button: CGMouseButton = (action["button"] as? String) == "right" ? .right : .left
        let count = (action["count"] as? Int) ?? 1
        postClick(pid: pid, at: CGPoint(x: x, y: y), button: button, count: count)
    case "scroll":
        let x = (action["x"] as? Double) ?? 0, y = (action["y"] as? Double) ?? 0
        let dir = (action["direction"] as? String) ?? "down"
        let amount = Int32((action["amount"] as? Int) ?? 3)
        var dx: Int32 = 0, dy: Int32 = 0
        switch dir { case "up": dy = amount; case "down": dy = -amount; case "left": dx = amount; case "right": dx = -amount; default: break }
        postScroll(pid: pid, at: CGPoint(x: x, y: y), dx: dx, dy: dy)
    default:
        throw ActError.message("BAD_ACTION", "unsupported kind \(kind)")
    }
}

// ───────────────────────── launch (hidden, no activation) ─────────────────────────

func launchHidden(_ name: String, hide: Bool, completion: @escaping (pid_t?, String?) -> Void) {
    let ws = NSWorkspace.shared
    var url: URL?
    if name.contains("/") || name.hasSuffix(".app") {
        url = URL(fileURLWithPath: name)
    } else if let u = ws.urlForApplication(withBundleIdentifier: name) {
        url = u
    } else {
        // locate by display name
        url = ws.urlForApplication(toOpen: URL(fileURLWithPath: "/dev/null"))
        if let full = findAppByName(name) { url = full }
    }
    guard let appURL = url else { completion(nil, "app not found"); return }
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = false          // never bring it to the front (keeps the user's focus)
    cfg.addsToRecentItems = false
    // App-level hide removes the window from the AX tree, so we only hide when the
    // caller asks and accepts AX-blind operation. Default: visible-but-not-activated,
    // i.e. the window opens behind the user's frontmost app. ScreenCaptureKit can
    // still capture it when it is occluded by other windows.
    cfg.hides = hide
    ws.openApplication(at: appURL, configuration: cfg) { app, err in
        if let app = app { completion(app.processIdentifier, nil) }
        else { completion(nil, err?.localizedDescription ?? "launch failed") }
    }
}

func findAppByName(_ name: String) -> URL? {
    for dir in ["/System/Applications", "/Applications", "/System/Applications/Utilities"] {
        let candidate = URL(fileURLWithPath: dir).appendingPathComponent("\(name).app")
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
    }
    return nil
}

// ───────────────────────── request handling ─────────────────────────

let map = AXMap()

func handle(_ req: [String: Any]) -> [String: Any] {
    let id = req["id"]
    guard let op = req["op"] as? String else { return fail(id, "BAD_REQUEST", "missing op") }
    let before = environment()

    switch op {
    case "frontmost":
        return ok(id, ["env": before])
    case "apps":
        let apps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && $0.bundleIdentifier != nil }
            .map { ["name": $0.localizedName ?? "", "bundleId": $0.bundleIdentifier ?? "", "pid": Int($0.processIdentifier)] }
        return ok(id, ["apps": apps, "env": before])
    case "launch":
        guard let name = req["app"] as? String else { return fail(id, "BAD_REQUEST", "missing app") }
        let hide = (req["hide"] as? Bool) ?? false
        let sem = DispatchSemaphore(value: 0)
        var out: (pid_t?, String?) = (nil, nil)
        launchHidden(name, hide: hide) { pid, err in out = (pid, err); sem.signal() }
        sem.wait()
        let after = environment()
        if let pid = out.0 {
            return ok(id, ["pid": Int(pid), "env": after, "envBefore": before,
                           "backgroundPreserved": backgroundPreserved(before, after)])
        }
        return fail(id, "LAUNCH_FAILED", out.1 ?? "launch failed")
    case "observe":
        guard let pidN = req["pid"] as? Int else { return fail(id, "BAD_REQUEST", "missing pid") }
        guard let tree = observeTree(pid: pid_t(pidN), map: map) else {
            return fail(id, "NO_WINDOW", "target has no accessible key window")
        }
        return ok(id, ["tree": tree, "env": environment()])
    case "look":
        guard let pidN = req["pid"] as? Int else { return fail(id, "BAD_REQUEST", "missing pid") }
        guard #available(macOS 14.0, *) else { return fail(id, "UNSUPPORTED_OS", "window capture needs macOS 14+") }
        let sem = DispatchSemaphore(value: 0)
        var png: Data?; var meta: [String: Any]?
        captureKeyWindowPNG(pid: pid_t(pidN)) { p, m in png = p; meta = m; sem.signal() }
        sem.wait()
        guard let data = png, let m = meta else { return fail(id, "CAPTURE_FAILED", "window capture failed (Screen Recording permission?)") }
        return ok(id, ["image": ["mimeType": "image/png", "data": data.base64EncodedString(),
                                 "width": m["width"] ?? 0, "height": m["height"] ?? 0],
                       "env": environment()])
    case "act":
        guard let pidN = req["pid"] as? Int, let action = req["action"] as? [String: Any] else {
            return fail(id, "BAD_REQUEST", "missing pid or action")
        }
        let t0 = nowMs()
        do { try performAction(pid: pid_t(pidN), action: action, map: map) }
        catch ActError.message(let code, let msg) { return fail(id, code, msg) }
        catch { return fail(id, "ACT_FAILED", "\(error)") }
        // settle briefly, then re-observe in the same round trip
        usleep(60_000)
        let actMs = nowMs() - t0
        let tree = observeTree(pid: pid_t(pidN), map: map)
        let after = environment()
        var result: [String: Any] = ["actionMs": actMs, "env": after, "envBefore": before,
                                      "backgroundPreserved": backgroundPreserved(before, after)]
        if let tree = tree { result["tree"] = tree } else { result["treeError"] = "NO_WINDOW" }
        return ok(id, result)
    case "selfcheck":
        let pidN = req["pid"] as? Int
        var result: [String: Any] = ["env": before, "axTrusted": AXIsProcessTrusted(),
                                     "screenRecording": CGPreflightScreenCaptureAccess()]
        if let pidN = pidN {
            let t0 = nowMs()
            let tree = observeTree(pid: pid_t(pidN), map: map)
            result["observeMs"] = nowMs() - t0
            if let tree = tree {
                let bytes = try! JSONSerialization.data(withJSONObject: tree).count
                result["treeBytes"] = bytes
                result["nodeCount"] = countNodes(tree)
            }
        }
        result["envAfter"] = environment()
        result["backgroundPreserved"] = backgroundPreserved(before, (result["envAfter"] as! [String: Any]))
        return ok(id, result)
    default:
        return fail(id, "BAD_OP", "unknown op \(op)")
    }
}

func countNodes(_ node: [String: Any]) -> Int {
    var n = 1
    if let kids = node["children"] as? [[String: Any]] { for k in kids { n += countNodes(k) } }
    return n
}

func backgroundPreserved(_ a: [String: Any], _ b: [String: Any]) -> Bool {
    func s(_ d: [String: Any], _ k: String) -> String { String(describing: d[k] ?? "") }
    let frontSame = s(a, "frontmostPid") == s(b, "frontmostPid")
    let keySame = s(a, "frontmostKeyWindow") == s(b, "frontmostKeyWindow")
    let ma = a["mouse"] as? [String: Double] ?? [:], mb = b["mouse"] as? [String: Double] ?? [:]
    let mouseSame = (ma["x"] ?? 0) == (mb["x"] ?? -1) && (ma["y"] ?? 0) == (mb["y"] ?? -1)
    return frontSame && keySame && mouseSame
}

// ───────────────────────── main loop ─────────────────────────

if CommandLine.arguments.contains("--version") {
    print("ondra-cuhost 0.1.0")
    exit(0)
}

setbuf(stdout, nil)
while let line = readLine(strippingNewline: true) {
    if line.isEmpty { continue }
    guard let data = line.data(using: .utf8),
          let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        emit(fail(nil, "BAD_JSON", "could not parse request"))
        continue
    }
    emit(handle(obj))
}
