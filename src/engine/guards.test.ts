import { describe, expect, it } from "vitest";
import type { Task } from "../state/types";
import { commandKind, isLocalWait, isTestRun, runsProgram, isSearch, SEARCH_STALL_MS, searchCall, searchStalled, shellArg, WAIT_STALL_MS, waitStalled } from "./commandKind";
import { ghTouched, isCodeFile, reviewFound, riskyChange } from "./proof";
import { backgroundShells, closePlan, lastReport, nextPlan, notTheirLanguage, onlyWaits } from "./tasks";

describe("commandKind", () => {
  it("status looks are polls", () => {
    for (const c of [
      "sleep 72; gh run view 42159843976 --json status,conclusion",
      'cd "$PWD" && gh api repos/a/b/actions/runs/1/jobs --jq .jobs',
      "asc status --app 6822234273 2>&1 | head -40",
      "curl -s https://example.com/status | jq .",
      "git status --short --branch",
      "git diff --stat",
      "pnpm --help",
      "git merge-tree -h",
      "gh pr checks 12",
    ])
      expect(commandKind(c), c).toBe("poll");
  });
  it("tests, type checks and builds are checks", () => {
    for (const c of ["pnpm -s typecheck", "pnpm test", "bun test ./tool/", "cargo test -q", "npx tsc --noEmit", "pnpm build", "pnpm run check:appshot"])
      expect(commandKind(c), c).toBe("check");
  });
  it("reading or listing a file is never a check, whatever its path", () => {
    for (const c of [
      "sed -n 1,18p 'src/app/(app)/home/__tests__/quest-list.test.tsx'",
      "ls build",
      "cat src/build/index.ts | grep tsc",
      "test -f dist/index.js && echo ok",
      "rg -n \"pnpm test\" package.json",
    ])
      expect(commandKind(c), c).not.toBe("check");
  });
  it("changing things is neither", () => {
    for (const c of ["git push origin main", "gh api repos/a/b/issues -f title=x", "curl -X POST https://x/y", "git checkout -b x", "gh pr merge 3 --merge"])
      expect(commandKind(c), c).toBe("other");
  });
});

describe("isTestRun", () => {
  it("runs of a test runner or a test script are test runs", () => {
    for (const c of [
      "pnpm -s test",
      "npm run test:unit 2>&1 | tail -20",
      "cd /repo && bunx vitest run 'src/app/(app)/home/__tests__/quest-list.test.tsx'",
      "for i in 1 2; do bunx vitest run src/a.test.ts; done",
      "cargo test -q",
      "go test ./...",
      "./gradlew test",
      "xcodebuild -scheme App test",
      "python3 -m pytest tests/",
      "bash scripts/test.sh",
      "out=$(npx jest src 2>&1); echo \"$out\" | tail -5",
    ])
      expect(isTestRun(c), c).toBe(true);
  });
  it("reading, printing or searching a test file is not", () => {
    for (const c of [
      "sed -n 1,18p 'src/app/(app)/home/__tests__/quest-list.test.tsx'",
      "cd /repo && cat src/lib/__tests__/api-client.test.ts | head -40",
      "head -60 src/a.test.ts; tail -5 /tmp/guest-test.log",
      "rg -n \"describe\\(\" src/__tests__ | wc -l",
      "grep -c PASS /tmp/test.log",
      "ls src/__tests__",
      "sed -n 1,80p /Applications/Ondra.app/Contents/Resources/app-skills/test-ci/SKILL.md",
      "test -d tests && echo yes",
      "python3 - <<'EOF'\np='src/__tests__/a.test.ts'\ns=open(p).read().replace('test(', 'it(')\nEOF",
      "git log --oneline -- src/__tests__",
    ])
      expect(isTestRun(c), c).toBe(false);
  });
  it("a program named in what is read or searched is not run", () => {
    expect(runsProgram("open http://localhost:3217/ >/dev/null 2>&1; agent-browser eval \"document.cookie\"", /\bagent-browser\b/)).toBe(true);
    expect(runsProgram("echo \"== $p $(agent-browser get url)\"", /\bagent-browser\b/)).toBe(true);
    expect(runsProgram("rg -n agent-browser skills/ | head", /\bagent-browser\b/)).toBe(false);
    expect(runsProgram("sed -n 1,80p skills/agent-browser/SKILL.md", /\bagent-browser\b/)).toBe(false);
  });
});

describe("isSearch", () => {
  it("finds, greps, listings and sizes that walk folders", () => {
    for (const c of [
      "find . -name x",
      "list=$(find . -name '*.html' -not -path '*/node_modules/*')",
      "cd web && find src -type f",
      "timeout 30 rg foo",
      "du -sh ~/*",
      "ls -R",
      "ls -laR src",
      "grep -r foo .",
      "grep -rn --include=*.ts foo src",
      "mdfind x",
      "for f in `find . -name '*.md'`; do wc -l $f; done",
      "sudo find / -name x",
      "/usr/bin/find . -type d",
      "tree -L 3",
      // rg walks src whether or not head cuts its output: a search (a quick one stops long before the watchdog)
      "rg foo src | head",
    ])
      expect(isSearch(c), c).toBe(true);
  });
  it("not builds, tests, git, or one-file reads", () => {
    for (const c of ["pnpm build", "vitest run", "git log --oneline -5", "git grep foo", "grep foo package.json", "cat a.txt | grep x", "ls -la", "echo 'find . -name x'", "cargo test", "pnpm dev"])
      expect(isSearch(c), c).toBe(false);
  });
  it("names the program and first argument as ps shows them", () => {
    expect(searchCall("list=$(find . -name '*.html')")).toEqual({ program: "find", arg: "." });
    expect(searchCall("cd web && /usr/bin/find src -type f")).toEqual({ program: "find", arg: "src" });
    expect(searchCall("timeout 30 rg 'a b' src")).toEqual({ program: "rg", arg: "a b" });
    expect(searchCall("find ~ -name x")).toEqual({ program: "find", arg: "~" });
    // the shell rewrites globs and variables: no argument to match on
    expect(searchCall("du -sh ~/*")).toEqual({ program: "du", arg: "-sh" });
    expect(searchCall("find $HOME -name x")).toEqual({ program: "find", arg: undefined });
  });
});

describe("searchStalled", () => {
  const at = 1_000_000;
  const find = { command: "find . -name '*.html'", startedAt: at };
  it("a search with no new output for the limit", () => {
    expect(searchStalled(find, at + SEARCH_STALL_MS - 1)).toBe(false);
    expect(searchStalled(find, at + SEARCH_STALL_MS)).toBe(true);
    // output came in since: counted from then
    expect(searchStalled({ ...find, changedAt: at + 60_000 }, at + SEARCH_STALL_MS)).toBe(false);
    expect(searchStalled({ ...find, changedAt: at + 60_000 }, at + 60_000 + SEARCH_STALL_MS)).toBe(true);
  });
  it("never a finished, background or non-search command", () => {
    const late = at + 10 * SEARCH_STALL_MS;
    expect(searchStalled({ ...find, endedAt: at + 1000 }, late)).toBe(false);
    expect(searchStalled({ ...find, background: true }, late)).toBe(false);
    for (const command of ["pnpm build", "pnpm test", "cargo build --release", "npm install", "sleep 600"])
      expect(searchStalled({ command, startedAt: at }, late), command).toBe(false);
  });
});

describe("isLocalWait", () => {
  it("waits for a local server or its ready line", () => {
    for (const c of [
      'for i in $(seq 1 60); do grep -q "Ready" /tmp/guest-dev.log && break; sleep 2; done; cd src/app && find . -name page.tsx',
      "for i in $(seq 1 45); do curl -s -o /dev/null -m 2 localhost:3000 && break; kill -0 $(cat /tmp/dev.pid) 2>/dev/null || break; sleep 2; done; tail -20 /tmp/dev.log",
      "until curl -sf http://127.0.0.1:5173 >/dev/null; do sleep 1; done",
      "while ! nc -z localhost 8080; do sleep 1; done",
      "for i in $(seq 1 30); do lsof -i :3000 >/dev/null && break; sleep 2; done",
      "for i in $(seq 1 40); do grep -qE 'Local:|ready in' vite.log && break; sleep 1; done",
      "npx wait-on http://localhost:3000",
    ])
      expect(isLocalWait(c), c).toBe(true);
  });
  it("not CI, store, build or test waits, nor a plain curl", () => {
    for (const c of [
      "for i in $(seq 1 60); do s=$(gh run view 1 --json status -q .status); [ \"$s\" = completed ] && break; sleep 30; done",
      "sleep 60; gh run view 42 --json status",
      "for i in $(seq 1 180); do test -f build.exit && break; sleep 2; done; tail -12 build.log",
      "for i in $(seq 1 120); do grep -q '^EXIT' server-test.log && break; sleep 5; done",
      "for i in $(seq 1 30); do asc status --app 1 | grep -q READY && break; sleep 60; done",
      "curl -s localhost:3000/api/health",
      "pnpm dev",
    ])
      expect(isLocalWait(c), c).toBe(false);
  });
});

describe("waitStalled", () => {
  const at = 1_000_000;
  const wait = { command: 'for i in $(seq 1 300); do grep -q "Ready" /tmp/dev.log && break; sleep 2; done', startedAt: at };
  it("a local wait with nothing new for the limit", () => {
    expect(waitStalled(wait, at + WAIT_STALL_MS - 1)).toBe(false);
    expect(waitStalled(wait, at + WAIT_STALL_MS)).toBe(true);
    // a loop that prints a line per page is still moving
    expect(waitStalled({ ...wait, changedAt: at + 100_000 }, at + WAIT_STALL_MS)).toBe(false);
    expect(waitStalled({ ...wait, changedAt: at + 100_000 }, at + 100_000 + WAIT_STALL_MS)).toBe(true);
  });
  it("never a finished command or another kind of wait", () => {
    const late = at + 10 * WAIT_STALL_MS;
    expect(waitStalled({ ...wait, endedAt: at + 1000 }, late)).toBe(false);
    for (const command of ["pnpm build", "pnpm test", "sleep 600", "for i in $(seq 1 60); do gh pr checks 3 && break; sleep 30; done"])
      expect(waitStalled({ command, startedAt: at }, late), command).toBe(false);
  });
});

describe("shellArg", () => {
  it("the first line of the command, as ps shows the shell running it", () => {
    expect(shellArg('for i in $(seq 1 60); do grep -q "Ready" /tmp/dev.log && break; sleep 2; done')).toBe('for i in $(seq 1 60); do grep -q "Ready" /tmp/dev.log && break; sleep 2; done');
    expect(shellArg("cd app && python3 - <<'EOF'\nprint(1)\nEOF")).toBe("cd app && python3 - <<'EOF'");
    // ps escapes backslashes and tabs: cut before them
    expect(shellArg("until curl -s localhost:3000; do printf '.\\n'; sleep 1; done")).toBe("until curl -s localhost:3000; do printf '.");
    expect(shellArg("sleep 5")).toBeUndefined();
    // a parallel call that starts the same way: matched on what only this one has
    const cd = 'cd "/Users/me/Library/Application Support/dev.3xhaust.ondra/worktrees/web-tmw1" && ';
    const wait = `${cd}for i in $(seq 1 60); do grep -qE "Ready|ready in" dev.log && break; sleep 2; done`;
    expect(shellArg(wait, [`${cd}pnpm build`])).toBe(wait);
    expect(shellArg(`${cd}grep -q "a\\|Ready" dev.log; sleep 2`, [`${cd}grep -q "a`])).toBe('|Ready" dev.log; sleep 2');
    // nothing tells them apart: no stop
    expect(shellArg(wait, [`${wait} && echo up`])).toBeUndefined();
  });
});

describe("backgroundShells", () => {
  it("what the job started in the background, newest first, once each", () => {
    const sh = (command: string, background = true) => ({ id: command, command, startedAt: 1, tail: "", background });
    expect(backgroundShells([
      sh("(nohup bun run dev > /tmp/dev.log 2>&1 &)"),
      sh("cat a.ts", false),
      sh("pnpm dev"),
      sh("(nohup bun run dev > /tmp/dev.log 2>&1 &)"),
    ])).toEqual(["(nohup bun run dev > /tmp/dev.log 2>&1 &)", "pnpm dev"]);
    expect(backgroundShells([sh("ls", false)])).toEqual([]);
  });
});

describe("isCodeFile", () => {
  const t = { cwd: "/repo", worktree: undefined } as Pick<Task, "cwd" | "worktree">;
  it("code in the job's folder", () => {
    expect(isCodeFile("/repo/src/a.ts", t)).toBe(true);
    expect(isCodeFile("src/a.ts", t)).toBe(true);
    expect(isCodeFile("/repo/package.json", t)).toBe(true);
  });
  it("not notes, data, artifacts or other folders", () => {
    expect(isCodeFile("/repo/notes.md", t)).toBe(false);
    expect(isCodeFile("/repo/out/notes.jsonl", t)).toBe(false);
    expect(isCodeFile("/repo/report-sections.json", t)).toBe(false);
    expect(isCodeFile("/data/artifacts/t1/build-report.py", t)).toBe(false);
    expect(isCodeFile("/elsewhere/x.ts", t)).toBe(false);
  });
});

describe("ghTouched", () => {
  const job = (...cmds: string[]) => ({ entries: cmds.map((c) => ({ kind: "tool", tool: { kind: "bash", target: c } })) }) as never;
  it("a release it made and a run it viewed", () => {
    expect(ghTouched(job("gh release create v1.1.12 --notes x"), "https://github.com/a/tavi/releases/tag/v1.1.12")).toBe(true);
    expect(ghTouched(job("gh api repos/a/b/actions/runs/42179950820 --jq .status"), "https://github.com/a/b/actions/runs/42179950820")).toBe(true);
    expect(ghTouched(job("gh run view 42179950820"), "https://github.com/a/b/actions/runs/42179950820")).toBe(true);
  });
  it("not some other release or run", () => {
    expect(ghTouched(job("gh release create v1.1.11"), "https://github.com/a/tavi/releases/tag/v1.1.12")).toBe(false);
    expect(ghTouched(job("gh run view 1"), "https://github.com/a/b/actions/runs/42179950820")).toBe(false);
  });
});

describe("reviewFound", () => {
  it("reads P1 and P2 one by one", () => {
    expect(reviewFound("P1 없음, P2 2건")).toBe(true);
    expect(reviewFound("no P1, 4 P2s")).toBe(true);
    expect(reviewFound("- **P2** `a.ts:70`: 대화가 풀려요")).toBe(true);
    expect(reviewFound("P1·P2 없음")).toBe(false);
    expect(reviewFound("P1 0개, P2 0개. P3 하나")).toBe(false);
    expect(reviewFound("문제 없음")).toBe(false);
  });
});

describe("handoff and reports", () => {
  const card = (next: string) => ({ did: [], found: [], next, doneWhen: "" }) as never;
  it("a card that only waits", () => {
    expect(onlyWaits(card("사용자의 답을 기다려요"))).toBe(true);
    expect(onlyWaits(card("리뷰 결과가 오면 P1·P2를 고쳐요"))).toBe(false);
    expect(onlyWaits(card("CI 실패 로그를 보고 고친 뒤 다시 푸시"))).toBe(false);
  });
  it("the last report line, not what it was doing", () => {
    const t = { entries: [{ kind: "text", text: "## 결과\n앱샷 PR을 올렸어요.\n자세히…" }, { kind: "tool", tool: {} }] } as never;
    expect(lastReport(t)).toBe("앱샷 PR을 올렸어요.");
  });
});

describe("narration language", () => {
  const korean = { entries: [{ id: "e", at: 0, kind: "user", text: "검증 그만하고 사진 올려" }] } as never;
  it("flags English lines for a Korean user, not code or Korean", () => {
    expect(notTheirLanguage("Now upload the photos to the PR body.", korean)).toBe(true);
    expect(notTheirLanguage("이제 사진을 PR 본문에 올려요.", korean)).toBe(false);
    expect(notTheirLanguage("```bash\ngh pr view 79\n```", korean)).toBe(false);
    expect(notTheirLanguage("Now upload the photos.", { entries: [{ id: "e", at: 0, kind: "user", text: "upload the photos" }] } as never)).toBe(false);
  });
});

describe("plan", () => {
  it("keeps finished steps when a new plan comes, and closes on finish", () => {
    const old = [
      { text: "원인 확인", state: "done" as const },
      { text: "사진 찍기", state: "now" as const },
      { text: "커밋·푸시", state: "todo" as const },
    ];
    const next = nextPlan(old, ["원인 확인", "커밋·푸시", "PR에 사진 넣기"]);
    expect(next.map((s) => s.state)).toEqual(["done", "now", "todo"]);
    expect(closePlan(next).map((s) => s.state)).toEqual(["done", "done", "skip"]);
  });
});

describe("waitsOnUser", () => {
  it("sees a job handing the next step to the user", async () => {
    const { waitsOnUser } = await import("./tasks");
    expect(waitsOnUser("`fix/x`를 직접 푸시하고 PR을 병합해 주세요. 기다릴게요.")).toBe(true);
    expect(waitsOnUser("병합 완료를 알려주시면 이어갈게요.")).toBe(true);
    expect(waitsOnUser("타입 검사를 돌렸고 통과했어요.")).toBe(false);
  });
});

describe("riskyChange", () => {
  it("asks for a review only for security, money or data loss", () => {
    expect(riskyChange(["/repo/src/auth/login.ts"])).toBe(true);
    expect(riskyChange(["/repo/src/billing.ts"])).toBe(true);
    expect(riskyChange(["/repo/db/migrations/002.sql"])).toBe(true);
    expect(riskyChange(["/repo/src/a.ts", "/repo/src/b.ts", "/repo/src/c.ts", "/repo/src/d.ts", "/repo/src/e.ts", "/repo/src/f.ts"])).toBe(false);
    expect(riskyChange(["/repo/src/engine/session.ts", "/repo/src-tauri/src/remote/handoff.rs"])).toBe(false);
  });
});
