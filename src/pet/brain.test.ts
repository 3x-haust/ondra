import { describe, expect, it } from "vitest";
import { type Body, groundUnder, hear, joinIn, ledgesOf, meet, MEET_AGAIN_MS, nextAct, type Other, pictureFor, release, shown, step, wallMiddle, wallsOf, worldOf, BORED_MS, WORD_MS } from "./brain";
import { parseSpec } from "./spec";
import { petWord, togglePet } from "../engine/pet";

const work = { x: 0, y: 25, w: 1440, h: 850 }; // floor at 875
const body = (o: Partial<Body> = {}): Body => ({ x: 700, y: 875, vx: 0, vy: 0, act: "idle", dir: 1, until: 1e12, on: -1, stirred: 0, ...o });
const r = (v: number) => () => v;

describe("ledges", () => {
  it("has the screen's bottom and the window tops it can see", () => {
    const l = ledgesOf(work, [{ id: 1, x: 100, y: 300, w: 400, h: 300 }]);
    expect(l[0]).toMatchObject({ floor: true, y: 875, x0: 0, x1: 1440 });
    expect(l[1]).toMatchObject({ x0: 100, x1: 500, y: 300 });
  });
  it("a window in front hides the part of a top edge it covers", () => {
    const front = { id: 2, x: 200, y: 250, w: 100, h: 200 };
    const back = { id: 1, x: 100, y: 300, w: 400, h: 300 };
    const l = ledgesOf(work, [front, back]).filter((x) => !x.floor);
    const backs = l.filter((x) => x.y === 300).map((x) => [x.x0, x.x1]);
    expect(backs).toEqual([
      [100, 200],
      [300, 500],
    ]);
  });
  it("skips window tops under the menu bar and slivers too narrow to stand on", () => {
    expect(ledgesOf(work, [{ id: 1, x: 0, y: 30, w: 800, h: 600 }]).length).toBe(1);
    expect(ledgesOf(work, [{ id: 1, x: 0, y: 300, w: 40, h: 100 }]).length).toBe(1);
  });
  it("what is under a point: the nearest ledge below it, else the floor", () => {
    const l = ledgesOf(work, [{ id: 1, x: 100, y: 300, w: 400, h: 300 }]);
    expect(groundUnder(l, 200, 100).y).toBe(300);
    expect(groundUnder(l, 200, 400).y).toBe(875);
    expect(groundUnder(l, 900, 100).floor).toBe(true);
  });
});

describe("moving", () => {
  const win = { id: 1, x: 100, y: 300, w: 400, h: 300 };
  const world = worldOf(work, [win]);
  const top = world.ledges[1];
  it("falls with gravity and lands on the window under it", () => {
    let b = body({ x: 300, y: 100, act: "fall", on: undefined });
    for (let i = 0; i < 120 && b.act === "fall"; i++) b = step(b, world, work, 1 / 60, 0, r(0.9));
    expect(b.act).toBe("idle");
    expect(b.y).toBe(300);
    expect(b.on).toBe(top.id);
  });
  it("falls when the window it stood on is gone", () => {
    const b = step(body({ x: 300, y: 300, on: top.id }), worldOf(work, []), work, 1 / 60, 0, r(0.9));
    expect(b.act).toBe("fall");
  });
  it("rides a window that moved a little", () => {
    const b = step(body({ x: 300, y: 300, on: top.id }), worldOf(work, [{ ...win, y: 320 }]), work, 1 / 60, 0, r(0.9));
    expect(b.act).toBe("idle");
    expect(b.y).toBe(320);
  });
  it("walks and turns at the screen's edge, or climbs it", () => {
    const at = body({ x: 1404, act: "walk", dir: 1 });
    const turned = step(at, world, work, 0.05, 0, r(0.9));
    expect(turned.dir).toBe(-1);
    const climbed = step(at, world, work, 0.05, 0, r(0.1));
    expect(climbed).toMatchObject({ act: "climb", wall: -3, x: 1440, dir: -1 });
  });
  it("at a window's edge it turns back or steps off", () => {
    const edge = body({ x: 497, y: 300, on: top.id, act: "walk", dir: 1 });
    expect(step(edge, world, work, 0.01, 0, r(0.9)).dir).toBe(-1);
    expect(step(edge, world, work, 0.01, 0, r(0.1)).act).toBe("fall");
  });
  it("walking on the floor into a window's side, it climbs up and onto the window", () => {
    const tall = { id: 2, x: 600, y: 400, w: 400, h: 475 }; // its bottom on the floor
    const w2 = worldOf(work, [tall]);
    let b = step(body({ x: 563, act: "walk", dir: 1 }), w2, work, 0.05, 0, r(0.1));
    expect(b).toMatchObject({ act: "climb", x: 600, dir: -1 });
    // it climbs, then hops over in an arc: never a jump of more than a few points in one step
    // where the picture's middle is (half its height above the feet; on a wall: beside it, upright)
    const mid = (x: Body) => (x.wall === undefined ? { x: x.x, y: x.y - 44 } : wallMiddle(w2.walls.find((w) => w.id === x.wall)!, x.y, 70));
    let moved = 0;
    for (let i = 0; i < 4000 && !(b.act === "idle" && b.on !== undefined); i++) {
      const before = mid(b);
      b = step(b, w2, work, 1 / 60, 0, r(0.9));
      const after = mid(b);
      moved = Math.max(moved, Math.hypot(after.x - before.x, after.y - before.y));
    }
    expect(b).toMatchObject({ act: "idle", y: 400 });
    expect(b.x).toBeGreaterThan(600);
    expect(moved).toBeLessThan(20);
  });
  it("on a wall it holds on or lets go; its wall gone, it falls", () => {
    const on = body({ wall: -3, x: 1440, y: 500, act: "cling", until: 0 });
    expect(step(on, world, work, 0.01, 10, r(0.3))).toMatchObject({ act: "cling", wall: -3 });
    expect(step(on, world, work, 0.01, 10, r(0.05))).toMatchObject({ act: "fall", wall: undefined, vx: -80 });
    expect(step({ ...on, wall: 99 }, world, work, 0.01, 10, r(0.3)).act).toBe("fall");
  });
  it("thrown hard at the screen's side, it holds on there", () => {
    const b = step(release(body({ act: "drag", x: 1300, y: 500 }), 2000, 0), world, work, 0.2, 0, r(0.5));
    expect(b).toMatchObject({ act: "cling", wall: -3, x: 1440 });
  });
  it("thrown: it flies at the speed it was let go (capped)", () => {
    const b = release(body({ act: "drag" }), 5000, -200);
    expect(b).toMatchObject({ act: "fall", vx: 900, vy: -200, dir: 1, on: undefined });
  });
  it("held in the air it stays where the pointer put it", () => {
    const b = body({ act: "drag", x: 50, y: 60, on: undefined });
    expect(step(b, world, work, 0.1, 0, r(0.5))).toEqual(b);
  });
  it("a question keeps it alert, and brings it down from a wall", () => {
    expect(step(body({ act: "walk", until: 0 }), world, work, 0.01, 10, r(0.5), { hold: "alert" }).act).toBe("alert");
    expect(step(body({ wall: -3, x: 1440, y: 500, act: "climb" }), world, work, 0.01, 10, r(0.5), { hold: "alert" }).act).toBe("fall");
  });
});

describe("walls", () => {
  it("the screen's sides, and the visible parts of windows' sides", () => {
    const front = { id: 2, x: 50, y: 200, w: 100, h: 200 };
    const back = { id: 1, x: 100, y: 300, w: 400, h: 300 };
    const w = wallsOf(work, [front, back]);
    expect(w.slice(0, 2).map((x) => [x.x, x.side])).toEqual([
      [0, -1],
      [1440, 1],
    ]);
    // back's left side at x=100 is behind front from 300 to 400
    expect(w.filter((x) => x.x === 100).map((x) => [x.y0, x.y1])).toEqual([[400, 600]]);
    expect(w.find((x) => x.x === 500)).toMatchObject({ y0: 300, y1: 600, side: -1 });
  });
});

describe("what it does next", () => {
  it("walks, sits, plays or idles while someone is around", () => {
    const seen = new Set([0.1, 0.4, 0.6, 0.8, 0.9].map((v) => nextAct(body(), 0, r(v), false).act));
    expect([...seen].sort()).toEqual(["idle", "play", "sit", "walk"]);
    expect(nextAct(body(), 0, r(0.8), true).act).not.toBe("play");
  });
  it("falls asleep when nothing happens for a while, and keeps sleeping", () => {
    expect(nextAct(body(), BORED_MS + 1, r(0.1), false).act).toBe("sleep");
    expect(nextAct(body({ act: "sleep" }), BORED_MS + 1, r(0.9), false).act).toBe("sleep");
  });
  it("works along while a job runs", () => {
    expect(nextAct(body(), 0, r(0.1), true).act).toBe("work");
  });
});

describe("what it says", () => {
  const w = (kind: "done" | "waiting" | "failed", taskId: string, at = 0) => ({ kind, taskId, title: taskId, at });
  it("a job's newest word replaces its older one; an answer clears it", () => {
    let l = hear([], w("waiting", "a"));
    l = hear(l, w("done", "a"));
    expect(l).toEqual([w("done", "a")]);
    expect(hear(l, { kind: "clear", taskId: "a" })).toEqual([]);
  });
  it("shows a question before news, and news only while fresh", () => {
    const l = [w("done", "a", 0), w("waiting", "b", 0)];
    expect(shown(l, WORD_MS * 5)?.taskId).toBe("b");
    expect(shown([w("done", "a", 0)], 1000)?.taskId).toBe("a");
    expect(shown([w("done", "a", 0)], WORD_MS + 1)).toBeUndefined();
  });
  it("hears a top-level job finish, wait, fail, or be answered", () => {
    const t = { id: "a", title: "x", status: "done" as const, parentId: undefined };
    expect(petWord(t, "running", 5)).toEqual({ kind: "done", taskId: "a", title: "x", at: 5 });
    expect(petWord({ ...t, status: "waiting" }, "running")?.kind).toBe("waiting");
    expect(petWord({ ...t, status: "running" }, "waiting")).toEqual({ kind: "clear", taskId: "a" });
    expect(petWord({ ...t, parentId: "p" }, "running")).toBeUndefined();
    expect(petWord(t, "done")).toBeUndefined();
  });
});

describe("pictures", () => {
  it("an act without a picture shows the nearest it has", () => {
    expect(pictureFor({ idle: "i", sit: "s" }, "sleep")).toBe("s");
    expect(pictureFor({ idle: "i" }, "walk")).toBe("i");
    expect(pictureFor({ idle: "i", happy: "h" }, "poke")).toBe("h");
  });
  it("pet.json: only plain file names in its folder, and idle is required", () => {
    const src = (f: string) => `/pets/x/${f}`;
    const p = parseSpec("x", JSON.stringify({ name: "고양이", faces: "left", actions: { idle: "idle.gif", walk: "../../etc/passwd", sad: "/abs.gif" } }), src);
    expect(p).toEqual({ id: "x", name: "고양이", faces: "left", actions: { idle: "/pets/x/idle.gif" } });
    expect(parseSpec("x", JSON.stringify({ actions: { walk: "walk.gif" } }), src)).toBeNull();
    expect(parseSpec("x", "not json", src)).toBeNull();
  });
});

describe("several pets", () => {
  it("picking adds a pet, picking it again takes it off, one always stays, five at most", () => {
    expect(togglePet(["default"], "cat")).toEqual(["default", "cat"]);
    expect(togglePet(["default", "cat"], "default")).toEqual(["cat"]);
    expect(togglePet(["cat"], "cat")).toEqual(["cat"]);
    expect(togglePet(["a", "b", "c", "d", "e"], "f")).toEqual(["b", "c", "d", "e", "f"]);
  });
});

describe("with other pets", () => {
  const me = body({ x: 700, act: "walk", dir: 1, on: -1 });
  const other = (o: Partial<Other> = {}): Other => ({ i: 1, x: 800, y: 875, act: "idle", dir: -1, ...o });
  it("waves at one it meets, facing it, then not again for a while", () => {
    const met = new Map<number, number>();
    const b = meet(me, [other({ x: 600 })], 1000, met);
    expect(b).toMatchObject({ act: "greet", dir: -1 });
    expect(meet(me, [other({ x: 600 })], 1000 + MEET_AGAIN_MS / 2, met).act).toBe("walk");
    expect(meet(me, [other({ x: 600 })], 1000 + MEET_AGAIN_MS + 1, met).act).toBe("greet");
  });
  it("doesn't wave at one asleep, far off, on other ground, or while busy with something else", () => {
    const met = new Map<number, number>();
    expect(meet(me, [other({ act: "sleep" })], 0, met).act).toBe("walk");
    expect(meet(me, [other({ x: 1200 })], 0, met).act).toBe("walk");
    expect(meet(me, [other({ y: 300 })], 0, met).act).toBe("walk");
    expect(meet({ ...me, act: "work" }, [other()], 0, met).act).toBe("work");
  });
  it("turns back instead of walking into one it met already", () => {
    const met = new Map([[1, 0]]);
    expect(meet(me, [other({ x: 740 })], 1000, met).dir).toBe(-1);
  });
  it("jumps when one lands on it", () => {
    expect(meet(body({ act: "sit" }), [other({ x: 710, y: 830, act: "fall" })], 0, new Map())).toMatchObject({ act: "poke" });
  });
  it("walks along with one going by, or goes to lie down by one asleep", () => {
    expect(joinIn(body(), [other({ act: "walk", dir: 1 })], r(0.1))).toMatchObject({ act: "walk", dir: 1 });
    expect(joinIn(body(), [other({ act: "sleep", x: 760 })], r(0.1))).toMatchObject({ act: "sleep" });
    expect(joinIn(body(), [other({ act: "sleep", x: 950 })], r(0.1))).toMatchObject({ act: "walk", dir: 1 });
    expect(joinIn(body(), [other({ act: "walk" })], r(0.9))).toBeUndefined();
  });
  it("a wave without its own picture shows happy", () => {
    expect(pictureFor({ idle: "i", happy: "h" }, "greet")).toBe("h");
  });
});
