// Skill refinement (GEPA, arXiv 2507.19457, the light version): a finished job that
// used a skill and went badly is read back — its condensed trace (what was asked, what
// the user said after, failed commands, errors, the result) with the skill's SKILL.md —
// and one model call says, in plain words, what in the skill led there and a small edit
// that would have helped. Nothing changes until the user applies it (Settings › 스킬).
//   - no trouble, no call: failed, corrected or redone by the user, or the same failure
//     over and over (the harness notes)
//   - the lessons of one skill pile up into one proposal, not a stack: a new trace is
//     reflected together with the open proposal's lessons and edit, and the model writes
//     one edit that covers them all (GEPA's "combine complementary lessons")
//   - an edit is exact replacements in the file; one that no longer fits (the skill was
//     changed since) is not applied
//   - Ondra's own skills are changed as the user's copy (원래대로 brings them back); skills
//     brought in from other tools are left alone (they are those tools' files)
import { skillList, fsRead, skillSave, skillRemove } from "../lib/native";
import { engine } from "./rpc";
import { oneShot } from "./aside";
import { readFences } from "./fences";
import { jobMaterial } from "./tidy";
import { setState, spaceById, state, uid, projectById } from "../state/store";
import type { SkillProposal, SkillEdit, SkillLesson, SpaceId, Task } from "../state/types";
import { setView, toast } from "../state/ui";
import { t as tr } from "../i18n";

/** at most one pass an hour, and a few calls in it */
const EVERY_MS = 60 * 60_000;
const CALLS_PER_PASS = 3;
/** only jobs finished lately are worth a lesson */
const RECENT_MS = 3 * 24 * 60 * 60_000;
/** lessons one proposal carries (the newest) */
export const MAX_LESSONS = 5;
const TRACE_BUDGET = 5_000;
const WAIT_MS = 4 * 60_000;

// ───────────── which skills a job used

export type SkillKind = "bundled" | "changed" | "mine";
export interface KnownSkill {
  name: string;
  /** its SKILL.md */
  path: string;
  kind: SkillKind;
}

const mdOf = (p: string) => (/\.md$/i.test(p) ? p : `${p.replace(/\/$/, "")}/SKILL.md`);

/** The skills a job read (their SKILL.md) or was asked to use (`name` 스킬로 / /skill:name), among those that can be changed. */
export function skillsUsed(t: Pick<Task, "ask" | "entries">, known: KnownSkill[]): KnownSkill[] {
  const names = new Set<string>();
  for (const e of t.entries ?? []) {
    if (e.kind !== "tool" || e.tool.kind !== "read") continue;
    const m = /\/([^/]+)\/SKILL\.md$/i.exec(e.tool.detail ?? "");
    if (m) names.add(m[1]);
  }
  for (const m of t.ask.matchAll(/`([\w.-]+)`(?=(?:, `[\w.-]+`)* 스킬로)|\/skill:([\w.-]+)/g)) names.add(m[1] ?? m[2]);
  return known.filter((k) => names.has(k.name));
}

// ───────────── did it go badly

/** what the user said after the ask (the first message is the ask, whoever sent it; other agents' messages aren't the user's) */
const saidAfter = (t: Pick<Task, "entries">): string[] =>
  (t.entries ?? [])
    .filter((e): e is Extract<Task["entries"][number], { kind: "user" }> => e.kind === "user")
    .slice(1)
    .filter((e) => !e.by)
    .map((e) => e.text);

/** what the user says when the work was not right (after the first ask) */
const CORRECTION = /(아니[야요,. ]|이게 아니|그게 아니|틀렸|틀려|잘못|다시 ?해|다시 ?하|왜 안|안 ?되잖|안 ?돼|엉뚱|그거 말고|\bwrong\b|not what|\bredo\b|try again|doesn'?t work|didn'?t work|still broken|\bbroken\b)/i;
/** harness notes of a job stuck on the same thing */
const STUCK = /^(같은 실패 반복|같은 검사 반복|검색 멈춤|기다림 멈춤|재시도 )/;

/** Why a finished job counts as trouble (empty = it went fine). */
export function troubleOf(t: Pick<Task, "status" | "error" | "entries">): string[] {
  const why: string[] = [];
  if (t.status === "failed" || t.error) why.push("failed");
  if (saidAfter(t).some((x) => CORRECTION.test(x))) why.push("corrected");
  const stuck = (t.entries ?? []).filter((e) => e.kind === "note" && STUCK.test(e.text)).length;
  const failedRuns = (t.entries ?? []).filter((e) => e.kind === "tool" && e.tool.ok === false && !e.tool.stopped && (e.tool.kind === "bash" || e.tool.kind === "test")).length;
  if (stuck >= 2 || failedRuns >= 3) why.push("retried");
  return why;
}

export const TROUBLE_LABEL: Record<string, string> = { failed: "실패했어요", corrected: "사용자가 바로잡았어요", retried: "같은 실패를 되풀이했어요" };

// ───────────── the trace the model reads

/** One job, short: the harness's lines (asked, result, failures, errors) and everything the user said after the ask. */
export function condenseTrace(t: Task, budget = TRACE_BUDGET): string {
  const m = jobMaterial(t, true);
  const said = saidAfter(t)
    .map((x) => x.replace(/\s+/g, " ").trim().slice(0, 300))
    .filter(Boolean)
    .slice(-6);
  const lines = [m.head, ...m.lines.map(([k, v]) => `${k}: ${v}`), ...said.map((s) => `User said after: ${s}`)];
  let out = "";
  for (const l of lines) {
    if (out.length + l.length + 1 > budget) break;
    out += `${l}\n`;
  }
  return out.trim();
}

// ───────────── lessons pile up into one proposal

/** The lessons of one proposal: the open ones and the new ones, one per job, the newest kept. */
export function mergeLessons(open: SkillLesson[], fresh: SkillLesson[], max = MAX_LESSONS): SkillLesson[] {
  const by = new Map<string, SkillLesson>();
  for (const l of [...open, ...fresh]) by.set(l.taskId, l);
  return [...by.values()].sort((a, b) => a.at - b.at).slice(-max);
}

// ───────────── the edit

/**
 * The edits made to a text: each `find` must be in it exactly once (an empty one adds
 * `replace` at the end). Null when one does not fit: the text changed under it.
 */
export function applyEdits(text: string, edits: SkillEdit[]): string | null {
  let out = text;
  for (const e of edits) {
    if (!e.find) {
      out = `${out.replace(/\s*$/, "")}\n\n${e.replace.trim()}\n`;
      continue;
    }
    const at = out.indexOf(e.find);
    if (at < 0 || out.indexOf(e.find, at + 1) >= 0) return null;
    out = out.slice(0, at) + e.replace + out.slice(at + e.find.length);
  }
  return out;
}

export type DiffLine = { kind: "same" | "add" | "del" | "gap"; text: string };

/** Lines removed and added between two texts (longest common subsequence), only the changed parts with `context` lines around. */
export function lineDiff(a: string, b: string, context = 2): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  // the same start and end are not compared line by line
  let s = 0;
  while (s < x.length && s < y.length && x[s] === y[s]) s++;
  let e = 0;
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++;
  const xm = x.slice(s, x.length - e);
  const ym = y.slice(s, y.length - e);
  const n = xm.length;
  const m = ym.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xm[i] === ym[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && xm[i] === ym[j]) (mid.push({ kind: "same", text: xm[i] }), i++, j++);
    // what goes out before what comes in
    else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) mid.push({ kind: "del", text: xm[i++] });
    else mid.push({ kind: "add", text: ym[j++] });
  }
  const all: DiffLine[] = [...x.slice(0, s).map((text) => ({ kind: "same" as const, text })), ...mid, ...x.slice(x.length - e).map((text) => ({ kind: "same" as const, text }))];
  // keep changed lines and a little around them; the rest folds into a gap
  const keep = all.map(() => false);
  all.forEach((d, k) => {
    if (d.kind === "same") return;
    for (let q = Math.max(0, k - context); q <= Math.min(all.length - 1, k + context); q++) keep[q] = true;
  });
  const out: DiffLine[] = [];
  all.forEach((d, k) => {
    if (keep[k]) out.push(d);
    else if (out[out.length - 1]?.kind !== "gap") out.push({ kind: "gap", text: "" });
  });
  return out;
}

const nameOf = (md: string) => /^---\r?\n[\s\S]*?^name:\s*(.+?)\s*$/m.exec(md)?.[1]?.replace(/^["']|["']$/g, "");

export interface Reflection {
  skip?: boolean;
  diagnosis: string;
  why: string;
  edits: SkillEdit[];
}

/** The model's answer, checked: a few small edits that fit the skill and keep its name. Null = nothing usable. */
export function readReflection(raw: string, skillText: string): Reflection | null {
  const r = readFences(raw, "skill-edit").items[0] as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object") return null;
  if (r.skip === true) return { skip: true, diagnosis: String(r.diagnosis ?? ""), why: "", edits: [] };
  const diagnosis = typeof r.diagnosis === "string" ? r.diagnosis.trim().slice(0, 400) : "";
  const why = typeof r.why === "string" ? r.why.trim().slice(0, 200) : "";
  const edits = (Array.isArray(r.edits) ? r.edits : [])
    .filter((e): e is SkillEdit => !!e && typeof e === "object" && typeof (e as SkillEdit).find === "string" && typeof (e as SkillEdit).replace === "string")
    .slice(0, 4)
    .map((e) => ({ find: e.find, replace: e.replace.slice(0, 2000) }))
    .filter((e) => e.find !== e.replace);
  if (!diagnosis || !edits.length) return null;
  const after = applyEdits(skillText, edits);
  if (after == null || after === skillText) return null;
  // a skill keeps its name (jobs find it by that)
  if (nameOf(after) !== nameOf(skillText)) return null;
  return { diagnosis, why, edits };
}

// ───────────── the prompt

export function reflectPrompt(skill: KnownSkill, skillText: string, traces: { trouble: string[]; text: string }[], earlier?: Pick<SkillProposal, "lessons" | "diagnosis" | "edits">): string {
  return [
    `A skill (instructions agents follow for a kind of work) was used in the jobs below and the jobs went badly. Read each job's trace and decide what in the skill led there — a missing step, a wrong default, an unclear rule, a missing fact about this domain — and write the smallest change to the skill that would have avoided it. If the trouble had nothing to do with the skill (the user changed their mind, an outage, a missing login, the task itself was impossible), say skip.`,
    ``,
    `Rules for the change:`,
    `- Keep everything that works. Change or add a few lines, not a rewrite. Never change the front matter's name.`,
    `- Write it in the skill's own language and style. Concrete and general: it must help the next job of this kind, not only this one.`,
    `- Each edit replaces text that appears exactly once in the skill (copy it exactly, enough to be unique). To add a section at the end, use an empty find.`,
    earlier
      ? `- An earlier proposal for this skill is still open (below). Write ONE change that covers its lessons and the new ones together: keep what it got right, combine, don't stack two changes that say the same thing.`
      : ``,
    ``,
    `Answer only with a fenced block:`,
    "```skill-edit",
    `{"diagnosis": "1-2 plain sentences in Korean (해요체): what went wrong and what in the skill caused it", "why": "one short Korean line: what the change makes the next job do", "edits": [{"find": "exact text from the skill", "replace": "new text"}]}`,
    "```",
    `or`,
    "```skill-edit",
    `{"skip": true, "diagnosis": "one Korean line why the skill is not the cause"}`,
    "```",
    ``,
    `# Skill ${skill.name} (${skill.path})`,
    "`````markdown",
    skillText.slice(0, 24_000),
    "`````",
    ...(earlier
      ? [``, `# The open proposal`, `Diagnosis: ${earlier.diagnosis}`, `Lessons: ${earlier.lessons.map((l) => l.problem).join(" / ")}`, `Edits: ${JSON.stringify(earlier.edits)}`]
      : []),
    ``,
    `# Jobs that went badly`,
    ...traces.map((x) => `${x.text}\nTrouble: ${x.trouble.join(", ")}\n`),
  ]
    .filter((l, i, a) => l !== `` || a[i - 1] !== ``)
    .join("\n");
}

// ───────────── the pass

/** The skills a job may have used that can be changed: Ondra's own (as the user's copy) and those made here. */
async function knownSkills(): Promise<KnownSkill[]> {
  const files = await skillList().catch(() => []);
  const data = engine.info.dataDir;
  const mine = state.skills
    .filter((s) => s.enabled && !!data && s.path.startsWith(`${data}/skills/`))
    .map((s) => ({ name: s.name, path: mdOf(s.path), kind: "mine" as const }));
  return [...files.map((f) => ({ name: f.name, path: f.path, kind: (f.overridden ? "changed" : "bundled") as SkillKind })), ...mine];
}

let running = false;
const within = <T,>(p: Promise<T>, ms = WAIT_MS) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
export const skillReflectOn = () => !!state.settings.skillReflect;
export const openProposals = () => (state.skillProposals ?? []).filter((p) => !p.status);

/** Read the jobs that finished badly since last time and propose skill changes (at most a few calls). */
export async function reflectSkills(force = false) {
  if (running || !skillReflectOn() || !engine.ready) return 0;
  const last = state.skillReflect;
  if (!force && last && Date.now() - last.at < EVERY_MS) return 0;
  running = true;
  let made = 0;
  try {
    const seen = new Set(last?.tasks ?? []);
    const now = Date.now();
    const jobs = state.tasks.filter((t) => !t.parentId && !t.answer && t.finishedAt && now - t.finishedAt < RECENT_MS && (t.status === "done" || t.status === "failed") && !seen.has(t.id));
    const read: string[] = jobs.map((t) => t.id);
    const known = jobs.length ? await knownSkills() : [];
    // skill → the troubled jobs that used it
    const by = new Map<string, { skill: KnownSkill; jobs: { t: Task; trouble: string[] }[] }>();
    for (const t of jobs) {
      const trouble = troubleOf(t);
      if (!trouble.length) continue;
      for (const s of skillsUsed(t, known)) {
        const g = by.get(s.name) ?? { skill: s, jobs: [] };
        g.jobs.push({ t, trouble });
        by.set(s.name, g);
      }
    }
    let calls = 0;
    for (const { skill, jobs: troubled } of by.values()) {
      if (calls >= CALLS_PER_PASS) {
        // the rest wait for the next pass
        for (const j of troubled) read.splice(read.indexOf(j.t.id), 1);
        continue;
      }
      calls++;
      const text = (await fsRead(skill.path).catch(() => ({ text: "" }))).text ?? "";
      if (!text.trim()) continue;
      const open = openProposals().find((p) => p.skill === skill.name);
      const t0 = troubled[troubled.length - 1].t;
      const folder = projectById(t0.project, t0.space)?.folder ?? t0.cwd ?? spaceById(t0.space)?.folder ?? "~";
      try {
        const raw = await within(oneShot(t0.space as SpaceId, folder, reflectPrompt(skill, text, troubled.map((j) => ({ trouble: j.trouble, text: condenseTrace(j.t) })), open)));
        const r = readReflection(raw, text);
        if (!r || r.skip) continue;
        const fresh: SkillLesson[] = troubled.map((j) => ({ taskId: j.t.id, title: j.t.title, at: j.t.finishedAt ?? now, problem: j.trouble.map((k) => TROUBLE_LABEL[k] ?? k).join(" · ") }));
        const p: SkillProposal = {
          id: open?.id ?? uid("sp"),
          skill: skill.name,
          path: skill.path,
          kind: skill.kind,
          at: now,
          lessons: mergeLessons(open?.lessons ?? [], fresh),
          diagnosis: r.diagnosis,
          why: r.why,
          edits: r.edits,
          base: text,
        };
        setState("skillProposals", (l) => [...(l ?? []).filter((x) => x.id !== p.id), p].slice(-30));
        made++;
      } catch {
        // this skill's jobs are read again next time
        for (const j of troubled) read.splice(read.indexOf(j.t.id), 1);
      }
    }
    setState("skillReflect", { at: now, tasks: [...seen, ...read].slice(-300) });
    if (made) toast(made > 1 ? tr("스킬 다듬기 제안 {n}개", { n: made }) : tr("스킬 다듬기 제안이 있어요"), "info", { label: tr("보기"), run: () => setView({ name: "settings", tab: "skills" }) });
  } finally {
    running = false;
  }
  return made;
}

// ───────────── the user's answer

/** Apply a proposal to the skill as it is now; false when it no longer fits (the skill changed). */
export async function applyProposal(id: string): Promise<boolean> {
  const p = (state.skillProposals ?? []).find((x) => x.id === id);
  if (!p || p.status) return false;
  const now = (await fsRead(p.path).catch(() => ({ text: "" }))).text ?? "";
  const after = now ? applyEdits(now, p.edits) : null;
  if (after == null) {
    toast(tr("스킬이 그새 바뀌어서 적용하지 못했어요"), "bad");
    return false;
  }
  await skillSave(p.skill, after, p.kind !== "mine");
  const undo = async () => {
    // Ondra's own skill with no copy before: removing the copy brings the original back
    if (p.kind === "bundled") await skillRemove(p.skill, true);
    else await skillSave(p.skill, now, p.kind !== "mine");
    setState("skillProposals", (l) => (l ?? []).map((x) => (x.id === id ? { ...x, status: undefined, decidedAt: undefined, base: now } : x)));
  };
  setState("skillProposals", (l) => (l ?? []).map((x) => (x.id === id ? { ...x, status: "applied" as const, base: "", decidedAt: Date.now() } : x)));
  toast(tr("{name} 스킬을 고쳤어요", { name: p.skill }), "info", { label: tr("되돌리기"), run: () => void undo() });
  return true;
}

export function dismissProposal(id: string) {
  setState("skillProposals", (l) => (l ?? []).map((x) => (x.id === id ? { ...x, status: "dismissed" as const, base: "", decidedAt: Date.now() } : x)));
}

/** Every 10 minutes while nothing is working: a pass when it's due. */
export function startSkillReflect() {
  const tick = () => {
    const busy = state.tasks.some((t) => t.status === "running") || state.captain.some((m) => m.pending);
    if (!busy && !document.hidden) void reflectSkills();
  };
  setTimeout(tick, 5 * 60_000);
  setInterval(tick, 10 * 60_000);
}
