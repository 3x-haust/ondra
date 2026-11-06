import { describe, expect, it } from "vitest";
import { addMemory, applying, inSpace, placeAll, placeOf, skillsIn } from "./memory";
import { setState, state } from "../state/store";
import type { Memory, Skill } from "../state/types";

const id = (x: string) => (p: string) => p.replace(/^~/, x);
const ex = id("/Users/u");
const piece = (o: Partial<Memory>): Memory => ({ id: o.id ?? Math.random().toString(36), text: o.text ?? "x", scope: "space", createdAt: 1, updatedAt: 1, uses: 0, ...o }) as Memory;

function reset(memory: Memory[] = [], skills: Skill[] = []) {
  setState("spaces", [
    { id: "work", label: "회사", folder: "/Users/u/Work" },
    { id: "home", label: "개인", folder: "~/p" },
  ] as never);
  setState("projects", [{ id: "a", name: "a", folder: "~/p/a", space: "home" }] as never);
  setState("tasks", [{ id: "t1", space: "work", title: "", status: "done" }] as never);
  setState("memory", memory);
  setState("skills", skills);
  setState("space", "home");
}

describe("memory belongs to one space", () => {
  it("places older project pieces by job, project, then space folder", () => {
    reset();
    expect(placeOf(piece({ scope: "project", project: "~/p/a", taskId: "t1" }))).toBe("work");
    expect(placeOf(piece({ scope: "project", project: "~/p/a" }))).toBe("home");
    expect(placeOf(piece({ scope: "project", project: "/Users/u/Work/x" }))).toBe("work");
    expect(placeOf(piece({ scope: "project", project: "/elsewhere" }))).toBeUndefined();
    expect(placeOf(piece({ scope: "global" }))).toBeUndefined();
  });

  it("writes the space into older pieces once", () => {
    reset([piece({ id: "p", scope: "project", project: "/Users/u/Work/x" }), piece({ id: "g", scope: "global" })]);
    expect(placeAll()).toBe(1);
    expect(state.memory.find((m) => m.id === "p")?.space).toBe("work");
    expect(state.memory.find((m) => m.id === "g")?.space).toBeUndefined();
  });

  it("never hands one space's project pieces to the other", () => {
    reset([
      piece({ id: "w", scope: "project", project: "~/p/a", space: "work" }),
      piece({ id: "h", scope: "project", project: "~/p/a", space: "home" }),
      piece({ id: "g", scope: "global" }),
    ]);
    const here = applying("home", ex("~/p/a"), ex).map((m) => m.id);
    expect(here.sort()).toEqual(["g", "h"]);
    expect(inSpace(state.memory[0], "home")).toBe(false);
    expect(inSpace(state.memory[0], "home", ["work"])).toBe(true);
  });

  it("keeps what a job saves for everywhere in its own space, and links only within it", () => {
    reset([piece({ id: "w", text: "배포는 금요일 오후에 하지 않아요 규칙", space: "work" })]);
    const got = addMemory("배포는 금요일 오후에 하지 않아요 원칙", "global", { space: "home", taskId: "nope", by: "agent", quiet: true });
    const m = state.memory.find((x) => x.id === got)!;
    expect(m.scope).toBe("space");
    expect(m.space).toBe("home");
    expect(m.links ?? []).not.toContain("w");
  });

  it("gives a grown skill only to its own space", () => {
    reset([piece({ id: "w", space: "work", skill: "deploy-flow" })], [
      { name: "deploy-flow", path: "/s/deploy", description: "", source: "ondra", enabled: true },
      { name: "shared", path: "/s/shared", description: "", source: "claude", enabled: true },
      { name: "mine", path: "/s/mine", description: "", source: "ondra", enabled: true, space: "home" },
    ] as Skill[]);
    expect(skillsIn("home").map((s) => s.name)).toEqual(["shared", "mine"]);
    expect(skillsIn("work").map((s) => s.name)).toEqual(["deploy-flow", "shared"]);
  });
});
