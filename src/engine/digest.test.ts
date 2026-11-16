import { describe, expect, it } from "vitest";
import type { Task } from "../state/types";
import { digestInput, digestPrompt, parseDigest } from "./digest";

const job = (entries: unknown[]): Task => ({ id: "t1", ask: "이거 분석해서 원리 알려줘", summary: "원리 분석, 불가 확인, 방안 정리", entries } as unknown as Task);

describe("digest", () => {
  // Hologram (Nov 16): the report, then two bounces by the finishing gate, then words about rerunning
  const hologram = job([
    { kind: "user", text: "이거 분석해서 원리 알려줘" },
    { kind: "tool", tool: { name: "bash" } },
    { kind: "text", text: "윈도 + 아이폰은 안 돼요. 통화 음성은 맥에서만 이어져요." },
    { kind: "block", block: { type: "table", columns: ["OS", "아이폰"], rows: [["Mac", "됨"], ["Windows", "안 됨"]] } },
    { kind: "user", text: "끝내기 전에 빠진 게 있어요: 근거의 명령이 이 세션에서 돈 기록이 없어요" },
    { kind: "tool", tool: { name: "bash" } },
    { kind: "user", text: '"계속할까요?" → 계속' },
    { kind: "text", text: "네 명령을 다시 돌렸고 결과는 처음과 같아요." },
  ]);

  it("reads everything since the user's ask, past Ondra's own messages and answered cards", () => {
    const input = digestInput(hologram)!;
    expect(input.ask).toBe("이거 분석해서 원리 알려줘");
    expect(input.words).toContain("윈도 + 아이폰은 안 돼요");
    expect(input.words).toContain("Windows | 안 됨");
    expect(input.words).toContain("네 명령을 다시 돌렸고");
    expect(input.words).not.toContain("끝내기 전에 빠진 게 있어요");
  });

  it("starts at the user's latest ask", () => {
    const again = job([...hologram.entries, { kind: "user", text: "그럼 안드로이드는?" }, { kind: "text", text: "안드로이드는 ADB로 돼요." }]);
    const input = digestInput(again)!;
    expect(input.ask).toBe("그럼 안드로이드는?");
    expect(input.words).not.toContain("윈도 + 아이폰");
  });

  it("asks for the outcome first, without how it was checked", () => {
    const p = digestPrompt(digestInput(hologram)!);
    expect(p).toContain("Korean");
    expect(p).toContain("the outcome in one sentence");
    expect(p).toContain("Leave out how the job checked, re-ran or proved things");
  });

  it("takes the first line as the row's line and the rest as its points", () => {
    expect(parseDigest("**윈도 + 아이폰은 안 돼요.**\n\n- 통화 음성은 맥에서만 이어져요\n- 요메이츠 PC는 맥에서만 가능해요\n")).toEqual({
      line: "윈도 + 아이폰은 안 돼요.",
      text: "- 통화 음성은 맥에서만 이어져요\n- 요메이츠 PC는 맥에서만 가능해요",
    });
    expect(parseDigest("  \n")).toBeUndefined();
  });

  it("has nothing to write when the job said nothing", () => {
    expect(digestInput(job([{ kind: "user", text: "해줘" }, { kind: "tool", tool: { name: "bash" } }]))?.words).toContain("(done:");
    expect(digestInput({ ...job([{ kind: "user", text: "해줘" }]), summary: undefined } as Task)).toBeUndefined();
  });
});
