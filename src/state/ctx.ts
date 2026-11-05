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
