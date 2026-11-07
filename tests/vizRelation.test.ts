import { describe, expect, it } from "vitest";
import { acyclic, alluvialGraph, arcOrder, chordMatrix, cleanLinks, cleanNodes, sankeyLayout } from "../src/ui/viz/relation/layout/flows";
import { cleanGraph, egoLayout, forceLayout, matrixOrder, bundleTree } from "../src/ui/viz/relation/layout/graph";
import { balance, orgIndented, orgLayout, sized, toTree } from "../src/ui/viz/relation/layout/trees";
import { cleanSets, distFor, exclusive, layoutCircles, lens, regions, upset } from "../src/ui/viz/relation/layout/sets";
import { classify, countryName, dotsIn, flowArc, lonLat, sidoCode, SIDO, SIDO_TILES } from "../src/ui/viz/relation/layout/geo";
import { declutter, ellipsize, estW, inkFor, INK_DARK, INK_LIGHT, toNum } from "../src/ui/viz/relation/layout/text";
import { KR_SIDO } from "../src/ui/viz/relation/layout/krSido";
import { feature } from "topojson-client";

describe("relation: text helpers", () => {
  it("ellipsizes to the width and keeps short text", () => {
    expect(ellipsize("서울", 100)).toBe("서울");
    const cut = ellipsize("아주 긴 한국어 라벨이 들어갑니다", 60);
    expect(cut.endsWith("…")).toBe(true);
    expect(estW(cut)).toBeLessThanOrEqual(60);
    expect(ellipsize("가나다", 1)).toBe("");
  });
  it("declutter keeps the higher rank of two colliding boxes", () => {
    const kept = declutter([{ x: 0, y: 0, w: 10, h: 10, rank: 1 }, { x: 5, y: 5, w: 10, h: 10, rank: 2 }, { x: 40, y: 0, w: 5, h: 5 }]);
    expect([...kept].sort()).toEqual([1, 2]);
  });
  it("reads numbers forgivingly", () => {
    expect(toNum("1,234")).toBe(1234);
    expect(toNum("x")).toBeUndefined();
    expect(toNum(NaN)).toBeUndefined();
  });
});

describe("relation: flows", () => {
  it("merges duplicate links, drops self links and bad values", () => {
    const ls = cleanLinks([{ from: "a", to: "b", value: 2 }, { source: "a", target: "b", value: "3" }, { from: "a", to: "a", value: 1 }, { from: "b", to: "c", value: -1 }, null, "x"]);
    expect(ls).toEqual([{ from: "a", to: "b", value: 5, em: false, note: undefined }]);
  });
  it("breaks cycles by dropping the smallest link", () => {
    const ls = acyclic(cleanLinks([{ from: "a", to: "b", value: 5 }, { from: "b", to: "c", value: 4 }, { from: "c", to: "a", value: 1 }]));
    expect(ls.map((l) => `${l.from}${l.to}`)).toEqual(["ab", "bc"]);
  });
  it("lays a sankey inside its box, conserving flow and marking the path", () => {
    const links = cleanLinks([{ from: "A", to: "B", value: 6 }, { from: "A", to: "C", value: 4 }, { from: "B", to: "D", value: 6 }]);
    const s = sankeyLayout(cleanNodes(undefined, links), links, 300, 200, { path: ["A", "B", "D"] });
    expect(s.nodes).toHaveLength(4);
    for (const n of s.nodes) {
      expect(n.x0).toBeGreaterThanOrEqual(0);
      expect(n.x1).toBeLessThanOrEqual(300);
      expect(n.y1).toBeLessThanOrEqual(200.001);
    }
    expect(s.nodes.find((n) => n.id === "A")!.value).toBe(10);
    expect(s.links.filter((l) => l.em).map((l) => l.to.id)).toEqual(["B", "D"]);
    expect(sankeyLayout([], [], 100, 100).nodes).toEqual([]);
  });
  it("builds alluvial stages with one node per stage and category", () => {
    const g = alluvialGraph(["1월", "2월"], [{ path: ["무료", "유료"], value: 3 }, { path: ["무료", "무료"], value: 5 }, { path: ["유료"], value: 2 }, { path: ["유료", "유료"], value: 0 }]);
    expect(g.stages).toEqual(["1월", "2월"]);
    expect(g.cats).toEqual(["무료", "유료"]);
    expect(g.nodes).toHaveLength(3);
    expect(g.links.reduce((s, l) => s + l.value, 0)).toBe(8);
  });
  it("makes a chord matrix from links or keeps a given one", () => {
    const m = chordMatrix({ links: [{ from: "가", to: "나", value: 2 }, { from: "나", to: "가", value: 1 }] });
    expect(m.names).toEqual(["가", "나"]);
    expect(m.matrix).toEqual([[0, 2], [1, 0]]);
    expect(chordMatrix({ names: ["x", "y"], matrix: [[0, "4"], [1]] }).matrix).toEqual([[0, 4], [1, 0]]);
  });
  it("orders arc-diagram nodes by group", () => {
    expect(arcOrder([{ id: "a", label: "a", group: "1" }, { id: "b", label: "b", group: "2" }, { id: "c", label: "c", group: "1" }]).map((n) => n.id)).toEqual(["a", "c", "b"]);
  });
});

describe("relation: networks", () => {
  const g = cleanGraph({
    nodes: [{ id: "a", group: "x" }, { id: "b", group: "x" }, { id: "c", group: "y" }],
    links: [{ from: "a", to: "b", value: 3 }, { from: "b", to: "a", value: 1 }, { from: "b", to: "c" }, { from: "c", to: "d" }],
  });
  it("cleans a graph: undirected duplicates merge, unknown ends become nodes", () => {
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "b", "c", "d"]);
    expect(g.links.find((l) => l.from === "a")!.value).toBe(4);
    expect(g.groups).toEqual(["x", "y"]);
  });
  it("runs the force layout to rest, deterministic and inside the box", () => {
    const a = forceLayout(g, 400, 300);
    const b = forceLayout(g, 400, 300);
    expect(a.map((p) => [p.x, p.y])).toEqual(b.map((p) => [p.x, p.y]));
    for (const p of a) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(400);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(300);
    }
  });
  it("orders the matrix by cluster and builds the bundling tree", () => {
    const o = matrixOrder(g).map((n) => n.group ?? "");
    expect(o.indexOf("y")).toBeGreaterThan(o.lastIndexOf("x"));
    expect(bundleTree(g).children.map((c) => c.name)).toEqual(["x", "y", ""]);
  });
  it("puts neighbours on ring 1 and their neighbours on ring 2", () => {
    const e = egoLayout(g, "a");
    expect(e.center!.id).toBe("a");
    expect(e.nodes.find((n) => n.id === "b")!.ring).toBe(1);
    expect(e.nodes.find((n) => n.id === "c")!.ring).toBe(2);
    expect(e.nodes.find((n) => n.id === "d")).toBeUndefined();
    expect(egoLayout(cleanGraph({}), "z").nodes).toEqual([]);
  });
});

describe("relation: hierarchies", () => {
  it("reads nested, path and parent forms into the same tree", () => {
    const nested = toTree({ items: [{ label: "A", children: [{ label: "a1", value: 2 }, { label: "a2", value: 3 }] }, { label: "B", value: 4 }] });
    const paths = toTree({ items: [{ path: "A/a1", value: 2 }, { path: ["A", "a2"], value: 3 }, { path: "B", value: 4 }] });
    const parents = toTree({ items: [{ id: "A" }, { id: "a1", parent: "A", value: 2 }, { id: "a2", parent: "A", value: 3 }, { id: "B", value: 4 }] });
    for (const t of [nested, paths, parents]) {
      const h = sized(t);
      expect(h.value).toBe(9);
      expect(h.children!.map((c) => c.data.name)).toEqual(["A", "B"]);
    }
  });
  it("cuts parent loops and survives junk", () => {
    const t = toTree({ items: [{ id: "a", parent: "b" }, { id: "b", parent: "a" }, 3, null, {}] });
    expect(sized(t).descendants().length).toBeGreaterThan(1);
    expect(toTree({}).children).toEqual([]);
  });
  it("counts leaves as 1 when nothing has a value", () => {
    expect(sized(toTree({ items: ["a", "b", "c"] })).value).toBe(3);
  });
  it("balances mind-map branches by leaves, keeping order", () => {
    expect(balance([3, 2, 3, 2, 2])).toEqual({ right: [0, 1], left: [4, 3, 2] });
    expect(balance([5])).toEqual({ right: [0], left: [] });
    expect(balance([1, 1])).toEqual({ right: [0], left: [1] });
  });
  it("lays out an org chart: collapsed nodes count what they hide, leaves stack", () => {
    const t = toTree({ root: { label: "대표", children: [{ label: "A", children: [{ label: "a1" }, { label: "a2" }] }, { label: "B", children: [{ label: "b1", children: [{ label: "x" }] }] }] } });
    const L = orgLayout(t, (_id, d) => d < 1);
    expect(L.boxes.map((b) => b.node.name)).toEqual(["대표", "A", "B"]);
    expect(L.boxes.find((b) => b.node.name === "B")!.hidden).toBe(2);
    const open = orgLayout(t, () => true);
    expect(open.boxes.find((b) => b.node.name === "A")!.stacked).toBe(true);
    const wide = orgLayout(t, () => true, false);
    expect(wide.cols).toBeGreaterThan(open.cols);
    expect(orgIndented(t, () => true).rows).toBe(7);
  });
});

describe("relation: sets", () => {
  it("lens area and its inverse agree", () => {
    expect(lens(1, 1, 2)).toBe(0);
    expect(lens(1, 2, 0.5)).toBeCloseTo(Math.PI);
    const d = distFor(1, 1, 1);
    expect(lens(1, 1, d)).toBeCloseTo(1, 4);
  });
  it("makes area-proportional circles for two sets", () => {
    const { names, items } = cleanSets([{ sets: ["A"], value: 100 }, { sets: ["B"], value: 50 }, { sets: ["A", "B"], value: 20 }]);
    const c = layoutCircles(names, items);
    expect(Math.PI * c[0].r ** 2).toBeCloseTo(100);
    const d = Math.hypot(c[0].x - c[1].x, c[0].y - c[1].y);
    expect(lens(c[0].r, c[1].r, d)).toBeCloseTo(20, 1);
  });
  it("keeps disjoint sets apart and subsets inside (Euler)", () => {
    const { names, items } = cleanSets([{ sets: ["전체"], value: 100 }, { sets: ["부분"], value: 10 }, { sets: ["밖"], value: 10 }, { sets: ["전체", "부분"], value: 10 }]);
    const c = layoutCircles(names, items, { disjointUnknown: true });
    const d01 = Math.hypot(c[0].x - c[1].x, c[0].y - c[1].y);
    const d02 = Math.hypot(c[0].x - c[2].x, c[0].y - c[2].y);
    expect(d01 + c[1].r).toBeLessThanOrEqual(c[0].r + 1e-3);
    expect(d02).toBeGreaterThanOrEqual(c[0].r + c[2].r - 1e-3);
  });
  it("finds exclusive region values, inferring triples through subsets", () => {
    const names = ["A", "B", "C"];
    const { items } = cleanSets([{ sets: ["A"], value: 10 }, { sets: ["B"], value: 8 }, { sets: ["C"], value: 6 }, { sets: ["A", "B"], value: 4 }, { sets: ["A", "C"], value: 3 }, { sets: ["B", "C"], value: 2 }, { sets: ["A", "B", "C"], value: 1 }]);
    const ex = exclusive(names, items);
    expect(ex.get(0b111)).toBe(1);
    expect(ex.get(0b001)).toBe(10 - 4 - 3 + 1);
    expect(ex.get(0b011)).toBe(3);
    // no triple given: regions that need it stay unknown
    expect(exclusive(names, items.filter((i) => i.sets.length < 3)).get(0b001)).toBeUndefined();
    // C ⊆ B, so A∩B∩C = A∩C
    const sub = cleanSets([{ sets: ["A"], value: 10 }, { sets: ["B"], value: 8 }, { sets: ["C"], value: 3 }, { sets: ["A", "B"], value: 4 }, { sets: ["A", "C"], value: 2 }, { sets: ["B", "C"], value: 3 }]);
    expect(exclusive(names, sub.items).get(0b111)).toBe(2);
  });
  it("samples a label point for every region present", () => {
    const r = regions([{ x: 0, y: 0, r: 1 }, { x: 1, y: 0, r: 1 }]);
    expect([...r.keys()].sort()).toEqual([1, 2, 3]);
    expect(r.get(3)!.x).toBeCloseTo(0.5, 1);
  });
  it("aggregates UpSet combinations and set totals", () => {
    const u = upset({ items: [{ sets: ["a"], value: 5 }, { sets: ["a", "b"], value: 3 }, { sets: ["b", "a"], value: 1 }, { sets: ["c"], value: 7 }, { sets: [], value: 9 }] }, 2);
    expect(u.names).toEqual(["a", "b", "c"]);
    expect(u.totals).toEqual([9, 4, 7]);
    expect(u.combos.map((c) => c.value)).toEqual([7, 5]);
    expect(u.more).toBe(1);
  });
});

describe("relation: maps", () => {
  it("matches 시도 names in every common form", () => {
    for (const s of ["서울", "서울시", "서울특별시", "Seoul", "KR-11", "11"]) expect(sidoCode(s)).toBe("11");
    expect(sidoCode("충청북도")).toBe("43");
    expect(sidoCode("전라북도")).toBe("45");
    expect(sidoCode("전북특별자치도")).toBe("45");
    expect(sidoCode("강원도")).toBe("42");
    expect(sidoCode("Gyeonggi-do")).toBe("41");
    expect(sidoCode("세종특별자치시")).toBe("50");
    expect(sidoCode("평양")).toBeUndefined();
  });
  it("matches countries by code, English or Korean name", () => {
    for (const s of ["KR", "KOR", "대한민국", "한국", "South Korea"]) expect(countryName(s)).toBe("South Korea");
    expect(countryName("USA")).toBe("United States of America");
    expect(countryName("일본")).toBe("Japan");
    expect(countryName("없는나라")).toBeUndefined();
  });
  it("ships 17 시도 shapes, one tile each", () => {
    const fs = (feature(KR_SIDO, KR_SIDO.objects.sido) as any).features;
    expect(fs.map((f: any) => f.properties.code).sort()).toEqual(Object.keys(SIDO).sort());
    expect(Object.keys(SIDO_TILES).sort()).toEqual(Object.keys(SIDO).sort());
    const cells = new Set(Object.values(SIDO_TILES).map((p) => p.join(",")));
    expect(cells.size).toBe(17);
    expect(JSON.stringify(KR_SIDO).length).toBeLessThan(150_000);
  });
  it("puts dots inside their region, the same every time", () => {
    const seoul = (feature(KR_SIDO, KR_SIDO.objects.sido) as any).features.find((f: any) => f.properties.code === "11");
    const a = dotsIn(seoul, 30, 7);
    expect(a).toHaveLength(30);
    expect(dotsIn(seoul, 30, 7)).toEqual(a);
    for (const [lon, lat] of a) {
      expect(lon).toBeGreaterThan(126.7);
      expect(lon).toBeLessThan(127.3);
      expect(lat).toBeGreaterThan(37.4);
      expect(lat).toBeLessThan(37.75);
    }
  });
  it("reads coordinates in several shapes", () => {
    expect(lonLat({ lat: 37.5, lon: 127 })).toEqual([127, 37.5]);
    expect(lonLat({ lat: 37.5, lng: 127 })).toEqual([127, 37.5]);
    expect(lonLat([37.5, 127])).toEqual([127, 37.5]);
    expect(lonLat({ lat: 200, lon: 0 })).toBeUndefined();
  });
  it("trims a flow arc short of its end", () => {
    const f = flowArc([0, 0], [100, 0], 0.2, 5);
    expect(Math.hypot(f.end[0] - 100, f.end[1])).toBeCloseTo(5);
  });
  it("classes skewed values by quantile so one big region doesn't flatten the rest", () => {
    const pop = [933, 326, 236, 302, 141, 144, 110, 39, 1369, 152, 159, 213, 174, 179, 255, 325, 67];
    const c = classify(pop);
    expect(c.kind).toBe("quantile");
    expect(c.breaks.length - 1).toBeGreaterThanOrEqual(5);
    expect(c.breaks.length - 1).toBeLessThanOrEqual(7);
    expect(c.breaks[0]).toBe(39);
    expect(c.breaks[c.breaks.length - 1]).toBe(1369);
    // every class is used, and the colours spread across the ramp
    const ts = new Set(pop.map(c.t));
    expect(ts.size).toBe(c.breaks.length - 1);
    expect(c.t(39)).toBe(0);
    expect(c.t(1369)).toBe(1);
    expect(c.t(933)).toBe(1);
  });
  it("keeps even data linear and data around 0 diverging", () => {
    expect(classify([2.1, 2.3, 2.5, 2.6, 2.9, 3.1, 3.4]).kind).toBe("linear");
    const d = classify([-0.9, 0.4, 1.4]);
    expect(d.kind).toBe("diverging");
    expect(d.t(1.4)).toBe(1);
    expect(classify([]).kind).toBe("linear");
  });
});

describe("relation: label ink on fills", () => {
  it("puts dark text on light fills and white on dark fills", () => {
    expect(inkFor("#cde2fb")).toBe(INK_DARK);
    expect(inkFor("#0d366b")).toBe(INK_LIGHT);
    expect(inkFor("#b7d3f6", 1, "#0d0d0d")).toBe(INK_DARK);
    expect(inkFor("#104281", 1, "#0d0d0d")).toBe(INK_LIGHT);
    expect(inkFor("#eda100")).toBe(INK_DARK);
    expect(inkFor("rgb(255, 255, 255)")).toBe(INK_DARK);
  });
  it("accounts for a see-through fill over the surface", () => {
    expect(inkFor("#0d366b", 0.15, "#ffffff")).toBe(INK_DARK);
    expect(inkFor("#b7d3f6", 0.15, "#0d0d0d")).toBe(INK_LIGHT);
  });
});
