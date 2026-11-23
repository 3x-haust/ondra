import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs build script
import { notesProblems } from "../scripts/release-notes.mjs";

describe("release notes", () => {
  it("takes Korean bullets under ## 바뀐 점, nested ones too", () => {
    expect(notesProblems("## 바뀐 점\n\n- 디스코드 에이전트\n  - 사진을 보내면 이제 직접 봐요.\n- `/btw` 명령은 파란색이에요.\n")).toEqual([]);
  });

  it("refuses notes without the heading (v0.70.1)", () => {
    const [problem] = notesProblems("- 작업이 끝나고 바뀐 파일을 어떻게 할지는 작업이 정해요.\n- 확인 못 한 게 있으면 한 번 더 확인해요.");
    expect(problem).toMatch(/must start with "## 바뀐 점"/);
  });

  it("refuses an English heading, prose under it, English bullets and no bullets", () => {
    expect(notesProblems("## What's changed\n- 고쳤어요.")[0]).toMatch(/must start with/);
    expect(notesProblems("## 바뀐 점\n작업이 빨라졌어요.")[0]).toMatch(/not a bullet/);
    expect(notesProblems("## 바뀐 점\n- Fixed the pause icon.")[0]).toMatch(/not in Korean/);
    expect(notesProblems("## 바뀐 점\n")[0]).toMatch(/no bullets/);
  });
});
