// A session's daemon: one CDP connection, the session's tab(s), refs, logs, routes and the
// live stream. The CLI talks to it over a Unix socket; commands run one at a time.

import Foundation

struct Config {
    let session: String
    let cdp: String?
    let pin: Bool
    let idleMs: Double
    let executable: String?
    let initScripts: [String]
    let keychain: String?
    let streamPort: UInt16

    static func fromEnv(session: String, cdp: String?, pin: Bool) -> Config {
        let env = ProcessInfo.processInfo.environment
        let idle = env["ONDRA_BROWSER_IDLE_TIMEOUT_MS"].flatMap(Double.init) ?? 30 * 60 * 1000
        let scripts = (env["ONDRA_BROWSER_INIT_SCRIPTS"] ?? "").split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return Config(session: session, cdp: cdp, pin: pin, idleMs: idle,
                      executable: env["ONDRA_BROWSER_EXECUTABLE_PATH"], initScripts: scripts,
                      keychain: env["ONDRA_BROWSER_KEYCHAIN"], streamPort: UInt16(env["ONDRA_BROWSER_STREAM_PORT"] ?? "") ?? 0)
    }
}

struct Route {
    let pattern: String
    let abort: Bool
    let body: String?
    let allowOrigin: String?
    let types: Set<String>
}

/// What the client sent.
struct Request {
    let args: [String]
    let cwd: String
    let stdin: String?
}

/// One command's outcome: `data` for --json, `text` for people.
struct Outcome {
    var data: JSON
    var text: String
    init(_ data: JSON = [:], _ text: String = "✓ Done") { self.data = data; self.text = text }
}

final class Daemon {
    let config: Config
    let cdp: CDP
    private var chrome: Process?
    private var profileDir: String?
    let q = DispatchQueue(label: "ondra-browser.commands", autoreleaseFrequency: .workItem)
    let lock = NSRecursiveLock()

    var tabs: [String: Tab] = [:]          // by CDP session id
    var active: Tab?
    var tabIds: [String: Int] = [:]        // targetId → tN
    var nextTabId = 1
    var routes: [Route] = []
    var media: [JSON] = []
    var colorScheme: String?
    var extraHeaders: JSON = [:]
    var offline = false
    var viewport: JSON?
    var geo: JSON?
    var userAgent: String?
    var lastUse = nowMs()
    /// when the tabs were last tidied (see `tidy`)
    var tidiedAt = 0.0
    var stream: StreamServer?
    var recorder: Recorder?
    var downloads: [String: JSON] = [:]
    /// inode of the socket this daemon listens on
    var ownSocket: ino_t = 0

    init(config: Config) throws {
        self.config = config
        var endpoint = config.cdp
        if endpoint == nil {
            let (proc, port, profile) = try Daemon.launchChrome(config)
            chrome = proc
            profileDir = profile
            endpoint = String(port)
        }
        cdp = try CDP(endpoint: endpoint!)
        cdp.onEvent = { [weak self] m, p, s in self?.event(m, p, s) }
        cdp.onClose = { [weak self] in self?.browserGone() }
        try cdp.call("Target.setDiscoverTargets", ["discover": true])
        stream = try? StreamServer(daemon: self, port: config.streamPort)
    }

    // ───────────── a browser of its own (no shared one given) ─────────────

    static func chromePath(_ config: Config) -> String? {
        var options: [String] = []
        if let e = config.executable { options.append(e) }
        options += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                    "/Applications/Chromium.app/Contents/MacOS/Chromium",
                    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]
        return options.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    static func launchChrome(_ config: Config) throws -> (Process, Int, String) {
        guard let exe = chromePath(config) else {
            throw BrowserError("No Chrome found: set ONDRA_BROWSER_EXECUTABLE_PATH or ONDRA_BROWSER_CDP")
        }
        let profile = "\(baseDir)/\(safeName(config.session))-profile"
        try? FileManager.default.removeItem(atPath: profile)
        try FileManager.default.createDirectory(atPath: profile, withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: exe)
        var args = ["--user-data-dir=\(profile)", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1",
                    "--use-mock-keychain", "--password-store=basic", "--no-first-run", "--no-default-browser-check",
                    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
                    "--disable-renderer-backgrounding", "--window-size=1280,800"]
        if !exe.hasSuffix("chrome-headless-shell") { args.append("--headless=new") }
        args.append("about:blank")
        p.arguments = args
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try p.run()
        let file = "\(profile)/DevToolsActivePort"
        let port: Int = try poll(timeoutMs: 20000, what: "Chrome to start") {
            if !p.isRunning { throw BrowserError("Chrome exited right after starting") }
            guard let t = try? String(contentsOfFile: file, encoding: .utf8), let first = t.split(separator: "\n").first else { return nil }
            return Int(first)
        }
        return (p, port, profile)
    }

    // ───────────── lifetime ─────────────

    func browserGone() {
        log("the browser connection closed")
        shutdown(code: 0)
    }

    func shutdown(code: Int32) {
        recorder?.stop()
        stream?.stop()
        if let c = chrome, c.isRunning {
            c.terminate()
            let until = nowMs() + 3000
            while c.isRunning && nowMs() < until { sleepMs(50) }
            if c.isRunning { kill(c.processIdentifier, SIGKILL) }
        }
        if let p = profileDir { try? FileManager.default.removeItem(atPath: p) }
        let _ = releaseSocket()
        var st = readState(config.session)
        if st.int("pid") == Int(getpid()) {
            st["pid"] = nil
            writeState(config.session, st)
        }
        exit(code)
    }

    func idleCheck() {
        let busy = (stream?.clientCount ?? 0) > 0 || recorder != nil
        if busy { lastUse = nowMs() }
        if !busy && tidiedAt < lastUse && nowMs() - lastUse > Daemon.tidyAfterMs {
            tidiedAt = nowMs()
            q.async { self.tidy() }
        }
        if config.idleMs > 0 && nowMs() - lastUse > config.idleMs {
            log("idle for \(Int(config.idleMs / 1000)) s, exiting")
            q.sync { shutdown(code: 0) }
        }
    }

    /// A session sits idle most of the time while its job thinks. A headless browser never
    /// feels memory pressure on its own, so after a quiet spell each of our tabs collects its
    /// garbage and drops what it can rebuild (decoded images, caches): about a fifth of a
    /// page's memory, with the page itself untouched. The daemon gives back its freed heap too.
    static let tidyAfterMs = 30_000.0

    func tidy() {
        guard nowMs() - lastUse >= Daemon.tidyAfterMs else { return }  // a command came in meanwhile
        let mine = lock.withLock { Array(tabs.values) }.filter { !$0.gone }
        for t in mine {
            _ = try? cdp.call("HeapProfiler.collectGarbage", session: t.sessionId, timeout: 10)
            _ = try? cdp.call("Memory.simulatePressureNotification", ["level": "critical"], session: t.sessionId, timeout: 5)
        }
        malloc_zone_pressure_relief(nil, 0)
    }

    // ───────────── events ─────────────

    func event(_ method: String, _ p: JSON, _ sid: String?) {
        if method == "Target.targetDestroyed" || method == "Target.detachedFromTarget" {
            let tid = p.str("targetId")
            lock.lock()
            let dead = tabs.values.filter { $0.targetId == tid || (sid == nil && $0.sessionId == p.str("sessionId")) }
            for t in dead {
                t.gone = true
                tabs[t.sessionId] = nil
            }
            lock.unlock()
            if let a = active, dead.contains(where: { $0 === a }) {
                stream?.tabChanged()
                if config.pin {
                    var st = readState(config.session)
                    st["targetId"] = nil
                    writeState(config.session, st)
                }
            }
            return
        }
        if method == "Target.targetInfoChanged", let info = p.obj("targetInfo"), let tid = info.str("targetId") {
            lock.lock()
            let t = tabs.values.first { $0.targetId == tid }
            lock.unlock()
            if let t { t.with { t.title = info.str("title") ?? t.title } }
            return
        }
        if method.hasPrefix("Browser.download") {
            if let g = p.str("guid") { lock.lock(); downloads[g, default: [:]].merge(p) { $1 }; lock.unlock() }
            return
        }
        guard let sid else { return }
        lock.lock()
        let tab = tabs[sid]
        lock.unlock()
        guard let tab else { return }
        if method == "Fetch.requestPaused" { routePaused(tab, p); return }
        if method == "Page.screencastFrame" {
            cdp.send("Page.screencastFrameAck", ["sessionId": p.int("sessionId") ?? 0], session: sid)
            guard tab === active, let data = p.str("data") else { return }
            let meta = p.obj("metadata") ?? [:]
            tab.with { tab.lastFrame = (data, meta) }
            stream?.frame(data, meta)
            recorder?.frame(data)
            return
        }
        tab.handle(method, p)
        if tab === active, method == "Page.frameNavigated" || method == "Page.navigatedWithinDocument" {
            stream?.url(tab.with { tab.url })
        }
    }

    private func routePaused(_ tab: Tab, _ p: JSON) {
        guard let rid = p.str("requestId") else { return }
        let url = p.obj("request")?.str("url") ?? ""
        let type = (p.str("resourceType") ?? "").lowercased()
        lock.lock()
        let route = routes.last { r in globMatch(r.pattern, url) && (r.types.isEmpty || r.types.contains(type)) }
        lock.unlock()
        guard let route else {
            cdp.send("Fetch.continueRequest", ["requestId": rid], session: tab.sessionId)
            return
        }
        if route.abort {
            cdp.send("Fetch.failRequest", ["requestId": rid, "errorReason": "BlockedByClient"], session: tab.sessionId)
        } else {
            var headers: [JSON] = [["name": "Content-Type", "value": "application/json"]]
            if let o = route.allowOrigin {
                headers.append(["name": "Access-Control-Allow-Origin", "value": o])
                headers.append(["name": "Access-Control-Allow-Credentials", "value": "true"])
            }
            cdp.send("Fetch.fulfillRequest", ["requestId": rid, "responseCode": 200, "responseHeaders": headers,
                                              "body": Data((route.body ?? "").utf8).base64EncodedString()], session: tab.sessionId)
        }
    }

    // ───────────── tabs ─────────────

    func pages() throws -> [JSON] {
        let r = try cdp.call("Target.getTargets")
        return (r.arr("targetInfos") as? [JSON] ?? []).filter { $0.str("type") == "page" && !($0.str("url") ?? "").hasPrefix("devtools://") }
    }

    func tabNumber(_ targetId: String) -> Int {
        lock.lock(); defer { lock.unlock() }
        if let n = tabIds[targetId] { return n }
        let n = nextTabId
        nextTabId += 1
        tabIds[targetId] = n
        return n
    }

    func attached(_ targetId: String) -> Tab? {
        lock.lock(); defer { lock.unlock() }
        return tabs.values.first { $0.targetId == targetId }
    }

    /// Attach to a page and set it up (domains, init scripts, routes, emulation).
    func attach(_ targetId: String) throws -> Tab {
        if let t = attached(targetId) { return t }
        let r = try cdp.call("Target.attachToTarget", ["targetId": targetId, "flatten": true])
        guard let sid = r.str("sessionId") else { throw BrowserError("could not attach to the tab") }
        let tab = Tab(targetId: targetId, sessionId: sid)
        lock.lock(); tabs[sid] = tab; lock.unlock()
        _ = tabNumber(targetId)
        for m in ["Page.enable", "Runtime.enable", "Network.enable"] { try cdp.call(m, session: sid) }
        try cdp.call("Page.setLifecycleEventsEnabled", ["enabled": true], session: sid)
        if let tree = try? cdp.call("Page.getFrameTree", session: sid), let f = tree.obj("frameTree")?.obj("frame") {
            tab.with {
                tab.mainFrameId = f.str("id")
                tab.url = f.str("url") ?? ""
                tab.loaderId = f.str("loaderId")
            }
        }
        for path in config.initScripts {
            if let src = try? String(contentsOfFile: path, encoding: .utf8) {
                _ = try? cdp.call("Page.addScriptToEvaluateOnNewDocument", ["source": src, "runImmediately": true], session: sid)
            }
        }
        try applySettings(tab)
        return tab
    }

    func applySettings(_ tab: Tab) throws {
        let sid = tab.sessionId
        lock.lock()
        let hasRoutes = !routes.isEmpty
        let feats = media
        let headers = extraHeaders
        let off = offline
        let vp = viewport
        let g = geo
        let ua = userAgent
        lock.unlock()
        if hasRoutes {
            try cdp.call("Fetch.enable", ["patterns": [["urlPattern": "*", "requestStage": "Request"]]], session: sid)
        } else {
            _ = try? cdp.call("Fetch.disable", session: sid)
        }
        try cdp.call("Emulation.setEmulatedMedia", ["features": feats], session: sid)
        try cdp.call("Network.setExtraHTTPHeaders", ["headers": headers], session: sid)
        if off {
            try cdp.call("Network.emulateNetworkConditions", ["offline": true, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1], session: sid)
        } else {
            _ = try? cdp.call("Network.emulateNetworkConditions", ["offline": false, "latency": 0, "downloadThroughput": -1, "uploadThroughput": -1], session: sid)
        }
        if let vp { try cdp.call("Emulation.setDeviceMetricsOverride", vp, session: sid) }
        if let g { try cdp.call("Emulation.setGeolocationOverride", g, session: sid) }
        if let ua { try cdp.call("Emulation.setUserAgentOverride", ["userAgent": ua], session: sid) }
    }

    func applyAll() throws {
        lock.lock(); let all = Array(tabs.values); lock.unlock()
        for t in all { try applySettings(t) }
    }

    func makeActive(_ tab: Tab) {
        let changed = active !== tab
        active = tab
        if config.pin {
            var st = readState(config.session)
            st["targetId"] = tab.targetId
            writeState(config.session, st)
        }
        if changed { stream?.tabChanged() }
    }

    func newTab(_ url: String = "about:blank") throws -> Tab {
        let r = try cdp.call("Target.createTarget", ["url": "about:blank", "background": true])
        guard let tid = r.str("targetId") else { throw BrowserError("could not open a tab") }
        let tab = try attach(tid)
        makeActive(tab)
        if url != "about:blank" { _ = try navigate(tab, url, waitUntil: "load") }
        return tab
    }

    /// The tab commands act on. A pinned session keeps its own tab across daemons;
    /// one whose tab was closed while it ran says so (tab_gone).
    func tab() throws -> Tab {
        if let a = active {
            if a.gone {
                throw BrowserError("tab_gone: this session's tab was closed. Run `ondra-browser tab new <url>` to open a new one.")
            }
            return a
        }
        let list = try pages()
        if config.pin {
            if let tid = readState(config.session).str("targetId"), list.contains(where: { $0.str("targetId") == tid }) {
                let t = try attach(tid)
                makeActive(t)
                return t
            }
            return try newTab()
        }
        if let first = list.first, let tid = first.str("targetId") {
            let t = try attach(tid)
            makeActive(t)
            return t
        }
        return try newTab()
    }

    // ───────────── page helpers ─────────────

    @discardableResult
    func navigate(_ tab: Tab, _ url: String, waitUntil: String, timeoutMs: Double = 25000) throws -> JSON {
        var target = url
        if !target.contains("://") && !target.hasPrefix("about:") && !target.hasPrefix("data:") && !target.hasPrefix("javascript:") {
            target = (target.hasPrefix("localhost") || target.hasPrefix("127.")) ? "http://\(target)" : "https://\(target)"
        }
        let before = tab.with { tab.navigations }
        let r = try cdp.call("Page.navigate", ["url": target], session: tab.sessionId, timeout: timeoutMs / 1000 + 5)
        if let e = r.str("errorText"), !e.isEmpty, e != "net::ERR_ABORTED" { throw BrowserError("\(e) at \(target)") }
        if let loader = r.str("loaderId") {
            try waitLifecycle(tab, loader: loader, until: waitUntil, timeoutMs: timeoutMs, navigatedFrom: before)
        }
        return try pageInfo(tab)
    }

    /// Wait for a lifecycle event of the page's load. A redirect or a script that navigates
    /// again starts a new loader: then the newest one counts. `navigatedFrom` (the count of
    /// navigations before ours) lets the document's readyState answer too, once a new
    /// document is in.
    func waitLifecycle(_ tab: Tab, loader: String?, until: String, timeoutMs: Double, navigatedFrom: Int? = nil) throws {
        let name: String
        switch until.lowercased() {
        case "domcontentloaded", "dom": name = "DOMContentLoaded"
        case "networkidle", "idle": name = "networkIdle"
        case "commit", "none": return
        default: name = "load"
        }
        var tick = 0
        _ = try poll(timeoutMs: timeoutMs, everyMs: 50, what: "\(until) of the page") { () -> Bool? in
            if tab.gone { throw BrowserError("tab_gone: the tab closed while loading") }
            let (seen, navigated) = tab.with { () -> (Bool, Bool) in
                let has = { (l: String?) -> Bool in
                    guard let l, let s = tab.lifecycle[l] else { return false }
                    return s.contains(name) || (name == "networkIdle" && s.contains("networkAlmostIdle") && tab.inflight.isEmpty)
                }
                let navigated = navigatedFrom.map { tab.navigations > $0 } ?? true
                // the newest loader counts only once a new document came in after ours
                let followed = loader != nil && navigated && tab.loaderId != loader && has(tab.loaderId)
                return (has(loader ?? tab.loaderId) || followed, navigated)
            }
            if seen { return true }
            tick += 1
            if navigated && name != "networkIdle" && tick % 10 == 0 {
                let state = (try? self.evalValue(tab, "document.readyState", timeout: 5)) as? String ?? ""
                if state == "complete" || (name == "DOMContentLoaded" && state == "interactive") { return true }
            }
            return nil
        }
    }

    func pageInfo(_ tab: Tab) throws -> JSON {
        let v = try evalValue(tab, "({url: location.href, title: document.title})") as? JSON ?? [:]
        let url = v.str("url") ?? tab.with { tab.url }
        tab.with { tab.url = url; tab.title = v.str("title") ?? tab.title }
        return ["url": url, "title": v.str("title") ?? ""]
    }

    /// Run JS in the page; the value (by value), or an error with the page's message.
    func evalValue(_ tab: Tab, _ expr: String, timeout: Double = 30, gesture: Bool = true) throws -> Any {
        let r = try cdp.call("Runtime.evaluate", ["expression": expr, "returnByValue": true, "awaitPromise": true,
                                                 "userGesture": gesture, "allowUnsafeEvalBlockedByCSP": true],
                             session: tab.sessionId, timeout: timeout)
        if let ex = r.obj("exceptionDetails") {
            let msg = ex.obj("exception")?.str("description") ?? ex.str("text") ?? "the script failed"
            throw BrowserError(msg)
        }
        return valueOf(r.obj("result") ?? [:])
    }

    func valueOf(_ o: JSON) -> Any {
        if let v = o["value"] { return v }
        if let u = o.str("unserializableValue") { return u }
        if o.str("type") == "undefined" { return NSNull() }
        return o.str("description") ?? NSNull()
    }

    /// Call `fn` (a JS function source taking the element) on a remote object.
    func callOn(_ tab: Tab, _ objectId: String, _ fn: String, _ args: [Any] = [], byValue: Bool = true) throws -> JSON {
        let r = try cdp.call("Runtime.callFunctionOn", ["objectId": objectId, "functionDeclaration": fn,
                                                       "arguments": args.map { ["value": $0] }, "returnByValue": byValue,
                                                       "awaitPromise": true, "userGesture": true], session: tab.sessionId)
        if let ex = r.obj("exceptionDetails") {
            throw BrowserError(ex.obj("exception")?.str("description") ?? ex.str("text") ?? "the script failed")
        }
        return r.obj("result") ?? [:]
    }

    /// Stop taking new connections: remove the socket, but only while it is still this
    /// daemon's (a newer one may already listen at the same path).
    @discardableResult
    func releaseSocket() -> Bool {
        let path = socketPath(config.session)
        var sb = stat()
        guard ownSocket != 0, stat(path, &sb) == 0, sb.st_ino == ownSocket else { return false }
        unlink(path)
        ownSocket = 0
        return true
    }

    func locked<R>(_ f: () throws -> R) rethrows -> R {
        lock.lock(); defer { lock.unlock() }
        return try f()
    }

    func log(_ s: String) {
        FileHandle.standardError.write(Data("[\(Date())] \(s)\n".utf8))
    }

    // ───────────── requests ─────────────

    /// Commands that only report and so never wait behind a running one.
    static let quick: Set<String> = ["stream status", "session info", "session", "stream"]

    func handle(_ req: Request) -> JSON {
        let a = req.args
        let key = a.prefix(2).joined(separator: " ")
        if Daemon.quick.contains(key) && (key == "stream status" || key == "session info") {
            return respond(req)
        }
        return q.sync { () -> JSON in
            lastUse = nowMs()
            defer { lastUse = nowMs() }
            return respond(req)
        }
    }

    private func respond(_ req: Request) -> JSON {
        if req.args.first == "batch" { return runBatch(req) }
        do {
            let o = try run(req.args, req)
            return ["success": true, "data": o.data, "text": o.text]
        } catch {
            return ["success": false, "error": "\(error)"]
        }
    }

    private func runBatch(_ req: Request) -> JSON {
        var bail = false
        var cmds: [[String]] = []
        for a in req.args.dropFirst() {
            if a == "--bail" { bail = true } else if a == "--json" || a == "--omit-command" { continue } else { cmds.append(shellSplit(a)) }
        }
        if cmds.isEmpty, let s = req.stdin, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard let list = parseJSON(s) as? [Any] else { return ["success": false, "error": "batch: stdin must be a JSON array of commands"] }
            for item in list {
                if let arr = item as? [Any] { cmds.append(arr.map { "\($0)" }) } else if let s = item as? String { cmds.append(shellSplit(s)) }
            }
        }
        var rows: [JSON] = []
        var texts: [String] = []
        var allOk = true
        for c in cmds {
            do {
                let o = try run(c, req)
                rows.append(["command": c, "success": true, "result": o.data, "error": NSNull()])
                texts.append(o.text)
            } catch {
                allOk = false
                rows.append(["command": c, "success": false, "result": NSNull(), "error": "\(error)"])
                texts.append("✗ \(error)")
                if bail { break }
            }
        }
        return ["success": allOk, "data": rows, "text": texts.joined(separator: "\n"), "batch": true]
    }
}

/// Split a command line the way a shell would (quotes and backslashes; no expansion).
func shellSplit(_ s: String) -> [String] {
    var out: [String] = []
    var cur = ""
    var has = false
    var quote: Character?
    var esc = false
    for ch in s {
        if esc { cur.append(ch); esc = false; continue }
        if ch == "\\" && quote != "'" { esc = true; has = true; continue }
        if let q = quote {
            if ch == q { quote = nil } else { cur.append(ch) }
            continue
        }
        if ch == "\"" || ch == "'" { quote = ch; has = true; continue }
        if ch.isWhitespace {
            if has || !cur.isEmpty { out.append(cur); cur = ""; has = false }
            continue
        }
        cur.append(ch)
    }
    if has || !cur.isEmpty { out.append(cur) }
    return out
}
