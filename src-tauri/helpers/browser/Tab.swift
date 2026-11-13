// One page (tab) a session is attached to: what its events tell us, kept for commands.

import Foundation

struct RefEntry {
    let backendId: Int
    let role: String
    let name: String
}

struct NetRequest {
    let id: String
    var url: String
    var method: String
    var resourceType: String
    var headers: JSON
    var postData: String?
    var status: Int?
    var mimeType: String?
    var responseHeaders: JSON?
    var failed: String?
    var finished = false
    let timestamp: Double
}

final class Tab {
    let targetId: String
    let sessionId: String
    let lock = NSLock()

    // what the page is
    var url = ""
    var title = ""
    var mainFrameId: String?
    /// lifecycle events seen, per loader
    var lifecycle: [String: Set<String>] = [:]
    var loaderId: String?
    /// main-frame navigations committed so far (a wait can tell a new document from the old one)
    var navigations = 0
    var gone = false

    // refs from looks: ref → node, node → ref
    var refs: [String: RefEntry] = [:]
    var refOf: [Int: String] = [:]
    var nextRef = 1

    // network
    var requests: [String: NetRequest] = [:]
    var order: [String] = []
    var inflight: Set<String> = []
    var lastNet = nowMs()

    // logs
    var console: [JSON] = []
    var errors: [JSON] = []

    /// the last snapshot's lines, per way of taking it (for --delta)
    var lastSnapshot: [String: [String]] = [:]

    // input
    var mouse = (x: 0.0, y: 0.0)

    // screencast
    var screencasting = false
    var lastFrame: (data: String, meta: JSON)?

    init(targetId: String, sessionId: String) {
        self.targetId = targetId
        self.sessionId = sessionId
    }

    func with<R>(_ f: () throws -> R) rethrows -> R {
        lock.lock(); defer { lock.unlock() }
        return try f()
    }

    func resetRefs() {
        refs = [:]
        refOf = [:]
        nextRef = 1
    }

    /// The ref for a node, made on first sight.
    func ref(for backendId: Int, role: String, name: String) -> String {
        if let r = refOf[backendId] {
            refs[r] = RefEntry(backendId: backendId, role: role, name: name)
            return r
        }
        let r = "e\(nextRef)"
        nextRef += 1
        refOf[backendId] = r
        refs[r] = RefEntry(backendId: backendId, role: role, name: name)
        return r
    }

    /// Events for this tab's CDP session (called on the event queue).
    func handle(_ method: String, _ p: JSON) {
        lock.lock(); defer { lock.unlock() }
        switch method {
        case "Page.lifecycleEvent":
            guard p.str("frameId") == mainFrameId || mainFrameId == nil, let loader = p.str("loaderId"), let name = p.str("name") else { return }
            if name == "init" { lifecycle[loader] = []; loaderId = loader }
            lifecycle[loader, default: []].insert(name)
            if lifecycle.count > 20 { lifecycle = lifecycle.filter { $0.key == loaderId } }
        case "Page.frameNavigated":
            guard let f = p.obj("frame"), f.str("parentId") == nil else { return }
            mainFrameId = f.str("id")
            navigations += 1
            url = (f.str("url") ?? "") + (f.str("urlFragment") ?? "")
            if let l = f.str("loaderId") { loaderId = l }
            resetRefs()
            lastSnapshot = [:]
            console = []
            errors = []
        case "Page.navigatedWithinDocument":
            if p.str("frameId") == mainFrameId, let u = p.str("url") { url = u }
        case "Runtime.consoleAPICalled":
            let args = p.arr("args") as? [JSON] ?? []
            let text = args.map(remoteText).joined(separator: " ")
            var type = p.str("type") ?? "log"
            if type == "warning" { type = "warn" }
            console.append(["type": type, "text": text, "args": args.map { ["type": $0.str("type") ?? "", "value": $0["value"] ?? NSNull()] }])
            if console.count > 1000 { console.removeFirst(console.count - 1000) }
        case "Runtime.exceptionThrown":
            let d = p.obj("exceptionDetails") ?? [:]
            let text = d.obj("exception")?.str("description") ?? d.str("text") ?? "error"
            errors.append(["text": text, "line": d["lineNumber"] ?? NSNull(), "column": d["columnNumber"] ?? NSNull(), "url": d["url"] ?? NSNull()])
            if errors.count > 500 { errors.removeFirst(errors.count - 500) }
        case "Network.requestWillBeSent":
            guard let id = p.str("requestId"), let r = p.obj("request") else { return }
            let type = p.str("type") ?? "Other"
            if requests[id] == nil { order.append(id) }
            // a redirect reuses the id: keep the latest hop
            requests[id] = NetRequest(id: id, url: r.str("url") ?? "", method: r.str("method") ?? "GET", resourceType: type,
                                      headers: r.obj("headers") ?? [:], postData: r.str("postData"), timestamp: (p.dbl("wallTime") ?? Date().timeIntervalSince1970) * 1000)
            if type != "WebSocket" && type != "EventSource" { inflight.insert(id) }
            lastNet = nowMs()
            // the newest 500 (a few page loads); each keeps its headers
            if order.count > 500 {
                for old in order.prefix(order.count - 500) { requests[old] = nil }
                order.removeFirst(order.count - 500)
            }
        case "Network.responseReceived":
            guard let id = p.str("requestId"), let r = p.obj("response") else { return }
            requests[id]?.status = r.int("status")
            requests[id]?.mimeType = r.str("mimeType")
            requests[id]?.responseHeaders = r.obj("headers")
            lastNet = nowMs()
        case "Network.loadingFinished":
            guard let id = p.str("requestId") else { return }
            requests[id]?.finished = true
            inflight.remove(id)
            lastNet = nowMs()
        case "Network.loadingFailed":
            guard let id = p.str("requestId") else { return }
            requests[id]?.failed = p.str("errorText") ?? "failed"
            requests[id]?.finished = true
            inflight.remove(id)
            lastNet = nowMs()
        default:
            break
        }
    }
}

/// A console argument as text, the way DevTools shows it briefly.
func remoteText(_ o: JSON) -> String {
    if let v = o["value"] {
        if let s = v as? String { return s }
        if v is NSNull { return "null" }
        return jsonString(v)
    }
    if let u = o.str("unserializableValue") { return u }
    if o.str("type") == "undefined" { return "undefined" }
    return o.str("description") ?? o.str("type") ?? ""
}
