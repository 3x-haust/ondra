import { describe, expect, it } from "vitest";
import {
  autoMax, cell, clip, conversions, day, dayTicks, feel, item, layTree, packRows, periodIx, placeLabels, quarters, raci,
  readDecision, readTree, rollback, roughW, statusOf, texts, toNum, wrapPx,
} from "../src/ui/viz/slide/util";

describe("slide: forgiving readers", () => {
  it("reads items from strings or objects and skips the rest", () => {
    expect(item("검색")).toEqual({ label: "검색" });
    expect(item({ name: "A", highlight: true, value: "1,200" })).toEqual({ label: "A", em: true, value: 1200 });
    expect(item({ note: "no label" })).toBeUndefined();
    expect(item(null)).toBeUndefined();
    expect(texts("하나")).toEqual(["하나"]);
    expect(texts(["a", { label: "b" }, 3, null])).toEqual(["a", "b", "3"]);
    expect(texts(undefined)).toEqual([]);
    expect(toNum("12.5%")).toBe(12.5);
    expect(toNum("abc")).toBeUndefined();
  });
  it("reads feature cells, Harvey quarters and RACI letters", () => {
    expect(cell(true).k).toBe("yes");
    expect(cell("△").k).toBe("part");
    expect(cell("미지원").k).toBe("no");
    expect(cell("30일")).toEqual({ k: "text", t: "30일" });
    expect(quarters(0.5)).toBe(2);
    expect(quarters(75)).toBe(3);
    expect(quarters(9)).toBe(0);
    expect(raci("a/r")).toBe("RA");
    expect(raci("x")).toBe("");
    expect(feel(5, true)).toBe(2);
    expect(feel(-7)).toBe(-2);
  });
});

describe("slide: text fitting", () => {
  it("clips with an ellipsis and wraps by words", () => {
    const s = "고객 데이터 플랫폼 연동 현황";
    expect(roughW(s, 10)).toBeGreaterThan(100);
    const c = clip(s, 60, 10);
    expect(c.endsWith("…")).toBe(true);
    expect(roughW(c, 10)).toBeLessThanOrEqual(60);
    expect(clip("짧음", 100, 10)).toBe("짧음");
    const lines = wrapPx(s, 60, 10, 2);
    expect(lines.length).toBe(2);
    for (const l of lines) expect(roughW(l, 10)).toBeLessThanOrEqual(60);
  });
});

describe("slide: layout math", () => {
  it("places point labels without overlap and drops what doesn't fit", () => {
    const pts = [0, 1, 2, 3].map((i) => ({ x: 50 + i * 4, y: 50, r: 4, w: 60, h: 14 }));
    const out = placeLabels(pts, { x: 0, y: 0, w: 200, h: 100 });
    const laid = out.filter((r): r is NonNullable<typeof r> => !!r);
    for (let i = 0; i < laid.length; i++)
      for (let j = i + 1; j < laid.length; j++) {
        const a = laid[i], b = laid[j];
        expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
      }
    expect(laid.length).toBeGreaterThan(1);
  });
  it("picks a domain that holds the values", () => {
    expect(autoMax([0.4, 0.9])).toBe(1);
    expect(autoMax([3, 8])).toBe(10);
    expect(autoMax([340])).toBe(400);
  });
  it("lays a tree out leaf by leaf with parents centred", () => {
    const t = readTree({ label: "r", items: [{ label: "a", items: ["a1", "a2"] }, { label: "b" }, { bad: 1 }] }, item)!;
    const lay = layTree(t);
    expect(lay.rows).toBe(3);
    expect(lay.depth).toBe(2);
    expect(t.kids.length).toBe(2);
    expect(t.kids[0].y).toBe(0.5);
  });
  it("rolls a decision tree back to expected values", () => {
    const t = readTree({
      label: "출시",
      items: [
        { label: "지금", cost: 10, items: [{ label: "좋음", p: 0.6, value: 50 }, { label: "나쁨", p: 40, value: -20 }] },
        { label: "안 함", value: 0 },
      ],
    }, readDecision)!;
    const ev = rollback(t)!;
    // 0.6·50 + 0.4·(−20) = 22, minus the cost 10
    expect(ev).toBeCloseTo(12);
    expect(t.data.kind).toBe("decide");
    expect(t.kids[0].data.kind).toBe("chance");
    expect(t.kids[0].data.best).toBe(true);
    expect(t.kids[1].data.best).toBeUndefined();
  });
  it("computes funnel conversions", () => {
    const c = conversions([1000, 250, 0, 0]);
    expect(c[1]).toEqual({ ofFirst: 0.25, ofPrev: 0.25 });
    expect(c[3].ofPrev).toBeNull();
    expect(c[0].ofPrev).toBeNull();
  });
  it("packs intervals into the fewest rows", () => {
    expect(packRows([{ a: 0, b: 2 }, { a: 1, b: 3 }, { a: 2, b: 4 }])).toEqual([0, 1, 0]);
    expect(packRows([{ a: 0, b: 2 }, { a: 2, b: 4 }], 1)).toEqual([0, 1]);
  });
  it("reads periods by name or index", () => {
    const p = ["1분기", "2분기", "3분기"];
    expect(periodIx("2분기", p)).toBe(1);
    expect(periodIx(9, p)).toBe(2);
    expect(periodIx("5분기", p)).toBeUndefined();
  });
});

describe("slide: dates and status", () => {
  it("parses dates and makes ticks", () => {
    expect(day("2026-11-02")! - day("2026-11-01")!).toBe(1);
    expect(day("2026.11")).toBe(day("2026-11-01"));
    expect(day("2026-13-01")).toBeUndefined();
    expect(day("다음 주")).toBeUndefined();
    const wk = dayTicks(day("2026-11-02")!, day("2026-11-30")!, 6);
    expect(wk.length).toBe(5);
    expect(wk[0].label).toBe("11. 2.");
    const mo = dayTicks(day("2026-01-10")!, day("2026-12-20")!, 6);
    // 11 month starts thinned to quarters
    expect(mo.map((t) => t.label)).toEqual(["4월", "7월", "10월"]);
  });
  it("judges a metric against its target", () => {
    expect(statusOf(105, 100)).toBe("good");
    expect(statusOf(95, 100)).toBe("warn");
    expect(statusOf(70, 100)).toBe("bad");
    expect(statusOf(2.9, 3, "down")).toBe("good");
    expect(statusOf(3.2, 3, "down")).toBe("warn");
    expect(statusOf(4.1, 3, "down")).toBe("bad");
  });
});
