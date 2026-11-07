import { describe, expect, it } from "vitest";
import { dropAsked } from "../src/ui/decisionText";
import type { Block } from "../src/state/types";

const t = (text: string) => ({ type: "text", text }) as Block;

describe("dropAsked", () => {
  it("drops the question the last words end on", () => {
    expect(dropAsked([t("초안을 썼어요.\n\n전체는 `a.md`에 있어요. 바로 게시할까요?")])).toEqual([t("초안을 썼어요.\n\n전체는 `a.md`에 있어요.")]);
  });
  it("drops a block that is only the question", () => {
    expect(dropAsked([t("앞 내용"), t("게시할까요?")])).toEqual([t("앞 내용")]);
  });
  it("keeps words that don't end on a question", () => {
    const b = [t("두 가지 방법이 있어요.")];
    expect(dropAsked(b)).toBe(b);
  });
});
