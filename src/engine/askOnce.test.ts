import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Memory, Task } from "../state/types";
import { startRpc } from "./rpc";
import { pauseTask, startTask } from "./tasks";

const job = (over: Partial<Task> = {}): Task => ({
  id: "job", space: "home", topic: "Example", title: "도메인 찾기",
  ask: "네임칩에서 도메인 찾아줘", cwd: "/workspace/example", status: "queued",
  priority: 2, weight: "light", accountId: "default", createdAt: 1,
  now: "", plan: [], legs: [{ startedAt: 1 }], entries: [], shells: [], inbox: [],
  isolate: false, answer: true, ...over,
});
const login = { id: "nc", text: "네임칩 로그인은 키체인에 없으면 사용자에게 직접 로그인해 달라고 해요", scope: "global", createdAt: 1, updatedAt: 1, uses: 0, by: "user", kind: "rule", keys: ["네임칩", "로그인"] } as Memory;

const sent = (type: string) => vi.mocked(native.agentSend).mock.calls.filter(([, c]) => c.type === type).map(([, c]) => String(c.message));
const asks = () => state.decisions.filter((d) => d.taskId === "job");
const block = (...lines: object[]) => `\`\`\`blocks\n${lines.map((l) => JSON.stringify(l)).join("\n")}\n\`\`\``;
const askLogin = block(
  { type: "now", text: "네임칩 로그인을 기다리고 있어요" },
  { type: "ask", question: "네임칩에 로그인해 줄래요?", options: [{ label: "로그인했어요" }, { label: "그만할래요" }] },
);

let emit: (ev: unknown) => void;

beforeEach(async () => {
  setState(reconcile(freshState()));
  setState("memory", [login]);
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
  setState("tasks", [job()]);
  await startTask("job");
  await vi.waitFor(() => expect(sent("prompt")).toHaveLength(1));
  await new Promise((r) => setTimeout(r));
});
afterEach(() => {
  for (const t of state.tasks) pauseTask(t.id);
  vi.restoreAllMocks();
});

const say = (text: string) => {
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  emit({ type: "message_end", message: { role: "assistant" } });
};
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("a job waiting on its question", () => {
  it("is not woken by memory about the wait it just asked for", async () => {
    say(askLogin);
    await settle();
    expect(asks()).toHaveLength(1);
    expect(sent("steer").filter((m) => m.includes("From the user's memory"))).toEqual([]);
  });

  it("asking the same question again keeps the one card it has", async () => {
    say(askLogin);
    await settle();
    const first = asks()[0]?.id;
    say(askLogin);
    await settle();
    expect(asks().map((d) => d.id)).toEqual([first]);
  });

  it("a different question replaces it", async () => {
    say(askLogin);
    await settle();
    const first = asks()[0]?.id;
    say(block({ type: "ask", question: "다른 계정으로 볼까요?", options: [{ label: "네" }, { label: "아니요" }] }));
    await settle();
    expect(asks()).toHaveLength(1);
    expect(asks()[0].id).not.toBe(first);
    expect(asks()[0].question).toBe("다른 계정으로 볼까요?");
  });
});
