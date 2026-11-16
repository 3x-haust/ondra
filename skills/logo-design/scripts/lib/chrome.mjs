// Headless Chrome over the DevTools protocol, no npm packages (Node 22+ has WebSocket).
// Finds Ondra's bundled Chrome first ($ONDRA_BROWSER_EXECUTABLE_PATH), then $CHROME_PATH,
// Google Chrome, Chromium and Playwright's cached builds. Starts a private instance with a
// throwaway profile: it never touches the shared browser or its logins.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
function candidates() {
  const list = [process.env.ONDRA_BROWSER_EXECUTABLE_PATH, process.env.CHROME_PATH];
  // running from the app bundle or a source checkout: <root>/skills/... next to resources/chrome
  for (let dir = path.dirname(new URL(import.meta.url).pathname), i = 0; i < 7; i++, dir = path.dirname(dir)) {
    for (const sub of ['chrome', 'resources/chrome', 'src-tauri/resources/chrome', 'Resources/chrome']) {
      const base = path.join(dir, sub);
      list.push(path.join(base, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'), path.join(base, 'chrome-headless-shell-mac-x64/chrome-headless-shell'));
    }
  }
  list.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  );
  const pw = path.join(home, process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  try {
    for (const d of fs.readdirSync(pw).filter(d => d.startsWith('chromium')).sort().reverse()) {
      for (const sub of ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome', 'chrome-headless-shell-linux64/chrome-headless-shell']) list.push(path.join(pw, d, sub));
    }
  } catch { /* no playwright cache */ }
  return list.filter(Boolean);
}

export function findChrome() {
  const hit = candidates().find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!hit) throw new Error('No Chrome found. Set CHROME_PATH to a Chrome or chrome-headless-shell binary.');
  return hit;
}

class Page {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(`${m.error.message} ${m.error.data ?? ''}`)) : res(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') console.error('page error:', m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text);
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') console.error('page console:', m.params.args.map(a => a.value ?? a.description).join(' '));
    });
  }
  send(method, params = {}) {
    return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async viewport(width, height, scale = 1) {
    await this.send('Emulation.setDeviceMetricsOverride', { width: Math.round(width), height: Math.round(height), deviceScaleFactor: scale, mobile: false });
  }
  async transparent(on = true) {
    await this.send('Emulation.setDefaultBackgroundColorOverride', on ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
  }
  /** Load a page from a file (keeps relative links) or from an HTML string. */
  async load({ file, html }) {
    let url = file ? 'file://' + path.resolve(file) : null;
    let tmp;
    if (html) { tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'logo-page-')), 'page.html'); fs.writeFileSync(tmp, html); url = 'file://' + tmp; }
    const loaded = new Promise(r => { const h = ev => { const m = JSON.parse(ev.data); if (m.method === 'Page.loadEventFired') { this.ws.removeEventListener('message', h); r(); } }; this.ws.addEventListener('message', h); });
    await this.send('Page.navigate', { url });
    await loaded;
    await this.eval('document.fonts ? document.fonts.ready.then(() => true) : true');
    if (tmp) fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  /** PNG of the viewport, or of a clip {x, y, width, height}; fullPage takes the whole document. */
  async shot({ clip, fullPage = false, scale = 1 } = {}) {
    if (fullPage) {
      const { w, h } = await this.eval('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })');
      clip = { x: 0, y: 0, width: w, height: h };
    }
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!clip, ...(clip ? { clip: { ...clip, scale } } : {}) });
    return Buffer.from(r.data, 'base64');
  }
  async pdf(opts = {}) {
    const r = await this.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: true, ...opts });
    return Buffer.from(r.data, 'base64');
  }
}

/** Start a private headless Chrome. Returns { page(), close() }. */
export async function launch() {
  const exe = findChrome();
  const profile = fs.mkdtempSync(path.join(process.env.APP_SCRATCH_DIR || os.tmpdir(), 'logo-chrome-'));
  const args = ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--force-color-profile=srgb', '--allow-file-access-from-files', '--disable-background-networking',
    '--mute-audio', 'about:blank'];
  if (!/headless-shell/.test(exe)) args.unshift('--headless=new');
  const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const wsUrl = await new Promise((res, rej) => {
    let buf = '';
    const t = setTimeout(() => rej(new Error('Chrome did not start: ' + buf.slice(-500))), 20000);
    proc.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); res(m[1]); } });
    proc.on('exit', c => { clearTimeout(t); rej(new Error(`Chrome exited (${c}): ${buf.slice(-500)}`)); });
  });
  const port = new URL(wsUrl).port;
  const pages = [];
  return {
    exe,
    async page(width = 1200, height = 800, scale = 1) {
      const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
      const p = new Page(ws); pages.push(p);
      await p.send('Page.enable'); await p.send('Runtime.enable');
      await p.viewport(width, height, scale);
      return p;
    },
    async close() {
      for (const p of pages) try { p.ws.close(); } catch { /* closed */ }
      if (proc.exitCode === null) {
        const exited = new Promise(r => { proc.once('exit', r); setTimeout(r, 3000); });
        proc.kill('SIGTERM');
        await exited;
      }
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* the OS cleans its temp folder */ }
    },
  };
}

/** The in-page helper library (lib/logo.js) as a <script> tag. */
export function logoLibTag() {
  const src = fs.readFileSync(new URL('./logo.js', import.meta.url), 'utf8');
  return `<script>${src}</script>`;
}

/** A blank page with the helper library loaded. */
export async function libPage(browser, width = 1024, height = 1024) {
  const page = await browser.page(width, height);
  await page.load({ html: `<!doctype html><meta charset="utf-8"><body style="margin:0">${logoLibTag()}</body>` });
  return page;
}

export const dataUrlToBuffer = (u) => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64');
