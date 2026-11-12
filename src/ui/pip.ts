// Which job's browser floats in the corner, and which corner: kept apart from the view so it can be tested.
import type { Task } from "../state/types";

export type Corner = "tl" | "tr" | "bl" | "br";
export const CORNERS: Corner[] = ["tl", "tr", "bl", "br"];

/** when the job last did something in its browser (a running job that opened one but hasn't yet: when it started) */
const lastBrowse = (t: Task) => {
  for (let i = t.entries.length - 1; i >= 0; i--) {
    const e = t.entries[i];
    if (e.kind === "tool" && e.tool.kind === "browser") return e.at;
  }
  return t.startedAt ?? t.createdAt;
};

/** The running job whose browser to show: the one that browsed last, leaving out the ones closed here. */
export function pipJob(tasks: Task[], closed: ReadonlySet<string>): Task | undefined {
  let best: Task | undefined;
  for (const t of tasks) {
    if (!t.browser || t.status !== "running" || closed.has(t.id)) continue;
    if (!best || lastBrowse(t) > lastBrowse(best)) best = t;
  }
  return best;
}

/** the corner nearest to where the window was let go (its centre, in a w×h window) */
export function nearestCorner(x: number, y: number, w: number, h: number): Corner {
  return `${y < h / 2 ? "t" : "b"}${x < w / 2 ? "l" : "r"}` as Corner;
}

/** a stored corner, or the default (bottom right, where macOS puts its own picture-in-picture) */
export const cornerOf = (v: unknown): Corner => (CORNERS.includes(v as Corner) ? (v as Corner) : "br");
