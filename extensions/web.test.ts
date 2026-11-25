import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
// the engine provides typebox at run time; the schemas don't matter here
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));
import { browserSearch, Cache, onTopic, Pace, passages, type Run } from "./web";

const dir = () => mkdtempSync(join(tmpdir(), "web-test-"));

describe("Pace", () => {
  it("spaces searches across processes sharing the folder", async () => {
    let now = 1_000_000;
    const sleep = async (ms: number) => void (now += ms);
    const d = dir();
    const a = new Pace(d, 2000, () => now, sleep);
    const b = new Pace(d, 2000, () => now, sleep); // another job: same folder, own object
    expect(await a.turn()).toBe(true);
    const before = now;
    expect(await b.turn()).toBe(true);
    expect(now - before).toBeGreaterThanOrEqual(2000);
  });
  it("holds everyone during a cool-down, and gives up past the wait limit", async () => {
    let now = 5_000_000;
    const sleep = async (ms: number) => void (now += ms);
    const d = dir();
    const a = new Pace(d, 2000, () => now, sleep);
    a.coolDown(20_000);
    const b = new Pace(d, 2000, () => now, sleep);
    expect(b.pausedUntil()).toBe(now + 20_000);
    expect(await b.turn(undefined, 5_000)).toBe(false);
    const t0 = now;
    expect(await b.turn(undefined, 60_000)).toBe(true);
    expect(now - t0).toBeGreaterThanOrEqual(20_000);
  });
});

describe("Cache", () => {
  it("returns the same search within its lifetime, ignoring case and spacing", () => {
    let now = 0;
    const c = new Cache(dir(), 600_000, () => now);
    c.set("Tauri  v2", [{ title: "t", url: "https://x", snippet: "" }]);
    expect(c.get("tauri v2")?.[0].url).toBe("https://x");
    now = 700_000;
    expect(c.get("tauri v2")).toBeUndefined();
  });
});

describe("passages", () => {
  it("gives the lines around a phrase, not the page", () => {
    const text = ["a", "b", "가격은 월 9,900원이에요", "c", "d", "e", "f", "g"].join("\n");
    const out = passages(text, "월 9,900원", 1);
    expect(out).toEqual(["b\n가격은 월 9,900원이에요\nc\nd"]);
    expect(passages(text, "없는 말")).toEqual([]);
  });
});

describe("browserSearch (the engine turned us away: the job's own tab)", () => {
  const page = (hits: { title: string; url: string; snippet: string }[], blocked = false) => JSON.stringify(JSON.stringify({ blocked, hits }));
  const run = (pages: Record<string, string>): Run & { opened: string[] } => {
    const opened: string[] = [];
    let at = "";
    const f = (async (args: string[]) => {
      if (args[0] === "open") {
        at = Object.keys(pages).find((k) => args[1].includes(k)) ?? "";
        opened.push(args[1]);
        return { code: 0, out: "" };
      }
      if (args[0] === "eval") return { code: 0, out: pages[at] ?? page([]) };
      return { code: 0, out: "" };
    }) as Run & { opened: string[] };
    f.opened = opened;
    return f;
  };

  it("skips an engine that shows a captcha or junk, and returns the next one's results on the topic", async () => {
    const r = run({
      "google.com": page([], true),
      "bing.com": page([
        { title: "CGEventTap confine cursor to a display", url: "https://example.com/a", snippet: "use CGWarpMouseCursorPosition" },
        { title: "Restricting the cursor with CGEventTap", url: "https://example.com/b", snippet: "" },
        { title: "피폐 역하렘 남주들의 막내 처제", url: "https://novel.example/x", snippet: "웹소설" },
      ]),
    });
    const got = await browserSearch("CGEventTap confine cursor", r, mkdtempSync(join(tmpdir(), "web-bench-")));
    expect(got.engine).toBe("bing");
    expect(got.hits.map((h) => h.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(got.tried[0]).toContain("google: captcha");
  });

  it("no browser: stops at once and says why", async () => {
    const none: Run = async () => ({ code: 1, out: "spawn ondra-browser ENOENT" });
    const got = await browserSearch("맥 핫코너", none, mkdtempSync(join(tmpdir(), "web-bench-")));
    expect(got.hits).toEqual([]);
    expect(got.tried).toHaveLength(1);
  });

  it("a result is on the topic when it shares enough of the query's words", () => {
    expect(onTopic("macOS hot corner sleep", { title: "Hot corners on macOS", url: "https://x", snippet: "" })).toBe(true);
    expect(onTopic("macOS hot corner sleep", { title: "Minesweeper Online", url: "https://y", snippet: "" })).toBe(false);
  });
});

describe("web_search on a computer without ondra-browser", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });
  it("doesn't try a browser tab when the engine refuses, nor point to one", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    // its own pace and cache folder, and a PATH without the browser
    vi.stubEnv("TMPDIR", dir());
    vi.stubEnv("PATH", dir());
    const ran: string[] = [];
    vi.doMock("node:child_process", () => ({
      execFile: (file: string, _args: string[], _o: unknown, done: (err: Error | null, out: string, errOut: string) => void) => {
        ran.push(file);
        // the engine turns every search away; no program but curl is there
        if (file.endsWith("curl")) done(null, "\n@@ondra@@429 text/html", "");
        else done(Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" }), "", "");
        return { stdin: { end() {} }, kill() {} };
      },
    }));
    const { default: web } = await import("./web");
    const tools: Record<string, { execute: (id: string, p: { query: string }) => Promise<{ content: { text: string }[] }> }> = {};
    web({ registerTool: (t: { name: string }) => void (tools[t.name] = t as never) });

    const got = tools.web_search.execute("1", { query: "tauri clipboard image windows" });
    await vi.advanceTimersByTimeAsync(120_000);
    const said = (await got).content[0].text;

    expect(ran.filter((f) => !f.endsWith("curl"))).toEqual([]);
    expect(said).not.toMatch(/ondra-browser|browser tab/);
  });
});
