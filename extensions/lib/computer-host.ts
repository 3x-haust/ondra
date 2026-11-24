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

  /** The ref number the model sees for a helper id. */
  refOf(id: string): number { return this.number(id); }

  /** Whether a line of the current screen has this text (case and spacing aside). */
  has(phrase: string): boolean {
    const p = squash(phrase);
    return !!p && this.lines.some((l) => squash(l.text).includes(p));
  }

  /**
   * The element called `phrase` on the current screen, for a step that names it instead of
   * giving a ref (it may only have appeared after an earlier step). Its own name (title,
   * description, placeholder, a text's value) counts most, then the text inside it; a control
   * wins over the text inside it, and for typing a field wins. Several equally good: `tied`.
   */
  locate(phrase: string, typing = false): { id?: string; tied: string[] } {
    const p = squash(phrase);
    if (!this.tree || !p) return { tied: [] };
    type Hit = { n: HostNode; score: number; acts: boolean; up: HostNode[] };
    const hits: Hit[] = [];
    const walk = (n: HostNode, up: HostNode[]) => {
      if (n.role !== "AXWindow") {
        const own = [n.title, n.desc, n.placeholder, n.role === "AXStaticText" || TEXT_ROLES.has(n.role) ? n.value : undefined]
          .filter((v): v is string => typeof v === "string").map(squash);
        const acts = ACTING.has(n.role) || Array.isArray(n.actions);
        let score = own.includes(p) ? 4 : own.some((v) => v.includes(p)) ? 2 : 0;
        if (!score && acts) {
          const inner = squash(this.label(n.id) ?? "");
          score = inner === p ? 3 : inner.includes(p) ? 1 : 0;
        }
        if (score) hits.push({ n, score: score + (acts ? 0.5 : 0) + (typing && TEXT_ROLES.has(n.role) ? 1 : 0) - (n.enabled === false ? 1 : 0), acts, up });
      }
      for (const c of n.children ?? []) walk(c, [...up, n]);
    };
    walk(this.tree, []);
    // a button's own text is the button
    const acting = new Set(hits.filter((h) => h.acts).map((h) => h.n));
    const kept = hits.filter((h) => !h.up.some((a) => acting.has(a)));
    if (!kept.length) return { tied: [] };
    const best = Math.max(...kept.map((h) => h.score));
    const top = kept.filter((h) => h.score === best);
    return top.length === 1 ? { id: top[0].n.id, tied: [] } : { tied: top.map((h) => h.n.id) };
  }

  /** A screen line for a helper id, as the model reads it ([12] button "Send"). */
  lineOf(id: string): string {
    const ref = this.number(id);
    const l = this.lines.find((x) => x.ref === ref);
    return l ? `[${ref}] ${l.text}` : `[${ref}]`;
  }

  /** Whether the element is a button ([12] or helper id). */
  isButton(ref: string): boolean { return this.find(ref)?.role === "AXButton"; }

  /** Whether a button with this name is on the current screen. */
  hasButton(name: string): boolean {
    const walk = (n: HostNode): boolean =>
      (n.role === "AXButton" && [n.title, n.desc].some((v) => typeof v === "string" && v.replace(/\s+/g, " ").trim() === name)) ||
      (n.children ?? []).some(walk);
    return !!this.tree && walk(this.tree);
  }

  /** Refs can't be trusted until the next observation, which is shown whole. */
  invalidate(): void { this.ids = new Set(); this.shown = undefined; }
  reset(): void {
    this.epoch = ""; this.tree = undefined; this.raw = ""; this.ids = new Set(); this.lines = []; this.shown = undefined;
    this.numbers = new Map(); this.byNumber = new Map();
  }
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase().normalize("NFC");
const TEXT_ROLES = new Set(["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"]);
const ACTING = new Set(["AXButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton",
  "AXMenuButton", "AXComboBox", "AXTextField", "AXTextArea", "AXSearchField", "AXCell", "AXRow", "AXTab", "AXDisclosureTriangle", "AXSlider", "AXIncrementor"]);

/** how long a step's `find` waits for its element to come up, and a `wait` by default / at most (ms) */
export const FIND_MS = 3000;
export const WAIT_MS = 5000;
export const WAIT_MAX_MS = 15000;
/** between two reads of the screen while waiting (ms) */
const POLL_MS = 120;

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
      // Keep the slot until its reply arrives; a cancelled request must not consume
      // the next request's response or let an approval overtake an unfinished act.
      const onAbort = () => { if (this.pending?.id === id) reject(new Error("Aborted")); };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.child!.stdin.write(JSON.stringify({ id, op, ...params }) + "\n");
    });
  }

  stop(): void { this.closed = true; try { this.child?.stdin.end(); } catch { /* closing */ } this.child?.kill(); this.child = undefined; }
}

/** How long stop waits for the helper's release: its worst case is a quit grace (1.2 s), a kill
 *  (≤2 s) and the copy's cleanup. */
export const RELEASE_WAIT_MS = 8000;

/** One app in one background host session. */
export type HostAction = { kind: string; ref?: unknown; epoch?: string } & Record<string, unknown>;
export type HostConfirm = (summary: string, signal?: AbortSignal) => Promise<boolean>;

export class ComputerHostSession {
  private target?: { kind: "app"; pid: number } | { kind: "approval"; pid: number; home: number };
  private readonly obs = new HostObservation();
  private started = false;
  private stopped = false;
  private busy = false;
  // A button whose press took the screen away (a prompt, a dialog, a new page); if the same
  // button comes back once something else was pressed, the prompt may have swallowed the press.
  private pressedAway?: string;

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
    if (launched.backgroundPreserved === false && launched.userInput !== true) throw new Error("Launch changed the foreground: the app came to the front as it started, so it cannot be used in the background. Start it once more at most; if it does this again, report it as not verifiable here");
    const pid = launched.pid;
    if (typeof pid !== "number") throw new Error("Host launch returned no pid");
    this.target = { kind: "app", pid };
    const observed = await this.observe(true, signal).catch(e => ({ observationError: (e as Error).message }));
    const menus = Array.isArray(launched.menus) ? launched.menus.filter((m): m is string => typeof m === "string").slice(0, 14) : [];
    return { pid, ...(typeof launched.path === "string" ? { path: launched.path } : {}), ...(typeof launched.mode === "string" ? { mode: launched.mode } : {}), ...(menus.length ? { menus } : {}),
      ...("kind" in (observed as object) ? { observation: observed } : observed) };
  }

  /** List exact running-app windows, then select one of that listing's opaque refs.
   *  The original app stays alive until stop, including when the target is another pid. */
  async targets(app: string, signal?: AbortSignal): Promise<HostResult> {
    return this.guard(() => this.helper.request("targets", { app }, signal));
  }

  async selectTarget(ref: string, signal?: AbortSignal): Promise<HostResult> {
    return this.guard(async () => {
      const home = this.target?.kind === "approval" ? this.target.home : this.requirePid();
      const r = await this.helper.request("target", { ref }, signal);
      if (typeof r.pid !== "number") throw new Error("Host target returned no pid");
      this.target = { kind: "approval", pid: r.pid, home };
      this.pressedAway = undefined;
      this.obs.reset();
      const { changed: _, ...observation } = this.obs.accept(r.tree, true);
      return { observation };
    });
  }

  async resume(signal?: AbortSignal): Promise<HostResult> {
    return this.guard(async () => {
      const home = this.target?.kind === "approval" ? this.target.home : this.requirePid();
      await this.helper.request("resume", {}, signal);
      this.target = { kind: "app", pid: home };
      this.pressedAway = undefined;
      this.obs.reset();
      const r = await this.helper.request("observe", { pid: home, full: true }, signal);
      const { changed: _, ...observation } = this.obs.accept(r.tree, true);
      return { observation };
    });
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
      if (r.matchedTree !== true) throw new HostHelperError("SECURE_CAPTURE_REFUSED", "capture did not match the inspected window; no image was saved");
      const image = r.image;
      if (!isRecord(image) || image.mimeType !== "image/png" || typeof image.data !== "string") throw new Error("Malformed host image");
      const frame = isRecord(r.frame) && ["x", "y", "width", "height"].every(k => typeof (r.frame as Record<string, unknown>)[k] === "number")
        ? r.frame as HostFrame : undefined;
      return { mimeType: "image/png", data: image.data, width: Number(image.width) || 0, height: Number(image.height) || 0,
        ...(frame ? { frame } : {}), ...(r.staged === true ? { staged: true } : {}) };
    });
  }

  /** One action, then re-observe, in a single helper round trip. Refuses to proceed if the action moved the foreground. */
  async act(action: HostAction, signal?: AbortSignal, confirm?: HostConfirm): Promise<HostResult> {
    return this.guard(() => this.once(action, true, signal, confirm));
  }

  /**
   * Several actions in order, as one call: each settles before the next, refs are checked
   * against the screen as it is at that step, and the first failure stops the rest. Returns
   * what each step did and the screen once, as a change from what the model last saw.
   */
  async steps(actions: HostAction[], signal?: AbortSignal, confirm?: HostConfirm): Promise<HostResult> {
    return this.guard(async () => {
      const done: Record<string, unknown>[] = [];
      for (let i = 0; i < actions.length; i++) {
        try {
          const last = i === actions.length - 1;
          if (actions[i].kind === "wait") {
            done.push(await this.waitFor(actions[i], signal));
            if (last) return { steps: done, observation: await this.showNow(signal) };
            continue;
          }
          const r = await this.once(await this.locate(actions[i], signal), last, signal, confirm);
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

  /** Read the screen again without showing it (refs and `find` see it; the model's view stays). */
  private async refresh(signal?: AbortSignal): Promise<void> {
    const r = await this.helper.request("observe", { pid: this.requirePid(), full: false }, signal);
    if (r.tree !== undefined) this.obs.accept(r.tree, { show: false });
  }

  /** The screen now, as a change from what the model last saw. */
  private async showNow(signal?: AbortSignal): Promise<HostSnapshot> {
    const r = await this.helper.request("observe", { pid: this.requirePid(), full: false }, signal);
    const { changed: _, ...snap } = this.obs.accept(r.tree, {});
    return snap;
  }

  /** Ask `test` of the screen, reading it again between tries, until it answers or `ms` pass. */
  private async until<T>(test: () => T | undefined, ms: number, signal?: AbortSignal): Promise<T | undefined> {
    const end = Date.now() + ms;
    for (;;) {
      const v = test();
      if (v !== undefined || Date.now() >= end) return v;
      await new Promise<void>((done, fail) => {
        const t = setTimeout(done, POLL_MS);
        signal?.addEventListener("abort", () => (clearTimeout(t), fail(new Error("Computer operation cancelled"))), { once: true });
      });
      await this.refresh(signal);
    }
  }

  /** A step that names its element (find) instead of a ref: the element, once it is on screen. */
  private async locate(action: HostAction, signal?: AbortSignal): Promise<HostAction> {
    if (action.find === undefined) return action;
    if (action.ref !== undefined) throw new Error("a step takes ref or find, not both");
    const phrase = typeof action.find === "string" ? action.find.trim() : "";
    if (!phrase || phrase.length > 120) throw new Error("find is the element's name as on screen (a short phrase)");
    const typing = action.kind === "type" || action.kind === "set-value";
    const got = await this.until(() => { const r = this.obs.locate(phrase, typing); return r.id || r.tied.length ? r : undefined; }, FIND_MS, signal);
    if (!got) throw new Error(`FIND_NOT_FOUND: nothing called “${phrase}” on screen after ${FIND_MS / 1000} s`);
    if (!got.id) throw new Error(`FIND_AMBIGUOUS: “${phrase}” fits ${got.tied.length}: ${got.tied.slice(0, 6).map((id) => this.obs.lineOf(id)).join("; ")}; use the ref of the one you mean`);
    const { find: _, ...rest } = action;
    return { ...rest, ref: this.obs.refOf(got.id) };
  }

  /** wait {for, gone?, seconds?}: until that text is on screen (or gone), read again and again. */
  private async waitFor(action: HostAction, signal?: AbortSignal): Promise<HostResult> {
    const phrase = typeof action.for === "string" ? action.for.trim() : "";
    if (!phrase || phrase.length > 120) throw new Error("wait needs for: a short text to wait for on screen");
    const gone = action.gone === true;
    const ms = Math.min(WAIT_MAX_MS, Math.max(200, typeof action.seconds === "number" ? action.seconds * 1000 : WAIT_MS));
    const t0 = Date.now();
    await this.refresh(signal);
    const ok = await this.until(() => (this.obs.has(phrase) !== gone ? true : undefined), ms, signal);
    if (!ok) throw new Error(`WAIT_TIMEOUT: “${phrase}” ${gone ? "still on screen" : "not on screen"} after ${Math.round(ms / 100) / 10} s`);
    return { kind: "wait", wait: { for: phrase, gone, after: Math.round((Date.now() - t0) / 100) / 10 } };
  }

  private async once(action: HostAction, show: boolean, signal?: AbortSignal, confirm?: HostConfirm): Promise<HostResult> {
    const translated = this.translate(action);
    const ref = action.ref ?? (isRecord(action.from) ? action.from.ref : undefined);
    const label = ref !== undefined ? this.obs.label(String(ref)) : undefined;
    const button = action.kind === "click" && ref !== undefined && this.obs.isButton(String(ref)) ? label : undefined;
    const prepared = await this.helper.request("prepare", { pid: this.requirePid(), action: translated }, signal);
    let r: HostResult;
    if (prepared.required === true || action.kind === "fill-secret") {
      try {
        if (typeof prepared.approval !== "string" || typeof prepared.summary !== "string") throw new Error("Missing secure confirmation target");
        if (!confirm) throw new Error("APPROVAL_UNAVAILABLE: confirm this action in the app; nothing was sent");
        if (await confirm(prepared.summary, signal) !== true) throw new Error("APPROVAL_DENIED: nothing was sent");
        if (signal?.aborted || this.stopped) throw new Error("Computer operation cancelled");
        // The helper executes the held action, not new parameters supplied after approval.
        r = await this.helper.request("commit-approval", { approval: prepared.approval }, signal);
      } finally {
        await this.helper.request("cancel-approval").catch(() => undefined);
      }
    } else {
      r = await this.helper.request("act", { pid: this.requirePid(), action: translated }, signal);
    }
    // the user's own mouse or keys moved things: theirs, not the action's
    if (r.backgroundPreserved === false && r.userInput !== true) {
      this.obs.invalidate();
      throw new Error(r.selfActivated
        ? "The app brought itself to the front and the user's app could not be put back in front; observe, and tell the user if they need to switch back"
        : "Action changed the foreground or cursor; this cannot be done in the background");
    }
    const seen = r.tree !== undefined ? this.obs.accept(r.tree, { show }) : undefined;
    let pressAgain: string | undefined;
    if (seen) {
      if (this.pressedAway && this.pressedAway !== button && this.obs.hasButton(this.pressedAway)) {
        pressAgain = this.pressedAway;
        this.pressedAway = undefined;
      }
      if (button && seen.changed && !this.obs.hasButton(button)) this.pressedAway = button;
    }
    // Delivery is not success: an unchanged tree after the action means it probably did nothing.
    const effect = action.kind === "fill-secret" ? "delivered" : seen ? (seen.changed ? "changed" : "no_change") : "unknown";
    const observation = seen && show ? (({ changed: _, ...snap }) => snap)(seen) : undefined;
    return {
      kind: action.kind, ...(ref !== undefined ? { ref: String(ref).replace(/^\[|\]$/g, "") } : {}),
      action: { ok: true, effect, ...(typeof r.via === "string" ? { via: r.via } : {}),
        ...(r.selfActivated ? { selfActivated: true, restored: r.restored === true } : {}),
        ...(r.dropInApp === false ? { dropOutside: true } : {}),
        ...(r.raisedOverUser === true ? { raisedOverUser: true, orderRestored: r.orderRestored === true } : {}),
        ...(pressAgain ? { pressAgain } : {}) },
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
        const ax = name.startsWith("AX") ? name : `AX${name}`;
        // raising puts the target window over the user's: the app is driven where it is
        if (ax === "AXRaise") throw new Error("Raise would bring the window in front of the user's; act on it where it is (click, set-value, action)");
        return { kind: "press-action", ref: ref(), action: ax };
      }
      case "fill-secret": {
        if (Object.keys(action).some(k => !["kind", "ref", "secret"].includes(k)) ||
            typeof action.secret !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(action.secret)) {
          throw new Error("fill-secret takes only ref and a saved secret name, never text or value");
        }
        return { kind: "fill-secret", ref: ref(), secret: action.secret };
      }
      case "set-value": return { kind: "set-value", ref: ref(), value: String(action.value ?? "") };
      case "menu": {
        const path = Array.isArray(action.path) ? action.path.map((p) => String(p).trim()).filter(Boolean) : [];
        if (!path.length || path.length > 6) throw new Error("menu needs path: 1–6 titles from the menu bar down");
        return { kind: "menu", path };
      }
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
    // A copy the job opened is quit (killed after a short grace if it ignores that), a real app
    // it opened is quit, the user's own app is hidden again. The wait outlasts the helper's own
    // worst case, so it is not cut off midway; even if it were, the helper's exit path ends
    // whatever it still holds.
    if (this.target !== undefined) {
      const pid = this.target.kind === "approval" ? this.target.home : this.target.pid;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.helper.request("release", { pid }).catch(() => undefined),
        new Promise((r) => { timer = setTimeout(r, RELEASE_WAIT_MS); }),
      ]);
      clearTimeout(timer);
    }
    this.helper.stop();
    return { stopped: true };
  }

  resetObservations(): void { this.obs.invalidate(); }

  private requirePid(): number {
    if (!this.target || this.stopped) throw new Error("No active host session");
    return this.target.pid;
  }
  private async guard<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new Error("Host session operation already in progress");
    this.busy = true;
    try { return await work(); } finally { this.busy = false; }
  }
}
