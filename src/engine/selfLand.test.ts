import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Entry, Task } from "../state/types";
import { fixLands, LAND_STREAK, landBranch, landSettle, noteLandAnswer, syncHome } from "./tasks";
import { landHabit, taskPrompt } from "./prompts";
import { bucket } from "../state/needs";

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

describe("a folder not on GitHub", () => {
  // the original folder's checkout: on another branch than the job started from
  const checkout = (branch: string) =>
    vi.spyOn(native, "gitChanges").mockImplementation(async (_: string, base?: string) =>
      (base ? { isRepo: true, branch: "fix/login", files: [{ path: "src/a.ts", add: 3, del: 1 }] } : { isRepo: true, branch, files: [] }) as never,
    );

  it("names the branch it would merge into", async () => {
    checkout("main");
    setState("tasks", [job({ landNudged: 0, worktree: { state: "open", repo: "/repo", path: "/repo/.ondra/job", branch: "fix/login", base: "abc", sub: "", from: "main" } })]);
    await landBranch("job");
    expect(state.decisions[0]?.question).toContain("main 브랜치에 합칠까요");
  });

  it("doesn't merge a checked fix by itself into another branch than the one it started from: it asks, and says so", async () => {
    checkout("docs/readme-kicks");
    const merge = vi.spyOn(native, "worktreeMerge");
    setState("tasks", [job({ entries: [passed], worktree: { state: "open", repo: "/repo", path: "/repo/.ondra/job", branch: "fix/login", base: "abc", sub: "", from: "main" } })]);
    await landBranch("job", "fix");
    expect(merge).not.toHaveBeenCalled();
    expect(state.tasks[0].worktree?.state).toBe("open");
    expect(state.decisions[0]?.question).toMatch(/^원래 폴더가 지금 docs\/readme-kicks 브랜치예요 \(main에서 시작했어요\) · /);
  });
});

describe("a project on GitHub", () => {
  beforeEach(() => {
    vi.spyOn(native, "gitOnGithub").mockResolvedValue(true);
  });

  it("is asked PR or discard only: the user's own folder is never merged into", async () => {
    setState("tasks", [job({ landNudged: 0 })]);
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

  it("a check Ondra started by itself goes up as a PR without asking, even with something left unchecked", async () => {
    setState("tasks", [job({ self: "check", entries: [passed], unverified: ["실행 중인 앱 화면"] })]);
    await landBranch("job", "fix").catch(() => {});
    expect(state.decisions).toHaveLength(0);
    expect(state.tasks[0].entries.some((e) => e.kind === "note" && e.text === "자동 검사라 묻지 않고 PR로 올려요")).toBe(true);
  });

  it("once its PR is merged the local main is brought up to GitHub's latest, and said so only when it moved", async () => {
    const sync = vi.spyOn(native, "gitSyncHome").mockResolvedValue({ state: "updated", branch: "main", note: "3" });
    setState("tasks", [job()]);
    await syncHome(state.tasks[0]);
    expect(sync).toHaveBeenCalledWith("/repo", []);
    expect(state.tasks[0].entries.some((e) => e.kind === "note" && e.text === "로컬 main을 GitHub 최신으로 맞췄어요")).toBe(true);
    sync.mockResolvedValue({ state: "skipped", branch: "main", note: "local commits not on origin" });
    setState("tasks", [job()]);
    await syncHome(state.tasks[0]);
    expect(state.tasks[0].entries).toHaveLength(0);
  });

  it("a check Ondra started by itself in a folder not on GitHub is not asked about: its branch stays as it is", async () => {
    vi.spyOn(native, "gitOnGithub").mockResolvedValue(false);
    setState("tasks", [job({ self: "check", entries: [passed], unverified: ["실행 중인 앱 화면"] })]);
    await landBranch("job", "fix");
    await landBranch("job");
    expect(state.decisions).toHaveLength(0);
    expect(state.tasks[0].worktree?.state).toBe("open");
    expect(state.tasks[0].entries.filter((e) => e.kind === "note" && e.text === "자동 검사라 묻지 않고 브랜치로 남겨 둬요")).toHaveLength(1);
  });

  it("a folder not on GitHub is left to the merge question as before", async () => {
    vi.spyOn(native, "gitOnGithub").mockResolvedValue(false);
    const sync = vi.spyOn(native, "gitSyncHome");
    setState("tasks", [job({ landNudged: 0 })]);
    await landBranch("job");
    expect(state.decisions[0]?.options.map((o) => o.id)).toEqual(["pr", "merge", "discard"]);
    await syncHome(state.tasks[0]);
    expect(sync).not.toHaveBeenCalled();
  });
});

describe("what becomes of the branch is the job's to settle", () => {
  const told = () => state.tasks[0].entries.filter((e) => e.kind === "user" && e.by === "ondra").map((e) => (e as { text: string }).text).join("\n");

  it("the git note has it settle by memory and the repo, and ask with options that fit when they don't", () => {
    const text = taskPrompt(job({ status: "running" }));
    expect(text).not.toContain("Ondra asks the user whether to merge");
    expect(text).toContain("ask the user yourself");
    expect(text).toContain('{"type":"keep"}');
  });

  it("a job that ended with changes and settled nothing is sent back once to settle it, not asked a set question", async () => {
    vi.spyOn(native, "gitOnGithub").mockResolvedValue(true);
    setState("tasks", [job()]);
    await landBranch("job");
    expect(state.decisions).toHaveLength(0);
    expect(told()).toBe("바뀐 것을 어떻게 할지 정해요");
    expect(landSettle(1, true)).toMatch(/nothing settled what becomes of them/);
    expect(landSettle(1, true)).toMatch(/on GitHub/);
    expect(landSettle(2, false)).toMatch(/not on GitHub/);
    // it ends again without settling: then the question, so the branch isn't forgotten
    setState("tasks", 0, "status", "done");
    await landBranch("job");
    expect(state.decisions[0]?.kind).toBe("merge");
  });

  it("is sent back again once the user has spoken since", async () => {
    setState("tasks", [job()]);
    await landBranch("job");
    setState("tasks", 0, "entries", (l) => [...l, { id: "u", at: Date.now() + 10, kind: "user", text: "다른 것도 고쳐줘" } as Entry]);
    setState("tasks", 0, "status", "done");
    await landBranch("job");
    expect(state.decisions).toHaveLength(0);
    expect(told().split("\n")).toHaveLength(2);
  });

  it("keep: the branch stays as it is, nothing asked, and it no longer waits for a merge", async () => {
    setState("tasks", [job()]);
    await landBranch("job", "keep");
    const t = state.tasks[0];
    expect(state.decisions).toHaveLength(0);
    expect(t.inbox).toHaveLength(0);
    expect(t.worktree?.state).toBe("open");
    expect(t.worktree?.kept).toBe(true);
    expect(bucket(t)).toBe("done");
  });
});
