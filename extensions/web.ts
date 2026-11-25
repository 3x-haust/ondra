// `web_search` and `web_fetch`: look things up on the web without a browser tab.
// Every engine (main and jobs) gets them, so an answer about a name, a tool or
// a fact can be checked and cited instead of recalled.
//   web_search {query}  → top results: title, url, snippet (Brave's HTML results)
//   web_fetch  {url}    → the page as plain text, trimmed
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const text = (t: string, details: Record<string, unknown> = {}) => ({ content: [{ type: "text", text: t }], details });

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'" };
const unescape = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    ENT[e.toLowerCase()] ?? (e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : m),
  );
const strip = (s: string) => unescape(s.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

// curl, not fetch: search engines turn away Node's fetch as a bot but answer curl
function get(url: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; type: string; body: string }> {
  return new Promise((done) => {
    const mark = "\n@@ondra@@";
    const child = execFile(
      "/usr/bin/curl",
      ["-sL", "--compressed", "-m", "20", "-A", UA, "-H", "Accept-Language: en-US,en;q=0.9,ko;q=0.8", "-w", `${mark}%{http_code} %{content_type}`, url],
      { maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
      (err, out) => {
        const at = out.lastIndexOf(mark);
        if (at < 0) return done({ ok: false, status: 0, type: "", body: err ? String(err.message) : "" });
        const [code, ...type] = out.slice(at + mark.length).trim().split(" ");
        const status = Number(code) || 0;
        done({ ok: status >= 200 && status < 300, status, type: type.join(" "), body: out.slice(0, at) });
      },
    );
    signal?.addEventListener("abort", () => child.kill(), { once: true });
  });
}

export type Hit = { title: string; url: string; snippet: string };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One search engine for every job and chat on this machine, each its own
 * process: the pace is kept in a shared folder, not in memory. A lock folder
 * (mkdir is atomic) guards "last" (when the last search went out) and "until"
 * (the engine said too many: nobody searches before then).
 */
export class Pace {
  constructor(
    private dir: string,
    private gapMs = 2000,
    private now = () => Date.now(),
    private sleep = wait,
  ) {
    mkdirSync(dir, { recursive: true });
  }
  private read(name: string) {
    try {
      return Number(readFileSync(join(this.dir, name), "utf8")) || 0;
    } catch {
      return 0;
    }
  }
  private write(name: string, v: number) {
    const tmp = join(this.dir, `${name}.${process.pid}`);
    writeFileSync(tmp, String(v));
    renameSync(tmp, join(this.dir, name));
  }
  private async lock(signal?: AbortSignal) {
    const at = join(this.dir, "lock");
    for (;;) {
      if (signal?.aborted) throw new Error("aborted");
      try {
        mkdirSync(at);
        return () => rmdirSync(at);
      } catch {
        // a lock left by a process that died
        try {
          if (this.now() - statSync(at).mtimeMs > 10_000) rmdirSync(at);
        } catch {}
        await this.sleep(100);
      }
    }
  }
  /** Wait for this process's turn (gap after the last search, and any cool-down), then take it. */
  async turn(signal?: AbortSignal, maxWaitMs = 90_000): Promise<boolean> {
    const start = this.now();
    for (;;) {
      const free = this.read("until");
      const due = Math.max(free, this.read("last") + this.gapMs);
      if (due - this.now() > maxWaitMs - (this.now() - start)) return false;
      if (due > this.now()) await this.sleep(Math.min(due - this.now(), 5000));
      const unlock = await this.lock(signal);
      try {
        if (Math.max(this.read("until"), this.read("last") + this.gapMs) <= this.now()) {
          this.write("last", this.now());
          return true;
        }
      } finally {
        unlock();
      }
    }
  }
  /** The engine said too many: everyone holds off for a while. */
  coolDown(ms: number) {
    this.write("until", Math.max(this.read("until"), this.now() + ms));
  }
  /** When searches are allowed again (0 = now). */
  pausedUntil() {
    const u = this.read("until");
    return u > this.now() ? u : 0;
  }
}

/** Results of the same search in the last ten minutes, kept on disk for every job. */
export class Cache {
  constructor(
    private dir: string,
    private ttlMs = 10 * 60_000,
    private now = () => Date.now(),
  ) {
    mkdirSync(dir, { recursive: true });
  }
  private file(q: string) {
    return join(this.dir, `${createHash("sha1").update(q.trim().toLowerCase().replace(/\s+/g, " ")).digest("hex")}.json`);
  }
  get(q: string): Hit[] | undefined {
    try {
      const v = JSON.parse(readFileSync(this.file(q), "utf8"));
      return this.now() - v.at < this.ttlMs ? v.hits : undefined;
    } catch {
      return undefined;
    }
  }
  set(q: string, hits: Hit[]) {
    const f = this.file(q);
    writeFileSync(`${f}.${process.pid}`, JSON.stringify({ at: this.now(), hits }));
    renameSync(`${f}.${process.pid}`, f);
  }
}

// the user's own temp folder: the same for every job, main chat and side chat
const webDir = join(tmpdir(), "ondra-web");
let pace: Pace | undefined;
let cache: Cache | undefined;
const shared = () => ((pace ??= new Pace(join(webDir, "pace"))), (cache ??= new Cache(join(webDir, "cache"))), { pace, cache });

async function search(query: string, signal?: AbortSignal): Promise<{ hits: Hit[]; status: number; cached?: boolean; busyUntil?: number }> {
  const { pace, cache } = shared();
  const had = cache.get(query);
  if (had) return { hits: had, status: 200, cached: true };
  let status = 0;
  // one retry after the engine's cool-down; the wait is for the shared turn, not a guess
  for (let i = 0; i < 2; i++) {
    if (!(await pace.turn(signal))) return { hits: [], status: 429, busyUntil: pace.pausedUntil() };
    const r = await get(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, signal);
    status = r.status;
    const hits = r.ok ? parseBrave(r.body) : [];
    if (hits.length) cache.set(query, hits);
    if (hits.length || (r.ok && r.status !== 202)) return { hits, status };
    if (r.status !== 429 && r.status !== 202 && r.status < 500) break;
    pace.coolDown(20_000);
  }
  return { hits: [], status, busyUntil: pace.pausedUntil() };
}

/** Brave's server-rendered results page: one `div.snippet[data-type=web]` per result. */
export function parseBrave(html: string): Hit[] {
  const out: Hit[] = [];
  for (const block of html.split(/<div class="snippet [^"]*" data-pos="\d+" data-type="web"/).slice(1)) {
    const url = block.match(/<a href="(https?:\/\/[^"]+)"/)?.[1];
    const title = block.match(/class="title[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    const snip = block.match(/class="content[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    if (url && title && !out.some((h) => h.url === url)) out.push({ title: strip(title), url: unescape(url), snippet: snip ? strip(snip) : "" });
  }
  return out;
}

/** A page as readable text: scripts, styles and navigation dropped, block tags as line breaks. */
export function pageText(html: string): { title: string; text: string } {
  const title = strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const body = (html.match(/<(main|article)[\s>][\s\S]*?<\/\1>/i)?.[0] ?? html)
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|li|h[1-6]|br|tr|section|article|pre|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  const lines = body.split("\n").map(strip).filter(Boolean);
  return { title, text: lines.join("\n") };
}

/** The lines around each place a phrase appears (case and spacing ignored), at most 8 passages. */
export function passages(text: string, phrase: string, around = 2): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const want = norm(phrase);
  const lines = text.split("\n");
  const out: string[] = [];
  let until = -1;
  for (let i = 0; i < lines.length && out.length < 8; i++) {
    // on this line, or broken across it and the next
    const here = norm(lines[i]).includes(want) || (!norm(lines[i + 1] ?? "").includes(want) && norm(`${lines[i]} ${lines[i + 1] ?? ""}`).includes(want));
    if (i <= until || !here) continue;
    const from = Math.max(0, i - around);
    until = Math.min(lines.length - 1, i + around + 1);
    out.push(lines.slice(from, until + 1).join("\n"));
  }
  return out;
}

// ---- the same search in the job's own browser tab, when the engine above turns us away:
// the job doesn't have to judge it, as `web.py search` in deep-research does by hand

const ENGINES: Record<string, string> = {
  naver: "https://search.naver.com/search.naver?where=web&query={q}",
  google: "https://www.google.com/search?q={q}&hl={hl}",
  bing: "https://www.bing.com/search?q={q}",
  yahoo: "https://search.yahoo.com/search?p={q}",
};
/** read in the page: result links (engine wrappers unwrapped, ads and the engine's own links left out) */
const SERP = `(() => {
  const own = /(^|\\.)(bing|google|naver|yahoo|msn|microsoft|duckduckgo)\\.(com|net|co\\.kr)$|(^|\\.)gstatic\\.com$/;
  const unwrap = (href) => {
    try {
      const u = new URL(href, location.href);
      if (/bing\\.com$/.test(u.hostname) && u.searchParams.get('u')) {
        let s = u.searchParams.get('u').slice(2).replace(/-/g, '+').replace(/_/g, '/');
        s += '='.repeat((4 - s.length % 4) % 4);
        return decodeURIComponent(escape(atob(s)));
      }
      if (/google\\./.test(u.hostname) && u.pathname === '/url') return u.searchParams.get('q') || u.searchParams.get('url');
      const ru = href.match(/\\/RU=([^/]+)\\/R[KS]=/); if (ru) return decodeURIComponent(ru[1]);
      return u.href;
    } catch (e) { return null; }
  };
  const page = (document.title + ' ' + location.href + ' ' + (document.body ? document.body.innerText.slice(0, 800) : '')).toLowerCase();
  const blocked = /\\/sorry\\/|unusual traffic|captcha|not a robot|verify (you|you're)|verifying|are you a robot|자동입력 방지/.test(page);
  const hits = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    if (a.closest('header, nav, footer, [role=navigation], [aria-label*="광고"], .b_ad, #tads, #bottomads')) continue;
    const url = unwrap(a.getAttribute('href'));
    if (!url || !/^https?:/.test(url)) continue;
    let host; try { host = new URL(url).hostname; } catch (e) { continue; }
    if (own.test(host)) continue;
    const t = (a.innerText || '').replace(/새 창 열림/g, '').replace(/\\s+/g, ' ').trim();
    const h = hits.get(url) || { url, title: '', snippet: '', heading: false };
    const isHead = !!(a.querySelector('h2, h3') || a.closest('h2, h3'));
    if (t.length >= 8 && !/›|»/.test(t) && (isHead && !h.heading || !h.title)) { if (h.title && h.title !== t && t.length > h.snippet.length) h.snippet = h.title; h.title = t; h.heading = h.heading || isHead; }
    else if (t.length > h.snippet.length && t !== h.title) h.snippet = t;
    if (!h.snippet || h.snippet.length < 40) {
      const box = a.closest('li, article, [data-testid=result], .algo, .b_algo, .g') || a.parentElement && a.parentElement.parentElement && a.parentElement.parentElement.parentElement;
      if (box && box.innerText.length < 1200) { const s = box.innerText.replace(/새 창 열림/g, '').replace(/\\s+/g, ' ').replace(h.title, '').trim(); if (s.length > h.snippet.length) h.snippet = s; }
    }
    hits.set(url, h);
  }
  const list = [...hits.values()].filter((h) => h.title).map(({ heading, ...h }) => ({ ...h, snippet: h.snippet.slice(0, 240) }));
  return JSON.stringify({ blocked: blocked && list.length < 3, hits: list });
})()`;

const STOP = new Set(["the", "and", "for", "with", "what", "how", "why", "vs", "or", "of", "in", "on", "to", "a", "an", "is", "are"]);
/** engines feed junk to a browser they take for a bot: results that share no words with the query */
export function onTopic(q: string, h: Hit): boolean {
  const terms = (q.toLowerCase().match(/[\w.+#가-힣-]+/g) ?? []).filter((t) => !STOP.has(t) && (t.length >= 3 || /[가-힣]/.test(t)));
  if (!terms.length) return true;
  const hay = `${h.title} ${h.snippet} ${h.url}`.toLowerCase();
  return terms.filter((t) => hay.includes(t)).length >= Math.max(1, Math.floor((terms.length + 2) / 3));
}

export type Run = (args: string[], stdin?: string, timeoutMs?: number) => Promise<{ code: number; out: string }>;
/** ondra-browser in the job's own tab (the engine's env names its session) */
const browser: Run = (args, stdin, timeoutMs = 60_000) =>
  new Promise((done) => {
    const child = execFile("ondra-browser", args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, out, errOut) =>
      done({ code: err ? 1 : 0, out: `${out}${err ? `${errOut} ${err.message}` : ""}` }),
    );
    if (stdin !== undefined) child.stdin?.end(stdin);
  });

/** An engine that just turned the tab away sits out a while (the file `web.py` keeps too, shared by every job). */
const benched = (dir: string): Record<string, number> => {
  try {
    return JSON.parse(readFileSync(join(dir, "engines.json"), "utf8"));
  } catch {
    return {};
  }
};
function bench(dir: string, engine: string) {
  const f = join(dir, "engines.json");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${f}.${process.pid}`, JSON.stringify({ ...benched(dir), [engine]: Date.now() / 1000 + 30 * 60 }));
    renameSync(`${f}.${process.pid}`, f);
  } catch {}
}

/** The query on search pages in the job's browser tab, engine by engine, until one gives results on the topic. */
export async function browserSearch(query: string, run: Run = browser, dir = webDir): Promise<{ engine?: string; hits: Hit[]; tried: string[] }> {
  const hangul = /[가-힣]/.test(query);
  const all = hangul ? ["naver", "google", "bing", "yahoo"] : ["google", "bing", "naver", "yahoo"];
  const out = benched(dir);
  const order = all.filter((e) => (out[e] ?? 0) < Date.now() / 1000);
  const tried: string[] = [];
  for (const e of order.length ? order : all) {
    const url = ENGINES[e].replace("{q}", encodeURIComponent(query)).replace("{hl}", hangul ? "ko" : "en");
    const opened = await run(["open", url, "--wait-until", "domcontentloaded"]);
    if (opened.code) {
      tried.push(`${e}: ${opened.out.trim().slice(-120)}`);
      // no browser at all: no other engine will do better
      if (/ENOENT|not found/i.test(opened.out)) break;
      continue;
    }
    await run(["wait", "--fn", "document.readyState !== 'loading' && document.querySelectorAll('a[href]').length > 20"], undefined, 30_000);
    const read = await run(["eval", "--stdin"], SERP, 40_000);
    let d: { blocked?: boolean; hits?: Hit[] };
    try {
      const v = JSON.parse(read.out.trim() || '""');
      d = typeof v === "string" ? JSON.parse(v) : v;
    } catch {
      tried.push(`${e}: unreadable page`);
      continue;
    }
    const hits = (d.hits ?? []).filter((h) => onTopic(query, h));
    if (d.blocked || hits.length < 2) {
      tried.push(`${e}: ${d.blocked ? "captcha or block page" : "no results on the topic"}`);
      bench(dir, e);
      continue;
    }
    return { engine: e, hits, tried };
  }
  return { hits: [], tried };
}

export default function (pi: any) {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    // reached through use; never declared, it carries no prompt lines (they would rebuild the prompt)
    exposure: "deferred",
    description:
      "Search the web. Returns the top results (title, url, snippet). Use it for anything you are not sure is current and exact: names of tools, libraries, people, products, versions, prices, news, anything the user calls by a name you don't recognise. Search with the user's hints (who made it, where it's from), then web_fetch the best pages and cite their URLs.",
    parameters: Type.Object({
      query: Type.String({ description: "what to search for, with the user's hints (maker, site, year)" }),
      count: Type.Optional(Type.Number({ description: "results to return (default 8, max 15)" })),
    }),
    async execute(_id: string, p: { query: string; count?: number }, signal?: AbortSignal) {
      const n = Math.max(1, Math.min(15, p.count ?? 8));
      try {
        const r = await search(p.query, signal);
        const refused = r.status === 429 || r.status === 202 || !!r.busyUntil;
        if (!r.hits.length && refused) {
          // turned away: the same search in this job's browser tab, without the job having to judge it
          const b = await browserSearch(p.query);
          if (b.hits.length) {
            const hits = b.hits.slice(0, n);
            return text(`(searched on ${b.engine} in your browser tab: the usual engine is refusing searches for now)\n${hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n")}`, { query: p.query, hits, engine: b.engine });
          }
          return text(
            `The search engine is refusing searches for now, and your browser tab found nothing either (${b.tried.join("; ") || "no engine to try"}). Don't retry in a loop: work on with what you have and search later, or open a site you know in your ondra-browser tab.`,
            { query: p.query, hits: [] },
          );
        }
        const hits = r.hits.slice(0, n);
        if (!hits.length) return text(`No results (HTTP ${r.status}). Try other words, or search in your ondra-browser tab.`, { query: p.query, hits: [] });
        return text(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n"), { query: p.query, hits, cached: !!r.cached });
      } catch (e) {
        return text(`Search failed: ${(e as Error).message}. Try again, or use the browser.`, { query: p.query, hits: [] });
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web fetch",
    description: "Read a web page as plain text (scripts, menus and styling dropped). Use after web_search to read the sources you'll cite. Pages that need sign-in or run only in a browser: use the browser instead.",
    exposure: "deferred",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL" }),
      max: Type.Optional(Type.Number({ description: "max characters (default 12000)" })),
      find: Type.Optional(Type.String({ description: "only the passages containing this phrase (checking a source's quote or number): a few lines around each match instead of the whole page" })),
    }),
    async execute(_id: string, p: { url: string; max?: number; find?: string }, signal?: AbortSignal) {
      if (!/^https?:\/\//.test(p.url)) return text("Only http(s) URLs.");
      const max = Math.max(1000, Math.min(60000, p.max ?? 12000));
      try {
        const r = await get(p.url, signal);
        if (!r.ok) return text(`HTTP ${r.status} for ${p.url}.`, { url: p.url, status: r.status });
        const raw = /html/i.test(r.type) || /^\s*</.test(r.body) ? pageText(r.body) : { title: "", text: r.body };
        if (p.find?.trim()) {
          const hits = passages(raw.text, p.find);
          return text(
            `${raw.title ? `# ${raw.title}\n` : ""}${p.url}\n\n${hits.length ? hits.join("\n…\n") : `"${p.find}" is not on this page.`}`,
            { url: p.url, title: raw.title, found: hits.length },
          );
        }
        const body = raw.text.length > max ? `${raw.text.slice(0, max)}\n… (${raw.text.length - max} more characters; ask with a larger max)` : raw.text;
        return text(`${raw.title ? `# ${raw.title}\n` : ""}${p.url}\n\n${body}`, { url: p.url, title: raw.title });
      } catch (e) {
        return text(`Fetch failed: ${(e as Error).message}.`, { url: p.url });
      }
    },
  });
}
