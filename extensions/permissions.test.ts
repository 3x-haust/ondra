import { describe, expect, it } from "vitest";
import { foreignData } from "./permissions";

const D = "/Users/me/Library/Application Support/ondra";
describe("foreignData", () => {
  const ok = ["t1", "t0"];
  it("lets a job read its own worktree, log and results", () => {
    expect(foreignData(`cat "${D}/worktrees/app-t1/src/a.ts"`, D, ok, "home")).toBeUndefined();
    expect(foreignData(`rg x ${D}/sessions/t0/a.jsonl`, D, ok, "home")).toBeUndefined();
    expect(foreignData(`ls ${D}/artifacts/t1`, D, ok, "home")).toBeUndefined();
    expect(foreignData(`ls ${D}/browser/home/recipes/github.com`, D, ok, "home")).toBeUndefined();
  });
  it("blocks the app state and anything of other jobs or the other space", () => {
    expect(foreignData(`cat ${D}/state.json`, D, ok, "home")).toBe("state.json");
    expect(foreignData(`rg token ${D}/sessions/t9/x.jsonl`, D, ok, "home")).toBe("sessions/t9");
    expect(foreignData(`ls ${D}/sessions/`, D, ok, "home")).toBe("sessions/");
    expect(foreignData(`cat ${D}/worktrees/app-t9/.env`, D, ok, "home")).toBe("worktrees/app-t9");
    expect(foreignData(`ls ${D}/browser/work/recipes`, D, ok, "home")).toBe("browser/work");
    expect(foreignData(`ls ${D}/spaces/work/logs`, D, ok, "home")).toBe("spaces/work");
  });
  it("leaves paths outside the data folder alone", () => {
    expect(foreignData("cat ~/projects/app/README.md", D, ok, "home")).toBeUndefined();
  });
});
