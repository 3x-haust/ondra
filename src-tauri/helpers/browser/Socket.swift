// Unix-domain sockets between the CLI and a session's daemon: one JSON line each way.

import Foundation

private func withAddress<R>(_ path: String, _ body: (UnsafePointer<sockaddr>, socklen_t) -> R) -> R? {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    let cap = MemoryLayout.size(ofValue: addr.sun_path)
    guard bytes.count < cap else { return nil }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        raw.copyBytes(from: bytes)
        raw[bytes.count] = 0
    }
    return withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { body($0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
}

func unixListen(_ path: String) throws -> Int32 {
    unlink(path)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw BrowserError("socket: \(String(cString: strerror(errno)))") }
    let ok = withAddress(path) { bind(fd, $0, $1) } ?? -1
    guard ok == 0 else { close(fd); throw BrowserError("bind \(path): \(String(cString: strerror(errno)))") }
    chmod(path, 0o600)
    guard listen(fd, 64) == 0 else { close(fd); throw BrowserError("listen: \(String(cString: strerror(errno)))") }
    return fd
}

func unixConnect(_ path: String) -> Int32? {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    var one: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
    let ok = withAddress(path) { connect(fd, $0, $1) } ?? -1
    if ok != 0 { close(fd); return nil }
    return fd
}

func setReadTimeout(_ fd: Int32, seconds: Double) {
    var tv = timeval(tv_sec: Int(seconds), tv_usec: Int32((seconds - floor(seconds)) * 1_000_000))
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
}

func writeAll(_ fd: Int32, _ data: Data) -> Bool {
    var off = 0
    return data.withUnsafeBytes { raw -> Bool in
        guard let base = raw.baseAddress else { return true }
        while off < data.count {
            let n = write(fd, base + off, data.count - off)
            if n < 0 { if errno == EINTR { continue }; return false }
            off += n
        }
        return true
    }
}

/// Read up to the first newline (the newline is dropped). nil on EOF before one, or a timeout.
func readLine(_ fd: Int32, limit: Int = 256 << 20) -> Data? {
    var out = Data()
    var buf = [UInt8](repeating: 0, count: 65536)
    while out.count < limit {
        let n = read(fd, &buf, buf.count)
        if n < 0 { if errno == EINTR { continue }; return nil }
        if n == 0 { return out.isEmpty ? nil : out }
        if let nl = buf[0..<n].firstIndex(of: 10) {
            out.append(contentsOf: buf[0..<nl])
            return out
        }
        out.append(contentsOf: buf[0..<n])
    }
    return out
}
