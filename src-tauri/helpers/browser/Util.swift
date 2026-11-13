// Shared pieces of ondra-browser: errors, JSON, paths, globs, small helpers.

import Foundation

typealias JSON = [String: Any]

struct BrowserError: Error, CustomStringConvertible {
    let message: String
    var description: String { message }
    init(_ message: String) { self.message = message }
}

func jsonData(_ value: Any, pretty: Bool = false) -> Data {
    var opts: JSONSerialization.WritingOptions = [.fragmentsAllowed, .withoutEscapingSlashes]
    if pretty { opts.insert(.prettyPrinted); opts.insert(.sortedKeys) }
    return (try? JSONSerialization.data(withJSONObject: value, options: opts)) ?? Data("null".utf8)
}

func jsonString(_ value: Any, pretty: Bool = false) -> String {
    var s = String(decoding: jsonData(value, pretty: pretty), as: UTF8.self)
    // JSONSerialization indents with two spaces after a colon space: keep it, but
    // print `"key": value` rather than `"key" : value`
    if pretty { s = s.replacingOccurrences(of: "\" : ", with: "\": ") }
    return s
}

func parseJSON(_ data: Data) -> Any? {
    try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
}

func parseJSON(_ text: String) -> Any? { parseJSON(Data(text.utf8)) }

extension Dictionary where Key == String, Value == Any {
    func str(_ k: String) -> String? { self[k] as? String }
    func int(_ k: String) -> Int? {
        if let n = self[k] as? Int { return n }
        if let n = self[k] as? Double { return Int(n) }
        if let n = self[k] as? NSNumber { return n.intValue }
        return nil
    }
    func dbl(_ k: String) -> Double? {
        if let n = self[k] as? Double { return n }
        if let n = self[k] as? Int { return Double(n) }
        if let n = self[k] as? NSNumber { return n.doubleValue }
        return nil
    }
    func bool(_ k: String) -> Bool? { self[k] as? Bool }
    func obj(_ k: String) -> JSON? { self[k] as? JSON }
    func arr(_ k: String) -> [Any]? { self[k] as? [Any] }
}

// ───────────── where sessions live ─────────────

/// Sockets and session state. Short on purpose: a Unix socket path holds at most 104 bytes.
let baseDir: String = {
    let dir = "/tmp/ondra-browser-\(getuid())"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    chmod(dir, 0o700)
    return dir
}()

func safeName(_ session: String) -> String {
    var s = String(session.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." ? $0 : "_" })
    if s.isEmpty { s = "default" }
    if s.count > 72 { s = String(s.prefix(56)) + "-" + String(UInt64(bitPattern: Int64(s.hashValue)), radix: 36) }
    return s
}

func socketPath(_ session: String) -> String { "\(baseDir)/\(safeName(session)).sock" }
func statePath(_ session: String) -> String { "\(baseDir)/\(safeName(session)).json" }
func logPath(_ session: String) -> String { "\(baseDir)/\(safeName(session)).log" }

func readState(_ session: String) -> JSON {
    guard let d = FileManager.default.contents(atPath: statePath(session)), let j = parseJSON(d) as? JSON else { return [:] }
    return j
}

func writeState(_ session: String, _ state: JSON) {
    let path = statePath(session)
    let tmp = path + ".tmp"
    FileManager.default.createFile(atPath: tmp, contents: jsonData(state), attributes: [.posixPermissions: 0o600])
    rename(tmp, path)
}

// ───────────── text ─────────────

/// `*` matches any run of characters (slashes too), `?` one character. Case-insensitive.
func globMatch(_ pattern: String, _ text: String) -> Bool {
    let p = Array(pattern.lowercased().replacingOccurrences(of: "**", with: "*")), t = Array(text.lowercased())
    var pi = 0, ti = 0, star = -1, mark = 0
    while ti < t.count {
        if pi < p.count && (p[pi] == "?" || p[pi] == t[ti]) { pi += 1; ti += 1 }
        else if pi < p.count && p[pi] == "*" { star = pi; mark = ti; pi += 1 }
        else if star >= 0 { pi = star + 1; mark += 1; ti = mark }
        else { return false }
    }
    while pi < p.count && p[pi] == "*" { pi += 1 }
    return pi == p.count
}

func clip(_ s: String, _ n: Int) -> String {
    let one = s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    return one.count <= n ? one : String(one.prefix(n - 1)) + "…"
}

func quoteForSnapshot(_ s: String) -> String {
    s.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: " ")
}

/// A path given by the client, made absolute against the client's working directory.
func absolutePath(_ p: String, cwd: String) -> String {
    let expanded = (p as NSString).expandingTildeInPath
    if expanded.hasPrefix("/") { return expanded }
    return (cwd as NSString).appendingPathComponent(expanded)
}

func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

func sleepMs(_ ms: Double) { usleep(useconds_t(max(0, ms) * 1000)) }

/// Poll `check` until it returns a value or the time is up.
func poll<T>(timeoutMs: Double, everyMs: Double = 100, what: String, _ check: () throws -> T?) throws -> T {
    let until = nowMs() + timeoutMs
    while true {
        if let v = try check() { return v }
        if nowMs() >= until { throw BrowserError("Timed out after \(Int(timeoutMs)) ms waiting for \(what)") }
        sleepMs(everyMs)
    }
}

func which(_ name: String) -> String? {
    let path = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin"
    for dir in path.split(separator: ":") + ["/opt/homebrew/bin", "/usr/local/bin"] {
        let p = "\(dir)/\(name)"
        if FileManager.default.isExecutableFile(atPath: p) { return p }
    }
    return nil
}

final class Locked<T> {
    private var value: T
    private let lock = NSLock()
    init(_ v: T) { value = v }
    func with<R>(_ f: (inout T) throws -> R) rethrows -> R {
        lock.lock(); defer { lock.unlock() }
        return try f(&value)
    }
    var get: T { with { $0 } }
}
