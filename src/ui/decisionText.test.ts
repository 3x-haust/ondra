import { describe, expect, it } from "vitest";
import { bareLabel } from "./decisionText";

describe("bareLabel", () => {
  it("drops a recommendation the label already carries", () => {
    expect(bareLabel("표지형 · 추천")).toBe("표지형");
    expect(bareLabel("편집형 (추천)")).toBe("편집형");
    expect(bareLabel("Cover - recommended")).toBe("Cover");
    expect(bareLabel("추천")).toBe("추천");
    expect(bareLabel("추천 받은 안")).toBe("추천 받은 안");
    expect(bareLabel("편집형")).toBe("편집형");
  });
});
