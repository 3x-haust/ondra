import { describe, expect, it } from "vitest";
import type { Hook } from "./Hooks";
import { hooksFor } from "./hooksFor";

const hook = (id: string, space?: string): Hook => ({ id, event: "stop", matcher: "", command: "x", enabled: true, space });

describe("hooksFor (Settings › 훅, per workspace)", () => {
  const list = [hook("all"), hook("home", "home"), hook("work", "work"), hook("far", `h:${"a".repeat(64)}:home`), hook("gone", "old")];
  it("lists the workspace's own and those for every workspace", () => {
    expect(hooksFor(list, "work", ["home", "work"]).map((h) => h.id)).toEqual(["all", "work", "far", "gone"]);
  });
  it("keeps one set for a workspace not this device's reachable, to fix or remove", () => {
    expect(hooksFor(list, "home", ["home", "work"]).map((h) => h.id)).toEqual(["all", "home", "far", "gone"]);
  });
});
