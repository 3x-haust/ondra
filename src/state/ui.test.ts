import { beforeEach, describe, expect, it } from "vitest";
import { activeTab, newPanelTab, panelOpen, panelTab, ptabs, setActiveTab, setPanelOpen, setPanelTab, setPtabs, setRoomy, setSidebarHidden, sidebarAway, sidebarHidden, toggleSidebar } from "./ui";

beforeEach(() => {
  setRoomy(true);
  setSidebarHidden(false);
  setPanelOpen(false);
  setPtabs([{ id: 1, kind: "flow" }]);
  setActiveTab(1);
});

describe("sidebar toggle", () => {
  it("folds and unfolds the sidebar in a wide window", () => {
    toggleSidebar();
    expect(sidebarHidden()).toBe(true);
    expect(sidebarAway()).toBe(true);
    toggleSidebar();
    expect(sidebarHidden()).toBe(false);
    expect(sidebarAway()).toBe(false);
  });

  it("brings an automatically hidden sidebar back by closing the narrow panel", () => {
    setRoomy(false);
    setPanelOpen(true);
    expect(sidebarHidden()).toBe(false);
    expect(sidebarAway()).toBe(true);
    toggleSidebar();
    expect(panelOpen()).toBe(false);
    expect(sidebarAway()).toBe(false);
  });

  it("does not close the panel when there is room for both", () => {
    setPanelOpen(true);
    setSidebarHidden(true);
    toggleSidebar();
    expect(panelOpen()).toBe(true);
    expect(sidebarAway()).toBe(false);
  });
});

describe("panel tools", () => {
  it("reuses a tool tab instead of opening duplicate tabs", () => {
    setPanelTab("side");
    const id = activeTab();
    setPanelTab("flow");
    setPanelTab("side");
    expect(activeTab()).toBe(id);
    expect(ptabs().map((t) => t.kind)).toEqual(["flow", "side"]);
  });

  it("opens an empty tab and replaces it when a tool is chosen", () => {
    newPanelTab();
    const id = activeTab();
    expect(panelOpen()).toBe(true);
    expect(panelTab()).toBe("new");
    setPanelTab("files");
    expect(activeTab()).toBe(id);
    expect(panelTab()).toBe("files");
    expect(ptabs()).toHaveLength(2);
  });
});
