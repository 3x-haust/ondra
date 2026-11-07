import { describe, expect, it } from "vitest";
import {
  acf, auc, avgPrecision, boxStats, calibrationFrom, dendroLines, ecdf, finite, fit4pl, frontier, hclust, hexbin, histogram, hull, kaplanMeier, kde, likert,
  linreg, loess, logDomain, logistic4, logTicks, mosaic, normCdf, normInv, pairs, placeLabels, pooled, powerFit, prFrom, qq, ranks, rocFrom, spc, stars, swarm,
  tInv, ternary, thin, thresholds, tPdf, distPdf, distRange, distSupport, cdfTable, cdfAt, quantileAt,
} from "../src/ui/viz/stat/math";

describe("stat math: inputs", () => {
  it("keeps finite numbers and pairs, never throws on junk", () => {
    expect(finite([1, "2", null, NaN, "x", 3])).toEqual([1, 2, 3]);
    expect(finite(undefined)).toEqual([]);
    expect(pairs([[1, 2], { x: 3, y: 4 }, [1], "bad", { x: "5", y: 6 }])).toEqual([[1, 2], [3, 4], [5, 6]]);
  });
});

describe("stat math: distributions", () => {
  it("box stats: quartiles, whiskers and outliers", () => {
    const b = boxStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])!;
    expect(b.median).toBe(5.5);
    expect(b.outliers).toEqual([100]);
    expect(b.hi).toBe(9);
    expect(b.lo).toBe(1);
    expect(boxStats([])).toBeNull();
  });
  it("histogram bins cover every value once", () => {
    const v = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 10 + 50);
    const th = thresholds(v);
    expect(th[0]).toBeLessThanOrEqual(Math.min(...v));
    expect(th[th.length - 1]).toBeGreaterThan(Math.max(...v));
    expect(histogram(v, th).reduce((s, b) => s + b.n, 0)).toBe(200);
    expect(thresholds([5, 5, 5])).toEqual([4.5, 5.5]);
    expect(thresholds([1, 2, 3, 4], 4).length).toBeGreaterThanOrEqual(4);
  });
  it("kde integrates to about 1", () => {
    const v = [1, 2, 2.5, 3, 3.1, 4, 6];
    const d = kde(v, -5, 12, undefined, 400);
    const step = d[1][0] - d[0][0];
    expect(d.reduce((s, p) => s + p[1] * step, 0)).toBeCloseTo(1, 2);
    expect(kde([], 0, 1)).toEqual([]);
  });
  it("ecdf ends at 1 and merges ties", () => {
    expect(ecdf([3, 1, 2, 2])).toEqual([[1, 0.25], [2, 0.75], [3, 1]]);
  });
  it("normal and t quantiles", () => {
    expect(normInv(0.975)).toBeCloseTo(1.95996, 4);
    expect(normInv(0.5)).toBeCloseTo(0, 8);
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(tInv(0.975, 10)).toBeCloseTo(2.228, 2);
    expect(tInv(0.975, 30)).toBeCloseTo(2.042, 2);
    expect(tPdf(0, 1e6)).toBeCloseTo(0.39894, 3);
  });
  it("qq of a normal sample lies near the line", () => {
    const v = Array.from({ length: 99 }, (_, i) => 10 + 2 * normInv((i + 1) / 100));
    const { pts, line } = qq(v);
    expect(line.slope).toBeCloseTo(2, 1);
    for (const [z, y] of pts) expect(Math.abs(line.icpt + line.slope * z - y)).toBeLessThan(0.3);
  });
  it("swarm keeps dots apart", () => {
    const pos = [0, 0, 0, 1, 2, 2, 10];
    const r = 3;
    const off = swarm(pos, r);
    for (let i = 0; i < pos.length; i++)
      for (let j = i + 1; j < pos.length; j++) expect(Math.hypot(pos[i] - pos[j], off[i] - off[j])).toBeGreaterThanOrEqual(2 * r - 1e-6);
    expect(swarm([0, 0, 0], 2, "up").every((o) => o >= 0)).toBe(true);
  });
});

describe("stat math: fits", () => {
  it("linear regression recovers a line", () => {
    const f = linreg([[0, 1], [1, 3], [2, 5], [3, 7]])!;
    expect(f.slope).toBeCloseTo(2);
    expect(f.icpt).toBeCloseTo(1);
    expect(f.r2).toBeCloseTo(1);
    expect(linreg([[1, 1]])).toBeNull();
    expect(linreg([[1, 1], [1, 2]])).toBeNull();
  });
  it("loess follows a curve", () => {
    const p = Array.from({ length: 60 }, (_, i) => [i / 10, Math.sin(i / 10)] as [number, number]);
    const l = loess(p, 0.3);
    expect(l.length).toBeGreaterThan(10);
    for (const [x, y] of l) expect(Math.abs(y - Math.sin(x))).toBeLessThan(0.1);
  });
  it("power law and 4PL fits", () => {
    const pf = powerFit([[1, 2], [10, 20], [100, 200]])!;
    expect(pf.b).toBeCloseTo(1);
    const truth = { bottom: 5, top: 95, ec50: 3, hill: 1.2 };
    const pts = [0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300].map((x) => [x, logistic4(x, truth)] as [number, number]);
    const f = fit4pl(pts)!;
    expect(f.ec50).toBeCloseTo(3, 0);
    expect(f.top).toBeCloseTo(95, 0);
    expect(fit4pl([[1, 1]])).toBeNull();
  });
});

describe("stat math: evaluation", () => {
  it("roc and auc", () => {
    const roc = rocFrom([0.9, 0.8, 0.7, 0.6, 0.4, 0.3], [1, 1, 0, 1, 0, 0]);
    expect(roc[0]).toEqual([0, 0]);
    expect(roc[roc.length - 1]).toEqual([1, 1]);
    expect(auc(roc)).toBeCloseTo(8 / 9);
    expect(rocFrom([0.5], [1])).toEqual([]);
  });
  it("precision–recall and average precision", () => {
    const pr = prFrom([0.9, 0.8, 0.7], [1, 0, 1]);
    expect(pr[pr.length - 1]).toEqual([1, 2 / 3]);
    expect(avgPrecision(pr)).toBeCloseTo(0.5 * 1 + 0.5 * (2 / 3));
  });
  it("calibration bins", () => {
    const c = calibrationFrom([0.05, 0.15, 0.95, 0.9], [0, 0, 1, 1], 10);
    expect(c.pts.length).toBe(3);
    expect(c.ece).toBeGreaterThan(0);
  });
});

describe("stat math: survival, clustering, quality", () => {
  it("kaplan–meier", () => {
    const k = kaplanMeier([1, 2, 2, 3, 4, 5], [1, 1, 0, 1, 0, 1]);
    expect(k.steps[1]).toMatchObject({ t: 1, s: 5 / 6 });
    expect(k.steps[2].s).toBeCloseTo((5 / 6) * (4 / 5));
    expect(k.censored.map((c) => c[0])).toEqual([2, 4]);
    expect(k.atRisk(3)).toBe(3);
    expect(k.steps.every((s) => s.lo <= s.s && s.s <= s.hi)).toBe(true);
    expect(kaplanMeier(undefined as any, undefined as any).steps.length).toBe(1);
  });
  it("hclust groups near rows and draws 3 segments per merge", () => {
    const d = hclust([[0, 0], [10, 10], [0.1, 0], [10, 10.2]]);
    const pos = d.order.indexOf(0), pos2 = d.order.indexOf(2);
    expect(Math.abs(pos - pos2)).toBe(1);
    expect(dendroLines(d).length).toBe(9);
    expect(hclust([]).order).toEqual([]);
  });
  it("spc limits and rules", () => {
    const v = [10, 11, 9, 10, 10.5, 9.5, 10, 30, 10, 9.8];
    const s = spc(v);
    expect(s.out[7]).toBe(true);
    expect(s.out.filter(Boolean).length).toBe(1);
    const run = spc([1, 1, 1, 1, 1, 1, 1, 1, 0, -5, -5], { center: 0, ucl: 10, lcl: -10 });
    expect(run.run.slice(0, 8).every(Boolean)).toBe(true);
    expect(run.run[9]).toBe(false);
  });
  it("acf of a periodic series", () => {
    const a = acf(Array.from({ length: 48 }, (_, i) => Math.sin((i * Math.PI) / 6)), 12);
    expect(a.r[11]).toBeGreaterThan(0.5);
    expect(a.r[5]).toBeLessThan(-0.5);
  });
  it("pooled estimate weights precise studies", () => {
    const p = pooled([{ value: 1, se: 0.1 }, { value: 0, se: 1 }])!;
    expect(p.value).toBeGreaterThan(0.95);
    expect(pooled([])).toBeNull();
  });
});

describe("stat math: geometry and labels", () => {
  it("ternary corners", () => {
    expect(ternary(1, 0, 0)![1]).toBeCloseTo(Math.sqrt(3) / 2);
    expect(ternary(0, 1, 0)).toEqual([0, 0]);
    expect(ternary(0, 0, 1)).toEqual([1, 0]);
    expect(ternary(-1, 0, 0)).toBeNull();
  });
  it("hull, hexbin, frontier", () => {
    expect(hull([[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0.5]]).length).toBe(4);
    const h = hexbin([[0, 0], [1, 1], [50, 50]], 10);
    expect(h.reduce((s, b) => s + b.n, 0)).toBe(3);
    expect(h.length).toBe(2);
    const pts: [number, number][] = [[1, 50], [2, 70], [3, 65], [4, 80], [2, 40]];
    expect(frontier(pts, "down", "up")).toEqual([0, 1, 3]);
  });
  it("likert centres on neutral", () => {
    const s = likert([10, 20, 40, 20, 10], 5);
    expect(s[2].lo).toBeCloseTo(-20);
    expect(s[2].hi).toBeCloseTo(20);
    expect(s[4].hi).toBeCloseTo(50);
    const e = likert([25, 25, 25, 25], 4);
    expect(e[2].lo).toBeCloseTo(0);
  });
  it("mosaic shares", () => {
    const m = mosaic([[30, 10], [20, 40]]);
    expect(m[0][0].x1).toBeCloseTo(0.4);
    expect(m[1][1].y1).toBeCloseTo(1);
  });
  it("labels avoid each other and ticks thin out", () => {
    const r = placeLabels([{ x: 50, y: 50, w: 40, h: 12 }, { x: 50, y: 50, w: 40, h: 12 }], { x: 0, y: 0, w: 200, h: 200 });
    expect(r[0] && r[1]).toBeTruthy();
    expect(r[0]!.x === r[1]!.x && r[0]!.y === r[1]!.y).toBe(false);
    // a label right beside its own dot is fine; touching the dot is not
    const beside = placeLabels([{ x: 100, y: 100, w: 40, h: 14 }], { x: 0, y: 0, w: 300, h: 300 }, [{ x: 96, y: 96, w: 8, h: 8 }], 4);
    expect(beside[0]).toEqual({ x: 104, y: 93, w: 40, h: 14 });
    expect(thin([0, 10, 20, 30, 40], [30, 30, 30, 30, 30])).toEqual([0, 4]);
    expect(thin([0, 100], [30, 30])).toEqual([0, 1]);
  });
  it("log ticks and domains", () => {
    expect(logTicks(1, 1000).major).toEqual([1, 10, 100, 1000]);
    expect(logTicks(2, 9).major.length).toBeGreaterThanOrEqual(2);
    expect(logTicks(1.9, 4.7).major).toEqual([2, 3, 4]);
    expect(logDomain([2.2, 4.1])[0]).toBeGreaterThan(1.5);
    expect(logDomain([3, 450])).toEqual([1, 1000]);
  });
  it("stars and ranks", () => {
    expect([0.0004, 0.004, 0.04, 0.4].map(stars)).toEqual(["***", "**", "*", "ns"]);
    const r = ranks([0.8, 0.9, null, 0.9, 0.7], "up");
    expect([...r.best]).toEqual([1, 3]);
    expect([...r.second]).toEqual([0]);
    expect([...ranks([3, 1, 2], "down").best]).toEqual([1]);
  });
});

describe("stat math: test distributions", () => {
  it("critical values from the numeric CDF", () => {
    const z = cdfTable(distPdf("normal"), ...distSupport("normal"), 4000);
    expect(quantileAt(z, 0.975)).toBeCloseTo(1.96, 1);
    expect(cdfAt(z, 0)).toBeCloseTo(0.5, 2);
    const t = cdfTable(distPdf("t", 10), ...distSupport("t", 10), 4000);
    expect(quantileAt(t, 0.975)).toBeCloseTo(2.228, 1);
    const c = cdfTable(distPdf("chi2", 3), ...distSupport("chi2", 3), 4000);
    expect(quantileAt(c, 0.95)).toBeCloseTo(7.815, 1);
    expect(distRange("t", 10, 1, 9)[1]).toBeGreaterThan(9);
    const f = cdfTable(distPdf("f", 3, 20), ...distSupport("f", 3, 20), 4000);
    expect(quantileAt(f, 0.95)).toBeCloseTo(3.098, 1);
  });
});
