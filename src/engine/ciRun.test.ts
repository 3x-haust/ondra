import { describe, expect, it } from "vitest";
import { ciTarget, jobLines, jobState, parseRun, runIds, runsOfChecks, settledRuns, stepName, typicalMs, waitsOnCi, type CiRun } from "./ciRun";

describe("ciTarget", () => {
  it("a run polled through a variable that holds its id", () => {
    const c = `cd "$APP_SCRATCH_DIR/probe"; R=45578109180; for i in $(seq 1 50); do s=$(gh run view $R --json jobs -q '.jobs[] | select(.status != "completed") | .name'); [ -z "$s" ] && break; sleep 25; done`;
    expect(ciTarget(c)).toEqual({ run: "45578109180" });
    expect(ciTarget(`R="45578109180"; gh run watch \${R} -R 3x-haust/ondra`)).toEqual({ run: "45578109180", repo: "3x-haust/ondra" });
  });

  it("the id of gh run view and gh run watch, past the flags", () => {
    expect(ciTarget("gh run view 45590480240 --json status,conclusion --jq '.status'")).toEqual({ run: "45590480240" });
    expect(ciTarget("gh run watch --interval 30 45590480240 --exit-status")).toEqual({ run: "45590480240" });
    expect(ciTarget("gh run view --job 139144124042 45590480240 --repo=github.com/3x-haust/ondra")).toEqual({ run: "45590480240", repo: "3x-haust/ondra" });
  });

  it("a run's link names its repo", () => {
    expect(ciTarget("gh run view https://github.com/3x-haust/ondra/actions/runs/45590480240")).toEqual({ run: "45590480240", repo: "3x-haust/ondra" });
    expect(ciTarget("until gh api repos/acme/web/actions/runs/123456789 --jq .status | grep -q completed; do sleep 20; done")).toEqual({ run: "123456789", repo: "acme/web" });
  });

  it("a PR's checks: the PR and its repo", () => {
    const c = `for i in $(seq 1 60); do s=$(gh pr checks 839 -R 3x-haust/ondra 2>/dev/null | rg -c 'pending'); [ "\${s:-0}" = 0 ] && break; sleep 10; done; gh pr checks 839 -R 3x-haust/ondra`;
    expect(ciTarget(c)).toEqual({ pr: "839", repo: "3x-haust/ondra" });
    expect(ciTarget("gh pr checks https://github.com/acme/web/pull/12 --watch")).toEqual({ pr: "12", repo: "acme/web" });
    expect(ciTarget("gh pr checks --watch")).toEqual({ pr: "", repo: undefined });
  });

  it("nothing for a command that watches no run", () => {
    expect(ciTarget("gh run list -L 5")).toBeUndefined();
    expect(ciTarget("pnpm test")).toBeUndefined();
    expect(ciTarget("gh run view $R")).toBeUndefined();
  });
});

describe("waitsOnCi", () => {
  it("a wait on a named run or PR, not a look at one", () => {
    expect(waitsOnCi(`R=45578109180; for i in $(seq 1 50); do s=$(gh run view $R --json jobs -q '.jobs[].status'); [ -z "$s" ] && break; sleep 25; done`)).toBe(true);
    expect(waitsOnCi("for i in $(seq 1 60); do s=$(gh pr checks 839 -R 3x-haust/ondra | rg -c pending); [ \"${s:-0}\" = 0 ] && break; sleep 10; done")).toBe(true);
    expect(waitsOnCi("gh run watch 45590480240")).toBe(true);
    expect(waitsOnCi("gh run view 45590480240 --json status")).toBe(false);
    expect(waitsOnCi("gh pr checks 12")).toBe(false);
  });
});

describe("runsOfChecks", () => {
  it("one run per workflow, from the checks' links", () => {
    const raw = JSON.stringify({
      statusCheckRollup: [
        { detailsUrl: "https://github.com/3x-haust/ondra/actions/runs/45577023705/job/1" },
        { detailsUrl: "https://github.com/3x-haust/ondra/actions/runs/45577023705/job/2" },
        { detailsUrl: "https://github.com/3x-haust/ondra/actions/runs/45577023644/job/3" },
        { context: "vercel", targetUrl: "https://vercel.com/x" },
      ],
    });
    expect(runsOfChecks(raw)).toEqual([
      { run: "45577023705", repo: "3x-haust/ondra" },
      { run: "45577023644", repo: "3x-haust/ondra" },
    ]);
    expect(runsOfChecks("")).toEqual([]);
  });
});

const T0 = Date.parse("2026-11-25T10:00:00Z");
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();
const NOT_YET = "0001-01-01T00:00:00Z";

const raw = JSON.stringify({
  workflowName: "Windows installer",
  status: "in_progress",
  conclusion: "",
  createdAt: iso(0),
  jobs: [
    {
      name: "windows",
      status: "in_progress",
      conclusion: "",
      startedAt: iso(0),
      completedAt: NOT_YET,
      steps: [
        { name: "Set up job", status: "completed", conclusion: "success", startedAt: iso(0), completedAt: iso(1) },
        { name: "Build app", status: "in_progress", conclusion: "", startedAt: iso(1), completedAt: NOT_YET },
        { name: "Upload", status: "pending", conclusion: "", startedAt: NOT_YET, completedAt: NOT_YET },
      ],
    },
    { name: "lint", status: "completed", conclusion: "success", startedAt: iso(0), completedAt: iso(3), steps: [] },
    {
      name: "test",
      status: "completed",
      conclusion: "failure",
      startedAt: iso(0),
      completedAt: iso(4),
      steps: [
        { name: "Run actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10", status: "completed", conclusion: "success" },
        { name: "Run tests", status: "completed", conclusion: "failure" },
      ],
    },
    { name: "linux", status: "queued", conclusion: "", startedAt: NOT_YET, completedAt: NOT_YET, steps: [] },
  ],
});

describe("parseRun", () => {
  it("reads gh's JSON, and a time not reached yet as none", () => {
    const r = parseRun(raw)!;
    expect(r.workflow).toBe("Windows installer");
    expect(r.jobs[0].completedAt).toBeUndefined();
    expect(r.jobs[0].steps[1].startedAt).toBe(T0 + 60_000);
    expect(parseRun("not json")).toBeUndefined();
  });
});

describe("jobState", () => {
  it("names each job's state", () => {
    expect(jobState({ status: "in_progress", conclusion: "" })).toBe("running");
    expect(jobState({ status: "queued", conclusion: "" })).toBe("queued");
    expect(jobState({ status: "waiting", conclusion: "" })).toBe("queued");
    expect(jobState({ status: "completed", conclusion: "success" })).toBe("done");
    expect(jobState({ status: "completed", conclusion: "skipped" })).toBe("skipped");
    expect(jobState({ status: "completed", conclusion: "cancelled" })).toBe("cancelled");
    expect(jobState({ status: "completed", conclusion: "timed_out" })).toBe("failed");
  });
});

describe("stepName", () => {
  it("drops the pinned ref of an action", () => {
    expect(stepName("Run actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10")).toBe("actions/checkout");
    expect(stepName("Post Run actions/setup-node@v4")).toBe("Post actions/setup-node");
    expect(stepName("Build unsigned installer")).toBe("Build unsigned installer");
  });
});

describe("jobLines", () => {
  const run = parseRun(raw)!;
  const usual = new Map([["windows", 25 * 60_000], ["lint", 2 * 60_000]]);
  const typical = (w: string, j: string) => (w === "Windows installer" ? usual.get(j) : undefined);

  it("a running job: its step, how long so far, and how far against the usual time", () => {
    const [win] = jobLines([run], typical, T0 + 18 * 60_000);
    expect(win).toEqual({ name: "windows", state: "running", step: "Build app", ms: 18 * 60_000, typical: 25 * 60_000, frac: 0.72 });
    // past the usual time the bar stays full
    expect(jobLines([run], typical, T0 + 40 * 60_000)[0].frac).toBe(1);
  });

  it("without a usual time there is no bar", () => {
    const [win] = jobLines([run], () => undefined, T0 + 5 * 60_000);
    expect(win.frac).toBeUndefined();
    expect(win.typical).toBeUndefined();
    expect(win.ms).toBe(5 * 60_000);
  });

  it("finished, failed and queued jobs say their state", () => {
    const [, lint, test, linux] = jobLines([run], typical, T0 + 18 * 60_000);
    expect(lint).toMatchObject({ state: "done", ms: 3 * 60_000 });
    expect(lint.frac).toBeUndefined();
    expect(test).toMatchObject({ state: "failed", step: "Run tests", ms: 4 * 60_000 });
    expect(linux).toEqual({ name: "linux", state: "queued" });
  });

  it("between two steps: the last one it finished", () => {
    const r: CiRun = { ...run, jobs: [{ ...run.jobs[0], steps: run.jobs[0].steps.map((s, i) => (i === 1 ? { ...s, status: "completed", conclusion: "success" } : s)) }] };
    expect(jobLines([r], typical, T0)[0].step).toBe("Build app");
  });

  it("settled once every run is completed", () => {
    expect(settledRuns([run])).toBe(false);
    expect(settledRuns([{ ...run, status: "completed" }])).toBe(true);
    expect(settledRuns([])).toBe(false);
  });
});

describe("typicalMs", () => {
  const job = (name: string, conclusion: string, start: number, end?: number) => ({
    name,
    status: "completed",
    conclusion,
    startedAt: T0 + start * 60_000,
    completedAt: end === undefined ? undefined : T0 + end * 60_000,
    steps: [],
  });

  it("the median of each job's successful runs", () => {
    const m = typicalMs([
      { jobs: [job("windows", "success", 0, 24), job("lint", "success", 0, 2)] },
      { jobs: [job("windows", "success", 0, 26)] },
      { jobs: [job("windows", "success", 0, 90)] }, // a cold cache doesn't move it
      { jobs: [job("windows", "failure", 0, 3)] },
    ]);
    expect(m.get("windows")).toBe(26 * 60_000);
    expect(m.get("lint")).toBe(2 * 60_000);
  });

  it("an even count takes the middle two; jobs without times are left out", () => {
    const m = typicalMs([{ jobs: [job("a", "success", 0, 10), job("b", "success", 0)] }, { jobs: [job("a", "success", 0, 20)] }]);
    expect(m.get("a")).toBe(15 * 60_000);
    expect(m.has("b")).toBe(false);
  });
});

describe("runIds", () => {
  it("the ids gh run list gives", () => {
    expect(runIds(JSON.stringify([{ databaseId: 1 }, { databaseId: 22 }]))).toEqual(["1", "22"]);
    expect(runIds("")).toEqual([]);
  });
});
