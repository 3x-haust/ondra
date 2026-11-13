// ondra-browser: Ondra's browser tool for agents. Drives Chrome over the DevTools protocol.
//
//   ondra-browser [--session <name>] [--json] <command> [args]
//
// Each session has a small daemon (started on first use, gone after a while idle) that
// keeps the connection, the session's tab, its refs and logs between commands. With
// ONDRA_BROWSER_CDP it attaches to a running browser (the app's shared one) instead of
// starting its own; with ONDRA_BROWSER_PIN_TAB=1 the session works in a tab of its own.
//
// Environment: ONDRA_BROWSER_SESSION, ONDRA_BROWSER_CDP, ONDRA_BROWSER_PIN_TAB,
// ONDRA_BROWSER_IDLE_TIMEOUT_MS, ONDRA_BROWSER_EXECUTABLE_PATH, ONDRA_BROWSER_INIT_SCRIPTS
// (comma-separated JS files run in every page before its own scripts),
// ONDRA_BROWSER_KEYCHAIN (the credential helper for `auth login`), ONDRA_BROWSER_STREAM_PORT.

import Foundation

let version = "1.0.0"

let help = """
ondra-browser \(version): drive a browser tab from the command line

Usage: ondra-browser [--session <name>] [--json] <command> [args]

Look
  snapshot [-c] [-i] [-s <css>] [-u] [-d <n>] [--delta]
                                               accessibility tree with refs (@e3); -c compact,
                                               -i controls only, -s one region, -u link targets,
                                               --delta only what changed since the last one
  get url|title|text|html|value|attr <name>|count|box|styles [<sel>]
  is visible|enabled|checked <sel>
  screenshot [path] [--full] [--selector <css>]
  pdf <path>
  eval <js> | eval --stdin                     run JavaScript in the page (await works)
  console [--clear]  errors [--clear]          the page's console messages and errors
  a11y [url] [--selector <css>]                accessibility check (WCAG 2.2 A/AA rules): violations
                                               with impact, rule id and the elements
  vitals [url]                                 LCP, CLS, INP, FCP, TTFB and load times

Act  (<sel> is a ref like @e3, a CSS selector, text=…, or xpath=…)
  open <url> [--wait-until load|domcontentloaded|networkidle]
  back  forward  reload
  click <sel>  dblclick <sel>  hover <sel>  focus <sel>  scrollintoview <sel>
  fill <sel> <text>                            clear, then type the text
  type <sel> <text>                            type key by key
  press <key>                                  Enter, Tab, Escape, Control+a, Shift+Tab …
  keyboard type <text> | keyboard inserttext <text>
  check <sel>  uncheck <sel>  select <sel> <value...>
  upload <sel> <files...>  download <sel> <path>  drag <from> <to>
  scroll up|down|left|right [px] [--selector <css>]
  mouse move <x> <y> | mouse down|up [button] | mouse wheel <dy> [dx]
  find role|text|label|placeholder|alt|title|testid <value> [action] [text] [--name <n>] [--exact]
  find first|last <css> [action] | find nth <n> <css> [action]

Wait
  wait <ms> | wait <sel> [--state visible|hidden|attached|detached]
  wait --load load|domcontentloaded|networkidle
  wait --text <text> | wait --url <pattern> | wait --fn <js>      (--timeout <ms>, default 25000)

Tabs and session
  tab [list] | tab new [url] | tab <tN> | tab close [tN]
  session list | session info
  close [--all]                                end this session (a shared browser keeps its tabs)

Network and state
  network route <url-glob> [--abort | --body <json> [--allow-origin <o>]] [--resource-type image,font,…]
  network unroute [url-glob]
  network requests [--clear] [--filter <text>] [--type xhr,fetch] [--method GET] [--status 400-599]
  network request <id>                         one request with its response body
  cookies [get [--url u]] | cookies set <name> <value> [--url|--domain|--path|--secure|--http-only|--same-site|--expires]
  cookies clear
  storage local|session [<key> | set <k> <v> | remove <k> | clear]
  set viewport <w> <h> [scale] | set device <name> | set media [dark|light] [reduced-motion]
  set offline on|off | set headers <json> | set geo <lat> <lng> | set useragent <ua>

Sign-in, recording, streaming
  auth login <site> --credential-provider keychain [--url <login page>] [--no-navigate] [--item <account>]
       [--username-selector <css>] [--password-selector <css>] [--submit-selector <css>]
  record start <file.webm|file.mp4> [url] | record stop       (needs ffmpeg)
  stream status | stream enable [--port <n>] | stream disable

Batch
  batch [--bail] ["cmd args" ...]              or a JSON array of commands on stdin; with --json
                                               one row per command: {command, success, result, error}

Global: --session <name>, --json, --cdp <port|url>, --no-pin-tab, --version
"""

let usage: [String: String] = [
    "open": "open <url> [--wait-until load|domcontentloaded|networkidle] [--timeout <ms>]",
    "snapshot": "snapshot [-c|--compact] [-i|--interactive] [-s|--selector <css>] [-u|--urls] [-d|--depth <n>] [--delta]",
    "a11y": "a11y [url] [--selector <css>]   accessibility violations: impact, rule, how many, the first element",
    "vitals": "vitals [url]   LCP, CLS, INP, FCP, TTFB, load",
    "click": "click <sel>   (<sel>: @e3, CSS, text=…, xpath=…)",
    "fill": "fill <sel> <text>   clear the field, then type the text",
    "type": "type <sel> <text>   type key by key into the field",
    "press": "press <key>   Enter, Tab, Escape, ArrowDown, Control+a, Shift+Tab …",
    "wait": "wait <ms> | wait <sel> [--state visible|hidden|attached|detached] | wait --load load|domcontentloaded|networkidle | wait --text <t> | wait --url <glob> | wait --fn <js>   [--timeout <ms>]",
    "eval": "eval <js> | eval --stdin   (the value of the last expression; promises are awaited)",
    "get": "get url|title|text <sel>|html <sel>|value <sel>|attr <name> <sel>|count <css>|box <sel>|styles <sel>",
    "screenshot": "screenshot [path] [--full] [--selector <css>]",
    "tab": "tab [list] | tab new [url] | tab <tN> | tab close [tN]",
    "network": "network route <glob> [--abort|--body <json>] [--resource-type <csv>] | network unroute [glob] | network requests [--clear] [--filter t] [--type xhr,fetch] [--method GET] [--status 400-599] | network request <id>",
    "find": "find role|text|label|placeholder|alt|title|testid <value> [click|fill|type|hover|focus|check|uncheck|text] [text] [--name <n>] [--exact]; find first|last <css> [action]; find nth <n> <css> [action]",
    "auth": "auth login <site> --credential-provider keychain [--url <login page>] [--no-navigate] [--item <account>] [--username-selector css] [--password-selector css] [--submit-selector css]",
    "record": "record start <file.webm|file.mp4> [url] | record stop",
    "upload": "upload <sel> <files...>",
    "select": "select <sel> <value or label...>",
    "set": "set viewport <w> <h> [scale] | set device <name> | set media [dark|light] [reduced-motion] | set offline on|off | set headers <json> | set credentials <u> <p> | set geo <lat> <lng> | set useragent <ua>",
    "cookies": "cookies [get [--url u]] | cookies set <name> <value> [--url u|--domain d] [--path p] [--secure] [--http-only] [--same-site s] [--expires ts] | cookies clear",
    "storage": "storage local|session [<key> | set <k> <v> | remove <k> | clear]",
    "batch": "batch [--bail] [--json] [\"cmd args\" ...]   (or a JSON array of commands on stdin)",
    "stream": "stream status | stream enable [--port <n>] | stream disable",
    "session": "session list | session info",
    "close": "close [--all]",
    "scroll": "scroll up|down|left|right [px] [--selector <css>]",
    "mouse": "mouse move <x> <y> | mouse down|up [left|right|middle] | mouse wheel <dy> [dx]",
    "keyboard": "keyboard type <text> | keyboard inserttext <text>",
    "download": "download <sel> <path>",
]

signal(SIGPIPE, SIG_IGN)
setvbuf(stdout, nil, _IOFBF, 1 << 16)

func out(_ s: String) {
    guard !s.isEmpty else { return }
    FileHandle.standardOutput.write(Data((s.hasSuffix("\n") ? s : s + "\n").utf8))
}

func errOut(_ s: String) {
    FileHandle.standardError.write(Data((s.hasSuffix("\n") ? s : s + "\n").utf8))
}

func selfPath() -> String {
    var size: UInt32 = 4096
    var buf = [CChar](repeating: 0, count: Int(size))
    if _NSGetExecutablePath(&buf, &size) == 0, let real = realpath(buf, nil) {
        defer { free(real) }
        return String(cString: real)
    }
    return CommandLine.arguments[0]
}

// ───────────── the daemon side ─────────────

func runDaemon(session: String, cdp: String?, pin: Bool) -> Never {
    let config = Config.fromEnv(session: session, cdp: cdp, pin: pin)
    let daemon: Daemon
    do {
        daemon = try Daemon(config: config)
    } catch {
        var st = readState(session)
        st["startError"] = "\(error)"
        st["pid"] = nil
        writeState(session, st)
        errOut("start failed: \(error)")
        exit(1)
    }
    let listenFd: Int32
    do { listenFd = try unixListen(socketPath(session)) } catch {
        errOut("\(error)")
        exit(1)
    }
    var sb = stat()
    if stat(socketPath(session), &sb) == 0 { daemon.ownSocket = sb.st_ino }
    var st = readState(session)
    st["session"] = session
    st["pid"] = Int(getpid())
    st["cdp"] = cdp.map { $0 as Any } ?? NSNull()
    st["startError"] = nil
    st["started"] = nowMs()
    writeState(session, st)

    signal(SIGTERM, SIG_IGN)
    let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
    term.setEventHandler { daemon.shutdown(code: 0) }
    term.resume()

    Thread.detachNewThread {
        while true {
            sleep(1)
            daemon.idleCheck()
            // the socket file was removed (or taken over): this daemon is no longer reachable
            var sb = stat()
            if daemon.ownSocket == 0 || stat(socketPath(session), &sb) != 0 || sb.st_ino != daemon.ownSocket {
                daemon.ownSocket = 0
                daemon.q.async { daemon.shutdown(code: 0) }
            }
        }
    }
    Thread.detachNewThread {
        while true {
            let c = accept(listenFd, nil, nil)
            if c < 0 { if errno == EINTR { continue }; sleepMs(50); continue }
            var one: Int32 = 1
            setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
            Thread.detachNewThread {
                defer { close(c) }
                setReadTimeout(c, seconds: 30)
                guard let line = readLine(c), let msg = parseJSON(line) as? JSON else { return }
                let reqCdp = msg["cdp"] as? String
                if reqCdp != cdp || (msg["pin"] as? Bool ?? pin) != pin {
                    // the caller wants another browser (the app restarted it elsewhere): make way
                    daemon.releaseSocket()
                    _ = writeAll(c, jsonData(["restart": true]) + Data("\n".utf8))
                    daemon.q.sync { daemon.shutdown(code: 0) }
                }
                let req = Request(args: msg["args"] as? [String] ?? [], cwd: msg["cwd"] as? String ?? "/", stdin: msg["stdin"] as? String)
                let reply = daemon.handle(req)
                _ = writeAll(c, jsonData(reply) + Data("\n".utf8))
            }
        }
    }
    dispatchMain()
}

// ───────────── the CLI side ─────────────

struct Client {
    let session: String
    let cdp: String?
    let pin: Bool

    func running() -> Bool {
        guard let fd = unixConnect(socketPath(session)) else { return false }
        close(fd)
        return true
    }

    /// Start the session's daemon if it is not running (one at a time per session).
    func ensure() throws {
        if running() { return }
        let lockPath = "\(baseDir)/\(safeName(session)).lock"
        let lfd = open(lockPath, O_CREAT | O_RDWR, 0o600)
        defer { if lfd >= 0 { flock(lfd, LOCK_UN); close(lfd) } }
        if lfd >= 0 { flock(lfd, LOCK_EX) }
        if running() { return }
        var st = readState(session)
        st["startError"] = nil
        writeState(session, st)

        var attr: posix_spawnattr_t?
        posix_spawnattr_init(&attr)
        posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSID))
        var fa: posix_spawn_file_actions_t?
        posix_spawn_file_actions_init(&fa)
        posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0)
        // the log keeps the last daemon's end (why it stopped) unless it grew large
        let big = ((try? FileManager.default.attributesOfItem(atPath: logPath(session)))?[.size] as? Int ?? 0) > 1 << 20
        posix_spawn_file_actions_addopen(&fa, 1, logPath(session), O_WRONLY | O_CREAT | O_APPEND | (big ? O_TRUNC : 0), 0o600)
        posix_spawn_file_actions_adddup2(&fa, 1, 2)
        let exe = selfPath()
        let args = [exe, "__daemon", session, cdp ?? "", pin ? "1" : "0"]
        var cargs = args.map { strdup($0) } + [nil]
        var pid: pid_t = 0
        let rc = posix_spawn(&pid, exe, &fa, &attr, &cargs, environ)
        for p in cargs { free(p) }
        posix_spawn_file_actions_destroy(&fa)
        posix_spawnattr_destroy(&attr)
        guard rc == 0 else { throw BrowserError("could not start the session: \(String(cString: strerror(rc)))") }
        let until = nowMs() + 45000
        while nowMs() < until {
            if running() { return }
            var status: Int32 = 0
            if waitpid(pid, &status, WNOHANG) == pid {
                let why = readState(session).str("startError") ?? (try? String(contentsOfFile: logPath(session), encoding: .utf8))?.split(separator: "\n").last.map(String.init) ?? "it exited"
                throw BrowserError("the browser session could not start: \(why)")
            }
            sleepMs(40)
        }
        throw BrowserError("the browser session did not start within 45 s")
    }

    func send(_ msg: JSON) throws -> JSON {
        for attempt in 0..<2 {
            try ensure()
            guard let fd = unixConnect(socketPath(session)) else { continue }
            defer { close(fd) }
            setReadTimeout(fd, seconds: 900)
            guard writeAll(fd, jsonData(msg) + Data("\n".utf8)) else { continue }
            guard let line = readLine(fd), let reply = parseJSON(line) as? JSON else {
                throw BrowserError("no response came back from the browser session (it may have stopped); try again")
            }
            if reply.bool("restart") == true && attempt == 0 {
                // the old daemon is going away; wait for its socket to go
                let until = nowMs() + 5000
                while running() && nowMs() < until { sleepMs(50) }
                continue
            }
            return reply
        }
        throw BrowserError("Failed to read from the browser session; try again")
    }
}

func liveSessions() -> [String] {
    let files = (try? FileManager.default.contentsOfDirectory(atPath: baseDir)) ?? []
    var names: [String] = []
    for f in files where f.hasSuffix(".json") && !f.hasSuffix(".tmp") {
        guard let d = FileManager.default.contents(atPath: "\(baseDir)/\(f)"), let st = parseJSON(d) as? JSON,
              let name = st.str("session"), let pid = st.int("pid"), kill(pid_t(pid), 0) == 0 else { continue }
        if let fd = unixConnect(socketPath(name)) { close(fd); names.append(name) }
    }
    return names.sorted()
}

func main() -> Int32 {
    var argv = Array(CommandLine.arguments.dropFirst())
    if argv.first == "__daemon", argv.count >= 4 {
        runDaemon(session: argv[1], cdp: argv[2].isEmpty ? nil : argv[2], pin: argv[3] == "1")
    }
    let env = ProcessInfo.processInfo.environment
    var json = false
    var session = env["ONDRA_BROWSER_SESSION"].flatMap { $0.isEmpty ? nil : $0 } ?? "default"
    var cdp = env["ONDRA_BROWSER_CDP"].flatMap { $0.isEmpty ? nil : $0 }
    var pin = ["1", "true", "yes"].contains((env["ONDRA_BROWSER_PIN_TAB"] ?? "").lowercased())
    var words: [String] = []
    var i = 0
    while i < argv.count {
        let a = argv[i]
        switch a {
        case "--json": json = true
        case "--session" where i + 1 < argv.count: session = argv[i + 1]; i += 1
        case "--cdp" where i + 1 < argv.count: cdp = argv[i + 1]; i += 1
        case "--no-pin-tab": pin = false
        case "--pin-tab": pin = true
        default: words.append(a)
        }
        i += 1
    }
    argv = words
    if argv.isEmpty || ["--help", "-h", "help"].contains(argv[0]) { out(help); return 0 }
    if ["--version", "-V", "version"].contains(argv[0]) {
        out(json ? jsonString(["success": true, "data": ["version": version], "error": NSNull()]) : "ondra-browser \(version)")
        return 0
    }
    if argv.count >= 2 && (argv.contains("--help") || argv.last == "-h") {
        out("usage: ondra-browser " + (usage[argv[0]] ?? "\(argv[0]) … (ondra-browser --help lists every command)"))
        return 0
    }

    func finish(_ ok: Bool, _ data: Any, _ text: String, _ error: String?) -> Int32 {
        if json {
            out(jsonString(["success": ok, "data": ok ? data : NSNull(), "error": error ?? NSNull()]))
        } else if ok {
            out(text)
        } else {
            errOut("✗ \(error ?? "failed")")
        }
        return ok ? 0 : 1
    }

    let client = Client(session: session, cdp: cdp, pin: pin)
    let cmd = argv[0], sub = argv.count > 1 ? argv[1] : ""

    // answered without starting anything
    if cmd == "session" && (sub == "list" || sub == "ls") {
        let names = liveSessions()
        return finish(true, ["sessions": names], names.joined(separator: "\n"), nil)
    }
    if cmd == "close" && argv.contains("--all") {
        for name in liveSessions() { _ = try? Client(session: name, cdp: nil, pin: false).sendIfRunning(["args": ["close"]]) }
        return finish(true, ["closed": true], "✓ Closed every session", nil)
    }
    if !client.running() {
        if cmd == "close" { return finish(true, ["closed": true], "✓ Session closed", nil) }
        if cmd == "session" { return finish(true, ["session": session, "active": false, "pid": NSNull()], "no session \(session) running", nil) }
        if cmd == "stream" && (sub == "status" || sub == "") {
            return finish(true, ["enabled": false, "connected": false, "port": NSNull()], "not streaming (no session running)", nil)
        }
    }

    var stdinText: String?
    let wantsStdin = (cmd == "batch" && !argv.dropFirst().contains { !$0.hasPrefix("--") }) || (cmd == "eval" && argv.contains("--stdin"))
    if wantsStdin && isatty(0) == 0 {
        stdinText = String(decoding: FileHandle.standardInput.readDataToEndOfFile(), as: UTF8.self)
    }
    let msg: JSON = ["args": argv, "cwd": FileManager.default.currentDirectoryPath, "stdin": stdinText.map { $0 as Any } ?? NSNull(), "cdp": cdp.map { $0 as Any } ?? NSNull(), "pin": pin]
    let reply: JSON
    do { reply = try client.send(msg) } catch {
        return finish(false, NSNull(), "", "\(error)")
    }
    let ok = reply.bool("success") == true
    if reply.bool("batch") == true {
        if json { out(jsonString(reply["data"] ?? [])) } else { out(reply.str("text") ?? "") }
        return ok ? 0 : 1
    }
    return finish(ok, reply["data"] ?? NSNull(), reply.str("text") ?? "", reply.str("error"))
}

extension Client {
    func sendIfRunning(_ msg: JSON) throws -> JSON? {
        guard running(), let fd = unixConnect(socketPath(session)) else { return nil }
        defer { close(fd) }
        setReadTimeout(fd, seconds: 10)
        var m = msg
        m["cdp"] = readState(session)["cdp"] as? String ?? NSNull()
        m["pin"] = NSNull()
        m["cwd"] = "/"
        _ = writeAll(fd, jsonData(m) + Data("\n".utf8))
        return readLine(fd).flatMap { parseJSON($0) as? JSON }
    }
}

exit(main())
