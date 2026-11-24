import { describe, expect, it } from "vitest";
import type { Entry } from "../state/types";
import { checksCovering, checksFor, checksOwed, checksPrompt, parseCheck, type LocalCheck } from "./localChecks";

const bash = (cmd: string, ok = true): Entry => ({ id: cmd, at: 0, kind: "tool", tool: { name: "bash", kind: "bash", target: cmd, detail: cmd, ok } });
const notes: LocalCheck = parseCheck("/d/checks/release-notes", JSON.stringify({ rule: "릴리즈 노트는 한국어 글머리표로", project: "~/w/ondra", run: "node {dir}/check.mjs notes.md", after: "scripts/release\\.mjs" }))!;
const tests: LocalCheck = parseCheck("/d/checks/codex", JSON.stringify({ rule: "Codex 토큰은 가려요", project: "~/w/ondra", run: "pnpm test extensions/secrets.test.ts", paths: ["extensions/secrets.ts"] }))!;

describe("local checks", () => {
  it("read a check.json, and skip one without a rule, a project or a command", () => {
    expect(notes).toMatchObject({ name: "release-notes", dir: "/d/checks/release-notes", after: "scripts/release\\.mjs", off: false });
    expect(parseCheck("/d/checks/x", JSON.stringify({ rule: "r", project: "p" }))).toBeUndefined();
    expect(parseCheck("/d/checks/x", "not json")).toBeUndefined();
  });

  it("hold only in their project, and only when on", () => {
    expect(checksFor("~/w/ondra/", [notes, tests]).map((c) => c.name)).toEqual(["release-notes", "codex"]);
    expect(checksFor("~/w/other", [notes, tests])).toEqual([]);
    expect(checksFor("~/w/ondra", [{ ...notes, off: true }, tests]).map((c) => c.name)).toEqual(["codex"]);
    expect(checksPrompt([notes])).toContain("never copy them into it");
    expect(checksPrompt([notes])).toContain("`node /d/checks/release-notes/check.mjs notes.md`");
  });

  it("cover the files under their paths, or a run of the command they come before", () => {
    const wt = "/x/worktrees/ondra-1";
    expect(checksCovering({ entries: [] }, [notes, tests], [`${wt}/src/other.ts`])).toEqual([]);
    expect(checksCovering({ entries: [] }, [notes, tests], [`${wt}/extensions/secrets.ts`]).map((r) => [r.check.name, r.ran])).toEqual([["codex", false]]);
    const released = checksCovering({ entries: [bash("node scripts/release.mjs notes.md --publish")] }, [notes], []);
    expect(released.map((r) => [r.check.name, r.ran])).toEqual([["release-notes", false]]);
    expect(checksOwed(released)[0]).toContain("안 돌렸어요: 릴리즈 노트는 한국어 글머리표로");
    // ran it (its folder named, ~ or not): the last run decides
    const failed = checksCovering({ entries: [bash("node ~/data/checks/release-notes/check.mjs notes.md", false), bash("node scripts/release.mjs notes.md")] }, [notes], []);
    expect(failed).toEqual([{ check: notes, ran: true, ok: false }]);
    expect(checksOwed(failed)[0]).toContain("실패했어요");
    const fixed = checksCovering({ entries: [bash("node /d/checks/release-notes/check.mjs notes.md", false), bash("node /d/checks/release-notes/check.mjs notes.md"), bash("node scripts/release.mjs notes.md")] }, [notes], []);
    expect(fixed).toEqual([{ check: notes, ran: true, ok: true }]);
    expect(checksOwed(fixed)).toEqual([]);
  });
});
