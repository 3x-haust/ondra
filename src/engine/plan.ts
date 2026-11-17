// A job's to-do list: big steps in the order they are done, each with the smaller
// steps it is split into once it is reached. The order is the order of the work: a
// request that comes in while the job works is put where it belongs by what depends
// on what (a survey that ships with the deploy is built before the deploy), and
// steps the user asked for that way carry `user` so they aren't dropped silently.
import type { PlanStep } from "../state/types";

export const MAX_STEPS = 10;
export const MAX_SUB = 8;

const key = (s: string) => s.replace(/[\s·.,()]/g, "").toLowerCase();

type Read = { text: string; user?: boolean; sub?: { text: string; user?: boolean }[] };

const textOf = (x: unknown): string =>
  typeof x === "string" ? x.trim() : x && typeof x === "object" ? String((x as Record<string, unknown>).text ?? "").trim() : "";
const userOf = (x: unknown) => !!x && typeof x === "object" && (x as Record<string, unknown>).user === true;

/** One step as the model sent it: "text", or {"text", "sub": [...], "user": true}. */
function readStep(x: unknown): Read | undefined {
  const text = textOf(x);
  if (!text) return undefined;
  const raw = x && typeof x === "object" ? (x as Record<string, unknown>).sub : undefined;
  const sub = Array.isArray(raw)
    ? raw
        .map((s) => ({ text: textOf(s), ...(userOf(s) ? { user: true } : {}) }))
        .filter((s) => s.text)
        .slice(0, MAX_SUB)
    : [];
  return { text, ...(userOf(x) ? { user: true } : {}), ...(sub.length ? { sub } : {}) };
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

/**
 * A new plan keeps what was already finished (same text, big or small) as done and
 * who asked for a step; the first open one is current.
 */
export function nextPlan(old: PlanStep[], steps: unknown[]): PlanStep[] {
  const all = old.flatMap((s) => [s, ...(s.sub ?? [])]);
  const finished = new Set(all.filter((s) => s.state === "done").map((s) => key(s.text)));
  const asked = new Set(all.filter((s) => s.user).map((s) => key(s.text)));
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
        return { text: x.text, state: finished.has(sk) || doneBare.has(k) ? "done" : "todo", ...(x.user || asked.has(sk) ? { user: true } : {}) };
      });
      const state = sub?.length ? (sub.every((x) => x.state === "done") ? "done" : "todo") : finished.has(k) ? "done" : "todo";
      return { text: r.text, state, ...(user ? { user: true } : {}), ...(sub?.length ? { sub } : {}) };
    });
  return focus(plan);
}

/** The step a "now" block names: 2, [2, 1] or "2.1" (big step, then its smaller one). */
export function stepAt(step: unknown): [number, number | undefined] | undefined {
  const parts = Array.isArray(step) ? step : typeof step === "string" ? step.split(".") : typeof step === "number" ? [step] : [];
  const [i, j] = parts.map((p) => Number(p));
  if (!Number.isInteger(i) || i < 0) return undefined;
  return [i, Number.isInteger(j) && j! >= 0 ? j : undefined];
}

/**
 * The job says which step it is on: the steps before it are done, it is now, the
 * ones after it are still to do. Inside it the same goes for its smaller steps;
 * named without one, the smaller steps it finished stay finished.
 */
export function moveTo(plan: PlanStep[], step: unknown): boolean {
  const at = stepAt(step);
  if (!at || !plan.length) return false;
  const i = Math.min(at[0], plan.length - 1);
  const j = at[1];
  plan.forEach((s, k) => {
    if (k < i) {
      if (s.state !== "skip") s.state = "done";
      for (const x of s.sub ?? []) if (x.state !== "skip") x.state = "done";
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
  const tag = (s: PlanStep) => (s.user ? " (user asked)" : "");
  return plan.flatMap((s) => [`${MARK[s.state]} ${cut(s.text)}${tag(s)}`, ...(s.sub ?? []).map((x) => `    ${MARK[x.state]} ${cut(x.text)}${tag(x)}`)]);
}
