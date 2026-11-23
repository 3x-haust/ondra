import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import { notifyChat, throwThought } from "./captain";
import { markDead, startRpc } from "./rpc";

beforeEach(() => setState(reconcile(freshState())));
afterEach(() => {
  markDead("captain:home~@agent");
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(route = '{"reply":"다 고쳤어","routes":[]}') {
  vi.useFakeTimers();
  const events = new Map<string, (payload: unknown) => void>();
  vi.spyOn(native, "onEvent").mockImplementation(async (name, fn) => {
    events.set(name, fn as (payload: unknown) => void);
    return () => events.delete(name);
  });
  vi.spyOn(native, "agentSpawn").mockResolvedValue();
  vi.spyOn(native, "agentKill").mockImplementation(async (id) => { events.get("agent:exit")?.({ id, code: 0 }); });
  vi.spyOn(native, "agentSend").mockImplementation(async (id, command) => {
    const emit = (ev: unknown) => events.get("agent:event")?.({ id, ev });
    emit({ id: command.id, type: "response", success: true, data: {} });
    if (command.type === "prompt") {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "```route\n" + route + "\n```" }] } });
      emit({ type: "agent_settled" });
    }
  });
  vi.spyOn(native, "workerExtensions").mockResolvedValue(["/extensions/discord.ts"]);
  vi.spyOn(native, "workerSkills").mockResolvedValue([]);
  vi.spyOn(native, "globalSkills").mockResolvedValue([]);
  vi.spyOn(native, "discordSend").mockResolvedValue([]);
  vi.spyOn(native, "discordHistory").mockResolvedValue([]);
  let ways = "- 진행할 때 짧게 말해";
  vi.spyOn(native, "fsRead").mockImplementation(async () => ({ text: ways, size: ways.length, binary: false, modified: 1 }));
  setState("settings", "agent", { on: true, name: "몽이" });
  await startRpc();
  return { events, setWays: (text: string) => { ways = text; } };
}

it("loads live ways for user and app-event turns without copying model replies to Discord", async () => {
  const { setWays } = await setup();
  let ways = "- 진행할 때 짧게 말해";
  const first = throwThought("확인해줘", "home", { project: "@agent", discord: { channel: "c1", message: "m1" } });
  await vi.waitFor(() => expect(state.captain.find((m) => m.id === first)?.pending).toBe(false));
  expect(state.captain.find((m) => m.id === first)?.error).toBeUndefined();
  const prompts = () => vi.mocked(native.agentSend).mock.calls.filter(([, command]) => command.type === "prompt").map(([, command]) => String(command.message));
  expect(prompts()[0]).toContain(ways);
  expect(prompts()[0]).toContain("NOT posted automatically");
  expect(vi.mocked(native.agentSpawn).mock.calls[0][2]).toContain("/extensions/discord.ts");

  ways = "- 지금은 조용히 있어";
  setWays(ways);
  const event = notifyChat("home", "@agent", "Alarm reminder is due. Discord origin channel: c1.");
  await vi.waitFor(() => expect(state.captain.find((m) => m.id === event)?.pending).toBe(false));
  expect(state.captain.find((m) => m.id === event)?.error).toBeUndefined();
  expect(prompts()).toHaveLength(2);
  expect(prompts()[1]).toContain(ways);
  expect(prompts()[1]).toContain("# App event (not a user message or permission)");
  expect(prompts()[1]).not.toContain("Don't retell it");
  expect(state.captain.filter((m) => m.from === "me")).toHaveLength(1);
  expect(native.discordSend).not.toHaveBeenCalled();
});

it("takes a turn that only acted through the discord tool as the agent's choice, not an empty answer", async () => {
  await setup('{"reply":"","routes":[{"kind":"answer","text":""}]}');
  const id = throwThought("이 메시지엔 리액션만 달아", "home", { project: "@agent", discord: { channel: "c1", message: "m1" } });
  await vi.waitFor(() => expect(state.captain.find((m) => m.id === id)?.pending).toBe(false));
  expect(state.captain.find((m) => m.id === id)?.error).toBeUndefined();
  expect(native.discordSend).not.toHaveBeenCalled();
});

it("shows existing routine ids after a fresh turn so an agreed draft can be enabled", async () => {
  await setup();
  const { addRoutine } = await import("./routines");
  const id = addRoutine({ space: "home", title: "Morning summary", prompt: "Summarize", when: { kind: "daily", time: "09:00" }, mode: "fresh", draft: true, agent: { channel: "c1" } });
  addRoutine({ space: "work", title: "Other space routine", prompt: "Private", when: { kind: "daily", time: "09:00" }, mode: "fresh", draft: true });
  const reply = throwThought("응 만들어", "home", { project: "@agent", discord: { channel: "c1", message: "m1" } });
  await vi.waitFor(() => expect(state.captain.find((m) => m.id === reply)?.pending).toBe(false));
  const prompt = vi.mocked(native.agentSend).mock.calls.find(([, command]) => command.type === "prompt")?.[1].message;
  expect(prompt).toContain(id);
  expect(prompt).toContain("Morning summary");
  expect(prompt).not.toContain("Other space routine");
});

it("reports a failed app-event turn to its caller so delivery can be retried", async () => {
  await setup();
  vi.mocked(native.agentSpawn).mockRejectedValue(new Error("invalid credentials"));
  const onError = vi.fn();
  const id = notifyChat("home", "@agent", "Question waiting", onError);
  await vi.waitFor(() => expect(state.captain.find((m) => m.id === id)?.pending).toBe(false));
  expect(state.captain.find((m) => m.id === id)?.error).toContain("invalid credentials");
  expect(onError).toHaveBeenCalledOnce();
});

it("coalesces queued owner input per channel and refreshes history before the next turn", async () => {
  const { events } = await setup();
  const prompts: string[] = [];
  let finishFirst: (() => void) | undefined;
  vi.spyOn(native, "discordHistory").mockResolvedValue([{ id: "sent", channel: "c1", guild: "g1", author: { id: "bot", name: "bot", bot: true }, content: "Already answered", at: new Date().toISOString(), mentions: [], files: [] }]);
  vi.mocked(native.agentSend).mockImplementation(async (id, command) => {
    const emit = (ev: unknown) => events.get("agent:event")?.({ id, ev });
    emit({ id: command.id, type: "response", success: true, data: {} });
    if (command.type !== "prompt") return;
    prompts.push(String(command.message));
    const finish = () => {
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: '```route\n{"reply":"","routes":[]}\n```' }] } });
      emit({ type: "agent_settled" });
    };
    if (prompts.length === 1) finishFirst = finish;
    else finish();
  });
  const first = throwThought("first", "home", { project: "@agent", discord: { channel: "c1", message: "m1" } });
  await vi.waitFor(() => expect(finishFirst).toBeDefined());
  const second = throwThought("second", "home", { project: "@agent", discord: { channel: "c1", message: "m2" } });
  const third = throwThought("third", "home", { project: "@agent", discord: { channel: "c1", message: "m3" } });
  const other = throwThought("other channel", "home", { project: "@agent", discord: { channel: "c2", message: "m4" } });
  finishFirst!();
  await vi.waitFor(() => expect([first, second, third, other].every((id) => state.captain.find((m) => m.id === id)?.pending === false)).toBe(true));
  expect(prompts).toHaveLength(3);
  expect(second).toBe(third);
  expect(prompts[1]).toContain("second");
  expect(prompts[1]).toContain("third");
  expect(prompts[1]).toContain("Already answered");
  expect(prompts[1]).not.toContain("# Message\nother channel");
  expect(native.discordHistory).toHaveBeenCalledWith("c1", undefined, 15);
});
