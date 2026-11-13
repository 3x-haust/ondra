// `auth login <site> --credential-provider keychain`: fill a login form from the macOS
// keychain. The password goes keychain → the app's credential helper → this process →
// the page's field. It is never printed, logged, returned or written anywhere.

import Foundation

private let findFieldsJS = #"""
(userSel, passSel) => {
  const vis = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled; };
  const all = (sel) => { const out = []; const visit = (root) => { out.push(...root.querySelectorAll(sel)); for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot); }; visit(document); return out; };
  const pass = passSel ? all(passSel).find(vis) : all('input[type=password]').find(vis);
  let user = null;
  if (userSel) user = all(userSel).find(vis);
  else {
    const scope = (pass && pass.form) || document;
    const cands = [...scope.querySelectorAll('input')].filter((i) => vis(i) && /^(text|email|tel|)$/.test(i.type) && i !== pass);
    const score = (i) => {
      const s = [i.autocomplete, i.name, i.id, i.placeholder, i.getAttribute('aria-label')].join(' ').toLowerCase();
      return (/username|email|login|user|account|identifier|아이디|이메일/.test(s) ? 2 : 0) + (i.type === 'email' ? 1 : 0);
    };
    const before = pass ? cands.filter((i) => i.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING) : cands;
    user = (before.length ? before : cands).sort((a, b) => score(b) - score(a))[0] || null;
    if (user && !pass && score(user) === 0) user = null;
  }
  return { user, pass };
}
"""#

private let submitJS = #"""
function (sel) {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !el.disabled; };
  if (sel) { const b = document.querySelector(sel); if (b) return b; }
  const form = this.form || this.closest('form');
  const scope = form || document;
  const btns = [...scope.querySelectorAll('button, input[type=submit], [role=button]')].filter(vis);
  const typed = btns.find((b) => (b.type || '').toLowerCase() === 'submit');
  const named = btns.find((b) => /log ?in|sign ?in|continue|next|submit|로그인|계속|다음/i.test(b.innerText || b.value || b.getAttribute('aria-label') || ''));
  return typed || named || null;
}
"""#

extension Daemon {
    /// The account and password for a URL, from the credential helper the app names.
    private func credential(url: String, item: String?) throws -> (String, String) {
        guard let helper = config.keychain, FileManager.default.isExecutableFile(atPath: helper) else {
            throw BrowserError("keychain sign-in is not available here (no credential helper)")
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: helper)
        p.arguments = ["--keychain-credential"]
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        p.standardError = FileHandle.nullDevice
        try p.run()
        let req: JSON = ["protocol": "ondra.keychain.v1", "type": "credential.resolve", "request": ["url": url, "itemRef": item.map { $0 as Any } ?? NSNull()] as JSON]
        try? inPipe.fileHandleForWriting.write(contentsOf: jsonData(req))
        try? inPipe.fileHandleForWriting.close()
        // the user may be looking at a keychain approval prompt
        let out = outPipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        guard let reply = parseJSON(out) as? JSON else { throw BrowserError("the keychain gave no answer") }
        guard reply.bool("success") == true, let c = reply.obj("credential"), let pw = c.str("password"), !pw.isEmpty else {
            let why = reply.str("error") ?? "not found"
            throw BrowserError(why == "not found" ? "no saved password for this site in the keychain (or the user denied it)" : "keychain: \(why)")
        }
        return (c.str("username") ?? "", pw)
    }

    private func fields(_ t: Tab, _ userSel: String?, _ passSel: String?) throws -> (String?, String?) {
        let r = try cdp.call("Runtime.evaluate", ["expression": "(\(findFieldsJS))(\(userSel.map { jsonString($0) } ?? "null"), \(passSel.map { jsonString($0) } ?? "null"))"], session: t.sessionId)
        guard let obj = r.obj("result")?.str("objectId") else { return (nil, nil) }
        defer { release(t, obj) }
        let u = try callOn(t, obj, "function(){return this.user}", byValue: false)
        let p = try callOn(t, obj, "function(){return this.pass}", byValue: false)
        return (u.str("subtype") == "null" ? nil : u.str("objectId"), p.str("subtype") == "null" ? nil : p.str("objectId"))
    }

    private func submit(_ t: Tab, from field: String, _ sel: String?) throws {
        let r = try callOn(t, field, submitJS, [sel ?? NSNull()], byValue: false)
        if r.str("subtype") != "null", let b = r.str("objectId") {
            defer { release(t, b) }
            if (try? click(t, b)) != nil { return }
        }
        try focus(t, field)
        try press(t, "Enter")
    }

    func auth(_ a: Args) throws -> Outcome {
        guard a.pos.first == "login" else {
            throw BrowserError("usage: auth login <site> --credential-provider keychain [--url <login page>] [--no-navigate] [--item <account>]")
        }
        let site = a.pos.count > 1 ? a.pos[1] : ""
        let provider = a["credential-provider"] ?? "keychain"
        guard provider == "keychain" else { throw BrowserError("the only credential provider is keychain") }
        let t = try tab()
        if !a.has("no-navigate"), let u = a["url"] {
            try navigate(t, u, waitUntil: "domcontentloaded")
        }
        var url = a["url"] ?? t.with { t.url }
        if !url.contains("://") { url = site.isEmpty ? t.with { t.url } : "https://\(site)" }
        let userSel = a["username-selector"], passSel = a["password-selector"], submitSel = a["submit-selector"]

        // the form may still be rendering
        let (user0, pass0) = try poll(timeoutMs: 15000, what: "a login form") { () -> (String?, String?)? in
            let f = try self.fields(t, userSel, passSel)
            if f.1 != nil { return f }
            if f.0 != nil { return f }
            if let a = f.0 { self.release(t, a) }
            return nil
        }
        let (account, password) = try credential(url: url, item: a["item"])
        var user = user0, pass = pass0
        var filledUser = false
        if let u = user, !account.isEmpty {
            try fill(t, u, account)
            filledUser = true
        }
        if pass == nil, let u = user {
            // a two-step sign-in: the account first, then the password page
            try submit(t, from: u, submitSel)
            release(t, u)
            user = nil
            let f = try poll(timeoutMs: 20000, what: "the password field") { () -> String? in
                let f = try? self.fields(t, nil, passSel)
                if let u = f?.0 { self.release(t, u) }
                return f?.1
            }
            pass = f
        }
        guard let pw = pass else { throw BrowserError("no password field on the page") }
        try focus(t, pw)
        _ = try callOn(t, pw, "function(){ if (typeof this.select === 'function') this.select(); }")
        try cdp.call("Input.insertText", ["text": password], session: t.sessionId)
        _ = try callOn(t, pw, """
        function(v) {
          if (this.value === v) return;
          const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          set ? set.call(this, v) : (this.value = v);
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }
        """, [password])
        try submit(t, from: pw, submitSel)
        release(t, pw)
        if let u = user { release(t, u) }
        sleepMs(500)
        try? waitLifecycle(t, loader: nil, until: "domcontentloaded", timeoutMs: 15000)
        let info = (try? pageInfo(t)) ?? [:]
        let who = account.isEmpty ? "" : " as \(account)"
        return Outcome(["site": site, "account": account, "filledUsername": filledUser, "url": info.str("url") ?? ""],
                       "✓ Filled the sign-in form\(who) from the keychain; now on \(info.str("url") ?? "")")
    }
}
