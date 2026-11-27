import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { agentPlacesNone, freshState, setState } from "../state/store";
import { agentHome, placeChoices, placeFor, placeNote } from "./agentPlaces";
import type { AgentSettings } from "../state/types";

const MB = "b".repeat(64);
const name = (id: string) => (id === MB ? "MacBook" : "Mac");

beforeEach(() => {
  setState(reconcile(freshState()));
  setState("spaces", [
    { id: "home", label: "개인", folder: "~", rules: "" },
    { id: "side", label: "사이드", folder: "~", rules: "" },
    { id: `h:${MB}:work`, label: "회사", folder: "~", rules: "", host: MB },
    { id: `h:${MB}:home`, label: "개인", folder: "~", rules: "", host: MB },
  ]);
  setState("settings", "hosts", [{ id: MB, name: "MacBook" }]);
  setState("projects", [{ id: "orbit", space: "home", name: "orbit", folder: "/o" }]);
  setState("settings", "hostProjects", [{ host: MB, id: "crm", space: `h:${MB}:work`, name: "crm", folder: "/c" }]);
});

const agent = (a: Partial<AgentSettings>): AgentSettings => ({ on: true, name: "메타몽", ...a });

describe("where the agent's work goes", () => {
  it("is none for every channel unless set, and a channel's own row wins (left on 없음, it is none)", () => {
    const a = agent({ places: [{ channel: "c-work", space: `h:${MB}:work` }, { channel: "c-none" }, { channel: "c-side", space: "side", account: "x" }] });
    expect(placeFor(a)).toEqual({ kind: "none" });
    expect(placeFor(a, "c-work")).toEqual({ kind: "device", host: MB, space: `h:${MB}:work`, label: "회사" });
    expect(placeFor(a, "c-none")).toEqual({ kind: "none" });
    expect(placeFor(a, "c-side")).toEqual({ kind: "here", space: "side", account: "x" });
    expect(placeFor(agent({ space: "side" }), "c-else")).toEqual({ kind: "here", space: "side" });
    // a device removed since: none
    expect(placeFor(agent({ space: `h:${"c".repeat(64)}:x` }))).toEqual({ kind: "none" });
  });

  it("keeps its chat in this device's workspace: the place's own, the same name as another device's, else the first", () => {
    const a = agent({ places: [{ channel: "c-mb-home", space: `h:${MB}:home` }, { channel: "c-work", space: `h:${MB}:work` }, { channel: "c-side", space: "side" }] });
    expect(agentHome(a, "c-side")).toBe("side");
    expect(agentHome(a, "c-mb-home")).toBe("home");
    expect(agentHome(a, "c-work")).toBe("home");
    expect(agentHome(a)).toBe("home");
  });

  it("lists the places by device, this one first", () => {
    expect(placeChoices("이 기기", name)).toEqual([
      { name: "이 기기", spaces: [{ id: "home", label: "개인" }, { id: "side", label: "사이드" }] },
      { host: MB, name: "MacBook", spaces: [{ id: `h:${MB}:work`, label: "회사" }, { id: `h:${MB}:home`, label: "개인" }] },
    ]);
  });

  it("tells main: nothing for this device's place, the device for another's, every place with its projects for none", () => {
    const a = agent({ places: [{ channel: "c-side", space: "side" }, { channel: "c-work", space: `h:${MB}:work` }] });
    expect(placeNote(a, "c-side", name)).toBe("");
    expect(placeNote(a, "c-work", name)).toContain(`"MacBook", in its workspace "회사" (space id h:${MB}:work)`);
    const none = placeNote(a, "c-else", name);
    expect(none).toContain("- this device › 개인 (space id home): orbit");
    expect(none).toContain(`- MacBook › 회사 (space id h:${MB}:work): crm`);
    expect(none).toContain("ask them with an ask whose options are those places");
  });

  it("with one place only, says nothing: that place is where it goes", () => {
    setState("spaces", [{ id: "home", label: "개인", folder: "~", rules: "" }]);
    setState("settings", "hosts", []);
    expect(placeNote(agent({}), "c", name)).toBe("");
  });
});

describe("an older agent's work place for every channel", () => {
  it("becomes none once, and keeps the chat's account; one set after stays", () => {
    const s = freshState();
    s.settings.agent = { on: true, name: "메타몽", space: "home", account: "a1", places: [{ channel: "c", space: "home" }] };
    const once = agentPlacesNone(s).settings.agent!;
    expect(once).toEqual({ on: true, name: "메타몽", account: "a1", places: [{ channel: "c", space: "home" }], v: 2 });
    const later = { ...s, settings: { ...s.settings, agent: { ...once, space: "home" } } };
    expect(agentPlacesNone(later).settings.agent!.space).toBe("home");
  });
});
