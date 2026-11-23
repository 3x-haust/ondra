// Work done for the Discord agent, in the open: while a job it started runs, what the job says
// between steps and what it does (a skill, subagents, tests, a commit, a PR, a screenshot) go to
// the channel it works in, a few seconds' worth at a time, the way someone building in public
// mutters as they go. Where and whether is the agent's own call (Task.agent: room, quiet, shots);
// this only carries it. Jobs from the app never get here (no Task.agent).
import { discordSend, discordSendFile, discordTyping } from "../lib/native";
import { redact } from "../lib/log";
import { state } from "../state/store";
import type { Entry, Shell, Task, ToolCall } from "../state/types";

type Watch = { seen: Set<string>; ended: Set<string>; kids: Set<string>; typingAt: number; busy?: boolean };
const watching = new Map<string, Watch>();
let since: number | undefined;

/** "… is typing" lasts about 10 s: kept up while it works */
export const TYPING_EVERY = 8000;
const MAX_LINE = 1800;

const roomOf = (t: Task) => t.agent?.room || t.agent?.channel;
const out = (s: string) => redact(s).trim();
const ended = (t: Task) => t.status === "done" || t.status === "failed" || t.status === "paused";
const kidsOf = (id: string) => state.tasks.filter((k) => k.parentId === id);

/** Called every few seconds: what each of the agent's jobs did since, as one message per job. */
export async function workTick(now = Date.now()) {
  since ??= now;
  const jobs = state.tasks.filter((t) => t.agent && !t.parentId && !t.agent.quiet && roomOf(t));
  for (const t of jobs) {
    let w = watching.get(t.id);
    if (!w) {
      if (ended(t) && !((t.entries[t.entries.length - 1]?.at ?? 0) >= since)) continue;
      w = { seen: new Set(), ended: new Set(), kids: new Set(), typingAt: -Infinity };
      // what happened before Ondra was watching (a restart mid-job) isn't replayed
      for (const e of t.entries) if (e.at < since) w.seen.add(e.id), w.ended.add(e.id);
      for (const k of kidsOf(t.id)) if (ended(k)) w.kids.add(k.id);
      watching.set(t.id, w);
    }
    if (w.busy) continue;
    w.busy = true;
    try {
      await relay(t, w, now);
    } finally {
      w.busy = false;
    }
    if (ended(t)) watching.delete(t.id);
  }
  // a job gone from the list (deleted) stops being watched
  for (const id of watching.keys()) if (!state.tasks.some((t) => t.id === id)) watching.delete(id);
}

async function relay(t: Task, w: Watch, now: number) {
  const room = roomOf(t)!;
  const lines: string[] = [];
  const shots: string[] = [];
  for (const e of t.entries) {
    const line = lineOf(t, e, w);
    if (line) lines.push(line);
    if (e.kind === "tool" && e.tool.image && !w.seen.has(`img:${e.id}`)) {
      w.seen.add(`img:${e.id}`);
      if (t.agent?.shots !== false && !/\/attachments\//.test(e.tool.image)) shots.push(e.tool.image);
    }
  }
  for (const k of kidsOf(t.id)) {
    if (w.kids.has(k.id) || !ended(k)) continue;
    w.kids.add(k.id);
    lines.push(kidEnd(k));
  }
  const text = lines.join("\n").slice(0, MAX_LINE * 2);
  if (text) await discordSend(room, text).catch(() => {});
  for (const p of shots.slice(0, 4)) await discordSendFile(room, p).catch(() => {});
  if (ended(t)) {
    // worked somewhere else than where it was asked: there, a line pointing to it
    if (t.agent?.channel && t.agent.room && t.agent.room !== t.agent.channel) await discordSend(t.agent.channel, `끝남, <#${t.agent.room}> 봐`).catch(() => {});
    return;
  }
  if (t.status === "running" && now - w.typingAt >= TYPING_EVERY) {
    w.typingAt = now;
    await discordTyping(room).catch(() => {});
  }
}

/** One entry as a line in the open, once: its words as they are, a step as what it did. */
function lineOf(t: Task, e: Entry, w: Watch): string | undefined {
  if (e.kind === "text") {
    if (w.seen.has(e.id)) return;
    w.seen.add(e.id);
    const s = out(e.text);
    return s ? s.slice(0, MAX_LINE) : undefined;
  }
  if (e.kind === "spawn") {
    const fresh = e.childIds.filter((id) => !w.seen.has(`kid:${id}`));
    if (!fresh.length) return;
    fresh.forEach((id) => w.seen.add(`kid:${id}`));
    const kids = fresh.map((id) => state.tasks.find((k) => k.id === id)).filter((k): k is Task => !!k);
    return `서브에이전트 ${kids.length || fresh.length}개 돌림${kids.length ? ` (${kids.map(kidName).join(" · ")})` : ""}`;
  }
  if (e.kind !== "tool") return;
  // started: a skill picked up is said at once
  if (!w.seen.has(e.id)) {
    w.seen.add(e.id);
    const skill = skillOf(e.tool);
    if (skill) {
      w.ended.add(e.id);
      return `\`${skill}\` 스킬 꺼냄`;
    }
  }
  // ended: what came of it
  if (w.ended.has(e.id) || !e.tool.endedAt) return;
  w.ended.add(e.id);
  return stepLine(e.tool, t.shells.find((s) => s.id === e.tool.shellId));
}

const kidName = (k: Task) => `${k.title}${k.model ? `, ${k.model.replace(/^.*\//, "")}` : ""}`;
function kidEnd(k: Task): string {
  const said = [...k.entries].reverse().find((e) => e.kind === "text");
  const first = said?.kind === "text" ? out(said.text).split("\n").find((l) => l.trim()) : undefined;
  return `${k.title} ${k.status === "failed" ? "실패" : "끝"}${first ? `: ${first.slice(0, 160)}` : ""}`;
}

/** the skill a read opens (…/<name>/SKILL.md) */
export function skillOf(tool: ToolCall): string | undefined {
  if (tool.kind !== "read") return;
  return (tool.detail ?? "").match(/([^/]+)\/SKILL\.md$/i)?.[1];
}

/** a finished step worth a line (tests, a build, a commit, a push, a PR); the rest goes unsaid */
export function stepLine(tool: ToolCall, shell?: Shell): string | undefined {
  const cmd = tool.detail ?? tool.target ?? "";
  const tail = shell?.tail ?? "";
  const ok = tool.ok ?? shell?.ok;
  if (tool.stopped) return;
  if (tool.kind === "test") return testLine(tail, ok);
  if (/\bgh\s+pr\s+create\b/.test(cmd)) {
    const url = tail.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/);
    return url ? `PR 올림 #${url[1]} ${url[0]}` : ok === false ? "PR 올리다 막힘" : undefined;
  }
  if (/\bgh\s+pr\s+merge\b/.test(cmd)) return ok === false ? "PR 머지 실패" : "PR 머지함";
  if (/\bgit\b[^|;&]*\bcommit\b/.test(cmd)) {
    const m = tail.match(/^\[[^\]\s]+(?:\s+\([^)]*\))?\s+([0-9a-f]{7,})\]\s+(.+)$/m);
    return m ? `커밋함 \`${m[1]}\` ${out(m[2]).slice(0, 120)}` : ok === false ? "커밋 실패" : undefined;
  }
  if (/\bgit\b[^|;&]*\bpush\b/.test(cmd)) return ok === false ? "푸시 실패" : "푸시함";
  if (/\b(tsc|cargo\s+(build|check)|vite\s+build|(npm|pnpm|yarn|bun)\s+(run\s+)?build|xcodebuild|gradlew?\s+\S*assemble)\b/.test(cmd)) {
    if (ok === undefined) return;
    return ok ? "빌드 돌림 → 통과" : `빌드 돌림 → 실패${why(tail)}`;
  }
}

/** "테스트 돌림 → 1541 통과 / 3 실패: `a.test.ts`", and why in a line when it failed */
export function testLine(tail: string, ok?: boolean): string | undefined {
  const last = (re: RegExp) => [...tail.matchAll(re)].map((m) => Number(m[1])).pop();
  const passed = last(/(\d+)\s+passed/g);
  const failed = last(/(\d+)\s+failed/g);
  if (passed === undefined && failed === undefined && ok === undefined) return;
  const counts = [passed !== undefined ? `${passed} 통과` : "", failed ? `${failed} 실패` : ""].filter(Boolean).join(" / ") || (ok === false ? "실패" : "통과");
  const files = [...new Set([...tail.matchAll(/\bFAIL\s+(\S+\.(?:test|spec)\.[a-z]+)/g)].map((m) => m[1].replace(/^.*\//, "")))].slice(0, 3);
  const bad = !!failed || ok === false;
  return `테스트 돌림 → ${counts}${files.length ? `: ${files.map((f) => `\`${f}\``).join(", ")}` : ""}${bad ? why(tail) : ""}`;
}

/** the first line that says what went wrong */
function why(tail: string): string {
  const line = tail.split("\n").find((l) => /(AssertionError|Error:|error(\[\w+\])?:|expected .+ to )/i.test(l));
  return line ? `\n  ↳ ${out(line).slice(0, 160)}` : "";
}

/** for tests: forget what was watched */
export function resetWorkLog() {
  watching.clear();
  since = undefined;
}
