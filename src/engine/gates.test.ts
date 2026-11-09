import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Entry, Task } from "../state/types";
import { startRpc } from "./rpc";
import { blocking, pauseTask, PLAN_NUDGES, PLAN_QUIET, startTask } from "./tasks";

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

  it("reminds a fork once per quiet stretch, capped", async () => {
    await harness((agent, n, emit) => {
      if (agent !== "t:job" || n !== 1) return;
      emit({ type: "agent_start" });
      say(emit, PLAN);
      bashCalls(emit, PLAN_QUIET * (PLAN_NUDGES + 2));
    });
    setState("tasks", [job()]);
    await startTask("job", true);
    await vi.waitFor(() => expect(reminders("t:job")).toHaveLength(PLAN_NUDGES));
    await new Promise((r) => setTimeout(r, 10));
    expect(reminders("t:job")).toHaveLength(PLAN_NUDGES);
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
