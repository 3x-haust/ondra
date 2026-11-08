// How far a task got, counted one way for every screen that shows it: the
// sidebar, board and canvas "+a −b", the changes tab and review bar, a "files"
// card in the thread or in results, and the to-do "2/4".
import { createStore, reconcile } from "solid-js/store";
import type { Block, PlanStep, Task } from "./types";
import { expand, tilde } from "../engine/rpc";
import { gitChanges } from "../lib/native";

export interface FileDiff {
  path: string;
  add: number;
  del: number;
}
export interface TaskDiff {
  files: FileDiff[];
  add: number;
  del: number;
}

/** what git said for a task with its own worktree, and for which state of it */
const [git, setGit] = createStore<Record<string, { key: string; files: FileDiff[] }>>({});
const asking = new Set<string>();

/** a task's own branch: its git diff is exactly its changes */
const ownBranch = (t: Task) => t.worktree?.state === "open";
/** changes when the edits it finished do: the diff is asked again then */
const keyOf = (t: Task) => `${t.worktree?.base ?? ""}:${t.entries.reduce((n, e) => n + (e.kind === "tool" && e.tool.endedAt ? 1 : 0), 0)}`;

/** The changes tab fetched the diff itself: everything else shows the same numbers. */
export function rememberDiff(t: Task, files: FileDiff[]) {
  if (!ownBranch(t)) return;
  setGit(t.id, reconcile({ key: keyOf(t), files: files.map((f) => ({ path: f.path, add: f.add, del: f.del })) }));
}

function ask(t: Task, key: string) {
  const id = `${t.id}:${key}`;
  if (asking.has(id)) return;
  asking.add(id);
  void gitChanges(expand(t.cwd), t.worktree!.base)
    .then((c) => c?.isRepo && setGit(t.id, reconcile({ key, files: c.files.map((f) => ({ path: f.path, add: f.add, del: f.del })) })))
    .catch(() => {})
    .finally(() => asking.delete(id));
}

/** what its own edits wrote, by file (notes and failed edits aren't changes) */
function written(t: Task): FileDiff[] {
  const root = expand(t.worktree?.path ?? t.cwd ?? "").replace(/\/+$/, "");
  const m = new Map<string, FileDiff>();
  for (const e of t.entries) {
    if (e.kind !== "tool" || (e.tool.kind !== "edit" && e.tool.kind !== "write") || e.tool.note || e.tool.ok === false) continue;
    const full = (e.tool.detail ?? "").split("\n")[0] || e.tool.target;
    const path = root && full.startsWith(`${root}/`) ? full.slice(root.length + 1) : tilde(full);
    const f = m.get(path) ?? { path, add: 0, del: 0 };
    f.add += e.tool.add ?? 0;
    f.del += e.tool.del ?? 0;
    m.set(path, f);
  }
  return [...m.values()];
}

/** The one count of what a task changed: its branch's diff when it has one, else its own edits. */
export function taskDiff(t: Task): TaskDiff {
  let files: FileDiff[] | undefined;
  if (ownBranch(t)) {
    const key = keyOf(t);
    const g = git[t.id];
    if (g) files = g.files;
    if (!g || g.key !== key) ask(t, key);
  }
  files ??= written(t);
  return { files, add: files.reduce((n, f) => n + f.add, 0), del: files.reduce((n, f) => n + f.del, 0) };
}

/** A "files" card about a task's work shows the task's real changes. */
export function withDiff(b: Block, t?: Task): Block {
  if (b.type !== "files" || !t) return b;
  const d = taskDiff(t);
  return d.files.length ? { type: "files", files: d.files } : b;
}

/** The one plan count: steps done of all ("2/4"), and the step in progress. */
export function planCount(plan: PlanStep[]) {
  const done = plan.filter((p) => p.state === "done").length;
  const now = plan.findIndex((p) => p.state === "now");
  return { done, total: plan.length, now, label: `${done}/${plan.length}` };
}

/** It has stopped working for good, or until someone starts it again. */
export const ended = (t: Task) => t.status === "done" || t.status === "failed";

/**
 * How long a task worked, one way for the header, the overview and its sessions:
 * from its start to its end (a running or waiting one: to `at`). A task that
 * stopped without an end time ends where its last session or entry did.
 */
export function workSpan(t: Task, at: number): { start: number; end: number } | null {
  if (!t.startedAt) return null;
  const last = t.legs[t.legs.length - 1];
  const live = t.status === "running" || t.status === "waiting";
  const end = t.finishedAt ?? (live ? at : last?.endedAt ?? t.entries[t.entries.length - 1]?.at ?? at);
  return { start: t.startedAt, end: Math.max(t.startedAt, end) };
}

export const workedMs = (t: Task, at: number) => {
  const s = workSpan(t, at);
  return s ? s.end - s.start : 0;
};

/** Each session's part of that time, so the sessions never add up to more than the whole. */
export function legTimes(t: Task, at: number): number[] {
  const s = workSpan(t, at);
  return t.legs.map((l, i) => {
    if (!s) return 0;
    const from = Math.max(l.startedAt, s.start);
    const to = Math.min(l.endedAt ?? t.legs[i + 1]?.startedAt ?? s.end, s.end);
    return Math.max(0, to - from);
  });
}
