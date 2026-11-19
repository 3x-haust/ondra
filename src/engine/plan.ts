// A job's to-do list: big steps in the order they are done, each with the smaller
// steps it is split into once it is reached. The order is the order of the work: a
// request that comes in while the job works is put where it belongs by what depends
// on what (a survey that ships with the deploy is built before the deploy), and
// steps the user asked for that way carry `user` so they aren't dropped silently.
// A step is never skipped silently either: one the job jumps over, or leaves open at done,
// needs its reason ("skip": "…") before the job may finish (pstack's "a skipped item keeps
// its line and says why": the habit that kept agents from quietly dropping verification).
import type { PlanStep } from "../state/types";

const MAX_STEPS = 10;
const MAX_SUB = 8;

const key = (s: string) => s.replace(/[\s·.,()]/g, "").toLowerCase();

type Mark = { done?: boolean; skip?: string };
type Read = { text: string; user?: boolean; sub?: ({ text: string; user?: boolean } & Mark)[] } & Mark;

const textOf = (x: unknown): string =>
  typeof x === "string" ? x.trim() : x && typeof x === "object" ? String((x as Record<string, unknown>).text ?? "").trim() : "";
const userOf = (x: unknown) => !!x && typeof x === "object" && (x as Record<string, unknown>).user === true;
/** what the job said of a step itself: {"done": true}, or {"skip": "why"} */
function markOf(x: unknown): Mark {
  if (!x || typeof x !== "object") return {};
  const o = x as Record<string, unknown>;
  const why = typeof o.skip === "string" ? o.skip.trim() : "";
  return why ? { skip: why.slice(0, 200) } : o.done === true ? { done: true } : {};
}

/** One step as the model sent it: "text", or {"text", "sub": [...], "user": true}. */
function readStep(x: unknown): Read | undefined {
  const text = textOf(x);
  if (!text) return undefined;
  const raw = x && typeof x === "object" ? (x as Record<string, unknown>).sub : undefined;
  const sub = Array.isArray(raw)
    ? raw
        .map((s) => ({ text: textOf(s), ...(userOf(s) ? { user: true } : {}), ...markOf(s) }))
        .filter((s) => s.text)
        .slice(0, MAX_SUB)
    : [];
  return { text, ...(userOf(x) ? { user: true } : {}), ...markOf(x), ...(sub.length ? { sub } : {}) };
}

/** Where the plan is: the first open step is now, and inside it its first open smaller step. */
function focus(plan: PlanStep[]): PlanStep[] {
  let found = false;
  for (const s of plan) {
    if (s.state === "done" || s.state === "skip") continue;
    if (found) {
      s.state = "todo";
      for (const x of s.sub ?? []) if (x.state === "now") x.state = "todo";
      continue;
    }
    found = true;
    s.state = "now";
    let inner = false;
    for (const x of s.sub ?? []) {
      if (x.state === "done" || x.state === "skip") continue;
      x.state = inner ? "todo" : "now";
      inner = true;
    }
  }
  return plan;
}

/** a step's state from what the job said of it, else from the old plan */
function stateOf(m: Mark, done: boolean, skipped?: string): Pick<PlanStep, "state" | "why"> {
  if (m.skip) return { state: "skip", why: m.skip };
  if (m.done || done) return { state: "done" };
  return skipped ? { state: "skip", why: skipped } : { state: "todo" };
}

/**
 * A new plan keeps what was already finished (same text, big or small) as done, a skip and
 * its reason, and who asked for a step; the first open one is current. A step the user asked
 * for that the new plan leaves out stays at its end, open: only done or a reason closes it.
 */
export function nextPlan(old: PlanStep[], steps: unknown[]): PlanStep[] {
  const all = old.flatMap((s) => [s, ...(s.sub ?? [])]);
  const finished = new Set(all.filter((s) => s.state === "done").map((s) => key(s.text)));
  const asked = new Set(all.filter((s) => s.user).map((s) => key(s.text)));
  const skipped = new Map(all.filter((s) => s.state === "skip" && s.why).map((s) => [key(s.text), s.why!]));
  // a finished step that had no smaller steps yet: the ones it is given now were done with it
  const doneBare = new Set(old.filter((s) => s.state === "done" && !s.sub?.length).map((s) => key(s.text)));
  const plan = steps
    .map(readStep)
    .filter((s): s is Read => !!s)
    .slice(0, MAX_STEPS)
    .map((r): PlanStep => {
      const k = key(r.text);
      const user = r.user || asked.has(k);
      const sub = r.sub?.map((x): PlanStep => {
        const sk = key(x.text);
        return { text: x.text, ...stateOf(x, finished.has(sk) || doneBare.has(k), skipped.get(sk)), ...(x.user || asked.has(sk) ? { user: true } : {}) };
      });
      const own = stateOf(r, finished.has(k), skipped.get(k));
      // a split step is done once each smaller step is done or skipped for a reason
      const closed = !!sub?.length && sub.every((x) => x.state === "done" || x.state === "skip") && sub.some((x) => x.state === "done");
      const state = r.skip || r.done || !sub?.length ? own : closed ? { state: "done" as const } : own.state === "skip" ? own : { state: "todo" as const };
      return { text: r.text, ...state, ...(user ? { user: true } : {}), ...(sub?.length ? { sub } : {}) };
    });
  const kept = new Set(plan.flatMap((s) => [s, ...(s.sub ?? [])]).map((s) => key(s.text)));
  const dropped = old.filter((s) => s.user && s.state !== "done" && s.state !== "skip" && !kept.has(key(s.text))).map((s): PlanStep => ({ text: s.text, state: "todo", user: true }));
  return focus([...plan, ...dropped]);
}

/** The step a "now" block names: 2, [2, 1] or "2.1" (big step, then its smaller one). */
export function stepAt(step: unknown): [number, number | undefined] | undefined {
  const parts = Array.isArray(step) ? step : typeof step === "string" ? step.split(".") : typeof step === "number" ? [step] : [];
  const [i, j] = parts.map((p) => Number(p));
  if (!Number.isInteger(i) || i < 0) return undefined;
  return [i, Number.isInteger(j) && j! >= 0 ? j : undefined];
}

/**
 * The job says which step it is on: the step it was on before is done, it is now, the
 * ones after it are still to do. A big step it jumps over without ever being on it is
 * skipped, with no reason yet (done asks for one, or for a plan that marks it done).
 * Inside a step its smaller steps count as done; named without one, the smaller steps it
 * finished stay finished.
 */
export function moveTo(plan: PlanStep[], step: unknown): boolean {
  const at = stepAt(step);
  if (!at || !plan.length) return false;
  const i = Math.min(at[0], plan.length - 1);
  const j = at[1];
  plan.forEach((s, k) => {
    if (k < i) {
      if (s.state === "todo") s.state = "skip";
      else if (s.state !== "skip") s.state = "done";
      for (const x of s.sub ?? []) if (x.state !== "skip" && x.state !== "done") x.state = s.state;
    } else if (k > i) {
      s.state = "todo";
      for (const x of s.sub ?? []) if (x.state === "now") x.state = "todo";
    } else {
      s.state = "now";
      const sub = s.sub ?? [];
      if (j === undefined) {
        let inner = false;
        for (const x of sub) {
          if (x.state === "done" || x.state === "skip") continue;
          x.state = inner ? "todo" : "now";
          inner = true;
        }
      } else {
        const jj = Math.min(j, sub.length - 1);
        sub.forEach((x, n) => (x.state = n < jj ? (x.state === "skip" ? "skip" : "done") : n === jj ? "now" : x.state === "done" ? "done" : "todo"));
      }
    }
  });
  return true;
}

/** A finished job's plan: the step it was on is done, steps it never reached are skipped (not left open). */
export function closePlan(plan: PlanStep[]): PlanStep[] {
  const close = (s: PlanStep): PlanStep => ({ ...s, state: s.state === "now" ? "done" : s.state === "todo" ? "skip" : s.state });
  return plan.map((s) => (s.sub ? { ...close(s), sub: s.sub.map(close) } : close(s)));
}

/**
 * Big steps a job is ending with, unexplained: jumped over or left open without being done,
 * and with no reason given. (Steps the user asked for are openAsked's; the one it is on now
 * is the one finishing.)
 */
export function unexplained(plan: PlanStep[]): string[] {
  return plan.filter((s) => !s.user && ((s.state === "skip" && !s.why) || s.state === "todo")).map((s) => s.text);
}

/** Steps the user asked for while the job worked that it never reached (big or small). */
export function openAsked(plan: PlanStep[]): string[] {
  return plan.flatMap((s) => [
    ...(s.user && s.state === "todo" && !s.sub?.some((x) => x.state === "done") ? [s.text] : []),
    ...(s.sub ?? []).filter((x) => x.user && x.state === "todo").map((x) => `${s.text} › ${x.text}`),
  ]);
}

const MARK = { done: "[x]", now: "[>]", todo: "[ ]", skip: "[-]" } as const;

/** The plan as lines for the model: "[x] text", its smaller steps indented under it. */
export function planText(plan: PlanStep[], width = 160): string[] {
  const cut = (s: string) => (s.length > width ? `${s.slice(0, width)}…` : s);
  const tag = (s: PlanStep) => `${s.user ? " (user asked)" : ""}${s.state === "skip" && s.why ? ` (skipped: ${s.why})` : ""}`;
  return plan.flatMap((s) => [`${MARK[s.state]} ${cut(s.text)}${tag(s)}`, ...(s.sub ?? []).map((x) => `    ${MARK[x.state]} ${cut(x.text)}${tag(x)}`)]);
}
