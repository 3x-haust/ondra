import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import { mainTools, throwThought } from "./captain";
import { markDead, startRpc } from "./rpc";

beforeEach(() => setState(reconcile(freshState())));
afterEach(() => {
  markDead("captain:home");
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("main skill discovery", () => {
  it.each([true, false])("loads skill search with lazy core available: %s", async (lazy) => {
    vi.spyOn(native, "workerExtensions").mockResolvedValue([
      ...(lazy ? ["/extensions/lazy-core.ts"] : []),
      "/extensions/web.ts", "/extensions/skills.ts", "/extensions/unrelated.ts",
    ]);

    const args = await mainTools();

    expect(args.flatMap((arg, i) => arg === "--extension" ? [args[i + 1]] : [])).toContain("/extensions/skills.ts");
    expect(args).not.toContain("/extensions/unrelated.ts");
  });

  it("passes searchable paths to main without putting the skill catalog in actual user messages", async () => {
    vi.useFakeTimers();
    const events = new Map<string, (payload: unknown) => void>();
    vi.spyOn(native, "onEvent").mockImplementation(async (name, fn) => {
      events.set(name, fn as (payload: unknown) => void);
      return () => { events.delete(name); };
    });
    vi.spyOn(native, "agentSpawn").mockResolvedValue();
    vi.spyOn(native, "agentKill").mockImplementation(async (id) => {
      events.get("agent:exit")?.({ id, code: 0 });
    });
    vi.spyOn(native, "agentSend").mockImplementation(async (id, command) => {
      const emit = (ev: unknown) => events.get("agent:event")?.({ id, ev });
      emit({ id: command.id, type: "response", success: true, data: {} });
      if (command.type === "prompt") {
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "확인했어요." }] } });
        emit({ type: "agent_settled" });
      }
    });
    vi.spyOn(native, "workerExtensions").mockResolvedValue(["/extensions/lazy-core.ts", "/extensions/skills.ts"]);
    vi.spyOn(native, "workerSkills").mockResolvedValue(["/bundled/SKILL.md"]);
    const pack = Array.from({ length: 6 }, (_, i) => ({
      name: `aws-${i}`, path: `/global/aws-${i}/SKILL.md`, description: `Amazon procedure ${i}`,
    }));
    vi.spyOn(native, "globalSkills").mockResolvedValue(pack);
    setState("skills", [
      { name: "home", path: "/home/SKILL.md", description: "Home-only catalog description", source: "ondra", enabled: true, space: "home" },
      { name: "work", path: "/work/SKILL.md", description: "Work-only catalog description", source: "ondra", enabled: true, space: "work" },
      { name: "off", path: "/off/SKILL.md", description: "Disabled catalog description", source: "ondra", enabled: false, space: "home" },
    ]);
    await startRpc();

    const replyId = throwThought("계산 오류를 확인해줘", "home");
    await vi.waitFor(() => expect(state.captain.find((m) => m.id === replyId)?.pending).toBe(false));

    expect(state.captain.find((m) => m.id === replyId)?.error).toBeUndefined();
    expect(native.agentSpawn).toHaveBeenCalledTimes(1);
    const [id, , args, env] = vi.mocked(native.agentSpawn).mock.calls[0];
    expect(id).toBe("captain:home");
    expect(args).toContain("--no-skills");
    expect(args).not.toContain("--skill");
    expect.soft(env.filter(([key]) => key === "ONDRA_SKILL_PATHS")).toEqual([
      ["ONDRA_SKILL_PATHS", JSON.stringify(["/bundled/SKILL.md", "/home/SKILL.md", ...pack.map((s) => s.path)])],
    ]);
    const prompts = vi.mocked(native.agentSend).mock.calls.filter(([, command]) => command.type === "prompt");
    expect(prompts).toHaveLength(1);
    const message = String(prompts[0][1].message);
    expect(message).toContain("계산 오류를 확인해줘");
    expect.soft(message).not.toContain("# Skills jobs can use");
    const context = `${args.join("\n")}\n${message}`;
    for (const description of [...state.skills.map((s) => s.description), ...pack.map((s) => s.description)])
      expect.soft(context).not.toContain(description);

    const send = async () => {
      const reply = throwThought("다시 확인해줘", "home");
      await vi.waitFor(() => expect(state.captain.find((m) => m.id === reply)?.pending).toBe(false));
      expect(state.captain.find((m) => m.id === reply)?.error).toBeUndefined();
    };
    await send();
    expect(native.agentSpawn).toHaveBeenCalledTimes(1);

    setState("skills", (list) => [...list, { name: "new", path: "/new/SKILL.md", description: "New procedure", source: "ondra", enabled: true, space: "home" }]);
    await send();
    expect(native.agentSpawn).toHaveBeenCalledTimes(2);
    const paths = () => JSON.parse(vi.mocked(native.agentSpawn).mock.lastCall![3].find(([key]) => key === "ONDRA_SKILL_PATHS")![1]);
    expect(paths()).toContain("/new/SKILL.md");

    setState("skills", (s) => s.name === "home", "enabled", false);
    await send();
    expect(native.agentSpawn).toHaveBeenCalledTimes(3);
    expect(paths()).not.toContain("/home/SKILL.md");

    setState("skills", (s) => s.name === "new", "description", "Updated procedure");
    await send();
    expect(native.agentSpawn).toHaveBeenCalledTimes(4);

    vi.mocked(native.globalSkills).mockResolvedValue(pack.map((s) => ({ ...s, description: `${s.description} updated` })));
    await send();
    expect(native.agentSpawn).toHaveBeenCalledTimes(5);

    setState("skills", (s) => s.name === "work", "description", "Other space update");
    await send();
    expect(native.agentSpawn).toHaveBeenCalledTimes(5);
    expect(native.agentKill).toHaveBeenCalledTimes(4);
  });
});
