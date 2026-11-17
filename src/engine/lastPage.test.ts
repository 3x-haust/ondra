import { describe, expect, it } from "vitest";
import { lastPage } from "./lastPage";

describe("lastPage", () => {
  it("takes the address the command opened, not a dotted word after it", () => {
    expect(lastPage(["open http://localhost:8137/study >/dev/null; ondra-browser storage local remove stopic.token; ondra-browser open http:/"])).toBe("http://localhost:8137/study");
  });
  it("reads a bare domain only as the argument of an open", () => {
    expect(lastPage(["open stopic.mmhs.app/study"])).toBe("https://stopic.mmhs.app/study");
    expect(lastPage(["storage local remove stopic.token"])).toBeUndefined();
    expect(lastPage(["screenshot /tmp/x.png"])).toBeUndefined();
  });
  it("goes back to the last step that names a page", () => {
    expect(lastPage(["open https://a.example.com/x", "click text=확인", "eval \"document.title\""])).toBe("https://a.example.com/x");
  });
});
