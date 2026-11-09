import { describe, expect, it } from "vitest";
import { addMemory } from "./memory";
import { applyPlan, conflictsIn, grounded, jobMaterial, jobsShown, keepMine, MIN_EVIDENCE, type Plan, tidyParts, useNew } from "./tidy";
import { setState, state } from "../state/store";
import type { Entry, JournalEntry, Memory, Task } from "../state/types";

const H = 3_600_000;
const piece = (o: Partial<Memory>): Memory => ({ id: o.id ?? Math.random().toString(36), text: o.text ?? "x", scope: "space", space: "work", source: "ondra", by: "agent", createdAt: 1, updatedAt: 1, uses: 0, ...o }) as Memory;
let at = 0;
const note = (text: string): Entry => ({ id: `e${at++}`, at, kind: "note", text });
const job = (id: string, o: Partial<Task> = {}): Task =>
  ({
    id,
    space: "work",
    title: `job ${id}`,
    ask: `${id} 작업을 해 주세요`,
    cwd: "/Users/u/Work/acme",
    project: "acme",
    status: "done",
    plan: [],
    legs: [],
    entries: [],
    shells: [],
    inbox: [],
    createdAt: 0,
    startedAt: 0,
    finishedAt: H,
    summary: "테스트를 고쳤고 빌드도 통과했어요. 변경은 두 파일이에요. 끝까지 확인했어요.",
    ...o,
  }) as Task;

function reset(memory: Memory[] = [], tasks: Task[] = []) {
  setState("spaces", [{ id: "work", label: "회사", folder: "/Users/u/Work" }] as never);
  setState("projects", [{ id: "acme", name: "acme", folder: "~/Work/acme", space: "work" }] as never);
  setState("tasks", tasks);
  setState("memory", memory);
  setState("memoryConflicts", []);
  setState("journal", tasks.map((t) => ({ id: `j-${t.id}`, taskId: t.id, at: t.finishedAt!, space: t.space, title: t.title, ask: t.ask, outcome: "done", text: "" }) as JournalEntry));
}

/** what one call was given: `fresh` jobs are new, `learn` may be learned from */
const seenOf = (tasks: Task[], fresh: string[], learn: string[] = []) => {
  const f = new Set(fresh), l = new Set(learn);
  const g = jobsShown(tasks, f, l);
  return { space: "work", shown: g.shown, mats: g.mats, fresh: f, learn: l };
};
const run = (plan: Plan, fresh: string[], learn: string[] = []) => applyPlan(plan, state.memory.filter((m) => !m.invalidAt), seenOf(state.tasks, fresh, learn));
const byText = (t: string) => state.memory.find((m) => m.text === t);

describe("what the pass reads about a job", () => {
  it("has the harness notes, failed commands with their error line, the error and how long it took", () => {
    const t = job("a", {
      finishedAt: 12 * 60_000,
      status: "failed",
      error: "dev 서버가 뜨지 않았어요\n자세한 내용",
      entries: [
        note("같은 실패 반복"),
        note("같은 실패 반복"),
        note("검색 멈춤 · 1분 넘게 결과 없음"),
        note("작업 전용 브랜치 x에서 시작해요"),
        { id: "t1", at: 1, kind: "tool", tool: { name: "bash", kind: "bash", target: "pnpm dev --port 3217", ok: false, shellId: "s1" } },
        { id: "t2", at: 2, kind: "tool", tool: { name: "bash", kind: "bash", target: "pnpm build", ok: true } },
      ],
      shells: [{ id: "s1", command: "pnpm dev", startedAt: 0, tail: "> vite\nError: listen EADDRINUSE: address already in use :::3217\n" }],
    });
    const m = jobMaterial(t, true);
    const all = Object.fromEntries(m.lines);
    expect(m.head).toContain("took 12m");
    expect(m.head).toContain("~/Work/acme");
    expect(all.Notes).toBe("같은 실패 반복 ×2 · 검색 멈춤 · 1분 넘게 결과 없음");
    expect(all.Failed).toBe("pnpm dev --port 3217");
    expect(all.Output).toContain("EADDRINUSE");
    expect(all.Error).toBe("dev 서버가 뜨지 않았어요");
    expect(all.Notes).not.toContain("브랜치");
  });

  it("finds a quote only in the job lines, whitespace and quote marks aside", () => {
    const m = jobMaterial(job("a", { summary: "pnpm test 전에   pnpm build를\n먼저 돌려야 했어요" }), true);
    expect(grounded("pnpm test 전에 pnpm build를 먼저", [m])).toBe(true);
    expect(grounded("Result: `pnpm test` 전에", [m])).toBe(true);
    expect(grounded("pnpm test 전에 pnpm build가 필요해요", [m])).toBe(false);
    expect(grounded("## job", [m])).toBe(false);
    expect(grounded("전에", [m])).toBe(false);
    expect(grounded(undefined, [m])).toBe(false);
  });
});

describe("grounding: a piece learned from jobs carries a quote that is really there", () => {
  it("drops a learned piece whose quote isn't in its job, keeps one whose quote is, with its source", () => {
    reset([], [job("a", { summary: "acme는 pnpm build를 먼저 해야 pnpm test가 돌아가요. 그래서 순서를 바꿨어요." })]);
    const n = run(
      {
        learn: [
          { job: "a", quote: "acme는 yarn을 써요", text: "acme는 yarn으로 설치해요", kind: "fact" },
          { job: "a", quote: "pnpm build를 먼저 해야  pnpm test가", text: "acme는 pnpm test 전에 pnpm build가 필요해요", kind: "procedure", project: true },
        ],
      },
      ["a"],
      ["a"],
    );
    expect(n.dropped).toBe(1);
    expect(byText("acme는 yarn으로 설치해요")).toBeUndefined();
    const m = byText("acme는 pnpm test 전에 pnpm build가 필요해요")!;
    expect(m).toMatchObject({ sources: ["a"], taskId: "a", by: "agent", scope: "project", project: "~/Work/acme" });
    expect(state.journal!.find((j) => j.taskId === "a")!.learned).toEqual([m.id]);
  });

  it("drops a learned piece without a quote, and one from a job it may not learn from", () => {
    reset([], [job("a"), job("b")]);
    run({ learn: [{ job: "a", text: "따옴표 없이 배운 것이에요" }, { job: "b", quote: "테스트를 고쳤고", text: "b에서 배운 것이에요" }] }, ["a", "b"], ["a"]);
    expect(state.memory).toHaveLength(0);
  });
});

describe("patterns across finished jobs", () => {
  const port = "dev 서버는 3217 포트를 써요 — 이미 떠 있으면 다시 띄우지 말고 curl로 확인해요";
  const three = () => [
    job("c", { finishedAt: 3 * H, entries: [note("기다림 멈춤 · 2분 넘게 변화 없음")] }),
    job("b", { finishedAt: 2 * H, summary: "3217 포트가 이미 사용 중이라 서버를 다시 띄우지 못했어요. curl로 확인했어요." }),
    job("a", { finishedAt: 1 * H }),
  ];

  it(`needs ${MIN_EVIDENCE} different jobs`, () => {
    reset([], three());
    const n = run({ patterns: [{ jobs: ["b", "c", "c", "nope"], quote: "3217 포트가 이미 사용 중", text: port, kind: "procedure" }] }, ["c"]);
    expect(n.dropped).toBe(1);
    expect(state.memory).toHaveLength(0);
  });

  it("needs a new job among them (old evidence alone was read before)", () => {
    reset([], three());
    run({ patterns: [{ jobs: ["a", "b", "c"], quote: "3217 포트가 이미 사용 중", text: port }] }, []);
    expect(state.memory).toHaveLength(0);
  });

  it("needs its quote in one of the jobs it cites", () => {
    reset([], [...three(), job("d", { finishedAt: 0.5 * H, summary: "3217 포트가 이미 사용 중이었어요" })]);
    run({ patterns: [{ jobs: ["a", "c", "d"], quote: "3217 포트가 이미 사용 중이라", text: port }] }, ["c"]);
    expect(state.memory).toHaveLength(0);
  });

  it("files one piece citing every job, newest first, and tells each 일 기록 entry", () => {
    reset([], three());
    const n = run({ patterns: [{ jobs: ["a", "b", "c"], quote: "3217 포트가 이미 사용 중이라", text: port, kind: "procedure", project: true }] }, ["c"]);
    expect(n.learned).toBe(1);
    const m = byText(port)!;
    expect(m.sources).toEqual(["c", "b", "a"]);
    expect(m.scope).toBe("project");
    for (const id of ["a", "b", "c"]) expect(state.journal!.find((j) => j.taskId === id)!.learned).toContain(m.id);
  });

  it("keeps the evidence window to what fits, new jobs first", () => {
    const busy = Array.from({ length: 4 }, (_, k): Entry => ({ id: `f${k}`, at: k, kind: "tool", tool: { name: "bash", kind: "bash", target: `pnpm run step-${k} ${"x".repeat(90)}`, ok: false } }));
    const many = Array.from({ length: 40 }, (_, i) => job(`j${i}`, { finishedAt: (40 - i) * H, summary: "가".repeat(900), error: "나".repeat(300), entries: busy }));
    const g = jobsShown(many.slice(0, 30), new Set(["j0"]), new Set(["j0"]));
    expect(g.shown[0].id).toBe("j0");
    expect(g.shown.length).toBeLessThan(30);
    expect(g.text.join("\n").length).toBeLessThanOrEqual(16_000);
  });
});

describe("a merged piece keeps where both came from", () => {
  it("unions sources on merge", () => {
    reset([piece({ id: "k", text: "acme는 pnpm을 써요", sources: ["a", "b"] }), piece({ id: "d", text: "acme 패키지는 pnpm으로 설치해요", taskId: "c" })]);
    run({ merge: [{ keep: "k", drop: ["d"] }] }, []);
    expect(state.memory.find((m) => m.id === "k")!.sources).toEqual(["a", "b", "c"]);
    expect(state.memory.find((m) => m.id === "d")!.invalidAt).toBeTruthy();
  });

  it("unions sources when the same thing is learned again", () => {
    reset([piece({ id: "k", text: "acme는 pnpm test 전에 pnpm build가 필요해요", sources: ["a"] })]);
    addMemory("acme는 pnpm test 전에 pnpm build가 필요해요", "space", { space: "work", by: "agent", sources: ["b", "c"], quiet: true });
    expect(state.memory).toHaveLength(1);
    expect(state.memory[0].sources).toEqual(["a", "b", "c"]);
  });

  it("leaves older pieces without sources as they were", () => {
    reset([piece({ id: "k", text: "배포는 금요일에 하지 않아요" })]);
    run({ keys: { k: ["deploy", "배포"] } }, []);
    expect(state.memory[0].sources).toBeUndefined();
  });
});

describe("what goes against the user's own pieces waits for the user", () => {
  const user = () => piece({ id: "u", text: "acme는 npm으로 설치해요", by: "user", kind: "rule", createdAt: 1 });
  const auto = () => piece({ id: "x", text: "acme는 pnpm으로 설치해요", createdAt: 5, sources: ["a"] });

  it("never merges away, rewords or retires the user's piece", () => {
    reset([user(), auto()]);
    run({ merge: [{ keep: "x", drop: ["u"] }, { keep: "u", drop: [], text: "다른 말" }], retire: [{ id: "u", by: "x" }] }, []);
    const u = state.memory.find((m) => m.id === "u")!;
    expect(u).toMatchObject({ text: "acme는 npm으로 설치해요", kind: "rule", by: "user" });
    expect(u.invalidAt).toBeUndefined();
  });

  it("holds a kept piece that contradicts the user's out of use and asks, once", () => {
    reset([user(), auto()]);
    const n = run({ retire: [{ id: "u", by: "x" }], conflict: [{ mine: "u", new: "x" }] }, []);
    expect(n.held).toBe(1);
    expect(n.retired).toBe(0);
    expect(state.memory.find((m) => m.id === "x")!.invalidAt).toBeTruthy();
    expect(conflictsIn("work")).toMatchObject([{ mine: "u", theirs: "x" }]);
  });

  it("a user's piece that is newer simply wins over the learned one", () => {
    reset([piece({ ...user(), createdAt: 9 }), auto()]);
    run({ retire: [{ id: "x", by: "u" }] }, []);
    expect(state.memory.find((m) => m.id === "x")!.invalidAt).toBeTruthy();
    expect(conflictsIn("work")).toHaveLength(0);
  });

  it("doesn't save a learned piece against the user's; keep mine drops it and it isn't asked again", () => {
    reset([user()], [job("a", { summary: "pnpm-lock.yaml이 있어서 pnpm install로 설치했어요. 잘 돌아가요. 끝." })]);
    const plan: Plan = { learn: [{ job: "a", quote: "pnpm install로 설치했어요", text: "acme는 pnpm으로 설치해요", against: "u" }] };
    expect(run(plan, ["a"], ["a"]).held).toBe(1);
    expect(byText("acme는 pnpm으로 설치해요")).toBeUndefined();
    const [c] = conflictsIn("work");
    expect(c).toMatchObject({ mine: "u", text: "acme는 pnpm으로 설치해요", sources: ["a"] });
    keepMine(c.id);
    expect(conflictsIn("work")).toHaveLength(0);
    expect(run(plan, ["a"], ["a"]).held).toBe(0);
    expect(state.memory.map((m) => m.id)).toEqual(["u"]);
    expect(state.memory[0].invalidAt).toBeUndefined();
  });

  it("an ungrounded piece against the user's isn't even asked", () => {
    reset([user()], [job("a")]);
    run({ learn: [{ job: "a", quote: "없는 말이에요 정말", text: "acme는 pnpm으로 설치해요", against: "u" }] }, ["a"], ["a"]);
    expect(conflictsIn("work")).toHaveLength(0);
  });

  it("use the new one: saves it with its sources and retires the user's, replaced by it", () => {
    reset([user()], [job("a", { summary: "pnpm-lock.yaml이 있어서 pnpm install로 설치했어요. 잘 돌아가요. 끝." })]);
    run({ learn: [{ job: "a", quote: "pnpm install로 설치했어요", text: "acme는 pnpm으로 설치해요", kind: "fact", against: "u" }] }, ["a"], ["a"]);
    useNew(conflictsIn("work")[0].id);
    const m = byText("acme는 pnpm으로 설치해요")!;
    expect(m).toMatchObject({ by: "agent", sources: ["a"] });
    expect(m.invalidAt).toBeUndefined();
    expect(state.memory.find((x) => x.id === "u")).toMatchObject({ supersededBy: m.id, text: "acme는 npm으로 설치해요" });
    expect(state.memory.find((x) => x.id === "u")!.invalidAt).toBeTruthy();
    expect(conflictsIn("work")).toHaveLength(0);
  });

  it("use the new one on a held piece: it comes back, the user's is retired", () => {
    reset([user(), auto()]);
    run({ conflict: [{ mine: "u", new: "x" }] }, []);
    useNew(conflictsIn("work")[0].id);
    expect(state.memory.find((m) => m.id === "x")!.invalidAt).toBeUndefined();
    expect(state.memory.find((m) => m.id === "u")).toMatchObject({ supersededBy: "x" });
  });

  it("undo after use new: yours back as it was, the new one gone, asked again", () => {
    reset([user()], [job("a", { summary: "pnpm-lock.yaml이 있어서 pnpm install로 설치했어요. 잘 돌아가요. 끝." })]);
    run({ learn: [{ job: "a", quote: "pnpm install로 설치했어요", text: "acme는 pnpm으로 설치해요", kind: "fact", against: "u" }] }, ["a"], ["a"]);
    const before = JSON.stringify(state.memory);
    const undo = useNew(conflictsIn("work")[0].id)!;
    expect(byText("acme는 pnpm으로 설치해요")).toBeTruthy();
    undo();
    expect(JSON.stringify(state.memory)).toBe(before);
    expect(conflictsIn("work")).toMatchObject([{ mine: "u", text: "acme는 pnpm으로 설치해요" }]);
  });

  it("undo after use new on a held piece: it is held again", () => {
    reset([user(), auto()]);
    run({ conflict: [{ mine: "u", new: "x" }] }, []);
    const undo = useNew(conflictsIn("work")[0].id)!;
    undo();
    expect(state.memory.find((m) => m.id === "x")!.invalidAt).toBeTruthy();
    expect(state.memory.find((m) => m.id === "u")!.invalidAt).toBeUndefined();
    expect(state.memory.find((m) => m.id === "u")!.supersededBy).toBeUndefined();
    expect(conflictsIn("work")).toMatchObject([{ mine: "u", theirs: "x" }]);
  });

  it("a piece brought back isn't counted as used", () => {
    reset([user(), auto()]);
    run({ conflict: [{ mine: "u", new: "x" }] }, []);
    useNew(conflictsIn("work")[0].id);
    expect(state.memory.find((m) => m.id === "x")!.lastUsed).toBeUndefined();
  });

  it("says what the pass did in one line", () => {
    setState("settings", "language", "ko");
    expect(tidyParts({ learned: 3, merged: 1, retired: 1, held: 1 }).join(" · ")).toBe("새 메모리 3 · 병합 1 · 내림 1 · 물어봄 1");
  });
});
