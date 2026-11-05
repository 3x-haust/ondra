import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Task } from "../state/types";
import { CAPTAIN_SYSTEM, SUB_SYSTEM, TASK_SYSTEM, taskSystem } from "./prompts";
import { startRpc } from "./rpc";
import { pauseTask, startTask } from "./tasks";

const task = (parentId?: string): Task => ({
  id: "coding-task", space: "home", topic: "Example", title: "Fix calculation",
  ask: "Fix the incorrect total.", cwd: "/workspace/example", status: "queued",
  priority: 2, weight: "light", accountId: "default", createdAt: 1,
  now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
  isolate: false, parentId,
});

beforeEach(() => {
  setState(reconcile(freshState()));
  setState("settings", "instructions", "Keep changes local.");
  setState("spaces", 0, "rules", "Follow repository checks.");
});

afterEach(() => {
  for (const t of state.tasks) pauseTask(t.id);
  vi.restoreAllMocks();
});

describe("coding defaults", () => {
  it.each([TASK_SYSTEM, SUB_SYSTEM])("includes the same core workflow in each worker role", (prompt) => {
    expect(prompt.match(/^# Coding work$/gm)).toHaveLength(1);
    for (const rule of [
      "AGENTS.md", "CLAUDE.md", "expected and actual", "root cause",
      "failing regression test", "smallest change", "same surface",
      "tests, type checks and lint", "unverified",
    ]) expect(prompt).toContain(rule);
    expect(prompt).not.toMatch(/Prove: once|no re-running checks|no new test files/);
  });

  it.each([
    ["task", TASK_SYSTEM],
    ["subagent", SUB_SYSTEM],
  ])("requires observable completion evidence for the %s role", (_role, prompt) => {
    for (const rule of [
      "execute it with a tool", "Reading code or predicting output",
      "already passed before the fix", "original failing path",
      "check -> command/action -> observed result",
      "what failed or was skipped, why", "report the work as incomplete",
    ]) expect(prompt.replace(/\s+/g, " ")).toContain(rule);
  });

  it("keeps role boundaries and the routing format", () => {
    expect(SUB_SYSTEM).toContain("Don't start subagents.");
    expect(TASK_SYSTEM).toContain("at most 4 at a time");
    expect(CAPTAIN_SYSTEM).toContain("you never do long work yourself");
    expect(CAPTAIN_SYSTEM).toContain("```route");
    expect(CAPTAIN_SYSTEM).toContain("Keep reproduction, fix and verification with one owning fork");
  });

  it("keeps optional user instructions out when empty", () => {
    setState("settings", "instructions", "  ");
    const parts = taskSystem(task());
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(TASK_SYSTEM);
    expect(parts.join("\n")).not.toContain("# User instructions");
  });
});

describe("worker prompt delivery", () => {
  // Only the native process/event boundary is replaced; prompt assembly, state,
  // task startup and RPC response handling all run their real implementations.
  beforeEach(async () => {
    const events = new Map<string, (payload: unknown) => void>();
    vi.spyOn(native, "onEvent").mockImplementation(async (name, fn) => {
      events.set(name, fn as (payload: unknown) => void);
      return () => { events.delete(name); };
    });
    vi.spyOn(native, "agentSpawn").mockResolvedValue();
    vi.spyOn(native, "agentSend").mockImplementation(async (id, command) => {
      events.get("agent:event")?.({
        id, ev: { id: command.id, type: "response", success: true, data: {} },
      });
    });
    await startRpc();
  });

  for (const role of ["task", "subagent"] as const) {
    it.each(["fresh", "resume", "handoff"])(`delivers ${role} defaults on %s without skills`, async (mode) => {
      const t = task(role === "subagent" ? "parent-task" : undefined);
      if (t.parentId) setState("tasks", [{ ...task(), id: t.parentId }]);
      if (mode === "handoff") t.legs = [{
        startedAt: 1, endedAt: 2,
        handoff: { did: ["Reproduced incorrect total"], next: "Fix the calculation", evidence: [] },
      }];
      setState("tasks", (list) => [...list, t]);

      await startTask(t.id, mode === "resume");

      expect(native.agentSpawn).toHaveBeenCalledTimes(1);
      const [id, cwd, args] = vi.mocked(native.agentSpawn).mock.calls[0];
      expect(id).toBe(`t:${t.id}`);
      expect(cwd).toBe(t.cwd);
      expect(args.includes("--continue")).toBe(mode === "resume");
      expect(args).not.toContain("--skill");
      const prompts = args.flatMap((arg, i) => arg === "--append-system-prompt" ? [args[i + 1]] : []);
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).toBe(role === "subagent" ? SUB_SYSTEM : TASK_SYSTEM);
      expect(prompts[1]).toBe("# User instructions\nKeep changes local.");
      expect(prompts[2]).toContain("Follow repository checks.");
      expect(prompts.join("\n").match(/^# Coding work$/gm)).toHaveLength(1);
      const sent = vi.mocked(native.agentSend).mock.calls.find(([, command]) => command.type === "prompt")?.[1];
      expect(sent?.message).toContain(mode === "resume" ? "다시 시작" : mode === "handoff" ? "Reproduced incorrect total" : t.ask);
      expect(state.tasks.find((x) => x.id === t.id)?.status).toBe("running");
    });
  }
});
