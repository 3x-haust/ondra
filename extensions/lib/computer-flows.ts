// Saved flows: a stretch of work in one app that went right once, kept as steps that name their
// elements (find) instead of a session's refs, with {placeholders} for what changes each time (the
// room, the message). Done again, it runs in one call without a model turn between the steps,
// the way a person's hands remember an app they use every day. A run that meets something
// unexpected stops there and hands the screen back to the model, which carries on by hand and
// may save the flow again.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type FlowStep = { kind: string } & Record<string, unknown>;
export type Flow = { about: string; steps: FlowStep[]; params: string[]; savedAt: number; runs?: number; stopped?: number };
type Store = Record<string, Record<string, Flow>>;

/** step kinds a flow keeps: each finds its element by name when it runs */
const KINDS = new Set(["click", "action", "set-value", "type", "press", "scroll", "menu", "wait", "fill-secret"]);
/** fields whose words may hold a {placeholder} */
const WORDS = ["find", "text", "value", "for"] as const;
const HOLE = /\{([A-Za-z0-9_가-힣]{1,30})\}/g;
export const MAX_FLOWS = 100;

/** where flows live: the workspace's own folder for them (one file for all apps), as the app says */
export const flowsPath = (env: Readonly<Record<string, string | undefined>> = process.env): string | undefined => {
  const dir = (env.ONDRA_FLOWS_DIR ?? "").replace(/\/$/, "");
  return dir ? join(dir, "flows.json") : undefined;
};

/** an app's key: the same app by its name, any case */
export const appKey = (app: string) => app.trim().replace(/\/+$/, "").toLowerCase();

export function readFlows(path = flowsPath()): Store {
  if (!path) return {};
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    return s && typeof s === "object" && !Array.isArray(s) ? (s as Store) : {};
  } catch {
    return {};
  }
}

function writeFlows(store: Store, path = flowsPath()): void {
  if (!path) throw new Error("Saved flows unavailable: no data folder");
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 1), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Check a flow's steps and name its placeholders; throws on what can't be replayed. */
export function checkFlow(steps: unknown): { steps: FlowStep[]; params: string[] } {
  if (!Array.isArray(steps) || !steps.length || steps.length > 20) throw new Error("a flow is 1–20 steps");
  const params = new Set<string>();
  const out: FlowStep[] = [];
  steps.forEach((raw, i) => {
    const n = i + 1;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`step ${n} is not an action`);
    const s = { ...(raw as Record<string, unknown>) };
    delete s.epoch;
    if (typeof s.kind !== "string" || !KINDS.has(s.kind)) throw new Error(`step ${n}: ${String(s.kind)} can't be saved (a flow keeps click, action, set-value, type, press, scroll, menu, wait, fill-secret)`);
    if (s.ref !== undefined) throw new Error(`step ${n}: a ref is this session's only; name the element with find (its name as on screen)`);
    if (s.x !== undefined || s.y !== undefined) throw new Error(`step ${n}: pixels move between runs; use find`);
    const needs = ["click", "action", "set-value", "fill-secret"].includes(s.kind);
    if (needs && typeof s.find !== "string") throw new Error(`step ${n}: ${s.kind} needs find (the element's name as on screen)`);
    for (const k of WORDS) {
      const v = s[k];
      if (v === undefined) continue;
      if (typeof v !== "string" || !v.trim() || v.length > 2000) throw new Error(`step ${n}: ${k} must be text`);
      for (const m of v.matchAll(HOLE)) params.add(m[1]);
    }
    if (Array.isArray(s.path)) for (const p of s.path) if (typeof p === "string") for (const m of p.matchAll(HOLE)) params.add(m[1]);
    out.push(s as FlowStep);
  });
  return { steps: out, params: [...params] };
}

/** Save (or replace) a flow for an app. */
export function saveFlow(app: string, name: string, about: string, steps: unknown, now = Date.now(), path = flowsPath()): Flow {
  const flowName = name.trim();
  if (!flowName || flowName.length > 40 || /[\x00-\x1f{}]/.test(flowName)) throw new Error("flow: a short name (1–40 characters)");
  const why = about.trim();
  if (!why || why.length > 200) throw new Error("about: what the flow does, in a line");
  const { steps: kept, params } = checkFlow(steps);
  const store = readFlows(path);
  const key = appKey(app);
  const mine = { ...(store[key] ?? {}) };
  const had = mine[flowName];
  if (!had && Object.values(store).reduce((n, f) => n + Object.keys(f).length, 0) >= MAX_FLOWS) throw new Error(`at most ${MAX_FLOWS} saved flows; replace one`);
  const flow: Flow = { about: why, steps: kept, params, savedAt: now, ...(had?.runs ? { runs: had.runs } : {}) };
  mine[flowName] = flow;
  store[key] = mine;
  writeFlows(store, path);
  return flow;
}

export function flowOf(app: string, name: string, path = flowsPath()): Flow | undefined {
  return readFlows(path)[appKey(app)]?.[name.trim()];
}

/** The steps with each {placeholder} filled; throws when a value is missing. */
export function fillFlow(flow: Flow, values: Record<string, unknown> = {}): FlowStep[] {
  const missing = flow.params.filter((p) => typeof values[p] !== "string");
  if (missing.length) throw new Error(`values needed: ${missing.join(", ")}`);
  const fill = (v: string) => v.replace(HOLE, (all, k: string) => (typeof values[k] === "string" ? (values[k] as string) : all));
  return flow.steps.map((s) => {
    const o: FlowStep = { ...s };
    for (const k of WORDS) if (typeof o[k] === "string") o[k] = fill(o[k] as string);
    if (Array.isArray(o.path)) o.path = (o.path as unknown[]).map((p) => (typeof p === "string" ? fill(p) : p));
    return o;
  });
}

/** Count a run: done, or stopped at a step. */
export function countRun(app: string, name: string, stopped: boolean, path = flowsPath()): void {
  const store = readFlows(path);
  const f = store[appKey(app)]?.[name.trim()];
  if (!f) return;
  f.runs = (f.runs ?? 0) + 1;
  if (stopped) f.stopped = (f.stopped ?? 0) + 1;
  try { writeFlows(store, path); } catch { /* counting is best effort */ }
}

/** One line a flow: `send-message(room, text): 카톡방에 메시지 보내기`. */
export const flowLine = (name: string, f: Flow) => `${name}(${f.params.join(", ")}): ${f.about}`;

/** What is saved, for the prompt: per app, one line a flow. Empty when nothing. */
export function flowsNote(store = readFlows()): string {
  const apps = Object.entries(store).filter(([, fs]) => Object.keys(fs).length);
  if (!apps.length) return "";
  const lines = apps.flatMap(([app, fs]) => Object.entries(fs).map(([n, f]) => `- ${app}: ${flowLine(n, f)}`)).slice(0, 20);
  return `Saved computer flows (computer run {app, flow, values} does one in a single call, opening the app if needed; prefer it to doing the same by hand):\n${lines.join("\n")}`;
}
