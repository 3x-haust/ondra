import { afterEach, describe, expect, it, vi } from "vitest";
import { produce } from "solid-js/store";
import { debounce, joinParts, packTask, Saver, unpackTask } from "./persist";
import { freshState } from "./store";
import type { AppState, Entry, Task } from "./types";

let n = 0;
const bash = (cmd: string, shellId: string): Entry => ({ id: `e${++n}`, at: n, kind: "tool", tool: { name: "bash", kind: "bash", target: cmd, detail: cmd, shellId, ok: true, endedAt: n } });
const read = (path: string): Entry => ({ id: `e${++n}`, at: n, kind: "tool", tool: { name: "read", kind: "read", target: path.split("/").pop()!, detail: path, ok: true, endedAt: n } });
const job = (id: string, over: Partial<Task> = {}): Task => ({
  id, space: "home", topic: "x", title: `job ${id}`, ask: "do it", cwd: "/x", status: "done", priority: 2, weight: "light", accountId: "default",
  createdAt: 1, now: "", plan: [], legs: [], inbox: [],
  entries: [{ id: `u${id}`, at: 0, kind: "user", text: "go" }, bash("pnpm test", `s${id}`), read("/x/src/a.ts"), bash("cargo check", `r${id}`)],
  shells: [
    { id: `s${id}`, command: "pnpm test", startedAt: 1, endedAt: 2, ok: true, tail: "ok 12 tests" },
    // still running: kept whole
    { id: `r${id}`, command: "cargo check", startedAt: 3, tail: "Compiling" },
  ],
  ...over,
});
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const stateWith = (tasks: Task[]): AppState => ({ ...freshState(), tasks });
/** what the file holds after a save, read back the way loadState reads it */
const fileOf = (s: Saver, st: AppState, held = new Map<string, string>()) => {
  const p = s.build(st);
  for (const [k, v] of Object.entries(p.tasks)) held.set(k, v);
  s.sentAll(p.order);
  const text = joinParts(p.head, p.order, (k) => held.get(k));
  const back = JSON.parse(text) as AppState;
  return { parts: p, text, back: { ...back, tasks: back.tasks.map(unpackTask) } };
};

describe("a task in the file", () => {
  it("leaves out the copies and gets them back", () => {
    const t = job("a");
    const packed = clone(packTask(t));
    const bashes = packed.entries.filter((e) => e.kind === "tool" && e.tool.name === "bash");
    expect(bashes.every((e) => e.kind === "tool" && e.tool.detail === undefined)).toBe(true);
    // a read's detail (the full path) isn't a copy: it stays
    expect(packed.entries.find((e) => e.kind === "tool" && e.tool.name === "read")).toMatchObject({ tool: { detail: "/x/src/a.ts" } });
    expect(packed.shells[0].command).toBeUndefined();
    expect(packed.shells[1].command).toBe("cargo check");
    expect(unpackTask(packed)).toEqual(t);
    expect(JSON.stringify(packTask(t)).length).toBeLessThan(JSON.stringify(t).length);
  });

  it("doesn't change the task it packs", () => {
    const t = job("a");
    const before = clone(t);
    packTask(t);
    expect(t).toEqual(before);
  });

  it("reads a file written before packing as it was", () => {
    const t = job("a");
    expect(unpackTask(clone(t))).toEqual(t);
  });

  it("keeps a shell whose call is gone (trimmed away), and a tool without detail gets its target", () => {
    const t = job("a", { entries: [], shells: [{ id: "lost", command: "ls", startedAt: 1, endedAt: 2, tail: "" }] });
    expect(clone(packTask(t)).shells[0].command).toBe("ls");
    const old = { ...job("b"), entries: [{ id: "x", at: 1, kind: "tool", tool: { name: "grep", kind: "search", target: "redirect" } }] } as Task;
    expect(unpackTask(clone(old)).entries[0]).toMatchObject({ tool: { detail: "redirect" } });
  });
});

describe("saving only what changed", () => {
  it("sends every task first, then only the one that changed", () => {
    const st = stateWith([job("a"), job("b"), job("c")]);
    const s = new Saver(0);
    const held = new Map<string, string>();
    const first = fileOf(s, st, held);
    expect(Object.keys(first.parts.tasks).sort()).toEqual(["a", "b", "c"]);
    expect(first.back.tasks).toEqual(st.tasks);

    // updateTask("b", …) as the store calls it
    s.mark(["tasks", (t: Task) => t.id === "b", produce(() => {})], st);
    st.tasks[1].title = "renamed";
    const second = fileOf(s, st, held);
    expect(Object.keys(second.parts.tasks)).toEqual(["b"]);
    expect(second.back.tasks[1].title).toBe("renamed");
    expect(second.back).toEqual(clone(st));
  });

  it("sends nothing for tasks when something else changed", () => {
    const st = stateWith([job("a")]);
    const s = new Saver(0);
    const held = new Map<string, string>();
    fileOf(s, st, held);
    s.mark(["settings", "theme", "dark"], st);
    st.settings.theme = "dark";
    const { parts, back } = fileOf(s, st, held);
    expect(parts.tasks).toEqual({});
    expect(back.settings.theme).toBe("dark");
  });

  it("re-serializes everything when the list is replaced, but sends only what differs", () => {
    const st = stateWith([job("a"), job("b")]);
    const s = new Saver(0);
    const held = new Map<string, string>();
    fileOf(s, st, held);
    st.tasks = [st.tasks[1], job("c")];
    s.mark(["tasks", st.tasks], st);
    const { parts, back } = fileOf(s, st, held);
    expect(Object.keys(parts.tasks)).toEqual(["c"]);
    expect(back.tasks.map((t) => t.id)).toEqual(["b", "c"]);
  });

  it("picks up a change that went around setState within a few saves", () => {
    const st = stateWith(Array.from({ length: 10 }, (_, i) => job(`t${i}`)));
    const s = new Saver(3);
    const held = new Map<string, string>();
    fileOf(s, st, held);
    st.tasks[7].title = "changed behind its back";
    let back: AppState | undefined;
    for (let i = 0; i < 4; i++) back = fileOf(s, st, held).back;
    expect(back!.tasks[7].title).toBe("changed behind its back");
  });

  it("always re-serializes a running job", () => {
    const st = stateWith([job("a", { status: "running" }), job("b")]);
    const s = new Saver(0);
    const held = new Map<string, string>();
    fileOf(s, st, held);
    st.tasks[0].shells[1].tail = "Compiling more";
    const { parts } = fileOf(s, st, held);
    expect(Object.keys(parts.tasks)).toEqual(["a"]);
  });

  it("sends everything again after the native side lost it", () => {
    const st = stateWith([job("a"), job("b")]);
    const s = new Saver(0);
    fileOf(s, st);
    s.reset();
    expect(Object.keys(s.build(st).tasks).sort()).toEqual(["a", "b"]);
  });

  it("keeps two tasks with one id apart", () => {
    const st = stateWith([job("a"), job("a", { title: "twin" })]);
    const { back } = fileOf(new Saver(0), st);
    expect(back.tasks.map((t) => t.title)).toEqual(["job a", "twin"]);
  });

  it("migrates a file written the old way: same state, smaller file", () => {
    // the old app wrote JSON.stringify(state) whole
    const tasks = Array.from({ length: 40 }, (_, i) => job(`m${i}`));
    const oldText = JSON.stringify(stateWith(tasks));
    const loaded = JSON.parse(oldText) as AppState;
    loaded.tasks = loaded.tasks.map(unpackTask);
    const { text, back } = fileOf(new Saver(), loaded);
    expect(back).toEqual(JSON.parse(oldText));
    expect(text.length).toBeLessThan(oldText.length);
  });
});

describe("when to save", () => {
  afterEach(() => vi.useRealTimers());

  it("saves once, a moment after the last change", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const d = debounce(run, 500, 2000);
    d.poke();
    vi.advanceTimersByTime(300);
    d.poke();
    vi.advanceTimersByTime(400);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("still saves every couple of seconds while changes never stop", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const d = debounce(run, 500, 2000);
    for (let t = 0; t < 10_000; t += 50) {
      d.poke();
      vi.advanceTimersByTime(50);
    }
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(run.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("flush saves right away, and only when something waits", () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const d = debounce(run, 500, 2000);
    expect(d.flush()).toBe(false);
    d.poke();
    expect(d.flush()).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
