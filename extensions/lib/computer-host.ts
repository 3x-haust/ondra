// Host background computer use: the TypeScript side of the `ondra-cuhost` helper.
//
// This drives the signed Swift helper (src-tauri/helpers/cuhost.swift) that operates
// one app on the USER'S OWN Mac entirely in the background: Accessibility tree +
// actions, pid-targeted events as a fallback, and ScreenCaptureKit window-only
// captures. It never activates an app, never moves the cursor, never posts to the
// global session. The helper reports the frontmost app / key window / mouse before
// and after every action; this module refuses any action whose result shows those
// changed, instead of papering over it.
//
// Two independently testable pieces live here:
//   - envelope(): validates one helper response (version 1, {ok,result|error}).
//   - HostObservation: a compact, stable-id AX tree with full / delta / unchanged
//     observations and id-based ref resolution — the token-saving core, so later
//     steps send only what changed.
// ComputerHostHelper spawns the process and matches responses to requests by id.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { renderTree, screenDelta, screenQuery, screenText, type ScreenLine } from "./computer-screen";

export type HostNode = {
  id: string;
  role: string;
  [key: string]: unknown;
  children?: HostNode[];
};
export type HostEnv = {
  frontmostApp: string | null;
  frontmostPid: number;
  frontmostKeyWindow?: string;
  /** CGWindowID of the frontmost app's front window; compared instead of the title when present. */
  frontmostWindowId?: number;
  mouse: { x: number; y: number };
};
export type HostResult = Record<string, unknown>;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Parse and validate one helper response line. Never surfaces raw helper text as instructions. */
export function envelope(value: unknown): { id: unknown; result: HostResult } {
  if (!isRecord(value) || value.version !== 1 || typeof value.ok !== "boolean") throw new Error("Malformed host envelope");
  if (!value.ok) {
    const error = value.error;
    if (!isRecord(error) || typeof error.code !== "string") throw new Error("Malformed host error");
    throw new HostHelperError(String(error.code), typeof error.message === "string" ? error.message : "");
  }
  if (!isRecord(value.result)) throw new Error("Malformed host result");
  return { id: value.id, result: value.result };
}

export class HostHelperError extends Error {
  constructor(readonly code: string, message: string) { super(`${code}: ${message}`); this.name = "HostHelperError"; }
}

/** The background invariant: frontmost app, key window and mouse must be unchanged. */
export function backgroundPreserved(before: HostEnv | undefined, after: HostEnv | undefined): boolean {
  if (!before || !after) return false;
  // A window title can change on its own (a terminal spinner); the window id cannot.
  const keySame = before.frontmostWindowId !== undefined && after.frontmostWindowId !== undefined
    ? before.frontmostWindowId === after.frontmostWindowId
    : (before.frontmostKeyWindow ?? null) === (after.frontmostKeyWindow ?? null);
  return before.frontmostPid === after.frontmostPid && keySame &&
    before.mouse.x === after.mouse.x && before.mouse.y === after.mouse.y;
}

export type HostFrame = { x: number; y: number; width: number; height: number };
export type HostImage = {
  mimeType: "image/png"; data: string; width: number; height: number;
  /** The captured window's frame; coordinate actions use pixels of this image. */
  frame?: HostFrame;
  /** Stage Manager strip thumbnail: not to scale, so its pixels must not be used as coordinates. */
  staged?: boolean;
};

type Point = { x: number; y: number };
const pixel = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`${name} must be a non-negative integer pixel`);
  return v;
};

function validateNode(node: unknown, depth: number): HostNode {
  if (depth > 200) throw new Error("Host tree too deep");
  if (!isRecord(node) || typeof node.id !== "string" || typeof node.role !== "string") throw new Error("Malformed host node");
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) throw new Error("Malformed host children");
    for (const child of node.children) validateNode(child, depth + 1);
  }
  return node as HostNode;
}

export type HostSnapshot = {
  epoch: string;
  /** full: the whole screen · delta: only what changed since base_epoch · unchanged · query: only matching lines */
  kind: "full" | "delta" | "unchanged" | "query";
  base_epoch?: string;
  text: string;
  matches?: number;
};

const encoder = new TextEncoder();
const MAX_SCREEN = 40 * 1024;

/** Cut a long screen at a line boundary, saying how to see the rest. */
function cap(text: string): string {
  if (encoder.encode(text).length <= MAX_SCREEN) return text;
  const lines = text.split("\n");
  let used = 0, n = 0;
  while (n < lines.length && used + encoder.encode(lines[n]).length + 1 <= MAX_SCREEN) used += encoder.encode(lines[n++]).length + 1;
  return `${lines.slice(0, n).join("\n")}\n… ${lines.length - n} more lines not shown: observe {query} for what you need, or scroll`;
}

/**
 * One app's observation history. The helper gives each element a stable structural id;
 * here each id gets a short session number ([12]) that the model uses as a ref. The model
 * is shown the whole screen once, then only what changed since what it last saw.
 * A ref is valid while its element is on the current screen.
 */
export class HostObservation {
  private revision = 0;
  private epoch = "";
  private tree?: HostNode;
  private raw = "";
  private ids = new Set<string>();
  private numbers = new Map<string, number>();
  private byNumber = new Map<number, string>();
  private lines: ScreenLine[] = [];
  private shown?: { epoch: string; lines: ScreenLine[] };

  private number(id: string): number {
    let n = this.numbers.get(id);
    if (n === undefined) { n = this.numbers.size + 1; this.numbers.set(id, n); this.byNumber.set(n, id); }
    return n;
  }

  /**
   * Take a new tree. show false: an intermediate state of a batch (refs update, nothing is
   * shown and the model's view is kept). query: show only matching lines, keeping the view.
   */
  accept(rawTree: unknown, options: boolean | { full?: boolean; show?: boolean; query?: string } = {}): HostSnapshot & { changed: boolean } {
    const o = typeof options === "boolean" ? { full: options } : options;
    const tree = validateNode(rawTree, 0);
    const raw = JSON.stringify(tree);
    const changed = raw !== this.raw;
    this.tree = tree;
    this.raw = raw;
    const ids = new Set<string>();
    const walk = (n: HostNode) => { ids.add(n.id); for (const c of n.children ?? []) walk(c); };
    walk(tree);
    this.ids = ids;
    this.lines = renderTree(tree, (id) => this.number(id));
    const epoch = `h${++this.revision}`;
    this.epoch = epoch;
    if (o.query !== undefined) {
      const found = screenQuery(this.lines, o.query);
      return { epoch, kind: "query", text: cap(found.text), matches: found.matches, changed };
    }
    if (o.show === false) return { epoch, kind: "unchanged", base_epoch: this.shown?.epoch, text: "", changed };
    const whole = screenText(this.lines);
    let out: HostSnapshot = { epoch, kind: "full", text: cap(whole) };
    if (!o.full && this.shown) {
      const delta = screenDelta(this.shown.lines, this.lines);
      if (delta === undefined) out = { epoch, kind: "unchanged", base_epoch: this.shown.epoch, text: "" };
      else if (delta.length < whole.length * 0.7) out = { epoch, kind: "delta", base_epoch: this.shown.epoch, text: cap(delta) };
    }
    this.shown = { epoch, lines: this.lines };
    return { ...out, changed };
  }

  /** The helper id for a ref the model gave ([12], 12 or "12"), if its element is on the current screen. */
  resolve(ref: unknown): string {
    if (!this.tree || !this.ids.size) throw new Error("No current screen; observe first");
    const s = String(ref ?? "").trim().replace(/^\[|\]$/g, "");
    const id = /^\d+$/.test(s) ? this.byNumber.get(Number(s)) : s;
    if (!id || !this.ids.has(id)) throw new Error(`Element [${s}] is not on the current screen; observe again and use a ref from it`);
    return id;
  }

  currentEpoch(): string { return this.epoch; }

  private find(ref: string): HostNode | undefined {
    const id = /^\[?\d+\]?$/.test(ref) ? this.byNumber.get(Number(ref.replace(/[[\]]/g, ""))) : ref;
    const find = (n: HostNode): HostNode | undefined => n.id === id ? n : (n.children ?? []).reduce<HostNode | undefined>((hit, c) => hit ?? find(c), undefined);
    return id && this.tree ? find(this.tree) : undefined;
  }

  /** What an element is called, for showing the step to the user: its own title or
   *  description, else the first text inside it ("보내기"). */
  label(ref: string): string | undefined {
    const text = (n: HostNode) => [n.title, n.desc, n.placeholder].find((v): v is string => typeof v === "string" && !!v.trim());
    const inner = (n: HostNode, depth: number): string | undefined => {
      if (depth > 3) return undefined;
      for (const c of n.children ?? []) {
        const v = text(c) ?? (c.role === "AXStaticText" && typeof c.value === "string" && c.value.trim() ? c.value : undefined) ?? inner(c, depth + 1);
        if (v) return v;
      }
      return undefined;
    };
    const node = this.find(ref);
    const name = node && (text(node) ?? inner(node, 0));
    return name ? name.replace(/\s+/g, " ").trim().slice(0, 80) : undefined;
  }

  /** Which screen this is, for the user's step line: the window's title, with the page's first
   *  heading when it adds something ("Instagram · 받은 메시지함"). */
  screen(): string | undefined {
    const say = (v: unknown) => typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim() : undefined;
    const first = (n: HostNode, role: string): HostNode | undefined =>
      n.role === role ? n : (n.children ?? []).reduce<HostNode | undefined>((hit, c) => hit ?? first(c, role), undefined);
    const textIn = (n: HostNode, depth = 0): string | undefined =>
      say(n.title) ?? say(n.desc) ?? say(n.value) ?? (depth < 3 ? (n.children ?? []).reduce<string | undefined>((hit, c) => hit ?? textIn(c, depth + 1), undefined) : undefined);
    if (!this.tree) return undefined;
    const win = first(this.tree, "AXWindow");
    const title = win && say(win.title);
    const head = first(win ?? this.tree, "AXHeading");
    const heading = head && textIn(head);
    const parts = [title, heading && !title?.includes(heading) ? heading : undefined].filter((v): v is string => !!v);
    return parts.length ? parts.join(" · ").slice(0, 80) : undefined;
  }

  /** Refs can't be trusted until the next observation, which is shown whole. */
  invalidate(): void { this.ids = new Set(); this.shown = undefined; }
  reset(): void {
    this.epoch = ""; this.tree = undefined; this.raw = ""; this.ids = new Set(); this.lines = []; this.shown = undefined;
    this.numbers = new Map(); this.byNumber = new Map();
  }
}

type Pending = { id: string; resolve: (r: HostResult) => void; reject: (e: Error) => void };

/** Spawns and talks to one `ondra-cuhost` process, one request in flight at a time. */
export class ComputerHostHelper {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private pending?: Pending;
  private seq = 0;
  private closed = false;

  constructor(private readonly command: string, private readonly args: string[] = []) {}

  start(): void {
    if (this.child) return;
    const child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onData(chunk));
    child.on("close", () => { this.closed = true; this.pending?.reject(new Error("Host helper exited")); this.pending = undefined; });
    child.on("error", (e) => { this.closed = true; this.pending?.reject(e); this.pending = undefined; });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      if (!this.pending) continue;
      const pending = this.pending;
      try {
        const { id, result } = envelope(JSON.parse(line));
        if (String(id) !== pending.id) { pending.reject(new Error("Mismatched host response id")); }
        else pending.resolve(result);
      } catch (e) { pending.reject(e as Error); }
      finally { this.pending = undefined; }
    }
  }

  request(op: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<HostResult> {
    if (!this.child || this.closed) return Promise.reject(new Error("Host helper not running"));
    if (this.pending) return Promise.reject(new Error("Host helper busy"));
    if (signal?.aborted) return Promise.reject(new Error("Aborted"));
    const id = String(++this.seq);
    return new Promise<HostResult>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      const onAbort = () => { if (this.pending?.id === id) { this.pending = undefined; reject(new Error("Aborted")); } };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.child!.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
    });
  }

  stop(): void { this.closed = true; try { this.child?.stdin.end(); } catch { /* closing */ } this.child?.kill(); this.child = undefined; }
}

/** One app in one background host session. */
export type HostAction = { kind: string; ref?: unknown; epoch?: string } & Record<string, unknown>;

export class ComputerHostSession {
  private pid?: number;
  private readonly obs = new HostObservation();
  private started = false;
  private stopped = false;
  private busy = false;

  constructor(private readonly helper: ComputerHostHelper) {}

  private asEnv(result: HostResult): HostEnv | undefined {
    const e = result.env;
    return isRecord(e) ? (e as unknown as HostEnv) : undefined;
  }

  async start(app: string, signal?: AbortSignal): Promise<HostResult> {
    if (this.started) throw new Error("Host session already started; use another session for another app");
    this.started = true;
    const launched = await this.helper.request("launch", { app }, signal);
    // the user moving the mouse or typing while it started is theirs, not the launch's
    if (launched.backgroundPreserved === false && launched.userInput !== true) throw new Error("Launch changed the foreground; refusing to continue in background");
    const pid = launched.pid;
    if (typeof pid !== "number") throw new Error("Host launch returned no pid");
    this.pid = pid;
    const observed = await this.observe(true, signal).catch(e => ({ observationError: (e as Error).message }));
    return { pid, ...(typeof launched.mode === "string" ? { mode: launched.mode } : {}),
      ...("kind" in (observed as object) ? { observation: observed } : observed) };
  }

  /** Which screen the app is on, from the last observation (for the user's step line). */
  screen(): string | undefined { return this.obs.screen(); }

  async observe(full: boolean, signal?: AbortSignal, query?: string): Promise<HostSnapshot> {
    return this.guard(async () => {
      const r = await this.helper.request("observe", { pid: this.requirePid(), full }, signal);
      const { changed: _, ...snap } = this.obs.accept(r.tree, { full, ...(query !== undefined ? { query } : {}) });
      return snap;
    });
  }

  async look(signal?: AbortSignal): Promise<HostImage> {
    return this.guard(async () => {
      const r = await this.helper.request("look", { pid: this.requirePid() }, signal);
      const image = r.image;
      if (!isRecord(image) || image.mimeType !== "image/png" || typeof image.data !== "string") throw new Error("Malformed host image");
      const frame = isRecord(r.frame) && ["x", "y", "width", "height"].every(k => typeof (r.frame as Record<string, unknown>)[k] === "number")
        ? r.frame as HostFrame : undefined;
      return { mimeType: "image/png", data: image.data, width: Number(image.width) || 0, height: Number(image.height) || 0,
        ...(frame ? { frame } : {}), ...(r.staged === true ? { staged: true } : {}) };
    });
  }

  /** One action, then re-observe, in a single helper round trip. Refuses to proceed if the action moved the foreground. */
  async act(action: HostAction, signal?: AbortSignal): Promise<HostResult> {
    return this.guard(() => this.once(action, true, signal));
  }

  /**
   * Several actions in order, as one call: each settles before the next, refs are checked
   * against the screen as it is at that step, and the first failure stops the rest. Returns
   * what each step did and the screen once, as a change from what the model last saw.
   */
  async steps(actions: HostAction[], signal?: AbortSignal): Promise<HostResult> {
    return this.guard(async () => {
      const done: Record<string, unknown>[] = [];
      for (let i = 0; i < actions.length; i++) {
        try {
          const r = await this.once(actions[i], i === actions.length - 1, signal);
          const { observation, observationError, ...step } = r;
          done.push(step);
          if (i === actions.length - 1) return { steps: done, ...(observation ? { observation } : { observationError }) };
        } catch (e) {
          // what has happened so far stays done; show the screen as it is now
          const error = (e as Error).message;
          const r = await this.helper.request("observe", { pid: this.requirePid(), full: false }, signal).catch(() => undefined);
          const observation = r?.tree !== undefined ? (({ changed: _, ...snap }) => snap)(this.obs.accept(r.tree, {})) : undefined;
          return { steps: done, failed: { step: i + 1, error }, skipped: actions.length - i - 1, ...(observation ? { observation } : {}) };
        }
      }
      return { steps: done };
    });
  }

  private async once(action: HostAction, show: boolean, signal?: AbortSignal): Promise<HostResult> {
    const translated = this.translate(action);
    const ref = action.ref ?? (isRecord(action.from) ? action.from.ref : undefined);
    const label = ref !== undefined ? this.obs.label(String(ref)) : undefined;
    const r = await this.helper.request("act", { pid: this.requirePid(), action: translated }, signal);
    // the user's own mouse or keys moved things: theirs, not the action's
    if (r.backgroundPreserved === false && r.userInput !== true) {
      this.obs.invalidate();
      throw new Error(r.selfActivated
        ? "The app brought itself to the front and the user's app could not be put back in front; observe, and tell the user if they need to switch back"
        : "Action changed the foreground or cursor; this cannot be done in the background");
    }
    const seen = r.tree !== undefined ? this.obs.accept(r.tree, { show }) : undefined;
    // Delivery is not success: an unchanged tree after the action means it probably did nothing.
    const effect = seen ? (seen.changed ? "changed" : "no_change") : "unknown";
    const observation = seen && show ? (({ changed: _, ...snap }) => snap)(seen) : undefined;
    return {
      kind: action.kind, ...(ref !== undefined ? { ref: String(ref).replace(/^\[|\]$/g, "") } : {}),
      action: { ok: true, effect, ...(typeof r.via === "string" ? { via: r.via } : {}),
        ...(r.selfActivated ? { selfActivated: true, restored: r.restored === true } : {}) },
      ...(typeof r.dragMs === "number" ? { dragMs: r.dragMs } : {}), ...(label ? { label } : {}),
      ...(observation ? { observation } : seen ? {} : { observationError: "NO_WINDOW" }),
    };
  }

  private translate(action: HostAction): Record<string, unknown> {
    const ref = () => this.obs.resolve(action.ref);
    switch (action.kind) {
      // AXPress first; a view that ignores it gets a pointer click addressed to its window
      case "click": return {
        kind: "press-action", ref: ref(), action: "AXPress", fallbackClick: true,
        count: action.count === 2 ? 2 : 1, button: action.button === "right" ? "right" : "left",
        ...(action.pointer === true ? { pointer: true } : {}),
      };
      // an accessibility action the element lists (Increment, Confirm, Pick, …), no events at all
      case "action": {
        const name = String(action.name ?? "").trim();
        if (!/^(AX)?[A-Za-z]{2,40}$/.test(name)) throw new Error("action needs the name of an action the element lists");
        return { kind: "press-action", ref: ref(), action: name.startsWith("AX") ? name : `AX${name}` };
      }
      case "set-value": return { kind: "set-value", ref: ref(), value: String(action.value ?? "") };
      case "type": return action.ref !== undefined ? { kind: "type", ref: ref(), text: String(action.text ?? "") } : { kind: "type", text: String(action.text ?? "") };
      case "press": return { kind: "press", key: String(action.key), modifiers: action.modifiers ?? [] };
      // Coordinates are pixels of the latest look of this window; the helper refuses
      // them if there was no look or the window moved since.
      case "click-at": return { kind: "click-at", x: pixel(action.x, "x"), y: pixel(action.y, "y"), button: action.button ?? "left", count: action.count ?? 1 };
      case "scroll": {
        const where = action.ref !== undefined ? { ref: ref() } : { x: pixel(action.x, "x"), y: pixel(action.y, "y") };
        return { kind: "scroll", ...where, direction: String(action.direction ?? "down"), amount: Number(action.amount ?? 3) };
      }
      case "drag": {
        const end = (value: unknown, name: string): { ref: string } | Point => {
          if (!isRecord(value)) throw new Error(`drag ${name} must be {ref} or {x, y}`);
          if (value.ref !== undefined) {
            if (value.x !== undefined || value.y !== undefined) throw new Error(`drag ${name} takes either ref or x/y`);
            return { ref: this.obs.resolve(value.ref) };
          }
          return { x: pixel(value.x, `${name}.x`), y: pixel(value.y, `${name}.y`) };
        };
        const from = end(action.from, "from"), to = end(action.to, "to");
        if (("ref" in from) !== ("ref" in to)) throw new Error("drag ends must be the same kind: both refs or both pixels");
        return { kind: "drag", from, to };
      }
      default: throw new Error(`Action ${action.kind} is not supported in background host mode`);
    }
  }

  async stop(): Promise<HostResult> {
    if (this.stopped) return { stopped: true };
    this.stopped = true;
    this.obs.reset();
    // its windows were kept out of the user's sight while the job worked: put them back
    if (this.pid !== undefined) await Promise.race([this.helper.request("release", { pid: this.pid }).catch(() => undefined), new Promise((r) => setTimeout(r, 2000))]);
    this.helper.stop();
    return { stopped: true };
  }

  resetObservations(): void { this.obs.invalidate(); }

  private requirePid(): number {
    if (this.pid === undefined || this.stopped) throw new Error("No active host session");
    return this.pid;
  }
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Host session operation already in progress");
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
}
