import { describe, expect, it } from "vitest";
import {
  barPath, calendarCells, cumulate, deltaNum, deltaTone, dodge, ellipsize, foldParts, largestRemainder, marimekko, normSeries,
  pareto, parliamentSeats, parseTime, ranksOf, sharePct, stackSeries, thin, toNum, valueDomain, waterfall, xKind,
} from "../src/ui/viz/chart/math";

describe("chart input clean-up", () => {
  it("reads numbers from numbers and numeric strings only", () => {
    expect(toNum(12)).toBe(12);
    expect(toNum("1,234")).toBe(1234);
    expect(toNum("12.5%")).toBe(12.5);
    expect(toNum("abc")).toBeNull();
    expect(toNum(NaN)).toBeNull();
    expect(toNum(null)).toBeNull();
  });
  it("tells numbers, dates and labels apart on x", () => {
    expect(xKind([1, 2, 3])).toBe("num");
    expect(xKind(["2026-01-01", "2026-02-01"])).toBe("time");
    expect(xKind(["2026-03", "2026-04"])).toBe("time");
    expect(xKind(["1월", "2월"])).toBe("cat");
    expect(xKind(["2024", "2025"])).toBe("cat");
    expect(parseTime("2026-03-01")).toBe(Date.UTC(2026, 2, 1));
  });
  it("normalises series, items and bare values, padding and cutting to x", () => {
    const a = normSeries({ x: ["a", "b", "c"], series: [{ label: "s", values: [1, "2", 3, 4] }, { label: "empty", values: [] }] });
    expect(a.series).toHaveLength(1);
    expect(a.series[0].values).toEqual([1, 2, 3]);
    const b = normSeries({ items: [{ label: "x", value: 3 }, { label: "y", value: "bad" }] });
    expect(b.x).toEqual(["x", "y"]);
    expect(b.series[0].values).toEqual([3, null]);
    const c = normSeries({ values: [5, 6] });
    expect(c.x).toEqual([1, 2]);
    expect(normSeries(null).series).toEqual([]);
    expect(normSeries({ x: ["a"], series: [{ values: [1, null] }] }).series[0].values).toEqual([1]);
  });
  it("includes zero in a domain when the data sits near it", () => {
    expect(valueDomain([20, 100])).toEqual([0, 100]);
    expect(valueDomain([80, 100])).toEqual([80, 100]);
    expect(valueDomain([5, 5])[0]).toBeLessThan(5);
    expect(valueDomain(null)).toEqual([0, 1]);
  });
});

describe("stacking", () => {
  it("stacks, normalises and splits signs", () => {
    const s = stackSeries([[1, 2], [3, null]], "stack");
    expect(s[0]).toEqual([[0, 1], [0, 2]]);
    expect(s[1]).toEqual([[1, 4], [2, 2]]);
    const p = stackSeries([[1, 1], [3, 1]], "percent");
    expect(p[1][0][1]).toBeCloseTo(1);
    expect(p[0][0][1]).toBeCloseTo(0.25);
    const d = stackSeries([[2], [-3]], "diverging");
    expect(d[0][0]).toEqual([0, 2]);
    expect(d[1][0]).toEqual([-3, 0]);
    expect(stackSeries([], "stack")).toEqual([]);
  });
  it("adds up running totals over gaps", () => {
    expect(cumulate([null, 1, 2, null, 3])).toEqual([null, 1, 3, 3, 6]);
  });
});

describe("labels", () => {
  it("dodges overlapping labels apart, keeping order and the range", () => {
    const y = dodge([50, 52, 54, 200], 15, 0, 300);
    expect(y[1] - y[0]).toBeGreaterThanOrEqual(15 - 1e-9);
    expect(y[2] - y[1]).toBeGreaterThanOrEqual(15 - 1e-9);
    expect(y[3]).toBe(200);
    const edge = dodge([0, 1, 2], 10, 0, 100);
    expect(Math.min(...edge)).toBeGreaterThanOrEqual(0);
    expect(dodge([], 10)).toEqual([]);
  });
  it("thins ticks so none overlap", () => {
    const pos = Array.from({ length: 12 }, (_, i) => i * 20);
    const keep = thin(pos, pos.map(() => 30), 4);
    for (let k = 1; k < keep.length; k++) expect(pos[keep[k]] - pos[keep[k - 1]]).toBeGreaterThanOrEqual(34);
    expect(keep[0]).toBe(0);
  });
  it("cuts text to a width with an ellipsis", () => {
    const w = (s: string) => s.length * 10;
    expect(ellipsize("가나다라마바", 40, w)).toBe("가나다…");
    expect(ellipsize("짧음", 100, w)).toBe("짧음");
  });
  it("draws bars square at the baseline and round at the data end", () => {
    expect(barPath(0, 0, 20, 100, "t")).toMatch(/^M0,100V4Q0,0 4,0/);
    expect(barPath(0, 0, 20, 100, "none")).toBe("M0,0h20v100h-20Z");
    expect(barPath(0, 0, 0, 0, "t")).toBe("M0,0h0v0h0Z");
  });
});

describe("part to whole", () => {
  it("folds more than six parts into 기타, keeping the largest", () => {
    const ps = Array.from({ length: 9 }, (_, i) => ({ label: `p${i}`, value: 10 - i }));
    const f = foldParts(ps, 6);
    expect(f).toHaveLength(6);
    expect(f[5]).toMatchObject({ label: "기타", other: true, value: 5 + 4 + 3 + 2 });
    expect(foldParts(ps.slice(0, 4), 6)).toHaveLength(4);
    // a given 기타 is merged, not counted twice
    const g = foldParts([...ps.slice(0, 3), { label: "기타", value: 1 }], 6);
    expect(g.filter((p) => p.label === "기타")).toHaveLength(1);
  });
  it("splits a whole into integers and shares that add up", () => {
    expect(largestRemainder([1, 1, 1], 100).reduce((a, b) => a + b, 0)).toBe(100);
    expect(sharePct([1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(100);
    expect(largestRemainder([0, 0], 10)).toEqual([0, 0]);
  });
  it("lays out a marimekko within 0..1", () => {
    const m = marimekko([[1, 3], [1, 1]]);
    expect(m.cols[0].w + m.cols[1].w).toBeCloseTo(1);
    expect(m.cols[1].w).toBeCloseTo(4 / 6);
    for (const r of m.rects) expect(r.y1).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe("waterfall and pareto", () => {
  it("runs steps and subtotals", () => {
    const w = waterfall([{ label: "시작", value: 100, total: true }, { label: "+", value: 20 }, { label: "-", value: -50 }, { label: "소계", total: true }, { label: "bad" }]);
    expect(w.map((s) => s.kind)).toEqual(["total", "up", "down", "total"]);
    expect(w[2]).toMatchObject({ start: 120, end: 70 });
    expect(w[3]).toMatchObject({ start: 0, end: 70 });
  });
  it("sorts and accumulates to 100%", () => {
    const p = pareto([{ label: "a", value: 1 }, { label: "b", value: 3 }]);
    expect(p[0].label).toBe("b");
    expect(p[1].cum).toBeCloseTo(100);
  });
});

describe("time layouts", () => {
  it("places days in Monday-first week columns", () => {
    const c = calendarCells([{ date: "2026-11-02", value: 1 }, { date: "2026-11-08", value: 2 }, { date: "2026-11-09", value: 3 }]);
    expect(c.cells[0]).toMatchObject({ dow: 0, week: 0 }); // 2026-11-02 is a Monday
    expect(c.cells.find((d) => d.date === "2026-11-08")).toMatchObject({ dow: 6, week: 0 });
    expect(c.cells.find((d) => d.date === "2026-11-09")).toMatchObject({ dow: 0, week: 1 });
    expect(c.weeks).toBe(2);
    expect(calendarCells([{ date: "nope", value: 1 }]).cells).toEqual([]);
  });
  it("ranks values per period, largest first", () => {
    expect(ranksOf([[10, 1], [20, null], [5, 3]])).toEqual([[2, 2], [1, null], [3, 1]]);
  });
});

describe("seats and deltas", () => {
  it("places exactly n seats on a half disc", () => {
    const s = parliamentSeats(130, 100);
    expect(s).toHaveLength(130);
    for (const p of s) expect(p.y).toBeLessThanOrEqual(1e-9);
    expect(parliamentSeats(0, 100)).toEqual([]);
  });
  it("reads deltas and whether they are good", () => {
    expect(deltaNum("+12.5%")).toBe(12.5);
    expect(deltaNum("−3")).toBe(-3);
    expect(deltaTone(-2, "down")).toEqual({ dir: "down", tone: "good" });
    expect(deltaTone(2, "down")).toEqual({ dir: "up", tone: "bad" });
    expect(deltaTone(2, undefined).tone).toBe("flat");
  });
});
