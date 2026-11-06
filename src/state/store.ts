// The one app store, saved to disk (debounced). Live-only data (streaming
// text, which panel is open) lives in `ui.ts`, not here.
import { createEffect, createRoot, createSignal } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { inTauri, stateLoad, stateSave } from "../lib/native";
import { fixture } from "./fixture";
import type { Account, AppState, SpaceId, Task } from "./types";

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
  settings: { slots: { light: 3, heavy: 1 }, captainModel: "", theme: "system", instructions: "", learn: true, isolate: true, forkModel: "", forkThinking: "", permission: "edits", watchPrs: true },
});

const [state, setState] = createStore<AppState>(freshState());
export { state, setState };

export const [loaded, setLoaded] = createSignal(false);

export async function loadState() {
  if (!inTauri && location.search.includes("fixture")) {
    setState(reconcile(fixture(freshState())));
    for (const t of state.tasks) if (!t.project) setState("tasks", (x) => x.id === t.id, "project", projectFor(t.space, t.cwd));
    const { setCtx } = await import("./ctx");
    setCtx("captain:work", { tokens: 31_200, window: 400_000, percent: 7.8 });
    for (const t of state.tasks) setCtx(`t:${t.id}`, { tokens: 18_000 + t.entries.length * 2_900, window: 400_000, percent: ((18_000 + t.entries.length * 2_900) / 400_000) * 100 });
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
            settings: { ...base.settings, ...parsed.settings },
            accounts: parsed.accounts.map((a) => ({ ...base.accounts[0], ...a, badModels: a.badModels ?? [] })),
            // the request queue lives in memory: a reply still "thinking" when the app closed never comes back
            captain: (parsed.captain ?? []).map((m) => (m.pending ? { ...m, pending: false, error: "앱이 닫혀서 답이 끊겼어요" } : m)),
            btws: (parsed.btws ?? []).map((b) => (b.pending ? { ...b, pending: false, error: b.answer ? undefined : "앱이 닫혀서 답이 끊겼어요" } : b)),
            side: (parsed.side ?? []).map((m) => (m.pending ? { ...m, pending: false, error: "앱이 닫혀서 답이 끊겼어요" } : m)),
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

createRoot(() => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const json = JSON.stringify(state);
    if (!loaded()) return;
    clearTimeout(timer);
    timer = setTimeout(() => stateSave(json), 500);
  });
});

// ── reads ──
export const spaceById = (id: SpaceId) => state.spaces.find((s) => s.id === id)!;
export const tasksIn = (space: SpaceId) => state.tasks.filter((t) => t.space === space);
export const projectsIn = (space: SpaceId) => (state.projects ?? []).filter((p) => p.space === space);
/** A project by id; with `space`, only that space's (ids are unique, but older state may share one). */
export const projectById = (id?: string, space?: SpaceId) =>
  id ? (state.projects ?? []).find((p) => p.id === id && (!space || p.space === space)) : undefined;
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
  for (const t of state.tasks) if (t.space === space && !t.project && projectFor(space, t.cwd) === unique) setState("tasks", (x) => x.id === t.id, "project", unique);
  return unique;
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
export const taskById = (id: string) => state.tasks.find((t) => t.id === id);
export const accountById = (id: string) => state.accounts.find((a) => a.id === id);
export const accountsIn = (space: SpaceId) => state.accounts.filter((a) => a.space === space);
export const decisionsIn = (space: SpaceId) => state.decisions.filter((d) => taskById(d.taskId)?.space === space);
export const decisionFor = (taskId: string) => state.decisions.find((d) => d.taskId === taskId);

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
