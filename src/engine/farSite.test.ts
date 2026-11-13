import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// that Mac's files, and the copies made here
const there = new Map<string, { text: string; modified: number }>();
const here = new Map<string, string>();
const refused = new Set<string>();
const enc = (s: string) => new TextEncoder().encode(s);
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
const home = (p: string) => p.replace(/^~/, "/Users/other");

vi.mock("./hosts", () => ({
  askHost: vi.fn(async (_h: string, fn: string, args: unknown[]) => {
    const path = home(String(args[0]));
    if (refused.has(path)) throw new Error("그 파일은 쓸 수 없어요");
    const f = there.get(path);
    if (fn === "far.stat") return f ? { size: enc(f.text).length, modified: f.modified, dir: false } : null;
    if (fn === "far.piece") {
      const all = enc(f!.text);
      return { data: toB64(all.subarray(Number(args[1]), Number(args[1]) + Number(args[2]))), size: all.length, modified: f!.modified };
    }
    throw new Error(`unknown: ${fn}`);
  }),
  tellHost: vi.fn(),
  onPeerKind: vi.fn(),
}));
vi.mock("../lib/native", async (orig) => {
  const real = await orig<typeof import("../lib/native")>();
  return {
    ...real,
    farPut: vi.fn(async (kind: string, name: string, offset: number, data: string) => {
      const p = `/cache/${kind}/${name}`;
      here.set(p, (offset ? here.get(p) ?? "" : "") + fromB64(data));
      return p;
    }),
    farStat: vi.fn(async (p: string) => (here.has(p) ? { size: enc(here.get(p)!).length, modified: 1, dir: false } : null)),
    fsRead: vi.fn(async (p: string) => ({ text: here.get(p) ?? null, size: 0, binary: false, modified: 0 })),
  };
});

import { askHost } from "./hosts";
import { pageSrcOf } from "./far";
import { refreshEngine } from "./rpc";

const put = (p: string, text: string, modified = 1) => there.set(p, { text, modified });
const flush = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};
const fetched = () => vi.mocked(askHost).mock.calls.filter((c) => c[1] === "far.piece").map((c) => home(String((c[2] as unknown[])[0])));

beforeAll(() => refreshEngine());
beforeEach(() => {
  vi.clearAllMocks();
  there.clear();
  here.clear();
  refused.clear();
});

describe("a page of another Mac", () => {
  it("comes with what it uses, laid out as there", async () => {
    const S = "/Users/other/proj/out";
    put(`${S}/index.html`, `<link rel="stylesheet" href="css/style.css"><img src="img/a%20b.png" srcset="img/a@2x.png 2x, img/a@3x.png 3x"><script type="module" src="js/app.js"></script>
      <img src="../shared/logo.svg"><a href="about.html#x">about</a><img src="https://x.dev/a.png"><img src="data:image/png;base64,AA"><img src="/abs.png"><img src="secret.png">`);
    put(`${S}/css/style.css`, `@import "more.css"; body { background: url('../img/bg.jpg') } @font-face { src: url(fonts/f.woff2) }`);
    put(`${S}/css/more.css`, "p{}");
    put(`${S}/css/fonts/f.woff2`, "font");
    put(`${S}/img/a b.png`, "png");
    put(`${S}/img/a@2x.png`, "png2");
    put(`${S}/img/bg.jpg`, "jpg");
    put(`${S}/js/app.js`, `import { u } from "./util.js"; const d = await fetch("../data/d.json");`);
    put(`${S}/js/util.js`, "export const u = 1");
    put(`${S}/data/d.json`, "{}");
    put("/Users/other/proj/shared/logo.svg", `<svg><image href="pic.png"/></svg>`);
    put("/Users/other/proj/shared/pic.png", "pic");
    put(`${S}/about.html`, `<img src="img/bg.jpg">`);
    put(`${S}/secret.png`, "no");
    refused.add(`${S}/secret.png`);

    expect(pageSrcOf(`${S}/index.html`, "H")).toBe("");
    await flush();
    const src = pageSrcOf(`${S}/index.html`, "H");
    const root = src.slice(0, src.indexOf("Users/other/proj/out/index.html"));
    expect(src).toMatch(/^\/cache\/site\/[0-9a-z]+\/Users\/other\/proj\/out\/index\.html\?v=\d+$/);
    const got = [...here.keys()].map((k) => k.slice(root.length)).sort();
    expect(got).toEqual(
      [
        "Users/other/proj/out/about.html",
        "Users/other/proj/out/css/fonts/f.woff2",
        "Users/other/proj/out/css/more.css",
        "Users/other/proj/out/css/style.css",
        "Users/other/proj/out/data/d.json",
        "Users/other/proj/out/img/a b.png",
        "Users/other/proj/out/img/a@2x.png",
        "Users/other/proj/out/img/bg.jpg",
        "Users/other/proj/out/index.html",
        "Users/other/proj/out/js/app.js",
        "Users/other/proj/out/js/util.js",
        "Users/other/proj/shared/logo.svg",
        "Users/other/proj/shared/pic.png",
      ].sort(),
    );
    // asked there in that Mac's terms
    expect(vi.mocked(askHost).mock.calls.every((c) => String((c[2] as unknown[])[0]).startsWith("/Users/other") || typeof (c[2] as unknown[])[0] !== "string")).toBe(true);
  });

  it("is copied again when it changes there, and what didn't change stays", async () => {
    const S = "/Users/other/site";
    put(`${S}/index.html`, `<img src="a.png">`);
    put(`${S}/a.png`, "a");
    pageSrcOf(`${S}/index.html`, "H2");
    await flush();
    const first = pageSrcOf(`${S}/index.html`, "H2");
    expect(fetched().sort()).toEqual([`${S}/a.png`, `${S}/index.html`]);
    vi.clearAllMocks();
    put(`${S}/index.html`, `<img src="a.png"><img src="b.png">`, 2);
    put(`${S}/b.png`, "b");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10_000);
    pageSrcOf(`${S}/index.html`, "H2");
    vi.useRealTimers();
    await flush();
    expect(fetched().sort()).toEqual([`${S}/b.png`, `${S}/index.html`]);
    expect(pageSrcOf(`${S}/index.html`, "H2")).not.toBe(first);
  });
});
