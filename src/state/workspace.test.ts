import { reconcile } from "solid-js/store";
import { beforeEach, describe, expect, it } from "vitest";
import { freshState, setState, state } from "./store";
import type { Task } from "./types";
import { setView, view } from "./ui";
import { carried, switchSpace } from "./workspace";

const job = (id: string, space: "home" | "work"): Task => ({
  id, space, topic: "", title: id, ask: "", cwd: "/", status: "running",
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
});

beforeEach(() => {
  setState(reconcile(freshState()));
  setState("spaces", [{ id: "home", label: "개인", folder: "~", rules: "" }, { id: "work", label: "회사", folder: "~", rules: "" }]);
  setState("space", "home");
  setState("tasks", [job("thome00000001", "home"), job("twork00000001", "work")]);
  setState("projects", [{ id: "site", space: "home", name: "site", folder: "~/site" }]);
  setView({ name: "main" });
});

describe("switching workspace", () => {
  it("keeps a screen both spaces have", () => {
    for (const v of [{ name: "memory" }, { name: "results" }, { name: "board" }, { name: "devices" }, { name: "settings", tab: "accounts" }] as const) {
      setState("space", "home");
      setView(v);
      switchSpace("work");
      expect(state.space).toBe("work");
      expect(view()).toEqual(v);
    }
  });

  it("lands a task or a project of the other space on Main", () => {
    expect(carried({ name: "task", id: "thome00000001" }, "work")).toEqual({ name: "main" });
    expect(carried({ name: "main", project: "site" }, "work")).toEqual({ name: "main" });
    setView({ name: "task", id: "thome00000001" });
    switchSpace("work");
    expect(view()).toEqual({ name: "main" });
  });

  it("opens the other space's own results list, not this one's result", () => {
    expect(carried({ name: "results", id: "r1" }, "work")).toEqual({ name: "results" });
  });
});
