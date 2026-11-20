import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Entry, Task } from "../state/types";
import { fixLands, LAND_STREAK, landBranch, noteLandAnswer, syncHome } from "./tasks";
import { landHabit, taskPrompt } from "./prompts";

const job = (over: Partial<Task> = {}): Task => ({
  id: "job", space: "home", topic: "Example", title: "Fix login",
  ask: "Fix the login redirect.", cwd: "/repo/.ondra/job", status: "done", project: "app",
  priority: 2, weight: "light", accountId: "default", createdAt: 1, finishedAt: 5,
  now: "", plan: [], legs: [{ startedAt: 1 }], entries: [], shells: [], inbox: [],
  worktree: { state: "open", repo: "/repo", path: "/repo/.ondra/job", branch: "fix/login", base: "abc", sub: "" },
  ...over,
});
/** the done's evidence block as the app left it after checking it against the session */
const proof = (...items: object[]): Entry => ({ id: "ev", at: 4, kind: "block", block: { type: "evidence", items, unverified: [] } }) as never;
const passed = proof({ kind: "test", ref: "pnpm test", ok: true, check: "ran" });

beforeEach(() => {
  setState(reconcile(freshState()));
  setState("projects", [{ id: "app", space: "home", name: "app", folder: "/repo" }]);
  vi.spyOn(native, "spaceEnv").mockResolvedValue([]);
  vi.spyOn(native, "worktreeMerge").mockResolvedValue("main");
  vi.spyOn(native, "worktreeRemove").mockResolvedValue();
  vi.spyOn(native, "gitChanges").mockResolvedValue({ isRepo: true, files: [{ path: "src/a.ts", add: 3, del: 1 }] } as never);
});
afterEach(() => vi.restoreAllMocks());

describe("a fix lands on its own", () => {
  it("only when a test or build was seen passing, nothing is unchecked, and the setting is on", () => {
    expect(fixLands({ entries: [passed] })).toBe(true);
    expect(fixLands({ entries: [proof({ kind: "build", ref: "pnpm build", ok: true, check: "ran" })] })).toBe(true);
    // a screenshot, the job's own word, or a failed run is not a passing check
    expect(fixLands({ entries: [proof({ kind: "shot", ref: "a.png", ok: true, check: "exists" })] })).toBe(false);
    expect(fixLands({ entries: [proof({ kind: "test", ref: "pnpm test", ok: true, check: "self" })] })).toBe(false);
    expect(fixLands({ entries: [proof({ kind: "test", ref: "pnpm test", check: "failed", why: "실패" })] })).toBe(false);
    // an earlier done's passing test doesn't vouch for the last one
    expect(fixLands({ entries: [passed, proof({ kind: "shot", ref: "a.png", check: "exists" })] })).toBe(false);
    expect(fixLands({ entries: [] })).toBe(false);
    expect(fixLands({ entries: [passed], unverified: ["로그인 화면은 못 열어 봤어요"] })).toBe(false);
    setState("settings", "autoMergeFixes", false);
    expect(fixLands({ entries: [passed] })).toBe(false);
  });

  it("is merged without a question, with a note saying why", async () => {
    setState("tasks", [job({ entries: [passed] })]);
    await landBranch("job", "fix");
    const t = state.tasks[0];
    expect(t.worktree?.state).toBe("merged");
    expect(state.decisions).toHaveLength(0);
    expect(t.entries.some((e) => e.kind === "note" && e.text === "확인된 수정이라 묻지 않고 합쳐요")).toBe(true);
  });

  it("is asked about when something was left unchecked, and says so", async () => {
    setState("tasks", [job({ entries: [passed], unverified: ["증거 없이 끝났어요"] })]);
    await landBranch("job", "fix");
    expect(state.tasks[0].worktree?.state).toBe("open");
    expect(state.decisions[0]?.kind).toBe("merge");
    expect(state.decisions[0]?.question).toMatch(/^확인 못 한 게 있어요 · /);
  });

  it("is asked about when no test or build ran, and says so", async () => {
    setState("tasks", [job({ entries: [proof({ kind: "shot", ref: "a.png", ok: true, check: "exists" })] })]);
    await landBranch("job", "fix");
    expect(state.tasks[0].worktree?.state).toBe("open");
    expect(state.decisions[0]?.question).toMatch(/^테스트·빌드를 돌린 기록이 없어요 · /);
  });

  it("is asked about, plainly, when the user turned it off", async () => {
    setState("settings", "autoMergeFixes", false);
    setState("tasks", [job()]);
    await landBranch("job", "fix");
    expect(state.tasks[0].worktree?.state).toBe("open");
    expect(state.decisions[0]?.question).toMatch(/^바뀐 파일/);
  });
});

describe("the same answer again and again", () => {
  const land = () => state.memory.filter((m) => !m.invalidAt && m.key === "land");

  it(`becomes the project's decision after ${LAND_STREAK} merges in a row`, () => {
    const t = job();
    for (let i = 0; i < LAND_STREAK - 1; i++) noteLandAnswer(t, "merge", 100 + i);
    expect(land()).toHaveLength(0);
    noteLandAnswer(t, "merge", 200);
    expect(land()).toHaveLength(1);
    expect(land()[0]).toMatchObject({ scope: "project", project: "/repo", kind: "decision", space: "home" });
    expect(land()[0].text).toMatch(/묻지 않고 원래 폴더에 합쳐요/);
    // the job hears it in its git note
    expect(landHabit(t)).toBe(land()[0].text);
    expect(taskPrompt(t)).toContain(land()[0].text);
  });

  it("needs the streak unbroken; a discard is about one job and doesn't count", () => {
    const t = job();
    noteLandAnswer(t, "merge");
    noteLandAnswer(t, "pr");
    noteLandAnswer(t, "merge");
    expect(land()).toHaveLength(0);
    noteLandAnswer(t, "merge");
    noteLandAnswer(t, "discard");
    noteLandAnswer(t, "merge");
    expect(land()).toHaveLength(1);
  });

  it("a new streak replaces the old decision", () => {
    const t = job();
    for (let i = 0; i < LAND_STREAK; i++) noteLandAnswer(t, "merge");
    for (let i = 0; i < LAND_STREAK; i++) noteLandAnswer(t, "pr");
    expect(land()).toHaveLength(1);
    expect(land()[0].text).toMatch(/PR로 올려요/);
  });

  it("keeps projects apart, and a job outside any project teaches nothing", () => {
    setState("projects", (l) => [...(l ?? []), { id: "web", space: "home", name: "web", folder: "/web" }]);
    noteLandAnswer(job(), "merge");
    noteLandAnswer(job(), "merge");
    noteLandAnswer(job({ project: "web" }), "merge");
    expect(land()).toHaveLength(0);
    expect(noteLandAnswer(job({ project: undefined }), "merge")).toBeNull();
  });
});

describe("the git note", () => {
  it("tells the job about fixes, and that memory comes first", () => {
    const text = taskPrompt(job({ status: "running" }));
    expect(text).toContain('{"type":"merge","kind":"fix"}');
    expect(text).toContain("The user's words and the project's memory come first");
    setState("settings", "autoMergeFixes", false);
    expect(taskPrompt(job({ status: "running" }))).not.toContain('"kind":"fix"');
  });
});

describe("a project on GitHub", () => {
  beforeEach(() => {
    vi.spyOn(native, "gitOnGithub").mockResolvedValue(true);
  });

  it("is asked PR or discard only: the user's own folder is never merged into", async () => {
    setState("tasks", [job()]);
    await landBranch("job");
    const d = state.decisions[0];
    expect(d?.question).toContain("PR로 올릴까요");
    expect(d?.options.map((o) => o.id)).toEqual(["pr", "discard"]);
  });

  it("a checked fix goes up as a PR without asking, and nothing is merged locally", async () => {
    const merge = vi.spyOn(native, "worktreeMerge");
    setState("tasks", [job({ entries: [passed] })]);
    await landBranch("job", "fix").catch(() => {});
    expect(merge).not.toHaveBeenCalled();
    expect(state.decisions).toHaveLength(0);
    expect(state.tasks[0].worktree?.state).toBe("open");
    expect(state.tasks[0].entries.some((e) => e.kind === "note" && e.text === "확인된 수정이라 묻지 않고 PR로 올려요")).toBe(true);
  });

  it("once its PR is merged the folder is brought up to GitHub's latest, and said so only when it moved", async () => {
    const sync = vi.spyOn(native, "gitSyncHome").mockResolvedValue({ state: "updated", branch: "main", note: "3" });
    setState("tasks", [job()]);
    await syncHome(state.tasks[0]);
    expect(sync).toHaveBeenCalledWith("/repo", []);
    expect(state.tasks[0].entries.some((e) => e.kind === "note" && e.text === "원래 폴더를 GitHub 최신으로 맞췄어요")).toBe(true);
    sync.mockResolvedValue({ state: "skipped", branch: "feature", note: "on feature, not main" });
    setState("tasks", [job()]);
    await syncHome(state.tasks[0]);
    expect(state.tasks[0].entries).toHaveLength(0);
  });

  it("a folder not on GitHub is left to the merge question as before", async () => {
    vi.spyOn(native, "gitOnGithub").mockResolvedValue(false);
    const sync = vi.spyOn(native, "gitSyncHome");
    setState("tasks", [job()]);
    await landBranch("job");
    expect(state.decisions[0]?.options.map((o) => o.id)).toEqual(["pr", "merge", "discard"]);
    await syncHome(state.tasks[0]);
    expect(sync).not.toHaveBeenCalled();
  });
});
