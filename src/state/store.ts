// The one app store, saved to disk (debounced). Live-only data (streaming
// text, which panel is open) lives in `ui.ts`, not here.
import { linkedProjects, mirroredDecisions, mirroredTasks } from "./mirror";
import { flushLog } from "../lib/log";
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap, type SetStoreFunction } from "solid-js/store";
import { bindingSource } from "../lib/shortcuts";
import { inTauri, onEvent, stateFlushed, stateLoad, stateSaveParts } from "../lib/native";
import { fixture } from "./fixture";
import { debounce, Saver, unpackTask } from "./persist";
import type { Account, AppState, Decision, SpaceId, Task } from "./types";

/**
 * ↑ history per space. It used to be one list for every space: each old line goes
 * to the space it was said in (found in the main chats, jobs, btws and side chats),
 * and a line found nowhere is dropped rather than shown in the wrong space.
 */
function sentBySpace(p: AppState): Record<string, string[]> {
  const old = p.sent as unknown;
  if (!Array.isArray(old)) return (old as Record<string, string[]>) ?? {};
  const where = new Map<string, SpaceId>();
  const put = (text: string | undefined, space: SpaceId | undefined) => {
    const v = text?.trim();
    if (v && space && !where.has(v)) where.set(v, space);
  };
  for (const m of p.captain ?? []) if (m.from === "me") put(m.text, m.space);
  for (const t of p.tasks ?? []) {
    put(t.ask, t.space);
    for (const e of t.entries) if (e.kind === "user") put(e.text, t.space);
  }
  for (const m of p.side ?? []) if (m.from === "me") put(m.text, m.space);
  for (const b of p.btws ?? []) {
    const [kind, id = ""] = b.scope.split(/:(.*)/s);
    const sp = kind === "task" ? p.tasks.find((t) => t.id === id)?.space : (id.split("~")[0] as SpaceId);
    put(b.question, sp);
    put(`/btw ${b.question}`, sp);
  }
  const out: Record<string, string[]> = {};
  for (const line of old as string[]) {
    const sp = where.get(line.trim());
    if (sp) (out[sp] ??= []).push(line);
  }
  return out;
}

export const freshState = (): AppState => ({
  version: 3,
  onboarded: false,
  space: "home",
  spaces: [{ id: "home", label: "개인", folder: "~", rules: "" }],
  accounts: [
    {
      id: "default",
      space: "home",
      label: "기본",
      providers: [],
      model: "",
      badModels: [],
      stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
  tasks: [],
  decisions: [],
  captain: [],
  memory: [],
  skills: [],
  side: [],
  projects: [],
  canvas: {},
  settings: { slots: { light: 3, heavy: 1 }, captainModel: "", theme: "system", instructions: "", learn: true, isolate: true, focusGuard: true, forkModel: "", forkThinking: "", permission: "edits", watchPullRequests: false },
});

const [state, writeState] = createStore<AppState>(freshState());
const saver = new Saver();
const saveSoon = debounce(() => void save());
/** Every write to the store goes through here: it notes what changed and saves a moment later. */
const writes: ((args: readonly unknown[]) => void)[] = [];
/** hear every store write (its setState arguments), before it happens: for passing changes on */
export const onWrite = (fn: (args: readonly unknown[]) => void) => void writes.push(fn);
const setState = ((...args: unknown[]) => {
  saver.mark(args, unwrap(state));
  for (const f of writes) f(args);
  saveSoon.poke();
  return (writeState as (...a: unknown[]) => void)(...args);
}) as SetStoreFunction<AppState>;
export { state, setState };
bindingSource(() => state.settings.keybindings);

export const [loaded, setLoaded] = createSignal(false);

let saving: Promise<void> = Promise.resolve();
/** Serialize what changed (off the reactive path) and hand it to the native side, one save at a time. */
function save(): Promise<void> {
  if (!loaded()) {
    saveSoon.poke();
    return saving;
  }
  saving = saving.then(async () => {
    const parts = saver.build(unwrap(state));
    if (!inTauri) return saver.sentAll(parts.order);
    try {
      let missing = await stateSaveParts(parts.head, parts.order, parts.tasks);
      if (missing.length) {
        // the native side started fresh (or dropped some): send those too
        const more = Object.fromEntries(missing.map((k) => [k, saver.text(k) ?? "null"]));
        missing = await stateSaveParts(parts.head, parts.order, more);
      }
      if (missing.length) throw new Error(`state save: ${missing.length} tasks missing`);
      saver.sentAll(parts.order);
    } catch (e) {
      saver.reset();
      saveSoon.poke();
      console.error("state not saved", e);
    }
  });
  return saving;
}
/** The app is quitting (or restarting into an update): engines that end now were stopped by that, not failed. */
let quitting = false;
export const appQuitting = () => quitting;
export const setQuitting = (on: boolean) => void (quitting = on);
/** Save now whatever waits (before quitting or restarting into an update). */
export async function flushState() {
  saveSoon.flush();
  await saving;
}

export async function loadState() {
  // quitting: the app waits (a moment at most) for the last save
  void onEvent("state:flush", () => ((quitting = true), flushLog(), void flushState().finally(() => void stateFlushed())));
  if (!inTauri && location.search.includes("fixture")) {
    setState(reconcile(fixture(freshState())));
    const { setCtx } = await import("./ctx");
    // the window the engine reports for the fixture's model (GPT-5.6 Terra: 272K), the same the context sheet shows
    const W = 272_000;
    setCtx("captain:work", { tokens: 31_200, window: W, percent: (31_200 / W) * 100 });
    for (const t of state.tasks) setCtx(`t:${t.id}`, { tokens: 18_000 + t.entries.length * 2_900, window: W, percent: ((18_000 + t.entries.length * 2_900) / W) * 100 });
    setLoaded(true);
    return;
  }
  const text = await stateLoad();
  if (text) {
    try {
      const parsed = JSON.parse(text) as AppState;
      if (parsed.version === 3) {
        const base = freshState();
        setState(
          reconcile({
            ...base,
            ...parsed,
            tasks: (parsed.tasks ?? []).map(unpackTask),
            settings: { ...base.settings, ...parsed.settings },
            accounts: parsed.accounts.map((a) => ({ ...base.accounts[0], ...a, badModels: a.badModels ?? [] })),
            // the request queue lives in memory: a reply still "thinking" when the app closed never comes back
            captain: (parsed.captain ?? []).map((m) => (m.pending ? { ...m, pending: false, error: "앱이 닫혀 응답이 끊겼어요" } : m)),
            btws: (parsed.btws ?? []).map((b) => (b.pending ? { ...b, pending: false, error: b.answer ? undefined : "앱이 닫혀 응답이 끊겼어요" } : b)),
            side: (parsed.side ?? []).map((m) => (m.pending ? { ...m, pending: false, error: "앱이 닫혀 응답이 끊겼어요" } : m)),
            sent: sentBySpace(parsed),
          }),
        );
      }
    } catch (e) {
      console.error("state.json unreadable, starting fresh", e);
    }
  }
  setLoaded(true);
}

/** Every task carries the project `taskProject` finds, so each place that reads `task.project` agrees. */
export function fileTasks() {
  // one write for all of them: the lists redraw once, not once per task
  const moves = new Map<string, string | undefined>();
  for (const t of state.tasks) {
    const p = taskProject(t);
    if (p !== t.project && (p || !t.project)) moves.set(t.id, p);
  }
  if (moves.size) setState("tasks", (x) => moves.has(x.id), produce((x: Task) => void (x.project = moves.get(x.id))));
}

createRoot(() => {
  // re-file when a project is added or a task gets its worktree
  createEffect(() => {
    if (!loaded()) return;
    for (const t of state.tasks) void (t.project, t.cwd, t.worktree?.repo, t.worktree?.sub);
    void (state.projects ?? []).map((p) => p.folder);
    queueMicrotask(fileTasks);
  });
});

/** Tasks by id and each task's subagents, kept up to date as tasks come and go (not on every streamed line). */
const index = createRoot(() =>
  createMemo(() => {
    const byId = new Map<string, Task>();
    const kids = new Map<string, Task[]>();
    for (const t of [...state.tasks, ...mirroredTasks()]) {
      if (!byId.has(t.id)) byId.set(t.id, t);
      const p = t.parentId;
      if (p) {
        const l = kids.get(p);
        if (l) l.push(t);
        else kids.set(p, [t]);
      }
    }
    return { byId, kids };
  }),
);
const none: Task[] = [];

// ── reads ──
export const spaceById = (id: SpaceId) => state.spaces.find((s) => s.id === id)!;
export const tasksIn = (space: SpaceId) => state.tasks.filter((t) => t.space === space);
export const projectsIn = (space: SpaceId) => (state.projects ?? []).filter((p) => p.space === space);
/** A project by id; with `space`, only that space's (ids are unique, but older state may share one). */
export const projectById = (id?: string, space?: SpaceId) =>
  id ? ((state.projects ?? []).find((p) => p.id === id && (!space || p.space === space)) ?? (id.startsWith("r:") ? remoteProjects().find((p) => p.id === id && (!space || p.space === space)) : undefined)) : undefined;
/** projects added from other Macs (Settings › 연결) */
const remoteProjects = createRoot(() => createMemo(() => linkedProjects(state.settings.hostProjects, (h) => state.settings.hosts?.find((x) => x.id === h)?.name ?? "Mac")));
/** what the sidebar lists: this Mac's projects and those added from other Macs */
export const projectsShown = (space: SpaceId) => [...projectsIn(space), ...remoteProjects().filter((p) => p.space === space)];
/** this Mac's jobs and the other Macs' jobs shown here */
export const tasksShown = (space: SpaceId) => [...tasksIn(space), ...mirroredTasks().filter((t) => t.space === space)];
/** every job shown here, any space: this Mac's and the other Macs' */
export const allTasks = (): Task[] => [...state.tasks, ...mirroredTasks()];
/** the jobs in line on the Mac this one runs on, next first (another Mac's: those of its shown here) */
export const queueWith = (t: Task): Task[] =>
  (t.host ? mirroredTasks().filter((x) => x.host === t.host) : state.tasks).filter((x) => x.status === "queued" && !x.parentId).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
/** every question waiting on the user: this Mac's and those of the other Macs' jobs */
export const allDecisions = (): Decision[] => [...state.decisions, ...mirroredDecisions()];
/** compare folders in "~/…" form (macOS home) */
const norm = (d: string) => d.replace(/^\/Users\/[^/]+(?=\/|$)/, "~").replace(/\/+$/, "");
/** the project whose folder holds this folder (deepest wins) */
export function projectFor(space: SpaceId, cwd?: string): string | undefined {
  if (!cwd) return undefined;
  const dir = norm(cwd);
  return projectsIn(space)
    .filter((p) => dir === norm(p.folder) || dir.startsWith(`${norm(p.folder)}/`))
    .sort((a, b) => b.folder.length - a.folder.length)[0]?.id;
}
/**
 * The project a task belongs to, one rule for the sidebar, board, canvas, Results and the overview:
 * its worktree's repo when that is a known project, else the project it was started in, else the
 * project holding its folder. None of these: no project (기타).
 */
export function taskProject(t: Task): string | undefined {
  // another Mac's job: that Mac filed it (its folders aren't this Mac's)
  if (t.host) return t.project;
  const known = (id?: string) => (id && projectsIn(t.space).some((p) => p.id === id) ? id : undefined);
  return (t.worktree?.repo ? projectFor(t.space, homeDir(t)) : undefined) ?? known(t.project) ?? projectFor(t.space, t.cwd);
}
/** A project is the repo, never one of its worktree folders (…/worktrees/<repo>/<job> → …/projects/<repo>). */
export function repoHome(folder: string): string {
  const wt = folder.replace(/\/$/, "").match(/^(.*)\/worktrees\/([^/]+)(?:\/|$)/);
  return wt ? `${wt[1]}/projects/${wt[2]}` : folder;
}
const gone = (folder: string) => (state.goneProjects ?? []).some((f) => norm(f) === norm(folder));
/** Folders jobs already worked in (their repos) become projects, once. */
export function seedProjects() {
  for (const t of state.tasks) {
    if (t.parentId || t.answer || !t.worktree?.repo || t.project) continue;
    if (gone(repoHome(t.worktree.repo))) continue;
    const id = addProject(t.space, t.worktree.repo);
    if (!t.project) setState("tasks", (x) => x.id === t.id, "project", id);
  }
}
/** Add a folder as a project (or return the one already there). */
export function addProject(space: SpaceId, folder: string, name?: string): string {
  folder = repoHome(folder);
  if (gone(folder)) setState("goneProjects", (l) => (l ?? []).filter((f) => norm(f) !== norm(folder)));
  const have = projectsIn(space).find((p) => norm(p.folder) === norm(folder));
  if (have) return have.id;
  const id = (name || folder.split("/").filter(Boolean).pop() || "project").toLowerCase().replace(/[^a-z0-9가-힣._-]+/g, "-").slice(0, 32) || uid("p");
  // unique across every space: the same folder name in both spaces gets two ids
  const unique = (state.projects ?? []).some((p) => p.id === id) ? `${id}-${uid("").slice(-4)}` : id;
  setState("projects", (l) => [...(l ?? []), { id: unique, space, name: name || folder.split("/").filter(Boolean).pop() || unique, folder }]);
  // jobs already in that folder join it
  fileTasks();
  return unique;
}
/** A project's shown name (its id and folder stay). */
export function renameProject(id: string, name: string) {
  const n = name.trim().slice(0, 40);
  if (n) setState("projects", (p) => p.id === id, "name", n);
}
/** Delete a project: its jobs stay (under "그 밖의 일"), its chat goes; the folder itself is untouched. */
export function removeProject(id: string) {
  const p = (state.projects ?? []).find((x) => x.id === id);
  if (!p) return;
  setState("projects", (l) => (l ?? []).filter((x) => x.id !== id));
  setState("goneProjects", (l) => [...(l ?? []).filter((f) => norm(f) !== norm(p.folder)), p.folder]);
  setState("tasks", (t) => t.project === id && t.space === p.space, "project", undefined);
  setState("captain", (l) => l.filter((m) => !(m.space === p.space && m.project === id)));
}
export const taskById = (id: string) => index().byId.get(id);
/** a task's subagents, in the order they were made (the tasks list's order) */
export const kidsOf = (id: string): Task[] => index().kids.get(id) ?? none;

/** a job of the list: not a subagent, a quick answer or archived */
export const listed = (t: Task) => !t.parentId && !t.answer && !t.archived;
/** the job a follow-up carries on (one started by answering it, say "merge it"), when that one is in
 *  the same list: the follow-up is part of its line, shown under it and named by it */
export function carriedOn(t: Task): Task | undefined {
  const p = t.follows ? taskById(t.follows) : undefined;
  return p && p.id !== t.id && listed(p) && p.space === t.space && p.project === t.project ? p : undefined;
}
/** the first job of a follow-up's line (the job itself when it follows none) */
export function lineHead(t: Task): Task {
  let x = t;
  for (let i = 0; carriedOn(x) && i < 50; i++) x = carriedOn(x)!;
  return x;
}
export const accountById = (id: string) => state.accounts.find((a) => a.id === id);
export const accountsIn = (space: SpaceId) => state.accounts.filter((a) => a.space === space);
export const decisionsIn = (space: SpaceId) => allDecisions().filter((d) => taskById(d.taskId)?.space === space);
export const decisionFor = (taskId: string) => state.decisions.find((d) => d.taskId === taskId) ?? mirroredDecisions().find((d) => d.taskId === taskId);

const rank = (t: Task) => ({ waiting: 0, running: 1, failed: 2, paused: 3, queued: 4, done: 5 })[t.status];

/** Tasks for the sidebar, grouped by topic, most urgent group first. */
export function topicsIn(space: SpaceId): { topic: string; tasks: Task[] }[] {
  const map = new Map<string, Task[]>();
  const order = tasksIn(space)
    .filter((t) => t.status !== "queued")
    .sort((a, b) => rank(a) - rank(b) || (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
  for (const t of order) map.set(t.topic, [...(map.get(t.topic) ?? []), t]);
  return [...map].map(([topic, tasks]) => ({ topic, tasks }));
}

export function cacheShare(a: Account): number | null {
  const total = a.stats.input + a.stats.cacheRead + a.stats.cacheWrite;
  return total > 0 ? a.stats.cacheRead / total : null;
}

// ── writes ──
export const setSpace = (space: SpaceId) => setState("space", space);
/** The folder the user meant (outside the task's own worktree). */
export function homeDir(t: Task): string {
  const w = t.worktree;
  return w ? (w.sub ? `${w.repo}/${w.sub}` : w.repo) : t.cwd;
}

export function updateTask(id: string, fn: (t: Task) => void) {
  setState("tasks", (t) => t.id === id, produce(fn));
}
export function updateAccount(id: string, fn: (a: Account) => void) {
  setState("accounts", (a) => a.id === id, produce(fn));
}

export const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
