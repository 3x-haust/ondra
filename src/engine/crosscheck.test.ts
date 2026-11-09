import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Memory, Task } from "../state/types";
import { disagreements, reviewSettled } from "./crosscheck";
import { reviewUnresolved } from "./proof";
import { handoffPrompt, taskPrompt } from "./prompts";
import { startRpc } from "./rpc";
import { pauseTask, startTask } from "./tasks";
import { conflictsIn } from "./tidy";

const job = (over: Partial<Task> = {}): Task => ({
  id: "job", space: "home", topic: "Example", title: "Login fix",
  ask: "Fix the login token refresh.", cwd: "/workspace/example", status: "queued",
  priority: 2, weight: "light", accountId: "default", createdAt: 1,
  now: "", plan: [], legs: [{ startedAt: 1 }], entries: [], shells: [], inbox: [],
  isolate: false, ...over,
});
const lens = (over: Partial<Task>): Task => job({ parentId: "job", review: true, legs: [], pair: "x1", ...over });
const piece = (id: string, text: string, by: "user" | "agent"): Memory => ({
  id, text, kind: "fact", scope: "space", space: "home", source: "ondra", createdAt: 1, uses: 0, by,
});
const block = (...lines: object[]) => `\`\`\`blocks\n${lines.map((l) => JSON.stringify(l)).join("\n")}\n\`\`\``;
const REVIEW = block({ type: "subagent", review: true, title: "교차 검토", task: "Review the changes in /workspace/example against: token refresh works." });
const SNAPSHOT = ["- [m_ok] 토큰은 src/auth.ts에서 갱신해요 (사실 · 11/1)", "- [m_agent] 재시도는 3번이에요 (사실 · 11/1)", "- [m_user] 로그인은 세션 쿠키를 써요 (사실 · 사용자 · 11/1)", "- [m_loose] 만료는 1시간이에요 (사실 · 11/1)", "- [m_split] 갱신은 한 번에 하나만 돌아요 (사실 · 11/1)"];
const AUTH = "export async function refresh() {\n  const retries = 5;\n  setHeader('Authorization', token);\n}\n";

/**
 * Only the native process boundary is faked: each agent answers its prompts with
 * the text `say` gives (the job asks for a review; each lens reports).
 */
async function harness(say: (agent: string, n: number) => string | { error: string } | undefined) {
  const events = new Map<string, (payload: unknown) => void>();
  vi.spyOn(native, "onEvent").mockImplementation(async (name, fn) => {
    events.set(name, fn as (payload: unknown) => void);
    return () => { events.delete(name); };
  });
  vi.spyOn(native, "agentSpawn").mockResolvedValue();
  vi.spyOn(native, "fsRead").mockImplementation(async (path) => ({ text: path.endsWith("src/auth.ts") ? AUTH : "", size: 1, binary: false }));
  const count = new Map<string, number>();
  vi.spyOn(native, "agentSend").mockImplementation(async (id, command) => {
    const emit = (ev: unknown) => events.get("agent:event")?.({ id, ev });
    emit({ id: command.id, type: "response", success: true, data: {} });
    if (command.type !== "prompt") return;
    const n = (count.get(id) ?? 0) + 1;
    count.set(id, n);
    const out = say(id, n);
    if (out === undefined) return;
    setTimeout(() => {
      const text = typeof out === "string" ? out : "";
      emit({ type: "agent_start" });
      emit({ type: "message_start", message: { role: "assistant" } });
      if (text) emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], ...(typeof out === "string" ? {} : { stopReason: "error", errorMessage: out.error }) } });
      emit({ type: "agent_settled" });
    });
  });
  await startRpc();
}
const sent = (agent: string, type = "prompt") =>
  vi.mocked(native.agentSend).mock.calls.filter(([id, c]) => id === agent && c.type === type).map(([, c]) => String((c as { message?: string }).message));
const kids = () => state.tasks.filter((t) => t.parentId === "job");
const kidAgent = (title: string) => `t:${kids().find((k) => k.title === title)?.id}`;
/** the scheduler runs only in the app: start the two lenses the job asked for here */
async function runLenses() {
  await vi.waitFor(() => expect(kids()).toHaveLength(2));
  await Promise.all(kids().map((k) => startTask(k.id)));
}

beforeEach(() => setState(reconcile(freshState())));
afterEach(() => {
  for (const t of state.tasks) pauseTask(t.id);
  vi.restoreAllMocks();
});

describe("교차 검토: one review block, two lenses", () => {
  it("starts 설계 검토 and 코드 검토 side by side, each with its lens and the job's memory", async () => {
    await harness((agent, n) => (agent === "t:job" && n === 1 ? `Reviewing.\n${REVIEW}` : undefined));
    setState("tasks", [job({ memorySnapshot: SNAPSHOT })]);
    await startTask("job", true);

    await vi.waitFor(() => expect(kids()).toHaveLength(2));
    const [design, code] = [kids().find((k) => k.lens === "design")!, kids().find((k) => k.lens === "code")!];
    expect([design.title, code.title]).toEqual(["설계 검토", "코드 검토"]);
    expect(design.review && code.review).toBe(true);
    expect(design.pair).toBeTruthy();
    expect(design.pair).toBe(code.pair);
    expect(design.ask).toContain("설계 검토 (design) lens");
    expect(code.ask).toContain("코드 검토 (code) lens");
    for (const k of [design, code]) {
      expect(k.ask).toContain("token refresh works.");
      expect(k.memorySnapshot).toEqual(SNAPSHOT);
      const prompt = taskPrompt(k);
      expect(prompt).toContain("# Memory the job was given");
      expect(prompt).toContain("[m_agent] 재시도는 3번이에요");
    }
    // one spawn row for the pair
    const spawn = state.tasks.find((t) => t.id === "job")!.entries.filter((e) => e.kind === "spawn");
    expect(spawn).toHaveLength(1);
    expect(spawn[0].kind === "spawn" && spawn[0].childIds).toEqual([design.id, code.id]);
  });

  it("sends one combined result once both are done, with where they disagree", async () => {
    await harness((agent, n) => {
      if (agent === "t:job") return n === 1 ? `Reviewing.\n${REVIEW}` : undefined;
      if (agent === kidAgent("설계 검토")) return block({ type: "done", summary: "설계 검토 끝", result: "## 설계 (Design)\n- P1 `src/auth.ts:2` — 재시도가 갱신 경합을 만들어요 → 한 번만" });
      if (agent === kidAgent("코드 검토")) return block({ type: "done", summary: "코드 검토 끝", result: "## 요구사항 (Spec)\n- P3 `src/auth.ts:3` — 이름이 모호해요\n## 코드 규칙 (Standards)\nP1·P2 없음" });
    });
    setState("tasks", [job({ memorySnapshot: SNAPSHOT })]);
    await startTask("job", true);

    await runLenses();
    await vi.waitFor(() => expect(sent("t:job")).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 20));
    const all = [...sent("t:job"), ...sent("t:job", "follow_up")];
    const combined = all.filter((m) => m.includes("교차 검토 결과가 왔어요"));
    expect(combined).toHaveLength(1);
    const m = combined[0];
    expect(m).toContain("# 설계 검토\n## 설계 (Design)\n- P1 `src/auth.ts:2`");
    expect(m).toContain("# 코드 검토\n## 요구사항 (Spec)");
    expect(m).toContain("# 두 검토가 갈리는 곳\n- `src/auth.ts:2` — 설계 P1 · 코드 P3");
    expect(m).toContain("그 지점 하나만 직접 확인해서");
    expect(m).toContain("리뷰를 다시 띄우지 말고");
    expect(m).toContain("P1·P2만 고쳐 줘");
    expect(m).not.toContain("빠졌어요");
  });

  it("doesn't wait on a failed lens: the result names the one that's missing", async () => {
    await harness((agent, n) => {
      if (agent === "t:job") return n === 1 ? `Reviewing.\n${REVIEW}` : undefined;
      if (agent === kidAgent("설계 검토")) return { error: "provider exploded" };
      if (agent === kidAgent("코드 검토")) return block({ type: "done", summary: "끝", result: "## 요구사항 (Spec)\nP1·P2 없음" });
    });
    setState("tasks", [job()]);
    await startTask("job", true);
    await runLenses();

    await vi.waitFor(() => expect(sent("t:job").some((m) => m.includes("교차 검토 결과가 왔어요"))).toBe(true));
    const m = sent("t:job").find((x) => x.includes("교차 검토 결과가 왔어요"))!;
    expect(m).toContain("# 설계 검토\n(빠졌어요: 실패 — provider exploded)");
    expect(m).toContain("# 코드 검토\n## 요구사항 (Spec)\nP1·P2 없음");
    expect(m).toContain('설계 검토는 빠졌어요: 다시 띄우지 말고 done의 unverified에 "설계 검토 빠짐"');
    expect(m).not.toContain("# 두 검토가 갈리는 곳");
    expect(kids().map((k) => k.status).sort()).toEqual(["done", "failed"]);
  });
});

describe("one review per job counts the pair as one", () => {
  const steers = () => sent("t:job", "steer");
  const ask = async (existing: Task[]) => {
    await harness((agent, n) => (agent === "t:job" && n === 1 ? `Again.\n${REVIEW}` : undefined));
    setState("tasks", [job(), ...existing]);
    await startTask("job", true);
  };

  it("a pair still going: no new lenses, the job waits for it", async () => {
    await ask([lens({ id: "d", lens: "design", title: "설계 검토", status: "done", result: "P1·P2 없음" }), lens({ id: "c", lens: "code", title: "코드 검토", status: "running" })]);
    await vi.waitFor(() => expect(steers()).toHaveLength(1));
    expect(steers()[0]).toContain('A review is already running ("교차 검토")');
    expect(kids()).toHaveLength(2);
  });

  it("a pair that's over: both lenses' findings, no new review", async () => {
    await ask([lens({ id: "d", lens: "design", title: "설계 검토", status: "done", result: "## 설계 (Design)\n- P2 `a.ts:1` — x" }), lens({ id: "c", lens: "code", title: "코드 검토", status: "failed", error: "boom" })]);
    await vi.waitFor(() => expect(steers()).toHaveLength(1));
    expect(steers()[0]).toContain('already reviewed once ("교차 검토")');
    expect(steers()[0]).toContain("# 설계 검토\n## 설계 (Design)\n- P2 `a.ts:1`");
    expect(steers()[0]).toContain("# 코드 검토\n(빠졌어요: 실패 — boom)");
    expect(kids()).toHaveLength(2);
  });

  it("both lenses failed: the review can start once more", async () => {
    await ask([lens({ id: "d", lens: "design", title: "설계 검토", status: "failed" }), lens({ id: "c", lens: "code", title: "코드 검토", status: "failed" })]);
    await vi.waitFor(() => expect(kids()).toHaveLength(4));
    expect(steers()).toHaveLength(0);
  });

  it("the gate counts a review as done only when no lens of it is still going", () => {
    const d = lens({ id: "d", lens: "design", status: "done" });
    expect(reviewSettled([d, lens({ id: "c", lens: "code", status: "running" })])).toBe(false);
    expect(reviewSettled([d, lens({ id: "c", lens: "code", status: "failed" })])).toBe(true);
    expect(reviewSettled([job({ id: "old", parentId: "job", review: true, status: "done" })])).toBe(true);
  });

  it("a P1 from either lens is unresolved until code changes after the pair", () => {
    const t = job();
    const pair = [
      lens({ id: "d", lens: "design", status: "done", result: "- P1 `a.ts:1` — x", finishedAt: 10 }),
      lens({ id: "c", lens: "code", status: "done", result: "P1·P2 없음", finishedAt: 20 }),
    ];
    expect(reviewUnresolved(t, pair)).toBe(true);
    t.entries = [{ id: "e", at: 30, kind: "tool", tool: { id: "x", name: "edit", kind: "edit", target: "a.ts", detail: "/workspace/example/a.ts", startedAt: 30, endedAt: 31, ok: true } } as Task["entries"][number]];
    expect(reviewUnresolved(t, pair)).toBe(false);
  });
});

describe("memory is checked, not trusted", () => {
  it("stamps confirmed, retires an agent's wrong piece, asks about the user's, drops the ungrounded", async () => {
    await harness((agent, n) => {
      if (agent === "t:job") return n === 1 ? `Reviewing.\n${REVIEW}` : undefined;
      if (agent === kidAgent("설계 검토"))
        return block(
          { type: "memory-check", items: [
            { id: "m_ok", status: "confirmed", evidence: "src/auth.ts:1 `export async function refresh()`" },
            { id: "m_split", status: "confirmed", evidence: "src/auth.ts:1 `refresh()`" },
            { id: "m_other", status: "contradicted", evidence: "src/auth.ts:2 `const retries = 5`", now: "x" },
          ] },
          { type: "done", summary: "끝", result: "## 설계 (Design)\nP1·P2 없음" },
        );
      if (agent === kidAgent("코드 검토"))
        return block(
          { type: "memory-check", items: [
            { id: "m_agent", status: "contradicted", evidence: "src/auth.ts:2 `const retries = 5`", now: "재시도는 5번이에요" },
            { id: "m_user", status: "contradicted", evidence: "src/auth.ts:3 `setHeader('Authorization', token)`", now: "로그인은 Authorization 헤더 토큰을 써요" },
            { id: "m_loose", status: "contradicted", evidence: "아마 30분일 거예요", now: "만료는 30분이에요" },
            { id: "m_split", status: "contradicted", evidence: "src/auth.ts:2 `const retries = 5`", now: "y" },
          ] },
          { type: "done", summary: "끝", result: "## 요구사항 (Spec)\nP1·P2 없음" },
        );
    });
    setState("memory", [
      piece("m_ok", "토큰은 src/auth.ts에서 갱신해요", "agent"),
      piece("m_agent", "재시도는 3번이에요", "agent"),
      piece("m_user", "로그인은 세션 쿠키를 써요", "user"),
      piece("m_loose", "만료는 1시간이에요", "agent"),
      piece("m_split", "갱신은 한 번에 하나만 돌아요", "agent"),
      piece("m_other", "not given to the job", "agent"),
    ]);
    setState("tasks", [job({ memorySnapshot: SNAPSHOT })]);
    await startTask("job", true);
    await runLenses();

    await vi.waitFor(() => expect(sent("t:job").some((m) => m.includes("교차 검토 결과가 왔어요"))).toBe(true));
    const mem = (id: string) => state.memory.find((m) => m.id === id)!;
    expect(mem("m_ok").verifiedAt).toBeGreaterThan(0);
    expect(mem("m_agent").invalidAt).toBeGreaterThan(0);
    expect(mem("m_agent").why).toContain("교차 검토에서 코드와 달라서 내렸어요 · src/auth.ts:2");
    // the user's own piece is never changed: it waits in 확인 필요
    expect(mem("m_user").invalidAt).toBeUndefined();
    expect(mem("m_user").text).toBe("로그인은 세션 쿠키를 써요");
    expect(conflictsIn("home")).toEqual([expect.objectContaining({ mine: "m_user", text: "로그인은 Authorization 헤더 토큰을 써요", sources: ["job"] })]);
    // no quote, or not given to the job: nothing happens
    expect(mem("m_loose").invalidAt).toBeUndefined();
    expect(mem("m_other").invalidAt).toBeUndefined();
    // the lenses disagree: left alone, named for the job
    expect(mem("m_split").invalidAt).toBeUndefined();
    expect(mem("m_split").verifiedAt).toBeUndefined();
    const m = sent("t:job").find((x) => x.includes("교차 검토 결과가 왔어요"))!;
    expect(m).toContain("- 메모리 [m_split] — 설계: 맞음 · 코드: 틀림 (src/auth.ts:2 `const retries = 5`)");
    expect(m).toContain("# 메모리 확인\n- 맞음 1개 (확인 표시함) · 틀린 에이전트 메모리 1개 내림 · 사용자 메모리 1개는 코드와 달라 확인 필요에 올림 (사용자가 정해요) · 근거 없어 버림 2개");
  });

  it("drops a quote that isn't in the file it cites", async () => {
    const { grounded } = await import("./memcheck");
    vi.spyOn(native, "fsRead").mockResolvedValue({ text: AUTH, size: 1, binary: false });
    expect(await grounded("src/auth.ts:2 `const retries = 5`", "/w")).toBe(true);
    expect(await grounded("src/auth.ts:2 `const retries = 9`", "/w")).toBe(false);
    expect(await grounded("`const retries = 5`", "/w")).toBe(false);
    expect(await grounded("src/auth.ts:2", "/w")).toBe(false);
  });
});

describe("disagreements", () => {
  it("lines up the same place judged differently, not agreement or other places", () => {
    expect(disagreements("- P1 `a.ts:10` — x\n- P2 `b.ts:5` — y", "- P3 `a.ts:12` — x\n- P2 `b.ts:5` — y\n- P1 `c.ts:1` — z")).toEqual(["- `a.ts:10` — 설계 P1 · 코드 P3"]);
    expect(disagreements("P1·P2 없음", "- P1 `a.ts:1` — x")).toEqual([]);
  });
});

describe("a resumed job sees both lenses", () => {
  it("lists the pair once with each lens's findings", () => {
    setState("tasks", [
      job({ legs: [{ startedAt: 1, endedAt: 2, handoff: { did: ["Fixed refresh"], next: "Ship", evidence: [] } }, { startedAt: 3 }] }),
      lens({ id: "d", lens: "design", title: "설계 검토", status: "done", result: "## 설계 (Design)\n- P2 `src/auth.ts:2` — 경합" }),
      lens({ id: "c", lens: "code", title: "코드 검토", status: "failed", error: "boom" }),
    ]);
    const p = handoffPrompt(state.tasks[0]);
    expect(p).toContain('- review "교차 검토": done (설계 검토 done, 코드 검토 failed).');
    expect(p).toContain("# 설계 검토\n## 설계 (Design)\n- P2 `src/auth.ts:2` — 경합");
    expect(p).toContain("# 코드 검토\n(빠졌어요: 실패 — boom)");
    expect(p.match(/review "교차 검토"/g)).toHaveLength(1);
  });

  it("says a pair still going comes back by itself", () => {
    setState("tasks", [
      job({ legs: [{ startedAt: 1, endedAt: 2, handoff: { did: ["x"], next: "y", evidence: [] } }, { startedAt: 3 }] }),
      lens({ id: "d", lens: "design", title: "설계 검토", status: "done", result: "P1·P2 없음" }),
      lens({ id: "c", lens: "code", title: "코드 검토", status: "running" }),
    ]);
    expect(handoffPrompt(state.tasks[0])).toContain('- review "교차 검토": still running (설계 검토 done, 코드 검토 running). Its combined result comes to you by itself');
  });
});

const PLAN = block({ type: "subagent", plan_review: true, title: "계획 검토", task: "Add webhook retries.\n\n1. src/hooks.ts: retry 3 times with backoff." });

describe("계획 검토: two fresh readers of the plan before building", () => {
  it("starts 범위 검토 and 실행 검토 with the plan only, as neither a code review nor a memory check", async () => {
    await harness((agent, n) => (agent === "t:job" && n === 1 ? `Planning.\n${PLAN}` : undefined));
    setState("tasks", [job({ memorySnapshot: SNAPSHOT })]);
    await startTask("job", true);

    await vi.waitFor(() => expect(kids()).toHaveLength(2));
    const [scope, fit] = [kids().find((k) => k.lens === "scope")!, kids().find((k) => k.lens === "fit")!];
    expect([scope.title, fit.title]).toEqual(["범위 검토", "실행 검토"]);
    expect(scope.pair).toBe(fit.pair);
    expect(scope.review || fit.review).toBeFalsy();
    for (const k of [scope, fit]) {
      expect(k.ask).toContain("retry 3 times with backoff");
      expect(k.ask).toContain("not the conversation");
      expect(k.memorySnapshot).toBeUndefined();
      expect(taskPrompt(k)).not.toContain("# Memory the job was given");
    }
    expect(fit.ask).toContain("in your own words");
  });

  it("sends one plan result telling the job to fix the plan, ask once, then build", async () => {
    await harness((agent, n) => {
      if (agent === "t:job") return n === 1 ? `Planning.\n${PLAN}` : n === 2 ? `Again.\n${PLAN}` : undefined;
      if (agent === kidAgent("범위 검토")) return block({ type: "done", summary: "끝", result: "- P2 `src/retry.ts:1` — 이미 재시도 함수가 있어요 → 그걸 써요" });
      if (agent === kidAgent("실행 검토")) return block({ type: "done", summary: "끝", result: "- 질문: 실패한 웹훅을 버릴지 쌓아둘지" });
    });
    setState("tasks", [job()]);
    await startTask("job", true);
    await runLenses();

    await vi.waitFor(() => expect([...sent("t:job"), ...sent("t:job", "follow_up")].some((m) => m.includes("계획 검토 결과가 왔어요"))).toBe(true));
    const m = [...sent("t:job"), ...sent("t:job", "follow_up")].find((x) => x.includes("계획 검토 결과가 왔어요"))!;
    expect(m).toContain("# 범위 검토\n- P2 `src/retry.ts:1`");
    expect(m).toContain("# 실행 검토\n- 질문:");
    expect(m).toContain("decision 하나로 묻고");
    expect(m).not.toContain("교차 검토");
    expect(m).not.toContain("P1·P2만 고쳐 줘");
    // a second plan review is refused, and no new readers start
    await new Promise((r) => setTimeout(r, 30));
    expect(kids()).toHaveLength(2);
  });

  it("doesn't count as the job's code review", async () => {
    await harness((agent, n) => (agent === "t:job" && n === 1 ? `Planning.\n${PLAN}\n${REVIEW}` : undefined));
    setState("tasks", [job()]);
    await startTask("job", true);
    await vi.waitFor(() => expect(kids()).toHaveLength(4));
    expect(kids().map((k) => k.lens).sort()).toEqual(["code", "design", "fit", "scope"]);
  });
});
