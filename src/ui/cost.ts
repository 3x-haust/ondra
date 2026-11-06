// What a finished job took: its working time and the tokens it (and its sub-jobs) used.
import { state } from "../state/store";
import type { Task } from "../state/types";
import { long, tokens } from "./bits";

export interface JobCost {
  /** from its (last) start to its end; the turns' own times when that's unknown */
  ms: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** how many sub-jobs are counted in */
  kids: number;
}

export function jobCost(t: Task): JobCost {
  const c: JobCost = { ms: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, kids: 0 };
  const add = (x: Task, own: boolean) => {
    for (const e of x.entries) {
      if (e.kind !== "turn") continue;
      if (own) c.ms += e.usage?.ms || e.ms || 0;
      if (!e.usage) continue;
      c.input += e.usage.input;
      c.output += e.usage.output;
      c.cacheRead += e.usage.cacheRead;
      c.cacheWrite += e.usage.cacheWrite;
    }
    for (const k of state.tasks.filter((k) => k.parentId === x.id)) {
      c.kids++;
      add(k, false);
    }
  };
  add(t, true);
  if (t.startedAt && t.finishedAt && t.finishedAt > t.startedAt) c.ms = Math.max(c.ms, t.finishedAt - t.startedAt);
  c.total = c.input + c.output + c.cacheRead + c.cacheWrite;
  return c;
}

/** "12분 · 토큰 1.2M" */
export const costShort = (c: JobCost) => [c.ms ? long(c.ms) : "", c.total ? `토큰 ${tokens(c.total)}` : ""].filter(Boolean).join(" · ");

/** the breakdown, for a hover or the end of a job's chat */
export const costDetail = (c: JobCost) =>
  [
    c.ms ? `${long(c.ms)} 걸림` : "",
    c.total ? `토큰 ${tokens(c.total)} (새 입력 ${tokens(c.input + c.cacheWrite)} · 캐시 ${tokens(c.cacheRead)} · 출력 ${tokens(c.output)})` : "",
    c.kids ? `서브 ${c.kids}개 포함` : "",
  ]
    .filter(Boolean)
    .join(" · ");
