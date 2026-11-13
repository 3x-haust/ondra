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
// foreground. It never activates an app and then suppresses or forges focus events.
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
        if let s = v as? String { if !s.isEmpty { node["value"] = s.count > 6000 ? String(s.prefix(6000)) : s } }
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

/// Chromium and Electron build their web content's accessibility only once an assistive app
/// asks for it; AXManualAccessibility is their own switch for that (no other effect). Once per pid.
var webAXAsked = Set<pid_t>()
func askForWebAccessibility(_ pid: pid_t) {
    guard !webAXAsked.contains(pid) else { return }
    webAXAsked.insert(pid)
    guard let url = NSRunningApplication(processIdentifier: pid)?.bundleURL, hasRendererHelper(url) else { return }
    let app = AXUIElementCreateApplication(pid)
    // Electron's switch; Chrome-family browsers listen to the one screen readers set
    let electron = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue) == .success
    if !electron { _ = AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue) }
    usleep(200_000) // the first build of the tree
}

func observeTree(pid: pid_t, map: AXMap) -> [String: Any]? {
    askForWebAccessibility(pid)
    guard let window = keyWindowElement(forPid: pid) else { return nil }
    func build() -> [String: Any]? {
        map.clear()
        var count = 0
        let a = readAttrs(window)
        let clip = a.frame ?? CGRect(x: -1e6, y: -1e6, width: 2e6, height: 2e6)
        return elementNode(window, key: "w", map: map, depth: 0, maxDepth: 60, clip: clip, count: &count, limit: 4000, pre: a)
    }
    var tree = build()
    // A web view (WebKit, Electron) fills in its page only after the first request reaches its
    // content process: a large container with nothing in it is asked again, a few times at most.
    // (a pane that stays empty, like a canvas, costs this wait only for the first few reads)
    while emptyPaneWaits[pid, default: 0] < 8, tree.map({ hasEmptyPane($0, map) }) == true {
        emptyPaneWaits[pid, default: 0] += 1
        // still empty after a wait: WebKit builds a page's tree once an assistive app says it is
        // there, which is what this attribute (set by screen readers) does
        if emptyPaneWaits[pid] == 2 {
            _ = AXUIElementSetAttributeValue(AXUIElementCreateApplication(pid), "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        }
        usleep(150_000)
        tree = build()
    }
    return tree
}

var emptyPaneWaits: [pid_t: Int] = [:]

/// A big group or scroll area with no children at all: a page that has not been read yet.
func hasEmptyPane(_ node: [String: Any], _ map: AXMap) -> Bool {
    let role = node["role"] as? String ?? ""
    let kids = node["children"] as? [[String: Any]] ?? []
    if kids.isEmpty, ["AXGroup", "AXScrollArea", "AXWebArea"].contains(role), node["offscreen"] == nil,
       let id = node["id"] as? String, let el = map.element(id), let f = axFrame(el), f.width >= 200, f.height >= 150 { return true }
    return kids.contains { hasEmptyPane($0, map) }
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

/// A window's current bounds by its number (public CGWindowList; no Screen Recording needed).
func cgWindowBounds(_ wid: CGWindowID) -> CGRect? {
    guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], wid) as? [[String: Any]],
          let b = info.first?[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: b)
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
    "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
    "leftarrow": 123, "rightarrow": 124, "downarrow": 125, "uparrow": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37,
    "j": 38, "k": 40, "n": 45, "m": 46,
    "-": 27, "minus": 27, "[": 33, "]": 30, ";": 41, "'": 39, ",": 43, ".": 47, "/": 44, "`": 50, "\\": 42,
    "plus": 24, "equal": 24, "home": 115, "end": 119, "pageup": 116, "pagedown": 121, "forwarddelete": 117,
    "backspace": 51, "enter": 36, "esc": 53,
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
    // ondra-bgguard.dylib knows Ondra's events by this mark, to carry their drags out in the app
    e?.setIntegerValueField(.eventSourceUserData, value: 0x4F4E4452)
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
            // a web page's own bar can be set and still move nothing (the page doesn't scroll; the
            // list inside it does, like a chat thread): only a bar that moved counts
            if abs(next - current) > 1e-6, AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: next)) == .success {
                usleep(30_000)
                var after: CFTypeRef?
                if AXUIElementCopyAttributeValue(bar, kAXValueAttribute as CFString, &after) == .success,
                   let moved = (after as? NSNumber)?.doubleValue, abs(moved - current) > 1e-6 {
                    return ["scrolledTo": moved]
                }
            }
        }
    }
    let page = vertical ? (forward ? "AXScrollDownByPage" : "AXScrollUpByPage") : (forward ? "AXScrollRightByPage" : "AXScrollLeftByPage")
    if axActions(area).contains(page) {
        let before = contentOrigin(area)
        if AXUIElementPerformAction(area, page as CFString) == .success {
            usleep(30_000)
            if before == nil || contentOrigin(area) != before { return ["scrolledBy": "page"] }
        }
    }
    if let moved = scrollByReveal(area, direction: direction, lines: lines) { return moved }
    throw ActError.message("SCROLL_UNAVAILABLE", "this scroll area exposes no settable scroll bar or page action")
}

/// Where the area's content sits now (its first child's origin), to tell whether a page action moved it.
func contentOrigin(_ area: AXUIElement) -> CGPoint? {
    guard let first = axChildren(area).first, let f = axFrame(first) else { return nil }
    return f.origin
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

/// Scroll the box that holds the target when no AX scroll area does: from the element at the
/// target up through its ancestors, bring the element just past each one's edge into view;
/// then a wheel event addressed to the window. Only a move of the content counts.
func scrollInside(start: AXUIElement?, point: CGPoint, pid: pid_t, direction: String, lines: Int, window: EventWindow?) -> [String: Any]? {
    var hit: AXUIElement?
    if start == nil {
        var el: AXUIElement?
        if AXUIElementCopyElementAtPosition(AXUIElementCreateApplication(pid), Float(point.x), Float(point.y), &el) == .success { hit = el }
    }
    let first = start ?? hit
    var cur = first, lastFrame: CGRect?
    for _ in 0..<14 {
        guard let c = cur else { break }
        let role = axString(c, kAXRoleAttribute) ?? ""
        if role == kAXWindowRole || role == kAXApplicationRole { break }
        // the same box again (a wrapper of the same size) would find the same nothing
        if let f = axFrame(c), f != lastFrame {
            lastFrame = f
            if let moved = scrollByReveal(c, direction: direction, lines: lines) { return moved }
        }
        cur = axParent(c)
    }
    // the wheel, addressed to the window like our clicks (the real cursor stays)
    guard let w = window else { return nil }
    let probe = first.flatMap(axFrame)
    let vertical = direction == "up" || direction == "down"
    let n = Int32(max(1, min(50, lines))) * ((direction == "down" || direction == "right") ? -1 : 1)
    guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2,
                          wheel1: vertical ? n : 0, wheel2: vertical ? 0 : n, wheel3: 0) else { return nil }
    e.location = point
    e.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.id))
    e.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(w.id))
    e.setIntegerValueField(.eventSourceUserData, value: 0x4F4E4452)
    e.postToPid(pid)
    usleep(120_000)
    if let before = probe, let el = first, let after = axFrame(el), abs(after.minY - before.minY) >= 1 || abs(after.minX - before.minX) >= 1 {
        return ["scrolledBy": "wheel"]
    }
    return nil
}

/// The app's own menu bar titles (not the Apple menu or the app-name menu), for the caller to know
/// what the menu action can reach.
func menuBarTitles(_ pid: pid_t) -> [String] {
    var bar: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXMenuBarAttribute as CFString, &bar) == .success,
          let b = bar, CFGetTypeID(b) == AXUIElementGetTypeID() else { return [] }
    let titles = axChildren(b as! AXUIElement).compactMap { axString($0, kAXTitleAttribute) }.filter { !$0.isEmpty }
    return Array(titles.dropFirst(2).prefix(14))
}

/// A menu bar command by its titles ("Sheet", "Navigate", "To Next Sheet"), pressed with
/// AXPress on the item itself: the menu never opens and the app is not activated. A path that
/// stops at a menu, or names no item there, lists what that menu offers instead.
func pressMenuPath(pid: pid_t, path: [String]) throws -> [String: Any] {
    var bar: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXMenuBarAttribute as CFString, &bar) == .success,
          let b = bar, CFGetTypeID(b) == AXUIElementGetTypeID() else { throw ActError.message("NO_MENU_BAR", "this app has no menu bar to use") }
    func norm(_ t: String) -> String {
        t.lowercased().replacingOccurrences(of: "…", with: "").replacingOccurrences(of: "...", with: "")
            .trimmingCharacters(in: .whitespaces)
    }
    func items(_ el: AXUIElement) -> [AXUIElement] {
        // a bar item or menu item holds one AXMenu whose children are the items
        let kids = axChildren(el)
        if let menu = kids.first(where: { axString($0, kAXRoleAttribute) == kAXMenuRole }) { return axChildren(menu) }
        return kids
    }
    func offered(_ list: [AXUIElement]) -> String {
        list.compactMap { e -> String? in
            guard let t = axString(e, kAXTitleAttribute), !t.isEmpty else { return nil }
            let sub = items(e).isEmpty ? "" : " ›"
            return axBool(e, kAXEnabledAttribute) == false ? "\(t)\(sub) (disabled)" : "\(t)\(sub)"
        }.joined(separator: ", ")
    }
    var level = axChildren(b as! AXUIElement)
    var walked: [String] = []
    for (i, name) in path.enumerated() {
        let want = norm(name)
        let titled = level.map { ($0, norm(axString($0, kAXTitleAttribute) ?? "")) }.filter { !$0.1.isEmpty }
        guard let hit = titled.first(where: { $0.1 == want })?.0 ?? titled.first(where: { $0.1.hasPrefix(want) })?.0
                ?? titled.first(where: { $0.1.contains(want) })?.0 else {
            let at = walked.isEmpty ? "the menu bar" : walked.map { "“\($0)”" }.joined(separator: " › ")
            throw ActError.message("NO_SUCH_ITEM", "\(at) has no “\(name)”; it offers: \(offered(level))")
        }
        walked.append(axString(hit, kAXTitleAttribute) ?? name)
        let sub = items(hit)
        if i == path.count - 1 {
            if !sub.isEmpty || axString(hit, kAXRoleAttribute) == kAXMenuBarItemRole {
                throw ActError.message("MENU_LEVEL", "\(walked.map { "“\($0)”" }.joined(separator: " › ")) is a menu; it offers: \(offered(sub)). Add one of them to the path")
            }
            // A background app has no key window, so it reports items that act on the window
            // as disabled until asked: press anyway, and let the screen tell.
            let r = AXUIElementPerformAction(hit, kAXPressAction as CFString)
            guard r == .success else {
                throw ActError.message(axBool(hit, kAXEnabledAttribute) == false ? "DISABLED" : "MENU_FAILED",
                                       "the app did not accept “\(walked.last!)” (AX \(r.rawValue))")
            }
            return ["via": "menu", "picked": walked.joined(separator: " › ")]
        }
        level = sub
    }
    throw ActError.message("BAD_ACTION", "empty menu path")
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
    // The pixels still line up while the captured window itself is where the look found it.
    // AX can name another window as key, or none (a hidden app), while that one has not moved;
    // checking AX alone refused clicks right after a look, again and again.
    let axNow = keyWindowElement(forPid: pid).flatMap(axFrame)
    let cgNow = cgWindowBounds(look.windowID)
    guard axNow.map({ nearlySame($0, look.frame) }) == true || cgNow.map({ nearlySame($0, look.frame) }) == true else {
        if axNow == nil && cgNow == nil { throw ActError.message("NO_WINDOW", "the window of the last look is gone; observe") }
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
        if right || name == kAXShowMenuAction || opensMenu(el) { try refuseMenuInBackground(pid) }
        let spot = try? resolvePoint(["ref": action["ref"] ?? ""], pid: pid, map: map)
        // the arrow gets there first, so the press lands where the user sees it point
        VirtualCursor.shared.lead(spot)
        // an item of an open menu: the menu closes and applies the choice after the press
        // returns, so wait for that before the next step reads or acts on the result
        let menuOwner = axString(el, kAXRoleAttribute) == kAXMenuItemRole ? axParent(el).flatMap(axParent) : nil
        if count == 1 && !right && !forcePointer && AXUIElementPerformAction(el, name as CFString) == .success {
            VirtualCursor.shared.press()
            if let owner = menuOwner { _ = waitForMenuClosed(owner) }
            return ["via": "ax"]
        }
        if count == 1 && right && !forcePointer && axActions(el).contains(kAXShowMenuAction),
           AXUIElementPerformAction(el, kAXShowMenuAction as CFString) == .success {
            VirtualCursor.shared.press()
            return ["via": "ax-menu"]
        }
        // A row's text or cell has no press: select its row the accessibility way (no events,
        // so the window is never lifted the way a pointer click lifts it)
        if count == 1 && !right && !forcePointer, let row = selectableRow(el), selectRow(row) {
            VirtualCursor.shared.press()
            return ["via": "ax-select"]
        }
        // The view ignores accessibility actions (custom rows, profile cards, …): click it
        // with pointer events addressed to its window, still without moving the real cursor.
        guard (action["fallbackClick"] as? Bool) ?? false else {
            throw ActError.message("AX_ACTION_FAILED", "AX action \(name) failed")
        }
        if userActive(in: pid) { throw ActError.message("USER_ACTIVE", "the user is working in this app; nothing was sent") }
        try refusePointerIfItRaises(pid)
        guard let (p, w) = spot else { throw ActError.message("NO_BOUNDS", "this element has no visible bounds to click") }
        VirtualCursor.shared.press()
        postClick(pid: pid, at: p, button: right ? .right : .left, count: count, window: w)
        return ["via": "pointer"]
    case "set-value":
        let el = try elementFor()
        if elementIsSecure(el) { throw ActError.message("SECURE_FIELD", "password fields are left to the user") }
        let value = (action["value"] as? String) ?? ""
        if !axSettable(el, kAXValueAttribute) {
            let role = axString(el, kAXRoleAttribute) ?? ""
            guard [kAXPopUpButtonRole, kAXMenuButtonRole, kAXComboBoxRole].contains(role) else {
                throw ActError.message("NOT_SETTABLE", "value is not settable")
            }
            try refuseMenuInBackground(pid)
            let picked = try pickFromMenu(el, value)
            if let (p, w) = try? resolvePoint(["ref": action["ref"] ?? ""], pid: pid, map: map) { VirtualCursor.shared.show(at: p, window: w, click: true) }
            return ["via": "menu", "picked": picked]
        }
        if AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, value as CFTypeRef) != .success {
            throw ActError.message("AX_SET_FAILED", "could not set value")
        }
        if let (p, w) = try? resolvePoint(["ref": action["ref"] ?? ""], pid: pid, map: map) { VirtualCursor.shared.show(at: p, window: w, click: false) }
    case "focus": // make a field key without activating the app
        let el = try elementFor()
        _ = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    case "menu":
        guard let path = action["path"] as? [String], !path.isEmpty else { throw ActError.message("BAD_ACTION", "menu needs a path") }
        return try pressMenuPath(pid: pid, path: path)
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
            // In the background a pointer click lifts most apps' windows over the user's: a field
            // that takes its value directly gets it that way (below) without any click.
            let background = NSWorkspace.shared.frontmostApplication?.processIdentifier != pid
            if !focusIsOn(el, pid: pid), !(background && axSettable(el, kAXValueAttribute)),
               let (p, w) = spot, (try? refusePointerIfItRaises(pid)) != nil {
                // some fields only take focus from a click: one addressed to the window, cursor untouched
                VirtualCursor.shared.lead((p, w))
                VirtualCursor.shared.press()
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
            // Some apps (LibreOffice, GTK apps) report no AX focus although they take keys, as
            // press shows: type into wherever the app's own caret is, as press would
            if let f = focusedElement(pid: pid) {
                if elementIsSecure(f) { throw ActError.message("SECURE_FIELD", "password fields are left to the user") }
            } else {
                typeText(pid: pid, text: text)
                return ["via": "keys", "focusUnknown": true]
            }
        }
        typeText(pid: pid, text: text)
    case "press":
        guard let key = action["key"] as? String, let code = keyCodes[key.lowercased()] else {
            throw ActError.message("BAD_KEY", "unknown key")
        }
        let mods = (action["modifiers"] as? [String]) ?? []
        postKey(pid: pid, keyCode: code, flags: pressModifiersFlags(mods))
    case "click-at":
        try refusePointerIfItRaises(pid)
        if (action["button"] as? String) == "right" { try refuseMenuInBackground(pid) }
        let (p, w) = try resolvePoint(action, pid: pid, map: map)
        let button: CGMouseButton = (action["button"] as? String) == "right" ? .right : .left
        let count = (action["count"] as? Int) ?? 1
        VirtualCursor.shared.lead((p, w))
        VirtualCursor.shared.press()
        postClick(pid: pid, at: p, button: button, count: count, window: w)
    case "scroll":
        // Scroll wheel events posted to a background app carry no window and are
        // dropped by AppKit, so scroll through the scroll area's AX scroll bar (or its
        // page actions) instead: no events, nothing visible to the user.
        let (p, w) = try resolvePoint(action, pid: pid, map: map)
        let start = (action["ref"] as? String).flatMap { map.element($0) }
        let dir = (action["direction"] as? String) ?? "down"
        let amount = (action["amount"] as? Int) ?? 3
        var failure: Error = ActError.message("NO_SCROLL_AREA", "no scroll area at this target")
        if let area = scrollArea(from: start, containing: p, pid: pid) {
            do { return try scrollAX(area, direction: dir, lines: amount) } catch { failure = error }
        }
        // a page that scrolls inside one of its own boxes (a web app's message pane) has no AX
        // scroll area for it: scroll whatever box holds the target, then try the wheel
        if let moved = scrollInside(start: start, point: p, pid: pid, direction: dir, lines: amount, window: w) { return moved }
        throw failure
    case "drag":
        try refusePointerIfItRaises(pid)
        guard let fromSpec = action["from"] as? [String: Any], let toSpec = action["to"] as? [String: Any] else {
            throw ActError.message("BAD_ACTION", "drag needs from and to")
        }
        let (a, w) = try resolvePoint(fromSpec, pid: pid, map: map)
        let (b, _) = try resolvePoint(toSpec, pid: pid, map: map)
        VirtualCursor.shared.lead((a, w))
        VirtualCursor.shared.press()
        let t0 = nowMs()
        // the arrow carries the drag across while the events go to the app
        VirtualCursor.shared.show(at: b, window: w, click: false)
        let steps = postDrag(pid: pid, from: a, to: b, window: w)
        VirtualCursor.shared.press()
        // a drop lands only in an app that carries ondra-bgguard.dylib, which runs the drag inside the app
        return ["dragSteps": steps, "dragMs": nowMs() - t0, "dropInApp": bgApp(pid)?.guarded == true]
    default:
        throw ActError.message("BAD_ACTION", "unsupported kind \(kind)")
    }
    return [:]
}

/// The open menu a pop-up, menu button or combo box shows as its child, if any.
func openMenu(of el: AXUIElement) -> AXUIElement? {
    axChildren(el).first { [kAXMenuRole, kAXListRole].contains(axString($0, kAXRoleAttribute) ?? "") }
}

/// Wait (up to a second) until `owner` no longer shows an open menu.
func waitForMenuClosed(_ owner: AXUIElement) -> Bool {
    for _ in 0..<40 {
        if openMenu(of: owner) == nil { usleep(30_000); return true }
        usleep(25_000)
    }
    return false
}

/// Choose `value` in a pop-up (or menu button, combo box) through its own menu, by
/// accessibility actions only: open it, pick the item whose title matches (exactly, else
/// by prefix, case aside), then wait until the menu closed and the control shows it.
/// Returns the item's title. No match: the menu is closed and the error lists the items.
/// The table or outline row an element sits in (itself or up to four parents), if it can be selected.
func selectableRow(_ el: AXUIElement) -> AXUIElement? {
    var cur: AXUIElement? = el
    for _ in 0..<5 {
        guard let c = cur else { return nil }
        let role = axString(c, kAXRoleAttribute) ?? ""
        if role == kAXRowRole { return axSettable(c, kAXSelectedAttribute) ? c : nil }
        if role == kAXTableRole || role == kAXOutlineRole || role == kAXWindowRole { return nil }
        cur = axParent(c)
    }
    return nil
}

/// Select a row as a click would: through its own AXSelected, else its table's AXSelectedRows.
func selectRow(_ row: AXUIElement) -> Bool {
    if axBool(row, kAXSelectedAttribute) == true { return true }
    _ = AXUIElementSetAttributeValue(row, kAXSelectedAttribute as CFString, kCFBooleanTrue)
    usleep(20_000)
    if axBool(row, kAXSelectedAttribute) == true { return true }
    if let table = axParent(row), axSettable(table, kAXSelectedRowsAttribute) {
        _ = AXUIElementSetAttributeValue(table, kAXSelectedRowsAttribute as CFString, [row] as CFArray)
        usleep(20_000)
    }
    return axBool(row, kAXSelectedAttribute) == true
}

/// A control whose press opens a menu: a pop-up, a menu button, a list-only combo box.
func opensMenu(_ el: AXUIElement) -> Bool {
    let role = axString(el, kAXRoleAttribute) ?? ""
    if role == kAXPopUpButtonRole || role == kAXMenuButtonRole { return true }
    return role == kAXComboBoxRole && !axSettable(el, kAXValueAttribute)
}

/// A menu that opens takes the keyboard from the user's front window (it resigns key) and
/// orders its app's window over theirs, even when the app stays in the background. So while
/// the target is not the front app, nothing that opens a menu is done.
/// Apps seen lifting their window over the user's when a pointer click reached them (Chromium,
/// Electron). Put back at once, but a lift is still a moment over the user's window: while the
/// app is in the background, no more pointer events go to it.
var raisesOnPointer = Set<pid_t>()
func refusePointerIfItRaises(_ pid: pid_t) throws {
    guard raisesOnPointer.contains(pid), NSWorkspace.shared.frontmostApplication?.processIdentifier != pid else { return }
    throw ActError.message("POINTER_RAISES", "this app lifts its window over the user's when clicked with the pointer, so pointer clicks are not sent to it in the background. Use refs (click without pointer), keys, set-value or menu commands")
}

func refuseMenuInBackground(_ pid: pid_t) throws {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier != pid else { return }
    throw ActError.message("NEEDS_FOREGROUND", "this opens a menu, and an open menu takes the keyboard from the user's app, so it is not done in the background. Use the app's menu bar (menu action) or keys if they offer the same choice; otherwise finish the rest and tell the user which choice is left for them")
}

func pickFromMenu(_ control: AXUIElement, _ value: String) throws -> String {
    let want = value.trimmingCharacters(in: .whitespaces).lowercased()
    if (axString(control, kAXValueAttribute) ?? axString(control, kAXTitleAttribute) ?? "").lowercased() == want { return value }
    var menu = openMenu(of: control)
    if menu == nil {
        let open = axActions(control).contains(kAXShowMenuAction) && axString(control, kAXRoleAttribute) != kAXPopUpButtonRole ? kAXShowMenuAction : kAXPressAction
        guard AXUIElementPerformAction(control, open as CFString) == .success else {
            throw ActError.message("AX_ACTION_FAILED", "could not open the pop-up's menu")
        }
        for _ in 0..<40 {
            if let m = openMenu(of: control) { menu = m; break }
            usleep(25_000)
        }
    }
    guard let m = menu else { throw ActError.message("NO_MENU", "the pop-up did not show its menu") }
    let items = axChildren(m).filter { [kAXMenuItemRole, kAXStaticTextRole, "AXRow"].contains(axString($0, kAXRoleAttribute) ?? "") }
    let title = { (i: AXUIElement) -> String in axString(i, kAXTitleAttribute) ?? axString(i, kAXValueAttribute) ?? "" }
    let titles = items.map(title)
    guard let k = titles.firstIndex(where: { $0.lowercased() == want }) ?? titles.firstIndex(where: { $0.lowercased().hasPrefix(want) }),
          axBool(items[k], kAXEnabledAttribute) != false else {
        _ = AXUIElementPerformAction(m, kAXCancelAction as CFString)
        _ = waitForMenuClosed(control)
        throw ActError.message("NO_SUCH_ITEM", "no enabled item \"\(value)\"; it offers: " + titles.filter { !$0.isEmpty }.joined(separator: ", "))
    }
    let item = items[k]
    if AXUIElementPerformAction(item, "AXPick" as CFString) != .success,
       AXUIElementPerformAction(item, kAXPressAction as CFString) != .success {
        _ = AXUIElementPerformAction(m, kAXCancelAction as CFString)
        throw ActError.message("AX_ACTION_FAILED", "could not pick \"\(titles[k])\"")
    }
    _ = waitForMenuClosed(control)
    for _ in 0..<20 {
        if (axString(control, kAXValueAttribute) ?? axString(control, kAXTitleAttribute) ?? "").lowercased() == titles[k].lowercased() { break }
        usleep(25_000)
    }
    return titles[k]
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
// Shows where the agent points without touching the real cursor: Ondra's own pointer, drawn
// on a click-through overlay ordered just above the target window, so the user's windows in
// front still cover it and the user's cursor and focus stay where they are. It glides to
// each point along a slight arc, arrives before the action lands, presses on a click, and
// fades a few seconds after the last action. Never key, never activates.

/// Ondra's pointer: a rounded arrowhead in Ondra's blue, a white rim, a soft shadow.
final class PointerLayer: CALayer {
    static let box = CGSize(width: 32, height: 32)
    /// the tip, in the box's bottom-left coordinates
    static let tip = CGPoint(x: 6, y: 26)
    private let body = CAGradientLayer()
    private let rim = CAShapeLayer()
    private let ripple = CAShapeLayer()

    override init() {
        super.init()
        bounds = CGRect(origin: .zero, size: Self.box)
        anchorPoint = CGPoint(x: Self.tip.x / Self.box.width, y: Self.tip.y / Self.box.height)
        contentsScale = NSScreen.main?.backingScaleFactor ?? 2
        let path = Self.arrow()
        // the press: a soft ring that opens under the tip
        let r: CGFloat = 15
        ripple.path = CGPath(ellipseIn: CGRect(x: -r, y: -r, width: 2 * r, height: 2 * r), transform: nil)
        ripple.position = Self.tip
        ripple.fillColor = NSColor(srgbRed: 0.30, green: 0.61, blue: 0.94, alpha: 0.20).cgColor
        ripple.strokeColor = NSColor(srgbRed: 0.30, green: 0.61, blue: 0.94, alpha: 0.55).cgColor
        ripple.lineWidth = 1.25
        ripple.opacity = 0
        addSublayer(ripple)
        shadowPath = path
        shadowColor = NSColor.black.cgColor
        shadowOpacity = 0.32
        shadowRadius = 3.5
        shadowOffset = CGSize(width: 0, height: -1.5)
        // Ondra's accent (#1f6fd8), a touch lighter at the top so it reads on dark and light
        body.frame = bounds
        body.colors = [NSColor(srgbRed: 0.42, green: 0.71, blue: 0.97, alpha: 1).cgColor, NSColor(srgbRed: 0.12, green: 0.44, blue: 0.85, alpha: 1).cgColor]
        body.startPoint = CGPoint(x: 0.3, y: 1)
        body.endPoint = CGPoint(x: 0.6, y: 0)
        let mask = CAShapeLayer()
        mask.path = path
        body.mask = mask
        addSublayer(body)
        rim.path = path
        rim.fillColor = nil
        rim.strokeColor = NSColor.white.cgColor
        rim.lineWidth = 1.5
        rim.lineJoin = .round
        addSublayer(rim)
        for l in [body, rim, ripple, mask] as [CALayer] { l.contentsScale = contentsScale }
    }
    override init(layer: Any) { super.init(layer: layer) }
    required init?(coder: NSCoder) { nil }

    /// A navigation arrow pointing up-left: tip, a right wing, a notch, a lower wing; corners rounded.
    static func arrow() -> CGPath {
        let t = tip
        let pts: [(CGPoint, CGFloat)] = [
            (t, 1.8),
            (CGPoint(x: t.x + 23, y: t.y - 8), 2.5),
            (CGPoint(x: t.x + 10.4, y: t.y - 10.4), 1.4),
            (CGPoint(x: t.x + 8, y: t.y - 23), 2.5),
        ]
        let p = CGMutablePath()
        let n = pts.count
        let start = CGPoint(x: (pts[n - 1].0.x + pts[0].0.x) / 2, y: (pts[n - 1].0.y + pts[0].0.y) / 2)
        p.move(to: start)
        for i in 0..<n { p.addArc(tangent1End: pts[i].0, tangent2End: pts[(i + 1) % n].0, radius: pts[i].1) }
        p.closeSubpath()
        return p
    }

    /// The press: the arrow dips and springs back while the ring opens and fades.
    func press(after delay: CFTimeInterval = 0) {
        let at = convertTime(CACurrentMediaTime(), from: nil) + delay
        let dip = CAKeyframeAnimation(keyPath: "transform.scale")
        dip.values = [1, 0.84, 1.05, 1]
        dip.keyTimes = [0, 0.35, 0.72, 1]
        dip.duration = 0.28
        dip.beginTime = at
        dip.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut), CAMediaTimingFunction(name: .easeOut)]
        add(dip, forKey: "press")
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.3; grow.toValue = 1.0
        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = [0, 1, 0]; fade.keyTimes = [0, 0.2, 1]
        let g = CAAnimationGroup()
        g.animations = [grow, fade]
        g.duration = 0.45
        g.beginTime = ripple.convertTime(CACurrentMediaTime(), from: nil) + delay + 0.06
        g.timingFunction = CAMediaTimingFunction(name: .easeOut)
        ripple.add(g, forKey: "ripple")
    }
}

final class VirtualCursor {
    static let shared = VirtualCursor()
    /// room around the window so the arrow and its ring can sit at the window's edge
    private let margin: CGFloat = 40
    private var panel: NSPanel?
    private var pointer: PointerLayer?
    private var hide: DispatchWorkItem?
    /// where the tip is headed (global top-left coordinates) and over which window; read from
    /// the action thread to time the glide, written on main
    private let lock = NSLock()
    private var lastAt: CGPoint?
    private var lastWindow: CGWindowID?
    private var lastFrame: CGRect = .zero
    private var shown = false

    /// Glide to `point` over `window`, pressing on arrival when `click`. Returns the glide's
    /// length in seconds (0 when nothing is drawn: the window is hidden, minimized or covered).
    @discardableResult
    func show(at point: CGPoint, window: EventWindow?, click: Bool) -> TimeInterval {
        guard let w = window, shownAsIs(w), visible(w.id, at: point) else { return 0 }
        lock.lock()
        let from = shown && lastWindow == w.id ? lastAt : nil
        lastAt = point
        lastWindow = w.id
        shown = true
        lock.unlock()
        let travel = from.map { Self.travel(from: $0, to: point) } ?? 0
        DispatchQueue.main.async { self.place(point, over: w, from: from, travel: travel, click: click) }
        return travel
    }

    /// Glide there first and wait (briefly) until the arrow arrives, so the action lands
    /// where the user sees it point. Used right before a click or a press.
    func lead(_ spot: (CGPoint, EventWindow?)?) {
        guard let (p, w) = spot else { return }
        let t = show(at: p, window: w, click: false)
        if t > 0 { usleep(UInt32(min(t, 0.32) * 1_000_000)) }
    }

    /// The press where the arrow is now.
    func press() {
        lock.lock(); let on = shown; lock.unlock()
        guard on else { return }
        DispatchQueue.main.async { self.pointer?.press(); self.keepAlive() }
    }

    /// Longer moves take a little longer, like a hand (Fitts): about 0.15 s to 0.5 s.
    static func travel(from a: CGPoint, to b: CGPoint) -> TimeInterval {
        let d = hypot(b.x - a.x, b.y - a.y)
        return d < 2 ? 0 : min(0.5, 0.14 + 0.075 * log2(1 + d / 24))
    }

    /// On screen at its real size: not hidden, minimized or a Stage Manager thumbnail.
    private func shownAsIs(_ w: EventWindow) -> Bool {
        guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], w.id) as? [[String: Any]], let d = info.first,
              (d[kCGWindowIsOnscreen as String] as? Bool) == true,
              let b = d[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b) else { return false }
        return nearlySame(r, w.frame, 4)
    }

    /// The window is the one the user sees at the point: a window over it (the user's own,
    /// while the app works behind) gets no pointer drawn on top.
    private func visible(_ id: CGWindowID, at point: CGPoint) -> Bool {
        let me = getpid()
        let infos = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
        for d in infos where (d[kCGWindowLayer as String] as? Int) == 0 && (d[kCGWindowOwnerPID as String] as? Int32) != me {
            guard let b = d[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b),
                  r.contains(point) else { continue }
            return (d[kCGWindowNumber as String] as? Int).map { CGWindowID($0) } == id
        }
        return false
    }

    private func make() -> NSPanel {
        let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 10, height: 10), styleMask: [.borderless, .nonactivatingPanel],
                        backing: .buffered, defer: false)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.ignoresMouseEvents = true
        p.isReleasedWhenClosed = false
        p.hidesOnDeactivate = false
        p.collectionBehavior = [.transient, .ignoresCycle, .fullScreenAuxiliary]
        let v = NSView(frame: p.contentLayoutRect)
        v.wantsLayer = true
        v.autoresizingMask = [.width, .height]
        p.contentView = v
        let ptr = PointerLayer()
        ptr.opacity = 0
        v.layer?.addSublayer(ptr)
        pointer = ptr
        return p
    }

    /// AppKit frame of the overlay for a window (global top-left coordinates in).
    private func overlayFrame(_ r: CGRect) -> NSRect {
        let primary = NSScreen.screens.first?.frame.height ?? CGDisplayBounds(CGMainDisplayID()).height
        return NSRect(x: r.minX - margin, y: primary - r.maxY - margin, width: r.width + 2 * margin, height: r.height + 2 * margin)
    }

    /// A global top-left point in the overlay's layer (bottom-left) coordinates.
    private func local(_ g: CGPoint, in r: CGRect) -> CGPoint {
        CGPoint(x: g.x - r.minX + margin, y: r.maxY + margin - g.y)
    }

    private func place(_ point: CGPoint, over w: EventWindow, from: CGPoint?, travel: TimeInterval, click: Bool) {
        let p = panel ?? make()
        panel = p
        guard let ptr = pointer else { return }
        if lastFrame != w.frame || !p.isVisible {
            CATransaction.begin(); CATransaction.setDisableActions(true)
            p.setFrame(overlayFrame(w.frame), display: false)
            if let f = from { ptr.position = local(f, in: w.frame) }
            CATransaction.commit()
            lastFrame = w.frame
        }
        p.order(.above, relativeTo: Int(w.id))
        let to = local(point, in: w.frame)
        CATransaction.begin(); CATransaction.setDisableActions(true)
        if ptr.opacity < 0.5 || from == nil {
            // appear: drift in from a little below-right of the point and settle
            ptr.removeAllAnimations()
            ptr.position = to
            ptr.opacity = 1
            let drift = CABasicAnimation(keyPath: "position")
            drift.fromValue = NSValue(point: CGPoint(x: to.x + 14, y: to.y - 14))
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0
            let grow = CABasicAnimation(keyPath: "transform.scale")
            grow.fromValue = 0.7
            let g = CAAnimationGroup()
            g.animations = [drift, fade, grow]
            g.duration = 0.22
            g.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.3, 1)
            ptr.add(g, forKey: "appear")
            ptr.transform = CATransform3DIdentity
            CATransaction.commit()
            if click { ptr.press(after: 0.2) }
            keepAlive()
            return
        }
        // glide along a slight arc (a hand never moves in a ruler-straight line)
        let start = (ptr.presentation() ?? ptr).position
        ptr.position = to
        ptr.removeAnimation(forKey: "appear")
        if travel > 0 {
            let dx = to.x - start.x, dy = to.y - start.y
            let d = max(1, hypot(dx, dy))
            let bend = min(48, d * 0.12)
            let control = CGPoint(x: (start.x + to.x) / 2 - dy / d * bend, y: (start.y + to.y) / 2 + dx / d * bend)
            let path = CGMutablePath()
            path.move(to: start)
            path.addQuadCurve(to: to, control: control)
            let glide = CAKeyframeAnimation(keyPath: "position")
            glide.path = path
            glide.duration = travel
            glide.calculationMode = .paced
            glide.timingFunction = CAMediaTimingFunction(controlPoints: 0.32, 0, 0.18, 1)
            ptr.add(glide, forKey: "glide")
        }
        CATransaction.commit()
        if click { ptr.press(after: travel) }
        keepAlive()
    }

    /// Fade out a few seconds after the last action.
    private func keepAlive() {
        hide?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self, let p = self.panel, let ptr = self.pointer else { return }
            self.lock.lock(); self.shown = false; self.lock.unlock()
            CATransaction.begin()
            CATransaction.setAnimationDuration(0.3)
            CATransaction.setCompletionBlock { if ptr.opacity == 0 { p.orderOut(nil) } }
            ptr.opacity = 0
            ptr.transform = CATransform3DMakeScale(0.85, 0.85, 1)
            CATransaction.commit()
        }
        hide = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0, execute: work)
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
    // a bundle by its path (a test build in a scratch folder): only if it is there
    if name.contains("/") || name.hasSuffix(".app") {
        let url = URL(fileURLWithPath: (name as NSString).expandingTildeInPath).standardizedFileURL
        if name.contains("/") || FileManager.default.fileExists(atPath: url.path) {
            return FileManager.default.fileExists(atPath: url.appendingPathComponent("Contents/Info.plist").path) ? url : nil
        }
    }
    if let u = ws.urlForApplication(withBundleIdentifier: name) { return u }
    // an app already open, wherever it was opened from (Downloads, a build folder)
    if let u = runningAppByName(name) { return u }
    // locate by name (never some other app: a name that matches nothing is "not found")
    return findAppByName(name)
}

/// A running app the name or bundle id names, any case: its bundle, for an app open from
/// outside the usual app folders.
func runningAppByName(_ name: String) -> URL? {
    let want = name.lowercased().replacingOccurrences(of: ".app", with: "")
    return NSWorkspace.shared.runningApplications.first { app in
        guard app.activationPolicy == .regular, let url = app.bundleURL else { return false }
        return [app.localizedName, app.bundleIdentifier, url.deletingPathExtension().lastPathComponent]
            .contains { $0?.lowercased() == want }
    }?.bundleURL
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
struct HeldFrame { let window: AXUIElement; let origin: CGPoint; let size: CGSize; let id: CGWindowID }

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

/// The on-screen bounds the window server shows for a window: under Stage Manager a window
/// in the side strip shows as a small thumbnail there, while AX still reports its real frame.
func cgBounds(_ id: CGWindowID) -> CGRect? {
    guard let info = (CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]])?.first,
          let b = info[kCGWindowBounds as String] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: b)
}

/// The front app's focused window, held only while it is on stage at its real size (its window
/// server bounds match its AX frame): a frame read off a Stage Manager thumbnail is never held.
func frontWindowFrame() -> HeldFrame? {
    guard let front = NSWorkspace.shared.frontmostApplication else { return nil }
    let app = AXUIElementCreateApplication(front.processIdentifier)
    var w: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &w) == .success, let win = w, CFGetTypeID(win) == AXUIElementGetTypeID() else { return nil }
    let el = win as! AXUIElement
    guard let o = axPoint(el, kAXPositionAttribute), let s = axSize(el),
          let id = cgWindowID(pid: front.processIdentifier, frame: CGRect(origin: o, size: s), title: nil) else { return nil }
    return HeldFrame(window: el, origin: o, size: s, id: id)
}

/// Watch the held window for a moment after a launch; if it was moved or resized, put it back.
/// If Stage Manager took it into the strip (its window server bounds are a thumbnail now), its
/// AX frame is not touched: resizing a window in the strip fights Stage Manager and leaves it
/// half out. That is a stage switch, and restoreUserStage brings the user's stage back.
func keepFrame(_ h: HeldFrame) {
    let moved = { () -> Bool in
        guard let o = axPoint(h.window, kAXPositionAttribute), let s = axSize(h.window) else { return false }
        return abs(o.x - h.origin.x) > 1 || abs(o.y - h.origin.y) > 1 || abs(s.width - h.size.width) > 1 || abs(s.height - h.size.height) > 1
    }
    let staged = { () -> Bool in
        guard let b = cgBounds(h.id) else { return true }
        return b.width < h.size.width * 0.6 && b.height < h.size.height * 0.6
    }
    for _ in 0..<15 {
        usleep(100_000)
        if staged() { return }
        if moved() {
            // let the arrangement finish, then restore size first (a smaller window can always move)
            usleep(250_000)
            if staged() { return }
            var size = h.size, origin = h.origin
            if let sv = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(h.window, kAXSizeAttribute as CFString, sv) }
            if let pv = AXValueCreate(.cgPoint, &origin) { AXUIElementSetAttributeValue(h.window, kAXPositionAttribute as CFString, pv) }
            if let sv = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(h.window, kAXSizeAttribute as CFString, sv) }
            return
        }
    }
}

/// An app by the name the user knows it by: its file name, bundle name or display name, in
/// the user's languages too ("카카오톡" as well as "KakaoTalk"), any case, in the usual app
/// folders and the user's own (where Safari and Chrome put web apps the user made).
func findAppByName(_ name: String) -> URL? {
    let fm = FileManager.default
    let want = name.lowercased().replacingOccurrences(of: ".app", with: "")
    let home = fm.homeDirectoryForCurrentUser.path
    var dirs = ["/System/Applications", "/Applications", "/System/Applications/Utilities", "/Applications/Utilities",
                "\(home)/Applications"]
    // one level of folders inside the user's app folders ("Chrome Apps.localized", a vendor folder)
    for base in ["/Applications", "\(home)/Applications"] {
        for sub in (try? fm.contentsOfDirectory(atPath: base)) ?? [] where !sub.hasSuffix(".app") && !sub.hasPrefix(".") {
            var isDir: ObjCBool = false
            if fm.fileExists(atPath: "\(base)/\(sub)", isDirectory: &isDir), isDir.boolValue { dirs.append("\(base)/\(sub)") }
        }
    }
    let apps = dirs.flatMap { dir in ((try? fm.contentsOfDirectory(atPath: dir)) ?? []).filter { $0.hasSuffix(".app") }
        .map { URL(fileURLWithPath: dir).appendingPathComponent($0) } }
    // the file name first (as it is spelled on disk), then any name the app goes by
    if let hit = apps.first(where: { $0.deletingPathExtension().lastPathComponent.lowercased() == want }) { return hit }
    return apps.first { url in
        let info = infoPlist(url)
        return ([info["CFBundleName"] as? String, info["CFBundleDisplayName"] as? String] + localizedAppNames(url))
            .contains { $0?.lowercased() == want }
    }
}

/// The app's names in the user's languages, from its InfoPlist.strings or InfoPlist.loctable.
func localizedAppNames(_ app: URL) -> [String?] {
    let res = app.appendingPathComponent("Contents/Resources")
    var langs: [String] = []
    for l in Locale.preferredLanguages {
        langs.append(l); langs.append(l.replacingOccurrences(of: "-", with: "_"))
        if let short = l.split(separator: "-").first { langs.append(String(short)) }
    }
    var tables: [[String: Any]] = langs.compactMap { NSDictionary(contentsOf: res.appendingPathComponent("\($0).lproj/InfoPlist.strings")) as? [String: Any] }
    if let loc = NSDictionary(contentsOf: res.appendingPathComponent("InfoPlist.loctable")) as? [String: Any] {
        tables += langs.compactMap { loc[$0] as? [String: Any] }
    }
    return tables.flatMap { [$0["CFBundleDisplayName"] as? String, $0["CFBundleName"] as? String] }
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
    static let queue = DispatchQueue(label: "ondra.backdrop")
    static let serialBase: UInt32 = 0x4f440000
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
        // Each helper (one per job using the computer) holds its own display, in a numbered slot
        // with a fixed serial. The system remembers where a display it has seen goes, so from the
        // second time on a slot comes up straight in its corner. A display it hasn't seen lands
        // beside the main one first, and a Dock on that side jumps onto it for a moment (the
        // Dock flicker users saw when every helper made a new one).
        let taken = Set(onlineDisplays().filter { CGDisplayVendorNumber($0) == 0x1234 && CGDisplayModelNumber($0) == 0x4f44 }.map { CGDisplaySerialNumber($0) })
        var made: CGVirtualDisplay?
        for slot in UInt32(0)..<8 where !taken.contains(Backdrop.serialBase + slot) {
            let d = CGVirtualDisplayDescriptor()
            // its own queue: the main thread is often busy with a request
            d.queue = Backdrop.queue; d.name = "Ondra"
            d.maxPixelsWide = 1920; d.maxPixelsHigh = 1200
            d.sizeInMillimeters = CGSize(width: 480, height: 300)
            d.productID = 0x4f44; d.vendorID = 0x1234; d.serialNum = Backdrop.serialBase + slot
            guard let v = CGVirtualDisplay(descriptor: d) else { continue } // another helper took it just now
            let st = CGVirtualDisplaySettings(); st.hiDPI = 0
            st.modes = [CGVirtualDisplayMode(width: 1920, height: 1200, refreshRate: 30)]
            if v.apply(st) { made = v; break }
        }
        guard let v = made else { dbgLog("display: create failed"); return false }
        let t1 = nowMs()
        while !onlineDisplays().contains(v.displayID), nowMs() - t1 < 2000 { usleep(10_000) }
        // Its place: off the bottom-right corner of the real displays, touching them only at a
        // corner, so the pointer can never wander onto it; past another job's display if one is
        // there. Saved for this set of displays, so it's already there next time.
        var corner = CGPoint(x: CGDisplayBounds(CGMainDisplayID()).maxX, y: CGDisplayBounds(CGMainDisplayID()).maxY)
        for other in onlineDisplays() where other != v.displayID && CGDisplayVendorNumber(other) == 0x1234 && CGDisplayModelNumber(other) == 0x4f44 {
            let b = CGDisplayBounds(other)
            if b.maxX > corner.x { corner = CGPoint(x: b.maxX, y: b.maxY) }
        }
        if CGDisplayBounds(v.displayID).origin != corner {
            var cfg: CGDisplayConfigRef?
            CGBeginDisplayConfiguration(&cfg)
            CGConfigureDisplayOrigin(cfg, v.displayID, Int32(corner.x), Int32(corner.y))
            CGCompleteDisplayConfiguration(cfg, .permanently)
        }
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

/// Where background copies live. ONDRA_CU_CACHE_DIR moves it (tests, so their orphan sweep
/// never meets a real job's copies).
func cacheAppsDir() -> URL {
    let override = ProcessInfo.processInfo.environment["ONDRA_CU_CACHE_DIR"].flatMap { $0.hasPrefix("/") ? $0 : nil }
    let base = override.map { URL(fileURLWithPath: $0, isDirectory: true) } ?? URL(fileURLWithPath: NSHomeDirectory())
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
func isLaunchedReal(_ pid: pid_t) -> Bool { bgLock.lock(); defer { bgLock.unlock() }; return launchedApps.contains(pid) || offscreenApps.contains(pid) }
func isOffscreenApp(_ pid: pid_t) -> Bool { bgLock.lock(); defer { bgLock.unlock() }; return offscreenApps.contains(pid) }
func bgApp(_ pid: pid_t) -> BgApp? { bgLock.lock(); defer { bgLock.unlock() }; return bgApps[pid] }

/// Spawn the copy suspended, assign it to the off-screen desktop, resume it, and run the
/// plist swap for its kind until it has checked in and a window is up (or a timeout).
func launchBackground(real: URL, copy: Copy, kind: AppKind, guardDylib: String?) -> BgApp? {
    let bd = Backdrop.shared
    guard bd.ensure() else { return nil }
    // a copy an earlier helper left running (it crashed, or an old bug) goes first
    reapOrphanCopies()
    var env = ["HOME=\(NSHomeDirectory())", "USER=\(NSUserName())", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR=\(NSTemporaryDirectory())"]
    let guarded = guardDylib != nil
    // the guard keeps every window of the app (floating panels too) on this display
    if let g = guardDylib { env.append("DYLD_INSERT_LIBRARIES=\(g)"); env.append("ONDRA_CU_BACKDROP=\(bd.displayID)") }

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

/// How long a background copy gets to quit on its own before it is killed. Some apps ignore
/// SIGTERM and refuse to quit (an unsaved-changes prompt); the copy is the job's, so it goes.
let quitGraceMs = 1200.0

/// End processes: ask each to quit (a quit Apple event and SIGTERM), all at once; after the
/// grace, SIGKILL whatever is left and wait for it to go. `alive` says whether a pid is still
/// the process meant (and reaps it when it is a child of ours), so a pid reused by another
/// process is never signalled.
func endProcesses(_ pids: [pid_t], alive: (pid_t) -> Bool) {
    var left = pids.filter(alive)
    guard !left.isEmpty else { return }
    for p in left { NSRunningApplication(processIdentifier: p)?.terminate(); kill(p, SIGTERM) }
    let t0 = nowMs()
    while !left.isEmpty, nowMs() - t0 < quitGraceMs { usleep(50_000); left = left.filter(alive) }
    guard !left.isEmpty else { return }
    dbgLog("end: \(left) did not quit in \(Int(quitGraceMs))ms, killing")
    for p in left { kill(p, SIGKILL) }
    let t1 = nowMs()
    while !left.isEmpty, nowMs() - t1 < 2000 { usleep(20_000); left = left.filter(alive) }
}

/// A process this helper spawned is still running (a zombie is reaped here, and counts as gone;
/// one already reaped elsewhere is no longer ours).
func childAlive(_ pid: pid_t) -> Bool {
    var st: Int32 = 0
    return waitpid(pid, &st, WNOHANG) == 0
}

/// Terminate a background app the job opened, and clean up its copy.
func releaseBackground(_ pid: pid_t) { releaseBackgrounds([pid]) }

/// Several at once. Each stays in bgApps until it is really gone, so if the helper is told to
/// stop while one is still being waited for, its exit path (releaseAllBackground) still sees
/// it and kills it, instead of exiting and leaving it running on the user's screen.
func releaseBackgrounds(_ pids: [pid_t]) {
    bgLock.lock()
    let apps = pids.compactMap { bgApps[$0] }
    var fds: [Int32] = []
    for app in apps {
        fds += [app.cdpIn, app.cdpOut].filter { $0 >= 0 }
        app.cdpIn = -1; app.cdpOut = -1
    }
    bgLock.unlock()
    guard !apps.isEmpty else { return }
    for fd in fds { close(fd) }
    let t0 = nowMs()
    endProcesses(apps.map(\.pid), alive: childAlive)
    bgLock.lock(); let gone = apps.filter { bgApps.removeValue(forKey: $0.pid) != nil }; bgLock.unlock()
    dbgLog("release: \(apps.map(\.pid)) ended after \(Int(nowMs() - t0))ms")
    for app in gone { teardownCopy(app.copyURL) }
    if !gone.isEmpty { dbgLog("release: copies cleaned up after \(Int(nowMs() - t0))ms") }
}

func releaseAllBackground() {
    bgLock.lock(); let pids = Array(bgApps.keys); let real = Array(launchedApps.union(offscreenApps)); bgLock.unlock()
    releaseBackgrounds(pids)
    // a real app the job opened is quit before the display goes away
    DispatchQueue.concurrentPerform(iterations: real.count) { releaseReal(real[$0]) }
}

// ───────────────────────── orphaned copies ─────────────────────────
// A copy runs as this helper's child, so when a helper is gone (it crashed, was killed, or an
// older build exited while a copy was still quitting) its copies are reparented to launchd and
// nobody will ever stop them: they stay on the user's screen once the off-screen display goes.
// Found by the program they run (a path inside the copies folder, never a name) and their
// parent (launchd), so a copy another live helper is driving, and the user's real apps, are
// never touched.

/// The path the process was started with (exec path from KERN_PROCARGS2). For a copy this is
/// the path inside the copies folder even when its executable is a symlink to the real app's.
func execPath(_ pid: pid_t) -> String? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 4 else { return nil }
    var buf = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &buf, &size, nil, 0) == 0, size > 4 else { return nil }
    var i = 4
    while i < size, buf[i] != 0 { i += 1 }
    return i > 4 ? String(decoding: buf[4..<i], as: UTF8.self) : nil
}

func isOrphanCopy(_ pid: pid_t, under dirs: [String]) -> Bool {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
          info.pbi_ppid == 1, info.pbi_uid == getuid(), let exe = execPath(pid) else { return false }
    return dirs.contains { exe.hasPrefix($0) }
}

/// Kill every orphaned copy. Returns how many there were.
@discardableResult func reapOrphanCopies() -> Int {
    let dir = cacheAppsDir()
    let dirs = Array(Set([dir.path, dir.resolvingSymlinksInPath().path].map { $0.hasSuffix("/") ? $0 : $0 + "/" }))
    let me = getpid()
    let orphans = allPids().filter { $0 != me && $0 > 1 && isOrphanCopy($0, under: dirs) }
    guard !orphans.isEmpty else { return 0 }
    dbgLog("orphans: \(orphans)")
    endProcesses(orphans) { isOrphanCopy($0, under: dirs) }
    return orphans.count
}

/// A real app the job opened: quit it, so its Dock tile stops showing it running. If the user
/// has since brought it to the front it is theirs and stays; if it doesn't quit (a question
/// about unsaved work), it is hidden instead.
func releaseReal(_ pid: pid_t) {
    bgLock.lock(); let launched = launchedApps.remove(pid) != nil; offscreenApps.remove(pid); bgLock.unlock()
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated else { return }
    if app.isActive { return }
    if launched {
        app.terminate()
        let t0 = nowMs()
        while !app.isTerminated, nowMs() - t0 < 3000 { usleep(50_000) }
        if app.isTerminated { return }
    }
    app.hide()
}

// ───────────────────────── real app, off-screen ─────────────────────────
// Apps that can't run from a background copy (Safari web apps, Catalyst, App Store, system
// apps) run as the real app: a regular app, so its Dock tile shows it running. It is still kept
// off the user's screen: launched hidden, caught the moment its process exists and put on the
// off-screen desktop before its first window, then shown there, so its windows are drawn at
// full size (not a Stage Manager thumbnail) and pointer and key events reach them.

/// real apps the job showed on the off-screen display
var offscreenApps: Set<pid_t> = []
/// real apps the job opened (not ones the user already had open): quit on release
var launchedApps: Set<pid_t> = []

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
              // never the helper's own pointer window: setting its frame over AX from this thread
              // is AppKit off the main thread, and the helper crashes (leaving its copies behind)
              owner != getpid(),
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
    // release answers without it: reading the user's app over AX can be slow when it is busy
    let before: [String: Any] = op == "release" ? ["frontmostPid": NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) } ?? -1] : environment()

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
        let aboveAtLaunch = pidsAboveFront()
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
            // an app already open is only attached to: opening it again would reopen it, and
            // macOS brings its windows up over the user's
            if alreadyOpen, let app = NSWorkspace.shared.runningApplications.first(where: {
                $0.bundleURL?.standardizedFileURL == target.standardizedFileURL }) {
                pid = app.processIdentifier
            } else {
                let sem = DispatchSemaphore(value: 0)
                var out: (pid_t?, String?) = (nil, nil)
                launchHidden(name, hide: hide) { p, e in out = (p, e); sem.signal() }
                sem.wait()
                pid = out.0; launchErr = out.1 ?? launchErr
            }
            mode = alreadyOpen ? "attached" : "hidden"
            if let c = catcher {
                for _ in 0..<40 where c.caught == 0 { usleep(25_000) }
                c.stop()
                // its windows opened off-screen: show them there (full size, never on the user's screen)
                if let p = pid, c.caught == p, showOffscreen(p) { mode = "offscreen" }
            }
            if !alreadyOpen, let p = pid { bgLock.lock(); launchedApps.insert(p); bgLock.unlock() }
        }
        if let held = held { keepFrame(held) }
        // turning on an app's accessibility (Chromium) or showing its windows can order one up
        if let p = pid {
            askForWebAccessibility(p)
            _ = keepUserWindowOnTop(p, aboveAtLaunch)
            // a panel the copy put up on the user's display at launch goes off-screen with the rest
            if bgApp(p) != nil { keepOffUserScreen(p) }
        }
        // an app the user opened themselves may have come up off-screen (apps remember their
        // frame): put any such window back where the user can see it
        rescueStrayWindows()
        // the app it started coming to the front (a stage switch under Stage Manager) is undone:
        // the user's app and its stage come back to the front
        let stageRestored = restoreUserStage(before["frontmostPid"] as? Int, since: t0)
        let after = environment()
        if let pid = pid {
            let preserved = backgroundPreserved(before, after)
            // the user's own mouse or keys while the app was starting are theirs, not the launch's
            var result: [String: Any] = ["pid": Int(pid), "path": target.path, "mode": mode, "kind": kind.rawValue, "env": after, "envBefore": before, "backgroundPreserved": preserved]
            if let r = stageRestored { result["stageRestored"] = r }
            let menus = menuBarTitles(pid)
            if !menus.isEmpty { result["menus"] = menus }
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
        let aboveBefore = pidsAboveFront()
        do { info = try performAction(pid: pid_t(pidN), action: action, map: map) }
        catch ActError.message(let code, let msg) { _ = keepUserWindowOnTop(pid_t(pidN), aboveBefore); return fail(id, code, msg) }
        catch { return fail(id, "ACT_FAILED", "\(error)") }
        var raised = keepUserWindowOnTop(pid_t(pidN), aboveBefore)
        // settle on the app's own notifications, then re-observe in the same round trip
        let settleMs = settle(pid: pid_t(pidN))
        if let late = keepUserWindowOnTop(pid_t(pidN), aboveBefore) { raised = (raised ?? true) && late }
        if let r = raised {
            info["raisedOverUser"] = true; info["orderRestored"] = r
            raisesOnPointer.insert(pid_t(pidN))
        }
        // a panel the action made the copy show (a drop panel during a drag) goes off-screen
        if bgApp(pid_t(pidN)) != nil, keepOffUserScreen(pid_t(pidN)) > 0 { info["panelKeptOffScreen"] = true }

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
        } else if let r = restoreUserStage(before["frontmostPid"] as? Int, since: t0) {
            // another app came forward (a Stage Manager switch): the user's stage comes back
            extra["stageRestored"] = r
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
        let t0 = nowMs()
        // a background copy the job opened is terminated and cleaned up; a real app it opened is
        // quit; the user's own app is hidden again if it was shown
        if bgApp(pid_t(pidN)) != nil { releaseBackground(pid_t(pidN)) }
        else if isLaunchedReal(pid_t(pidN)) { releaseReal(pid_t(pidN)) }
        else { hideAgain(pid_t(pidN)) }
        rescueStrayWindows()
        return ok(id, ["released": true, "releaseMs": nowMs() - t0])
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

/// A background copy's window that came up on the user's screen — a floating panel the app put
/// on the main display or at the pointer (orderFrontRegardless at a floating or status level,
/// which no raise of the user's window can cover), a tooltip, a window an unguarded app moved —
/// goes onto the off-screen display with the rest of the app, at the same place relative to its
/// display, so it stays drawn, capturable and reachable by AX. The guard does this inside the app
/// before the window is ever shown; this is the backstop for apps without it. Menu bar items are
/// left alone. Returns how many windows were moved.
@discardableResult func keepOffUserScreen(_ pid: pid_t) -> Int {
    let bd = Backdrop.shared
    guard bd.displayID != 0 else { return 0 }
    let infos = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let stray = infos.contains { w in
        guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, ((w[kCGWindowAlpha as String] as? Double) ?? 1) > 0,
              let b = w[kCGWindowBounds as String] as? NSDictionary, let r = CGRect(dictionaryRepresentation: b),
              r.width > 1, r.height > 1, !bd.contains(r) else { return false }
        let layer = (w[kCGWindowLayer as String] as? Int) ?? 0
        let menuBar = (layer == Int(CGWindowLevelForKey(.mainMenuWindow)) || layer == Int(CGWindowLevelForKey(.statusWindow))) && r.height <= 50
        return !menuBar
    }
    guard stray else { return 0 }
    let target = CGDisplayBounds(bd.displayID)
    var winsRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(AXUIElementCreateApplication(pid), kAXWindowsAttribute as CFString, &winsRef) == .success,
          let wins = winsRef as? [AXUIElement] else { return 0 }
    var moved = 0
    for win in wins {
        guard let f = axFrame(win), f.width > 1, f.height > 1, !bd.contains(f) else { continue }
        let center = CGPoint(x: f.midX, y: f.midY)
        let from = onlineDisplays().map { CGDisplayBounds($0) }.first { $0.contains(center) } ?? CGDisplayBounds(CGMainDisplayID())
        var origin = CGPoint(x: target.minX + (f.minX - from.minX), y: target.minY + (f.minY - from.minY))
        origin.x = max(target.minX, min(origin.x, target.maxX - min(f.width, target.width)))
        origin.y = max(target.minY, min(origin.y, target.maxY - min(f.height, target.height)))
        if let pv = AXValueCreate(.cgPoint, &origin), AXUIElementSetAttributeValue(win, kAXPositionAttribute as CFString, pv) == .success { moved += 1 }
    }
    if moved > 0 { dbgLog("kept \(moved) window(s) of \(pid) off the user's screen") }
    return moved
}

/// Watches the background copies while the helper runs: a copy can put a panel up at any time
/// (a global drag monitor, a timer), not only during an action.
func startWindowKeeper() {
    Thread.detachNewThread {
        while true {
            usleep(250_000)
            bgLock.lock(); let pids = Array(bgApps.keys); bgLock.unlock()
            for p in pids { keepOffUserScreen(p) }
        }
    }
}

/// Stage Manager: an app the job runs coming to the front (the app starting, a window of it
/// ordering itself in) switches stages, and the user's windows shrink into the side strip. If an
/// app of this helper's took the front and the user's own mouse or keys did not do it, the user's
/// app is brought back to the front, and with it their stage. Only then: a front change to any
/// other app can't be told from the user's or another program's doing (other tools activate their
/// own windows too), so it is left alone. nil: nothing to restore; else whether it came back.
func restoreUserStage(_ wasFront: Int?, since t0: Double) -> Bool? {
    guard let was = wasFront, was > 0,
          let now = NSWorkspace.shared.frontmostApplication?.processIdentifier, Int(now) != was,
          bgApp(now) != nil || isLaunchedReal(now),
          !userInputSince(seconds: (nowMs() - t0) / 1000),
          let prev = NSRunningApplication(processIdentifier: pid_t(was)), !prev.isTerminated else { return nil }
    dbgLog("stage: front went \(was) → \(now), giving it back")
    return giveFrontBack(to: pid_t(was), from: now)
}

/// Apps with a normal window in front of the front app's front window, front to back.
func pidsAboveFront() -> Set<Int32> {
    guard let front = NSWorkspace.shared.frontmostApplication?.processIdentifier,
          let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
    var above = Set<Int32>()
    for w in info {
        guard (w[kCGWindowLayer as String] as? Int) == 0, let p = w[kCGWindowOwnerPID as String] as? Int32 else { continue }
        if p == front { return above }
        if ((w[kCGWindowAlpha as String] as? Double) ?? 1) > 0 { above.insert(p) }
    }
    return above
}

/// Some apps (Electron, LibreOffice) order their window to the top when a click reaches
/// them, even in the background and without activating. When `target` newly sits in front
/// of the user's front window, raise the user's window back over it (the front app stays
/// active, so focus is untouched). nil: nothing was raised; else whether order came back.
func keepUserWindowOnTop(_ target: pid_t, _ before: Set<Int32>) -> Bool? {
    guard !before.contains(target), pidsAboveFront().contains(target),
          let front = NSWorkspace.shared.frontmostApplication?.processIdentifier, front != target else { return nil }
    let app = AXUIElementCreateApplication(front)
    var w: CFTypeRef?
    for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] where w == nil {
        if AXUIElementCopyAttributeValue(app, attr as CFString, &w) != .success { w = nil }
    }
    guard let win = w, CFGetTypeID(win) == AXUIElementGetTypeID() else { return false }
    _ = AXUIElementPerformAction(win as! AXUIElement, kAXRaiseAction as CFString)
    for _ in 0..<10 {
        if !pidsAboveFront().contains(target) { return true }
        usleep(10_000)
    }
    return false
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

// ───────────────────────── permission guide ─────────────────────────
// `--guide accessibility|screen --app <Ondra.app> --title <t> --sub <s>`: a small panel laid
// over the bottom of System Settings while it shows the privacy list, holding Ondra's tile to
// drag into the list ("Ondra를 손쉬운 사용 목록에 끌어다 놓으세요 · 그다음 켜세요"). It shows only while
// System Settings is in front and quits once the permission is on (checked for the process that
// launched it: Ondra), when System Settings goes away, or after ten minutes.

/// The app's tile: drag it out and the list gets the app's file.
final class DragTile: NSView, NSDraggingSource {
    let url: URL
    init(url: URL, name: String) {
        self.url = url
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 10
        layer?.backgroundColor = NSColor.white.withAlphaComponent(0.06).cgColor
        layer?.borderColor = NSColor.white.withAlphaComponent(0.09).cgColor
        layer?.borderWidth = 1
        let icon = NSImageView(image: NSWorkspace.shared.icon(forFile: url.path))
        icon.imageScaling = .scaleProportionallyUpOrDown
        let label = NSTextField(labelWithString: name)
        label.font = .systemFont(ofSize: 14, weight: .semibold)
        label.textColor = .labelColor
        for v in [icon, label] { v.translatesAutoresizingMaskIntoConstraints = false; addSubview(v) }
        NSLayoutConstraint.activate([
            icon.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12), icon.centerYAnchor.constraint(equalTo: centerYAnchor),
            icon.widthAnchor.constraint(equalToConstant: 28), icon.heightAnchor.constraint(equalToConstant: 28),
            label.leadingAnchor.constraint(equalTo: icon.trailingAnchor, constant: 10), label.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }
    required init?(coder: NSCoder) { fatalError() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }
    override func mouseDown(with event: NSEvent) {}
    override func mouseDragged(with event: NSEvent) {
        let item = NSDraggingItem(pasteboardWriter: url as NSURL)
        let image = NSImage(size: bounds.size, flipped: false) { _ in
            if let rep = self.bitmapImageRepForCachingDisplay(in: self.bounds) {
                self.cacheDisplay(in: self.bounds, to: rep); rep.draw(in: self.bounds)
            }
            return true
        }
        item.setDraggingFrame(bounds, contents: image)
        beginDraggingSession(with: [item], event: event, source: self)
    }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
}

final class GuidePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

func runGuide(_ args: [String]) -> Never {
    func arg(_ k: String) -> String? { args.firstIndex(of: k).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil } }
    let pane = args.first(where: { $0 == "accessibility" || $0 == "screen" }) ?? "accessibility"
    guard let appPath = arg("--app") else { exit(2) }
    let url = URL(fileURLWithPath: appPath)
    let name = (Bundle(url: url)?.infoDictionary?["CFBundleName"] as? String) ?? url.deletingPathExtension().lastPathComponent
    let title = arg("--title") ?? "Drag \(name) into the list", sub = arg("--sub") ?? "Then turn it on."
    let granted = { pane == "screen" ? CGPreflightScreenCaptureAccess() : AXIsProcessTrusted() }
    // a frame to sit on instead of System Settings' window (tests)
    let testFrame = ProcessInfo.processInfo.environment["ONDRA_GUIDE_FRAME"].map { s -> CGRect in
        let n = s.split(separator: ",").compactMap { Double($0) }; return CGRect(x: n[0], y: n[1], width: n[2], height: n[3])
    }

    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let W: CGFloat = 420, H: CGFloat = 132
    let panel = GuidePanel(contentRect: NSRect(x: 0, y: 0, width: W, height: H), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    panel.isOpaque = false; panel.backgroundColor = .clear; panel.hasShadow = true
    panel.level = .floating; panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
    panel.appearance = NSAppearance(named: .darkAqua)
    let bg = NSView(frame: NSRect(x: 0, y: 0, width: W, height: H))
    bg.wantsLayer = true; bg.layer?.cornerRadius = 12; bg.layer?.masksToBounds = true
    bg.layer?.backgroundColor = NSColor(white: 0.11, alpha: 0.98).cgColor
    bg.layer?.borderColor = NSColor.white.withAlphaComponent(0.08).cgColor; bg.layer?.borderWidth = 1
    panel.contentView = bg

    let badge = NSView(); badge.wantsLayer = true
    badge.layer?.cornerRadius = 16; badge.layer?.backgroundColor = NSColor.systemBlue.withAlphaComponent(0.18).cgColor
    let arrow = NSImageView(image: NSImage(systemSymbolName: "arrow.up", accessibilityDescription: nil) ?? NSImage())
    arrow.symbolConfiguration = .init(pointSize: 14, weight: .semibold); arrow.contentTintColor = .systemBlue
    let t1 = NSTextField(labelWithString: title); t1.font = .systemFont(ofSize: 14, weight: .semibold); t1.textColor = .labelColor
    let t2 = NSTextField(labelWithString: sub); t2.font = .systemFont(ofSize: 12.5); t2.textColor = .secondaryLabelColor
    for l in [t1, t2] { l.lineBreakMode = .byTruncatingTail; l.maximumNumberOfLines = 1 }
    let tile = DragTile(url: url, name: name)
    for v in [badge, arrow, t1, t2, tile] as [NSView] { v.translatesAutoresizingMaskIntoConstraints = false; bg.addSubview(v) }
    NSLayoutConstraint.activate([
        badge.leadingAnchor.constraint(equalTo: bg.leadingAnchor, constant: 16), badge.topAnchor.constraint(equalTo: bg.topAnchor, constant: 16),
        badge.widthAnchor.constraint(equalToConstant: 32), badge.heightAnchor.constraint(equalToConstant: 32),
        arrow.centerXAnchor.constraint(equalTo: badge.centerXAnchor), arrow.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
        t1.leadingAnchor.constraint(equalTo: badge.trailingAnchor, constant: 12), t1.trailingAnchor.constraint(lessThanOrEqualTo: bg.trailingAnchor, constant: -16),
        t1.topAnchor.constraint(equalTo: bg.topAnchor, constant: 15),
        t2.leadingAnchor.constraint(equalTo: t1.leadingAnchor), t2.trailingAnchor.constraint(lessThanOrEqualTo: bg.trailingAnchor, constant: -16),
        t2.topAnchor.constraint(equalTo: t1.bottomAnchor, constant: 2),
        tile.leadingAnchor.constraint(equalTo: bg.leadingAnchor, constant: 16), tile.trailingAnchor.constraint(equalTo: bg.trailingAnchor, constant: -16),
        tile.bottomAnchor.constraint(equalTo: bg.bottomAnchor, constant: -16), tile.heightAnchor.constraint(equalToConstant: 48),
    ])

    let started = Date()
    var settingsSeen = Date()
    func settingsWindow() -> CGRect? {
        if let f = testFrame { return f }
        guard let pid = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first?.processIdentifier else { return nil }
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
        return list.filter { ($0[kCGWindowOwnerPID as String] as? pid_t) == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
            .compactMap { w -> CGRect? in
                guard let b = w[kCGWindowBounds as String] as? NSDictionary else { return nil }
                return CGRect(dictionaryRepresentation: b)
            }
            .max { $0.width * $0.height < $1.width * $1.height }
    }
    let tick = Timer(timeInterval: 0.25, repeats: true) { _ in
        if (testFrame == nil && granted()) || Date().timeIntervalSince(started) > 600 { exit(0) }
        let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        guard let win = settingsWindow() else {
            panel.orderOut(nil)
            // System Settings closed (a moment's grace while it opens)
            if Date().timeIntervalSince(settingsSeen) > 4 { exit(0) }
            return
        }
        settingsSeen = Date()
        guard testFrame != nil || front == "com.apple.systempreferences" else { panel.orderOut(nil); return }
        // over the bottom of the list column, edge to edge with its cards: they start 269pt in from
        // the window's left (past the sidebar) and stop 21pt short of its right (the scroller)
        let left: CGFloat = 269, right: CGFloat = 21, bottom: CGFloat = 20
        let w = max(W, win.width - left - right)
        let x = win.width - left - right >= W ? win.minX + left : win.midX - W / 2
        let top = NSScreen.screens.first?.frame.maxY ?? 0
        let frame = NSRect(x: x, y: top - (win.maxY - bottom), width: w, height: H)
        if panel.frame != frame { panel.setFrame(frame, display: true) }
        if !panel.isVisible { panel.orderFrontRegardless() }
    }
    RunLoop.main.add(tick, forMode: .common)
    tick.fire()
    app.run()
    exit(0)
}

// ───────────────────────── main loop ─────────────────────────

if CommandLine.arguments.contains("--guide") { runGuide(CommandLine.arguments) }

if CommandLine.arguments.contains("--version") {
    print("ondra-cuhost 0.4.6")
    exit(0)
}

// One-shot queries for scripts (skills/computer-use/shot-check.sh), one JSON line each:
//   --windows <App>  → {"windows":[{"title","bounds":{x,y,width,height},"accessible":true}]}
//                      the app's windows as Accessibility sees them (real size, not a
//                      Stage Manager thumbnail); empty when the app is not running
//   --displays       → {"displays":[{"width","height","scale","main"}]} in points
if let i = CommandLine.arguments.firstIndex(of: "--windows") {
    let name = i + 1 < CommandLine.arguments.count ? CommandLine.arguments[i + 1].lowercased() : ""
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 1.5)
    var wins: [[String: Any]] = []
    let apps = NSWorkspace.shared.runningApplications.filter {
        ($0.localizedName ?? "").lowercased() == name || ($0.bundleIdentifier ?? "").lowercased() == name
    }
    for app in apps {
        let ax = AXUIElementCreateApplication(app.processIdentifier)
        var list: CFTypeRef?
        guard AXUIElementCopyAttributeValue(ax, kAXWindowsAttribute as CFString, &list) == .success, let ws = list as? [AXUIElement] else { continue }
        for w in ws {
            var pos = CGPoint.zero, size = CGSize.zero
            var v: CFTypeRef?
            if AXUIElementCopyAttributeValue(w, kAXPositionAttribute as CFString, &v) == .success, let v { AXValueGetValue(v as! AXValue, .cgPoint, &pos) }
            if AXUIElementCopyAttributeValue(w, kAXSizeAttribute as CFString, &v) == .success, let v { AXValueGetValue(v as! AXValue, .cgSize, &size) }
            var t: CFTypeRef?
            let title = AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &t) == .success ? (t as? String ?? "") : ""
            wins.append(["title": title, "pid": Int(app.processIdentifier), "accessible": true,
                         "bounds": ["x": Double(pos.x), "y": Double(pos.y), "width": Double(size.width), "height": Double(size.height)]])
        }
    }
    print(jsonLine(["windows": wins]))
    exit(0)
}
if CommandLine.arguments.contains("--displays") {
    let main = NSScreen.main
    let displays: [[String: Any]] = NSScreen.screens.map {
        ["width": Double($0.frame.width), "height": Double($0.frame.height), "scale": Double($0.backingScaleFactor), "main": $0 == main]
    }.sorted { ($0["main"] as? Bool ?? false) && !($1["main"] as? Bool ?? false) }
    print(jsonLine(["displays": displays]))
    exit(0)
}

/// The helper's last act, once, whichever way it is stopped: end every app the job opened (all
/// at once, each killed if it won't quit) before the off-screen display goes with the process.
/// A window still on that display would land on the user's screen, and under Stage Manager that
/// switches the user's stage. A second stop while this runs waits on the lock until exit(0).
let shutdownLock = NSLock()
func shutdown() -> Never {
    shutdownLock.lock()
    let t0 = nowMs()
    releaseAllBackground()
    hideAllAgain()
    dbgLog("shutdown: apps ended after \(Int(nowMs() - t0))ms")
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
    shutdown()
}
worker.stackSize = 8 << 20
worker.start()
// a copy an earlier helper left running (it crashed or was killed) goes now, not at the next launch
DispatchQueue.global(qos: .utility).async { reapOrphanCopies() }
startWindowKeeper()
// Stopped (stdin closed, or SIGTERM/SIGHUP/SIGINT): everything the job opened goes first.
var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGHUP, SIGINT] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: .global(qos: .userInitiated))
    source.setEventHandler { shutdown() }
    source.resume()
    signalSources.append(source)
}
// No Dock icon, no menu bar, never activated: windows only for the pointer overlay.
NSApplication.shared.setActivationPolicy(.accessory)
NSApplication.shared.run()
