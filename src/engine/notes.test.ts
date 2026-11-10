import { describe, expect, it } from "vitest";
import { notesMarkdown, notesPrompt } from "./notes";

describe("project notes", () => {
  const at = new Date(2026, 10, 10);
  it("writes a job's block as the project's notes", () => {
    const md = notesMarkdown("acme", "결제 버튼 고치기", {
      state: "결제 페이지가 새 API로 넘어갔어요.",
      todo: ["환불 흐름 옮기기", ""],
      decisions: ["토스 대신 Stripe, 해외 결제 때문에"],
      where: ["src/pay/checkout.ts — 결제 진입점"],
    }, at)!;
    expect(md).toBe(
      "# acme\n\n2026-11-10 · 결제 버튼 고치기\n\n## 지금\n결제 페이지가 새 API로 넘어갔어요.\n\n## 남은 일\n- 환불 흐름 옮기기\n\n## 정한 것\n- 토스 대신 Stripe, 해외 결제 때문에\n\n## 위치\n- src/pay/checkout.ts — 결제 진입점\n",
    );
  });
  it("leaves the notes alone when the block says nothing", () => {
    expect(notesMarkdown("acme", "x", { todo: [] }, at)).toBeUndefined();
  });
  it("tells the first job it starts the notes", () => {
    expect(notesPrompt("acme", "")).toContain("none yet");
    expect(notesPrompt("acme", "# acme\n## 지금\n반쯤 됐어요")).toContain("반쯤 됐어요");
  });
});
