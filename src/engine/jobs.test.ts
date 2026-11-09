import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state, taskById } from "../state/store";
import type { Entry, Task } from "../state/types";
import { handle } from "./bridge";
import { applyRoutes, mainStep } from "./captain";
import { CAPTAIN_SYSTEM, SUB_SYSTEM, TASK_SYSTEM } from "./prompts";
import { callerOf, jobLine, PAIR_PER_WINDOW, readJob, resetSends, scrub, searchJobs, TELL_PER_MIN, tellJob } from "./jobs";
import { agentOf, steerQueued } from "./tasks";
import { markAlive, markDead } from "./rpc";

const NOW = Date.UTC(2026, 10, 9, 12);
const H = 3_600_000;
const job = (id: string, over: Partial<Task> = {}): Task => ({
  id, space: "home", topic: "Ondra", title: id, ask: `Do ${id}`, cwd: "/repo", status: "done",
  priority: 2, weight: "light", accountId: "default", createdAt: NOW - 100 * H, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
  ...over,
});
const user = (text: string, by?: string): Entry => ({ id: `e${Math.random()}`, at: NOW, kind: "user", text, ...(by ? { by } : {}) });
const said = (text: string): Entry => ({ id: `e${Math.random()}`, at: NOW, kind: "text", text });

beforeEach(() => {
  setState(reconcile(freshState()));
  resetSends();
  setState("spaces", [{ id: "home", label: "개인", folder: "~", rules: "" }, { id: "work", label: "회사", folder: "~/work", rules: "" }]);
  setState("projects", [
    { id: "p-site", space: "home", name: "site", folder: "/repo/site" },
    { id: "p-app", space: "home", name: "app", folder: "/repo/app" },
  ] as never);
  setState("tasks", [
    job("t-redesign", { title: "랜딩 리디자인", project: "p-site", summary: "히어로와 가격표를 새로 만들었어요", finishedAt: NOW - 72 * H, branch: "feat/landing-redesign" }),
    job("t-guest", { title: "비로그인 먼저 쓰기", project: "p-app", status: "running", startedAt: NOW - 2 * H, now: "로그인 화면 고치는 중", ask: "로그인 없이 먼저 쓸 수 있게" }),
    job("t-review", { title: "시안 리뷰", parentId: "t-guest", status: "running", startedAt: NOW - H, ask: "리디자인 시안을 검토" }),
    job("t-old", { title: "결제 버그", status: "failed", error: "빌드 실패", finishedAt: NOW - 400 * H }),
    job("t-wait", { title: "배너 문구", status: "waiting", startedAt: NOW - 3 * H }),
    job("w-redesign", { space: "work", title: "회사 리디자인" }),
    job("t-answer", { title: "리디자인이 뭐야", answer: true }),
  ]);
  setState("decisions", [{ id: "d1", taskId: "t-wait", at: NOW, question: "어느 문구로 할까요?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], context: [], kind: "ask" }]);
  vi.spyOn(native, "agentSend").mockResolvedValue(undefined as never);
});
afterEach(() => {
  for (const t of state.tasks) markDead(agentOf(t.id));
  vi.restoreAllMocks();
});

const main = callerOf("captain:home")!;
const ids = (r: { hits: Task[] }) => r.hits.map((t) => t.id);

describe("jobs_search", () => {
  it("finds jobs by name in this space only, any status, age or project, subagents with their parent", () => {
    const r = searchJobs(main, "리디자인", { now: NOW });
    // the title hit first; the subagent only mentions it in its ask; the other space and quick answers never
    expect(ids(r)).toEqual(["t-redesign", "t-review"]);
    expect(jobLine(taskById("t-review")!, NOW)).toContain('(subagent of t-guest "비로그인 먼저 쓰기")');
    expect(ids(searchJobs(main, "비로그인에 전달", { now: NOW }))[0]).toBe("t-guest");
    expect(ids(searchJobs(main, "landing-redesign", { now: NOW }))).toEqual(["t-redesign"]);
  });

  it("filters by status and project, and caps the list", () => {
    expect(ids(searchJobs(main, "", { status: "failed" }))).toEqual(["t-old"]);
    expect(ids(searchJobs(main, "", { status: "live" })).sort()).toEqual(["t-guest", "t-review", "t-wait"]);
    expect(ids(searchJobs(main, "", { project: "site" }))).toEqual(["t-redesign"]);
    expect(searchJobs(main, "", { limit: 2 }).hits).toHaveLength(2);
    expect(searchJobs(main, "", { status: "sleeping" }).error).toContain("unknown status");
  });

  it("with no query lists the live ones first, then the latest", () => {
    expect(ids(searchJobs(main, "")).slice(0, 3)).toEqual(["t-review", "t-guest", "t-wait"]);
    expect(ids(searchJobs(main, "")).slice(3)).toEqual(["t-redesign", "t-old"]);
  });

  it("lets meaning lift a job the words miss", () => {
    const sims = new Map([["t-old", 0.8]]);
    expect(ids(searchJobs(main, "결제 오류", { sims }))[0]).toBe("t-old");
    expect(ids(searchJobs(main, "전혀 다른 것", { sims: new Map([["t-old", 0.3]]) }))).toEqual([]);
  });

  it("one line: id, status, project, title, when, where, last state", () => {
    expect(jobLine(taskById("t-redesign")!, NOW)).toBe("t-redesign | done | site | 랜딩 리디자인 | finished 3d ago | /repo | did: 히어로와 가격표를 새로 만들었어요");
    expect(jobLine(taskById("t-wait")!, NOW)).toContain("asks: 어느 문구로 할까요?");
    expect(jobLine(taskById("t-old")!, NOW)).toContain("failed: 빌드 실패");
  });

  it("a job never finds itself, and sees another space only when the user opened it", () => {
    const self = callerOf("t-guest")!;
    expect(ids(searchJobs(self, "비로그인"))).not.toContain("t-guest");
    setState("tasks", (t) => t.id === "t-guest", "reach", ["work"]);
    expect(ids(searchJobs(callerOf("t-guest")!, "리디자인"))).toContain("w-redesign");
  });
});

describe("job_read", () => {
  it("trims what it hands back and leaves secrets out", () => {
    setState("tasks", (t) => t.id === "t-redesign", {
      ask: "가".repeat(5000),
      summary: "배포했어요. GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 password: hunter2222",
      plan: [{ text: "시안", state: "done" }, { text: "구현", state: "now" }],
      entries: [user("처음 요청"), said("a".repeat(900)), user("이것도", "main"), said("끝났어요 sk-ant-api03-abcdefghijklmnopqrstuvwxyz")],
    });
    const text = readJob(main, taskById("t-redesign")!, { messages: 3, now: NOW });
    expect(text).toContain("# 랜딩 리디자인 (t-redesign)");
    expect(text).toContain("[x] 시안");
    expect(text).toContain("[>] 구현");
    expect(text).toMatch(/가{100,}…/);
    expect(text).not.toContain("가".repeat(1600));
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("hunter2222");
    expect(text).not.toContain("sk-ant-api03");
    expect(text).toContain("Latest messages (last 3):");
    expect(text).toContain("- main: 이것도");
    expect(text).not.toContain("처음 요청");
  });

  it("gives a job another job's messages only where it may read that job's logs", () => {
    setState("tasks", (t) => t.id === "t-redesign", "entries", [said("비밀 아닌 진행 상황")]);
    const sibling = callerOf("t-review")!;
    expect(readJob(sibling, taskById("t-redesign")!)).not.toContain("진행 상황");
    expect(readJob(sibling, taskById("t-redesign")!)).toContain("this is its record");
    // its own fork is its to read
    setState("tasks", (t) => t.id === "t-guest", "entries", [said("부모의 진행 상황")]);
    expect(readJob(sibling, taskById("t-guest")!)).toContain("부모의 진행 상황");
  });

  it("says what a job waits on", () => {
    expect(readJob(main, taskById("t-wait")!)).toContain('Waiting on: the user\'s answer to "어느 문구로 할까요?" (options: A / B)');
    expect(readJob(main, taskById("t-guest")!)).toContain("its subagents: t-review");
  });

  it("scrubs token shapes and assigned secrets but keeps plain words", () => {
    expect(scrub("token refresh fixed")).toBe("token refresh fixed");
    expect(scrub("api_key=abcd1234efgh")).toBe("api_key=[hidden]");
    expect(scrub("curl -H 'Authorization: Bearer abcdefghijklmnop'")).toContain("Bearer [hidden]");
    expect(scrub("https://user:pa55word@example.com/x")).toBe("https://[hidden]@example.com/x");
  });
});

describe("job_tell", () => {
  it("queues for a running job's next turn, or delivers now", () => {
    markAlive(agentOf("t-guest"));
    const r = tellJob(callerOf("t-wait")!, "t-guest", "배너는 내가 맡을게요");
    expect(r).toMatchObject({ ok: true, line: "queued for its next turn" });
    const q = taskById("t-guest")!.queue![0];
    expect(q).toMatchObject({ text: "배너는 내가 맡을게요", by: "t-wait" });
    expect(q.sent).toContain('another job in this space, "배너 문구" (t-wait)');
    // when it goes in, the thread shows the words and who sent them; the model gets who it is from
    steerQueued("t-guest", q.id);
    const e = taskById("t-guest")!.entries.slice(-1)[0]!;
    expect(e).toMatchObject({ kind: "user", text: "배너는 내가 맡을게요", by: "t-wait" });
    expect(tellJob(callerOf("t-wait")!, "t-guest", "지금 봐줘", { now: true }).line).toBe("delivered");
  });

  it("answers a waiting job, resumes a paused one, carries a finished one on", () => {
    markAlive(agentOf("t-wait"));
    expect(tellJob(main, "t-wait", "A로 해요").line).toBe("delivered as the answer to its question");
    expect(taskById("t-wait")!.status).toBe("running");
    expect(state.decisions.some((d) => d.taskId === "t-wait")).toBe(false);

    setState("tasks", (t) => t.id === "t-old", { status: "paused", finishedAt: undefined });
    expect(tellJob(main, "t-old", "다시 해봐요").line).toBe("resumed with it");
    expect(taskById("t-old")!).toMatchObject({ status: "queued", inbox: ["다시 해봐요"] });
    expect(taskById("t-old")!.entries.slice(-1)[0]).toMatchObject({ kind: "user", by: "main" });

    const r = tellJob(callerOf("t-guest")!, "t-redesign", "모바일 히어로도 손봐줘요");
    expect(r.line).toMatch(/^it had finished: a new job carries it on with this \(t/);
    const next = taskById(r.taskId!)!;
    expect(next).toMatchObject({ follows: "t-redesign", project: "p-site", title: "랜딩 리디자인" });
    expect(next.entries[0]).toMatchObject({ kind: "user", text: "모바일 히어로도 손봐줘요", by: "t-guest" });
    expect(next.ask).toContain("It is not the user");
  });

  it("refuses itself, the user's stopped work, other spaces and endless back-and-forth", () => {
    const a = callerOf("t-guest")!;
    expect(tellJob(a, "t-guest", "나에게").line).toContain("this job itself");
    setState("tasks", (t) => t.id === "t-wait", "parkedAt", NOW);
    expect(tellJob(a, "t-wait", "계속해").line).toContain("the user stopped or ended that job");
    expect(tellJob(a, "w-redesign", "hi").ok).toBe(false);
    expect(tellJob(a, "t-answer", "hi").ok).toBe(false);

    // a burst from one job
    for (let i = 0; i < TELL_PER_MIN; i++) expect(tellJob(a, "t-review", `${i}`, { at: NOW + i }).ok).toBe(true);
    expect(tellJob(a, "t-review", "more", { at: NOW + 10 }).line).toContain(`${TELL_PER_MIN} messages in the last minute`);
  });

  it("stops two jobs pinging each other", () => {
    resetSends();
    const a = callerOf("t-guest")!;
    const b = callerOf("t-review")!;
    for (let i = 0; i < PAIR_PER_WINDOW; i++) expect(tellJob(i % 2 ? b : a, i % 2 ? "t-guest" : "t-review", `ping ${i}`, { at: NOW + i * 70_000 }).ok).toBe(true);
    expect(tellJob(a, "t-review", "again", { at: NOW + PAIR_PER_WINDOW * 70_000 }).line).toContain("stop the back-and-forth");
  });
});

describe("main and the bridge", () => {
  it("resolves main's worker id to its chat's space, never a simulated or unknown one", () => {
    expect(callerOf("captain:home~p-app")).toMatchObject({ space: "home", project: "p-app", chat: "home~p-app" });
    expect(callerOf("captain:sim2:home")).toBeUndefined();
    expect(callerOf("captain:ghost")).toBeUndefined();
    expect(callerOf("t-guest")).toMatchObject({ space: "home" });
  });

  it("answers main's job lookups in its space, and keeps memory a job's", async () => {
    const r = (await handle({ op: "jobs_search", worker: "captain:work", args: { query: "리디자인" } })) as { lines: string[] };
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatch(/^w-redesign \| done/);
    expect(await handle({ op: "job_read", worker: "captain:work", args: { id: "t-redesign" } })).toEqual({ error: expect.stringContaining("no job t-redesign") });
    expect(await handle({ op: "jobs_search", worker: "nobody", args: {} })).toEqual({ error: expect.stringContaining("only a job or main") });
    expect(await handle({ op: "memory_save", worker: "captain:home", args: { text: "x" } })).toEqual({ error: "only a job can change memory" });
    expect(await handle({ op: "job_tell", worker: "t-guest", args: { id: "w-redesign", message: "hi" } })).toEqual({ error: expect.stringContaining("another space") });
  });

  it("appends to a job main found with jobs_search, not only listed ones", async () => {
    // a subagent and a finished job of another project, days old: not in main's fork list
    markAlive(agentOf("t-review"));
    const out = await applyRoutes("home~p-app", [
      { kind: "append", taskId: "t-review", message: "비로그인 화면도 봐주세요" },
      { kind: "append", taskId: "t-redesign", message: "가격표 문구만 바꿔요" },
    ], "저기 리디자인에 전달해");
    expect(out[0]).toEqual({ kind: "append", taskId: "t-review", message: "비로그인 화면도 봐주세요" });
    expect(taskById("t-review")!.entries.slice(-1)[0]).toMatchObject({ kind: "user", text: "비로그인 화면도 봐주세요", by: "main" });
    expect(out[1].kind).toBe("new");
    const next = taskById((out[1] as { taskId: string }).taskId)!;
    expect(next.follows).toBe("t-redesign");
    // main's own follow-up isn't marked as sent by someone: it is the user's request
    expect(next.entries[0]).not.toHaveProperty("by");
  });

  it("names its job lookups as steps", () => {
    expect(mainStep("jobs_search", { query: "리디자인" }, true)).toBe("작업 찾음 · 리디자인");
    expect(mainStep("jobs_search", { query: "리디자인" }, false)).toBe("작업 찾는 중 · 리디자인");
    expect(mainStep("job_read", { id: "t-guest" }, true)).toBe("작업 살펴봄 · 비로그인 먼저 쓰기");
    expect(mainStep("read", {}, true)).toBeUndefined();
  });
});

describe("prompts", () => {
  it("send main to jobs_search for a job it can't see, then to an append", () => {
    expect(CAPTAIN_SYSTEM).toContain("found with jobs_search, never with memory");
    expect(CAPTAIN_SYSTEM).toContain("append to the id it finds");
    expect(TASK_SYSTEM).toContain("jobs_search, job_read, and\njob_tell");
    expect(SUB_SYSTEM).toContain("jobs_search and job_read");
  });
});
