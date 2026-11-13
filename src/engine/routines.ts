// 루틴: work that starts by itself. Each routine has a prompt, a project and a "when" (a time, a
// repeat, or something on the project's GitHub repo). A run is an ordinary job, so everything a job
// can do a run can do; runs of one routine form one line in the sidebar:
//   continue → the next run goes on in the last run's conversation (relay: it resumes or carries on)
//   fresh    → each run is a new job that follows the last one (a clean conversation on the same line)
// A run with nothing to report says so (NOTHING) and, for a quiet routine, is put away without a
// notice. Ondra keeps running in the tray when its window is closed; a run the Mac slept through
// starts once when it wakes, never once per missed time.
import { createEffect, createRoot, on } from "solid-js";
import { ghWatch, spaceEnv } from "../lib/native";
import { projectById, setState, spaceById, state, taskById, uid } from "../state/store";
import type { Routine, RoutineWhen, SpaceId, Task } from "../state/types";
import { toast } from "../state/ui";
import { t } from "../i18n";
import { eventText, newEvents, parseEvents, searchFilter } from "./routineEvents";
import { describeWhen, LATE_OK, nextRun } from "./routineTime";
import { archiveTask, createTask, finished } from "./tasks";
import { relay } from "./jobs";
import { splitProjectId } from "../state/mirror";
import { viaHost } from "./hosts";

/** What a run says, at the start of its last message, when there was nothing to do or report. */
export const NOTHING = "(루틴: 없음)";
/** events are looked at this often */
export const EVENT_EVERY = 5 * 60_000;

export const routinesIn = (space: SpaceId) => (state.routines ?? []).filter((r) => r.space === space && !r.draft);
export const routineById = (id: string) => (state.routines ?? []).find((r) => r.id === id);

export function patchRoutine(id: string, patch: Partial<Routine>) {
  setState("routines", (list) => (list ?? []).map((r) => (r.id === id ? { ...r, ...patch } : r)));
}

export type RoutineDraft = Pick<Routine, "space" | "title" | "prompt" | "when" | "mode"> & Partial<Pick<Routine, "project" | "quiet" | "host" | "hostSpace" | "model" | "accountId" | "draft" | "from" | "enabled">>;

/** A new routine (a draft from the chat waits for the user to save it). Returns its id. */
export function addRoutine(d: RoutineDraft, now = Date.now()): string {
  const id = uid("r");
  const r: Routine = {
    id,
    space: d.space,
    title: d.title.trim().slice(0, 80) || t("루틴"),
    prompt: d.prompt.trim(),
    project: d.project,
    when: d.when,
    mode: d.mode,
    quiet: d.quiet ?? true,
    enabled: d.enabled ?? !d.draft,
    draft: d.draft,
    host: d.host,
    hostSpace: d.hostSpace,
    model: d.model,
    accountId: d.accountId,
    from: d.from,
    createdAt: now,
    updatedAt: now,
    nextAt: nextRun(d.when, now),
    runs: 0,
  };
  setState("routines", (list) => [...(list ?? []), r]);
  return id;
}

/** Saves edits; a new "when" or turning it on starts the clock from now (an event routine looks again from now). */
export function saveRoutine(id: string, patch: Partial<Omit<Routine, "id" | "createdAt" | "runs">>, now = Date.now()) {
  const r = routineById(id);
  if (!r) return;
  const when = patch.when ?? r.when;
  const retime = patch.when !== undefined || (patch.enabled === true && !r.enabled) || (patch.draft === false && r.draft);
  const eventChanged = patch.when !== undefined && JSON.stringify(patch.when) !== JSON.stringify(r.when);
  patchRoutine(id, {
    ...patch,
    updatedAt: now,
    ...(retime ? { nextAt: nextRun(when, now) } : {}),
    ...(eventChanged ? { seen: undefined, since: undefined } : {}),
    ...(patch.draft === false ? { enabled: patch.enabled ?? true } : {}),
  });
}

export function removeRoutine(id: string) {
  setState("routines", (list) => (list ?? []).filter((r) => r.id !== id));
}

/** The runs of a routine, oldest first. */
export const runsOf = (id: string): Task[] => state.tasks.filter((x) => x.routine === id).sort((a, b) => a.createdAt - b.createdAt);

/** Said nothing worth a look: the run's last word starts with NOTHING. */
export function saidNothing(x: Pick<Task, "summary" | "result" | "saidDone">): boolean {
  const last = (x.result ?? x.summary ?? x.saidDone ?? "").trim();
  return last.startsWith(NOTHING) || (x.summary ?? "").trim().startsWith(NOTHING);
}

const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** The message a run starts with: which routine, when it last ran, what to do, and what happened (events). */
export function runMessage(r: Routine, now: number, happened?: string): string {
  const head = [
    `(Ondra) 루틴 «${r.title}» · ${describeWhen(r.when)} · ${r.runs + 1}번째 실행 · ${stamp(now)}`,
    r.lastAt ? `지난 실행: ${stamp(r.lastAt)}` : "첫 실행이에요.",
  ].join("\n");
  const quiet = r.quiet
    ? `할 일이나 알릴 것이 없었다면 마지막 답을 "${NOTHING}"로 시작하고 한 줄로 끝내요. 그런 실행은 조용히 보관돼요.`
    : "";
  return [head, happened ? `## 새로 생긴 것\n${happened}` : "", `## 할 일\n${r.prompt}`, quiet].filter(Boolean).join("\n\n");
}

/** Starts one run now. Returns the job it went to (undefined: skipped, with lastStatus saying why). */
export function runRoutine(id: string, o: { now?: number; happened?: string; manual?: boolean } = {}): string | undefined {
  const r = routineById(id);
  if (!r || (r.draft && !o.manual)) return undefined;
  const now = o.now ?? Date.now();
  const p = r.project ? projectById(r.project) : undefined;
  if (r.project && !p) {
    patchRoutine(id, { lastAt: now, lastStatus: "failed", lastError: t("프로젝트가 없어요"), nextAt: nextRun(r.when, now) });
    return undefined;
  }
  const last = r.lastTask ? taskById(r.lastTask) : undefined;
  // the next run waits for the last one to end: a pile of runs (or of queued messages) helps no one
  if (last && !finished(last) && !o.manual) {
    patchRoutine(id, { lastStatus: "skipped", nextAt: nextRun(r.when, now) });
    return undefined;
  }
  const message = runMessage(r, now, o.happened);
  let taskId: string;
  if (r.mode === "continue" && last) {
    // the same conversation: a finished run carries on in a job on its line, a live one hears it
    taskId = relay(last, message, { by: "main", display: o.happened ? t("루틴 실행 · 새로 생긴 것이 있어요") : t("루틴 실행") }).taskId;
  } else {
    taskId = createTask({
      space: r.space,
      title: r.title,
      topic: r.title,
      ask: message,
      display: t("루틴 «{name}» 실행", { name: r.title }),
      project: r.project,
      model: r.model,
      accountId: r.accountId,
      host: r.host,
      hostSpace: r.hostSpace,
      ...(last && finished(last) ? { follows: last.id } : {}),
      routine: id,
    });
  }
  // runs of a routine are marked so the line and the page can find them (a carried-on one too)
  if (state.tasks.some((x) => x.id === taskId && !x.routine)) setState("tasks", (x) => x.id === taskId, "routine", id);
  patchRoutine(id, {
    lastAt: now,
    lastTask: taskId,
    lastStatus: "running",
    lastError: undefined,
    runs: r.runs + 1,
    nextAt: r.when.kind === "once" ? undefined : nextRun(r.when, now),
    ...(r.when.kind === "once" ? { enabled: false } : {}),
  });
  return taskId;
}

/** Is a timed routine due? A time missed long ago (asleep, closed) still runs, once. */
export const due = (r: Routine, now: number) => r.enabled && !r.draft && r.when.kind !== "event" && r.nextAt !== undefined && r.nextAt <= now;

/** A run missed by a lot: say so in the run, so it can look back over the gap. */
const lateNote = (r: Routine, now: number) =>
  r.nextAt && now - r.nextAt > LATE_OK ? t("({time}에 하려던 실행이에요. Mac이 잠들어 있었어요.)", { time: stamp(r.nextAt) }) : undefined;

/** Looks at one event routine's repo; starts a run for what is new. */
export async function pollRoutine(r: Routine, now = Date.now()): Promise<void> {
  if (r.when.kind !== "event" || !r.enabled || r.draft) return;
  const p = r.project ? projectById(r.project) : undefined;
  if (!p) return;
  const when = r.when;
  const search = searchFilter(when.event) ? (when.filter ?? "") : "";
  let raw = "";
  try {
    const far = splitProjectId(p.id);
    // another Mac's project: its repo is looked at there, as that Mac's GitHub login
    raw = far ? String(await viaHost(far.host, "ghWatch", [far.id, when.event, search])) : await ghWatch(p.folder, when.event, search, await spaceEnv(spaceById(r.space)));
  } catch (e) {
    patchRoutine(r.id, { lastError: e instanceof Error ? e.message : String(e) });
    return;
  }
  const items = parseEvents(when.event, raw);
  const got = newEvents(routineById(r.id) ?? r, items, now);
  patchRoutine(r.id, { seen: got.seen, since: got.since, lastError: undefined });
  if (got.fresh.length) runRoutine(r.id, { now, happened: eventText(got.fresh) });
}

/** Called every minute: timed routines that are due start, event routines are looked at in turn. */
let polling = false;
let lastPoll = new Map<string, number>();
export async function tickRoutines(now = Date.now()) {
  for (const r of state.routines ?? []) {
    if (due(r, now)) {
      const late = lateNote(r, now);
      runRoutine(r.id, { now, happened: late });
    }
  }
  if (polling) return;
  polling = true;
  try {
    for (const r of state.routines ?? []) {
      if (r.when.kind !== "event" || !r.enabled || r.draft) continue;
      if (now - (lastPoll.get(r.id) ?? 0) < EVENT_EVERY) continue;
      lastPoll.set(r.id, now);
      await pollRoutine(r, now);
    }
  } finally {
    polling = false;
  }
}
export const resetPolls = () => void (lastPoll = new Map());

/** The routine a job is a run of (a run on another Mac is known by the routine's last job). */
export const routineOf = (x: Pick<Task, "id" | "routine">) => (x.routine ? routineById(x.routine) : undefined) ?? (state.routines ?? []).find((r) => r.lastTask === x.id);

/** A run that ended: the routine's status follows, and a quiet routine puts away a run with nothing. */
export function settleRun(x: Task) {
  const r = routineOf(x);
  if (!r || r.lastTask !== x.id) return;
  if (x.status === "failed") return patchRoutine(r.id, { lastStatus: "failed", lastError: x.error ?? undefined });
  if (x.status !== "done") return;
  const nothing = saidNothing(x);
  patchRoutine(r.id, { lastStatus: nothing ? "nothing" : "done" });
  // nothing to see: out of the list (a continue run stays: the next run goes on in it)
  if (nothing && r.quiet && r.mode === "fresh") archiveTask(x.id, true, { quiet: true });
}

/** Should finishing this job make a system notice? A quiet routine's empty run doesn't. */
export const quietRun = (x: Task) => !!routineOf(x)?.quiet && saidNothing(x);

let started = false;
export function startRoutines() {
  if (started) return;
  started = true;
  // the first look waits for the app to settle; then once a minute
  setTimeout(() => void tickRoutines(), 30_000);
  setInterval(() => void tickRoutines(), 60_000);
  // each routine's last run, here or on another Mac: when it ends, the routine hears
  createRoot(() => {
    const ended = new Map<string, string>();
    createEffect(
      on(
        () => (state.routines ?? []).map((r) => (r.lastTask ? `${r.lastTask}:${taskById(r.lastTask)?.status ?? ""}` : "")).join(),
        () => {
          for (const r of state.routines ?? []) {
            const x = r.lastTask ? taskById(r.lastTask) : undefined;
            if (!x) continue;
            const was = ended.get(x.id);
            ended.set(x.id, x.status);
            if (was !== x.status && (x.status === "done" || x.status === "failed")) settleRun(x);
          }
        },
      ),
    );
  });
}

/** A short line for a routine's state: next time, or what its last run did. */
export function routineLine(r: Routine, now = Date.now()): string {
  if (r.draft) return t("아직 저장 안 함");
  if (!r.enabled) return t("꺼짐");
  if (r.lastStatus === "running") return t("실행 중");
  if (r.when.kind === "event") return r.lastError ? t("확인 못 함: {why}", { why: r.lastError.slice(0, 60) }) : t("{n}분마다 확인해요", { n: EVENT_EVERY / 60_000 });
  if (r.nextAt) {
    const d = new Date(r.nextAt);
    const today = new Date(now).toDateString() === d.toDateString();
    return t("다음 실행 {when}", { when: today ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}` });
  }
  return t("끝났어요");
}

/** Lets the toast say what was made. */
export function announce(r: Routine) {
  toast(t("루틴 «{name}»: {when}", { name: r.title, when: describeWhen(r.when) }));
}

export type { RoutineWhen };
