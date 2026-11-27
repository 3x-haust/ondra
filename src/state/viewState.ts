// What you were looking at stays as you left it: how far a list or a chat was scrolled,
// what was folded, how the canvas was panned and zoomed, which tab was open. A view
// remounts whenever you go to another job, chat or workspace and back; it reads its
// place from here instead of starting over. Kept in memory, and in localStorage a
// moment after the last change, so it also survives a restart.
//
// Keys say what they belong to, so they go with it: `sp:<space>/…` (inSpace) goes with
// the workspace, `t:<job>/…` (ofJob) with the job. Anything else is the whole app's.
import { createEffect, createSignal, on, onCleanup, type Signal } from "solid-js";

/** where a scrolled box was left */
export interface Spot {
  top: number;
  left: number;
  /** it was following the newest content: it comes back at the bottom, and keeps following */
  bottom?: boolean;
}

interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** what is still there, for dropping what went (a deleted job, a removed workspace) */
export interface Live {
  space(id: string): boolean;
  job(id: string): boolean;
}

const KEY = "ondra.view";
/** scroll places kept: every job's thread gets one, so the oldest go first */
const SPOTS = 400;
/** the same for what is open or folded per message or per row (`many`) */
const ITEMS = 1000;

export const inSpace = (space: string, what: string) => `sp:${space}/${what}`;
export const ofJob = (id: string, what: string) => `t:${id}/${what}`;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export function createViewState(store: Storage | undefined, wait = 400) {
  let vals: Record<string, unknown> = {};
  /** values kept per message or row: many of them, so only the newest ITEMS */
  let items: Record<string, unknown> = {};
  let spots: Record<string, Spot> = {};
  try {
    const raw = JSON.parse(store?.getItem(KEY) ?? "{}");
    vals = raw.v ?? {};
    items = raw.f ?? {};
    spots = raw.s ?? {};
  } catch {}
  /** one signal per value, made when first read: a view sees its own value change, no other */
  const cells = new Map<string, Signal<unknown>>();
  const cell = (k: string) => {
    let c = cells.get(k);
    if (!c) cells.set(k, (c = createSignal<unknown>(vals[k] ?? items[k])));
    return c;
  };
  let live: Live | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** a key's owner is gone */
  const gone = (k: string) => {
    if (!live) return false;
    const m = /^(sp|t):([^/]+)\//.exec(k);
    if (m && !(m[1] === "sp" ? live.space(m[2]) : live.job(m[2]))) return true;
    // a job's fold in a workspace's sidebar goes with the job
    const job = /\/fold\/t:(.+)$/.exec(k)?.[1];
    return !!job && !live.job(job);
  };
  const prune = () => {
    for (const box of [vals, items])
      for (const k of Object.keys(box))
        if (gone(k)) {
          delete box[k];
          cells.get(k)?.[1](undefined);
        }
    for (const k of Object.keys(spots)) if (gone(k)) delete spots[k];
  };
  /** the newest last: the oldest go once there are more than `max` */
  const touch = <T,>(box: Record<string, T>, k: string, v: T, max: number) => {
    delete box[k];
    box[k] = v;
    const ks = Object.keys(box);
    for (let i = 0; i < ks.length - max; i++) delete box[ks[i]];
  };
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    prune();
    try {
      store?.setItem(KEY, JSON.stringify({ v: vals, f: items, s: spots }));
    } catch {}
  };
  // scrolling writes many times a second: the disk gets the last of them
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(flush, wait);
  };

  /** a value kept under `key` as it is now (undefined: none); reactive */
  const peek = (key: string): unknown => (route?.owns(key) ? route.get(key) : cell(key)[0]());
  /** keep `v` under `key` (undefined, or the value it starts with: nothing kept) */
  function put(key: string, v: unknown, opts: { many?: boolean; initial?: unknown; quiet?: boolean } = {}) {
    if (!opts.quiet && route?.owns(key)) return route.set(key, same(v, opts.initial) ? undefined : v);
    const box = opts.many ? items : vals;
    // back at the start, nothing needs keeping
    if (v === undefined || same(v, opts.initial)) delete box[key];
    else if (opts.many) touch(items, key, v, ITEMS);
    else vals[key] = v;
    cell(key)[1](() => box[key]);
    save();
    if (!opts.many) for (const f of heard) f(key);
  }

  /**
   * A value a view keeps across remounts, like a signal. `key` may change (the workspace
   * switched): the value read is then that key's. `initial` is what it is until set.
   * `many`: one of many alike (a fold per message): only the newest of those are kept.
   */
  function kept<T>(key: string | (() => string), initial: T, opts: { many?: boolean } = {}): [get: () => T, set: (v: T | ((prev: T) => T)) => void] {
    const k = typeof key === "function" ? key : () => key;
    const get = () => {
      const v = peek(k());
      return v === undefined ? initial : (v as T);
    };
    const set = (next: T | ((prev: T) => T)) => put(k(), typeof next === "function" ? (next as (p: T) => T)(get()) : next, { many: opts.many, initial });
    return [get, set];
  }

  /** keys kept somewhere else (another device's workspace, state/shared.ts): read and set there */
  let route: { owns(key: string): boolean; get(key: string): unknown; set(key: string, v: unknown): void } | undefined;
  const setRoute = (r: typeof route) => void (route = r);
  /** told of each single value set here (not per message or row) */
  const heard = new Set<(key: string) => void>();
  const onPut = (f: (key: string) => void) => void heard.add(f);
  /** the single values kept here whose key starts with `prefix` */
  const entries = (prefix: string): [string, unknown][] => Object.entries(vals).filter(([k]) => k.startsWith(prefix));

  const spot = (key: string): Spot | undefined => spots[key];
  const keepSpot = (key: string, s: Spot) => {
    const was = spots[key];
    if (was && was.top === s.top && was.left === s.left && !!was.bottom === !!s.bottom) return;
    touch(spots, key, s, SPOTS);
    save();
  };

  /** From now on, what belongs to a job or a workspace that is gone is dropped (now, and at every save). */
  const setLive = (l: Live) => {
    live = l;
    prune();
    save();
  };

  return { kept, peek, put, entries, setRoute, onPut, spot, keepSpot, setLive, flush };
}

const storage = (() => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
})();
export const viewState = createViewState(storage);
export const { kept, peek, put, spot, keepSpot, setLive } = viewState;
// a quit right after a scroll still keeps it
if (typeof window !== "undefined") for (const e of ["pagehide", "beforeunload"]) window.addEventListener(e, () => viewState.flush());

// ───────────────────────── scroll

/** the part of an element the scroll keepers use (a fake one in tests) */
export interface Scroller {
  scrollTop: number;
  scrollLeft: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  addEventListener(type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions): void;
  removeEventListener(type: string, fn: (e: Event) => void): void;
}

/** Where a box goes back to: its bottom when it was following there, else the place it was left at. */
export const topFor = (s: Spot, el: Pick<Scroller, "scrollHeight" | "clientHeight">) => (s.bottom ? Math.max(0, el.scrollHeight - el.clientHeight) : s.top);

/** how long a place waits for its content to arrive (a list read from disk, pictures loading) */
const TRIES = 90;
const frame = (f: () => void) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(f) : (setTimeout(f, 16) as unknown as number));
const unframe = (id: number) => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id));

/**
 * Keep how far `el` is scrolled under `key()`: noted on every scroll, put back when it
 * mounts. The content may not be there yet (it comes from disk, or draws a frame
 * later), so it tries again each frame until the place is reached, the user scrolls
 * themselves, or it has waited long enough. `restore()` takes up a new key's place
 * (the same box now shows another workspace's).
 */
export function keepScroll(el: Scroller, key: () => string, vs: Pick<typeof viewState, "spot" | "keepSpot"> = viewState) {
  let k = key();
  /** the place being put back, until it is reached */
  let want: Spot | undefined;
  let tries = 0;
  let id = 0;
  /** where the last try left it, to see whether something else moved it since */
  let at: { top: number; left: number } | undefined;
  const note = () => vs.keepSpot(k, { top: el.scrollTop, left: el.scrollLeft });
  const reach = () => {
    if (!want) return;
    // something else moved it meanwhile (a jump to a found row): that wins
    if (at && (Math.abs(el.scrollTop - at.top) > 1 || Math.abs(el.scrollLeft - at.left) > 1)) return void ((want = undefined), note());
    const top = topFor(want, el);
    el.scrollTop = top;
    el.scrollLeft = want.left;
    at = { top: el.scrollTop, left: el.scrollLeft };
    if ((Math.abs(el.scrollTop - top) <= 1 && Math.abs(el.scrollLeft - want.left) <= 1) || ++tries > TRIES) want = undefined;
    else id = frame(reach);
  };
  const restore = (fresh = true) => {
    unframe(id);
    k = key();
    want = vs.spot(k);
    tries = 0;
    at = undefined;
    // another key with nothing kept starts at the start
    if (!want && fresh) want = { top: 0, left: 0 };
    // not in the page yet (a ref runs before it is put in): from the next tick
    queueMicrotask(reach);
  };
  const onScroll = () => {
    if (!want) note();
  };
  // the user moving it themselves wins over a place still being put back
  const mine = () => {
    want = undefined;
    unframe(id);
  };
  const user = ["wheel", "pointerdown", "touchstart", "keydown"];
  el.addEventListener("scroll", onScroll, { passive: true });
  for (const e of user) el.addEventListener(e, mine, { passive: true });
  restore(false);
  return {
    restore: () => restore(),
    stop: () => {
      unframe(id);
      el.removeEventListener("scroll", onScroll);
      for (const e of user) el.removeEventListener(e, mine);
    },
  };
}

/** `ref={scrollKept(() => key)}`: keepScroll for a Solid view, following the key as it changes. */
export const scrollKept = (key: () => string) => (el: HTMLElement) => {
  const k = keepScroll(el, key);
  onCleanup(k.stop);
  createEffect(on(key, () => k.restore(), { defer: true }));
};
