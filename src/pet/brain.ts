// The pet's body and mind, without a screen: where it can stand (the bottom of the screen and
// the tops of other apps' windows) and climb (the screen's sides and windows' sides), how it moves
// (walks, climbs, holds on, falls with gravity, is thrown and sticks to a wall), and what
// it does next (idles, walks, sits, falls asleep when nothing happens; is happy, alarmed or sad
// when a job ends, needs the user or fails). Pure: the pet window (Pet.tsx) feeds it the world
// and time and draws what it says.

export type Act = "idle" | "walk" | "sit" | "sleep" | "fall" | "drag" | "happy" | "alert" | "sad" | "work" | "climb" | "cling" | "poke" | "play" | "greet";
/** every act a pet can have a picture for. poke: clicked (giggles, startled); play: what it does for fun when nothing's going on */
export const ACTS: Act[] = ["idle", "walk", "sit", "sleep", "fall", "drag", "happy", "alert", "sad", "work", "climb", "cling", "poke", "play", "greet"];

/** what to show when a pet has no picture for an act */
const FALLBACK: Record<Act, Act[]> = {
  idle: [],
  walk: ["idle"],
  sit: ["idle"],
  sleep: ["sit", "idle"],
  fall: ["drag", "idle"],
  drag: ["fall", "idle"],
  happy: ["idle"],
  alert: ["happy", "idle"],
  sad: ["sit", "idle"],
  work: ["sit", "idle"],
  // on a wall the picture is turned so its feet touch the wall: walking up it is climbing
  climb: ["walk", "idle"],
  cling: ["idle"],
  poke: ["happy", "idle"],
  play: ["idle"],
  // another pet came by: it waves
  greet: ["happy", "idle"],
};

/** the picture for an act: its own, or the nearest it has (idle always) */
export function pictureFor(actions: Partial<Record<Act, string>>, act: Act): string | undefined {
  for (const a of [act, ...FALLBACK[act]]) if (actions[a]) return actions[a];
  return actions.idle ?? Object.values(actions)[0];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** a place to stand: a level line from x0 to x1 at height y (screen points, y down). floor: the screen's bottom */
export interface Ledge {
  id: number;
  x0: number;
  x1: number;
  y: number;
  floor?: boolean;
}
export type Win = Box & { id: number };
/** a side to climb: a vertical line at x from y0 to y1. side: where the wall is from the pet on it (1: on its right) */
export interface Wall {
  id: number;
  x: number;
  y0: number;
  y1: number;
  side: 1 | -1;
}
export interface World {
  ledges: Ledge[];
  walls: Wall[];
}

/** narrower than this is no ledge */
const MIN_LEDGE = 60;
/** a window top this close under the menu bar (or above the screen) is not stood on */
const TOP_MARGIN = 40;

/** [a0,a1) minus [b0,b1): what is left of a level line when a window in front covers part of it */
function cut(segs: [number, number][], b0: number, b1: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a0, a1] of segs) {
    if (b1 <= a0 || b0 >= a1) out.push([a0, a1]);
    else {
      if (b0 > a0) out.push([a0, b0]);
      if (b1 < a1) out.push([b1, a1]);
    }
  }
  return out;
}

/**
 * Where the pet can stand on this screen: its bottom (the work area's, above the Dock), and the
 * visible parts of other windows' top edges. `wins` is front to back: a window covers the top
 * edges of the ones behind it.
 */
export function ledgesOf(work: Box, wins: Win[]): Ledge[] {
  const out: Ledge[] = [{ id: -1, x0: work.x, x1: work.x + work.w, y: work.y + work.h, floor: true }];
  wins.forEach((w, i) => {
    const y = w.y;
    if (y < work.y + TOP_MARGIN || y >= work.y + work.h - 8) return;
    let segs: [number, number][] = [[Math.max(w.x, work.x), Math.min(w.x + w.w, work.x + work.w)]];
    for (const f of wins.slice(0, i)) if (f.y <= y - 1 && f.y + f.h >= y - 1) segs = cut(segs, f.x, f.x + f.w);
    segs.filter(([a, b]) => b - a >= MIN_LEDGE).forEach(([a, b], k) => out.push({ id: w.id * 16 + k, x0: a, x1: b, y }));
  });
  return out;
}

/**
 * What the pet can climb: the screen's two sides, and the visible parts of windows' sides (their
 * outsides: it climbs a window's left side from the left). `wins` is front to back, as in ledgesOf.
 */
export function wallsOf(work: Box, wins: Win[]): Wall[] {
  const out: Wall[] = [
    { id: -2, x: work.x, y0: work.y, y1: work.y + work.h, side: -1 },
    { id: -3, x: work.x + work.w, y0: work.y, y1: work.y + work.h, side: 1 },
  ];
  wins.forEach((w, i) => {
    const sides: [number, 1 | -1][] = [
      [w.x, 1],
      [w.x + w.w, -1],
    ];
    sides.forEach(([x, side], k) => {
      if (x <= work.x + 4 || x >= work.x + work.w - 4) return;
      let segs: [number, number][] = [[Math.max(w.y, work.y + TOP_MARGIN), Math.min(w.y + w.h, work.y + work.h)]];
      // a window in front covers it where it overlaps the line (just outside the window, where the pet hangs)
      for (const f of wins.slice(0, i)) if (f.x <= x + side * -2 && f.x + f.w >= x + side * -2) segs = cut(segs, f.y, f.y + f.h);
      segs.filter(([a, b]) => b - a >= MIN_LEDGE).forEach(([a, b], j) => out.push({ id: w.id * 16 + k * 8 + j, x, y0: a, y1: b, side }));
    });
  });
  return out;
}

export const worldOf = (work: Box, wins: Win[]): World => ({ ledges: ledgesOf(work, wins), walls: wallsOf(work, wins) });

/** the closest ledge under (x, y), at or below y (with a little slack), or the floor */
export function groundUnder(ledges: Ledge[], x: number, y: number, slack = 2): Ledge {
  let best: Ledge | undefined;
  for (const l of ledges) if (x >= l.x0 && x <= l.x1 && l.y >= y - slack && (!best || l.y < best.y)) best = l;
  return best ?? ledges.find((l) => l.floor) ?? ledges[0];
}

export interface Body {
  /** the middle of its feet; on a wall: x is the wall, y the middle of the pet along it */
  x: number;
  y: number;
  vx: number;
  vy: number;
  act: Act;
  /** 1: facing right; on a wall, 1 is down and -1 up */
  dir: 1 | -1;
  /** the wall it is on (climbing or holding on) */
  wall?: number;
  /** when the act ends and the next is chosen (ms) */
  until: number;
  /** the ledge it stands on */
  on?: number;
  /** the last time something happened to it (a click, a job): it sleeps when nothing does */
  stirred: number;
}

export const GRAVITY = 2200;
export const WALK = 46;
export const CLIMB = 34;
/** walking into a wall, how often it climbs instead of turning */
export const CLIMB_CHANCE = 0.5;
/** thrown at least this fast into the screen's side, it holds on to it */
export const STICK_SPEED = 250;
/** at a window's top it hops over onto it: up this fast, inward this fast */
const HOP_VY = 800;
const HOP_VX = 150;
/** nothing for this long: it may fall asleep */
export const BORED_MS = 150_000;

export type Rand = () => number;
const between = (r: Rand, a: number, b: number) => a + (b - a) * r();

/** what it does next, standing, when the last act ran out */
export function nextAct(b: Body, now: number, r: Rand, busy: boolean): { act: Act; ms: number; dir?: 1 | -1 } {
  const bored = now - b.stirred > BORED_MS;
  if (b.act === "sleep" && bored) return { act: "sleep", ms: between(r, 20_000, 40_000) };
  const roll = r();
  if (bored && roll < 0.35) return { act: "sleep", ms: between(r, 30_000, 90_000) };
  if (busy && roll < 0.25) return { act: "work", ms: between(r, 6_000, 14_000) };
  if (roll < 0.55) return { act: "walk", ms: between(r, 2_500, 8_000), dir: r() < 0.5 ? -1 : 1 };
  if (roll < 0.72) return { act: "sit", ms: between(r, 4_000, 10_000) };
  // nothing to do: it plays now and then (stretches, looks around)
  if (!busy && roll < 0.84) return { act: "play", ms: between(r, 2_500, 5_000) };
  return { act: "idle", ms: between(r, 1_500, 5_000) };
}

/** acts that hold it still and end on their own */
const STILL: Act[] = ["idle", "sit", "sleep", "happy", "alert", "sad", "work", "poke", "play", "greet"];

export interface StepOpts {
  busy?: boolean;
  hold?: Act;
  /** its picture's size on screen (points) */
  size?: { w: number; h: number };
  /** the other pets: when an act runs out it may join one */
  others?: Other[];
}

/**
 * One step of `dt` seconds. Falling: gravity until it lands on what is under it (thrown hard at the
 * screen's side, it holds on there). Standing: it rides its ledge (a window moved), falls when the
 * ledge is gone, walks, and at a wall (the screen's side, a window's side) may climb it; at a
 * window's edge it turns, climbs down its side or steps off. On a wall: climbs, holds on, lets go;
 * at a window's top it climbs onto it. `hold` keeps an act going (alert while a job waits on the user).
 */
export function step(b: Body, world: World, work: Box, dt: number, now: number, r: Rand, o: StepOpts = {}): Body {
  const n: Body = { ...b };
  const W = o.size?.w ?? 70, H = o.size?.h ?? 88;
  const half = W / 2;
  const minX = work.x + half, maxX = work.x + work.w - half;
  if (n.act === "drag") return n;
  if (n.wall !== undefined) return onWall(n, world, dt, now, r, o, W, H);
  if (n.act === "fall") {
    const y0 = n.y;
    n.vy += GRAVITY * dt;
    const nx = n.x + n.vx * dt;
    if ((nx < minX || nx > maxX) && Math.abs(n.vx) >= STICK_SPEED) {
      const w = world.walls.find((x) => x.id === (nx < minX ? -2 : -3));
      if (w) {
        const y = Math.min(w.y1 - half, Math.max(w.y0 + half, n.y - H / 2));
        return { ...n, wall: w.id, x: w.x, y, vx: 0, vy: 0, act: "cling", dir: -1, on: undefined, until: now + between(r, 1_500, 4_000) };
      }
    }
    n.x = Math.min(maxX, Math.max(minX, nx));
    n.y += n.vy * dt;
    const g = groundUnder(world.ledges, n.x, y0);
    if (n.y >= g.y) {
      n.y = g.y;
      n.vy = 0;
      n.vx = 0;
      n.on = g.id;
      n.act = o.hold ?? "idle";
      n.until = now + 600;
    }
    return n;
  }
  const on = world.ledges.find((l) => l.id === n.on);
  if (!on || n.x < on.x0 - 2 || n.x > on.x1 + 2 || Math.abs(on.y - n.y) > 40) {
    // what it stood on went away (the window closed or moved off): it falls
    return { ...n, act: "fall", vy: 0, vx: 0, on: undefined };
  }
  n.y = on.y;
  if (o.hold && n.act !== o.hold) return { ...n, act: o.hold, until: now + 4_000 };
  if (n.act === "walk") {
    const before = n.x + n.dir * half;
    n.x += n.dir * WALK * dt;
    const front = n.x + n.dir * half;
    // a wall in front, rising from where it walks: sometimes it climbs it
    const w = world.walls.find((x) => x.side === n.dir && (before - x.x) * (front - x.x) <= 0 && x.y1 >= on.y - 6 && x.y0 <= on.y - 60);
    if (w && r() < CLIMB_CHANCE) {
      return { ...n, wall: w.id, x: w.x, y: Math.min(on.y, w.y1) - half - 1, act: "climb", dir: -1, on: undefined, until: now + between(r, 3_000, 9_000) };
    }
    if (n.x <= minX || n.x >= maxX) {
      n.x = Math.min(maxX, Math.max(minX, n.x));
      n.dir = n.x <= minX ? 1 : -1;
    } else if (!on.floor && (n.x <= on.x0 + 4 || n.x >= on.x1 - 4)) {
      // the edge of a window: it turns back or steps off
      if (r() < 0.3) return { ...n, act: "fall", vx: n.dir * WALK, vy: -120, on: undefined };
      n.dir = n.x <= on.x0 + 4 ? 1 : -1;
      n.x = Math.min(on.x1 - 5, Math.max(on.x0 + 5, n.x));
    }
  }
  if (now >= n.until && (STILL.includes(n.act) || n.act === "walk")) {
    if (o.hold) return { ...n, act: o.hold, until: now + 4_000 };
    const next = (o.others?.length && joinIn(n, o.others, r, W)) || nextAct(n, now, r, !!o.busy);
    n.act = next.act;
    n.until = now + next.ms;
    if (next.dir) n.dir = next.dir;
  }
  return n;
}

/** where the pet's picture is when on wall `w` at y: its middle (the picture is turned, feet on the wall) */
export const wallMiddle = (w: Wall, y: number, H: number) => ({ x: w.x - w.side * (H / 2), y });

function onWall(n: Body, world: World, dt: number, now: number, r: Rand, o: StepOpts, W: number, H: number): Body {
  const half = W / 2;
  const w = world.walls.find((x) => x.id === n.wall);
  // upright again around the same middle, so it doesn't jump
  const off = (vx = 0): Body => {
    const m = w ? wallMiddle(w, n.y, H) : { x: n.x, y: n.y };
    return { ...n, wall: undefined, act: "fall", x: m.x, y: m.y + H / 2, vx, vy: 0, on: undefined, dir: vx < 0 ? -1 : vx > 0 ? 1 : n.dir };
  };
  // its wall went away (the window closed or moved off)
  if (!w || Math.abs(w.x - n.x) > 40 || n.y < w.y0 - 40 || n.y > w.y1 + 40) return off();
  n.x = w.x;
  // something happened (a job ended, a question): it lets go to come and say it
  if (o.hold || (n.act !== "climb" && n.act !== "cling")) return off(-w.side * 60);
  if (n.act === "climb") {
    n.y += n.dir * CLIMB * dt;
    if (n.y - half <= w.y0) {
      // the top: it hops up and over onto the window it climbed (an arc from where it is, not a jump
      // cut), or (nothing up there) it holds on
      const tx = w.x + w.side * (half + 2);
      const top = world.ledges.find((l) => !l.floor && Math.abs(l.y - w.y0) <= 3 && tx >= l.x0 && tx <= l.x1);
      if (top) {
        const m = wallMiddle(w, n.y, H);
        return { ...n, wall: undefined, act: "fall", x: m.x, y: m.y + H / 2, vx: w.side * HOP_VX, vy: -HOP_VY, on: undefined, dir: w.side };
      }
      n.y = w.y0 + half;
      n.dir = 1;
      n.act = "cling";
      n.until = now + between(r, 1_500, 4_000);
    } else if (n.y + half >= w.y1) {
      // the bottom: it drops to what is under it
      return off(-w.side * 30);
    }
  }
  if (now >= n.until) {
    const roll = r();
    if (roll < 0.15) return off(-w.side * 80);
    if (roll < 0.45) {
      n.act = "cling";
      n.until = now + between(r, 2_000, 6_000);
    } else {
      n.act = "climb";
      n.dir = r() < 0.6 ? -1 : 1;
      n.until = now + between(r, 2_000, 7_000);
    }
  }
  return n;
}

/** let go after a drag: it flies with the speed it was thrown at (capped) and falls */
export function release(b: Body, vx: number, vy: number): Body {
  const cap = (v: number, m: number) => Math.max(-m, Math.min(m, v));
  return { ...b, act: "fall", vx: cap(vx, 900), vy: cap(vy, 900), on: undefined, wall: undefined, dir: vx < -20 ? -1 : vx > 20 ? 1 : b.dir };
}

// ───────────── what it says

export type WordKind = "done" | "waiting" | "failed";
export interface Word {
  kind: WordKind;
  taskId: string;
  title: string;
  at: number;
  /** a question with choices: answered right from the bubble */
  ask?: { decisionId: string; question: string; options: { id: string; label: string; primary?: boolean }[] };
}
/** a done or failed word goes away on its own; a question stays until it is answered */
export const WORD_MS = 12_000;

/** The words the pet carries after `w` came (or a clear for a job): a job's newest word replaces its older one. */
export function hear(words: Word[], w: Word | { kind: "clear"; taskId: string }): Word[] {
  const rest = words.filter((x) => x.taskId !== w.taskId);
  return w.kind === "clear" ? rest : [...rest, w].slice(-6);
}
/** what it shows now: a question first (the user is needed), then the newest word still fresh */
export function shown(words: Word[], now: number): Word | undefined {
  const ask = words.filter((w) => w.kind === "waiting");
  if (ask.length) return ask[ask.length - 1];
  return [...words].reverse().find((w) => now - w.at < WORD_MS);
}
/** the act a word puts it in */
export const actFor = (k: WordKind): Act => (k === "done" ? "happy" : k === "waiting" ? "alert" : "sad");

// ── the other pets ─────────────────────────────────────────────────────────────────────────
// Every pet is its own window, so each says where it is and what it does (Pet.tsx) and each decides
// for itself what to do about the others near it. Both sides see each other, so a meeting is two
// pets waving at each other, not one.

/** another pet, as it last said where it is */
export interface Other {
  i: number;
  x: number;
  y: number;
  act: Act;
  dir: 1 | -1;
  wall?: number;
}
/** close enough to notice each other (points between their middles, on the same ground) */
export const MEET_NEAR = 150;
/** two pets who met don't meet again for this long */
export const MEET_AGAIN_MS = 60_000;
/** how long a wave lasts */
export const GREET_MS = 2_200;
/** acts it can be pulled out of by another pet (not held, thrown, on a wall, or told something by a job) */
const FREE: Act[] = ["idle", "walk", "sit", "play"];

const sameGround = (b: Body, o: Other) => o.wall === undefined && Math.abs(o.y - b.y) < 6;

/**
 * What it does about the other pets: it waves at one it meets (once a minute each), turns back
 * instead of walking into one, jumps when one lands on it, sometimes walks along with one passing by
 * or lies down by one asleep. `met`: when it last met each pet (kept by the caller, changed here).
 */
export function meet(b: Body, others: Other[], now: number, met: Map<number, number>, W = 70): Body {
  if (b.wall !== undefined || b.on === undefined) return b;
  // one fell on it (or right next to it): it jumps
  const landed = others.find((o) => o.act === "fall" && Math.abs(o.x - b.x) < W * 0.8 && b.y - o.y < 90 && b.y - o.y > -10);
  if (landed && b.act !== "poke" && b.act !== "sleep" && (FREE.includes(b.act) || b.act === "greet"))
    return { ...b, act: "poke", until: now + 1_400, dir: landed.x < b.x ? -1 : 1, stirred: now };
  if (!FREE.includes(b.act)) return b;
  const near = others.filter((o) => sameGround(b, o) && Math.abs(o.x - b.x) < MEET_NEAR).sort((p, q) => Math.abs(p.x - b.x) - Math.abs(q.x - b.x));
  const o = near[0];
  if (o && o.act !== "sleep" && now - (met.get(o.i) ?? -Infinity) > MEET_AGAIN_MS) {
    met.set(o.i, now);
    return { ...b, act: "greet", until: now + GREET_MS, dir: o.x < b.x ? -1 : 1, stirred: now };
  }
  // walking into one: it turns back instead of passing through
  if (b.act === "walk" && o && Math.abs(o.x - b.x) < W * 0.9 && Math.sign(o.x - b.x) === b.dir) return { ...b, dir: b.dir === 1 ? -1 : 1 };
  return b;
}

/** when its act runs out, what it picks with others around: walks along with one going by, or lies down by one asleep */
export function joinIn(b: Body, others: Other[], r: Rand, W = 70): { act: Act; ms: number; dir?: 1 | -1 } | undefined {
  if (b.wall !== undefined || b.on === undefined) return;
  const roll = r();
  const sleeper = others.find((o) => sameGround(b, o) && o.act === "sleep" && Math.abs(o.x - b.x) < 300);
  if (sleeper && roll < 0.3) {
    // next to it already: lie down; else walk over first
    if (Math.abs(sleeper.x - b.x) < W * 1.3) return { act: "sleep", ms: between(r, 20_000, 50_000), dir: sleeper.x < b.x ? -1 : 1 };
    return { act: "walk", ms: (Math.abs(sleeper.x - b.x) - W) / WALK * 1000, dir: sleeper.x < b.x ? -1 : 1 };
  }
  const walker = others.find((o) => sameGround(b, o) && o.act === "walk" && Math.abs(o.x - b.x) < 400);
  if (walker && roll < 0.35) return { act: "walk", ms: between(r, 3_000, 7_000), dir: walker.dir };
  return;
}
