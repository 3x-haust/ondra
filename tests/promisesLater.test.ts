import { describe, expect, it } from "vitest";
import { promisesLater } from "../src/engine/proof";

describe("promisesLater", () => {
  it("catches a done that only promises the work", () => {
    expect(promisesLater("정책을 저장했어요. 기능 완성 후 버전 충돌을 확인하고, 기존 머지 커밋·릴리스 절차로 정식 배포할게요.")).toBe(true);
    expect(promisesLater("테스트를 마저 돌려 볼게요")).toBe(true);
  });
  it("lets a finished summary through", () => {
    expect(promisesLater("PR 병합과 마이너 베타 배포를 마쳤어요")).toBe(false);
    expect(promisesLater("나중에 할게요라는 말은 지웠어요.")).toBe(false);
  });
});
