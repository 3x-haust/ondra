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
//   - launches apps without activation and parks their windows in a screen corner, out of the
//     user's sight (still drawn, so the tree, events and captures work); they go back on release;
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
//   {"op":"launch","app":"TextEdit"}        → launch hidden, no activation
//   {"op":"observe","pid":123,"full":bool}  → compact AX tree (full) or diff
//   {"op":"look","pid":123}                 → window-only PNG (base64) of the key window,
//                                             plus its frame; coordinates are image pixels
//   {"op":"act","pid":123,"action":{…}}     → one action, settle, then re-observe
//   {"op":"release","pid":123}              → put the app's parked windows back where they were
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
    throw ActError.message("SCROLL_UNAVAILABLE", "this scroll area exposes no settable scroll bar or page action")
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

// ───────────────────────── parking ─────────────────────────
// The job's app never shows over the user's work: once its windows open they are moved to a
// screen corner with a single point left on screen (the way tiling window managers keep other
// workspaces' windows: a window wholly off every screen may be moved back or stop being drawn).
// They are still drawn, so accessibility, pid-addressed events and window capture work as
// before. Where each window was is kept: they go back when the job is done with the app (release,
// the helper ending) or when the user brings the app forward themselves.

struct Parked { let window: AXUIElement; let origin: CGPoint }
var parked: [pid_t: [Parked]] = [:]
let parkLock = NSLock()
/// set while an action runs: the app coming forward then is the action's doing, not the user's
var acting = false

func axWindows(_ pid: pid_t) -> [AXUIElement] {
    var v: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &v) == .success,
          let list = v as? [AXUIElement] else { return [] }
    return list
}

/// Screens in accessibility coordinates (top-left origin, y down).
func axScreens() -> [CGRect] {
    let top = NSScreen.screens.first?.frame.maxY ?? 0
    return NSScreen.screens.map { CGRect(x: $0.frame.minX, y: top - $0.frame.maxY, width: $0.frame.width, height: $0.frame.height) }
}

/// Where a window of this size goes: a screen's bottom-right (else bottom-left) corner with one
/// point on that screen, and none of it on another screen.
func parkSpot(_ size: CGSize, screens: [CGRect] = axScreens()) -> CGPoint? {
    for s in screens {
        for o in [CGPoint(x: s.maxX - 1, y: s.maxY - 1), CGPoint(x: s.minX - size.width + 1, y: s.maxY - 1)] {
            let r = CGRect(origin: o, size: size)
            if !screens.contains(where: { $0 != s && $0.intersects(r) }) { return o }
        }
    }
    return nil
}

/// Move the app's windows out of sight. Already parked ones that came back are moved again.
func park(_ pid: pid_t) {
    parkLock.lock(); defer { parkLock.unlock() }
    var list = parked[pid] ?? []
    for w in axWindows(pid) {
        let role = axString(w, kAXRoleAttribute), sub = axString(w, kAXSubroleAttribute)
        guard role == (kAXWindowRole as String), sub == nil || sub == (kAXStandardWindowSubrole as String) || sub == (kAXDialogSubrole as String) else { continue }
        guard let at = axPoint(w, kAXPositionAttribute), let size = axSize(w), var spot = parkSpot(size) else { continue }
        if abs(at.x - spot.x) < 1, abs(at.y - spot.y) < 1 { continue }
        if !list.contains(where: { CFEqual($0.window, w) }) { list.append(Parked(window: w, origin: at)) }
        if let v = AXValueCreate(.cgPoint, &spot) { AXUIElementSetAttributeValue(w, kAXPositionAttribute as CFString, v) }
    }
    parked[pid] = list
}

/// Put the app's windows back where they were.
func unpark(_ pid: pid_t) {
    parkLock.lock(); defer { parkLock.unlock() }
    for p in parked[pid] ?? [] {
        var o = p.origin
        if let v = AXValueCreate(.cgPoint, &o) { AXUIElementSetAttributeValue(p.window, kAXPositionAttribute as CFString, v) }
    }
    parked[pid] = nil
}

func unparkAll() {
    parkLock.lock(); let pids = Array(parked.keys); parkLock.unlock()
    for pid in pids { unpark(pid) }
}

/// Park the app as soon as its first window is there (a launch shows it a moment later).
func parkWhenShown(_ pid: pid_t) {
    for _ in 0..<40 {
        if !axWindows(pid).isEmpty { break }
        usleep(75_000)
    }
    park(pid)
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
        // Stage Manager makes room for a window that opens behind: the user's own front window
        // is pushed aside and shrunk. Its frame is noted now and put back once the launch settles.
        let held = frontWindowFrame()
        // an app the user already has open is theirs to look at: only one this launch opens is parked
        let running = Set(NSWorkspace.shared.runningApplications.map { $0.processIdentifier })
        let sem = DispatchSemaphore(value: 0)
        var out: (pid_t?, String?) = (nil, nil)
        launchHidden(name, hide: hide) { pid, err in out = (pid, err); sem.signal() }
        sem.wait()
        if let pid = out.0, !running.contains(pid), (req["park"] as? Bool) ?? true { parkWhenShown(pid) }
        if let held = held { keepFrame(held) }
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
        acting = true
        defer { acting = false }
        do { info = try performAction(pid: pid_t(pidN), action: action, map: map) }
        catch ActError.message(let code, let msg) { return fail(id, code, msg) }
        catch { return fail(id, "ACT_FAILED", "\(error)") }
        // settle on the app's own notifications, then re-observe in the same round trip
        let settleMs = settle(pid: pid_t(pidN))
        // a window the action opened (a dialog, a second window) goes out of sight too
        let wasParked: Bool = { parkLock.lock(); defer { parkLock.unlock() }; return parked[pid_t(pidN)] != nil }()
        if wasParked { park(pid_t(pidN)) }
        let actMs = nowMs() - t0
        let tree = observeTree(pid: pid_t(pidN), map: map)
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
        unpark(pid_t(pidN))
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
    print("ondra-cuhost 0.3.0")
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
    unparkAll()
    exit(0)
}
worker.stackSize = 8 << 20
worker.start()
// Stopped (the job is done with the app): its windows go back where they were first.
signal(SIGTERM, SIG_IGN)
let onTerm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
onTerm.setEventHandler { unparkAll(); exit(0) }
onTerm.resume()
// The user bringing a parked app forward (its Dock icon, ⌘Tab) wants to see it: it comes back.
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { note in
    guard !acting, let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    let pid = app.processIdentifier
    let isParked: Bool = { parkLock.lock(); defer { parkLock.unlock() }; return parked[pid] != nil }()
    if isParked, userInputSince(seconds: 2) { DispatchQueue.global().async { unpark(pid) } }
}
// No Dock icon, no menu bar, never activated: windows only for the pointer overlay.
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
