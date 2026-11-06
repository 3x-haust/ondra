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

export default function (pi: any) {
  pi.registerTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web. Returns the top results (title, url, snippet). Use it for anything you are not sure is current and exact: names of tools, libraries, people, products, versions, prices, news, anything the user calls by a name you don't recognise. Search with the user's hints (who made it, where it's from), then web_fetch the best pages and cite their URLs.",
    promptSnippet: "Search the web (title, url, snippet)",
    promptGuidelines: [
      "Look things up with web_search / web_fetch before answering about names, tools, versions or facts you can't verify from files; cite the URLs you used.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "what to search for, with the user's hints (maker, site, year)" }),
      count: Type.Optional(Type.Number({ description: "results to return (default 8, max 15)" })),
    }),
    async execute(_id: string, p: { query: string; count?: number }, signal?: AbortSignal) {
      const n = Math.max(1, Math.min(15, p.count ?? 8));
      try {
        const r = await search(p.query, signal);
        const hits = r.hits.slice(0, n);
        if (!hits.length)
          return text(
            r.status === 429 || r.status === 202 || r.busyUntil
              ? "The search engine is refusing searches for now (every job shares it). Don't retry in a loop: search through Aside instead (`aside skills show google-search`, then `aside repl` with googleSearch.search), or work on with what you have and search later."
              : `No results (HTTP ${r.status}). Try other words, or search through Aside.`,
            { query: p.query, hits: [] },
          );
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
    promptSnippet: "Read a web page as text",
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
