import { describe, expect, it } from "vitest";
import type { Entry, Task } from "../state/types";
import { causeFooting, checkedClaims, isBugFix, leftovers, readUnverified, reproGap, unbackedChecked, unreasoned } from "./proof";

let n = 0;
const bash = (command: string, ok = true, at = ++n): Entry => ({ id: `e${at}`, at, kind: "tool", tool: { name: "bash", kind: "bash", target: command, detail: command, ok } });
const read = (path: string, at = ++n): Entry => ({ id: `e${at}`, at, kind: "tool", tool: { name: "read", kind: "read", target: path, detail: path, ok: true } });
const edit = (path: string, at = ++n): Entry => ({ id: `e${at}`, at, kind: "tool", tool: { name: "edit", kind: "edit", target: path, detail: path, ok: true } });
const job = (entries: Entry[], branch?: string): Task => ({
  id: "t", space: "home", topic: "", title: "", ask: "", cwd: "/repo", status: "running", ...(branch ? { branch } : {}),
  priority: 2, weight: "light", accountId: "default", createdAt: 0, now: "", plan: [], legs: [], entries, shells: [], inbox: [],
});

describe("a report's cause and its footing", () => {
  it("tells a bare cause, a guess and a checked one apart", () => {
    expect(causeFooting("고쳤어요.\n\n**고친 것** 저장 순서를 바꿨어요")).toBe("none");
    expect(causeFooting("**원인** `app.js:3`에서 기본값이 저장값을 덮었어요\n\n**고친 것** …")).toBe("bare");
    expect(causeFooting("**원인** 불러올 때 덮어쓰는 것 같아요 (추측)\n**고친 것** …")).toBe("guess");
    expect(causeFooting("**원인** `app.js:3`의 `{ ...t, ...DEFAULTS }`가 done을 false로 덮어요. node로 그 식만 돌려 확인했어요 (확인함)")).toBe("labelled");
    expect(causeFooting("**원인**: 가설은 덮어쓰기였고 (추측) 로그로 확인했어요 (측정함)")).toBe("labelled");
  });

  it("asks for something that looked behind \"(확인함)\"", () => {
    const said = "원인은 기본값 순서예요. 식만 돌려 확인했어요 (확인함)";
    expect(checkedClaims(said)).toEqual(["식만 돌려 확인했어요 (확인함)"]);
    expect(unbackedChecked(job([read("/repo/app.js")]), said)).toBe("식만 돌려 확인했어요 (확인함)");
    expect(unbackedChecked(job([read("/repo/app.js"), bash("node -e '…'")]), said)).toBeNull();
    // a command that failed did not look
    expect(unbackedChecked(job([bash("node -e '…'", false)]), said)).not.toBeNull();
  });
});

describe("what the job couldn't check", () => {
  it("reads strings, \"what — why\" and objects, and names the ones with no real reason", () => {
    const list = readUnverified([
      "시뮬레이터 QA 스크린샷·영상을 PR 본문에 첨부하지 않음",
      "실기기 푸시 알림 — 사용자의 아이폰이 필요해요",
      { what: "결제 실서버 확인", why: "실제 결제가 나가요" },
      { what: "다크 모드", why: "시간" },
      "",
    ]);
    expect(list.map((u) => u.what)).toEqual(["시뮬레이터 QA 스크린샷·영상을 PR 본문에 첨부하지 않음", "실기기 푸시 알림", "결제 실서버 확인", "다크 모드"]);
    expect(unreasoned(list).map((u) => u.what)).toEqual(["시뮬레이터 QA 스크린샷·영상을 PR 본문에 첨부하지 않음", "다크 모드"]);
  });
});

describe("a bug's reproduction", () => {
  it("is a fix/ branch's", () => {
    expect(isBugFix(job([], "fix/login-bounce"))).toBe(true);
    expect(isBugFix(job([], "feat/signup"))).toBe(false);
  });

  it("ran before the first code change and passed after the last", () => {
    const repro = "node scripts/persist-check.js";
    expect(reproGap(job([edit("/repo/app.js"), bash(repro)]), repro)).toBe("before");
    expect(reproGap(job([bash(repro, false), edit("/repo/app.js"), bash(repro, false)]), repro)).toBe("after");
    expect(reproGap(job([bash(repro, false), edit("/repo/app.js"), edit("/repo/b.js"), bash(repro)]), repro)).toBeNull();
    // passing before the last edit doesn't cover it
    expect(reproGap(job([bash(repro, false), edit("/repo/app.js"), bash(repro), edit("/repo/b.js")]), repro)).toBe("after");
  });
});

describe("what a diff shouldn't carry out", () => {
  const patch = [
    "diff --git a/src/app.ts b/src/app.ts",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -10,3 +10,9 @@ export function load() {",
    "   const saved = read();",
    "+  console.log('saved', saved);",
    "+  // TODO: 나중에 정리",
    "+  // const old = merge(saved, DEFAULTS);",
    "+  // the saved value wins over the defaults",
    "+  return { ...DEFAULTS, ...saved };",
    "-  return { ...saved, ...DEFAULTS };",
    "+  // 임시로 이렇게 둠",
    "diff --git a/README.md b/README.md",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1,2 @@",
    "+// TODO in prose is fine",
  ].join("\n");

  it("names debug output, code left commented out and fix-later notes, with where they are", () => {
    expect(leftovers(patch)).toEqual([
      "src/app.ts:11 디버그 출력",
      "src/app.ts:12 나중에 고치겠다는 주석",
      "src/app.ts:13 주석으로 남긴 코드",
      "src/app.ts:16 나중에 고치겠다는 주석",
    ]);
  });

  it("leaves prose, Rust derefs and a script's own output alone", () => {
    const quiet = [
      "--- a/src/hosts.ts",
      "+++ b/src/hosts.ts",
      "@@ -1,0 +1,6 @@",
      "+/** \"off\": disconnected here for now (연결 끊기) */",
      "+  // browse (the browser-use skill's lean loop over ondra-browser)",
      "+ * for something that isn't coming (the server crashed, its port was taken)",
      "+  // the todo list keeps its order",
      "+  // 임시 파일은 스크래치 폴더에 둬요",
      "+  // if the user said so, stop",
      "--- a/src-tauri/src/secrets.rs",
      "+++ b/src-tauri/src/secrets.rs",
      "@@ -140,0 +141,2 @@",
      "+        *cache = Some(vault.clone());",
      "+        *text = json!(format!(\"…{}\", tail));",
      "--- a/scripts/release.mjs",
      "+++ b/scripts/release.mjs",
      "@@ -1,0 +1,1 @@",
      "+console.log(`released ${version}`);",
      "--- a/src/cli/main.ts",
      "+++ b/src/cli/main.ts",
      "@@ -1,0 +1,1 @@",
      "+console.log(table);",
      "--- a/src/report.ts",
      "+++ b/src/report.ts",
      "@@ -1,1 +1,2 @@",
      " console.log(header);",
      "+console.log(rows);",
    ].join("\n");
    expect(leftovers(quiet)).toEqual([]);
    // still named: a debugger line in a script, a call commented out, a "for now" that promises to come back
    expect(leftovers(["+++ b/scripts/x.mjs", "@@ -1,0 +1,3 @@", "+debugger;", "+// save(state);", "+// for now, skip the cache"].join("\n"))).toEqual([
      "scripts/x.mjs:1 디버그 출력",
      "scripts/x.mjs:2 주석으로 남긴 코드",
      "scripts/x.mjs:3 나중에 고치겠다는 주석",
    ]);
  });

  it("leaves the repo's own explaining comments and files the job didn't touch alone", () => {
    expect(leftovers(patch).some((l) => l.includes("wins over"))).toBe(false);
    expect(leftovers(patch, (f) => f !== "src/app.ts")).toEqual([]);
  });
});
