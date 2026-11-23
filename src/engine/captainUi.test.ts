import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { agentDecisions, allDecisions, freshState, setState, state } from "../state/store";
import { resetMain, stopMain, throwThought } from "./captain";
import { markDead, startRpc } from "./rpc";
import { decide } from "./tasks";

let fire: (name: string, payload: unknown) => void;
const emit = (key: string, ev: unknown) => fire("agent:event", { id: `captain:${key}`, ev });
const ask = (key: string) => emit(key, { type: "extension_ui_request", id: "approval", method: "confirm", title: "보안 입력", message: "로그인 창", timeout: 1000 });
const responses = () => vi.mocked(native.agentSend).mock.calls.filter(([, c]) => c.type === "extension_ui_response");

beforeEach(async () => {
  vi.useFakeTimers();
  setState(reconcile(freshState()));
  const events = new Map<string, (payload: unknown) => void>();
  fire = (name, payload) => events.get(name)?.(payload);
  vi.spyOn(native, "onEvent").mockImplementation(async (name, fn) => {
    events.set(name, fn as (payload: unknown) => void);
    return () => { events.delete(name); };
  });
  vi.spyOn(native, "agentSpawn").mockResolvedValue();
  vi.spyOn(native, "agentKill").mockImplementation(async (id) => fire("agent:exit", { id, code: 0 }));
  vi.spyOn(native, "workerExtensions").mockResolvedValue([]);
  vi.spyOn(native, "workerSkills").mockResolvedValue([]);
  vi.spyOn(native, "globalSkills").mockResolvedValue([]);
  vi.spyOn(native, "agentSend").mockImplementation(async (id, command) => {
    fire("agent:event", { id, ev: { type: "response", id: command.id, success: true, data: {} } });
    if (command.type === "abort") fire("agent:event", { id, ev: { type: "agent_settled" } });
  });
  await startRpc();
});
afterEach(async () => {
  for (const key of ["home", "home~@agent", "home~@agent:12345"]) {
    await stopMain(key);
    markDead(`captain:${key}`);
  }
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function working(project?: string) {
  throwThought("로그인해줘", "home", { project });
  await vi.waitFor(() => expect(vi.mocked(native.agentSend).mock.calls.some(([, c]) => c.type === "prompt")).toBe(true));
  return project ? `home~${project}` : "home";
}

describe("main extension confirmation cards", () => {
  it.each([undefined, "@agent", "@agent:12345"])("answers the original %s chat connection exactly once", async (project) => {
    const key = await working(project);
    ask(key);
    expect(state.decisions).toHaveLength(1);
    const d = state.decisions[0];
    expect(d.taskId).toBe(`main:${key}`);
    expect(d.ui).toEqual({ requestId: "approval", method: "confirm" });
    expect((project ? agentDecisions() : allDecisions()).map((x) => x.id)).toEqual([d.id]);
    const prompts = vi.mocked(native.agentSend).mock.calls.filter(([, c]) => c.type === "prompt").length;
    await decide(d.id, "yes");
    await decide(d.id, "yes");
    expect(responses()).toEqual([[`captain:${key}`, { type: "extension_ui_response", id: "approval", confirmed: true }]]);
    expect(vi.mocked(native.agentSend).mock.calls.filter(([, c]) => c.type === "prompt")).toHaveLength(prompts);
  });

  it.each(["stop", "exit", "tool end", "timeout"])("removes the card after %s and ignores its late answer", async (end) => {
    const key = await working();
    ask(key);
    expect(state.decisions).toHaveLength(1);
    const id = state.decisions[0].id;
    if (end === "stop") await stopMain(key);
    if (end === "exit") fire("agent:exit", { id: `captain:${key}`, code: 0 });
    if (end === "tool end") emit(key, { type: "tool_execution_end", toolCallId: "computer" });
    if (end === "timeout") await vi.advanceTimersByTimeAsync(1000);
    expect(state.decisions).toHaveLength(0);
    await decide(id, "yes");
    expect(responses()).toEqual([]);
  });

  it("drops only the cancelled request while another parallel tool is running", async () => {
    const key = await working("@agent");
    emit(key, { type: "tool_execution_start", toolCallId: "computer" });
    emit(key, { type: "tool_execution_start", toolCallId: "read" });
    ask(key);
    const cancelled = state.decisions[0].id;
    emit(key, { type: "extension_ui_request", id: "other", method: "confirm", title: "다른 확인" });
    const other = state.decisions[1].id;
    emit(key, { type: "extension_ui_cancel", id: "approval" });
    emit(key, { type: "tool_execution_end", toolCallId: "computer" });
    expect(state.decisions.map(d => d.id)).toEqual([other]);
    await decide(cancelled, "yes");
    expect(responses()).toEqual([]);
    await decide(other, "no");
    expect(responses()).toEqual([[`captain:${key}`, { type: "extension_ui_response", id: "other", confirmed: false }]]);
  });

  it("does not answer a replacement session using the old card", async () => {
    const key = await working();
    ask(key);
    const old = state.decisions[0].id;
    await resetMain("home");
    expect(state.decisions).toHaveLength(0);
    ask(key);
    const current = state.decisions[0].id;
    await decide(old, "yes");
    expect(responses()).toEqual([]);
    expect(state.decisions.map((d) => d.id)).toEqual([current]);
    await decide(current, "no");
    expect(responses()).toEqual([[`captain:${key}`, { type: "extension_ui_response", id: "approval", confirmed: false }]]);
  });

  it("checks expiry even before a delayed timer has run", async () => {
    const key = await working();
    ask(key);
    const id = state.decisions[0].id;
    vi.setSystemTime(Date.now() + 1001);
    await decide(id, "yes");
    expect(state.decisions).toHaveLength(0);
    expect(responses()).toEqual([]);
  });

  it("discards a restored UI card instead of turning it into a new user request", async () => {
    setState("decisions", [{ id: "old", taskId: "main:home", kind: "ask", at: 1, question: "보안 입력", options: [], context: [], ui: { requestId: "gone", method: "confirm" } }]);
    await decide("old", "yes");
    expect(state.captain).toHaveLength(0);
    expect(responses()).toEqual([]);
  });
});
