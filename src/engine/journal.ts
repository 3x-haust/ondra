// 일 기록 and 지금 — what finished jobs did, kept as written:
//   • Codex rollout summaries / OpenClaw daily notes / nanobot history: one entry
//     per finished job (title, ask, outcome, result). Never sent whole; searched by
//     memory_search, and the quiet pass learns from new entries (cursor in tidy.ts).
//   • Cline activeContext / progress: per project, what was last going on and what
//     is left — given to the next job there only while it is fresh (two days).
import { createEffect, createRoot } from "solid-js";
import { homeDir, loaded, setState, state, uid } from "../state/store";
import type { JournalEntry, ProjectNow, Task } from "../state/types";
import { tokens } from "./memory";

const MAX = 400;
const FRESH_MS = 2 * 86_400_000;

const outcomeOf = (t: Task): JournalEntry["outcome"] => (t.status === "failed" ? "failed" : t.status === "done" ? "done" : "stopped");

function entryOf(t: Task): JournalEntry {
  const left = t.plan.filter((p) => p.state !== "done").map((p) => p.text);
  const text = [
    (t.summary ?? t.now ?? "").trim().slice(0, 1200),
    ...(t.unverified?.length ? [`확인 안 됨: ${t.unverified.slice(0, 4).join(" · ")}`] : []),
    ...(left.length ? [`남은 것: ${left.slice(0, 5).join(" · ")}`] : []),
  ]
    .filter(Boolean)
    .join("\n");
  return {
    id: uid("j"),
    taskId: t.id,
    at: t.finishedAt ?? Date.now(),
    space: t.space,
    project: homeDir(t) || undefined,
    title: t.title,
    ask: t.ask.slice(0, 400),
    outcome: outcomeOf(t),
    text,
  };
}

function nowOf(t: Task): ProjectNow {
  const left = t.plan.filter((p) => p.state !== "done").map((p) => p.text);
  const head = `${t.title} — ${outcomeOf(t) === "done" ? "완료" : outcomeOf(t) === "failed" ? "실패" : "일시정지"}`;
  const line = (t.summary ?? "").split("\n").find((l) => l.trim())?.trim().slice(0, 200) ?? "";
  return {
    text: [head, line, left.length ? `남은 것: ${left.slice(0, 4).join(" · ")}` : ""].filter(Boolean).join("\n").slice(0, 420),
    at: t.finishedAt ?? Date.now(),
    taskId: t.id,
    title: t.title,
  };
}

/** Record a finished top-level job (once). */
export function writeJournal(t: Task) {
  if (t.parentId || t.answer || !t.finishedAt) return;
  if ((state.journal ?? []).some((j) => j.taskId === t.id && j.at === t.finishedAt)) return;
  const e = entryOf(t);
  setState("journal", (l) => [...(l ?? []).filter((j) => j.taskId !== t.id), e].slice(-MAX));
  if (e.project) setState("memoryNow", (n) => ({ ...(n ?? {}), [nowKey(t.space, e.project!)]: nowOf(t) }));
}

/** 지금 notes are kept per space and folder: the same folder used from both spaces has two. */
export const nowKey = (space: string, folder: string) => `${space}:${folder}`;
/** "<space>:<folder>" → its parts; an older key is the folder alone (its space comes from the job that wrote it). */
export function parseNowKey(k: string): { space?: string; folder: string } {
  const m = /^([^:/~]+):(.*)$/s.exec(k);
  if (m) return { space: m[1], folder: m[2] };
  const n = state.memoryNow?.[k];
  return { space: n ? state.tasks.find((t) => t.id === n.taskId)?.space : undefined, folder: k };
}

/** What was last going on in this folder in this space, if it is still fresh. */
export function projectNow(folder: string, space: string): ProjectNow | undefined {
  if (!folder) return undefined;
  const n = state.memoryNow?.[nowKey(space, folder)] ?? (parseNowKey(folder).space === space ? state.memoryNow?.[folder] : undefined);
  return n && Date.now() - n.at < FRESH_MS ? n : undefined;
}

/** Journal entries that match a query (word overlap, newest first on ties). */
export function searchJournal(entries: JournalEntry[], query: string, max = 3): JournalEntry[] {
  const q = new Set(tokens(query));
  if (!q.size) return [];
  return entries
    .map((e) => {
      const w = tokens(`${e.title} ${e.ask} ${e.text}`);
      let n = 0;
      for (const x of new Set(w)) if (q.has(x) || [...q].some((t) => t.length >= 3 && (x.startsWith(t) || t.startsWith(x)))) n++;
      return { e, n };
    })
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || b.e.at - a.e.at)
    .slice(0, max)
    .map((x) => x.e);
}

/** Every finished job becomes an entry; the first time, the last few are filled in. */
createRoot(() => {
  createEffect(() => {
    if (!loaded()) return;
    const first = state.journal === undefined;
    const ended = state.tasks.filter((t) => !t.parentId && !t.answer && t.finishedAt && (t.status === "done" || t.status === "failed"));
    const have = new Set((state.journal ?? []).map((j) => `${j.taskId}:${j.at}`));
    const todo = (first ? [...ended].sort((a, b) => a.finishedAt! - b.finishedAt!).slice(-40) : ended.filter((t) => !have.has(`${t.id}:${t.finishedAt}`) && t.finishedAt! > Date.now() - 600_000));
    if (first) setState("journal", []);
    for (const t of todo) writeJournal(t);
  });
});
