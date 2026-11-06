import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
// the engine provides typebox at run time; the schemas don't matter here
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));
import { Cache, Pace, passages } from "./web";

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
