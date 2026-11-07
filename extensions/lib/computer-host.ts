// Host background computer use: the TypeScript side of the `ondra-cuhost` helper.
//
// This drives the signed Swift helper (src-tauri/helpers/cuhost.swift) that operates
// one app on the USER'S OWN Mac entirely in the background: Accessibility tree +
// actions, pid-targeted events as a fallback, and ScreenCaptureKit window-only
// captures. It never activates an app, never moves the cursor, never posts to the
// global session. The helper reports the frontmost app / key window / mouse before
// and after every action; this module refuses any action whose result shows those
// changed, instead of papering over it the way Codex does.
//
// Two independently testable pieces live here:
//   - envelope(): validates one helper response (version 1, {ok,result|error}).
//   - HostObservation: a compact, stable-id AX tree with full / delta / unchanged
//     observations and id-based ref resolution — the token-saving core, so later
//     steps send only what changed.
// ComputerHostHelper spawns the process and matches responses to requests by id.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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
  return before.frontmostPid === after.frontmostPid &&
    (before.frontmostKeyWindow ?? null) === (after.frontmostKeyWindow ?? null) &&
    before.mouse.x === after.mouse.x && before.mouse.y === after.mouse.y;
}

function validateNode(node: unknown, depth: number): HostNode {
  if (depth > 200) throw new Error("Host tree too deep");
  if (!isRecord(node) || typeof node.id !== "string" || typeof node.role !== "string") throw new Error("Malformed host node");
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) throw new Error("Malformed host children");
    for (const child of node.children) validateNode(child, depth + 1);
  }
  return node as HostNode;
}

type Change = { op: "set"; path: (string | number)[]; value: unknown } | { op: "remove"; path: (string | number)[] };
export type HostSnapshot =
  | { epoch: string; kind: "full"; tree: HostNode }
  | { epoch: string; kind: "delta"; base_epoch: string; changes: Change[] }
  | { epoch: string; kind: "unchanged"; base_epoch: string };

function diff(before: unknown, after: unknown, path: (string | number)[], out: Change[]): void {
  if (before === after) return;
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    for (let i = 0; i < after.length; i++) diff(before[i], after[i], [...path, i], out);
  } else if (isRecord(before) && isRecord(after)) {
    for (const key of Object.keys(before)) if (!(key in after)) out.push({ op: "remove", path: [...path, key] });
    for (const key of Object.keys(after)) {
      if (!(key in before)) out.push({ op: "set", path: [...path, key], value: after[key] });
      else diff(before[key], after[key], [...path, key], out);
    }
  } else {
    out.push({ op: "set", path, value: after });
  }
}

const encoder = new TextEncoder();
const size = (v: unknown) => encoder.encode(JSON.stringify(v)).length;

/**
 * One window's observation history. Holds per-session stable element ids (the
 * helper derives each from the element's structural path + role + identifier, so
 * the same control keeps its id across observations). Actions reference an id,
 * valid only for the current epoch. Later observations are a JSON diff from the
 * previous tree, or "unchanged" — never re-sending the whole tree for free.
 */
export class HostObservation {
  private revision = 0;
  private epoch = "";
  private baseEpoch = "";
  private tree?: HostNode;
  private ids = new Set<string>();

  accept(rawTree: unknown, full: boolean): HostSnapshot {
    const tree = validateNode(rawTree, 0);
    const epoch = `h${++this.revision}`;
    this.collectIds(tree);
    const out: HostSnapshot = (() => {
      if (!full && this.tree && this.baseEpoch) {
        const changes: Change[] = [];
        diff(this.tree, tree, [], changes);
        if (changes.length === 0) return { epoch, kind: "unchanged", base_epoch: this.baseEpoch };
        const delta: HostSnapshot = { epoch, kind: "delta", base_epoch: this.baseEpoch, changes };
        const whole: HostSnapshot = { epoch, kind: "full", tree };
        return size(delta) <= size(whole) ? delta : whole;
      }
      return { epoch, kind: "full", tree };
    })();
    this.tree = JSON.parse(JSON.stringify(tree)) as HostNode;
    this.epoch = epoch;
    this.baseEpoch = epoch;
    return out;
  }

  private collectIds(node: HostNode): void {
    // Rebuild the id set for the just-accepted tree; only its own ids are actionable.
    const next = new Set<string>();
    const walk = (n: HostNode) => { next.add(n.id); for (const c of n.children ?? []) walk(c); };
    walk(node);
    this.ids = next;
  }

  /** An action may only target an id present in the current epoch. */
  resolve(epoch: string, ref: string): string {
    if (!this.epoch || epoch !== this.epoch) throw new Error("Stale observation epoch");
    if (!this.ids.has(ref)) throw new Error("Unknown element ref");
    return ref;
  }

  currentEpoch(): string { return this.epoch; }

  invalidate(): void { this.epoch = ""; }
  reset(): void { this.epoch = ""; this.baseEpoch = ""; this.tree = undefined; this.ids = new Set(); }
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

/** One app in one background host session, mirroring the guest session's surface. */
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
    if (launched.backgroundPreserved === false) throw new Error("Launch changed the foreground; refusing to continue in background");
    const pid = launched.pid;
    if (typeof pid !== "number") throw new Error("Host launch returned no pid");
    this.pid = pid;
    const observed = await this.observe(true, signal).catch(e => ({ observationError: (e as Error).message }));
    return { pid, env: launched.env, ...("kind" in (observed as object) ? { observation: observed } : observed) };
  }

  async observe(full: boolean, signal?: AbortSignal): Promise<HostSnapshot> {
    return this.guard(async () => {
      const r = await this.helper.request("observe", { pid: this.requirePid(), full }, signal);
      return this.obs.accept(r.tree, full);
    });
  }

  async look(signal?: AbortSignal): Promise<{ mimeType: "image/png"; data: string; width: number; height: number }> {
    return this.guard(async () => {
      const r = await this.helper.request("look", { pid: this.requirePid() }, signal);
      const image = r.image;
      if (!isRecord(image) || image.mimeType !== "image/png" || typeof image.data !== "string") throw new Error("Malformed host image");
      return { mimeType: "image/png", data: image.data, width: Number(image.width) || 0, height: Number(image.height) || 0 };
    });
  }

  /** One action, then re-observe, in a single helper round trip. Refuses to proceed if the action moved the foreground. */
  async act(action: { kind: string; epoch: string; ref?: string } & Record<string, unknown>, signal?: AbortSignal): Promise<HostResult> {
    return this.guard(async () => {
      const before = this.obs.currentEpoch();
      const translated = this.translate(action, before);
      const r = await this.helper.request("act", { pid: this.requirePid(), action: translated }, signal);
      if (r.backgroundPreserved === false) {
        this.obs.invalidate();
        throw new Error("Action changed the foreground or cursor; this cannot be done in the background");
      }
      const snapshot = r.tree !== undefined ? this.obs.accept(r.tree, false) : undefined;
      return { action: { ok: true, outcome: "verified" }, actionMs: r.actionMs, env: r.env,
        ...(snapshot ? { observation: snapshot } : { observationError: "NO_WINDOW" }) };
    });
  }

  private translate(action: { kind: string; epoch: string; ref?: string } & Record<string, unknown>, epoch: string): Record<string, unknown> {
    const ref = () => this.obs.resolve(epoch, String(action.ref));
    switch (action.kind) {
      case "click": return { kind: "press-action", ref: ref(), action: "AXPress" };
      case "set-value": return { kind: "set-value", ref: ref(), value: String(action.value ?? "") };
      case "type": return action.ref !== undefined ? { kind: "type", ref: ref(), text: String(action.text ?? "") } : { kind: "type", text: String(action.text ?? "") };
      case "press": return { kind: "press", key: String(action.key), modifiers: action.modifiers ?? [] };
      case "click-at": return { kind: "click-at", x: Number(action.x), y: Number(action.y), button: action.button ?? "left", count: action.count ?? 1 };
      case "scroll": return { kind: "scroll", x: Number(action.x ?? 0), y: Number(action.y ?? 0), direction: String(action.direction ?? "down"), amount: Number(action.amount ?? 3) };
      default: throw new Error(`Action ${action.kind} is not supported in background host mode`);
    }
  }

  async stop(): Promise<HostResult> {
    if (this.stopped) return { stopped: true };
    this.stopped = true;
    this.obs.reset();
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
