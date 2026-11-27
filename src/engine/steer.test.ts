import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { setState, state } from "../state/store";
import { testState } from "../state/testing";
import type { Task } from "../state/types";
import { startRpc } from "./rpc";
import { pauseTask, REPLAN_CALLS, startTask, tell } from "./tasks";

const job = (over: Partial<Task> = {}): Task => ({
  id: "job", space: "home", topic: "Example", title: "Survey",
  ask: "Add the survey modal.", cwd: "/workspace/example", status: "queued",
  priority: 2, weight: "light", accountId: "default", createdAt: 1,
  now: "", plan: [], legs: [{ startedAt: 1 }], entries: [], shells: [], inbox: [],
  isolate: false, answer: true, ...over,
});

const sent = (type: string) => vi.mocked(native.agentSend).mock.calls.filter(([, c]) => c.type === type).map(([, c]) => String(c.message));
const last = (xs: string[]) => xs[xs.length - 1];
const task = () => state.tasks.find((t) => t.id === "job")!;
const block = (...lines: object[]) => `\`\`\`blocks\n${lines.map((l) => JSON.stringify(l)).join("\n")}\n\`\`\``;

let emit: (ev: unknown) => void;
let calls = 0;

beforeEach(async () => {
  setState(reconcile(testState()));
  calls = 0;
  const events = new Map<string, (payload: unknown) => void>();
  vi.spyOn(native, "onEvent").mockImplementation(async (name, fn) => {
    events.set(name, fn as (payload: unknown) => void);
    return () => { events.delete(name); };
  });
  vi.spyOn(native, "agentSpawn").mockResolvedValue();
  vi.spyOn(native, "agentStopCommand").mockResolvedValue(1);
  vi.spyOn(native, "agentSend").mockImplementation(async (id, command) => {
    emit = (ev: unknown) => events.get("agent:event")?.({ id, ev });
    const data = command.type === "clear_queue" ? { steering: [], followUp: [] } : {};
    emit({ id: command.id, type: "response", success: true, data });
    if (command.type === "prompt" && sent("prompt").length === 1) setTimeout(() => emit({ type: "agent_start" }));
  });
  await startRpc();
});
afterEach(() => {
  for (const t of state.tasks) pauseTask(t.id);
  vi.restoreAllMocks();
});

/** the job is working on its plan */
async function working(plan: Task["plan"] = [{ text: "포스트호그 지표 넣기", state: "done" }, { text: "배포", state: "now" }]) {
  setState("tasks", [job({ plan })]);
  await startTask("job");
  await vi.waitFor(() => expect(sent("prompt")).toHaveLength(1));
  await new Promise((r) => setTimeout(r));
}
/** a bash call starts; `ago`: it began this long ago */
function bash(command: string, ago = 10_000) {
  const id = `call${++calls}`;
  emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command } });
  setState("tasks", (t) => t.id === "job", "shells", (s) => s.id === id, "startedAt", Date.now() - ago);
  return id;
}
const say = (text: string) => {
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  emit({ type: "message_end", message: { role: "assistant" } });
};
/** the model takes the user's words that were steered in */
const takes = (text: string) => emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });

describe("the user's words while the job works", () => {
  it("are placed by the plan, not done on arrival", async () => {
    await working();
    await tell("job", "배포는 mmhs app 써줘", { now: true });
    const steer = sent("steer")[0];
    expect(steer).toMatch(/^배포는 mmhs app 써줘\n\n\(Ondra\) The user said this while you were working/);
    expect(steer).toContain("Answer them first, now");
    expect(steer).toContain("by what depends on what");
    expect(steer).toContain("send the updated plan block before any other tool call");
    // the to-do list shows them at once, until the job places them
    expect(task().planAsk).toBe("배포는 mmhs app 써줘");
  });

  it("stop a command that only waits, over ssh too, and say so", async () => {
    await working();
    bash(`ssh -n ubuntu-125-186-161-87 'for i in $(seq 1 60); do pgrep -f "docker build" >/dev/null || break; sleep 10; done'`);
    await tell("job", "설문도 만들어줘", { now: true });
    expect(sent("steer")[0]).toContain("Ondra stopped `ssh -n ubuntu-125-186-161-87");
    await vi.waitFor(() => expect(native.agentStopCommand).toHaveBeenCalledTimes(1));
    expect(vi.mocked(native.agentStopCommand).mock.calls[0].slice(0, 2)).toEqual(["t:job", "bash"]);
    expect(task().entries.some((e) => e.kind === "note" && e.text === "명령 멈춤 · 새 메시지를 바로 전해요")).toBe(true);
  });

  it("stop real work and a wait that just began too, and tell the job they were cut", async () => {
    await working();
    bash("pnpm build --filter web");
    bash("for i in $(seq 1 60); do aws sts get-caller-identity && break; sleep 5; done", 500);
    await tell("job", "로그인 했어", { by: "main", now: true });
    expect(sent("steer")).toHaveLength(1);
    expect(sent("steer")[0]).toContain("Ondra stopped `pnpm build --filter web`, `for i in $(seq 1 60)");
    expect(sent("steer")[0]).toContain("cut off, not finished");
    await vi.waitFor(() => expect(native.agentStopCommand).toHaveBeenCalledTimes(2));
  });

  it("from another job, wait for the running command", async () => {
    await working();
    bash("pnpm build --filter web");
    await tell("job", "(Ondra) A message from another job", { by: "t2" });
    expect(native.agentStopCommand).not.toHaveBeenCalled();
  });

  it("not placed after a few tool calls: the job is asked once", async () => {
    await working();
    await tell("job", "배포는 mmhs app 써줘", { now: true });
    // before the model has them, its calls don't count
    for (let i = 0; i < REPLAN_CALLS; i++) bash(`cat a${i}.txt`);
    expect(sent("steer")).toHaveLength(1);
    takes(sent("steer")[0]);
    for (let i = 0; i < REPLAN_CALLS; i++) bash(`cat b${i}.txt`);
    expect(sent("steer")).toHaveLength(2);
    expect(last(sent("steer"))).toContain("your to-do list hasn't changed");
    expect(last(sent("steer"))).toContain("[>] 배포");
    expect(task().planAsk).toBeUndefined();
    for (let i = 0; i < REPLAN_CALLS * 2; i++) bash(`cat c${i}.txt`);
    expect(sent("steer")).toHaveLength(2);
  });

  it("placed in a new plan: no reminder, and the step is the user's", async () => {
    await working();
    await tell("job", "설문 만들어줘", { now: true });
    takes(sent("steer")[0]);
    say(block({ type: "plan", steps: ["포스트호그 지표 넣기", { text: "설문 넣기", user: true, sub: ["모달 만들기", "앱에 연결"] }, "배포"] }));
    for (let i = 0; i < REPLAN_CALLS * 2; i++) bash(`cat d${i}.txt`);
    expect(sent("steer")).toHaveLength(1);
    expect(task().planAsk).toBeUndefined();
    expect(task().plan[1]).toMatchObject({ text: "설문 넣기", state: "now", user: true });
    expect(task().plan[1].sub?.map((x) => x.state)).toEqual(["now", "todo"]);
  });

  it("a done with a step the user asked for never reached is sent back once", async () => {
    await working([
      { text: "설문 넣기", state: "now", user: true },
      { text: "mmhs.app으로 배포", state: "todo", user: true },
    ]);
    say(block({ type: "done", summary: "설문을 넣었어요" }));
    emit({ type: "agent_settled" });
    await vi.waitFor(() => expect(sent("prompt")).toHaveLength(2));
    expect(last(sent("prompt"))).toContain("- mmhs.app으로 배포");
    expect(task().status).toBe("running");
    expect(task().entries.some((e) => e.kind === "note" && e.text === "남은 요청 · mmhs.app으로 배포")).toBe(true);
  });
});
