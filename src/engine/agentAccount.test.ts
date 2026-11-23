import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState, state } from "../state/store";
import { checked } from "./appSettings";
import { agentAccount, createTask } from "./tasks";

beforeEach(() => {
  setState(reconcile(freshState()));
  setState("accounts", [
    { id: "a1", label: "Claude", space: "home", providers: ["anthropic"], model: "" } as never,
    { id: "a2", label: "GPT", space: "home", providers: ["openai"], model: "" } as never,
    { id: "w1", label: "회사", space: "work", providers: ["openai"], model: "" } as never,
  ]);
  setState("accountPick", { home: "a1" });
});

describe("the Discord agent's own AI account", () => {
  it("runs its jobs on the account picked for it, while the user's own jobs keep theirs", () => {
    setState("settings", "agent", { on: true, name: "메타몽", account: "a2" });
    expect(agentAccount("home")).toBe("a2");
    const bot = createTask({ space: "home", title: "봇 일", topic: "x", ask: "x", agent: { channel: "c1" } });
    const mine = createTask({ space: "home", title: "내 일", topic: "x", ask: "x" });
    expect(state.tasks.find((t) => t.id === bot)?.accountId).toBe("a2");
    expect(state.tasks.find((t) => t.id === mine)?.accountId).toBe("a1");
  });

  it("follows the workspace's choice when none is picked, or the picked one is gone or in another workspace", () => {
    setState("settings", "agent", { on: true, name: "메타몽" });
    expect(agentAccount("home")).toBeUndefined();
    setState("settings", "agent", { on: true, name: "메타몽", account: "w1" });
    expect(agentAccount("home")).toBeUndefined();
    setState("settings", "agent", { on: true, name: "메타몽", account: "auto" });
    expect(agentAccount("home")).toBeUndefined();
    const bot = createTask({ space: "home", title: "봇 일", topic: "x", ask: "x", agent: { channel: "c1" } });
    expect(state.tasks.find((t) => t.id === bot)?.accountId).toBe("a1");
  });

  it("can be set by name from the ondra skill's settings tool", () => {
    setState("settings", "agent", { on: true, name: "메타몽", space: "home" });
    expect(checked("agent.account", "a2")).toEqual({ ok: true, value: "a2" });
    expect(checked("agent.account", "auto")).toEqual({ ok: true, value: "auto" });
    expect(checked("agent.account", "w1").ok).toBe(false);
  });
});
