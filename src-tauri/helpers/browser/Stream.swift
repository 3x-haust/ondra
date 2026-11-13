// The session's tab, live: a WebSocket server on 127.0.0.1 that sends screencast frames
// and takes mouse/keyboard input, and the recorder that turns the same frames into a video.
//
// Server → client:  {"type":"frame","data":<jpeg base64>,"metadata":{deviceWidth,deviceHeight,…}}
//                   {"type":"url","url":…}
// Client → server:  {"type":"input_mouse","eventType":"mousePressed",x,y,button,clickCount}
//                   {"type":"input_keyboard","eventType":"keyDown",key,code,text,modifiers}
//                   {"type":"input_touch","eventType":"touchStart",touchPoints:[{x,y}]}
// `ws://127.0.0.1:<port>/?maxFps=10` caps the frames one client gets.

import CryptoKit
import Foundation

final class WSClient {
    let fd: Int32
    let maxFps: Double
    var lastSent = 0.0
    var pending: String?
    var alive = true
    private let wlock = NSLock()

    init(fd: Int32, maxFps: Double) {
        self.fd = fd
        self.maxFps = maxFps
    }

    func send(_ text: String) {
        sendFrame(opcode: 0x1, Data(text.utf8))
    }

    func sendFrame(opcode: UInt8, _ payload: Data) {
        var head = Data([0x80 | opcode])
        let n = payload.count
        if n < 126 {
            head.append(UInt8(n))
        } else if n < 65536 {
            head.append(126)
            head.append(UInt8(n >> 8)); head.append(UInt8(n & 0xff))
        } else {
            head.append(127)
            for i in (0..<8).reversed() { head.append(UInt8((UInt64(n) >> (UInt64(i) * 8)) & 0xff)) }
        }
        wlock.lock(); defer { wlock.unlock() }
        guard alive else { return }
        if !writeAll(fd, head + payload) { alive = false }
    }

    func close() {
        wlock.lock()
        let was = alive
        alive = false
        wlock.unlock()
        if was { shutdown(fd, SHUT_RDWR) }
    }
}

final class StreamServer {
    weak var daemon: Daemon?
    let fd: Int32
    let port: UInt16
    private let lock = NSLock()
    private var clients: [WSClient] = []
    private var castingOn: String?        // CDP session id of the tab being screencast
    private var timer: DispatchSourceTimer?
    private var stopped = false

    var clientCount: Int { lock.lock(); defer { lock.unlock() }; return clients.count }

    init(daemon: Daemon, port: UInt16) throws {
        self.daemon = daemon
        let s = socket(AF_INET, SOCK_STREAM, 0)
        guard s >= 0 else { throw BrowserError("stream: no socket") }
        var one: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard ok == 0, listen(s, 16) == 0 else { close(s); throw BrowserError("stream: cannot listen on port \(port)") }
        var bound = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &bound) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(s, $0, &len) } }
        fd = s
        self.port = UInt16(bigEndian: bound.sin_port)
        Thread.detachNewThread { [weak self] in self?.acceptLoop() }
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "ondra-browser.stream"))
        t.schedule(deadline: .now() + 0.05, repeating: 0.05)
        t.setEventHandler { [weak self] in self?.flush() }
        t.resume()
        timer = t
    }

    func stop() {
        lock.lock()
        stopped = true
        let all = clients
        clients = []
        lock.unlock()
        for c in all { c.close() }
        timer?.cancel()
        close(fd)
        updateCasting()
    }

    private func acceptLoop() {
        while true {
            let c = accept(fd, nil, nil)
            if c < 0 {
                if errno == EINTR { continue }
                return
            }
            var one: Int32 = 1
            setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
            Thread.detachNewThread { [weak self] in self?.serve(c) }
        }
    }

    // ───────────── one client ─────────────

    private func serve(_ fd: Int32) {
        var buf = Data()
        var chunk = [UInt8](repeating: 0, count: 8192)
        // the HTTP upgrade request
        while buf.range(of: Data("\r\n\r\n".utf8)) == nil {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 || buf.count > 65536 { close(fd); return }
            buf.append(contentsOf: chunk[0..<n])
        }
        let end = buf.range(of: Data("\r\n\r\n".utf8))!
        let head = String(decoding: buf[..<end.lowerBound], as: UTF8.self)
        buf = Data(buf[end.upperBound...])
        let lines = head.components(separatedBy: "\r\n")
        let target = lines.first?.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
        var key: String?
        for l in lines.dropFirst() {
            let parts = l.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.count == 2, parts[0].lowercased() == "sec-websocket-key" { key = parts[1] }
        }
        guard let key else {
            _ = writeAll(fd, Data("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n".utf8))
            close(fd)
            return
        }
        let accept = Data(Insecure.SHA1.hash(data: Data((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").utf8))).base64EncodedString()
        guard writeAll(fd, Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: \(accept)\r\n\r\n".utf8)) else { close(fd); return }
        let fps = URLComponents(string: "http://x" + target)?.queryItems?.first { $0.name == "maxFps" }?.value.flatMap(Double.init) ?? 10
        let client = WSClient(fd: fd, maxFps: max(0.5, min(fps, 60)))
        lock.lock()
        if stopped { lock.unlock(); close(fd); return }
        clients.append(client)
        lock.unlock()
        welcome(client)
        updateCasting()

        func need(_ n: Int) -> Bool {
            while buf.count < n {
                let r = read(fd, &chunk, chunk.count)
                if r <= 0 { return false }
                buf.append(contentsOf: chunk[0..<r])
            }
            return true
        }
        var message = Data()
        loop: while client.alive {
            guard need(2) else { break }
            let b0 = buf[buf.startIndex], b1 = buf[buf.startIndex + 1]
            let opcode = b0 & 0x0f
            let masked = b1 & 0x80 != 0
            var len = Int(b1 & 0x7f)
            var off = 2
            if len == 126 {
                guard need(4) else { break }
                len = Int(buf[buf.startIndex + 2]) << 8 | Int(buf[buf.startIndex + 3]); off = 4
            } else if len == 127 {
                guard need(10) else { break }
                len = 0
                for i in 0..<8 { len = len << 8 | Int(buf[buf.startIndex + 2 + i]) }
                off = 10
            }
            guard len < 16 << 20, need(off + (masked ? 4 : 0) + len) else { break }
            var payload = [UInt8](buf[(buf.startIndex + off + (masked ? 4 : 0))..<(buf.startIndex + off + (masked ? 4 : 0) + len)])
            if masked {
                let m = [UInt8](buf[(buf.startIndex + off)..<(buf.startIndex + off + 4)])
                for i in 0..<payload.count { payload[i] ^= m[i & 3] }
            }
            buf = Data(buf[(buf.startIndex + off + (masked ? 4 : 0) + len)...])
            switch opcode {
            case 0x0, 0x1, 0x2:
                message.append(contentsOf: payload)
                if b0 & 0x80 != 0 {
                    input(String(decoding: message, as: UTF8.self))
                    message = Data()
                }
            case 0x8:
                client.sendFrame(opcode: 0x8, Data())
                break loop
            case 0x9:
                client.sendFrame(opcode: 0xA, Data(payload))
            default:
                break
            }
        }
        client.close()
        close(fd)
        lock.lock()
        clients.removeAll { $0 === client }
        lock.unlock()
        updateCasting()
    }

    /// A new viewer sees the page at once: its address and a picture (headless Chrome only
    /// sends a frame when something changes).
    private func welcome(_ c: WSClient) {
        guard let d = daemon, let tab = d.active, !tab.gone else { return }
        c.send(jsonString(["type": "url", "url": tab.with { tab.url }]))
        if let f = tab.with({ tab.lastFrame }) {
            c.send(jsonString(["type": "frame", "data": f.data, "metadata": f.meta]))
            c.lastSent = nowMs()
            return
        }
        DispatchQueue.global().async {
            guard let r = try? d.cdp.call("Page.captureScreenshot", ["format": "jpeg", "quality": 70], session: tab.sessionId, timeout: 10),
                  let data = r.str("data") else { return }
            let m = try? d.cdp.call("Page.getLayoutMetrics", session: tab.sessionId, timeout: 5)
            let v = m?.obj("cssVisualViewport") ?? m?.obj("visualViewport") ?? [:]
            let meta: JSON = ["deviceWidth": v.dbl("clientWidth") ?? 1280, "deviceHeight": v.dbl("clientHeight") ?? 800, "pageScaleFactor": 1, "offsetTop": 0,
                              "scrollOffsetX": v.dbl("pageX") ?? 0, "scrollOffsetY": v.dbl("pageY") ?? 0]
            c.send(jsonString(["type": "frame", "data": data, "metadata": meta]))
        }
    }

    private func input(_ text: String) {
        guard let d = daemon, let tab = d.active, !tab.gone, let m = parseJSON(text) as? JSON else { return }
        d.lastUse = nowMs()
        switch m.str("type") {
        case "input_mouse":
            var p: JSON = ["type": m.str("eventType") ?? "mouseMoved", "x": m.dbl("x") ?? 0, "y": m.dbl("y") ?? 0,
                           "button": m.str("button") ?? "none", "clickCount": m.int("clickCount") ?? 0, "modifiers": m.int("modifiers") ?? 0]
            if let dx = m.dbl("deltaX") { p["deltaX"] = dx }
            if let dy = m.dbl("deltaY") { p["deltaY"] = dy }
            if p.str("type") == "mousePressed" { p["buttons"] = 1 }
            d.cdp.send("Input.dispatchMouseEvent", p, session: tab.sessionId)
        case "input_keyboard":
            var p: JSON = ["type": m.str("eventType") ?? "keyDown", "modifiers": m.int("modifiers") ?? 0]
            for k in ["key", "code", "text"] { if let v = m.str(k) { p[k] = v } }
            if let kc = m.int("keyCode") ?? m.int("windowsVirtualKeyCode") { p["windowsVirtualKeyCode"] = kc }
            d.cdp.send("Input.dispatchKeyEvent", p, session: tab.sessionId)
        case "input_touch":
            d.cdp.send("Input.dispatchTouchEvent", ["type": m.str("eventType") ?? "touchStart", "touchPoints": m.arr("touchPoints") ?? []], session: tab.sessionId)
        default:
            break
        }
    }

    // ───────────── frames ─────────────

    func frame(_ data: String, _ meta: JSON) {
        let msg = jsonString(["type": "frame", "data": data, "metadata": meta])
        lock.lock(); let all = clients; lock.unlock()
        let now = nowMs()
        for c in all {
            if now - c.lastSent >= 1000 / c.maxFps {
                c.lastSent = now
                c.pending = nil
                c.send(msg)
            } else {
                c.pending = msg
            }
        }
    }

    /// The last frame a client skipped for its cap goes out when its turn comes, so a
    /// page that stops changing is shown as it ended.
    private func flush() {
        lock.lock(); let all = clients; lock.unlock()
        let now = nowMs()
        for c in all {
            if let p = c.pending, now - c.lastSent >= 1000 / c.maxFps {
                c.pending = nil
                c.lastSent = now
                c.send(p)
            }
        }
    }

    func url(_ u: String) {
        let msg = jsonString(["type": "url", "url": u])
        lock.lock(); let all = clients; lock.unlock()
        for c in all { c.send(msg) }
    }

    func tabChanged() {
        updateCasting(force: true)
        if let d = daemon, let t = d.active, !t.gone { url(t.with { t.url }) }
    }

    /// Screencast the active tab while anyone watches or records; stop otherwise.
    func updateCasting(force: Bool = false) {
        guard let d = daemon else { return }
        let want = (clientCount > 0 || d.recorder != nil) && !stopped
        let tab = d.active.flatMap { $0.gone ? nil : $0 }
        let target = want ? tab?.sessionId : nil
        lock.lock()
        let current = castingOn
        castingOn = target
        lock.unlock()
        if current == target && !force { return }
        if let current, current != target {
            d.cdp.send("Page.stopScreencast", session: current)
            d.locked { d.tabs[current]?.with { d.tabs[current]?.screencasting = false } }
        }
        if let target, let tab {
            d.cdp.send("Page.startScreencast", ["format": "jpeg", "quality": 75, "maxWidth": 1600, "maxHeight": 1200, "everyNthFrame": 1], session: target)
            tab.with { tab.screencasting = true }
            if current != target, clientCount > 0 {
                lock.lock(); let all = clients; lock.unlock()
                for c in all { welcome(c) }
            }
        }
    }
}

// ───────────── recording ─────────────

final class Recorder {
    let path: String
    private let proc = Process()
    private let input: FileHandle
    private var latest: Data?
    private let lock = NSLock()
    private var timer: DispatchSourceTimer?
    private var frames = 0
    static let fps = 10

    init(path: String) throws {
        guard let ffmpeg = which("ffmpeg") else { throw BrowserError("recording needs ffmpeg on PATH (brew install ffmpeg)") }
        self.path = path
        let ext = (path as NSString).pathExtension.lowercased()
        let encoders = Recorder.encoders(ffmpeg)
        var codec: [String]
        switch ext {
        case "webm":
            if encoders.contains("libvpx-vp9") { codec = ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "36", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1"] }
            else if encoders.contains("libvpx") { codec = ["-c:v", "libvpx", "-b:v", "2M", "-deadline", "realtime", "-cpu-used", "8"] }
            else { throw BrowserError("this ffmpeg cannot write .webm (no libvpx); record to .mp4 instead") }
        case "mp4", "mov", "m4v":
            codec = encoders.contains("libx264")
                ? ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
                : ["-c:v", "h264_videotoolbox", "-b:v", "4M", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
        default:
            throw BrowserError("record to a .webm or .mp4 file")
        }
        try? FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        proc.executableURL = URL(fileURLWithPath: ffmpeg)
        proc.arguments = ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(Recorder.fps), "-c:v", "mjpeg", "-i", "-",
                          "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-r", String(Recorder.fps)] + codec + [path]
        let pipe = Pipe()
        proc.standardInput = pipe
        proc.standardOutput = FileHandle.nullDevice
        proc.standardError = FileHandle.nullDevice
        input = pipe.fileHandleForWriting
        try proc.run()
        let t = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "ondra-browser.record"))
        t.schedule(deadline: .now(), repeating: 1.0 / Double(Recorder.fps))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    static func encoders(_ ffmpeg: String) -> String {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: ffmpeg)
        p.arguments = ["-hide_banner", "-encoders"]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        try? p.run()
        let d = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return String(decoding: d, as: UTF8.self)
    }

    func frame(_ b64: String) {
        guard let d = Data(base64Encoded: b64) else { return }
        lock.lock(); latest = d; lock.unlock()
    }

    /// One frame per tick, the latest again when nothing changed: the video keeps real time.
    private func tick() {
        lock.lock(); let f = latest; lock.unlock()
        guard let f, proc.isRunning else { return }
        do { try input.write(contentsOf: f); frames += 1 } catch { timer?.cancel() }
    }

    /// Finish the file. Returns seconds recorded.
    @discardableResult
    func stop() -> Double {
        timer?.cancel()
        timer = nil
        try? input.close()
        let until = nowMs() + 60000
        while proc.isRunning && nowMs() < until { sleepMs(50) }
        if proc.isRunning { proc.terminate() }
        return Double(frames) / Double(Recorder.fps)
    }

    var ok: Bool { !proc.isRunning && proc.terminationStatus == 0 }
}

extension Daemon {
    func record(_ a: Args, _ req: Request) throws -> Outcome {
        switch a.pos.first ?? "" {
        case "start":
            guard a.pos.count > 1 else { throw BrowserError("usage: record start <file.webm|file.mp4> [url]") }
            if recorder != nil { throw BrowserError("already recording; record stop first") }
            let t = try tab()
            let file = absolutePath(a.pos[1], cwd: req.cwd)
            let r = try Recorder(path: file)
            // the page as it is now is the first frame
            if let shot = try? cdp.call("Page.captureScreenshot", ["format": "jpeg", "quality": 80], session: t.sessionId), let d = shot.str("data") {
                r.frame(d)
            }
            recorder = r
            if stream == nil { stream = try? StreamServer(daemon: self, port: 0) }
            stream?.updateCasting(force: true)
            if a.pos.count > 2 { try navigate(t, a.pos[2], waitUntil: "load") }
            return Outcome(["path": file], "✓ Recording to \(file)")
        case "stop":
            guard let r = recorder else { throw BrowserError("not recording") }
            recorder = nil
            stream?.updateCasting()
            let secs = r.stop()
            guard r.ok, FileManager.default.fileExists(atPath: r.path) else { throw BrowserError("ffmpeg could not write \(r.path)") }
            return Outcome(["path": r.path, "seconds": secs], "✓ Saved \(r.path) (\(String(format: "%.1f", secs)) s)")
        default:
            throw BrowserError("usage: record start <file> [url] | record stop")
        }
    }
}
