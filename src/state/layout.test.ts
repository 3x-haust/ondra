import { describe, expect, it } from "vitest";
import * as L from "./layout";
import { blankPane, canStep, closePane, equalizePanes, focusPane, gotoPane, layout, newTaskOpen, paneCount, resizePane, setLayout, setPaneRoom, setView, shownIn, splitPane, stepView, toggleZoom, view } from "./ui";
import { keepLayout, layoutOf } from "./panes";

const room: L.Room = { w: 1200, h: 800, gap: 8, minW: 360, minH: 220 };
const base = () => L.single("a", "A");
/** a | b, with b split into b over c */
const three = () => L.split(L.split(base(), "a", "right", "b", "B"), "b", "down", "c", "C");

describe("layout tree", () => {
  it("splits beside the target in each direction and focuses the new pane", () => {
    const r = L.split(base(), "a", "right", "b", "B");
    expect(L.leaves(r.root)).toEqual(["a", "b"]);
    expect(r.focus).toBe("b");
    const l = L.split(base(), "a", "left", "b", "B");
    expect(L.leaves(l.root)).toEqual(["b", "a"]);
    const d = L.split(base(), "a", "down", "b", "B");
    expect((d.root as L.Split).axis).toBe("col");
    expect(L.leaves(three().root)).toEqual(["a", "b", "c"]);
  });

  it("closes a pane: its neighbour takes the room and the focus, the last one stays", () => {
    const t = three();
    const r = L.remove(t, "c");
    expect(L.leaves(r.root)).toEqual(["a", "b"]);
    expect(r.focus).toBe("b");
    expect(r.panes.c).toBeUndefined();
    // closing the left pane gives the focus to the nearest pane on its right
    const r2 = L.remove({ ...t, focus: "a" }, "a");
    expect(r2.focus).toBe("b");
    const one = base();
    expect(L.remove(one, "a")).toBe(one);
  });

  it("moves the focus by direction, nearest first, wrapping at the edges", () => {
    const t = three();
    expect(L.neighbour(t.root, "a", "right")).toBe("b");
    expect(L.neighbour(t.root, "b", "down")).toBe("c");
    expect(L.neighbour(t.root, "c", "up")).toBe("b");
    expect(L.neighbour(t.root, "c", "left")).toBe("a");
    expect(L.neighbour(t.root, "b", "right")).toBe("a");
    expect(L.neighbour(t.root, "a", "up")).toBeNull();
    expect(L.step(t.root, "c", 1)).toBe("a");
    expect(L.step(t.root, "a", -1)).toBe("c");
  });

  it("resizes the nearest split on that axis, kept to the minimum sizes", () => {
    const t = three();
    const r = L.resize(t, "c", "right", 100, room);
    const top = r.root as L.Split;
    expect(top.ratio).toBeCloseTo(0.5 + 100 / (1200 - 8));
    // the vertical split between b and c moves for up/down
    const d = L.resize(t, "c", "up", 80, room);
    expect(((d.root as L.Split).b as L.Split).ratio).toBeCloseTo(0.5 - 80 / (800 - 8));
    // far past the edge: each side keeps its 360px
    const far = L.resize(t, "a", "right", 5000, room);
    const w = L.rects(far.root, room).get("b")!.w;
    expect(w).toBeCloseTo(360);
    // a pane without a split on that axis changes nothing
    const one = base();
    expect(L.resize(one, "a", "left", 50, room)).toBe(one);
  });

  it("zooms one pane and back; moving the focus keeps it zoomed on the new pane", () => {
    const z = L.toggleZoom(three());
    expect(z.zoom).toBe("c");
    expect(L.focus(z, "a").zoom).toBe("a");
    expect(L.toggleZoom(z).zoom).toBeNull();
    expect(L.toggleZoom(base()).zoom).toBeNull();
    expect(L.remove(z, "c").zoom).toBeNull();
  });

  it("equalizes by the panes each side holds, like Ghostty", () => {
    let l = L.split(base(), "a", "right", "b", "B");
    l = L.split(l, "b", "right", "c", "C");
    l = L.setRatio(l, (l.root as L.Split).id, 0.8);
    const e = L.equalize(l);
    const r = L.rects(e.root);
    expect(r.get("a")!.w).toBeCloseTo(1 / 3);
    expect(r.get("b")!.w).toBeCloseTo(1 / 3);
    expect(r.get("c")!.w).toBeCloseTo(1 / 3);
    // nested splits even out too, whichever changed
    let t = three();
    t = L.setRatio(L.setRatio(t, (t.root as L.Split).id, 0.3), ((t.root as L.Split).b as L.Split).id, 0.7);
    const te = L.rects(L.equalize(t).root);
    expect(te.get("a")!.w).toBeCloseTo(0.5);
    expect(te.get("b")!.h).toBeCloseTo(0.5);
    // one split only (a double-click on its divider)
    const one = L.equalize(l, ((l.root as L.Split).b as L.Split).id);
    expect((one.root as L.Split).ratio).toBe(0.8);
  });

  it("knows when a split would leave a pane under its minimum", () => {
    const l = L.split(base(), "a", "right", "b", "B");
    expect(L.canSplit(base(), "a", "right", room)).toBe(true);
    expect(L.canSplit(l, "b", "right", room)).toBe(true);
    const l3 = L.split(l, "b", "right", "c", "C");
    expect(L.canSplit(l3, "c", "right", room)).toBe(false);
    expect(L.canSplit(l3, "c", "down", room)).toBe(true);
    expect(L.fits(l3.root, { ...room, w: 900 })).toBe(false);
  });

  it("reads a stored layout back, dropping panes that can't come back", () => {
    const t = three();
    const raw = JSON.parse(JSON.stringify(t));
    expect(L.parse(raw, (x) => (typeof x === "string" ? x : null))).toEqual(t);
    const gone = L.parse(raw, (x) => (x === "B" ? null : (x as string)));
    expect(L.leaves(gone!.root)).toEqual(["a", "c"]);
    expect(L.parse({ root: { pane: "x" }, panes: {} }, () => null)).toBeNull();
    expect(L.parse("nope", () => "x")).toBeNull();
    expect(L.prune(t, (p) => p !== "A")!.focus).toBe("c");
  });
});

describe("panes in the app", () => {
  const reset = () => {
    setPaneRoom(() => null);
    setLayout(L.single("p1", blankPane()));
  };

  it("acts on the focused pane, each with its own history", () => {
    reset();
    setView({ name: "task", id: "t1" });
    const right = splitPane("right")!;
    expect(paneCount()).toBe(2);
    expect(view()).toEqual({ name: "main" });
    expect(newTaskOpen()).toEqual({});
    setView({ name: "task", id: "t2" });
    expect(newTaskOpen()).toBeNull();
    expect(canStep(-1)).toBe(true);
    stepView(-1);
    expect(view()).toEqual({ name: "main" });
    stepView(1);
    focusPane("p1");
    expect(view()).toEqual({ name: "task", id: "t1" });
    expect(canStep(1)).toBe(false);
    // a job already open beside: it gets the focus instead of a second copy
    setView({ name: "task", id: "t2" });
    expect(layout().focus).toBe(right);
    expect(layout().panes.p1.view).toEqual({ name: "task", id: "t1" });
  });

  it("goes by direction, zooms, equalizes and closes", () => {
    reset();
    splitPane("right", { view: { name: "board" } });
    expect(gotoPane("left")).toBe(true);
    expect(layout().focus).toBe("p1");
    resizePane("right");
    expect((layout().root as L.Split).ratio).toBeGreaterThan(0.5);
    equalizePanes();
    expect((layout().root as L.Split).ratio).toBe(0.5);
    toggleZoom();
    expect(layout().zoom).toBe("p1");
    toggleZoom();
    expect(layout().zoom).toBeNull();
    expect(shownIn({ name: "board" })).toBeDefined();
    expect(closePane()).toBe(true);
    expect(closePane()).toBe(false);
    expect(view()).toEqual({ name: "board" });
  });

  it("refuses a split without room", () => {
    reset();
    setPaneRoom(() => ({ ...room, w: 700 }));
    expect(splitPane("right")).toBeNull();
    expect(paneCount()).toBe(1);
    expect(splitPane("down")).not.toBeNull();
    setPaneRoom(() => null);
  });

  it("keeps the layout per space and drops panes whose job is gone", () => {
    reset();
    setView({ name: "task", id: "kept" });
    splitPane("right", { view: { name: "task", id: "gone" } });
    splitPane("down", { view: { name: "settings" } });
    keepLayout("personal", layout());
    const back = layoutOf("personal", (v) => v.name !== "task" || v.id === "kept")!;
    const views = Object.values(back.panes).map((p) => p.view);
    expect(views).toContainEqual({ name: "task", id: "kept" });
    expect(views).not.toContainEqual({ name: "task", id: "gone" });
    // a pane on settings comes back where it was before
    expect(views.some((v) => v.name === "settings")).toBe(false);
    expect(layoutOf("company", () => true)).toBeNull();
  });
});
