import { describe, expect, it, vi } from "vitest";

// the menu host draws JSX (a DOM this node run doesn't have)
vi.mock("./taskMenu", () => ({ openMenuAt: vi.fn() }));

import { setState } from "../state/store";
import { imageName, menuItems, menuTarget } from "./appMenu";

/** just enough of an element: what closest() finds for each selector */
const el = (found: Record<string, unknown>) => ({ closest: (s: string) => found[s] ?? null }) as unknown as Element;
const FIELD = "input, textarea, [contenteditable=''], [contenteditable='true']";

describe("a right-click", () => {
  setState("settings", "language", "ko");
  it("on a picture offers copy and save, and the address for a web one", () => {
    const m = menuTarget(el({ img: { currentSrc: "https://x.dev/a/shot%201.png", alt: "" } }), "");
    expect(m).toEqual({ kind: "image", src: "https://x.dev/a/shot%201.png", name: "shot 1.png" });
    expect(menuItems(m).flatMap((i) => (i === "sep" ? [] : [i.id]))).toEqual(["copy-image", "save-image", "copy-image-link"]);
    expect(menuItems({ kind: "image", src: "data:image/png;base64,AA", name: "image" }).length).toBe(2);
  });
  it("on picked text copies it; in a field leaves the system's menu", () => {
    expect(menuTarget(el({}), " 고른 글 ")).toEqual({ kind: "text", text: " 고른 글 " });
    expect(menuTarget(el({ [FIELD]: {} }), "x")).toEqual({ kind: "field" });
  });
  it("on nothing in particular shows nothing (no 새로 고침)", () => {
    expect(menuTarget(el({}), "")).toEqual({ kind: "none" });
    expect(menuItems({ kind: "none" })).toEqual([]);
  });
  it("names a picture by its file, else what it shows", () => {
    expect(imageName("asset://localhost/%2FUsers%2Fme%2Fcap.jpg")).toBe("cap.jpg");
    expect(imageName("data:image/png;base64,AA", "화면")).toBe("화면");
    expect(imageName("blob:xyz")).toBe("image");
  });
});
