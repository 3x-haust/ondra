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

/** The running job whose browser to show, leaving out the ones closed here: the job open on screen
 *  when it is one of them (you went into it, so it is its browser you want to watch), else the one
 *  that browsed last. */
export function pipJob(tasks: Task[], closed: ReadonlySet<string>, viewing?: string): Task | undefined {
  const shows = (t: Task) => !!t.browser && t.status === "running" && !closed.has(t.id);
  const here = viewing ? tasks.find((t) => t.id === viewing) : undefined;
  if (here && shows(here)) return here;
  let best: Task | undefined;
  for (const t of tasks) {
    if (!shows(t)) continue;
    if (!best || lastBrowse(t) > lastBrowse(best)) best = t;
  }
  return best;
}

/** the corner nearest to where the window was let go (its centre, in a w×h window) */
export function nearestCorner(x: number, y: number, w: number, h: number): Corner {
  return `${y < h / 2 ? "t" : "b"}${x < w / 2 ? "l" : "r"}` as Corner;
}

/** the preview's width (its height follows the page, 16:10) */
export const PIP_W = 320;
/** room left clear: the title bar above, the composer below, the window's sides */
const EDGE = { top: 60, bottom: 104, side: 16 };

/** where its top-left sits in a corner of a w×h window */
export function cornerSpot(c: Corner, w: number, h: number, pw: number, ph: number): { x: number; y: number } {
  return {
    x: c.endsWith("l") ? EDGE.side : Math.max(EDGE.side, w - EDGE.side - pw),
    y: c.startsWith("t") ? EDGE.top : Math.max(EDGE.top, h - EDGE.bottom - ph),
  };
}

/** Where a thrown preview would come to rest: its centre carried on by its speed (px/ms) as if
 *  slowing down at a steady rate, so a flick crosses the window and a slow let-go stays near. */
export function projectRelease(at: { x: number; y: number }, v: { x: number; y: number }): { x: number; y: number } {
  const carry = 180; // ms of travel a release is worth
  return { x: at.x + v.x * carry, y: at.y + v.y * carry };
}

/** a stored corner, or the default (bottom right, where macOS puts its own picture-in-picture) */
export const cornerOf = (v: unknown): Corner => (CORNERS.includes(v as Corner) ? (v as Corner) : "br");
