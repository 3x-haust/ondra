// Memory on the way. A job is given the pieces that fit its ask when it starts; the work then
// moves on to steps, apps, devices, sites and programs the ask never named ("이 버그 고쳐" that
// ends up on a Windows PC). What the user keeps about those reaches the job when it turns to
// them, once, instead of only when the job thinks to search.
import { homeDir } from "../state/store";
import type { Memory, Task } from "../state/types";
import { programsOf } from "./commandKind";
import { core, recall, siteWords } from "./memory";
import { aboutOtherProject, memoriesFor } from "./prompts";

/** pieces sent on the way to one job, at most */
export const RECALL_CAP = 12;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? [v.trim()] : []);
/** "com.microsoft.rdc.macos" names nothing a person says; "Windows App" does */
const named = (v: string) => (/^[a-z]{2,}(\.[\w-]+){2,}$/i.test(v) ? [] : [v]);

/** What a step works on, as names to recall by: the app or device, the site, the programs it runs. */
export function stepThings(name: string, args: any): string[] {
  const out: string[] = [];
  switch (name) {
    case "computer":
      out.push(...str(args?.app).flatMap(named));
      break;
    case "device":
      out.push(...[args?.app, args?.device, args?.model].flatMap(str).flatMap(named));
      if (args?.action === "start") out.push(args?.platform === "android" ? "Android" : "iOS");
      break;
    case "web_fetch":
      out.push(...siteWords(String(args?.url ?? "")));
      break;
    case "bash": {
      const cmd = String(args?.command ?? "");
      out.push(...siteWords(cmd), ...programsOf(cmd));
      break;
    }
  }
  return [...new Set(out)];
}

/** Ids of the pieces this job already has: given at the start, always on, or sent on the way. */
export function given(t: Task, list: Memory[]): Set<string> {
  const ids = new Set(t.recalled ?? []);
  for (const l of t.memorySnapshot ?? []) for (const m of l.matchAll(/\[([^\]\s]+)\]/g)) ids.add(m[1]);
  for (const m of core(list)) ids.add(m.id);
  return ids;
}

/**
 * The pieces clearly about what the job turned to that it doesn't have yet. `names`: the query is
 * only names (an app, a program), so one rare shared word is enough; a step's sentence needs two
 * (or a close meaning), as at the start.
 */
export function recallNow(t: Task, query: string, names: boolean): Memory[] {
  const left = RECALL_CAP - (t.recalled?.length ?? 0);
  if (left <= 0 || !query.trim()) return [];
  const pool = memoriesFor(t.space, homeDir(t), t.reach);
  const have = given(t, pool);
  const fresh = pool.filter((m) => !have.has(m.id) && !aboutOtherProject(m, t));
  return recall(fresh, query, { max: Math.min(3, left), budget: 700, strict: true, about: query, need: names ? 1 : 2 });
}
