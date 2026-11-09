// How the app state reaches state.json without stopping the UI.
//
// The store used to be stringified whole (17 MB for a few days of work) inside an
// effect on every change, a streaming shell tail included. Now each write to the
// store only marks what it touched (`mark`), and a save a moment later serializes
// just the tasks that changed: the rest of the file is reused as it was. The native
// side keeps every task's text and writes the whole file (temp file + rename), so
// only the changed parts cross the bridge.
import type { AppState, Entry, Shell, Task, ToolCall } from "./types";

// ───────────────────────── the file's form of a task

/**
 * A task as it goes into the file: copies it can do without are left out (a bash
 * call's `detail` repeats its `target`; a finished shell's `command` repeats its
 * call's). `unpackTask` puts them back, so the app never sees the difference.
 */
export function packTask(t: Task): Task {
  const cmd = new Map<string, string>();
  let entries: Entry[] | undefined;
  for (let i = 0; i < t.entries.length; i++) {
    const e = t.entries[i];
    if (e.kind !== "tool") continue;
    if (e.tool.shellId) cmd.set(e.tool.shellId, e.tool.detail ?? e.tool.target);
    if (e.tool.detail !== undefined && e.tool.detail === e.tool.target) {
      entries ??= t.entries.slice();
      const { detail: _, ...tool } = e.tool;
      entries[i] = { ...e, tool };
    }
  }
  let shells: Shell[] | undefined;
  for (let i = 0; i < t.shells.length; i++) {
    const s = t.shells[i];
    if (s.endedAt && s.command !== undefined && cmd.get(s.id) === s.command) {
      shells ??= t.shells.slice();
      const { command: _, ...rest } = s;
      shells[i] = rest as Shell;
    }
  }
  return entries || shells ? { ...t, entries: entries ?? t.entries, shells: shells ?? t.shells } : t;
}

/** A task read from the file, in either form (files written before packing too). Mutates and returns it. */
export function unpackTask(t: Task): Task {
  t.entries ??= [];
  t.shells ??= [];
  const cmd = new Map<string, string>();
  for (const e of t.entries) {
    if (e.kind !== "tool" || !e.tool) continue;
    const tool = e.tool as ToolCall;
    if (tool.detail === undefined && typeof tool.target === "string") tool.detail = tool.target;
    if (tool.shellId) cmd.set(tool.shellId, tool.detail ?? tool.target);
  }
  for (const s of t.shells) if (s.command === undefined) s.command = cmd.get(s.id) ?? "";
  return t;
}

// ───────────────────────── what changed since the last save

type Slot = string;
/** a task's place in the file: its id, or id#n for a repeated id (never expected, never merged) */
const slotsOf = (tasks: readonly Task[]): Slot[] => {
  const seen = new Map<string, number>();
  return tasks.map((t) => {
    const n = seen.get(t.id) ?? 0;
    seen.set(t.id, n + 1);
    return n ? `${t.id}#${n}` : t.id;
  });
};

export interface Parts {
  /** the state without its tasks, as JSON */
  head: string;
  /** every task's slot, in order */
  order: Slot[];
  /** the tasks' JSON the native side doesn't have yet (changed ones, or all after a reset) */
  tasks: Record<Slot, string>;
}

/**
 * Keeps each task's JSON between saves. `mark` is told about every store write (the
 * setState arguments) and notes which tasks it touches; `build` re-serializes only
 * those. As a safety net for a change that went around `setState` (a `produce`
 * draft kept and written later), live tasks and a few others in turn are always
 * serialized again, so nothing stays stale for long.
 */
export class Saver {
  private json = new Map<Slot, string>();
  private dirty = new Set<string>();
  private all = true;
  /** slots the native side holds, as last sent */
  private sent = new Set<Slot>();
  private turn = 0;
  /** how many settled tasks are serialized again on each save, in turn */
  private readonly sweep: number;
  constructor(sweep = 8) {
    this.sweep = sweep;
  }

  /** a store write is about to happen (the arguments given to setState), on this state */
  mark(args: readonly unknown[], s: AppState) {
    if (this.all) return;
    if (args[0] !== "tasks") {
      if (typeof args[0] !== "string") this.all = true;
      return;
    }
    const sel = args[1];
    // ("tasks", value) or ("tasks", prev => next): the list itself
    if (args.length < 3) return void (this.all = true);
    const tasks = s.tasks ?? [];
    if (typeof sel === "function") {
      tasks.forEach((t, i) => (sel as (t: Task, i: number) => boolean)(t, i) && this.dirty.add(t.id));
    } else if (typeof sel === "number") {
      if (tasks[sel]) this.dirty.add(tasks[sel].id);
    } else if (Array.isArray(sel)) {
      for (const i of sel) if (tasks[i]) this.dirty.add(tasks[i].id);
    } else this.all = true;
  }

  /** the native side lost what it held (a failed write, a restart): send everything next time */
  reset() {
    this.sent.clear();
  }

  /** what to send for this state; afterwards nothing counts as changed */
  build(s: AppState): Parts {
    const { tasks: list = [], ...rest } = s;
    const order = slotsOf(list);
    const live = new Set<Slot>();
    const n = Math.max(1, list.length);
    for (let k = 0; k < Math.min(this.sweep, list.length); k++) live.add(order[(this.turn + k) % n]);
    this.turn = (this.turn + this.sweep) % n;
    const tasks: Record<Slot, string> = {};
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      const slot = order[i];
      const old = this.json.get(slot);
      const again = this.all || old === undefined || this.dirty.has(t.id) || t.status === "running" || t.status === "waiting" || live.has(slot);
      const text = again ? JSON.stringify(packTask(t)) : old!;
      if (text !== old) this.json.set(slot, text);
      if (text !== old || !this.sent.has(slot)) tasks[slot] = text;
    }
    if (this.json.size > order.length) {
      const keep = new Set(order);
      for (const k of this.json.keys()) if (!keep.has(k)) this.json.delete(k);
    }
    this.all = false;
    this.dirty.clear();
    return { head: JSON.stringify(rest), order, tasks };
  }

  /** the native side now holds these slots */
  sentAll(order: Slot[]) {
    this.sent = new Set(order);
  }

  /** the JSON of a slot, for resending one the native side says it lacks */
  text(slot: Slot) {
    return this.json.get(slot);
  }
}

/** The whole file from its parts: what the native side writes (also for tests and plain browsers). */
export function joinParts(head: string, order: Slot[], text: (slot: Slot) => string | undefined): string {
  const tasks = `"tasks":[${order.map((s) => text(s) ?? "null").join(",")}]`;
  return head.length > 2 ? `{${tasks},${head.slice(1)}` : `{${tasks}}`;
}

// ───────────────────────── when to save

/**
 * A trailing save: `QUIET` ms after the last change, but never more than `MAX` ms
 * after the first unsaved one, so a job that streams for minutes is still saved
 * every couple of seconds.
 */
export function debounce(run: () => void, quiet = 500, max = 2000, clock = () => Date.now()) {
  let first = 0;
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    timer = undefined;
    const now = clock();
    const wait = Math.min(quiet - (now - last), max - (now - first));
    if (wait > 0) return void (timer = setTimeout(tick, wait));
    first = 0;
    run();
  };
  return {
    poke() {
      last = clock();
      if (!first) first = last;
      timer ??= setTimeout(tick, quiet);
    },
    /** run now if anything waits */
    flush() {
      if (!first) return false;
      clearTimeout(timer);
      timer = undefined;
      first = 0;
      run();
      return true;
    },
    get pending() {
      return first > 0;
    },
  };
}
