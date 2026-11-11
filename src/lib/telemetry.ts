// Anonymous usage numbers and private feedback, sent to PostHog: the only place anything leaves for
// it, and docs/TELEMETRY.md lists all of it. Anonymous by construction: an event is one of SHAPES and
// each property a number, a boolean or a member of a named set, so what was asked, a title, a file or
// a folder has no shape to travel in (vet() refuses the rest at runtime). The person is a random id
// this copy of the app made for itself. Three things carry words: an uncaught error and a failed job's
// error (both redacted and cut), and feedback, which the user writes and sends.
// Settings › 일반 turns the numbers off; feedback goes only when the user presses Send.
import { logWarn, redact } from "./log";

/** The project's write-only key, given at build time (VITE_POSTHOG_KEY in `.env`): a build without
 * one, such as a fork's, sends nothing. It is still inside the shipped app, so it is no secret. */
const KEY: string = import.meta.env.VITE_POSTHOG_KEY ?? "";
const HOST = "https://us.i.posthog.com";
/** The API survey that feedback lands in (PostHog › Surveys; VITE_POSTHOG_SURVEY). */
const SURVEY: string = import.meta.env.VITE_POSTHOG_SURVEY ?? "";
/** This build can report numbers (Settings shows the switch). */
export const canTrack = !!KEY;
/** This build can send feedback to the maintainers; otherwise it is filed as an issue. */
export const canSendFeedback = !!KEY && !!SURVEY;
/** asked here, not taken from lib/native: counting must work the same whatever a test puts in native's place */
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const ID = "ondra.telemetry.id";

// ───────────────────────── what may be sent ─────────────────────────
export const VIEWS = ["main", "task", "board", "devices", "memory", "results", "changes", "settings"] as const;
export const PANEL_TABS = ["new", "flow", "side", "artifacts", "changes", "pr", "files", "terminal", "browser", "overview", "preview", "reverse", "issues"] as const;
export const KINDS = ["job", "subagent", "review", "answer"] as const;
export const PROVIDERS = ["anthropic", "openai", "openai-codex", "google", "openrouter", "xai", "groq", "mistral", "deepseek", "github-copilot", "bedrock", "vertex", "azure", "ollama", "other", "none"] as const;
export const MODELS = ["claude-fable", "claude-mythos", "claude-opus", "claude-sonnet", "claude-haiku", "claude", "gpt-6", "gpt-5", "gpt", "o-series", "gemini-pro", "gemini-flash", "gemini", "grok", "deepseek", "qwen", "llama", "mistral", "kimi", "glm", "other", "none"] as const;
export const EFFORTS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const PERMISSIONS = ["ask", "edits", "full"] as const;
export const WEIGHTS = ["light", "heavy"] as const;
export const THEMES = ["system", "dark", "light"] as const;
export const FAULTS = ["network", "auth", "usage_limit", "context_limit", "refused", "engine_exit", "timeout", "no_model", "unknown"] as const;
export const COMMANDS = ["feedback", "btw", "side", "flow", "changes", "files", "terminal", "browser", "pause", "resume", "retry", "start", "done", "merge", "discard", "rename", "ask", "edits", "full", "remember", "memory", "settings", "clear", "compact", "stop", "task", "main", "skill", "other"] as const;
export const WHERE = ["main", "task"] as const;

type In<T extends readonly string[]> = T[number];
/** What every job event says about the job. */
export interface Job {
  kind: In<typeof KINDS>;
  provider: In<typeof PROVIDERS>;
  model: In<typeof MODELS>;
  effort: In<typeof EFFORTS>;
  permission: In<typeof PERMISSIONS>;
  weight: In<typeof WEIGHTS>;
}
export interface Events {
  app_launched: { first_launch: boolean; onboarded: boolean };
  /** whole minutes the window was in front, sent every five */
  app_active: { minutes: number };
  settings_snapshot: {
    spaces_n: number; accounts_n: number; tasks_n: number; memories_n: number; skills_n: number;
    anthropic_connected: boolean; openai_connected: boolean; google_connected: boolean; other_connected: boolean;
    isolate_on: boolean; learn_on: boolean; watch_prs_on: boolean; github_write_on: boolean; focus_guard_on: boolean; links_inside: boolean;
    permission: In<typeof PERMISSIONS>; theme: In<typeof THEMES>;
  };
  onboarding_finished: { signed_in: boolean };
  view_opened: { view: In<typeof VIEWS> };
  panel_opened: { tab: In<typeof PANEL_TABS> };
  command_used: { name: In<typeof COMMANDS> };
  message_sent: { where: In<typeof WHERE> };
  decision_answered: { waited_s: number };
  job_started: Job & { isolated: boolean; from_issue: boolean };
  job_finished: Job & { ok: boolean; seconds: number; tokens: number; subagents_n: number; unverified_n: number; ended_by_user: boolean };
  job_failed: Job & { reason: In<typeof FAULTS>; seconds: number };
  job_merged: { hours_open: number };
  job_discarded: { hours_open: number };
  update_installed: { ok: boolean };
  feedback_sent: { with_log: boolean };
  telemetry_off: Record<string, never>;
}
export type EventName = keyof Events;
/** where the events are listed for people (a test keeps it complete) */
export const EVENTS_DOC = "docs/TELEMETRY.md";
type Kind = "number" | "boolean" | readonly string[];

const JOB: Record<keyof Job, Kind> = { kind: KINDS, provider: PROVIDERS, model: MODELS, effort: EFFORTS, permission: PERMISSIONS, weight: WEIGHTS };
export const SHAPES: { [K in EventName]: Record<keyof Events[K], Kind> } = {
  app_launched: { first_launch: "boolean", onboarded: "boolean" },
  app_active: { minutes: "number" },
  settings_snapshot: {
    spaces_n: "number", accounts_n: "number", tasks_n: "number", memories_n: "number", skills_n: "number",
    anthropic_connected: "boolean", openai_connected: "boolean", google_connected: "boolean", other_connected: "boolean",
    isolate_on: "boolean", learn_on: "boolean", watch_prs_on: "boolean", github_write_on: "boolean", focus_guard_on: "boolean", links_inside: "boolean",
    permission: PERMISSIONS, theme: THEMES,
  },
  onboarding_finished: { signed_in: "boolean" },
  view_opened: { view: VIEWS },
  panel_opened: { tab: PANEL_TABS },
  command_used: { name: COMMANDS },
  message_sent: { where: WHERE },
  decision_answered: { waited_s: "number" },
  job_started: { ...JOB, isolated: "boolean", from_issue: "boolean" },
  job_finished: { ...JOB, ok: "boolean", seconds: "number", tokens: "number", subagents_n: "number", unverified_n: "number", ended_by_user: "boolean" },
  job_failed: { ...JOB, reason: FAULTS, seconds: "number" },
  job_merged: { hours_open: "number" },
  job_discarded: { hours_open: "number" },
  update_installed: { ok: "boolean" },
  feedback_sent: { with_log: "boolean" },
  telemetry_off: {},
};

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** Why an event may not go (null = it may): every field present, nothing extra, each the kind its shape names. */
export function vet(name: string, props: unknown): string | null {
  if (!own(SHAPES, name)) return `unknown event ${name}`;
  const shape = SHAPES[name as EventName] as Record<string, Kind>;
  if (!props || typeof props !== "object" || Array.isArray(props)) return `${name}: not an object`;
  const given = props as Record<string, unknown>;
  for (const key of Object.keys(given)) if (!own(shape, key)) return `${name}: unknown property ${key}`;
  for (const [key, kind] of Object.entries(shape)) {
    if (!own(given, key)) return `${name}: missing ${key}`;
    const v = given[key];
    if (kind === "number" ? typeof v !== "number" || !Number.isFinite(v) : kind === "boolean" ? typeof v !== "boolean" : typeof v !== "string" || !kind.includes(v)) return `${name}: ${key} is not ${typeof kind === "string" ? `a ${kind}` : "in its set"}`;
  }
  return null;
}

// ───────────────────────── open-ended names → closed sets ─────────────────────────
/** A value when the set has it, else the fallback: a setting written by a newer version never breaks an event. */
export const pick = <T extends readonly string[]>(set: T, v: unknown, fallback: T[number]): T[number] => (typeof v === "string" && set.includes(v) ? v : fallback);

const FAMILY: [RegExp, In<typeof MODELS>][] = [
  [/fable/, "claude-fable"], [/mythos/, "claude-mythos"], [/opus/, "claude-opus"], [/sonnet/, "claude-sonnet"], [/haiku/, "claude-haiku"], [/claude/, "claude"],
  [/gpt-?6/, "gpt-6"], [/gpt-?5/, "gpt-5"], [/gpt/, "gpt"], [/(^|[/-])o[1-9](-|$)/, "o-series"],
  [/gemini.*pro/, "gemini-pro"], [/gemini.*flash/, "gemini-flash"], [/gemini/, "gemini"],
  [/grok/, "grok"], [/deepseek/, "deepseek"], [/qwen/, "qwen"], [/llama/, "llama"], [/mistral|codestral|devstral/, "mistral"], [/kimi|moonshot/, "kimi"], [/glm/, "glm"],
];
/** "anthropic/claude-opus-5-5" → its provider and its family. A model the app doesn't know (a local one's own name) is "other". */
export function modelOf(id: string | undefined): { provider: In<typeof PROVIDERS>; model: In<typeof MODELS> } {
  const [head, ...rest] = (id ?? "").toLowerCase().split("/");
  if (!rest.length) return { provider: "none", model: "none" };
  const name = rest.join("/");
  return { provider: pick(PROVIDERS, head, "other"), model: FAMILY.find(([re]) => re.test(name))?.[1] ?? "other" };
}

const FAULT: [RegExp, In<typeof FAULTS>][] = [
  [/context|too long|maximum.*tokens|prompt is too/i, "context_limit"],
  [/rate.?limit|quota|usage limit|overloaded|\b429\b|credit|billing/i, "usage_limit"],
  [/unauthori[sz]ed|\b401\b|\b403\b|api.?key|log ?in|sign ?in|credential|oauth|expired/i, "auth"],
  [/model.*(not found|unsupported|does not exist)|no model|unknown model/i, "no_model"],
  [/fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|socket|\b50[234]\b|bad gateway|unavailable/i, "network"],
  [/timed? ?out|timeout/i, "timeout"],
  [/bad request|\b400\b|invalid_request/i, "refused"],
  [/exit|종료|terminated|killed|signal/i, "engine_exit"],
];
/** A failed job's error, filed under why. `unknown` climbing is the signal to add a name. */
export const faultOf = (message: string | undefined): In<typeof FAULTS> => FAULT.find(([re]) => re.test(message ?? ""))?.[1] ?? "unknown";

// ───────────────────────── sending ─────────────────────────
interface Sent {
  event: string;
  properties: Record<string, unknown>;
  timestamp: string;
}
const QUEUE_MAX = 200;
const queue: Sent[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
// off until the launch says whether the user left the numbers on
let on = () => false;
let common: Record<string, unknown> = {};
let person: Record<string, unknown> = {};

/** Only the installed app reports: not a dev build, the fixture, a plain browser, a test or a build without the key. */
const live = () => canTrack && inTauri && !import.meta.env.DEV && !location.search.includes("fixture");

/** A UUIDv7 (time first), the form PostHog's sessions take. */
export function uuid7(now = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 6; i++) b[i] = Math.floor(now / 2 ** (8 * (5 - i))) % 256;
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A random id kept on this Mac: this copy of the app, never who uses it. `first`: it was made just now. */
export function installId(store: Pick<Storage, "getItem" | "setItem"> = localStorage): { id: string; first: boolean } {
  try {
    const had = store.getItem(ID);
    if (had) return { id: had, first: false };
    const id = crypto.randomUUID();
    store.setItem(ID, id);
    return { id, first: true };
  } catch {
    return { id: "", first: false };
  }
}

/** One event as PostHog takes it. The person is this copy of the app: active users, retention and every
 * breakdown are counted from persons, and the server drops the IP (a project setting). */
export function shape(event: string, props: Record<string, unknown>, id: string, at = new Date()): Sent {
  return { event, properties: { ...common, ...(event === "app_launched" ? person : {}), ...props, distinct_id: id, $process_person_profile: true }, timestamp: at.toISOString() };
}

const post = (batch: Sent[]) =>
  fetch(`${HOST}/batch/`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: KEY, batch }), keepalive: true, signal: AbortSignal.timeout(15_000) }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  });

let sending = false;
/** Send what waits. What can't be sent waits for the next try (bounded), and never holds the app up. */
export async function flushTelemetry() {
  clearTimeout(timer);
  timer = undefined;
  if (sending || !queue.length) return;
  sending = true;
  const batch = queue.splice(0, 50);
  try {
    await post(batch);
  } catch {
    queue.unshift(...batch);
    if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  }
  sending = false;
}

function enqueue(event: string, props: Record<string, unknown>) {
  if (!live() || !on()) return;
  const { id } = installId();
  if (!id) return;
  queue.push(shape(event, props, id));
  if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
  if (queue.length >= 20) void flushTelemetry();
  else timer ??= setTimeout(() => void flushTelemetry(), 10_000);
}

/** Count something that happened: refused unless it is exactly what its shape says. */
export function track<K extends EventName>(name: K, props: Events[K]) {
  const wrong = vet(name, props);
  if (wrong) return refused(wrong);
  enqueue(name, props as Record<string, unknown>);
}

/** A failed job: why (a named bucket), with the error's own words beside it, redacted and cut. */
export function jobFailed(props: Events["job_failed"], message: string | undefined) {
  const wrong = vet("job_failed", props);
  if (wrong) return refused(wrong);
  enqueue("job_failed", { ...props, message: tidy(message ?? "", 200) });
}

/** A refusal is a hole in the numbers: it goes out as a fault, so a schema behind the app shows up. */
function refused(why: string) {
  logWarn("telemetry", `refused: ${why}`);
  const e = new Error(why);
  e.name = "TelemetryRefused";
  e.stack = "";
  fault(e, "telemetry");
}

const tidy = (s: string, max = 300) => redact(s).replace(/\s+/g, " ").trim().slice(0, max);
/** A stack as file names and lines: no folder, no query. */
export const frames = (stack: string) =>
  stack.split("\n").map((l) => /^\s*(?:at\s+)?(?:([^\s@(]+)\s*[@(]\s*)?(?:[^\s()]*\/)?([^/\s():?]+)(?:\?[^:\s]*)?:(\d+):(\d+)\)?\s*$/.exec(l)).filter((m) => !!m).slice(0, 12).map((m) => ({ platform: "custom", lang: "javascript", function: m[1] || "?", filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) }));

const spent = new Map<string, number>();
/** An error nobody caught, in the shape PostHog's error tracking reads. A few of each site a launch. */
export function fault(error: unknown, site: "ui" | "promise" | "telemetry", handled = true) {
  const n = spent.get(site) ?? 0;
  if (n >= 5) return;
  spent.set(site, n + 1);
  const err = error instanceof Error ? error : undefined;
  enqueue("$exception", { site, $exception_list: [{ type: tidy(err?.name ?? "Error", 80), value: tidy(String(err?.message ?? error ?? "unknown")), mechanism: { handled, synthetic: false }, stacktrace: { type: "raw", frames: err?.stack ? frames(err.stack) : [] } }] });
}

/** At launch: what every event carries, whether the user left the numbers on, and the watching that needs
 * no caller (time in front, uncaught errors). Returns whether this is the install's first launch. */
export function startTelemetry(o: { version: string; os: string; lang: string; enabled: () => boolean }): { first: boolean } {
  on = o.enabled;
  const os_version = o.os.replace(/^macOS\s*/, "");
  common = { $lib: "ondra", $lib_version: o.version, app_version: o.version, os: "macos", os_version, lang: o.lang, $session_id: uuid7() };
  person = { $set: { app_version: o.version, os: "macos", os_version, lang: o.lang }, $set_once: { first_seen: new Date().toISOString(), first_version: o.version } };
  const { first } = live() ? installId() : { first: false };
  // minutes in front: counted while the window has focus, sent every five (a crash costs five, not the day)
  let minutes = 0;
  const active = () => minutes && (track("app_active", { minutes }), (minutes = 0));
  setInterval(() => document.hasFocus() && ++minutes >= 5 && active(), 60_000);
  window.addEventListener("error", (e) => fault(e.error ?? e.message, "ui", false));
  window.addEventListener("unhandledrejection", (e) => fault(e.reason, "promise", false));
  window.addEventListener("pagehide", () => (active(), void flushTelemetry()));
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && void flushTelemetry());
  return { first };
}

/**
 * Feedback the user wrote and sent, read only by Ondra's maintainers (a PostHog survey answer).
 * Sent whether or not the numbers are on: pressing Send is the consent. Rejects when it didn't arrive.
 */
export function sendFeedback(text: string, o: { version: string; os: string; where: string; logs?: string }) {
  if (!canSendFeedback) return Promise.reject(new Error("NO_KEY"));
  if (!inTauri) return Promise.resolve();
  const props = { $survey_id: SURVEY, $survey_response: text, app_version: o.version, os_version: o.os, where: o.where, ...(o.logs ? { logs: o.logs } : {}) };
  return post([shape("survey sent", props, installId().id || crypto.randomUUID())]);
}
