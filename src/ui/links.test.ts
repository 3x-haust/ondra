import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ openExternal: vi.fn(async () => {}), revealPath: vi.fn(async () => {}) }));
vi.mock("../lib/native", async (orig) => ({ ...(await orig<typeof import("../lib/native")>()), ...native }));
// the menu host draws JSX (a DOM this node run doesn't have)
vi.mock("./taskMenu", () => ({ openMenuAt: vi.fn() }));

import { setState } from "../state/store";
import { browserTarget, panelOpen, panelShared, panelTab, previewPath, setBrowserTarget, setPanelOpen, setPtabs, setActiveTab, setView } from "../state/ui";
import { linkMenuItems, openLink } from "./links";

beforeEach(() => {
  native.openExternal.mockClear();
  native.revealPath.mockClear();
  setState("settings", "links", undefined);
  setView({ name: "main" });
  setPanelOpen(false);
  setPtabs([{ id: 1, kind: "flow" }]);
  setActiveTab(1);
  setBrowserTarget(null);
});

describe("openLink", () => {
  it("opens a web page in the panel's shared browser, reusing its tab", () => {
    openLink("https://github.com/acme/web/pull/42");
    expect(panelOpen()).toBe(true);
    expect(panelTab()).toBe("browser");
    expect(panelShared()).toBe(true);
    expect(browserTarget()).toBe("https://github.com/acme/web/pull/42");
    openLink("https://example.com");
    expect(browserTarget()).toBe("https://example.com");
    expect(native.openExternal).not.toHaveBeenCalled();
  });

  it("uses the default browser on ⌘- or ⌥-click", () => {
    openLink("https://example.com", { event: { metaKey: true } });
    openLink("https://example.com/b", { event: { altKey: true } });
    expect(native.openExternal.mock.calls).toEqual([["https://example.com"], ["https://example.com/b"]]);
    expect(panelOpen()).toBe(false);
  });

  it("follows the setting", () => {
    setState("settings", "links", "outside");
    openLink("https://example.com");
    expect(native.openExternal).toHaveBeenCalledWith("https://example.com");
    expect(panelOpen()).toBe(false);
  });

  it("goes outside where no panel shows (the canvas)", () => {
    setView({ name: "board" });
    openLink("https://example.com");
    expect(native.openExternal).toHaveBeenCalledWith("https://example.com");
  });

  it("keeps sign-ins and downloads outside", () => {
    openLink("https://example.com/login", { outside: true });
    openLink("https://github.com/login/device");
    openLink("https://example.com/app.dmg");
    expect(native.openExternal).toHaveBeenCalledTimes(3);
    expect(panelOpen()).toBe(false);
  });

  it("opens a file in the app's viewer, or Finder with ⌘", () => {
    openLink("/Users/me/report.pdf");
    expect(previewPath()).toBe("/Users/me/report.pdf");
    expect(panelTab()).toBe("preview");
    openLink("/Users/me/report.pdf:12", { event: { metaKey: true } });
    expect(native.revealPath).toHaveBeenCalledWith("/Users/me/report.pdf");
  });

  it("drops what it can't open", () => {
    expect(openLink("javascript:alert(1)").to).toBe("none");
    expect(native.openExternal).not.toHaveBeenCalled();
    expect(panelOpen()).toBe(false);
  });
});

describe("link menu", () => {
  it("offers the app's browser, the default one and copy", () => {
    expect(linkMenuItems("https://example.com").map((x) => (x === "sep" ? x : x.id))).toEqual(["open-inside", "open-outside", "sep", "copy-link"]);
  });
  it("has no inside choice where it can't open inside", () => {
    setView({ name: "board" });
    expect(linkMenuItems("https://example.com").map((x) => (x === "sep" ? x : x.id))).toEqual(["open-outside", "sep", "copy-link"]);
    setView({ name: "main" });
    expect(linkMenuItems("https://example.com/a.dmg").map((x) => (x === "sep" ? x : x.id))).toEqual(["open-outside", "sep", "copy-link"]);
  });
});
