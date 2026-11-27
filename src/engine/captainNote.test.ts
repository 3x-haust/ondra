import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { setState, state } from "../state/store";
import { testState } from "../state/testing";
import { stopMain, throwThought } from "./captain";
import { markDead, startRpc } from "./rpc";

const KEY = "home~@agent";
const WORDS = "이거 고쳐줘\n\n첨부한 파일:\n- /tmp/shot.png";
const NOTE = "(Ondra) The user sent this from Discord.\n- Their explicit words outrank your defaults.\n- People, servers and lessons go in your personal memory, not the work memory.";

beforeEach(async () => {
  vi.useFakeTimers();
  setState(reconcile(testState()));
  const events = new Map<string, (payload: unknown) => void>();
  vi.spyOn(native, "onEvent").mockImplementation(async (name, fn) => {
    events.set(name, fn as (payload: unknown) => void);
    return () => { events.delete(name); };
  });
  vi.spyOn(native, "agentSpawn").mockResolvedValue();
  vi.spyOn(native, "agentKill").mockImplementation(async (id) => events.get("agent:exit")?.({ id, code: 0 }));
  vi.spyOn(native, "workerExtensions").mockResolvedValue([]);
  vi.spyOn(native, "workerSkills").mockResolvedValue([]);
  vi.spyOn(native, "globalSkills").mockResolvedValue([]);
  vi.spyOn(native, "agentSend").mockImplementation(async (id, command) => {
    const emit = (ev: unknown) => events.get("agent:event")?.({ id, ev });
    emit({ id: command.id, type: "response", success: true, data: {} });
    if (command.type === "prompt") {
      const route = '```route\n{"reply":"고칠게","routes":[{"kind":"new","title":"고치기","topic":"ondra","task":"fix it"}]}\n```';
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: route }] } });
      emit({ type: "agent_settled" });
    }
  });
  await startRpc();
});
afterEach(async () => {
  await stopMain(KEY);
  markDead(`captain:${KEY}`);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a note for the model alone", () => {
  it("goes to the model with the words, but not into the job the words start", async () => {
    // a work memory that shares words with the note only, none with what the user said
    setState("memory", [{ id: "mnote", text: "Explicit words outrank defaults: People, servers and lessons go in your personal memory, not the work memory", keys: ["personal memory", "servers", "lessons", "outrank"], scope: "global", source: "ondra", createdAt: Date.now(), updatedAt: Date.now(), uses: 0 }]);
    const replyId = throwThought(WORDS, "home", { project: "@agent", note: NOTE });
    await vi.waitFor(() => expect(state.captain.find((m) => m.id === replyId)?.pending).toBe(false));

    const prompt = String(vi.mocked(native.agentSend).mock.calls.find(([, c]) => c.type === "prompt")![1].message);
    expect(prompt).toContain(WORDS);
    expect(prompt).toContain(NOTE);
    // memory is recalled for what the user said, not for the note's wording
    expect(prompt).not.toContain("Explicit words outrank defaults");

    const job = state.tasks.find((t) => t.title === "고치기")!;
    expect(job).toBeTruthy();
    // the job's first message, as its view shows it: the user's words only
    const first = job.entries.find((e) => e.kind === "user")!;
    expect(first.text).toBe(WORDS);
  });
});
