import { describe, expect, it } from "vitest";
import { dropOffers } from "./offers";

describe("dropOffers", () => {
  it("takes out offers of more work", () => {
    expect(dropOffers("컴퓨터 유즈를 끝까지 만들고 PR까지만 올릴게요. 압축 버튼 PR도 같이 원하시면 말씀해 주세요.")).toBe("컴퓨터 유즈를 끝까지 만들고 PR까지만 올릴게요.");
    expect(dropOffers("빌드는 성공했어요.\n\n이어서 배포도 할까요?")).toBe("빌드는 성공했어요.");
    expect(dropOffers("결과예요.\n- 필요하시면 표로도 정리해 드릴게요")).toBe("결과예요.");
  });
  it("leaves everything else", () => {
    expect(dropOffers("원하시면 말씀해 주세요.")).toBe("원하시면 말씀해 주세요.");
    expect(dropOffers("```\nif (x) 할까요?\n```")).toBe("```\nif (x) 할까요?\n```");
    expect(dropOffers("두 가지로 나눠서 바로 시작할게요")).toBe("두 가지로 나눠서 바로 시작할게요");
  });
});
