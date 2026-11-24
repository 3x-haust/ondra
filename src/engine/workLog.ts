// Work done for the Discord agent, in the open: while a job it started runs, what the job says
// between its steps goes to the channel it works in, a few seconds' worth at a time, the way
// someone building in public mutters as they go. Only its own words and the pictures it puts in
// them: no stock lines about its steps (it says what it ran, found and opened itself). Where and
// whether is the agent's own call (Task.agent: room, quiet, shots); this only carries it. Jobs
// from the app never get here (no Task.agent).
import { discordSend, discordSendFile, discordTyping } from "../lib/native";
import { redact } from "../lib/log";
import { expand } from "./rpc";
import { state } from "../state/store";
import type { Entry, Task } from "../state/types";
import { forThem } from "./tongue";

type Watch = { seen: Set<string>; typingAt: number; busy?: boolean; pictures?: string[]; saidAt?: number; askedAt?: number };
const watching = new Map<string, Watch>();
/** jobs already let go: an ended job is relayed to its end once, never picked up again */
const done = new Set<string>();
let since: number | undefined;

/** Working this long with nothing said there, it looks stopped from the channel: the job is
 *  reminded, once a while, to say in its own words where it is (nothing is said for it). */
export const QUIET_FOR = 2 * 60_000;
const QUIET_NOTE = (min: number) =>
  `(Ondra) Your work shows on Discord only through your own words, and people there have heard nothing from you for ${min} minutes, so it looks like you stopped. In a line or two, in their language, say what you have actually checked or found so far, or where you are stuck; then go on.`;

/** "… is typing" lasts about 10 s: kept up while it works */
export const TYPING_EVERY = 8000;
const MAX_LINE = 1800;

const roomOf = (t: Task) => t.agent?.room || t.agent?.channel;
const out = (s: string) => redact(s).trim();
const ended = (t: Task) => t.status === "done" || t.status === "failed" || t.status === "paused";

/** Called every few seconds: what each of the agent's jobs did since, as one message per job. */
export async function workTick(now = Date.now()) {
  since ??= now;
  const jobs = state.tasks.filter((t) => t.agent && !t.parentId && !t.agent.quiet && roomOf(t));
  for (const t of jobs) {
    if (done.has(t.id)) continue;
    let w = watching.get(t.id);
    if (!w) {
      // ended before it was ever watched (before a restart, or quiet then): nothing to say
      if (ended(t)) {
        done.add(t.id);
        continue;
      }
      w = { seen: new Set(), typingAt: -Infinity, saidAt: now };
      // what happened before Ondra was watching (a restart mid-job) isn't replayed
      for (const e of t.entries) if (e.at < since) w.seen.add(e.id);
      watching.set(t.id, w);
    }
    if (w.busy) continue;
    w.busy = true;
    try {
      await relay(t, w, now);
    } finally {
      w.busy = false;
    }
    if (ended(t)) watching.delete(t.id), done.add(t.id);
  }
  // a job gone from the list (deleted) stops being watched
  for (const id of watching.keys()) if (!state.tasks.some((t) => t.id === id)) watching.delete(id);
}

async function relay(t: Task, w: Watch, now: number) {
  const room = roomOf(t)!;
  const lines: string[] = [];
  for (const e of t.entries) {
    const line = lineOf(t, e, w);
    if (line) lines.push(line);
  }
  const shots = t.agent?.shots !== false ? (w.pictures ?? []) : [];
  w.pictures = [];
  // two jobs in one channel: each batch says whose it is, in small print
  const shared = [...watching.keys()].some((id) => id !== t.id && (() => { const o = state.tasks.find((x) => x.id === id); return !!o && roomOf(o) === room && !ended(o); })());
  const body = lines.join("\n").slice(0, MAX_LINE * 2);
  const text = body && shared ? `-# ${t.title}\n${body}` : body;
  if (text) await discordSend(room, text).catch(() => {});
  for (const p of shots.slice(0, 4)) await discordSendFile(room, p).catch(() => {});
  if (text || shots.length) w.saidAt = now;
  // its end, where it was asked too, is the agent's own end line (discord.ts mainSaid)
  if (ended(t)) return;
  // working, but silent there for a while: it is reminded to say where it is, in its own words
  const quiet = now - Math.max(w.saidAt ?? now, w.askedAt ?? 0);
  if (t.status === "running" && quiet >= QUIET_FOR) {
    const { whisper } = await import("./tasks");
    if (whisper(t.id, QUIET_NOTE(Math.round((now - (w.saidAt ?? now)) / 60_000)))) w.askedAt = now;
  }
  if (t.status === "running" && now - w.typingAt >= TYPING_EVERY) {
    w.typingAt = now;
    await discordTyping(room).catch(() => {});
  }
}

/** Its words, once: what it says before its next step (its last words, the report, are the agent's own end line). */
function lineOf(t: Task, e: Entry, w: Watch): string | undefined {
  if (e.kind !== "text" || w.seen.has(e.id)) return;
  if (!t.entries.slice(t.entries.indexOf(e) + 1).some((x) => x.kind === "tool")) {
    if (ended(t)) stripPictures(e.text, w), w.seen.add(e.id);
    return;
  }
  w.seen.add(e.id);
  const s = out(stripPictures(e.text, w));
  // what it muttered in English in Korean work isn't carried (the engine's reminder to keep to
  // the user's language comes only after the line is out)
  const said = s ? forThem(s, t.title) : "";
  return said ? said.slice(0, MAX_LINE) : undefined;
}

/** markdown pictures in its words (![](~/…/shot.png)) go up as pictures, not as their path */
function stripPictures(text: string, w: Watch): string {
  return text.replace(/!\[[^\]]*\]\(([^)]+)\)/g, (_, p: string) => {
    (w.pictures ??= []).push(expand(p));
    return "";
  });
}

export function resetWorkLog() {
  watching.clear();
  done.clear();
  since = undefined;
}
