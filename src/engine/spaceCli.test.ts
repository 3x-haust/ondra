import { afterEach, describe, expect, it, vi } from "vitest";
import * as native from "../lib/native";
import { setState, state } from "../state/store";
import { candidates, commandOf, ensureCommands, installCommand } from "./spaceCli";

afterEach(() => vi.restoreAllMocks());

describe("a workspace's terminal command", () => {
  it("is named from the space, or work, work2 … when the name has no latin letters", () => {
    expect(commandOf("Client Work")).toBe("client-work");
    expect(commandOf("회사")).toBe("");
    expect(candidates({ id: "a", label: "회사", folder: "~", rules: "" }, ["work"]).slice(0, 2)).toEqual(["work2", "work3"]);
  });

  it("is made with the space: a name the Mac already has is skipped, a typed one's error comes back", async () => {
    setState("spaces", [
      { id: "home", label: "개인", folder: "~", rules: "" },
      { id: "sp1", label: "회사", folder: "~/Work", rules: "" },
      { id: "sp2", label: "Mine", folder: "~", rules: "", cliHome: "~/.local/share/company-cli/home" },
    ]);
    const install = vi.spyOn(native, "spaceCliInstall").mockImplementation(async (_s, cmd) => {
      if (cmd === "work") throw new Error("work은(는) 이미 있는 명령이에요");
      return { path: `/Users/me/.local/bin/${cmd}`, off_path: false };
    });
    await ensureCommands();
    // the user's own setup (a CLI home of theirs) gets none until named; 개인 never
    expect(install.mock.calls.map((c) => [c[0].id, c[1]])).toEqual([
      ["sp1", "work"],
      ["sp1", "work2"],
    ]);
    expect(state.spaces.find((s) => s.id === "sp1")!.command).toBe("work2");
    expect(await installCommand(state.spaces.find((s) => s.id === "sp2")!, "work")).toEqual({ error: "work은(는) 이미 있는 명령이에요" });
    expect(await installCommand(state.spaces.find((s) => s.id === "sp2")!, "work2")).toEqual({ error: "다른 워크스페이스가 쓰는 이름이에요" });
    // renamed: the old one goes (natively, as previous)
    await installCommand(state.spaces.find((s) => s.id === "sp1")!, "office");
    expect(install).toHaveBeenLastCalledWith(expect.objectContaining({ id: "sp1" }), "office", "work2");
  });
});
