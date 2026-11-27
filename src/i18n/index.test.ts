import { describe, expect, it } from "vitest";
import { setState } from "../state/store";
import { inLang, t } from "./index";

describe("t", () => {
  it("keeps Korean and strips a context", () => {
    setState("settings", "language", "ko");
    expect(t("일시정지|action")).toBe("일시정지");
    expect(t("{n}개", { n: 3 })).toBe("3개");
  });
  it("uses English, context first, and picks singular or plural", () => {
    setState("settings", "language", "en");
    expect(t("일시정지|action")).toBe("Pause");
    expect(t("일시정지")).toBe("Paused");
    expect(t("없는 말")).toBe("없는 말");
    setState("settings", "language", "ko");
  });
  it("writes in another language for a while (a page made for another device), then in its own again", () => {
    setState("settings", "language", "ko");
    expect(inLang("en", () => t("일시정지|action"))).toBe("Pause");
    expect(() => inLang("en", () => { throw new Error("x"); })).toThrow("x");
    expect(t("일시정지|action")).toBe("일시정지");
  });
});
