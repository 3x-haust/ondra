import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Task } from "../state/types";
import { startRpc } from "./rpc";
import { pauseTask, startTask } from "./tasks";

const job = (over: Partial<Task> = {}): Task => ({
  id: "job", space: "home", topic: "Example", title: "Remote control",
  ask: "Make remote control work.", cwd: "/workspace/example", status: "queued",
  priority: 2, weight: "light", accountId: "default", createdAt: 1,
  now: "", plan: [], legs: [{ startedAt: 1 }], entries: [], shells: [], inbox: [],
  isolate: false, answer: true, ...over,
});

beforeEach(() => setState(reconcile(freshState())));
afterEach(() => {
  for (const t of state.tasks) pauseTask(t.id);
  vi.restoreAllMocks();
});

describe("one review per job", () => {
  it("wakes a job that ended its turn waiting for a refused second review", async () => {
    const events = new Map<string, (payload: unknown) => void>();
    vi.spyOn(native, "onEvent").mockImplementation(async (name, fn) => {
      events.set(name, fn as (payload: unknown) => void);
      return () => { events.delete(name); };
    });
    vi.spyOn(native, "agentSpawn").mockResolvedValue();
    let prompts = 0;
    vi.spyOn(native, "agentSend").mockImplementation(async (id, command) => {
      const emit = (ev: unknown) => events.get("agent:event")?.({ id, ev });
      emit({ id: command.id, type: "response", success: true, data: {} });
      if (command.type !== "prompt" || ++prompts > 1) return;
      // the job asks for a second review and ends its turn to wait for it
      const text = 'Reviewing now.\n```blocks\n{"type":"subagent","review":true,"title":"코드 리뷰","task":"Use the code-review skill."}\n```';
      setTimeout(() => {
        emit({ type: "agent_start" });
        emit({ type: "message_start", message: { role: "assistant" } });
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
        emit({ type: "agent_settled" });
      });
    });
    await startRpc();
    setState("tasks", [
      job(),
      job({ id: "review", parentId: "job", review: true, status: "done", title: "코드 리뷰", result: "P1 없음, P2 없음", legs: [], answer: undefined }),
    ]);

    await startTask("job", true);

    await vi.waitFor(() => expect(prompts).toBe(2));
    const sent = vi.mocked(native.agentSend).mock.calls.filter(([, c]) => c.type === "prompt").map(([, c]) => String(c.message));
    expect(sent[1]).toContain("already reviewed once");
    expect(state.decisions.some((d) => d.taskId === "job" && d.kind === "stalled")).toBe(false);
    expect(state.tasks.filter((t) => t.parentId === "job")).toHaveLength(1);
  });
});
