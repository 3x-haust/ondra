// When a job's session is told to hand off to a fresh one. Every call re-sends
// the whole context, so a very full session costs the most and thinks worst;
// but each new session re-reads and re-plans, so handing off early wastes more.
// The line is a share of the model's own context window, not a fixed size.

/** Context windows by model id, for when the engine hasn't reported one yet. */
const KNOWN: [RegExp, number][] = [
  [/\[1m\]|-1m\b|gemini/i, 1_000_000],
  [/gpt-5|gpt-6|codex/i, 272_000],
  [/claude|opus|sonnet|haiku|fable/i, 200_000],
];
const DEFAULT_WINDOW = 200_000;

export function windowFor(model?: string): number {
  return KNOWN.find(([re]) => re.test(model ?? ""))?.[1] ?? DEFAULT_WINDOW;
}

/** The first point (~50%) asks for a handoff at the next clean stop; the second (~65%) asks for it now.
 *  Past the middle of the window every call costs the most and the model loses track of the start. */
export const HANDOFF_SHARE = [0.5, 0.65] as const;
// a small window still gets room to work before the first nudge
const FLOOR = 100_000;

/** Prompt sizes (tokens) at which a session is nudged to hand off, from the window the engine reports or the model id. */
export function handoffAt(window?: number, model?: string): [number, number] {
  const w = window && window > 0 ? window : windowFor(model);
  const first = Math.max(Math.round(w * HANDOFF_SHARE[0]), Math.min(FLOOR, Math.round(w * HANDOFF_SHARE[1])));
  const second = Math.max(Math.round(w * HANDOFF_SHARE[1]), first + Math.round(w * 0.05));
  return [first, Math.min(second, Math.round(w * 0.9))];
}

/** What the job is told at each point. It never tells it to stop working. */
export function handoffSteer(level: number, prompt: number, window: number): string {
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const at = `(Ondra) This session's context is at ${k(prompt)} of ${k(window)} tokens.`;
  return level === 0
    ? `${at} Keep working. At the next point where nothing is half-done, send a {"type":"handoff"} block (did, found, next, doneWhen, evidence) so a fresh session continues; if only the wrap-up is left by then, send done instead.`
    : `${at} It is nearly full: send the {"type":"handoff"} block now (or done if only the wrap-up is left).`;
}
