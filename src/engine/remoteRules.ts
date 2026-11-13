// The rules of Settings › 연결, kept apart from the wiring so they can be tested:
//   - this Mac letting others in (engine/remote.ts): what a Mac allowed in may see and do here;
//   - this Mac working on others (engine/hosts.ts): what goes when one is removed, which of its
//     projects show here.
import type { Settings, Task } from "../state/types";

// ───────── a Mac allowed in

/** what one connected Mac may reach: the projects it keeps (asked with "watch") and the
 *  workspaces it may use here (missing = all) */
export interface Reach {
  device: string;
  watch: ReadonlySet<string>;
  spaces?: ReadonlySet<string>;
}

type ById = (id: string) => Task | undefined;

/** a job's top job (a subagent's parent, up the line) */
export function rootOf(t: Task, byId: ById): Task {
  let x: Task = t;
  for (let i = 0; x.parentId && i < 20; i++) x = byId(x.parentId) ?? x;
  return x;
}

export const spaceAllowed = (spaces: ReadonlySet<string> | undefined, space: string) => !spaces || spaces.has(space);

/**
 * A job that Mac may see and act on: one of this Mac's own (never one shown here from a third
 * Mac), in a workspace it may use, and in a project it keeps or asked for by it (subagents go
 * with their top job).
 */
export function mayReach(r: Reach, t: Task | undefined, byId: ById): boolean {
  if (!t || t.host) return false;
  const root = rootOf(t, byId);
  if (root.host || !spaceAllowed(r.spaces, root.space) || !spaceAllowed(r.spaces, t.space)) return false;
  return (!!root.project && r.watch.has(root.project)) || (!!r.device && root.from?.device === r.device);
}

/** the calls another Mac may make on one job: the job's id comes first */
export const JOB_CALLS = [
  "tell",
  "stopTask",
  "resumeTask",
  "startTask",
  "mergeTask",
  "discardTask",
  "closeWorktree",
  "archiveTask",
  "removeTask",
  "renameTask",
  "duplicateTask",
  "editTurn",
  "steerQueued",
  "dropQueued",
  "editQueued",
  "moveQueued",
  "setTaskModel",
  "setTaskPermission",
] as const;
export type JobCall = (typeof JOB_CALLS)[number];
const jobCalls = new Set<string>(JOB_CALLS);

/**
 * The arguments a job call goes ahead with, or why not (thrown). Only a job that Mac may reach;
 * a message is the user's (or that Mac's main chat's), never one passed off as a job's own agent.
 */
export function checkCall(r: Reach, fn: string, args: unknown[], byId: ById): unknown[] {
  if (!jobCalls.has(fn)) throw new Error(`unknown: ${fn}`);
  const id = args[0];
  if (typeof id !== "string" || !mayReach(r, byId(id), byId)) throw new Error("그 작업은 쓸 수 없어요");
  if (fn === "tell") {
    const o = (args[2] ?? {}) as { now?: unknown; shown?: unknown; by?: unknown };
    return [id, String(args[1] ?? ""), { now: o.now === true, ...(typeof o.shown === "string" ? { shown: o.shown } : {}), ...(o.by === "main" ? { by: "main" } : {}) }];
  }
  return args;
}

/** the jobs a Mac asked for here that are still in the list (top jobs, not archived) */
export const jobsFrom = (tasks: readonly Task[], device: string) => tasks.filter((t) => !t.parentId && !t.archived && t.from?.device === device);

// ───────── a Mac this one works on

type Hosts = Pick<Settings, "hosts" | "hostProjects" | "computers">;

/** the settings with that Mac gone: its entry, its projects here, and any run location on it */
export function withoutHost(s: Hosts, id: string): Required<Hosts> {
  return {
    hosts: (s.hosts ?? []).filter((h) => h.id !== id),
    hostProjects: (s.hostProjects ?? []).filter((p) => p.host !== id),
    computers: Object.fromEntries(Object.entries(s.computers ?? {}).filter(([, c]) => c.host !== id)),
  };
}

/**
 * Which of that Mac's projects to take off the list here (gone there, or hidden here) and which
 * to add (new there, not hidden, and with a workspace tab here to go in).
 */
export function linkPlan<P extends { id: string; space?: string }>(
  list: readonly P[],
  linked: readonly { id: string }[],
  hidden: readonly string[] | undefined,
  spaceFor: (label?: string) => string | undefined,
): { gone: string[]; add: P[] } {
  const off = new Set(hidden ?? []);
  const gone = linked.filter((l) => off.has(l.id) || !list.some((p) => p.id === l.id)).map((l) => l.id);
  const add = list.filter((p) => !off.has(p.id) && !linked.some((l) => l.id === p.id) && !!spaceFor(p.space));
  return { gone, add };
}

/** a removed Mac that hasn't heard it yet: tried again after this long (30s, doubling, at most 30 min) */
export const byeWait = (tries: number) => Math.min(30 * 60_000, 30_000 * 2 ** Math.min(tries, 6));
/** and given up on after this long: it is forgotten here either way */
export const BYE_GIVE_UP = 30 * 24 * 3600_000;
