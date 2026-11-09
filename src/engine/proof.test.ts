import { afterEach, describe, expect, it, vi } from "vitest";
import * as native from "../lib/native";
import type { Entry, Task } from "../state/types";
import { checkEvidence, resultLine, sawClaims, unbackedClaim } from "./proof";
import { shipped } from "./tasks";

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

describe("shipped", () => {
  const job = (target: string) => ({ entries: [{ kind: "tool", tool: { target } }] }) as never;
  it("sees work that already went out", () => {
    expect(shipped(job("git push -u origin feat/x"))).toBe(true);
    expect(shipped(job("gh pr merge 12 --merge"))).toBe(true);
    expect(shipped(job("asc submit --app 1 --version 1.14.0"))).toBe(true);
  });
  it("not for local work", () => {
    expect(shipped(job("git commit -m x && bun test"))).toBe(false);
    expect(shipped(job("asc status --app 1"))).toBe(false);
  });
});

describe("what the answer says it saw", () => {
  const base = (entries: Task["entries"] = []): Task => ({
    id: "j", space: "home", topic: "x", title: "x", ask: "x", cwd: "/w", status: "running", priority: 2, weight: "light",
    accountId: "a", createdAt: 1, now: "", plan: [], legs: [], entries, shells: [], inbox: [], isolate: false,
  });
  const edit = { id: "e1", at: 1, kind: "tool", tool: { name: "edit", kind: "edit", target: "a.ts", detail: "/w/src/a.ts", ok: true } } as Task["entries"][number];
  const click = { id: "e2", at: 2, kind: "tool", tool: { name: "browser", kind: "browser", target: "click", ok: true } } as Task["entries"][number];
  const said = "돼요. '무료로 시작하기'를 누르면 게스트 홈이 열려요. 브라우저에서 직접 눌러 확인했어요. 지금 켜져 있는 http://localhost:3000 에서 바로 보시면 돼요.";

  it("finds a claim of looking at the screen, not a pointer to where to look or a denial", () => {
    expect(sawClaims(said)).toEqual(["브라우저에서 직접 눌러 확인했어요."]);
    expect(sawClaims("브라우저 화면으로는 보지 않았어요.")).toEqual([]);
    expect(sawClaims("I verified the flow in the browser.")).toHaveLength(1);
  });

  it("holds when a browser step came after the last code change, or a fresh screenshot is there", () => {
    expect(unbackedClaim(base([edit, click]), said, [], [])).toBeNull();
    expect(unbackedClaim(base([edit]), said, [{ kind: "shot", ref: "/w/a.png", check: "exists" }], [])).toBeNull();
  });

  it("is sent back with no screen behind it, or when its own unverified list says it didn't look", () => {
    expect(unbackedClaim(base([click, edit]), said, [], [])?.why).toContain("화면을 본 기록");
    expect(unbackedClaim(base([edit, click]), said, [], ["브라우저 화면으로는 보지 않았어요. 홈 응답 내용으로만 확인했어요."])?.why).toContain("unverified에는");
  });

  it("reads the result line from a command's real output", () => {
    expect(resultLine("\x1b[32m✓\x1b[0m src/a.test.ts (3)\n\n Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Duration  1.2s\n")).toBe("Tests  3 passed (3)");
    expect(resultLine("vite v5\n✓ built in 2.31s\n")).toBe("✓ built in 2.31s");
    expect(resultLine("")).toBeUndefined();
  });
});
