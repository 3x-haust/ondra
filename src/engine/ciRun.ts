// A wait on GitHub CI, as progress: which run a waiting command watches, how far
// each of its jobs is, and how long they usually take. Pure; ui/CiProgress.tsx polls.
import { describeCommand } from "./describe";

/** What a waiting command watches: one run by id, or the checks of a PR ("" = the folder's branch). */
export interface CiTarget {
  run?: string;
  pr?: string;
  /** owner/name, when the command names it (-R, a URL); else the job's folder decides */
  repo?: string;
}

/** Flags of gh run / gh pr checks that take a value: what follows them isn't the id. */
const VALUED = new Set(["--job", "-j", "--json", "-q", "--jq", "-t", "--template", "-R", "--repo", "-i", "--interval", "-a", "--attempt", "--exit-status-flag"]);

const repoOf = (s: string) => s.replace(/^(?:https?:\/\/)?github\.com\//, "").replace(/\.git$/, "");

/** The run (or PR) a command waits on, if it waits on one. */
export function ciTarget(cmd: string): CiTarget | undefined {
  // a variable that holds the id (`R=45578109180; … gh run view $R`) reads as its value
  const vars = new Map<string, string>();
  for (const m of cmd.matchAll(/(?:^|[\s;&|(])([A-Za-z_]\w*)=(['"]?)([\w./:-]+)\2(?=[\s;&|)]|$)/g)) vars.set(m[1], m[3]);
  const c = cmd.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (all, a, b) => vars.get(a ?? b) ?? all);
  const named = c.match(/(?:^|\s)(?:-R|--repo)(?:\s+|=)(['"]?)((?:https?:\/\/)?(?:github\.com\/)?[\w.-]+\/[\w.-]+)\1(?=\s|$|[;&|)])/)?.[2];
  const repo = named ? repoOf(named) : undefined;
  // a run's URL or API path names both the repo and the run
  const url = c.match(/(?:github\.com\/|repos\/)([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/);
  // what is quoted is a jq filter or a format, never the id; separators end the gh command
  const bare = c.replace(/'[^']*'|"[^"]*"/g, "''");
  const args = (re: RegExp) => {
    const m = bare.match(re);
    if (!m) return undefined;
    const out: string[] = [];
    const words = m[1].trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (w.startsWith("-")) {
        if (!w.includes("=") && VALUED.has(w)) i++;
        continue;
      }
      out.push(w);
    }
    return out;
  };
  const runArgs = args(/\bgh\s+run\s+(?:view|watch)\b([^;&|\n)]*)/);
  const run = runArgs?.find((w) => /^\d{5,}$/.test(w));
  if (run) return { run, repo: repo ?? (url?.[2] === run ? url[1] : undefined) };
  if (url) return { run: url[2], repo: url[1] };
  const prArgs = args(/\bgh\s+pr\s+checks\b([^;&|\n)]*)/);
  if (prArgs) {
    const w = prArgs[0] ?? "";
    const pull = w.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/);
    if (pull) return { pr: pull[2], repo: repo ?? pull[1] };
    return { pr: /^#?\d+$/.test(w) ? w.replace("#", "") : w, repo };
  }
  return undefined;
}

/** A command its row names as waiting on CI (describe.ts), on a run or PR it names: the row can show that run. */
export function waitsOnCi(cmd: string): boolean {
  return describeCommand(cmd).nowKo === "GitHub 빌드 기다리는 중" && !!ciTarget(cmd);
}

/** The runs a PR's checks come from, by their links (one per workflow). */
export function runsOfChecks(raw: string): { run: string; repo: string }[] {
  const out = new Map<string, { run: string; repo: string }>();
  try {
    for (const c of JSON.parse(raw).statusCheckRollup ?? []) {
      const m = String(c?.detailsUrl ?? "").match(/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)/);
      if (m && !out.has(m[2])) out.set(m[2], { run: m[2], repo: m[1] });
    }
  } catch {
    return [];
  }
  return [...out.values()];
}

export type JobState = "queued" | "running" | "done" | "failed" | "cancelled" | "skipped";

export interface CiStep {
  name: string;
  status: string;
  conclusion: string;
  startedAt?: number;
  completedAt?: number;
}
export interface CiJob {
  name: string;
  status: string;
  conclusion: string;
  startedAt?: number;
  completedAt?: number;
  steps: CiStep[];
}
export interface CiRun {
  workflow: string;
  status: string;
  conclusion: string;
  createdAt?: number;
  jobs: CiJob[];
}

// gh writes a time not reached yet as year 1
const at = (s: unknown) => {
  const n = typeof s === "string" ? Date.parse(s) : NaN;
  return n > 0 ? n : undefined;
};
const low = (s: unknown) => String(s ?? "").toLowerCase();

/** `gh run view --json jobs,status,conclusion,workflowName,createdAt`, made plain. */
export function parseRun(raw: string): CiRun | undefined {
  let j: Record<string, any>;
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== "object") return undefined;
  const jobs = (Array.isArray(j.jobs) ? j.jobs : []).map((x: Record<string, any>) => ({
    name: String(x.name ?? ""),
    status: low(x.status),
    conclusion: low(x.conclusion),
    startedAt: at(x.startedAt),
    completedAt: at(x.completedAt),
    steps: (Array.isArray(x.steps) ? x.steps : []).map((s: Record<string, any>) => ({ name: String(s.name ?? ""), status: low(s.status), conclusion: low(s.conclusion), startedAt: at(s.startedAt), completedAt: at(s.completedAt) })),
  }));
  return { workflow: String(j.workflowName ?? ""), status: low(j.status), conclusion: low(j.conclusion), createdAt: at(j.createdAt), jobs };
}

export function jobState(j: Pick<CiJob, "status" | "conclusion">): JobState {
  if (j.status !== "completed") return j.status === "in_progress" ? "running" : "queued";
  if (j.conclusion === "success" || j.conclusion === "neutral") return "done";
  if (j.conclusion === "skipped") return "skipped";
  if (j.conclusion === "cancelled") return "cancelled";
  return "failed";
}

/** "Run actions/checkout@df4cb1c0…" reads "actions/checkout": the pinned ref says nothing */
export function stepName(s: string): string {
  return s
    .replace(/^(Post )?Run ([\w.-]+\/[\w./-]+)@\S+$/, (_, post, action) => `${post ?? ""}${action}`)
    .trim();
}

export interface JobLine {
  name: string;
  state: JobState;
  /** running: the step it is on; failed: the step that failed */
  step?: string;
  /** running: how long so far; finished: how long it took */
  ms?: number;
  /** how long it usually takes, from recent successful runs */
  typical?: number;
  /** running with a typical time: how far along, 0–1 (past the typical time stays at 1) */
  frac?: number;
}

/** One line per job of the runs, in GitHub's order. */
export function jobLines(runs: CiRun[], typical: (workflow: string, job: string) => number | undefined, now: number): JobLine[] {
  const out: JobLine[] = [];
  for (const r of runs) {
    for (const j of r.jobs) {
      const state = jobState(j);
      const line: JobLine = { name: j.name, state };
      const usual = typical(r.workflow, j.name);
      if (usual) line.typical = usual;
      if (state === "running") {
        // between two steps none is in progress: the last one it finished
        const s = j.steps.find((x) => x.status === "in_progress") ?? [...j.steps].reverse().find((x) => x.status === "completed");
        if (s) line.step = stepName(s.name);
        if (j.startedAt) line.ms = Math.max(0, now - j.startedAt);
        if (usual && line.ms !== undefined) line.frac = Math.min(1, line.ms / usual);
      } else if (state === "failed") {
        const s = j.steps.find((x) => x.conclusion === "failure" || x.conclusion === "timed_out");
        if (s) line.step = stepName(s.name);
      }
      if (state !== "running" && state !== "queued" && j.startedAt && j.completedAt) line.ms = Math.max(0, j.completedAt - j.startedAt);
      out.push(line);
    }
  }
  return out;
}

/** every run has finished: nothing more will change */
export const settledRuns = (runs: CiRun[]) => runs.length > 0 && runs.every((r) => r.status === "completed");

/**
 * How long each job usually takes, by name: the median of its successful runs
 * (one slow or cached run doesn't move it). Jobs without a clean start and end are left out.
 */
export function typicalMs(runs: { jobs: CiJob[] }[]): Map<string, number> {
  const by = new Map<string, number[]>();
  for (const r of runs) {
    for (const j of r.jobs) {
      if (j.conclusion !== "success" || !j.startedAt || !j.completedAt || j.completedAt <= j.startedAt) continue;
      by.set(j.name, [...(by.get(j.name) ?? []), j.completedAt - j.startedAt]);
    }
  }
  const out = new Map<string, number>();
  for (const [name, list] of by) {
    const s = [...list].sort((a, b) => a - b);
    const mid = s.length >> 1;
    out.set(name, Math.round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2));
  }
  return out;
}

/** The run ids `gh run list --json databaseId` gives. */
export function runIds(raw: string): string[] {
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.map((x) => String(x?.databaseId ?? "")).filter((x) => /^\d+$/.test(x)) : [];
  } catch {
    return [];
  }
}
