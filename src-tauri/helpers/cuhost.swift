// ondra-cuhost — background host computer use for the user's own Mac.
//
// Drives one target app entirely in the background, using only public macOS APIs:
//   - Accessibility (AXUIElement*) for the UI tree and for actions.
//   - pid-targeted CGEvent (CGEventPostToPid) for keys/text/drag/coordinate clicks —
//     only as a fallback when an AX action is unavailable. Pointer events are built
//     with the public NSEvent initializer so they carry the target window; drags are
//     eased down/dragged/up sequences. Scrolling uses the AX scroll bar instead.
//   - ScreenCaptureKit (SCShareableContent + SCScreenshotManager) for window-only
//     captures of the target app's own windows, even hidden or occluded.
//
// Background contract, enforced here, not papered over:
//   - never activates an app, never brings a window to front;
//   - never warps the real cursor, never posts to the global session (events go
//     to the target pid only); where it points is shown with its own small pointer
//     drawn just above the target window;
//   - opens an app the job starts on an off-screen display it holds (a background-only
//     copy, spawned suspended and assigned there before its first window): no Dock tile,
//     no flash, focus never taken, and its login keychain kept; apps that can't be copied
//     that way fall back to the real app launched hidden (not one the user already runs);
//   - records the frontmost app, its front window id and mouse position BEFORE and
//     AFTER every action and reports them, so the caller can verify nothing moved;
//   - refuses event input while the user is working in the target app, and never
//     reads or types into password fields.
// When an app ignores an AX action, the helper clicks the element with pointer
// events addressed to its window; when an app brings itself forward on a click, the
// helper hands the front straight back to the user's app. It never falls back to
// foreground. This is the opposite of Codex's SyntheticAppFocusEnforcer /
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
//   {"op":"launch","app":"TextEdit"}        → open in the background (off-screen copy),
//                                             or a hidden real-app fallback; never activated
//   {"op":"observe","pid":123,"full":bool}  → compact AX tree (full) or diff
//   {"op":"look","pid":123}                 → window-only PNG (base64) of the key window,
//                                             plus its frame; coordinates are image pixels
//   {"op":"act","pid":123,"action":{…}}     → one action, settle, then re-observe
//   {"op":"release","pid":123}              → hide again anything shown for a capture or events
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

/// The frontmost app's front window by CGWindowID (on-screen list is front-to-back).
/// Identity, not title: a title can change on its own (a terminal's spinner).
func frontWindowId(pid: pid_t) -> Int? {
    guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    return info.first { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }?[kCGWindowNumber as String] as? Int
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
    if frontPid > 0, let wid = frontWindowId(pid: frontPid) { env["frontmostWindowId"] = wid }
    return env
}

// ───────────────────────── AX tree ─────────────────────────
// A compact tree with per-session stable ids. Each element's structural key (parent
// key + role + AXIdentifier + child index) is stable across observations of the same
// window; the emitted id is a short hash of that key, so the same control keeps the
// same few-character id and the caller can diff by id instead of by position, without
// paying for long path ids in every node.
//
// Attributes are read in one AXUIElementCopyMultipleAttributeValues call per element
// (one IPC round trip instead of ~10), and children scrolled out of their scroll
// area are left out (counted in "offscreen") so long lists cost only their visible rows.

final class AXMap {
    private var byId: [String: AXUIElement] = [:]
    private var keyForId: [String: String] = [:]
    func clear() { byId.removeAll(); keyForId.removeAll() }
    /// Short, stable id for a structural key; a (rare) hash collision gets a suffix.
    func id(for key: String) -> String {
        var h: UInt32 = 2166136261
        for b in key.utf8 { h = (h ^ UInt32(b)) &* 16777619 }
        let base = "e" + String(h, radix: 36)
        var id = base, n = 1
        while let other = keyForId[id], other != key { n += 1; id = "\(base)_\(n)" }
        keyForId[id] = key
        return id
    }
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
    return AXUIElementIsAttributeSettable(el, attr as CFString, &settable) == .success && settable.boolValue
}
/// Global, top-left-origin frame from AXPosition + AXSize.
func axFrame(_ el: AXUIElement) -> CGRect? {
    var p: CFTypeRef?, z: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &p) == .success,
          AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &z) == .success else { return nil }
    return frameFrom(p, z)
}
func frameFrom(_ p: CFTypeRef?, _ z: CFTypeRef?) -> CGRect? {
    guard let p = p, let z = z, CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(z) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(z as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}
func isSecure(role: String, subrole: String?) -> Bool {
    role == "AXSecureTextField" || subrole == "AXSecureTextField"
}

// One batched read per element. Order matters: indexes below.
let kBatch: [String] = [
    kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
    kAXPlaceholderValueAttribute, kAXValueAttribute, kAXEnabledAttribute, kAXFocusedAttribute,
    kAXIdentifierAttribute, kAXChildrenAttribute, kAXPositionAttribute, kAXSizeAttribute,
    kAXSelectedTextAttribute,
]
let kTextRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXSlider", "AXIncrementor"]
let kClipRoles: Set<String> = ["AXScrollArea", "AXTable", "AXOutline", "AXList", "AXBrowser"]

struct Attrs {
    var role = "AXUnknown", subrole: String?, title: String?, desc: String?, placeholder: String?
    var value: CFTypeRef?, enabled: Bool?, focused: Bool?, ident: String?
    var children: [AXUIElement] = [], frame: CGRect?, selection: String?
}

func readAttrs(_ el: AXUIElement) -> Attrs {
    var out = Attrs()
    var raw: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(el, kBatch as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw) == .success,
          let vals = raw as? [AnyObject], vals.count == kBatch.count else {
        // Fall back to single reads (some apps do not implement the batched call).
        out.role = axString(el, kAXRoleAttribute) ?? "AXUnknown"
        out.subrole = axString(el, kAXSubroleAttribute); out.title = axString(el, kAXTitleAttribute)
        out.desc = axString(el, kAXDescriptionAttribute); out.placeholder = axString(el, kAXPlaceholderValueAttribute)
        var v: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, kAXValueAttribute as CFString, &v) == .success { out.value = v }
        out.enabled = axBool(el, kAXEnabledAttribute); out.focused = axBool(el, kAXFocusedAttribute)
        out.ident = axString(el, kAXIdentifierAttribute); out.children = axChildren(el); out.frame = axFrame(el)
        return out
    }
    // A failed attribute comes back as an AXValue of type kAXValueAXErrorType.
    func get(_ i: Int) -> CFTypeRef? {
        let v = vals[i] as CFTypeRef
        if CFGetTypeID(v) == AXValueGetTypeID(), AXValueGetType(v as! AXValue) == .axError { return nil }
        if v is NSNull { return nil }
        return v
    }
    out.role = (get(0) as? String) ?? "AXUnknown"
    out.subrole = get(1) as? String; out.title = get(2) as? String; out.desc = get(3) as? String
    out.placeholder = get(4) as? String; out.value = get(5)
    out.enabled = (get(6) as? NSNumber)?.boolValue; out.focused = (get(7) as? NSNumber)?.boolValue
    out.ident = get(8) as? String; out.children = (get(9) as? [AXUIElement]) ?? []
    out.frame = frameFrom(get(10), get(11))
    out.selection = get(12) as? String
    return out
}

func elementNode(_ el: AXUIElement, key parentKey: String, map: AXMap, depth: Int, maxDepth: Int,
                 clip: CGRect, count: inout Int, limit: Int, pre: Attrs? = nil) -> [String: Any]? {
    if count >= limit { return nil }
    count += 1
    let a = pre ?? readAttrs(el)
    let key = "\(parentKey)/\(a.role)#\(a.ident ?? "")"
    let id = map.id(for: key)
    map.store(id, el)
    var node: [String: Any] = ["id": id, "role": a.role]
    let secure = isSecure(role: a.role, subrole: a.subrole)
    if let sub = a.subrole, !sub.isEmpty { node["subrole"] = sub }
    if let t = a.title, !t.isEmpty { node["title"] = t }
    if let d = a.desc, !d.isEmpty { node["desc"] = d }
    if let ph = a.placeholder, !ph.isEmpty { node["placeholder"] = ph }
    if secure {
        node["secure"] = true // never read or return a password value
    } else if let v = a.value {
        if let s = v as? String { if !s.isEmpty { node["value"] = s.count > 2000 ? String(s.prefix(2000)) + "…[truncated]" : s } }
        else if let n = v as? NSNumber { node["value"] = n.stringValue }
    }
    if !secure, let sel = a.selection, !sel.isEmpty { node["selection"] = sel.count > 200 ? String(sel.prefix(200)) + "…" : sel }
    if a.enabled == false { node["enabled"] = false }
    if a.focused == true { node["focused"] = true }
    let actions = axActions(el).filter { $0 != kAXShowMenuAction }
    if !actions.isEmpty { node["actions"] = actions }
    if !secure, a.value != nil || kTextRoles.contains(a.role), axSettable(el, kAXValueAttribute) { node["settable"] = true }
    // Children are clipped to the nearest scroll area / list that contains them.
    var childClip = clip
    if kClipRoles.contains(a.role), let f = a.frame, f.width > 0, f.height > 0 { childClip = clip.intersection(f) }
    if depth < maxDepth {
        var kids: [[String: Any]] = []
        var offscreen = 0
        for (i, child) in a.children.enumerated() {
            if count >= limit { node["truncated"] = true; break }
            let ca = readAttrs(child)
            if let f = ca.frame, f.width > 0, f.height > 0, !f.intersects(childClip) { offscreen += 1; continue }
            if let c = elementNode(child, key: "\(key)[\(i)]", map: map, depth: depth + 1, maxDepth: maxDepth,
                                   clip: childClip, count: &count, limit: limit, pre: ca) {
                kids.append(c)
            }
        }
        if !kids.isEmpty { node["children"] = kids }
        if offscreen > 0 { node["offscreen"] = offscreen } // scroll to reveal them
    } else if !a.children.isEmpty {
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
    let a = readAttrs(window)
    let clip = a.frame ?? CGRect(x: -1e6, y: -1e6, width: 2e6, height: 2e6)
    return elementNode(window, key: "w", map: map, depth: 0, maxDepth: 60, clip: clip, count: &count, limit: 4000, pre: a)
}

// ───────────────────────── window capture ─────────────────────────
// The captured window is the one the AX tree describes (matched by frame), so look
// pixels and tree ids refer to the same window. Its frame and CGWindowID are kept:
// coordinate actions use image pixels of the latest look, and are refused if the
// window has moved or resized since (the pixels would no longer line up).
// Under Stage Manager, ScreenCaptureKit reports a strip thumbnail's frame for a
// background window, so the AX frame (the one the app maps events with) is used.

struct LookFrame { let frame: CGRect; let windowID: CGWindowID; let width: Int; let height: Int }
var lastLook: [pid_t: LookFrame] = [:]

func nearlySame(_ a: CGRect, _ b: CGRect, _ tol: CGFloat = 1.5) -> Bool {
    abs(a.minX - b.minX) <= tol && abs(a.minY - b.minY) <= tol && abs(a.width - b.width) <= tol && abs(a.height - b.height) <= tol
}

@available(macOS 14.0, *)
func captureKeyWindowPNG(pid: pid_t, completion: @escaping (Data?, [String: Any]?) -> Void) {
    let axWindow = keyWindowElement(forPid: pid)
    let axFrameNow = axWindow.flatMap(axFrame)
    let axTitle = axWindow.flatMap { axString($0, kAXTitleAttribute) }
    Task {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            // The target app's own windows only; never the whole screen.
            let windows = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 }
            // Match the AX key window: by frame, else by title (Stage Manager reports a
            // thumbnail frame for windows in its strip), else the largest window.
            let matched = axFrameNow.flatMap { f in windows.first { nearlySame($0.frame, f) } }
                ?? axTitle.flatMap { t in t.isEmpty ? nil : windows.first { $0.title == t } }
            let chosen = matched ?? windows.max(by: { ($0.frame.width * $0.frame.height) < ($1.frame.width * $1.frame.height) })
            guard let target = chosen else { completion(nil, nil); return }
            // The window's real frame is what the app maps events with; prefer AX's.
            let f = (matched != nil ? axFrameNow : nil) ?? target.frame
            let filter = SCContentFilter(desktopIndependentWindow: target)
            let cfg = SCStreamConfiguration()
            cfg.width = Int(f.width)
            cfg.height = Int(f.height)
            cfg.showsCursor = false
            cfg.ignoreShadowsSingleWindow = true
            let cg = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
            let rep = NSBitmapImageRep(cgImage: cg)
            guard let png = rep.representation(using: .png, properties: [:]) else { completion(nil, nil); return }
            // Stage Manager: a window parked in the strip is composited as a small, skewed
            // thumbnail, and that is what gets captured. Its pixels are not to scale.
            let staged = matched != nil && !nearlySame(target.frame, f, 4)
            completion(png, ["width": cg.width, "height": cg.height, "windowTitle": target.title ?? "",
                             "windowID": Int(target.windowID), "matchedTree": matched != nil, "staged": staged,
                             "frame": ["x": Double(f.minX), "y": Double(f.minY), "width": Double(f.width), "height": Double(f.height)]])
        } catch {
            FileHandle.standardError.write("capture error: \(error)\n".data(using: .utf8)!)
            completion(nil, nil)
        }
    }
}

/// CGWindowID of the target's window with this frame or title (public CGWindowList;
/// numbers, owners and bounds need no Screen Recording permission).
func cgWindowID(pid: pid_t, frame: CGRect, title: String?) -> CGWindowID? {
    guard let info = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    let mine = info.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
    func number(_ w: [String: Any]) -> CGWindowID? { (w[kCGWindowNumber as String] as? Int).map { CGWindowID($0) } }
    for w in mine {
        if let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b), nearlySame(r, frame) { return number(w) }
    }
    if let t = title, !t.isEmpty, let w = mine.first(where: { ($0[kCGWindowName as String] as? String) == t }) { return number(w) }
    return nil
}

// ───────────────────────── input (background, pid-targeted) ─────────────────────────
// We never post to the global session and never move the cursor. CGEventPostToPid
// delivers directly to the target process's event queue. Mouse events also carry
// the target CGWindowID in the public kCGMouseEventWindowUnderMousePointer fields,
// so the app routes them to that window even though the real pointer is elsewhere.

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
    // Return in a background Chromium app goes over the private pipe (its page drops key events)
    if keyCode == 36, flags.isEmpty, let app = bgApp(pid), app.kind == .chromium, cdpEnter(app) { return }
    ensureDrawn(pid)
    let src = CGEventSource(stateID: .privateState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: true)
    down?.flags = flags
    let up = CGEvent(keyboardEventSource: src, virtualKey: keyCode, keyDown: false)
    up?.flags = flags
    down?.postToPid(pid)
    up?.postToPid(pid)
}

func typeText(pid: pid_t, text: String) {
    // A background Chromium app's page is never key: commit the text over the private pipe
    if let app = bgApp(pid), app.kind == .chromium, cdpInsertText(app, text) { return }
    ensureDrawn(pid)
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

/// The window a pointer event is addressed to: its CGWindowID and global frame.
struct EventWindow { let id: CGWindowID; let frame: CGRect }

/// A pid-targeted mouse event. When the target window is known, the event is built
/// with the public NSEvent mouse-event initializer, which carries the window number
/// and window-local location; without it, AppKit in a background app has no window
/// to deliver the event to (the WindowServer hit-test that normally fills it in only
/// happens for events at the real cursor). The public
/// kCGMouseEventWindowUnderMousePointer fields are set as well.
/// One number per press: AppKit ties a press's down, dragged and up events together by it.
var eventNumber = 0
func mouseEvent(_ src: CGEventSource?, _ type: CGEventType, _ at: CGPoint, _ button: CGMouseButton,
                window: EventWindow?, clickState: Int64 = 1) -> CGEvent? {
    var e: CGEvent?
    if let w = window, let nsType = NSEvent.EventType(rawValue: UInt(type.rawValue)) {
        // NSEvent→CGEvent conversion stores the location y-flipped by the primary
        // display height, and AppKit reads it back as a top-left window-local point.
        let primaryHeight = CGDisplayBounds(CGMainDisplayID()).height
        let local = NSPoint(x: at.x - w.frame.minX, y: primaryHeight - (at.y - w.frame.minY))
        e = NSEvent.mouseEvent(with: nsType, location: local, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                               windowNumber: Int(w.id), context: nil, eventNumber: eventNumber,
                               clickCount: Int(clickState), pressure: type == .leftMouseUp || type == .mouseMoved ? 0 : 1)?.cgEvent
    }
    if e == nil { e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: at, mouseButton: button) }
    e?.setIntegerValueField(.mouseEventClickState, value: clickState)
    if let w = window {
        e?.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.id))
        e?.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(w.id))
    }
    return e
}

func postClick(pid: pid_t, at: CGPoint, button: CGMouseButton, count: Int, window: EventWindow?) {
    ensureDrawn(pid)
    let src = CGEventSource(stateID: .privateState)
    let downType: CGEventType = button == .right ? .rightMouseDown : .leftMouseDown
    let upType: CGEventType = button == .right ? .rightMouseUp : .leftMouseUp
    for i in 1...max(1, count) {
        eventNumber += 1
        mouseEvent(src, downType, at, button, window: window, clickState: Int64(i))?.postToPid(pid)
        mouseEvent(src, upType, at, button, window: window, clickState: Int64(i))?.postToPid(pid)
    }
}

/// Minimum-jerk easing: starts and ends at rest, like a hand-made drag.
func minJerk(_ t: Double) -> Double { t * t * t * (10 - 15 * t + 6 * t * t) }

/// Press at `from`, move through eased intermediate points, release at `to` — all
/// posted to the target pid; the real cursor never moves. Returns the step count.
func postDrag(pid: pid_t, from: CGPoint, to: CGPoint, window: EventWindow?) -> Int {
    ensureDrawn(pid)
    let src = CGEventSource(stateID: .privateState)
    let distance = hypot(to.x - from.x, to.y - from.y)
    let steps = max(4, min(12, Int(distance / 24)))
    mouseEvent(src, .mouseMoved, from, .left, window: window, clickState: 0)?.postToPid(pid)
    eventNumber += 1
    mouseEvent(src, .leftMouseDown, from, .left, window: window)?.postToPid(pid)
    usleep(16_000) // let the app enter its mouse-tracking loop
    for i in 1...steps {
        let k = minJerk(Double(i) / Double(steps))
        let p = CGPoint(x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k)
        mouseEvent(src, .leftMouseDragged, p, .left, window: window)?.postToPid(pid)
        usleep(8_000) // ~120 Hz
    }
    mouseEvent(src, .leftMouseUp, to, .left, window: window)?.postToPid(pid)
    return steps
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

/// True if the user is working in the target app right now: it is frontmost and
/// there was hardware input in the last second. Synthetic input would mix with theirs.
func userActive(in pid: pid_t) -> Bool {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { return false }
    let types: [CGEventType] = [.keyDown, .leftMouseDown, .rightMouseDown, .mouseMoved, .leftMouseDragged, .scrollWheel]
    let idle = types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? .infinity
    return idle < 1.0
}

func focusedElement(pid: pid_t) -> AXUIElement? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute as CFString, &v) == .success,
          let f = v, CFGetTypeID(f) == AXUIElementGetTypeID() else { return nil }
    return (f as! AXUIElement)
}

/// The focused element is `el` or inside it (a field editor, a web text node, …).
func focusIsOn(_ el: AXUIElement, pid: pid_t) -> Bool {
    guard var cur = focusedElement(pid: pid) else { return false }
    for _ in 0..<6 {
        if CFEqual(cur, el) { return true }
        var parent: CFTypeRef?
        guard AXUIElementCopyAttributeValue(cur, kAXParentAttribute as CFString, &parent) == .success,
              let p = parent, CFGetTypeID(p) == AXUIElementGetTypeID() else { return false }
        cur = p as! AXUIElement
    }
    return false
}

/// The element's frame clipped to its enclosing scroll areas and the window.
func visibleFrame(of el: AXUIElement, within window: CGRect?) -> CGRect? {
    guard var r = axFrame(el) else { return nil }
    if let w = window { r = r.intersection(w) }
    var cur = el
    for _ in 0..<12 {
        var parent: CFTypeRef?
        guard AXUIElementCopyAttributeValue(cur, kAXParentAttribute as CFString, &parent) == .success,
              let p = parent, CFGetTypeID(p) == AXUIElementGetTypeID() else { break }
        cur = p as! AXUIElement
        if axString(cur, kAXRoleAttribute) == "AXScrollArea", let f = axFrame(cur) { r = r.intersection(f) }
    }
    return r.isNull || r.isEmpty ? nil : r
}

func axParent(_ el: AXUIElement) -> AXUIElement? {
    var parent: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXParentAttribute as CFString, &parent) == .success,
          let p = parent, CFGetTypeID(p) == AXUIElementGetTypeID() else { return nil }
    return (p as! AXUIElement)
}

/// The scroll area that is (or contains) `start`; else the smallest one under `point`.
func scrollArea(from start: AXUIElement?, containing point: CGPoint, pid: pid_t) -> AXUIElement? {
    var cur = start
    for _ in 0..<16 {
        guard let c = cur else { break }
        if axString(c, kAXRoleAttribute) == "AXScrollArea" { return c }
        cur = axParent(c)
    }
    guard let window = keyWindowElement(forPid: pid) else { return nil }
    var best: (AXUIElement, CGFloat)?
    var stack = [window], visited = 0
    while let el = stack.popLast(), visited < 4000 {
        visited += 1
        let a = readAttrs(el)
        if let f = a.frame, !f.contains(point) { continue }
        if a.role == "AXScrollArea", let f = a.frame, best == nil || f.width * f.height < best!.1 { best = (el, f.width * f.height) }
        stack.append(contentsOf: a.children)
    }
    return best?.0
}

/// Move a scroll area by about `lines` × 24 pt through its settable AX scroll bar,
/// falling back to its page-scroll actions.
func scrollAX(_ area: AXUIElement, direction: String, lines: Int) throws -> [String: Any] {
    let vertical = direction == "up" || direction == "down"
    let forward = direction == "down" || direction == "right"
    var barRef: CFTypeRef?
    let barAttr = vertical ? kAXVerticalScrollBarAttribute : kAXHorizontalScrollBarAttribute
    if AXUIElementCopyAttributeValue(area, barAttr as CFString, &barRef) == .success, let b = barRef,
       CFGetTypeID(b) == AXUIElementGetTypeID() {
        let bar = b as! AXUIElement
        var v: CFTypeRef?
        if axSettable(bar, kAXValueAttribute), AXUIElementCopyAttributeValue(bar, kAXValueAttribute as CFString, &v) == .success,
           let current = (v as? NSNumber)?.doubleValue, let view = axFrame(area) {
            var contentsRef: CFTypeRef?
            var content = vertical ? view.height : view.width
            if AXUIElementCopyAttributeValue(area, kAXContentsAttribute as CFString, &contentsRef) == .success,
               let list = contentsRef as? [AXUIElement], let first = list.first, let cf = axFrame(first) {
                content = vertical ? cf.height : cf.width
            }
            let range = max(1, content - (vertical ? view.height : view.width))
            let delta = Double(lines) * 24 / Double(range)
            let next = min(1, max(0, current + (forward ? delta : -delta)))
            if AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: next)) == .success {
                return ["scrolledTo": next]
            }
        }
    }
    let page = vertical ? (forward ? "AXScrollDownByPage" : "AXScrollUpByPage") : (forward ? "AXScrollRightByPage" : "AXScrollLeftByPage")
    if axActions(area).contains(page), AXUIElementPerformAction(area, page as CFString) == .success { return ["scrolledBy": "page"] }
    if let moved = scrollByReveal(area, direction: direction, lines: lines) { return moved }
    throw ActError.message("SCROLL_UNAVAILABLE", "this scroll area exposes no settable scroll bar or page action")
}

/// Web views (Safari web apps, WebKit chats) often expose no scroll bar. Bring the element just
/// past the visible edge into view instead (AXScrollToVisible): the area moves by about `lines`
/// rows, and a chat that loads older messages when scrolled up loads them.
func scrollByReveal(_ area: AXUIElement, direction: String, lines: Int) -> [String: Any]? {
    guard let view = axFrame(area), view.width > 0, view.height > 0 else { return nil }
    let step = CGFloat(max(1, lines)) * 24
    // where the element should end up beyond the edge, and how far an element is from it
    func distance(_ f: CGRect) -> CGFloat? {
        switch direction {
        case "down":  return f.maxY > view.maxY + 1 ? abs(f.maxY - (view.maxY + step)) : nil
        case "up":    return f.minY < view.minY - 1 ? abs(f.minY - (view.minY - step)) : nil
        case "right": return f.maxX > view.maxX + 1 ? abs(f.maxX - (view.maxX + step)) : nil
        case "left":  return f.minX < view.minX - 1 ? abs(f.minX - (view.minX - step)) : nil
        default: return nil
        }
    }
    let vertical = direction == "up" || direction == "down"
    var best: (AXUIElement, CGFloat)?
    var stack = axChildren(area), visited = 0
    while let el = stack.popLast(), visited < 4000 {
        visited += 1
        let kids = axChildren(el)
        // small elements (a row, a message) give even steps; whole containers would jump
        if let f = axFrame(el), f.width > 0, f.height > 0,
           (vertical ? f.height : f.width) < (vertical ? view.height : view.width) * 0.6,
           let d = distance(f), best == nil || d < best!.1 { best = (el, d) }
        stack.append(contentsOf: kids)
    }
    guard let (el, _) = best, let before = axFrame(el) else { return nil }
    guard AXUIElementPerformAction(el, "AXScrollToVisible" as CFString) == .success else { return nil }
    usleep(60_000)
    // it moved if the element's frame did (the page scrolled under it)
    if let after = axFrame(el), abs(after.minY - before.minY) < 1, abs(after.minX - before.minX) < 1 { return nil }
    return ["scrolledBy": "reveal"]
}

func elementIsSecure(_ el: AXUIElement) -> Bool {
    isSecure(role: axString(el, kAXRoleAttribute) ?? "", subrole: axString(el, kAXSubroleAttribute))
}

/// A point to send pointer events to, plus the window to route them to.
/// {ref}: the element's centre (global). {x,y}: pixels of the latest look of this
/// pid's window, refused if there was no look or the window moved since.
func resolvePoint(_ spec: [String: Any], pid: pid_t, map: AXMap) throws -> (CGPoint, EventWindow?) {
    if let ref = spec["ref"] as? String {
        guard let el = map.element(ref) else { throw ActError.message("STALE_REF", "unknown or stale element ref") }
        guard let f = axFrame(el), f.width > 0, f.height > 0 else { throw ActError.message("NO_BOUNDS", "this element has no visible bounds") }
        let win = keyWindowElement(forPid: pid)
        var window: EventWindow?
        if let wf = win.flatMap(axFrame), let wid = cgWindowID(pid: pid, frame: wf, title: win.flatMap { axString($0, kAXTitleAttribute) }) {
            window = EventWindow(id: wid, frame: wf)
        }
        // Aim at the part of the element that is actually visible (a table's frame can
        // extend far past its scroll view).
        let visible = visibleFrame(of: el, within: window?.frame) ?? f
        return (CGPoint(x: visible.midX, y: visible.midY), window)
    }
    guard let x = (spec["x"] as? NSNumber)?.doubleValue, let y = (spec["y"] as? NSNumber)?.doubleValue else {
        throw ActError.message("BAD_ACTION", "missing coordinates")
    }
    guard let look = lastLook[pid] else { throw ActError.message("NEEDS_LOOK", "coordinates are pixels of a look; look first") }
    guard let now = keyWindowElement(forPid: pid).flatMap(axFrame), nearlySame(now, look.frame) else {
        throw ActError.message("WINDOW_MOVED", "the window moved or resized since the last look; look again")
    }
    guard x >= 0, y >= 0, x < Double(look.width), y < Double(look.height) else {
        throw ActError.message("OUT_OF_WINDOW", "coordinates are outside the captured window")
    }
    let sx = look.frame.width / CGFloat(max(1, look.width)), sy = look.frame.height / CGFloat(max(1, look.height))
    return (CGPoint(x: look.frame.minX + CGFloat(x) * sx, y: look.frame.minY + CGFloat(y) * sy),
            EventWindow(id: look.windowID, frame: look.frame))
}

func performAction(pid: pid_t, action: [String: Any], map: AXMap) throws -> [String: Any] {
    guard let kind = action["kind"] as? String else { throw ActError.message("BAD_ACTION", "missing kind") }
    func elementFor() throws -> AXUIElement {
        guard let id = action["ref"] as? String, let el = map.element(id) else {
            throw ActError.message("STALE_REF", "unknown or stale element ref")
        }
        return el
    }
    // Event-posting actions must not mix with the user's own typing or pointing.
    if ["type", "press", "click-at", "drag"].contains(kind), userActive(in: pid) {
        throw ActError.message("USER_ACTIVE", "the user is working in this app; nothing was sent")
    }
    switch kind {
    case "press-action": // AX action by name, no events at all (preferred)
        let el = try elementFor()
        let name = (action["action"] as? String) ?? kAXPressAction
        let count = max(1, min(2, (action["count"] as? Int) ?? 1))
        let right = (action["button"] as? String) == "right"
        let forcePointer = (action["pointer"] as? Bool) ?? false
        let spot = try? resolvePoint(["ref": action["ref"] ?? ""], pid: pid, map: map)
        if count == 1 && !right && !forcePointer && AXUIElementPerformAction(el, name as CFString) == .success {
            if let (p, w) = spot { VirtualCursor.shared.show(at: p, window: w, click: true) }
            return ["via": "ax"]
        }
        if count == 1 && right && !forcePointer && axActions(el).contains(kAXShowMenuAction),
           AXUIElementPerformAction(el, kAXShowMenuAction as CFString) == .success {
            if let (p, w) = spot { VirtualCursor.shared.show(at: p, window: w, click: true) }
            return ["via": "ax-menu"]
        }
        // The view ignores accessibility actions (custom rows, profile cards, …): click it
        // with pointer events addressed to its window, still without moving the real cursor.
        guard (action["fallbackClick"] as? Bool) ?? false else {
            throw ActError.message("AX_ACTION_FAILED", "AX action \(name) failed")
        }
        if userActive(in: pid) { throw ActError.message("USER_ACTIVE", "the user is working in this app; nothing was sent") }
        guard let (p, w) = spot else { throw ActError.message("NO_BOUNDS", "this element has no visible bounds to click") }
        VirtualCursor.shared.show(at: p, window: w, click: true)
        postClick(pid: pid, at: p, button: right ? .right : .left, count: count, window: w)
        return ["via": "pointer"]
    case "set-value":
        let el = try elementFor()
        if elementIsSecure(el) { throw ActError.message("SECURE_FIELD", "password fields are left to the user") }
        let value = (action["value"] as? String) ?? ""
        if !axSettable(el, kAXValueAttribute) { throw ActError.message("NOT_SETTABLE", "value is not settable") }
        if AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFTypeRef) != .success {
            throw ActError.message("AX_SET_FAILED", "could not set value")
        }
        if let (p, w) = try? resolvePoint(["ref": action["ref"] ?? ""], pid: pid, map: map) { VirtualCursor.shared.show(at: p, window: w, click: false) }
    case "focus": // make a field key without activating the app
        let el = try elementFor()
        _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    case "type":
        guard let text = action["text"] as? String else { throw ActError.message("BAD_ACTION", "missing text") }
        // A background Chromium app's page is never key, so AX focus can't be verified and its
        // editor drops key events; commit over the private pipe. Click the target first (if given)
        // to place the caret, then insert into whatever the page has focused.
        if let bg = bgApp(pid), bg.kind == .chromium {
            if let _ = action["ref"] {
                let el = try elementFor()
                if elementIsSecure(el) { throw ActError.message("SECURE_FIELD", "password fields are left to the user") }
                _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
                if let (p, w) = try? resolvePoint(["ref": action["ref"] ?? ""], pid: pid, map: map) {
                    if !focusIsOn(el, pid: pid) { postClick(pid: pid, at: p, button: .left, count: 1, window: w); usleep(80_000) }
                    VirtualCursor.shared.show(at: p, window: w, click: false)
                }
            }
            guard cdpInsertText(bg, text) else { throw ActError.message("TYPE_FAILED", "could not insert text into the page") }
            return ["via": "cdp"]
        }
        if let _ = action["ref"] {
            let el = try elementFor()
            if elementIsSecure(el) { throw ActError.message("SECURE_FIELD", "password fields are left to the user") }
            _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            let spot = try? resolvePoint(["ref": action["ref"] ?? ""], pid: pid, map: map)
            if !focusIsOn(el, pid: pid), let (p, w) = spot {
                // some fields only take focus from a click: one addressed to the window, cursor untouched
                postClick(pid: pid, at: p, button: .left, count: 1, window: w)
                usleep(80_000)
            }
            if let (p, w) = spot { VirtualCursor.shared.show(at: p, window: w, click: false) }
            // Keys go to whatever has focus; only send them if focus really landed on the target.
            if !focusIsOn(el, pid: pid) {
                if axSettable(el, kAXValueAttribute) {
                    let current = axString(el, kAXValueAttribute) ?? ""
                    if AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, (current + text) as CFTypeRef) == .success {
                        return ["via": "value"]
                    }
                }
                throw ActError.message("FOCUS_UNVERIFIED", "keyboard focus is not on the target; nothing was typed")
            }
        } else {
            guard let f = focusedElement(pid: pid) else { throw ActError.message("NO_FOCUS", "no focused element; pass a ref") }
            if elementIsSecure(f) { throw ActError.message("SECURE_FIELD", "password fields are left to the user") }
        }
        typeText(pid: pid, text: text)
    case "press":
        guard let key = action["key"] as? String, let code = keyCodes[key.lowercased()] else {
            throw ActError.message("BAD_KEY", "unknown key")
        }
        let mods = (action["modifiers"] as? [String]) ?? []
        postKey(pid: pid, keyCode: code, flags: pressModifiersFlags(mods))
    case "click-at":
        let (p, w) = try resolvePoint(action, pid: pid, map: map)
        let button: CGMouseButton = (action["button"] as? String) == "right" ? .right : .left
        let count = (action["count"] as? Int) ?? 1
        VirtualCursor.shared.show(at: p, window: w, click: true)
        postClick(pid: pid, at: p, button: button, count: count, window: w)
    case "scroll":
        // Scroll wheel events posted to a background app carry no window and are
        // dropped by AppKit, so scroll through the scroll area's AX scroll bar (or its
        // page actions) instead: no events, nothing visible to the user.
        let (p, _) = try resolvePoint(action, pid: pid, map: map)
        let start = (action["ref"] as? String).flatMap { map.element($0) }
        guard let area = scrollArea(from: start, containing: p, pid: pid) else {
            throw ActError.message("NO_SCROLL_AREA", "no scroll area at this target")
        }
        let dir = (action["direction"] as? String) ?? "down"
        let amount = (action["amount"] as? Int) ?? 3
        return try scrollAX(area, direction: dir, lines: amount)
    case "drag":
        guard let fromSpec = action["from"] as? [String: Any], let toSpec = action["to"] as? [String: Any] else {
            throw ActError.message("BAD_ACTION", "drag needs from and to")
        }
        let (a, w) = try resolvePoint(fromSpec, pid: pid, map: map)
        let (b, _) = try resolvePoint(toSpec, pid: pid, map: map)
        VirtualCursor.shared.show(at: a, window: w, click: false)
        let t0 = nowMs()
        let steps = postDrag(pid: pid, from: a, to: b, window: w)
        VirtualCursor.shared.show(at: b, window: w, click: true)
        return ["dragSteps": steps, "dragMs": nowMs() - t0]
    default:
        throw ActError.message("BAD_ACTION", "unsupported kind \(kind)")
    }
    return [:]
}

/// Hardware input (the user's own mouse or keys) within the last `seconds`.
func userInputSince(seconds: Double) -> Bool {
    let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .rightMouseDown, .leftMouseDragged, .keyDown, .flagsChanged, .scrollWheel]
    let idle = types.map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }.min() ?? .infinity
    return idle <= seconds + 0.05
}

/// Make `pid` frontmost again after `from` activated itself. Public activation only.
func giveFrontBack(to pid: pid_t, from target: pid_t) -> Bool {
    guard let prev = NSRunningApplication(processIdentifier: pid) else { return false }
    if #available(macOS 14.0, *), let source = NSRunningApplication(processIdentifier: target) {
        _ = prev.activate(from: source, options: [])
    }
    if NSWorkspace.shared.frontmostApplication?.processIdentifier != pid { _ = prev.activate(options: []) }
    for _ in 0..<25 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid { return true }
        CFRunLoopRunInMode(.defaultMode, 0.02, true)
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier == pid
}

// ───────────────────────── virtual cursor ─────────────────────────
// Shows where the agent points without touching the real cursor: a small pointer of
// its own, drawn just above the target window (so the user's front windows still
// cover it), gliding between points and pulsing once on a click. Click-through,
// never key, never activates; it goes away a moment after the last action.

final class PointerView: NSView {
    let ring = CAShapeLayer()
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        ring.fillColor = NSColor.clear.cgColor
        ring.strokeColor = NSColor.controlAccentColor.cgColor
        ring.lineWidth = 2
        ring.opacity = 0
        let r: CGFloat = 12
        ring.path = CGPath(ellipseIn: CGRect(x: -r, y: -r, width: r * 2, height: r * 2), transform: nil)
        ring.position = CGPoint(x: 14, y: frame.height - 14)
        layer?.addSublayer(ring)
    }
    required init?(coder: NSCoder) { nil }
    override func draw(_ dirty: NSRect) {
        // the tip sits at (14, h-14) so the click ring can centre on it
        let tip = NSPoint(x: 14, y: bounds.height - 14)
        let p = NSBezierPath()
        p.move(to: tip)
        p.line(to: NSPoint(x: tip.x, y: tip.y - 17))
        p.line(to: NSPoint(x: tip.x + 4.2, y: tip.y - 13))
        p.line(to: NSPoint(x: tip.x + 7.2, y: tip.y - 19.5))
        p.line(to: NSPoint(x: tip.x + 9.8, y: tip.y - 18.3))
        p.line(to: NSPoint(x: tip.x + 6.9, y: tip.y - 11.9))
        p.line(to: NSPoint(x: tip.x + 12.2, y: tip.y - 11.9))
        p.close()
        p.lineJoinStyle = .round
        NSColor.controlAccentColor.setFill()
        p.fill()
        NSColor.white.setStroke()
        p.lineWidth = 1.5
        p.stroke()
    }
    func pulse() {
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.4; scale.toValue = 1.0
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9; fade.toValue = 0
        let g = CAAnimationGroup()
        g.animations = [scale, fade]
        g.duration = 0.35
        g.timingFunction = CAMediaTimingFunction(name: .easeOut)
        ring.add(g, forKey: "pulse")
    }
}

final class VirtualCursor {
    static let shared = VirtualCursor()
    private var panel: NSPanel?
    private var view: PointerView?
    private var hide: DispatchWorkItem?
    private let size = NSSize(width: 44, height: 44)

    func show(at point: CGPoint, window: EventWindow?, click: Bool) {
        guard let w = window, shownAsIs(w) else { return }
        DispatchQueue.main.async { self.place(point, above: w.id, click: click) }
    }

    /// On screen at its real size: not hidden, minimized or a Stage Manager thumbnail.
    private func shownAsIs(_ w: EventWindow) -> Bool {
        guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], w.id) as? [[String: Any]], let d = info.first,
              (d[kCGWindowIsOnscreen as String] as? Bool) == true,
              let b = d[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { return false }
        return nearlySame(r, w.frame, 4)
    }

    private func make() -> NSPanel {
        let p = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.ignoresMouseEvents = true
        p.isReleasedWhenClosed = false
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
        let v = PointerView(frame: NSRect(origin: .zero, size: size))
        p.contentView = v
        view = v
        return p
    }

    private func place(_ point: CGPoint, above id: CGWindowID, click: Bool) {
        let p = panel ?? make()
        panel = p
        // global top-left coordinates → AppKit's bottom-left, tip at the point
        let primary = NSScreen.screens.first?.frame.height ?? CGDisplayBounds(CGMainDisplayID()).height
        let origin = NSPoint(x: point.x - 14, y: primary - point.y - (size.height - 14))
        if p.isVisible && p.alphaValue > 0 {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                p.animator().setFrameOrigin(origin)
            }
        } else {
            p.setFrameOrigin(origin)
            p.alphaValue = 1
        }
        p.order(.above, relativeTo: Int(id))
        if click { view?.pulse() }
        hide?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let p = self?.panel else { return }
            NSAnimationContext.runAnimationGroup({ ctx in ctx.duration = 0.25; p.animator().alphaValue = 0 },
                                                 completionHandler: { if p.alphaValue == 0 { p.orderOut(nil) } })
        }
        hide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: work)
    }
}

// ───────────────────────── settle ─────────────────────────
// After an action, wait for the app's own AX notifications to go quiet instead of a
// fixed sleep: no-op actions return quickly, slow redraws are waited for (bounded).

var axNotifications = 0
var settleObserver: (pid: pid_t, observer: AXObserver)?

func observer(for pid: pid_t) -> AXObserver? {
    if let s = settleObserver, s.pid == pid { return s.observer }
    if let s = settleObserver {
        CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(s.observer), .defaultMode)
        settleObserver = nil
    }
    var obs: AXObserver?
    guard AXObserverCreate(pid, { _, _, _, _ in axNotifications += 1 }, &obs) == .success, let o = obs else { return nil }
    let app = AXUIElementCreateApplication(pid)
    for n in [kAXValueChangedNotification, kAXFocusedUIElementChangedNotification, kAXUIElementDestroyedNotification,
              kAXCreatedNotification, kAXSelectedTextChangedNotification, kAXTitleChangedNotification,
              kAXWindowCreatedNotification, kAXSelectedChildrenChangedNotification, kAXSelectedRowsChangedNotification,
              kAXRowCountChangedNotification, kAXMenuOpenedNotification, kAXLayoutChangedNotification] {
        _ = AXObserverAddNotification(o, app, n as CFString, nil)
    }
    CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(o), .defaultMode)
    settleObserver = (pid, o)
    return o
}

/// Returns how long it waited. Quiet = no notification for 30 ms (after a 30 ms
/// floor, since some changes post nothing); never longer than 600 ms.
func settle(pid: pid_t) -> Double {
    let t0 = nowMs()
    guard observer(for: pid) != nil else { usleep(60_000); return nowMs() - t0 }
    var seen = axNotifications, last = t0
    while true {
        CFRunLoopRunInMode(.defaultMode, 0.005, true)
        let now = nowMs()
        if axNotifications != seen { seen = axNotifications; last = now }
        if now - t0 >= 30 && now - last >= 30 { break }
        if now - t0 >= 600 { break }
    }
    return nowMs() - t0
}

// ───────────────────────── launch (hidden, no activation) ─────────────────────────

func appURL(_ name: String) -> URL? {
    let ws = NSWorkspace.shared
    if name.contains("/") || name.hasSuffix(".app") { return URL(fileURLWithPath: name) }
    if let u = ws.urlForApplication(withBundleIdentifier: name) { return u }
    // locate by display name
    return findAppByName(name) ?? ws.urlForApplication(toOpen: URL(fileURLWithPath: "/dev/null"))
}

func launchHidden(_ name: String, hide: Bool, completion: @escaping (pid_t?, String?) -> Void) {
    let ws = NSWorkspace.shared
    guard let appURL = appURL(name) else { completion(nil, "app not found"); return }
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = false          // never bring it to the front (keeps the user's focus)
    cfg.addsToRecentItems = false
    // Hidden: nothing on the user's screen. The AX tree and actions work on a hidden app;
    // captures and events show it for a moment (ensureDrawn), behind the user's windows.
    cfg.hides = hide
    ws.openApplication(at: appURL, configuration: cfg) { app, err in
        if let app = app { completion(app.processIdentifier, nil) }
        else { completion(nil, err?.localizedDescription ?? "launch failed") }
    }
}

/// The frontmost app's focused window and where it is.
struct HeldFrame { let window: AXUIElement; let origin: CGPoint; let size: CGSize }

func axPoint(_ el: AXUIElement, _ attr: String) -> CGPoint? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let val = v, CFGetTypeID(val) == AXValueGetTypeID() else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(val as! AXValue, .cgPoint, &p) ? p : nil
}
func axSize(_ el: AXUIElement) -> CGSize? {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &v) == .success, let val = v, CFGetTypeID(val) == AXValueGetTypeID() else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(val as! AXValue, .cgSize, &s) ? s : nil
}

func frontWindowFrame() -> HeldFrame? {
    guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
    let app = AXUIElementCreateApplication(front.processIdentifier)
    var w: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &w) == .success, let win = w, CFGetTypeID(win) == AXUIElementGetTypeID() else { return nil }
    let el = win as! AXUIElement
    guard let o = axPoint(el, kAXPositionAttribute), let s = axSize(el) else { return nil }
    return HeldFrame(window: el, origin: o, size: s)
}

/// Watch the held window for a moment after a launch; if it was moved or resized, put it back.
func keepFrame(_ h: HeldFrame) {
    let moved = { () -> Bool in
        guard let o = axPoint(h.window, kAXPositionAttribute), let s = axSize(h.window) else { return false }
        return abs(o.x - h.origin.x) > 1 || abs(o.y - h.origin.y) > 1 || abs(s.width - h.size.width) > 1 || abs(s.height - h.size.height) > 1
    }
    for _ in 0..<15 {
        usleep(100_000)
        if moved() {
            // let the arrangement finish, then restore size first (a smaller window can always move)
            usleep(250_000)
            var size = h.size, origin = h.origin
            if let sv = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(h.window, kAXSizeAttribute as CFString, sv) }
            if let pv = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(h.window, kAXPositionAttribute as CFString, pv) }
            if let sv = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(h.window, kAXSizeAttribute as CFString, sv) }
            return
        }
    }
}

func findAppByName(_ name: String) -> URL? {
    for dir in ["/System/Applications", "/Applications", "/System/Applications/Utilities"] {
        let candidate = URL(fileURLWithPath: dir).appendingPathComponent("\(name).app")
        if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
    }
    return nil
}

// ───────────────────────── background launch (off-screen display) ─────────────────────────
// The job's apps run on an off-screen display: nothing on the user's screen, nothing in
// the Dock, focus never taken. An app the user already has open is theirs and is never
// touched; this path is only for apps the job opens itself.
//
//   - One off-screen CGVirtualDisplay (Backdrop) is held for the helper's whole life.
//     Adding or removing it flickers the Dock once, so it is made once and kept.
//   - A new process is spawned suspended, assigned to that display's desktop, then
//     resumed, so its first window opens off-screen — never a flash on the real screen.
//   - It runs from a copy of the app whose Info.plist is background-only (no Dock tile).
//     The copy is shaped by the app's kind so the login keychain keeps working:
//       native   — Info.plist is a copy; everything else, the executable included, is a
//                  symlink to the real app, so the kernel validates the real signature.
//       chromium — an APFS clone with the real executable hard-linked and the real
//                  Info.plist swapped back in the instant the app checks in (a modified
//                  plist in place during a keychain read is what securityd rejects).
//       sandboxed— the clone starts with the real plist (so sandbox init validates),
//                  the background plist is swapped in once the sandbox is on, and the
//                  real plist swapped back at check-in.
//     Catalyst / iOS-on-Mac / System apps can't be copied this way: they fall back to
//     the real app, launched hidden (the earlier launchHidden path), Dock tile and all.
//   - An app that tries to make itself a Dock app and come forward (some Electron, tao)
//     is held back by ondra-bgguard.dylib, injected when the app can't enforce it away.

func dbgLog(_ m: String) {
    if ProcessInfo.processInfo.environment["ONDRA_CU_DEBUG"] != nil { FileHandle.standardError.write("cu: \(m)\n".data(using: .utf8)!) }
}

enum AppKind: String { case native, chromium, sandboxed, fallback }

func onlineDisplays() -> [CGDirectDisplayID] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 32); var n: UInt32 = 0
    CGGetOnlineDisplayList(32, &ids, &n)
    return Array(ids.prefix(Int(n)))
}

/// The off-screen display, made once and held for the helper's life.
final class Backdrop {
    static let shared = Backdrop()
    private var display: CGVirtualDisplay?
    private(set) var displayID: CGDirectDisplayID = 0
    private let conn: Int32
    private let copySpaces: (@convention(c) (Int32) -> Unmanaged<CFArray>)
    private let assignFn: (@convention(c) (Int32, pid_t, UInt64) -> Int32)

    private init() {
        let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)
        conn = unsafeBitCast(dlsym(sky, "SLSMainConnectionID"), to: (@convention(c) () -> Int32).self)()
        copySpaces = unsafeBitCast(dlsym(sky, "SLSCopyManagedDisplaySpaces"), to: (@convention(c) (Int32) -> Unmanaged<CFArray>).self)
        assignFn = unsafeBitCast(dlsym(sky, "SLSProcessAssignToSpace"), to: (@convention(c) (Int32, pid_t, UInt64) -> Int32).self)
    }

    /// Make the display if it isn't up yet. Returns false if it could not be created.
    @discardableResult func ensure() -> Bool {
        if display != nil { return true }
        let d = CGVirtualDisplayDescriptor()
        d.queue = .main; d.name = "Ondra"
        d.maxPixelsWide = 1920; d.maxPixelsHigh = 1200
        d.sizeInMillimeters = CGSize(width: 480, height: 300)
        // Each helper (one per job using the computer) holds its own display: a unique serial,
        // so a second job running at the same time doesn't fail to make one.
        d.productID = 0x4f44; d.vendorID = 0x1234; d.serialNum = UInt32(truncatingIfNeeded: getpid())
        guard let v = CGVirtualDisplay(descriptor: d) else { dbgLog("display: create failed"); return false }
        let st = CGVirtualDisplaySettings(); st.hiDPI = 0
        st.modes = [CGVirtualDisplayMode(width: 1920, height: 1200, refreshRate: 30)]
        guard v.apply(st) else { dbgLog("display: apply failed"); return false }
        // Place it off the bottom-right corner of the real displays, touching them only at a
        // corner, so the pointer can never wander onto it. Another job's display is already
        // there: go corner-to-corner past the last one.
        var corner = CGPoint(x: CGDisplayBounds(CGMainDisplayID()).maxX, y: CGDisplayBounds(CGMainDisplayID()).maxY)
        for other in onlineDisplays() where other != v.displayID && CGDisplayVendorNumber(other) == 0x1234 && CGDisplayModelNumber(other) == 0x4f44 {
            let b = CGDisplayBounds(other)
            if b.maxX > corner.x { corner = CGPoint(x: b.maxX, y: b.maxY) }
        }
        var cfg: CGDisplayConfigRef?
        CGBeginDisplayConfiguration(&cfg)
        CGConfigureDisplayOrigin(cfg, v.displayID, Int32(corner.x), Int32(corner.y))
        CGCompleteDisplayConfiguration(cfg, .forSession)
        display = v; displayID = v.displayID
        // its desktop (space) comes up a moment after the display; nothing can be put on it before
        let t0 = nowMs()
        while spaceID == 0, nowMs() - t0 < 3000 { usleep(20_000) }
        dbgLog("display \(displayID) up, space \(spaceID) after \(Int(nowMs() - t0))ms")
        return true
    }

    /// The current-space id of the off-screen display (recomputed each call: the space id
    /// changes when displays are reconfigured).
    var spaceID: UInt64 {
        guard displayID != 0, let uuidRef = CGDisplayCreateUUIDFromDisplayID(displayID)?.takeRetainedValue(),
              let uuid = CFUUIDCreateString(nil, uuidRef) as String? else { return 0 }
        for s in copySpaces(conn).takeRetainedValue() as! [[String: Any]] where (s["Display Identifier"] as? String) == uuid {
            if let c = s["Current Space"] as? [String: Any], let id = c["id64"] as? UInt64 { return id }
        }
        return 0
    }

    func assign(_ pid: pid_t, to space: UInt64) { _ = assignFn(conn, pid, space) }

    /// Is this window frame on the off-screen display?
    func contains(_ frame: CGRect) -> Bool {
        guard displayID != 0 else { return false }
        return CGDisplayBounds(displayID).intersects(frame)
    }
}

// ───────────────────────── app kind, copies, signing ─────────────────────────

func infoPlist(_ app: URL) -> [String: Any] {
    guard let d = try? Data(contentsOf: app.appendingPathComponent("Contents/Info.plist")),
          let p = try? PropertyListSerialization.propertyList(from: d, options: [], format: nil) as? [String: Any] else { return [:] }
    return p
}

func runCapturing(_ path: String, _ args: [String]) -> (out: Data, err: Data, status: Int32) {
    let p = Process(); p.executableURL = URL(fileURLWithPath: path); p.arguments = args
    let o = Pipe(), e = Pipe(); p.standardOutput = o; p.standardError = e
    // read before wait so a full pipe cannot deadlock
    do { try p.run() } catch { return (Data(), Data(), -1) }
    let od = o.fileHandleForReading.readDataToEndOfFile()
    let ed = e.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (od, ed, p.terminationStatus)
}

struct SignFacts { var hardened = false, sandbox = false, disableLibVal = false, allowDyldEnv = false }

func signFacts(_ app: URL) -> SignFacts {
    var f = SignFacts()
    let flags = runCapturing("/usr/bin/codesign", ["--display", "--verbose=2", app.path])
    // codesign prints e.g. "CodeDirectory v=… flags=0x10002(adhoc,runtime) hashes=…" to stderr;
    // the hardened runtime shows as "runtime" inside the flags=0x…( ) parenthesis.
    if let s = String(data: flags.err, encoding: .utf8), let r = s.range(of: "flags=0x") {
        let after = s[r.upperBound...]
        if let open = after.firstIndex(of: "("), let close = after[open...].firstIndex(of: ")") {
            f.hardened = after[after.index(after: open)..<close].contains("runtime")
        }
    }
    let ents = runCapturing("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", app.path])
    if let p = try? PropertyListSerialization.propertyList(from: ents.out, options: [], format: nil) as? [String: Any] {
        f.sandbox = (p["com.apple.security.app-sandbox"] as? Bool) == true
        f.disableLibVal = (p["com.apple.security.cs.disable-library-validation"] as? Bool) == true
        f.allowDyldEnv = (p["com.apple.security.cs.allow-dyld-environment-variables"] as? Bool) == true
    }
    return f
}

func hasRendererHelper(_ app: URL) -> Bool {
    let fw = app.appendingPathComponent("Contents/Frameworks")
    guard let it = FileManager.default.enumerator(at: fw, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) else { return false }
    for case let u as URL in it where u.pathExtension == "app" && u.lastPathComponent.contains("(Renderer)") { return true }
    return false
}

/// The app a template bundle (a Safari web app) runs under: the system Web App.
func templateApp(_ app: URL) -> URL? {
    guard let params = infoPlist(app)["LSTemplateApplicationParameters"] as? [String: Any],
          let bid = params["CFBundleIdentifier"] as? String,
          let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bid),
          Bundle(url: url)?.executablePath != nil else { return nil }
    return url
}

func detectKind(_ app: URL) -> AppKind {
    if app.path.hasPrefix("/System/") { return .fallback }
    let info = infoPlist(app)
    // Catalyst and iOS-on-Mac apps crash libsecinit on a swapped plist and take their type
    // from LaunchServices; they can't be background-copied.
    if info["UIDeviceFamily"] != nil || (info["LSRequiresIPhoneOS"] as? Bool) == true { return .fallback }
    // A Safari web app has no program of its own: the system Web App runs it, as a regular app
    // only (a changed copy of either bundle is refused as damaged, with an alert).
    if (info["LSTemplateApplication"] as? Bool) == true { return .fallback }
    let s = signFacts(app)
    if s.sandbox { return .sandboxed }
    if hasRendererHelper(app) { return .chromium }
    return .native
}

/// Non-hardened apps honor DYLD_INSERT_LIBRARIES; hardened apps only with both the
/// dyld-environment and library-validation exceptions. Otherwise the guard can't load.
func guardEligible(_ app: URL) -> Bool {
    let f = signFacts(app)
    return f.hardened ? (f.allowDyldEnv && f.disableLibVal) : true
}

/// The injected guard dylib: a path the app passes in, else a file next to this helper.
func guardDylibPath() -> String? {
    if let p = ProcessInfo.processInfo.environment["ONDRA_COMPUTER_HOST_GUARD"], FileManager.default.fileExists(atPath: p) { return p }
    let beside = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().appendingPathComponent("ondra-bgguard.dylib")
    return FileManager.default.fileExists(atPath: beside.path) ? beside.path : nil
}

struct Copy { let url: URL; let exe: String; let plist: String; let origPlist: String }

func cacheAppsDir() -> URL {
    let base = URL(fileURLWithPath: NSHomeDirectory())
        .appendingPathComponent("Library/Caches/dev.3xhaust.ondra/Applications", isDirectory: true)
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base
}

func setBackgroundOnly(_ plist: String) {
    guard let d = try? Data(contentsOf: URL(fileURLWithPath: plist)),
          var p = try? PropertyListSerialization.propertyList(from: d, options: [], format: nil) as? [String: Any] else { return }
    p.removeValue(forKey: "LSUIElement")
    p["LSBackgroundOnly"] = true
    if let out = try? PropertyListSerialization.data(fromPropertyList: p, format: .xml, options: 0) {
        try? out.write(to: URL(fileURLWithPath: plist))
    }
}

func buildCopy(_ app: URL, kind: AppKind) throws -> Copy {
    let fm = FileManager.default
    let copy = cacheAppsDir().appendingPathComponent(app.lastPathComponent)
    try? fm.removeItem(at: copy)
    let source = app
    let exeName = (infoPlist(source)["CFBundleExecutable"] as? String) ?? source.deletingPathExtension().lastPathComponent
    let contents = source.appendingPathComponent("Contents")
    let copyContents = copy.appendingPathComponent("Contents")
    if kind == .native {
        try fm.createDirectory(at: copyContents, withIntermediateDirectories: true)
        for entry in try fm.contentsOfDirectory(at: contents, includingPropertiesForKeys: nil, options: []) {
            if entry.lastPathComponent == "Info.plist" { continue }
            try fm.createSymbolicLink(at: copyContents.appendingPathComponent(entry.lastPathComponent), withDestinationURL: entry)
        }
        try fm.copyItem(at: contents.appendingPathComponent("Info.plist"), to: copyContents.appendingPathComponent("Info.plist"))
    } else {
        // APFS clone, then hard-link the real executable over the cloned one
        let cp = runCapturing("/bin/cp", ["-c", "-R", app.path, cacheAppsDir().path])
        if cp.status != 0 { throw ActError.message("COPY_FAILED", "could not clone the app") }
        let realExe = contents.appendingPathComponent("MacOS/\(exeName)").path
        let copyExe = copyContents.appendingPathComponent("MacOS/\(exeName)").path
        try? fm.removeItem(atPath: copyExe)
        if link(realExe, copyExe) != 0 { throw ActError.message("LINK_FAILED", "could not hard-link the executable") }
    }
    let plist = copyContents.appendingPathComponent("Info.plist").path
    let origPlist = contents.appendingPathComponent("Info.plist").path
    // native: the background plist stays (the real signature is validated via the symlink).
    // chromium: start background, swap the real one back at check-in.
    // sandboxed: start real, swap background in once sandboxed, real back at check-in.
    if kind == .native || kind == .chromium { setBackgroundOnly(plist) }
    return Copy(url: copy, exe: copyContents.appendingPathComponent("MacOS/\(exeName)").path, plist: plist, origPlist: origPlist)
}

// ───────────────────────── spawn, swap, assign ─────────────────────────

private let csLib = dlopen("/System/Library/Frameworks/CoreServices.framework/CoreServices", RTLD_NOW)
private let asnForPid = unsafeBitCast(dlsym(csLib, "_LSASNCreateWithPid"), to: (@convention(c) (CFAllocator?, pid_t) -> Unmanaged<CFTypeRef>?).self)
private let lsInfoItem = unsafeBitCast(dlsym(csLib, "_LSCopyApplicationInformationItem"), to: (@convention(c) (Int32, CFTypeRef, CFString) -> Unmanaged<CFTypeRef>?).self)
private let sbCheck = unsafeBitCast(dlsym(UnsafeMutableRawPointer(bitPattern: -2), "sandbox_check"), to: (@convention(c) (pid_t, UnsafePointer<CChar>?, Int32) -> Int32).self)

/// The app has registered with LaunchServices (its NSApplication is up): the moment it
/// is safe to swap the real Info.plist back, well before it reads the keychain.
func checkedInType(_ pid: pid_t) -> String? {
    guard let asn = asnForPid(nil, pid)?.takeRetainedValue() else { return nil }
    return lsInfoItem(-2, asn, "ApplicationType" as CFString)?.takeRetainedValue() as? String
}

/// A background app the helper is driving. Holds the copy to clean up and, for Chromium,
/// the private DevTools pipe used for text the page's own editor would otherwise drop.
final class BgApp {
    let pid: pid_t
    let realURL: URL
    let copyURL: URL
    let kind: AppKind
    let guarded: Bool
    var cdpIn: Int32 = -1
    var cdpOut: Int32 = -1
    var cdpSeq = 0
    var cdpSession: String?
    var cdpFocusEmulated = false
    var cdpBuf = Data()
    init(pid: pid_t, realURL: URL, copyURL: URL, kind: AppKind, guarded: Bool) {
        self.pid = pid; self.realURL = realURL; self.copyURL = copyURL; self.kind = kind; self.guarded = guarded
    }
}

var bgApps: [pid_t: BgApp] = [:]
let bgLock = NSLock()
func isOffscreenApp(_ pid: pid_t) -> Bool { bgLock.lock(); defer { bgLock.unlock() }; return offscreenApps.contains(pid) }
func bgApp(_ pid: pid_t) -> BgApp? { bgLock.lock(); defer { bgLock.unlock() }; return bgApps[pid] }

/// Spawn the copy suspended, assign it to the off-screen desktop, resume it, and run the
/// plist swap for its kind until it has checked in and a window is up (or a timeout).
func launchBackground(real: URL, copy: Copy, kind: AppKind, guardDylib: String?) -> BgApp? {
    let bd = Backdrop.shared
    guard bd.ensure() else { return nil }
    var env = ["HOME=\(NSHomeDirectory())", "USER=\(NSUserName())", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR=\(NSTemporaryDirectory())"]
    let guarded = guardDylib != nil
    if let g = guardDylib { env.append("DYLD_INSERT_LIBRARIES=\(g)") }

    let disclaim = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "responsibility_spawnattrs_setdisclaim").map {
        unsafeBitCast($0, to: (@convention(c) (UnsafeMutablePointer<posix_spawnattr_t?>, Int32) -> Int32).self)
    }
    var attr: posix_spawnattr_t?; posix_spawnattr_init(&attr)
    posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_START_SUSPENDED))
    _ = disclaim?(&attr, 1)
    let dbg = ProcessInfo.processInfo.environment["ONDRA_CU_DEBUG"] != nil
    let appErr = dbg ? NSTemporaryDirectory() + "cu-app.err" : "/dev/null"
    var fa: posix_spawn_file_actions_t?; posix_spawn_file_actions_init(&fa)
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_addopen(&fa, 1, appErr, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    posix_spawn_file_actions_adddup2(&fa, 1, 2)

    // Chromium apps get a private DevTools pipe (fd 3 in, fd 4 out) for text the page drops.
    var toApp: [Int32] = [-1, -1], fromApp: [Int32] = [-1, -1]
    var argv: [UnsafeMutablePointer<CChar>?] = [strdup(copy.exe)]
    if kind == .chromium {
        pipe(&toApp); pipe(&fromApp)
        posix_spawn_file_actions_adddup2(&fa, toApp[0], 3)
        posix_spawn_file_actions_adddup2(&fa, fromApp[1], 4)
        argv.append(strdup("--remote-debugging-pipe"))
    }
    argv.append(nil)
    let envp: [UnsafeMutablePointer<CChar>?] = env.map { strdup($0) } + [nil]

    // sandboxed: begin with the real plist; stage both the background plist and a fresh
    // copy of the real one to swap at the right moments.
    let bgStage = copy.plist + ".bg", origStage = copy.plist + ".orig"
    let reverseSwap = kind == .sandboxed
    if reverseSwap {
        unlink(bgStage); try? FileManager.default.copyItem(atPath: copy.plist, toPath: bgStage); setBackgroundOnly(bgStage)
    }
    if kind != .native {
        unlink(origStage); try? FileManager.default.copyItem(atPath: copy.origPlist, toPath: origStage)
    }

    var pid: pid_t = 0
    let rc = posix_spawn(&pid, copy.exe, &fa, &attr, argv, envp)
    posix_spawn_file_actions_destroy(&fa); posix_spawnattr_destroy(&attr)
    if kind == .chromium { close(toApp[0]); close(fromApp[1]) }
    if dbg { FileHandle.standardError.write("cu: spawn rc=\(rc) pid=\(pid) exe=\(copy.exe)\n".data(using: .utf8)!) }
    guard rc == 0, pid > 0 else {
        if kind == .chromium { close(toApp[1]); close(fromApp[0]) }
        return nil
    }
    let space = bd.spaceID
    bd.assign(pid, to: space)
    kill(pid, SIGCONT)

    let t0 = nowMs(); var swappedIn = !reverseSwap; var restored = kind == .native
    var checkinMs = 0.0
    while nowMs() - t0 < 8000 {
        if !swappedIn, sbCheck(pid, nil, 0) != 0 {
            kill(pid, SIGSTOP); _ = rename(bgStage, copy.plist); kill(pid, SIGCONT); swappedIn = true; dbgLog("swap: background plist in after \(Int(nowMs() - t0))ms")
        }
        if swappedIn, !restored, checkedInType(pid) != nil {
            kill(pid, SIGSTOP); _ = rename(origStage, copy.plist); kill(pid, SIGCONT); restored = true; checkinMs = nowMs() - t0; dbgLog("swap: checked in after \(Int(checkinMs))ms, real plist back")
        }
        var st: Int32 = 0
        if waitpid(pid, &st, WNOHANG) == pid {
            if dbg { FileHandle.standardError.write("cu: app exited early after \(Int(nowMs()-t0))ms exit=\((st>>8)&0xff) sig=\(st&0x7f) swappedIn=\(swappedIn) restored=\(restored)\n".data(using: .utf8)!) }
            if !restored, kind != .native { _ = rename(origStage, copy.plist) }
            if kind == .chromium { close(toApp[1]); close(fromApp[0]) }
            return nil
        }
        bd.assign(pid, to: space)
        // give it a moment after check-in for its first window to open on the off-screen desktop
        if restored, onScreenWindows(pid) > 0, nowMs() - t0 - checkinMs > 400 { break }
        usleep(restored ? 20_000 : (swappedIn ? 200 : 20))
    }
    if !restored, kind != .native { _ = rename(origStage, copy.plist) }

    let app = BgApp(pid: pid, realURL: real, copyURL: copy.url, kind: kind, guarded: guarded)
    if kind == .chromium { app.cdpIn = toApp[1]; app.cdpOut = fromApp[0]; _ = fcntl(app.cdpOut, F_SETFL, O_NONBLOCK) }
    bgLock.lock(); bgApps[pid] = app; bgLock.unlock()
    return app
}

// ───────────────────────── private DevTools pipe (Chromium text input) ─────────────────────────
// The off-screen window is never key, so its page is unfocused and editors like Slate drop
// key events, and the user's input method can leave half-composed text. Committed text and
// Return go straight to the page over the private pipe instead.

func cdpSend(_ app: BgApp, _ method: String, _ params: [String: Any], session: Bool = true) -> [String: Any]? {
    guard app.cdpIn >= 0 else { return nil }
    app.cdpSeq += 1
    let id = app.cdpSeq
    var msg: [String: Any] = ["id": id, "method": method, "params": params]
    if session, let s = app.cdpSession { msg["sessionId"] = s }
    guard var data = try? JSONSerialization.data(withJSONObject: msg) else { return nil }
    data.append(0)
    _ = data.withUnsafeBytes { write(app.cdpIn, $0.baseAddress, data.count) }
    // read NUL-delimited replies until the matching id (skipping events), with a deadline
    let deadline = nowMs() + 3000
    var tmp = [UInt8](repeating: 0, count: 65536)
    while nowMs() < deadline {
        let n = read(app.cdpOut, &tmp, tmp.count)
        if n > 0 {
            app.cdpBuf.append(contentsOf: tmp[0..<n])
            while let i = app.cdpBuf.firstIndex(of: 0) {
                let chunk = app.cdpBuf[app.cdpBuf.startIndex..<i]
                app.cdpBuf.removeSubrange(app.cdpBuf.startIndex...i)
                if let obj = (try? JSONSerialization.jsonObject(with: chunk)) as? [String: Any], (obj["id"] as? Int) == id {
                    return obj
                }
            }
        } else { usleep(2000) }
    }
    return nil
}

/// Attach to the app's page and turn on focus emulation, once.
func cdpEnsureAttached(_ app: BgApp) -> Bool {
    if app.cdpSession != nil { return true }
    guard let targets = cdpSend(app, "Target.getTargets", [:], session: false),
          let result = targets["result"] as? [String: Any],
          let infos = result["targetInfos"] as? [[String: Any]] else { return false }
    guard let page = infos.first(where: { ($0["type"] as? String) == "page" }),
          let tid = page["targetId"] as? String else { return false }
    guard let att = cdpSend(app, "Target.attachToTarget", ["targetId": tid, "flatten": true], session: false),
          let ar = att["result"] as? [String: Any], let sid = ar["sessionId"] as? String else { return false }
    app.cdpSession = sid
    _ = cdpSend(app, "Emulation.setFocusEmulationEnabled", ["enabled": true])
    app.cdpFocusEmulated = true
    return true
}

/// Commit text into whatever the page has focused (the model clicked the field first).
func cdpInsertText(_ app: BgApp, _ text: String) -> Bool {
    guard cdpEnsureAttached(app) else { return false }
    return cdpSend(app, "Input.insertText", ["text": text]) != nil
}

func cdpEnter(_ app: BgApp) -> Bool {
    guard cdpEnsureAttached(app) else { return false }
    let down: [String: Any] = ["type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 36, "text": "\r"]
    let up: [String: Any] = ["type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 36]
    return cdpSend(app, "Input.dispatchKeyEvent", down) != nil && cdpSend(app, "Input.dispatchKeyEvent", up) != nil
}

// ───────────────────────── cleanup ─────────────────────────

/// Unregister a copy and its nested helper .app bundles from LaunchServices, then delete it.
func teardownCopy(_ copy: URL) {
    let lsregister = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
    var bundles = [copy]
    if let it = FileManager.default.enumerator(at: copy, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles]) {
        for case let u as URL in it where u.pathExtension == "app" { bundles.append(u) }
    }
    for b in bundles { _ = runCapturing(lsregister, ["-u", b.path]) }
    try? FileManager.default.removeItem(at: copy)
}

/// Terminate a background app the job opened, and clean up its copy.
func releaseBackground(_ pid: pid_t) {
    bgLock.lock(); let app = bgApps.removeValue(forKey: pid); bgLock.unlock()
    guard let app = app else { return }
    if app.cdpIn >= 0 { close(app.cdpIn) }; if app.cdpOut >= 0 { close(app.cdpOut) }
    if kill(pid, 0) == 0 {
        kill(pid, SIGTERM)
        var st: Int32 = 0
        for _ in 0..<30 { if waitpid(pid, &st, WNOHANG) == pid || kill(pid, 0) != 0 { break }; usleep(100_000) }
        if kill(pid, 0) == 0 { kill(pid, SIGKILL); waitpid(pid, &st, 0) }  // reap so no zombie lingers
    }
    teardownCopy(app.copyURL)
}

func releaseAllBackground() {
    bgLock.lock(); let pids = Array(bgApps.keys); let shown = Array(offscreenApps); offscreenApps.removeAll(); bgLock.unlock()
    for pid in pids { releaseBackground(pid) }
    // a real app shown on the off-screen display goes back to hidden before the display goes away
    for pid in shown { NSRunningApplication(processIdentifier: pid)?.hide() }
}

// ───────────────────────── real app, off-screen ─────────────────────────
// Apps that can't run from a background copy (Safari web apps, Catalyst, App Store, system
// apps) run as the real app: a regular app, so its Dock tile shows it running. It is still kept
// off the user's screen: launched hidden, caught the moment its process exists and put on the
// off-screen desktop before its first window, then shown there, so its windows are drawn at
// full size (not a Stage Manager thumbnail) and pointer and key events reach them.

/// real apps the job showed on the off-screen display (hidden again on release)
var offscreenApps: Set<pid_t> = []

func allPids() -> [pid_t] {
    let n = proc_listallpids(nil, 0)
    var buf = [pid_t](repeating: 0, count: Int(max(0, n)) + 128)
    let got = proc_listallpids(&buf, Int32(buf.count * MemoryLayout<pid_t>.size))
    return Array(buf.prefix(Int(max(0, got))))
}

func pidPath(_ pid: pid_t) -> String? {
    var b = [CChar](repeating: 0, count: 4096)
    return proc_pidpath(pid, &b, UInt32(b.count)) > 0 ? String(cString: b) : nil
}

/// The arguments a process was started with (KERN_PROCARGS2).
func processArgs(_ pid: pid_t) -> [String] {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4 else { return [] }
    var buf = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0 else { return [] }
    let argc = Int(buf.withUnsafeBytes { $0.load(as: Int32.self) })
    var i = 4
    while i < size, buf[i] != 0 { i += 1 }        // the executable path
    while i < size, buf[i] == 0 { i += 1 }        // padding
    var args: [String] = []
    while args.count < argc, i < size {
        let start = i
        while i < size, buf[i] != 0 { i += 1 }
        args.append(String(decoding: buf[start..<i], as: UTF8.self)); i += 1
    }
    return args
}

/// The program an app runs as: its own executable, or the system Web App for a Safari web app.
func runningExecutable(_ app: URL) -> String? {
    let exe = (infoPlist(app)["LSTemplateApplication"] as? Bool) == true
        ? templateApp(app).flatMap { Bundle(url: $0)?.executablePath }
        : Bundle(url: app)?.executablePath
    return exe.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path }
}

/// Watches for the process LaunchServices starts for `exe` and, the moment it exists, stops it,
/// assigns it to the off-screen desktop and lets it go on; keeps it there while it starts.
final class LaunchCatcher {
    private let lock = NSLock()
    private var _caught: pid_t = 0
    private var stopped = false
    var caught: pid_t { lock.lock(); defer { lock.unlock() }; return _caught }

    init(exe: String, mentioning: String?, space: UInt64) {
        let known = Set(allPids())
        Thread.detachNewThread { [self] in
            var seen = known
            let t0 = nowMs()
            while nowMs() - t0 < 8000 {
                lock.lock(); let stop = stopped; lock.unlock()
                if stop { return }
                for p in allPids() where !seen.contains(p) {
                    // launchd forks, then xpcproxy, then the app's program replaces it (same pid):
                    // keep looking at a pid until it is something else
                    guard let path = pidPath(p) else { continue }
                    if path == "/sbin/launchd" || path == "/usr/libexec/xpcproxy" { continue }
                    seen.insert(p)
                    guard URL(fileURLWithPath: path).resolvingSymlinksInPath().path == exe else { continue }
                    if let m = mentioning, !processArgs(p).contains(m) { continue }
                    kill(p, SIGSTOP); Backdrop.shared.assign(p, to: space); kill(p, SIGCONT)
                    lock.lock(); _caught = p; lock.unlock()
                    dbgLog("catcher: \(p) after \(Int(nowMs() - t0))ms, space \(space), windows \(layer0Windows(p).count)")
                    // keep it there while it starts (its first windows)
                    let c0 = nowMs()
                    while nowMs() - c0 < 3000, kill(p, 0) == 0 {
                        Backdrop.shared.assign(p, to: space)
                        if nowMs() - c0 > 600, layer0Windows(p).count > 0 { break }
                        usleep(20_000)
                    }
                    return
                }
                usleep(300)
            }
        }
    }
    func stop() { lock.lock(); stopped = true; lock.unlock() }
}

/// The app's normal windows (hidden ones too) and where they are.
func layer0Windows(_ pid: pid_t) -> [CGRect] {
    ((CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []).compactMap { w in
        guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, (w[kCGWindowLayer as String] as? Int) == 0,
              let b = w[kCGWindowBounds as String] as? [String: CGFloat], let wd = b["Width"], let ht = b["Height"],
              wd > 1, ht > 1 else { return nil }
        return CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: wd, height: ht)
    }
}

/// Show a hidden real app the catcher put off-screen, only once every window of it is there.
func showOffscreen(_ pid: pid_t) -> Bool {
    // its windows open where it last left them and move to the off-screen desktop a moment later
    let t0 = nowMs()
    var wins = layer0Windows(pid)
    while wins.isEmpty || !wins.allSatisfy({ Backdrop.shared.contains($0) }), nowMs() - t0 < 3000 {
        usleep(50_000); wins = layer0Windows(pid)
    }
    dbgLog("offscreen check \(pid) after \(Int(nowMs() - t0))ms: \(wins)")
    guard !wins.isEmpty, wins.allSatisfy({ Backdrop.shared.contains($0) }),
          let app = NSRunningApplication(processIdentifier: pid) else { return false }
    app.unhide()
    bgLock.lock(); offscreenApps.insert(pid); bgLock.unlock()
    return true
}

/// A window the user's own app left on the off-screen display (apps remember their frame):
/// move it back onto the main display so the user can see it. Never touches a background app
/// the job is running.
func rescueStrayWindows() {
    let main = CGDisplayBounds(CGMainDisplayID())
    let infos = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
    var seen = Set<pid_t>()
    for w in infos {
        guard (w[kCGWindowLayer as String] as? Int) == 0,
              let owner = w[kCGWindowOwnerPID as String] as? pid_t, !seen.contains(owner),
              bgApp(owner) == nil, !isOffscreenApp(owner),
              let b = w[kCGWindowBounds as String] as? [String: CGFloat],
              let x = b["X"], let y = b["Y"], let wd = b["Width"], let ht = b["Height"] else { continue }
        let frame = CGRect(x: x, y: y, width: wd, height: ht)
        guard Backdrop.shared.contains(frame) else { continue }
        seen.insert(owner)
        let appEl = AXUIElementCreateApplication(owner)
        var winsRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appEl, kAXWindowsAttribute as CFString, &winsRef) == .success,
              let wins = winsRef as? [AXUIElement] else { continue }
        for win in wins {
            guard let f = axFrame(win), Backdrop.shared.contains(f) else { continue }
            var origin = CGPoint(x: main.midX - f.width / 2, y: main.midY - f.height / 2)
            if let pv = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, pv) }
        }
    }
}

// ───────────────────────── out of sight ─────────────────────────
// An app the job opens is launched hidden: no window on the user's screen, no Stage Manager
// switch, nothing in its strip. Accessibility reads and acts on a hidden app all the same. Only
// what needs the window drawn shows it, without activating it: a capture (`look`) and pointer or
// key events. It is hidden again right after, and stays hidden when the job is done; the user
// brings it up from the Dock or ⌘Tab, which shows it as usual.

/// apps shown for a capture or events, to hide again after
var shownFor: Set<pid_t> = []
let shownLock = NSLock()

func onScreenWindows(_ pid: pid_t) -> Int {
    ((CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? [])
        .filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }.count
}

/// Draw a hidden app's windows (behind the user's, never activated) for what needs them drawn.
func ensureDrawn(_ pid: pid_t) {
    guard let app = NSRunningApplication(processIdentifier: pid), app.isHidden else { return }
    shownLock.lock(); shownFor.insert(pid); shownLock.unlock()
    app.unhide()
    for _ in 0..<40 where onScreenWindows(pid) == 0 { usleep(25_000) }
    usleep(120_000) // its first frame
}

/// Hide again what ensureDrawn showed (not an app the user brought up meanwhile: that one is theirs).
func hideAgain(_ pid: pid_t) {
    shownLock.lock(); let was = shownFor.remove(pid) != nil; shownLock.unlock()
    guard was, let app = NSRunningApplication(processIdentifier: pid), !app.isActive else { return }
    app.hide()
}

func hideAllAgain() {
    shownLock.lock(); let pids = shownFor; shownLock.unlock()
    for pid in pids { hideAgain(pid) }
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
        guard let target = appURL(name) else { return fail(id, "LAUNCH_FAILED", "app not found") }
        // an app the user already has open is theirs; we never make a second background copy of it
        let running = Set(NSWorkspace.shared.runningApplications.compactMap { $0.bundleURL?.standardizedFileURL })
        let alreadyOpen = running.contains(target.standardizedFileURL)
        // Stage Manager makes room for a window that opens behind: the user's own front window
        // is pushed aside and shrunk. Its frame is noted now and put back once the launch settles.
        let held = frontWindowFrame()
        let t0 = nowMs()
        var pid: pid_t?
        var mode = "hidden"
        var launchErr: String?
        // Off-screen background copy: no Dock tile, no window on the user's screen, keychain kept.
        // Catalyst/iOS/System apps, and an app the user already runs, fall back to the real app.
        let kind = alreadyOpen ? AppKind.fallback : detectKind(target)
        if kind != .fallback {
            do {
                let copy = try buildCopy(target, kind: kind)
                let guardPath = kind != .sandboxed && guardEligible(target) ? guardDylibPath() : nil
                if let app = launchBackground(real: target, copy: copy, kind: kind, guardDylib: guardPath) {
                    pid = app.pid; mode = "background:\(kind.rawValue)\(guardPath != nil ? "+guard" : "")"
                } else {
                    teardownCopy(copy.url); launchErr = "background launch failed"
                }
            } catch ActError.message(_, let m) { launchErr = m } catch { launchErr = "\(error)" }
        }
        if pid == nil {
            // the real app, hidden and never activated (its Dock tile may show)
            let hide = !alreadyOpen && ((req["hide"] as? Bool) ?? true)
            // catch its process as it starts and put it on the off-screen desktop
            var catcher: LaunchCatcher?
            if hide, Backdrop.shared.ensure(), let exe = runningExecutable(target) {
                let web = (infoPlist(target)["LSTemplateApplication"] as? Bool) == true
                catcher = LaunchCatcher(exe: exe, mentioning: web ? target.path : nil, space: Backdrop.shared.spaceID)
            }
            let sem = DispatchSemaphore(value: 0)
            var out: (pid_t?, String?) = (nil, nil)
            launchHidden(name, hide: hide) { p, e in out = (p, e); sem.signal() }
            sem.wait()
            pid = out.0; launchErr = out.1 ?? launchErr
            mode = alreadyOpen ? "attached" : "hidden"
            if let c = catcher {
                for _ in 0..<40 where c.caught == 0 { usleep(25_000) }
                c.stop()
                // its windows opened off-screen: show them there (full size, never on the user's screen)
                if let p = pid, c.caught == p, showOffscreen(p) { mode = "offscreen" }
            }
        }
        if let held = held { keepFrame(held) }
        // an app the user opened themselves may have come up off-screen (apps remember their
        // frame): put any such window back where the user can see it
        rescueStrayWindows()
        let after = environment()
        if let pid = pid {
            let preserved = backgroundPreserved(before, after)
            // the user's own mouse or keys while the app was starting are theirs, not the launch's
            var result: [String: Any] = ["pid": Int(pid), "mode": mode, "kind": kind.rawValue, "env": after, "envBefore": before, "backgroundPreserved": preserved]
            if mode == "hidden", let e = launchErr { result["backgroundError"] = e }
            if !preserved, userInputSince(seconds: (nowMs() - t0) / 1000) { result["userInput"] = true }
            return ok(id, result)
        }
        return fail(id, "LAUNCH_FAILED", launchErr ?? "launch failed")
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
        ensureDrawn(pid_t(pidN))
        captureKeyWindowPNG(pid: pid_t(pidN)) { p, m in png = p; meta = m; sem.signal() }
        sem.wait()
        hideAgain(pid_t(pidN))
        guard let data = png, let m = meta else { return fail(id, "CAPTURE_FAILED", "window capture failed (Screen Recording permission?)") }
        if let f = m["frame"] as? [String: Double], let wid = m["windowID"] as? Int, let w = m["width"] as? Int, let h = m["height"] as? Int {
            lastLook[pid_t(pidN)] = LookFrame(frame: CGRect(x: f["x"]!, y: f["y"]!, width: f["width"]!, height: f["height"]!),
                                              windowID: CGWindowID(wid), width: w, height: h)
        }
        return ok(id, ["image": ["mimeType": "image/png", "data": data.base64EncodedString(),
                                 "width": m["width"] ?? 0, "height": m["height"] ?? 0],
                       "frame": m["frame"] ?? NSNull(), "matchedTree": m["matchedTree"] ?? false,
                       "staged": m["staged"] ?? false,
                       "env": environment()])
    case "act":
        guard let pidN = req["pid"] as? Int, let action = req["action"] as? [String: Any] else {
            return fail(id, "BAD_REQUEST", "missing pid or action")
        }
        let t0 = nowMs()
        _ = observer(for: pid_t(pidN)) // register before acting so no notification is missed
        CFRunLoopRunInMode(.defaultMode, 0, true)
        axNotifications = 0
        var info: [String: Any] = [:]
        do { info = try performAction(pid: pid_t(pidN), action: action, map: map) }
        catch ActError.message(let code, let msg) { return fail(id, code, msg) }
        catch { return fail(id, "ACT_FAILED", "\(error)") }
        // settle on the app's own notifications, then re-observe in the same round trip
        let settleMs = settle(pid: pid_t(pidN))

        let actMs = nowMs() - t0
        let tree = observeTree(pid: pid_t(pidN), map: map)
        hideAgain(pid_t(pidN))
        var after = environment()
        var extra: [String: Any] = [:]
        // Some apps bring themselves forward when clicked. Hand the front back to what
        // the user had, right away, instead of failing an action that already happened.
        if let was = before["frontmostPid"] as? Int, was != pidN, (after["frontmostPid"] as? Int) == pidN,
           !userInputSince(seconds: (nowMs() - t0) / 1000) {
            extra["selfActivated"] = true
            extra["restored"] = giveFrontBack(to: pid_t(was), from: pid_t(pidN))
            after = environment()
        }
        // The user's own mouse or keys during the action are theirs, not a broken contract.
        if !backgroundPreserved(before, after), userInputSince(seconds: (nowMs() - t0) / 1000) { extra["userInput"] = true }
        var result: [String: Any] = ["actionMs": actMs, "settleMs": settleMs, "env": after, "envBefore": before,
                                      "backgroundPreserved": backgroundPreserved(before, after)]
        for (k, v) in extra { result[k] = v }
        for (k, v) in info { result[k] = v }
        if let tree = tree { result["tree"] = tree } else { result["treeError"] = "NO_WINDOW" }
        return ok(id, result)
    case "release":
        guard let pidN = req["pid"] as? Int else { return fail(id, "BAD_REQUEST", "missing pid") }
        // a background copy the job opened is terminated and cleaned up; a hidden fallback is hidden again
        if bgApp(pid_t(pidN)) != nil { releaseBackground(pid_t(pidN)) }
        else if isOffscreenApp(pid_t(pidN)) {
            bgLock.lock(); offscreenApps.remove(pid_t(pidN)); bgLock.unlock()
            NSRunningApplication(processIdentifier: pid_t(pidN))?.hide()
        } else { hideAgain(pid_t(pidN)) }
        rescueStrayWindows()
        return ok(id, ["released": true, "env": environment()])
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
    // Compare the key window by id when both snapshots have one; titles can animate.
    let keySame = a["frontmostWindowId"] != nil && b["frontmostWindowId"] != nil
        ? s(a, "frontmostWindowId") == s(b, "frontmostWindowId")
        : s(a, "frontmostKeyWindow") == s(b, "frontmostKeyWindow")
    let ma = a["mouse"] as? [String: Double] ?? [:], mb = b["mouse"] as? [String: Double] ?? [:]
    let mouseSame = (ma["x"] ?? 0) == (mb["x"] ?? -1) && (ma["y"] ?? 0) == (mb["y"] ?? -1)
    return frontSame && keySame && mouseSame
}

// ───────────────────────── main loop ─────────────────────────

if CommandLine.arguments.contains("--version") {
    print("ondra-cuhost 0.4.1")
    exit(0)
}

setbuf(stdout, nil)
// Bound every AX call, so a hung target app cannot hang the helper (global timeout).
AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.5)
// Requests run on their own thread; the main thread only draws the virtual cursor.
let worker = Thread {
    while let line = readLine(strippingNewline: true) {
        if line.isEmpty { continue }
        guard let data = line.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            emit(fail(nil, "BAD_JSON", "could not parse request"))
            continue
        }
        emit(handle(obj))
    }
    releaseAllBackground()
    hideAllAgain()
    exit(0)
}
worker.stackSize = 8 << 20
worker.start()
// Stopped: an app shown for a capture or events goes back out of sight first.
signal(SIGTERM, SIG_IGN)
let onTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
onTerm.setEventHandler { releaseAllBackground(); hideAllAgain(); exit(0) }
onTerm.resume()
// No Dock icon, no menu bar, never activated: windows only for the pointer overlay.
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
