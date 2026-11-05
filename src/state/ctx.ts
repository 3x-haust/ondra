// How full each agent's context window is, as the engine last reported it.
import { createStore } from "solid-js/store";

export interface Ctx {
  tokens: number;
  window: number;
  percent: number;
}
export const [ctx, setCtx] = createStore<Record<string, Ctx>>({});

export function noteCtx(agent: string, s: any) {
  const c = s?.contextUsage;
  if (!c) return;
  const window = Number(c.contextWindow ?? 0);
  const tokens = Number(c.tokens ?? 0);
  if (!window) return;
  setCtx(agent, { tokens, window, percent: Number(c.percent ?? (tokens / window) * 100) });
}

/**
 * Cache reuse per agent: of what was already sent (the previous call's prompt),
 * how much the next call read back from the cache. 100% = nothing sent before was
 * paid for again; new text never counts against it (unlike a per-call hit rate).
 */
export interface Reuse {
  reused: number;
  reusable: number;
  last: number;
}
// kept across restarts, so the status line shows it before the next answer
const KEY = "ondra.cacheReuse";
const saved = (): Record<string, Reuse> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};
export const [reuse, setReuse] = createStore<Record<string, Reuse>>(saved());
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const persist = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      // the 200 most recent agents are plenty
      const keep = Object.entries({ ...reuse }).slice(-200);
      localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(keep)));
    } catch {}
  }, 1000);
};

export function noteCall(agent: string, u: any) {
  const read = Number(u?.cacheRead ?? 0);
  const prompt = Number(u?.input ?? 0) + read + Number(u?.cacheWrite ?? 0);
  if (!prompt) return;
  const r = reuse[agent] ?? { reused: 0, reusable: 0, last: 0 };
  // a session's first call, or one after the history shrank (compaction, handoff),
  // can only reuse a shared prefix: count what it read
  const can = r.last && prompt >= r.last ? r.last : read;
  setReuse(agent, { reused: r.reused + Math.min(read, can), reusable: r.reusable + can, last: prompt });
  persist();
}

export const reusePct = (agent: string) => {
  const r = reuse[agent];
  return r && r.reusable ? (r.reused / r.reusable) * 100 : undefined;
};
