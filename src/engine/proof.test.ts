import { afterEach, describe, expect, it, vi } from "vitest";
import * as native from "../lib/native";
import type { Entry, Task } from "../state/types";
import { checkEvidence } from "./proof";

let n = 0;
const bash = (command: string, at = ++n): Entry => ({ id: `e${at}`, at, kind: "tool", tool: { name: "bash", kind: "bash", target: command, detail: command, ok: true } });
const edit = (path: string, at = ++n): Entry => ({ id: `e${at}`, at, kind: "tool", tool: { name: "edit", kind: "edit", target: path, detail: path, ok: true } });
const job = (entries: Entry[]): Task => ({
  id: "t", space: "home", topic: "", title: "", ask: "", cwd: "/repo", status: "running",
  priority: 2, weight: "light", accountId: "default", createdAt: 0, now: "", plan: [], legs: [], entries, shells: [], inbox: [],
});
const PR = "https://github.com/acme/app/pull/38";

afterEach(() => vi.restoreAllMocks());

describe("link evidence", () => {
  it.each([
    ["merged with gh", "gh pr merge 38 --merge --delete-branch"],
    ["created with gh", "gh pr create --title x --body y"],
    ["read with gh api", "gh api repos/acme/app/pulls/38"],
  ])("counts a PR the job %s as read", async (_, command) => {
    const [e] = await checkEvidence(job([bash(command)]), [{ kind: "link", ref: PR }]);

    expect(e.check).toBe("read");
  });

  it("does not count a different PR number", async () => {
    const [e] = await checkEvidence(job([bash("gh pr merge 37")]), [{ kind: "link", ref: PR }]);

    expect(e.check).toBe("unread");
  });
});

describe("screenshot evidence", () => {
  const shot = (modified: number) => vi.spyOn(native, "fsRead").mockResolvedValue({ text: null, size: 50_000, binary: true, modified });

  it("rejects a result shot taken before the last code change", async () => {
    shot(1_000);
    const [e] = await checkEvidence(job([edit("src/a.ts", 2_000)]), [{ kind: "shot", ref: "/repo/after.png" }]);

    expect(e.check).toBe("stale");
  });

  it("keeps a shot taken after the change, or one meant as the before picture", async () => {
    shot(1_000);
    const t = job([edit("src/a.ts", 500)]);
    const [after] = await checkEvidence(t, [{ kind: "shot", ref: "/repo/after.png" }]);
    const [before] = await checkEvidence(job([edit("src/a.ts", 2_000)]), [{ kind: "shot", ref: "/repo/01-before.png" }]);

    expect(after.check).toBe("exists");
    expect(before.check).toBe("exists");
  });
});
