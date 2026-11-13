// A Chrome DevTools Protocol client over one browser-level WebSocket, with flat sessions.
//
// `call` blocks the calling thread until the reply comes; events are delivered in order
// on their own serial queue, so an event handler may `send` (fire and forget) but must
// not `call`.

import Foundation

final class CDP: NSObject, URLSessionWebSocketDelegate {
    private var session: URLSession!
    private var task: URLSessionWebSocketTask!
    private let lock = NSLock()
    private var nextId = 0
    private var pending: [Int: Pending] = [:]
    private(set) var closed = false
    private let events = DispatchQueue(label: "ondra-browser.events", autoreleaseFrequency: .workItem)
    var onEvent: ((String, JSON, String?) -> Void)?
    var onClose: (() -> Void)?
    let endpoint: String

    private final class Pending {
        let sem = DispatchSemaphore(value: 0)
        var result: JSON?
        var error: String?
    }

    /// `endpoint`: a DevTools port, `host:port`, an http(s) URL or a ws(s) URL.
    init(endpoint: String) throws {
        self.endpoint = endpoint
        super.init()
        let ws = try CDP.resolve(endpoint)
        session = URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
        task = session.webSocketTask(with: ws)
        task.maximumMessageSize = 512 << 20
        task.resume()
        receive()
        // the first call proves the socket is up
        _ = try call("Browser.getVersion", timeout: 10)
    }

    static func resolve(_ endpoint: String) throws -> URL {
        if endpoint.hasPrefix("ws://") || endpoint.hasPrefix("wss://") {
            guard let u = URL(string: endpoint) else { throw BrowserError("bad CDP URL \(endpoint)") }
            return u
        }
        var base = endpoint
        if Int(endpoint) != nil { base = "http://127.0.0.1:\(endpoint)" }
        else if !endpoint.hasPrefix("http") { base = "http://\(endpoint)" }
        guard let url = URL(string: base.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/json/version") else {
            throw BrowserError("bad CDP endpoint \(endpoint)")
        }
        var req = URLRequest(url: url, timeoutInterval: 5)
        req.httpMethod = "GET"
        let sem = DispatchSemaphore(value: 0)
        var body: Data?
        var err: Error?
        URLSession.shared.dataTask(with: req) { d, _, e in body = d; err = e; sem.signal() }.resume()
        if sem.wait(timeout: .now() + 6) == .timedOut { throw BrowserError("the browser at \(endpoint) did not answer") }
        guard let d = body, let j = parseJSON(d) as? JSON, let ws = j.str("webSocketDebuggerUrl"), let u = URL(string: ws) else {
            throw BrowserError("no browser at \(endpoint)\(err.map { ": \($0.localizedDescription)" } ?? "")")
        }
        return u
    }

    private func receive() {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let msg):
                switch msg {
                case .string(let s): self.handle(Data(s.utf8))
                case .data(let d): self.handle(d)
                @unknown default: break
                }
                self.receive()
            case .failure:
                self.shutDown()
            }
        }
    }

    private func handle(_ data: Data) {
        guard let msg = parseJSON(data) as? JSON else { return }
        if let id = msg.int("id") {
            lock.lock()
            let p = pending.removeValue(forKey: id)
            lock.unlock()
            guard let p else { return }
            if let e = msg.obj("error") {
                let data = e.str("data").map { " (\($0))" } ?? ""
                p.error = (e.str("message") ?? "CDP error") + data
            } else {
                p.result = msg.obj("result") ?? [:]
            }
            p.sem.signal()
        } else if let method = msg.str("method") {
            let params = msg.obj("params") ?? [:]
            let sid = msg.str("sessionId")
            events.async { [weak self] in self?.onEvent?(method, params, sid) }
        }
    }

    private func shutDown() {
        lock.lock()
        if closed { lock.unlock(); return }
        closed = true
        let all = pending
        pending = [:]
        lock.unlock()
        for p in all.values { p.error = "the browser connection closed"; p.sem.signal() }
        events.async { [weak self] in self?.onClose?() }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        shutDown()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        shutDown()
    }

    private func message(_ method: String, _ params: JSON, _ sessionId: String?) -> (Int, String) {
        lock.lock()
        nextId += 1
        let id = nextId
        lock.unlock()
        var m: JSON = ["id": id, "method": method, "params": params]
        if let sessionId { m["sessionId"] = sessionId }
        return (id, jsonString(m))
    }

    @discardableResult
    func call(_ method: String, _ params: JSON = [:], session sessionId: String? = nil, timeout: Double = 30) throws -> JSON {
        if closed { throw BrowserError("the browser connection closed") }
        let (id, text) = message(method, params, sessionId)
        let p = Pending()
        lock.lock(); pending[id] = p; lock.unlock()
        task.send(.string(text)) { [weak self] err in
            guard let err, let self else { return }
            self.lock.lock()
            let q = self.pending.removeValue(forKey: id)
            self.lock.unlock()
            q?.error = "send failed: \(err.localizedDescription)"
            q?.sem.signal()
        }
        if p.sem.wait(timeout: .now() + timeout) == .timedOut {
            lock.lock(); pending.removeValue(forKey: id); lock.unlock()
            throw BrowserError("the browser did not answer \(method) within \(Int(timeout)) s")
        }
        if let e = p.error { throw BrowserError("\(method): \(e)") }
        return p.result ?? [:]
    }

    /// Fire and forget (for event handlers).
    func send(_ method: String, _ params: JSON = [:], session sessionId: String? = nil) {
        if closed { return }
        let (_, text) = message(method, params, sessionId)
        task.send(.string(text)) { _ in }
    }

    func close() {
        task.cancel(with: .goingAway, reason: nil)
        session.invalidateAndCancel()
        shutDown()
    }
}
