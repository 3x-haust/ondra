import { describe, expect, it } from "vitest";
import { focusSteal, foreignData } from "./permissions";

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

describe("focusSteal", () => {
  it("catches what brings a window in front of the user", () => {
    expect(focusSteal(`osascript -e 'tell application "TextEdit" to activate'`)?.what).toMatch(/AppleScript/);
    expect(focusSteal(`osascript -e 'tell application "System Events" to keystroke "a"'`)?.what).toMatch(/System Events/);
    expect(focusSteal("open -a TextEdit note.txt")).toBeDefined();
    expect(focusSteal("cd x && open https://example.com")).toBeDefined();
    expect(focusSteal("agent-desktop launch Calculator --activate")).toBeDefined();
    expect(focusSteal("agent-desktop focus-window --app Notes")).toBeDefined();
    expect(focusSteal("agent-desktop mouse-click --xy 10,10")).toBeDefined();
    expect(focusSteal('agent-desktop click @s1:e2 --headed --session "$SID"')).toBeDefined();
    expect(focusSteal('agent-desktop press cmd+k --session "$SID"')?.what).toMatch(/press/);
  });
  it("lets background work through", () => {
    expect(focusSteal("open -g -a TextEdit note.txt")).toBeUndefined();
    expect(focusSteal("open -gj -a Calculator")).toBeUndefined();
    expect(focusSteal(`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`)).toBeUndefined();
    expect(focusSteal('agent-desktop press cmd+k --app Electron --session "$SID"')).toBeUndefined();
    expect(focusSteal('agent-desktop --session "$SID" snapshot --app Orbit -i')).toBeUndefined();
    expect(focusSteal('agent-desktop click @s1:e2 --session "$SID"')).toBeUndefined();
    expect(focusSteal("agent-desktop launch Calculator")).toBeUndefined();
    expect(focusSteal("git log --oneline | head")).toBeUndefined();
    expect(focusSteal("pnpm openapi:gen")).toBeUndefined();
  });
});
