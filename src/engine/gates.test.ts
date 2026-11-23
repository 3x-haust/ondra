import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Entry, Task } from "../state/types";
import { startRpc } from "./rpc";
import { blocking, decide, endOrphanKids, pauseTask, PLAN_NUDGES, PLAN_QUIET, PLAN_QUIET_MS, startTask, tell } from "./tasks";

const job = (over: Partial<Task> = {}): Task => ({
  id: "job", space: "home", topic: "Example", title: "Total fix",
  ask: "Fix the incorrect total.", cwd: "/workspace/example", status: "queued",
  priority: 2, weight: "light", accountId: "default", createdAt: 1,
  now: "", plan: [], legs: [{ startedAt: 1 }], entries: [], shells: [], inbox: [],
  isolate: false, ...over,
});
const block = (...lines: object[]) => `\`\`\`blocks\n${lines.map((l) => JSON.stringify(l)).join("\n")}\n\`\`\``;
const tool = (id: string, at: number, kind: "bash" | "edit", detail: string): Entry => ({ id, at, kind: "tool", tool: { name: kind, kind, target: detail, detail, ok: true } });

type Emit = (ev: unknown) => void;
/** Only the native process boundary is faked: `turn` plays one model turn for an agent's nth prompt. */
async function harness(turn: (agent: string, n: number, emit: Emit) => void) {
  const events = new Map<string, (payload: unknown) => void>();
  vi.spyOn(native, "onEvent").mockImplementation(async (name, fn) => {
    events.set(name, fn as (payload: unknown) => void);
    return () => { events.delete(name); };
  });
  vi.spyOn(native, "agentSpawn").mockResolvedValue();
  vi.spyOn(native, "fsRead").mockResolvedValue({ text: "", size: 1, binary: false });
  const count = new Map<string, number>();
  vi.spyOn(native, "agentSend").mockImplementation(async (id, command) => {
    const emit: Emit = (ev) => events.get("agent:event")?.({ id, ev });
    emit({ id: command.id, type: "response", success: true, data: {} });
    if (command.type !== "prompt") return;
    const n = (count.get(id) ?? 0) + 1;
    count.set(id, n);
    setTimeout(() => turn(id, n, emit));
  });
  await startRpc();
}
const sent = (agent: string, type: string) =>
  vi.mocked(native.agentSend).mock.calls.filter(([id, c]) => id === agent && c.type === type).map(([, c]) => String((c as { message?: string }).message));
const say = (emit: Emit, text: string) => {
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
};
const bashCalls = (emit: Emit, n: number) => {
  for (let i = 0; i < n; i++) {
    emit({ type: "tool_execution_start", toolCallId: `c${i}`, toolName: "bash", args: { command: `rg -n total src/part${i}.ts` } });
    emit({ type: "tool_execution_end", toolCallId: `c${i}`, toolName: "bash", result: { content: [{ type: "text", text: "" }] }, isError: false });
  }
};

beforeEach(() => setState(reconcile(freshState())));
afterEach(() => {
  for (const t of state.tasks) pauseTask(t.id);
  vi.restoreAllMocks();
});

describe("proof gate", () => {
  it("only a claim with nothing behind it blocks", () => {
    expect((["no-run", "failed", "missing"] as const).map((check) => blocking({ kind: "test", ref: "x", check }))).toEqual([true, true, true]);
    expect((["stale", "unread", "ran", "exists"] as const).map((check) => blocking({ kind: "test", ref: "x", check }))).toEqual([false, false, false, false]);
    // a screenshot from before the last edit shows old code: still sent back
    expect(blocking({ kind: "shot", ref: "/a.png", check: "stale" })).toBe(true);
    expect(blocking({ kind: "link", ref: "https://x.dev", check: "unread" })).toBe(false);
  });

  it("finishes a job whose test ran before its last edit, listing it as unverified instead of sending it back", async () => {
    const done = block({ type: "done", summary: "합계를 고쳤어요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }] });
    await harness((agent, n, emit) => {
      if (agent !== "t:job") return;
      emit({ type: "agent_start" });
      if (n === 1) say(emit, `고쳤어요.\n${done}`);
      emit({ type: "agent_settled" });
    });
    setState("tasks", [job({ entries: [tool("e1", 1, "bash", "pnpm test"), tool("e2", 2, "edit", "/workspace/example/src/total.ts")] })]);
    await startTask("job", true);

    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(sent("t:job", "prompt").some((m) => m.includes("끝내기 전에"))).toBe(false);
    expect(state.tasks[0].unverified).toEqual(["pnpm test · 돌린 뒤에 코드가 바뀌었어요"]);
  });

  it("sends back a job that cites a test it never ran", async () => {
    const done = block({ type: "done", summary: "합계를 고쳤어요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }] });
    await harness((agent, n, emit) => {
      if (agent !== "t:job") return;
      emit({ type: "agent_start" });
      if (n === 1) say(emit, `고쳤어요.\n${done}`);
      emit({ type: "agent_settled" });
    });
    setState("tasks", [job({ entries: [tool("e2", 2, "edit", "/workspace/example/src/total.ts")] })]);
    await startTask("job", true);

    await vi.waitFor(() => expect(sent("t:job", "prompt").some((m) => m.includes("끝내기 전에 빠진 게 있어요"))).toBe(true));
    expect(sent("t:job", "prompt").find((m) => m.includes("끝내기 전에"))).toContain("돌린 기록이 없어요");
  });
});

describe("what a job leaves unchecked comes with why", () => {
  const ran = (at: number, cmd: string): Entry => tool(`b${at}`, at, "bash", cmd);
  const finish = async (over: Partial<Task>, done: object, extra = "") => {
    await harness((agent, n, emit) => {
      if (agent !== "t:job") return;
      emit({ type: "agent_start" });
      if (n === 1) say(emit, `고쳤어요.${extra}\n${block(done)}`);
      emit({ type: "agent_settled" });
    });
    setState("tasks", [job(over)]);
    await startTask("job", true);
  };
  const backs = () => sent("t:job", "prompt").filter((m) => m.includes("끝내기 전에"));

  it("sends back an unverified item that has no reason, naming what can still be done", async () => {
    await finish(
      { entries: [tool("e1", 1, "edit", "/workspace/example/src/total.ts"), ran(2, "pnpm test")] },
      { type: "done", summary: "합계를 고쳤어요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }], unverified: ["스크린샷을 PR 본문에 첨부하지 않음"] },
    );
    await vi.waitFor(() => expect(backs()).toHaveLength(1));
    expect(backs()[0]).toContain("«스크린샷을 PR 본문에 첨부하지 않음»");
    expect(backs()[0]).toContain("지금 하고 evidence에 넣어 줘");
  });

  const held = () => sent("t:job", "prompt").filter((m) => m.includes("Don't finish yet"));
  const ask = (question: string, ...options: string[]) => "```blocks\n" + JSON.stringify({ type: "ask", question, options: options.map((label) => ({ label })) }) + "\n```";

  it("with something unchecked, doesn't finish: it asks the user first, and finishes once they answered", async () => {
    const done = { type: "done", summary: "합계를 고쳤어요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }], unverified: [{ what: "실제 결제 화면", why: "사용자 계정 로그인이 필요해요" }] };
    await harness((agent, n, emit) => {
      if (agent !== "t:job") return;
      emit({ type: "agent_start" });
      if (n === 1) say(emit, `고쳤어요.\n${block(done)}`);
      if (n === 2) say(emit, ask("결제 화면은 로그인이 필요해서 못 봤어요. 어떻게 할까요?", "직접 확인할게요", "확인 없이 끝내기"));
      if (n === 3) say(emit, `알겠어요.\n${block(done)}`);
      emit({ type: "agent_settled" });
    });
    setState("tasks", [job({ entries: [tool("e1", 1, "edit", "/workspace/example/src/total.ts"), ran(2, "pnpm test")] })]);
    await startTask("job", true);

    await vi.waitFor(() => expect(state.decisions.some((d) => d.kind === "ask")).toBe(true));
    expect(held()).toHaveLength(1);
    expect(held()[0]).toContain("실제 결제 화면 — 사용자 계정 로그인이 필요해요");
    expect(backs()).toHaveLength(0);
    expect(state.tasks[0].status).not.toBe("done");

    const q = state.decisions.find((d) => d.kind === "ask")!;
    await decide(q.id, q.options[1].id);
    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(state.tasks[0].unverified).toEqual(["실제 결제 화면 — 사용자 계정 로그인이 필요해요"]);
    expect(held()).toHaveLength(1);
  });

  it("an unticked item on the checklist sent with the done counts as unchecked too", async () => {
    const done = { type: "done", summary: "녹음은 잘 돼요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }] };
    const list = { type: "checklist", items: [{ label: "개발판 녹음", done: true }, { label: "스피커로 나오는 상대방 목소리 녹음", done: false }] };
    await harness((agent, n, emit) => {
      if (agent !== "t:job") return;
      emit({ type: "agent_start" });
      if (n === 1) say(emit, `확인했어요.\n${block(list, done)}`);
      emit({ type: "agent_settled" });
    });
    setState("tasks", [job({ entries: [tool("e1", 1, "edit", "/workspace/example/src/total.ts"), ran(2, "pnpm test")] })]);
    await startTask("job", true);
    await vi.waitFor(() => expect(held()).toHaveLength(1));
    expect(held()[0]).toContain("스피커로 나오는 상대방 목소리 녹음");
    expect(held()[0]).not.toContain("개발판 녹음");
    expect(state.tasks[0].status).not.toBe("done");
  });

  it("with something unchecked and no question from the job, the second done goes through: asking is the job's call, nothing set is asked", async () => {
    const done = { type: "done", summary: "합계를 고쳤어요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }], unverified: [{ what: "스피커 소리 녹음", why: "방 안 대화가 섞여요" }] };
    await harness((agent, n, emit) => {
      if (agent !== "t:job") return;
      emit({ type: "agent_start" });
      if (n <= 2) say(emit, `고쳤어요.\n${block(done)}`);
      emit({ type: "agent_settled" });
    });
    setState("tasks", [job({ entries: [tool("e1", 1, "edit", "/workspace/example/src/total.ts"), ran(2, "pnpm test")] })]);
    await startTask("job", true);

    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(held()).toHaveLength(1);
    // checking what it can is asked of it; asking the user is left to it
    expect(held()[0]).toContain("check it now");
    expect(held()[0]).not.toMatch(/ask the user now/);
    expect(state.decisions).toHaveLength(0);
    expect(state.tasks[0].unverified).toEqual(["스피커 소리 녹음 — 방 안 대화가 섞여요"]);
  });

  it("doesn't ask again in a later turn about what the user already said to leave unchecked, only about something new", async () => {
    const done = (...unverified: unknown[]) => ({ type: "done", summary: "합계를 고쳤어요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }], unverified });
    await harness((agent, n, emit) => {
      if (agent !== "t:job") return;
      emit({ type: "agent_start" });
      if (n <= 2) say(emit, `고쳤어요.\n${block(done({ what: "스피커 소리 녹음", why: "방 안 대화가 섞여요" }))}`);
      // the next turn the job words it a little differently, as it did in the app
      if (n === 3) say(emit, `PR을 열었어요.\n${block(done("스피커 소리 녹음 — 사용자가 확인 없이 마무리하기로 했어요"))}`);
      if (n === 4) say(emit, `다시 올렸어요.\n${block(done("스피커 소리 녹음 — 사용자가 확인 없이 마무리하기로 했어요", { what: "결제 화면", why: "로그인이 필요해요" }))}`);
      emit({ type: "agent_settled" });
    });
    setState("tasks", [job({ entries: [tool("e1", 1, "edit", "/workspace/example/src/total.ts"), ran(2, "pnpm test")] })]);
    await startTask("job", true);
    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(held()).toHaveLength(1);

    const { tell } = await import("./tasks");
    // a finished job goes back in line with the words; the scheduler starts it again
    await tell("job", "PR로 올려 줘");
    await startTask("job", true);
    await vi.waitFor(() => expect(sent("t:job", "prompt").length).toBeGreaterThanOrEqual(3));
    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(held()).toHaveLength(1);
    expect(state.decisions).toHaveLength(0);

    await tell("job", "한 번 더 올려 줘");
    await startTask("job", true);
    await vi.waitFor(() => expect(held()).toHaveLength(2));
    expect(held()[1]).toContain("결제 화면");
    expect(held()[1]).not.toContain("스피커 소리 녹음");
  });

  it("a job Ondra started by itself from memory never asks: what it couldn't check stays in its record and it finishes", async () => {
    const done = { type: "done", summary: "검사를 넣었어요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }], unverified: [{ what: "실행 중인 앱 화면", why: "개발 앱을 띄우지 않기로 했어요" }] };
    await harness((agent, n, emit) => {
      if (agent !== "t:job") return;
      emit({ type: "agent_start" });
      if (n === 1) say(emit, ask("실제 앱 화면 확인을 어떻게 할까요?", "직접 확인할게요", "확인 없이 마무리"));
      if (n === 2) say(emit, `넣었어요.\n${block(done)}`);
      emit({ type: "agent_settled" });
    });
    setState("tasks", [job({ self: "check", entries: [tool("e1", 1, "edit", "/workspace/example/src/total.ts"), ran(2, "pnpm test")] })]);
    await startTask("job", true);
    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(state.decisions).toHaveLength(0);
    expect(held()).toHaveLength(0);
    const told = vi.mocked(native.agentSend).mock.calls.map(([, c]) => `${c.type} ${String((c as { message?: string }).message)}`);
    // told once, in the turn it asked (steered in, as the ask comes while it is still going)
    expect(told.filter((m) => m.includes("nobody is asked"))).toHaveLength(1);
    expect(state.tasks[0].unverified).toEqual(["실행 중인 앱 화면 — 개발 앱을 띄우지 않기로 했어요"]);
  });

  it("sends back a plan step left open, and lets a skip with its reason through", async () => {
    const plan = [{ text: "원인 찾기", state: "done" as const }, { text: "회귀 테스트", state: "todo" as const }, { text: "고치기", state: "done" as const }];
    await finish(
      { plan, entries: [tool("e1", 1, "edit", "/workspace/example/src/total.ts"), ran(2, "pnpm test")] },
      { type: "done", summary: "합계를 고쳤어요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }] },
    );
    await vi.waitFor(() => expect(backs()).toHaveLength(1));
    expect(backs()[0]).toContain("«회귀 테스트»");
  });

  it("asks a fix/ job for its reproduction before and after, but not a small one", async () => {
    const entries = [tool("e1", 1, "edit", "/workspace/example/src/total.ts"), ran(2, "pnpm test")];
    const done = { type: "done", summary: "합계를 고쳤어요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }] };
    await finish({ branch: "fix/total", entries }, done);
    await vi.waitFor(() => expect(backs()).toHaveLength(1));
    expect(backs()[0]).toContain("재현 기록이 없어요");

    pauseTask("job");
    vi.restoreAllMocks();
    setState(reconcile(freshState()));
    await finish({ branch: "fix/total", size: "small", entries }, { ...done, unverified: ["화면"] });
    // a small job owes no reproduction; what it left unchecked is still asked about before it ends
    await vi.waitFor(() => expect(sent("t:job", "prompt").some((m) => m.includes("Don't finish yet"))).toBe(true));
    expect(backs()).toHaveLength(0);
  });

  it("sends back a playbook job that never sent a plan, but not one with no playbook", async () => {
    // a feat/ job was told its playbook's steps are its plan's steps; with no plan nothing was ever checked
    const entries = [tool("e1", 1, "edit", "/workspace/example/src/total.ts"), ran(2, "pnpm test")];
    const done = { type: "done", summary: "팀 화면을 만들었어요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }] };
    await finish({ branch: "feat/team", entries }, done);
    await vi.waitFor(() => expect(backs()).toHaveLength(1));
    expect(backs()[0]).toContain("계획을 한 번도 보내지 않았어요");
    expect(backs()[0]).toContain("Feature");

    pauseTask("job");
    vi.restoreAllMocks();
    setState(reconcile(freshState()));
    await finish({ entries }, done);
    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(backs()).toHaveLength(0);
  });

  it("sends back a cause given with no footing", async () => {
    await finish(
      { entries: [tool("e1", 1, "edit", "/workspace/example/src/total.ts"), ran(2, "pnpm test")] },
      { type: "done", summary: "합계를 고쳤어요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }] },
      "\n\n**원인** 세금을 두 번 더했어요.",
    );
    await vi.waitFor(() => expect(backs()).toHaveLength(1));
    expect(backs()[0]).toContain("근거 라벨이 없어요");
  });
});

describe("plan reminder", () => {
  const PLAN = block({ type: "plan", steps: ["원인 찾기", "고치기", "확인"] }, { type: "now", text: "원인을 찾고 있어요", step: 0 });
  const reminders = (agent: string) => sent(agent, "steer").filter((m) => m.includes("to-do list hasn't moved"));

  it("leaves a fork alone until its quiet stretch is long", async () => {
    await harness((agent, n, emit) => {
      if (agent !== "t:job" || n !== 1) return;
      emit({ type: "agent_start" });
      say(emit, PLAN);
      bashCalls(emit, PLAN_QUIET - 1);
    });
    setState("tasks", [job()]);
    await startTask("job", true);
    await vi.waitFor(() => expect(sent("t:job", "prompt")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(reminders("t:job")).toHaveLength(0);
  });

  it("leaves a fork alone in its first minutes, however many calls it makes", async () => {
    await harness((agent, n, emit) => {
      if (agent !== "t:job" || n !== 1) return;
      emit({ type: "agent_start" });
      say(emit, PLAN);
      bashCalls(emit, PLAN_QUIET * 3);
    });
    setState("tasks", [job()]);
    await startTask("job", true);
    await vi.waitFor(() => expect(sent("t:job", "prompt")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10));
    expect(reminders("t:job")).toHaveLength(0);
  });

  it("reminds a fork once per quiet stretch, capped", async () => {
    const now = vi.spyOn(Date, "now");
    let clock = Date.now();
    now.mockImplementation(() => clock);
    await harness((agent, n, emit) => {
      if (agent !== "t:job" || n !== 1) return;
      emit({ type: "agent_start" });
      say(emit, PLAN);
      // each stretch of calls takes longer than the quiet time
      for (let i = 0; i < PLAN_NUDGES + 2; i++) {
        clock += PLAN_QUIET_MS;
        bashCalls(emit, PLAN_QUIET);
      }
    });
    setState("tasks", [job()]);
    await startTask("job", true);
    await vi.waitFor(() => expect(reminders("t:job")).toHaveLength(PLAN_NUDGES));
    await new Promise((r) => setTimeout(r, 10));
    expect(reminders("t:job")).toHaveLength(PLAN_NUDGES);
  });

  it("asks a fork that never sent a plan for one, once its quiet stretch is long", async () => {
    const now = vi.spyOn(Date, "now");
    let clock = Date.now();
    now.mockImplementation(() => clock);
    await harness((agent, n, emit) => {
      if (agent !== "t:job" || n !== 1) return;
      emit({ type: "agent_start" });
      say(emit, "PC 코드를 먼저 볼게요.");
      clock += PLAN_QUIET_MS;
      bashCalls(emit, PLAN_QUIET);
    });
    setState("tasks", [job({ branch: "feat/team" })]);
    await startTask("job", true);
    await vi.waitFor(() => expect(sent("t:job", "steer").some((m) => m.includes("haven't sent a plan"))).toBe(true));
    const m = sent("t:job", "steer").find((x) => x.includes("haven't sent a plan"))!;
    expect(m).toContain("Feature");
  });

  it("never reminds a subagent", async () => {
    await harness((agent, n, emit) => {
      if (agent !== "t:kid" || n !== 1) return;
      emit({ type: "agent_start" });
      say(emit, PLAN);
      bashCalls(emit, PLAN_QUIET * 3);
    });
    setState("tasks", [job({ status: "running" }), job({ id: "kid", parentId: "job", title: "조사", legs: [] })]);
    await startTask("kid");
    await vi.waitFor(() => expect(sent("t:kid", "prompt")).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(reminders("t:kid")).toHaveLength(0);
  });
});

describe("fewer turns before done", () => {
  const ran = (at: number, cmd: string): Entry => tool(`b${at}`, at, "bash", cmd);
  const edited = () => [tool("e1", 1, "edit", "/workspace/example/src/total.ts"), ran(2, "pnpm test")];
  const play = async (turns: Record<number, string>, over: Partial<Task> = {}) => {
    await harness((agent, n, emit) => {
      if (agent !== "t:job") return;
      emit({ type: "agent_start" });
      if (turns[n]) say(emit, turns[n]);
      emit({ type: "agent_settled" });
    });
    setState("tasks", [job({ entries: edited(), ...over })]);
    await startTask("job", true);
  };
  const prompts = () => sent("t:job", "prompt");
  const done = (extra: object = {}) => block({ type: "done", summary: "합계를 고쳤어요", evidence: [{ kind: "test", ref: "pnpm test", ok: true }], ...extra });

  it("asks about what it left unchecked in the same send-back as the missing proof, not in a turn of its own", async () => {
    const unverified = [{ what: "결제 단계", why: "로그인이 필요해요" }];
    await play({
      1: `고쳤어요. 브라우저에서 직접 눌러 봤어요.\n${done({ unverified })}`,
      2: `고쳤어요.\n${done({ unverified })}`,
    });
    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(state.decisions).toHaveLength(0);
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toContain("끝내기 전에");
    expect(prompts()[1]).toContain("Don't finish yet");
  });

  it("a soft miss sends it back once; the second time it is written down in its record, not argued again", async () => {
    const claim = "브라우저에서 직접 눌러 봤어요.";
    await play({ 1: `고쳤어요. ${claim}\n${done()}`, 2: `고쳤어요. ${claim}\n${done()}` });
    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(prompts()).toHaveLength(2);
    expect(state.decisions).toHaveLength(0);
    expect(state.tasks[0].unverified?.join("\n")).toContain("뒷받침되지 않는");
  });

  it("doesn't ask again after the user answered, even when the job was restarted in between", async () => {
    const unverified = [{ what: "결제 화면", why: "로그인이 필요해요" }];
    await play({
      1: `고쳤어요.\n${done({ unverified })}`,
      2: "```blocks\n" + JSON.stringify({ type: "ask", question: "결제 화면은 못 봤어요. 어떻게 할까요?", options: [{ label: "확인 없이 끝내기" }] }) + "\n```",
      3: `알겠어요.\n${done({ unverified })}`,
    });
    await vi.waitFor(() => expect(state.decisions.some((d) => d.kind === "ask")).toBe(true));
    // the session went away while it waited (a restart): the answer starts a new run
    pauseTask("job");
    await tell("job", "확인 없이 끝내기");
    await startTask("job", true);
    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(prompts().filter((m) => m.includes("Don't finish yet"))).toHaveLength(1);
    expect(state.decisions).toHaveLength(0);
  });

  it("sends back an answer that slipped into English for a user who writes Korean", async () => {
    await play(
      { 1: `I fixed the total and the tests pass now in every case.\n${done()}`, 2: `합계를 고쳤어요.\n${done()}` },
      { entries: [{ id: "u1", at: 0, kind: "user", text: "합계 고쳐 줘" }, ...edited()] },
    );
    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(prompts()[1]).toContain("한국어로 다시");
    expect(state.tasks[0].entries.some((e) => e.kind === "note" && e.text === "확인 필요 · 언어")).toBe(true);
  });

  it("doesn't send back for the plan's last step left open: the done is that step", async () => {
    const plan = [{ text: "고치기", state: "done" as const }, { text: "결과 보고", state: "todo" as const }];
    await play({ 1: `고쳤어요.\n${done()}` }, { plan });
    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(prompts()).toHaveLength(1);
  });

  it("the summary is the latest piece of work's report, not one from before the user's new words", async () => {
    const said = (pr: string) => block({ type: "done", summary: `PR ${pr}를 열었어요`, evidence: [{ kind: "test", ref: "pnpm test", ok: true }] });
    await play({
      // sent back once (a soft miss): the first done is kept as the summary of that work
      1: `PR #685를 열었어요. 브라우저에서 직접 눌러 봤어요.\n${said("#685")}`,
      // then it asks something and waits, its session still there
      2: "```blocks\n" + JSON.stringify({ type: "ask", question: "색은 이대로 둘까요?", options: [{ label: "네" }] }) + "\n```",
      3: `PR #686을 열었어요.\n${said("#686")}`,
    });
    await vi.waitFor(() => expect(state.tasks[0].status).toBe("waiting"));
    await tell("job", "스킬은 다른 색으로");
    await vi.waitFor(() => expect(state.tasks[0].status).toBe("done"));
    expect(state.tasks[0].summary).toBe("PR #686를 열었어요");
  });
});

describe("subagents of a job that ended", () => {
  it("end with it instead of staying paused forever, also ones left from before", async () => {
    const kid = (id: string, status: Task["status"]): Task => job({ id, parentId: "job", status, title: id });
    setState("tasks", [job({ status: "done" }), kid("k1", "paused"), kid("k2", "waiting"), job({ id: "live", status: "running" }), { ...kid("k3", "paused"), parentId: "live" }]);
    endOrphanKids();
    const by = (id: string) => state.tasks.find((t) => t.id === id)!;
    expect(by("k1").status).toBe("done");
    expect(by("k2").status).toBe("done");
    expect(by("k1").entries.some((e) => e.kind === "note" && e.text === "작업이 끝나서 멈췄어요")).toBe(true);
    // a paused subagent of a job still going is left alone
    expect(by("k3").status).toBe("paused");
  });
});
