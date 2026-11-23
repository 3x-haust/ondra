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

describe("per Discord channel", () => {
  it("work asked in a channel set to its own workspace and account runs there; other channels go by the usual", async () => {
    setState("spaces", [{ id: "home", label: "개인" } as never, { id: "work", label: "회사" } as never]);
    setState("settings", "agent", {
      on: true,
      name: "메타몽",
      account: "a2",
      places: [
        { channel: "c-work", space: "work", account: "w1" },
        { channel: "c-side", account: "a1" },
      ],
    });
    // its own workspace, its own account there
    expect(agentAccount("work", "c-work")).toBe("w1");
    // the agent's usual workspace, another account than the usual one
    expect(agentAccount("home", "c-side")).toBe("a1");
    // a channel not listed: the usual
    expect(agentAccount("home", "c-else")).toBe("a2");
    const job = createTask({ space: "work", title: "회사 일", topic: "x", ask: "x", agent: { channel: "c-work" } });
    expect(state.tasks.find((t) => t.id === job)?.accountId).toBe("w1");
    const side = createTask({ space: "home", title: "사이드", topic: "x", ask: "x", agent: { channel: "c-side" } });
    expect(state.tasks.find((t) => t.id === side)?.accountId).toBe("a1");

    const { agentSpace } = await import("./discord");
    const a = state.settings.agent!;
    expect(agentSpace(a, "c-work")).toBe("work");
    expect(agentSpace(a, "c-side")).toBe("home");
    expect(agentSpace(a, "c-else")).toBe("home");
  });

  it("a channel set to a workspace without an account picked follows that workspace's choice", () => {
    setState("settings", "agent", { on: true, name: "메타몽", account: "a2", places: [{ channel: "c-work", space: "work" }] });
    expect(agentAccount("work", "c-work")).toBeUndefined();
  });
});
