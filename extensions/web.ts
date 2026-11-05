// `web_search` and `web_fetch`: look things up on the web without a browser tab.
// Every engine (main and jobs) gets them, so an answer about a name, a tool or
// a fact can be checked and cited instead of recalled.
//   web_search {query}  → top results: title, url, snippet (Brave's HTML results)
//   web_fetch  {url}    → the page as plain text, trimmed
import { execFile } from "node:child_process";
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

// one search engine, shared by every job on this machine: space the calls and
// back off when it says "too many", instead of failing the first time
let lastAt = 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function search(query: string, signal?: AbortSignal): Promise<{ hits: Hit[]; status: number }> {
  let status = 0;
  for (const backoff of [0, 3000, 8000]) {
    if (backoff) await wait(backoff);
    const gap = lastAt + 1500 - Date.now();
    if (gap > 0) await wait(gap);
    lastAt = Date.now();
    const r = await get(`https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`, signal);
    status = r.status;
    const hits = r.ok ? parseBrave(r.body) : [];
    if (hits.length || (r.ok && r.status !== 202)) return { hits, status };
    if (r.status !== 429 && r.status !== 202 && r.status < 500) break;
  }
  return { hits: [], status };
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
            r.status === 429 ? "The search engine is busy (too many searches). Wait a little and search again, or search in the browser." : `No results (HTTP ${r.status}). Try other words, or search in the browser.`,
            { query: p.query, hits: [] },
          );
        return text(hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n"), { query: p.query, hits });
      } catch (e) {
        return text(`Search failed: ${(e as Error).message}. Try again, or use the browser.`, { query: p.query, hits: [] });
      }
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web fetch",
    exposure: "deferred",
    description: "Read a web page as plain text (scripts, menus and styling dropped). Use after web_search to read the sources you'll cite. Pages that need sign-in or run only in a browser: use the browser instead.",
    promptSnippet: "Read a web page as text",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL" }),
      max: Type.Optional(Type.Number({ description: "max characters (default 12000)" })),
    }),
    async execute(_id: string, p: { url: string; max?: number }, signal?: AbortSignal) {
      if (!/^https?:\/\//.test(p.url)) return text("Only http(s) URLs.");
      const max = Math.max(1000, Math.min(60000, p.max ?? 12000));
      try {
        const r = await get(p.url, signal);
        if (!r.ok) return text(`HTTP ${r.status} for ${p.url}.`, { url: p.url, status: r.status });
        const raw = /html/i.test(r.type) || /^\s*</.test(r.body) ? pageText(r.body) : { title: "", text: r.body };
        const body = raw.text.length > max ? `${raw.text.slice(0, max)}\n… (${raw.text.length - max} more characters; ask with a larger max)` : raw.text;
        return text(`${raw.title ? `# ${raw.title}\n` : ""}${p.url}\n\n${body}`, { url: p.url, title: raw.title });
      } catch (e) {
        return text(`Fetch failed: ${(e as Error).message}.`, { url: p.url });
      }
    },
  });
}
