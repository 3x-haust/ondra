#!/usr/bin/env python3
"""Render a diagram HTML to PNG with headless Chromium (Playwright).

Usage:
  python3 render_png.py IN.html OUT.png [--selector .canvas] [--scale 2] [--full-page] [--single]

Default behavior:
  - captures BOTH themes: OUT.png (light) and OUT-dark.png (data-theme="dark")
  - strips border-radius on .scroller/.canvas for the screenshot only, so the PNG
    has square corners (the HTML keeps its rounded look)
--selector .canvas   screenshots just the diagram element (default)
--full-page          screenshots the whole page instead
--single             capture only the document as authored (no theme toggling)

Setup if Playwright is missing:
  pip install playwright
  python3 -m playwright install --with-deps chromium
Sandboxed hosts without root, if launch fails on a missing shared library (e.g. libXdamage.so.1):
  apt-get download libxdamage1 && dpkg -x libxdamage1_*.deb /tmp/libs
  (this script auto-adds /tmp/libs/usr/lib/*/ to LD_LIBRARY_PATH when that folder exists)

In Ondra (added for Ondra's bundled copy): without Playwright, the same screenshots are
taken with the headless Chrome Ondra ships ($ONDRA_BROWSER_EXECUTABLE_PATH in every job),
driven over the DevTools protocol with the standard library only. Nothing to install.
"""
import glob, os, pathlib, sys

SQUARE_CORNERS = (".scroller{border-radius:0!important;border:none!important}"
                  ".canvas{border-radius:0!important}")


# ───────── Ondra: the bundled headless Chrome when Playwright isn't installed ─────────

def ondra_chrome():
    """The headless Chrome to use without Playwright: Ondra's (set in every job), else one on this Mac."""
    for env in ("ONDRA_BROWSER_EXECUTABLE_PATH", "CHROME_PATH"):
        p = os.environ.get(env)
        if p and os.path.isfile(p):
            return p
    home = os.path.expanduser("~/Library/Application Support")
    found = sorted(glob.glob(f"{home}/dev.3xhaust.ondra/components/chrome/*/*/chrome-headless-shell"), reverse=True)
    found.append("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    return next((p for p in found if os.path.isfile(p)), None)


class _Cdp:
    """A DevTools protocol client over one WebSocket, standard library only."""

    def __init__(self, ws_url):
        import base64, socket, urllib.parse
        u = urllib.parse.urlparse(ws_url)
        self.sock = socket.create_connection((u.hostname, u.port), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise OSError("DevTools closed the connection")
            head += chunk
        if b" 101 " not in head.split(b"\r\n", 1)[0]:
            raise OSError(f"DevTools refused the WebSocket: {head[:80]!r}")
        self.buf = head.split(b"\r\n\r\n", 1)[1]
        self.next_id = 0
        self.events = []

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(1 << 20)
            if not chunk:
                raise OSError("DevTools closed the connection")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _recv(self):
        import json, struct
        data = b""
        while True:
            b0, b1 = self._read(2)
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            payload = self._read(n)
            if mask:
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
            if b0 & 0x0F == 0x8:
                raise OSError("DevTools closed the connection")
            if b0 & 0x0F in (0x9, 0xA):  # ping / pong
                continue
            data += payload
            if b0 & 0x80:
                return json.loads(data)

    def send(self, method, **params):
        import json, struct
        self.next_id += 1
        body = json.dumps({"id": self.next_id, "method": method, "params": params}).encode()
        head = bytes([0x81])
        n = len(body)
        head += bytes([0x80 | n]) if n < 126 else bytes([0x80 | 126]) + struct.pack(">H", n) if n < 65536 \
            else bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        self.sock.sendall(head + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(body)))
        while True:
            msg = self._recv()
            if msg.get("id") == self.next_id:
                if "error" in msg:
                    raise OSError(f"{method}: {msg['error'].get('message')}")
                return msg.get("result", {})
            self.events.append(msg)

    def wait_event(self, method):
        while True:
            if any(e.get("method") == method for e in self.events):
                self.events = [e for e in self.events if e.get("method") != method]
                return
            self.events.append(self._recv())

    def js(self, expr):
        r = self.send("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        return r.get("result", {}).get("value")


def render_with_chrome(chrome, src, out, sel, scale, full, single):
    """render_png's screenshots without Playwright: the same viewport, waits and themes."""
    import base64, json, shutil, subprocess, tempfile, time, urllib.request
    profile = tempfile.mkdtemp(prefix="stack-diagram-chrome-")
    args = [chrome, "--remote-debugging-port=0", f"--user-data-dir={profile}", "--no-first-run",
            "--no-default-browser-check", "--hide-scrollbars", "--font-render-hinting=none", "about:blank"]
    if not chrome.endswith("chrome-headless-shell"):
        args.insert(1, "--headless=new")
    proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        port_file = pathlib.Path(profile, "DevToolsActivePort")
        for _ in range(300):
            if port_file.exists() and port_file.read_text().strip():
                break
            time.sleep(0.05)
        port = port_file.read_text().split()[0]
        targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=10))
        page = next(t for t in targets if t.get("type") == "page")
        cdp = _Cdp(page["webSocketDebuggerUrl"])
        metrics = lambda w: cdp.send("Emulation.setDeviceMetricsOverride", width=w, height=1000,
                                     deviceScaleFactor=scale, mobile=False)
        metrics(1200)
        cdp.send("Page.enable")
        cdp.send("Page.navigate", url=src.as_uri())
        cdp.wait_event("Page.loadEventFired")
        # .scroller clips a canvas wider than the viewport
        width = cdp.js("document.querySelector('.canvas')?.offsetWidth ?? 0") or 0
        if width + 100 > 1200:
            metrics(int(width) + 100)
        time.sleep(1.0)  # let embedded fonts settle
        cdp.js("document.head.appendChild(Object.assign(document.createElement('style'),"
               f"{{textContent:{json.dumps(SQUARE_CORNERS)}}})).sheet && 1")

        def shoot(path):
            if full:
                box = cdp.js("({x:0,y:0,w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight})")
            else:
                box = cdp.js(f"(()=>{{const e=document.querySelector({json.dumps(sel)});if(!e)return null;"
                             "e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();"
                             "return {x:r.left+scrollX,y:r.top+scrollY,w:r.width,h:r.height}})()")
                if not box:
                    sys.exit(f"selector {sel!r} not found in {src.name}")
            shot = cdp.send("Page.captureScreenshot", format="png", captureBeyondViewport=True,
                            clip={"x": box["x"], "y": box["y"], "width": box["w"], "height": box["h"], "scale": 1})
            pathlib.Path(path).write_bytes(base64.b64decode(shot["data"]))
            print(f"rendered {path}")

        if single:
            shoot(out)
        else:
            cdp.js("document.documentElement.removeAttribute('data-theme')")
            time.sleep(0.12)
            shoot(out)
            cdp.js("document.documentElement.setAttribute('data-theme','dark')")
            time.sleep(0.12)
            shoot(out.with_name(out.stem + "-dark" + out.suffix))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(profile, ignore_errors=True)

def main():
    args = sys.argv[1:]
    sel, scale, full, single = ".canvas", 2, False, False
    if "--selector" in args:
        i = args.index("--selector"); sel = args[i + 1]; del args[i:i + 2]
    if "--scale" in args:
        i = args.index("--scale"); scale = float(args[i + 1]); del args[i:i + 2]
    if "--full-page" in args:
        args.remove("--full-page"); full = True
    if "--single" in args:
        args.remove("--single"); single = True
    if len(args) != 2:
        print(__doc__); sys.exit(1)
    src, out = pathlib.Path(args[0]).resolve(), pathlib.Path(args[1])

    lib_dirs = glob.glob("/tmp/libs/usr/lib/*")
    if lib_dirs:
        os.environ["LD_LIBRARY_PATH"] = ":".join(
            lib_dirs + [os.environ.get("LD_LIBRARY_PATH", "")]).rstrip(":")

    # Japanese text renders with Chinese-variant glyphs when no JP font is installed
    import subprocess
    try:
        ja = subprocess.run(["fc-list", ":lang=ja"], capture_output=True, text=True).stdout
        if "Sans" not in ja:
            print("WARNING: no Japanese sans font found — JP text will render with Chinese glyph "
                  "variants. Install a Japanese font, e.g. on Debian/Ubuntu: sudo apt-get install fonts-noto-cjk\n"
                  "  or without root:\n"
                  "  apt-get download fonts-noto-cjk && dpkg -x fonts-noto-cjk_*.deb /tmp/fontx\n"
                  "  mkdir -p ~/.fonts && cp /tmp/fontx/usr/share/fonts/opentype/noto/NotoSansCJK-*.ttc ~/.fonts/ && fc-cache -f")
    except FileNotFoundError:
        pass

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        chrome = ondra_chrome()
        if chrome:
            return render_with_chrome(chrome, src, out, sel, scale, full, single)
        sys.exit("playwright not installed — see setup notes in this script's docstring")

    def shoot(page, path):
        if full:
            page.screenshot(path=str(path), full_page=True)
        else:
            el = page.query_selector(sel)
            if not el:
                sys.exit(f"selector {sel!r} not found in {src.name}")
            el.screenshot(path=str(path))
        print(f"rendered {path}")

    with sync_playwright() as p:
        # headless Chromium hints glyph advances to whole pixels by default: uneven letter spacing
        b = p.chromium.launch(args=["--no-sandbox", "--font-render-hinting=none"])
        page = b.new_page(viewport={"width": 1200, "height": 1000}, device_scale_factor=scale)
        page.goto(src.as_uri())
        # .scroller clips a canvas wider than the viewport
        width = page.evaluate("document.querySelector('.canvas')?.offsetWidth ?? 0")
        if width + 100 > 1200:
            page.set_viewport_size({"width": width + 100, "height": 1000})
        page.wait_for_timeout(1000)  # let embedded fonts settle
        page.add_style_tag(content=SQUARE_CORNERS)
        if single:
            shoot(page, out)
        else:
            page.evaluate("document.documentElement.removeAttribute('data-theme')")
            page.wait_for_timeout(120)
            shoot(page, out)
            page.evaluate("document.documentElement.setAttribute('data-theme','dark')")
            page.wait_for_timeout(120)
            shoot(page, out.with_name(out.stem + "-dark" + out.suffix))
        b.close()

if __name__ == "__main__":
    main()
