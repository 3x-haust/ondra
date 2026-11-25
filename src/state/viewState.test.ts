import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewState, inSpace, keepScroll, ofJob, topFor, type Scroller } from "./viewState";
import { keepBottom } from "../ui/stick";

/** localStorage, in memory */
const memory = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

/** a scrolling box with `height` of content in a `client`-tall window; the browser clamps what is set */
class Box implements Scroller {
  height: number;
  clientHeight: number;
  #top = 0;
  #left = 0;
  listeners = new Map<string, Set<(e: Event) => void>>();
  children: unknown[] = [];
  constructor(height: number, client = 100) {
    this.height = height;
    this.clientHeight = client;
  }
  get scrollHeight() {
    return this.height;
  }
  get scrollTop() {
    return this.#top;
  }
  set scrollTop(v: number) {
    this.#top = Math.max(0, Math.min(v, this.height - this.clientHeight));
  }
  get scrollLeft() {
    return this.#left;
  }
  set scrollLeft(v: number) {
    this.#left = Math.max(0, v);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(e: Event) {
    for (const fn of this.listeners.get(e.type) ?? []) fn(e);
    return true;
  }
  fire(type: string) {
    this.dispatchEvent(new Event(type));
  }
  /** the user scrolls it to `top` */
  scrollBy(top: number) {
    this.scrollTop = top;
    this.fire("scroll");
  }
  contains() {
    return false;
  }
}

describe("kept values", () => {
  it("keeps a value per workspace and reads the one of the workspace shown", () => {
    const vs = createViewState(memory());
    let space = "home";
    const [group, setGroup] = vs.kept(() => inSpace(space, "board.group"), "state");
    expect(group()).toBe("state");
    setGroup("project");
    expect(group()).toBe("project");
    space = "work";
    expect(group()).toBe("state");
    setGroup((g) => (g === "state" ? "project" : "state"));
    space = "home";
    expect(group()).toBe("project");
  });

  it("survives a restart, written a moment after the last change", () => {
    vi.useFakeTimers();
    const store = memory();
    const vs = createViewState(store, 400);
    const [open, setOpen] = vs.kept("fold", false);
    setOpen(true);
    expect(store.m.size).toBe(0);
    vi.advanceTimersByTime(400);
    expect(open()).toBe(true);
    const again = createViewState(store);
    expect(again.kept("fold", false)[0]()).toBe(true);
    vi.useRealTimers();
  });

  it("forgets a value set back to how it starts", () => {
    const store = memory();
    const vs = createViewState(store);
    const [, setOpen] = vs.kept("fold", false);
    setOpen(true);
    setOpen(false);
    vs.flush();
    expect(JSON.parse(store.getItem("ondra.view")!).v).toEqual({});
  });

  it("keeps only the newest of the many alike", () => {
    const store = memory();
    const vs = createViewState(store);
    for (let i = 0; i < 1005; i++) vs.kept(`think/${i}`, false, { many: true })[1](true);
    vs.flush();
    const f = JSON.parse(store.getItem("ondra.view")!).f;
    expect(Object.keys(f)).toHaveLength(1000);
    expect(f["think/0"]).toBeUndefined();
    expect(f["think/1004"]).toBe(true);
  });

  it("drops what belonged to a deleted job or workspace", () => {
    const store = memory();
    const vs = createViewState(store);
    const [jobFold, setJobFold] = vs.kept(ofJob("gone", "todos"), false);
    const [, setLive] = vs.kept(ofJob("here", "todos"), false);
    const [, setSpaceGroup] = vs.kept(inSpace("old", "board.group"), "state");
    const [, setApp] = vs.kept("settings.tab", "");
    setJobFold(true);
    setLive(true);
    setSpaceGroup("project");
    setApp("x");
    vs.keepSpot(ofJob("gone", "thread"), { top: 10, left: 0 });
    vs.keepSpot(ofJob("here", "thread"), { top: 20, left: 0 });
    vs.setLive({ space: (id) => id === "home", job: (id) => id === "here" });
    expect(jobFold()).toBe(false);
    expect(vs.spot(ofJob("gone", "thread"))).toBeUndefined();
    expect(vs.spot(ofJob("here", "thread"))).toEqual({ top: 20, left: 0 });
    vs.flush();
    const saved = JSON.parse(store.getItem("ondra.view")!);
    expect(saved.v).toEqual({ [ofJob("here", "todos")]: true, "settings.tab": "x" });
  });

  it("starts empty from a broken save", () => {
    const store = memory();
    store.setItem("ondra.view", "{nope");
    expect(createViewState(store).kept("a", 1)[0]()).toBe(1);
  });
});

describe("scroll places", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("goes back to the bottom when it was left at the bottom, else to where it was", () => {
    const el = new Box(1000);
    expect(topFor({ top: 300, left: 0, bottom: true }, el)).toBe(900);
    expect(topFor({ top: 300, left: 0 }, el)).toBe(300);
    el.height = 50;
    expect(topFor({ top: 0, left: 0, bottom: true }, el)).toBe(0);
  });

  it("notes the place on scroll and puts it back once the content is long enough", async () => {
    const vs = createViewState(memory());
    const a = new Box(1000);
    const keep = keepScroll(a, () => "list", vs);
    a.scrollBy(400);
    expect(vs.spot("list")).toEqual({ top: 400, left: 0 });
    keep.stop();

    // mounted again with its rows still coming in
    const b = new Box(200);
    keepScroll(b, () => "list", vs);
    await Promise.resolve();
    expect(b.scrollTop).toBe(100);
    b.height = 1000;
    vi.advanceTimersByTime(20);
    expect(b.scrollTop).toBe(400);
    // our own scroll doesn't overwrite the place, the user's does
    b.scrollBy(450);
    expect(vs.spot("list")?.top).toBe(450);
  });

  it("stops putting it back once the user scrolls", async () => {
    const vs = createViewState(memory());
    vs.keepSpot("list", { top: 800, left: 0 });
    const el = new Box(300);
    keepScroll(el, () => "list", vs);
    await Promise.resolve();
    el.fire("wheel");
    el.scrollBy(50);
    el.height = 1000;
    vi.advanceTimersByTime(100);
    expect(el.scrollTop).toBe(50);
    expect(vs.spot("list")?.top).toBe(50);
  });

  it("takes up another key's place in the same box, or its start", async () => {
    const vs = createViewState(memory());
    let space = "home";
    const el = new Box(1000);
    const keep = keepScroll(el, () => inSpace(space, "board"), vs);
    el.scrollBy(300);
    space = "work";
    keep.restore();
    await Promise.resolve();
    expect(el.scrollTop).toBe(0);
    el.scrollBy(120);
    space = "home";
    keep.restore();
    await Promise.resolve();
    expect(el.scrollTop).toBe(300);
    expect(vs.spot(inSpace("work", "board"))?.top).toBe(120);
  });

  it("keeps the newest places only", () => {
    const vs = createViewState(memory());
    for (let i = 0; i < 405; i++) vs.keepSpot(`t:${i}/thread`, { top: i, left: 0 });
    expect(vs.spot("t:0/thread")).toBeUndefined();
    expect(vs.spot("t:404/thread")?.top).toBe(404);
  });
});

describe("a chat as it was left", () => {
  const observers: { cb: () => void }[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    observers.length = 0;
    class Obs {
      cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
        observers.push(this);
      }
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", Obs);
    vi.stubGlobal("MutationObserver", Obs);
    vi.stubGlobal("requestAnimationFrame", (f: () => void) => setTimeout(f, 16));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  /** the content changed: what the observers would hear */
  const changed = () => observers.forEach((o) => o.cb());
  const chat = (height: number, key: () => string, vs: ReturnType<typeof createViewState>, onStick?: (v: boolean) => void) => {
    const el = new Box(height);
    const stop = keepBottom(el as unknown as HTMLElement, onStick, { key, vs });
    return { el, stop };
  };

  it("comes back at the bottom and keeps following when it was left there", () => {
    const vs = createViewState(memory());
    vs.keepSpot("t:a/thread", { top: 900, left: 0, bottom: true });
    const { el } = chat(1000, () => "t:a/thread", vs);
    changed();
    expect(el.scrollTop).toBe(900);
    el.height = 1500;
    changed();
    expect(el.scrollTop).toBe(1400);
  });

  it("comes back where the user had scrolled up to, even as the thread draws in late", () => {
    const vs = createViewState(memory());
    vs.keepSpot("t:a/thread", { top: 300, left: 0, bottom: false });
    const stuck: boolean[] = [];
    const { el } = chat(150, () => "t:a/thread", vs, (v) => stuck.push(v));
    expect(stuck).toEqual([false]);
    el.height = 1000;
    changed();
    expect(el.scrollTop).toBe(300);
    // new messages don't carry it down
    el.height = 1400;
    changed();
    expect(el.scrollTop).toBe(300);
  });

  it("notes where the user leaves it, and that it is at the bottom again", () => {
    const vs = createViewState(memory());
    const { el } = chat(1000, () => "t:a/thread", vs);
    changed();
    // the browser tells of the scroll it made itself
    el.fire("scroll");
    el.dispatchEvent(Object.assign(new Event("wheel"), { deltaY: -100 }));
    el.scrollBy(200);
    expect(vs.spot("t:a/thread")).toEqual({ top: 200, left: 0, bottom: false });
    el.scrollBy(900);
    expect(vs.spot("t:a/thread")).toEqual({ top: 900, left: 0, bottom: true });
  });

  it("takes up the place of the chat that comes into the same box", () => {
    const vs = createViewState(memory());
    vs.keepSpot("sp:work/main/work", { top: 250, left: 0, bottom: false });
    let key = "sp:home/main/home";
    const { el } = chat(1000, () => key, vs);
    changed();
    expect(el.scrollTop).toBe(900);
    key = "sp:work/main/work";
    changed();
    expect(el.scrollTop).toBe(250);
    key = "sp:home/main/home";
    changed();
    expect(el.scrollTop).toBe(900);
  });

  it("goes to the bottom when the user sends, wherever it was left", () => {
    const vs = createViewState(memory());
    vs.keepSpot("t:a/thread", { top: 300, left: 0, bottom: false });
    const { el } = chat(1000, () => "t:a/thread", vs);
    changed();
    el.fire("sent");
    expect(el.scrollTop).toBe(900);
    expect(vs.spot("t:a/thread")?.bottom).toBe(true);
  });
});
