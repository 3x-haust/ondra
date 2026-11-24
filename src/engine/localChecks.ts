// Checks that hold one user's own ways in one project (their language, their release steps, the
// rules they keep for their own work on it): kept on this Mac only, never in the repository
// everyone else clones. Each is a folder <data>/checks/<name>/ with a check.json and its scripts:
//
//   { "rule": "...", "project": "~/Work/acme", "run": "node {dir}/check.mjs notes.md",
//     "paths": ["scripts/release.mjs"], "after": "scripts/release\\.mjs", "off": false }
//
// `run` is the command, `{dir}` the check's folder. A check covers a job that changed a file
// under `paths` or ran a command matching `after`; with neither, any code the job changed.
// Jobs in the project read the list in their prompt; one that changed what a check covers and
// didn't run it (or left it failing) is sent back once (tasks.ts). Settings › 자동 검사 lists them.
import { createSignal } from "solid-js";
import { fsFiles, fsRead, fsWrite } from "../lib/native";
import type { Task } from "../state/types";
import { engine, expand, tilde } from "./rpc";

export interface LocalCheck {
  /** its folder's name */
  name: string;
  /** its folder */
  dir: string;
  rule: string;
  /** the project folder it holds in */
  project: string;
  /** the command, `{dir}` for its folder */
  run: string;
  /** files (repo-relative, a trailing / for a folder) whose change it covers */
  paths?: string[];
  /** a command (regex) whose run it covers */
  after?: string;
  /** the memory piece and the job it came from */
  memory?: string;
  task?: string;
  off?: boolean;
}

const [list, setList] = createSignal<LocalCheck[]>([]);
export const localChecks = list;

export const checksDir = () => `${engine.info.dataDir}/checks`;

const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : undefined);

/** a check.json read; undefined when it lacks what a check needs */
export function parseCheck(dir: string, text: string): LocalCheck | undefined {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  const s = (k: string) => (typeof j[k] === "string" && (j[k] as string).trim() ? (j[k] as string).trim() : undefined);
  const rule = s("rule"), project = s("project"), run = s("run");
  if (!rule || !project || !run) return undefined;
  return { name: dir.split("/").pop()!, dir, rule, project, run, paths: strs(j.paths), after: s("after"), memory: s("memory"), task: s("task"), off: j.off === true };
}

/** Read every check on this Mac (again: a job may have added one). */
export async function loadLocalChecks(): Promise<LocalCheck[]> {
  if (!engine.info.dataDir) return list();
  const root = checksDir();
  const files = await fsFiles(root).catch(() => [] as string[]);
  const found: LocalCheck[] = [];
  for (const f of files.filter((p) => /^[^/]+\/check\.json$/.test(p)).sort()) {
    const dir = `${root}/${f.split("/")[0]}`;
    const r = await fsRead(`${dir}/check.json`).catch(() => null);
    const c = r?.text ? parseCheck(dir, r.text) : undefined;
    if (c) found.push(c);
  }
  setList(found);
  return found;
}

/** Turn a check off or on: written into its check.json, so jobs see it too. */
export async function setCheckOff(c: LocalCheck, off: boolean) {
  const r = await fsRead(`${c.dir}/check.json`);
  const j = JSON.parse(r.text ?? "{}");
  await fsWrite(`${c.dir}/check.json`, JSON.stringify({ ...j, off }, null, 2) + "\n");
  setList((l) => l.map((x) => (x.dir === c.dir ? { ...x, off } : x)));
}

const trim = (p: string) => expand(p).replace(/\/+$/, "");

/** the checks that hold in this project folder (on ones only) */
export const checksFor = (folder: string | undefined, all = list()) => (folder ? all.filter((c) => !c.off && trim(c.project) === trim(folder)) : []);

export const command = (c: LocalCheck) => c.run.split("{dir}").join(c.dir);

const when = (c: LocalCheck) =>
  [c.paths?.length && `you change ${c.paths.join(", ")}`, c.after && `you run a command matching /${c.after}/ (run the check before it)`].filter(Boolean).join(" or ") || "you change code";

/** what a job in the project is told */
export function checksPrompt(list: LocalCheck[]): string {
  if (!list.length) return "";
  return [
    "# This user's local checks for this project",
    `They hold this user's own ways and live on this Mac only (${tilde(checksDir())}), not in the repository: never copy them into it. Run each one that applies and fix what it finds before done; one you think is wrong, say so with done instead of changing or skipping it.`,
    ...list.map((c) => `- ${c.rule} — when ${when(c)}: \`${command(c)}\``),
  ].join("\n");
}

type Bash = { cmd: string; ok?: boolean };
const bashOf = (t: Pick<Task, "entries">): Bash[] =>
  t.entries.flatMap((e) => (e.kind === "tool" && e.tool.kind === "bash" ? [{ cmd: `${e.tool.target ?? ""}\n${e.tool.detail ?? ""}`, ok: e.tool.ok }] : []));

/** the check's own command: its folder named, as written or with ~ / $HOME */
const runs = (c: LocalCheck, cmd: string) => cmd.includes(`/checks/${c.name}/`) || cmd.includes(command(c));

export interface CheckRun {
  check: LocalCheck;
  /** the job ran it: the last run passed (true), failed (false) or is still going (undefined) */
  ran: boolean;
  ok?: boolean;
}

/** The checks this job's work falls under, and how their last run went. `files`: the code it changed. */
export function checksCovering(t: Pick<Task, "entries">, list: LocalCheck[], files: string[]): CheckRun[] {
  const bash = bashOf(t);
  return list.flatMap((c) => {
    const own = bash.filter((b) => runs(c, b.cmd));
    let re: RegExp | undefined;
    try {
      re = c.after ? new RegExp(c.after) : undefined;
    } catch {
      re = undefined;
    }
    const touched = !!c.paths?.length && files.some((f) => c.paths!.some((p) => f.includes(`/${p.replace(/^\/+/, "")}`) || f === p));
    const triggered = !!re && bash.some((b) => !runs(c, b.cmd) && re!.test(b.cmd));
    const anyCode = !c.paths?.length && !c.after && files.length > 0;
    if (!touched && !triggered && !anyCode) return [];
    const last = own[own.length - 1];
    return [{ check: c, ran: !!last, ok: last?.ok }];
  });
}

/** what a job owes its local checks, as lines for the send-back (Korean, like the rest of it) */
export function checksOwed(covering: CheckRun[]): string[] {
  return covering.flatMap((r) =>
    !r.ran
      ? [`- 이 사용자의 로컬 검사를 안 돌렸어요: ${r.check.rule} — 돌려 줘: \`${command(r.check)}\``]
      : r.ok === false
        ? [`- 로컬 검사가 실패했어요: ${r.check.rule} — 고치고 다시 돌려 줘: \`${command(r.check)}\``]
        : [],
  );
}
