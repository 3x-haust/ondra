// The one app store, saved to disk (debounced). Live-only data (streaming
// text, which panel is open) lives in `ui.ts`, not here.
import { linkedProjects, mirroredDecisions, mirroredTasks } from "./mirror";
import { flushLog } from "../lib/log";
import { createEffect, createMemo, createRoot, createSignal } from "solid-js";
import { createStore, produce, reconcile, unwrap, type SetStoreFunction } from "solid-js/store";
import { bindingSource } from "../lib/shortcuts";
import { inTauri, onEvent, stateFlushed, stateLoad, stateSaveParts } from "../lib/native";
import { fixture } from "./fixture";
import { debounce, permissionOf, Saver, unpackTask } from "./persist";
import type { Account, AppState, CaptainMessage, Decision, SpaceId, Task } from "./types";

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

/** What every account starts with; a saved one is filled in from it. */
export const accountBase = (): Omit<Account, "id" | "space" | "label"> => ({ providers: [], model: "", badModels: [], stats: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });

/** the account older versions made on install ("기본", signed in through ~/.pi/agent) */
export const LEGACY_ACCOUNT = "default";

/**
 * There is no built-in account: every account is one the person signed in to. An older state's
 * 기본 stays only while it has a login (then it's named like any other: by its service and email);
 * an empty one goes, with what pointed at it (a picked account, a reviewer, the agent's account).
 */
export function withoutEmptyLegacy(s: AppState): AppState {
  const old = s.accounts.find((a) => a.id === LEGACY_ACCOUNT);
  if (!old) return s;
  if (old.providers.length || old.connection) return { ...s, accounts: s.accounts.map((a) => (a.id === LEGACY_ACCOUNT && a.label === "기본" ? { ...a, label: "" } : a)) };
  const keep = <T extends { account?: string }>(l: T[] | undefined) => l?.filter((r) => r.account !== LEGACY_ACCOUNT);
  const pick = Object.fromEntries(Object.entries(s.accountPick ?? {}).filter(([, id]) => id !== LEGACY_ACCOUNT));
  const agent = s.settings.agent;
  return {
    ...s,
    accounts: s.accounts.filter((a) => a.id !== LEGACY_ACCOUNT),
    ...(s.accountPick ? { accountPick: pick } : {}),
    settings: {
      ...s.settings,
      ...(s.settings.reviewers ? { reviewers: keep(s.settings.reviewers) } : {}),
      ...(s.settings.reviewersBySpace ? { reviewersBySpace: Object.fromEntries(Object.entries(s.settings.reviewersBySpace).map(([k, l]) => [k, keep(l) ?? []])) } : {}),
      ...(agent
        ? { agent: { ...agent, account: agent.account === LEGACY_ACCOUNT ? undefined : agent.account, places: agent.places?.map((p) => (p.account === LEGACY_ACCOUNT ? { ...p, account: undefined } : p)) } }
        : {}),
    },
  };
}

export const freshState = (): AppState => ({
  version: 3,
  onboarded: false,
  space: "home",
  spaces: [{ id: "home", label: "개인", folder: "~", rules: "" }],
  accounts: [],
  tasks: [],
  decisions: [],
  captain: [],
  memory: [],
  skills: [],
  side: [],
  projects: [],
  canvas: {},
  settings: { captainModel: "", theme: "system", instructions: "", learn: true, isolate: true, focusGuard: true, forkModel: "", forkThinking: "", permission: "auto", watchPullRequests: false },
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
    if (!inTauri) return saver.sentAll(parts);
    try {
      let missing = await stateSaveParts(parts.names, parts.fields, parts.order, parts.tasks);
      if (missing.fields.length || missing.tasks.length) {
        // the native side started fresh (or dropped some): send those too
        const fields = Object.fromEntries(missing.fields.map((k) => [k, saver.field(k) ?? "null"]));
        const tasks = Object.fromEntries(missing.tasks.map((k) => [k, saver.text(k) ?? "null"]));
        missing = await stateSaveParts(parts.names, fields, parts.order, tasks);
      }
      if (missing.fields.length || missing.tasks.length) throw new Error(`state save: ${missing.fields.length + missing.tasks.length} parts missing`);
      saver.sentAll(parts);
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
          reconcile(withoutEmptyLegacy({
            ...base,
            ...parsed,
            tasks: (parsed.tasks ?? []).map(unpackTask),
            settings: { ...base.settings, ...parsed.settings, permission: permissionOf(parsed.settings?.permission) ?? base.settings.permission },
            accounts: (parsed.accounts ?? []).map((a) => ({ ...accountBase(), ...a, badModels: a.badModels ?? [] })),
            // the request queue lives in memory: a reply still "thinking" when the app closed never comes back
            captain: (parsed.captain ?? []).map((m) => (m.pending ? { ...m, pending: false, error: "앱이 닫혀 응답이 끊겼어요" } : m)),
            btws: (parsed.btws ?? []).map((b) => (b.pending ? { ...b, pending: false, error: b.answer ? undefined : "앱이 닫혀 응답이 끊겼어요" } : b)),
            side: (parsed.side ?? []).map((m) => (m.pending ? { ...m, pending: false, error: "앱이 닫혀 응답이 끊겼어요" } : m)),
            sent: sentBySpace(parsed),
          })),
        );
      }
    } catch (e) {
      console.error("saved state unreadable, starting fresh", e);
    }
  }
  setLoaded(true);
}

/** Every task carries the project `taskProject` finds, so each place that reads `task.project` agrees. */
function fileTasks() {
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
/** this device's own workspaces (not those of the devices added in Settings › 연결) */
export const ownSpaces = () => state.spaces.filter((s) => !s.host);
/** the one of this device's workspaces a per-space settings page shows: `want` when it is one of them,
 *  else the first (a device's workspace keeps its settings on that device) */
export const ownSpace = (want?: SpaceId): SpaceId => {
  const own = ownSpaces();
  return own.some((s) => s.id === want) ? want! : (own[0]?.id ?? "home");
};
/** the workspaces of one device: this one's (undefined), or an added device's */
export const spacesOf = (host?: string) => state.spaces.filter((s) => s.host === host);
/** the workspaces of the device whose workspace is open (the tabs, ⌘1…⌘9) */
export const deviceSpaces = () => spacesOf(state.spaces.find((s) => s.id === state.space)?.host);
export const tasksIn = (space: SpaceId) => state.tasks.filter((t) => t.space === space);
export const projectsIn = (space: SpaceId) => (state.projects ?? []).filter((p) => p.space === space);
/** A project by id; with `space`, only that space's (ids are unique, but older state may share one). */
export const projectById = (id?: string, space?: SpaceId) =>
  id ? ((state.projects ?? []).find((p) => p.id === id && (!space || p.space === space)) ?? (id.startsWith("r:") ? remoteProjects().find((p) => p.id === id && (!space || p.space === space)) : undefined)) : undefined;
/** projects added from other Macs (Settings › 연결) */
const remoteProjects = createRoot(() => createMemo(() => linkedProjects(state.settings.hostProjects, (h) => state.settings.hosts?.find((x) => x.id === h)?.name ?? "Mac")));
/** what the sidebar lists: the projects of that workspace's device (this one's, or another device's in
 *  its own tab; a link left from before each device had its own tabs waits for that device) */
export const projectsShown = (space: SpaceId) => {
  const host = state.spaces.find((s) => s.id === space)?.host;
  return inOrder(host ? remoteProjects().filter((p) => p.space === space && p.host === host) : projectsIn(space), state.settings.projectOrder);
};
/** projects in the order the user put them; those never moved keep their place after, as added */
export function inOrder<T extends { id: string }>(list: T[], order: string[] | undefined): T[] {
  if (!order?.length) return list;
  const at = new Map(order.map((id, i) => [id, i]));
  return list
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (at.get(a.p.id) ?? order.length + a.i) - (at.get(b.p.id) ?? order.length + b.i))
    .map((x) => x.p);
}
/** Move a project to `to` (its place among the space's projects as the sidebar shows them). */
export function moveProject(space: SpaceId, id: string, to: number) {
  const ids = projectsShown(space).map((p) => p.id);
  const from = ids.indexOf(id);
  if (from < 0) return;
  ids.splice(from, 1);
  ids.splice(Math.max(0, Math.min(to, ids.length)), 0, id);
  // other spaces' order stays as it is
  const mine = new Set(ids);
  setState("settings", "projectOrder", [...(state.settings.projectOrder ?? []).filter((x) => !mine.has(x)), ...ids]);
}
/** Move a device in the Mac bar to `to` (its place in `ids`, the bar's order as shown). */
export function moveMac(ids: string[], id: string, to: number) {
  const from = ids.indexOf(id);
  if (from < 0) return;
  const next = ids.filter((x) => x !== id);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
  setState("settings", "macOrder", next);
}
/** Each space's jobs, this Mac's first and then the other Macs' shown there: kept as jobs come
 *  and go or move, not rebuilt on each read (the sidebar reads it for every row, every second). */
const bySpace = createRoot(() =>
  createMemo(() => {
    const m = new Map<SpaceId, Task[]>();
    const add = (t: Task) => {
      const l = m.get(t.space);
      if (l) l.push(t);
      else m.set(t.space, [t]);
    };
    for (const t of state.tasks) add(t);
    for (const t of mirroredTasks()) add(t);
    return m;
  }),
);
/** this Mac's jobs and the other Macs' jobs shown here (a shared list: filter or copy it, never sort it in place) */
export const tasksShown = (space: SpaceId): readonly Task[] => bySpace().get(space) ?? none;
/** every job shown here, any space: this Mac's and the other Macs' */
export const allTasks = (): Task[] => [...state.tasks, ...mirroredTasks()];
/** the jobs in line on the Mac this one runs on, next first (another device's: those of its shown here) */
export const queueWith = (t: Task): Task[] =>
  (t.host ? mirroredTasks().filter((x) => x.host === t.host) : state.tasks).filter((x) => x.status === "queued" && !x.parentId).sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt);
/** every question waiting on the user: this Mac's and those of the other Macs' jobs */
export const allDecisions = (): Decision[] => [...state.decisions, ...mirroredDecisions()].filter((d) => !agentDecision(d));
/** the Discord agent's own chat, as a chat's project id ("home~@agent"; engine/captain.ts) */
export const AGENT_CHAT = "@agent";
export const isAgentChat = (key: string) => {
  const project = key.replace(/^sim\d*:/, "").split("~")[1];
  return project === AGENT_CHAT || !!project?.startsWith(`${AGENT_CHAT}:`);
};
/** the Discord agent's work (it, or the job it is under): shown in the 에이전트 tab only */
export const agentWork = (t: Task | undefined): boolean => !!t && (!!t.agent || (!!t.parentId && !!taskById(t.parentId)?.agent));
/** the questions of the agent's work, for the 에이전트 tab */
const agentDecision = (d: Decision) => d.taskId.startsWith("main:") ? isAgentChat(d.taskId.slice(5)) : agentWork(taskById(d.taskId));
export const agentDecisions = (space?: SpaceId): Decision[] => state.decisions.filter((d) => agentDecision(d) && (!space || (d.taskId.startsWith("main:") ? d.taskId.slice(5).split("~")[0] : taskById(d.taskId)?.space) === space));
/** Normalize separators only for drive paths: a backslash is a valid Mac filename character. */
const projectPath = (d: string) => /^[A-Za-z]:[\\/]/.test(d) ? d.replace(/\\/g, "/") : d;
const norm = (d: string) => projectPath(d).replace(/^\/Users\/[^/]+(?=\/|$)/, "~").replace(/\/+$/, "");
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
  // another device's job: that device filed it (its folders aren't this Mac's)
  if (t.host) return t.project;
  const known = (id?: string) => (id && projectsIn(t.space).some((p) => p.id === id) ? id : undefined);
  return (t.worktree?.repo ? projectFor(t.space, homeDir(t)) : undefined) ?? known(t.project) ?? projectFor(t.space, t.cwd);
}
/** A project is the repo, never one of its worktree folders (…/worktrees/<repo>/<job> → …/projects/<repo>). */
export function repoHome(folder: string): string {
  const wt = projectPath(folder).replace(/\/$/, "").match(/^(.*)\/worktrees\/([^/]+)(?:\/|$)/);
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
  const label = name || projectPath(folder).split("/").filter(Boolean).pop();
  const id = (label || "project").toLowerCase().replace(/[^a-z0-9가-힣._-]+/g, "-").slice(0, 32) || uid("p");
  // unique across every space: the same folder name in both spaces gets two ids
  const unique = (state.projects ?? []).some((p) => p.id === id) ? `${id}-${uid("").slice(-4)}` : id;
  setState("projects", (l) => [...(l ?? []), { id: unique, space, name: label || unique, folder }]);
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

/** the chat messages kept: the last 300 of each chat (main, each project's, the agent's), so a busy
 *  chat never pushes another's history out */
export function trimChats(list: CaptainMessage[], keep = 300): CaptainMessage[] {
  const seen = new Map<string, number>();
  const out: CaptainMessage[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const k = `${list[i].space}~${list[i].project ?? ""}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n <= keep) out.push(list[i]);
  }
  return out.length === list.length ? list : out.reverse();
}

/** a job of the list: not a subagent, a quick answer or archived */
export const listed = (t: Task) => !t.parentId && !t.answer && !t.archived && !t.agent;
/** a job in the Discord agent's own list (its 작업), as listed is for the sidebar */
export const agentListed = (t: Task) => !t.parentId && !t.answer && !t.archived && !!t.agent;
/** the job a follow-up carries on (one started by answering it, say "merge it") or the job of its group,
 *  when that one is in the same list: the job is part of its line, shown under it and named by it */
export function carriedOn(t: Task): Task | undefined {
  for (const id of [t.follows, t.group]) {
    const p = id ? taskById(id) : undefined;
    if (p && p.id !== t.id && (t.agent ? agentListed(p) : listed(p)) && p.space === t.space && p.project === t.project) return p;
  }
  return undefined;
}
/** the job a job is a part of (the spec its ticket came from), or the job itself */
export const groupRoot = (t: Task): Task => (t.group ? (taskById(t.group) ?? t) : t);
/** a job's group, its root first: just the job when it has none */
export function groupOf(t: Task): Task[] {
  const root = groupRoot(t);
  return [root, ...state.tasks.filter((x) => x.group === root.id && x.id !== root.id)];
}
/** running, waiting on the user, or queued behind steps that can still finish (a step whose
 *  step failed never starts, so it isn't going) */
export function stillGoing(t: Task, seen = new Set<string>()): boolean {
  if (t.status === "running" || t.status === "waiting") return true;
  if (t.status !== "queued" || seen.has(t.id)) return false;
  seen.add(t.id);
  return (t.after ?? []).every((id) => {
    const d = taskById(id);
    return !d || d.status === "done" || stillGoing(d, seen);
  });
}
/** another job of its group is still going: this one's end isn't the group's */
export const groupGoing = (t: Task) => groupOf(t).some((x) => x.id !== t.id && stillGoing(x));
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
