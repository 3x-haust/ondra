import { afterEach, describe, expect, it, vi } from "vitest";
import { setState, state } from "../state/store";
import * as aside from "./aside";
import { absorbNotes, type Note } from "./absorb";

afterEach(() => vi.restoreAllMocks());

describe("notes brought in from a project folder", () => {
  it("file a piece about the user for every project, the rest for the project", async () => {
    setState("spaces", [{ id: "work", label: "회사", folder: "/Users/u/Work" }] as never);
    setState("projects", [{ id: "acme", name: "acme", folder: "~/Work/acme", space: "work" }] as never);
    setState("memory", []);
    const ask = vi.spyOn(aside, "oneShot").mockResolvedValue(
      "```pieces\n" +
        JSON.stringify([
          { text: "사용자에게 보내는 답과 상태 줄은 한국어로 써요", kind: "rule", user: true },
          { text: "acme 저장소의 색은 디자인 토큰만 써요", kind: "rule" },
        ]) +
        "\n```",
    );
    const note: Note = { path: "/Users/u/.claude/projects/-Users-u-Work-acme/memory/user-korean.md", text: "---\ntype: user\n---\n한국어로 답해", hash: "h", space: "work", project: "~/Work/acme" };
    expect(await absorbNotes([note])).toBe(2);
    expect(ask.mock.calls[0][2]).toContain("user=true for a piece about the user");
    const by = (t: string) => state.memory.find((m) => m.text.startsWith(t));
    expect(by("사용자에게")).toMatchObject({ scope: "global", project: undefined, from: note.path });
    expect(by("acme")).toMatchObject({ scope: "project", project: "~/Work/acme" });
  });
});
