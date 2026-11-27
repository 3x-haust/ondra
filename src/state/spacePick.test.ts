import { reconcile } from "solid-js/store";
import { beforeEach, describe, expect, it } from "vitest";
import { freshState, ownSpace, setState } from "./store";
import { hostSpaceId, linkTone, linkWord, type HostMirror } from "./mirror";
import { carried } from "./workspace";

const HOST = "a".repeat(64);
const far = hostSpaceId(HOST, "home");

beforeEach(() => {
  setState(reconcile(freshState()));
  setState("spaces", [
    { id: "home", label: "개인", folder: "~", rules: "" },
    { id: "work", label: "회사", folder: "~", rules: "" },
    { id: far, label: "개인", folder: "~", rules: "", host: HOST },
  ]);
});

describe("ownSpace (a per-space settings page's workspace)", () => {
  it("keeps this device's workspace", () => {
    expect(ownSpace("work")).toBe("work");
  });
  it("takes this device's first for another device's workspace, or none", () => {
    expect(ownSpace(far)).toBe("home");
    expect(ownSpace(undefined)).toBe("home");
    expect(ownSpace("gone")).toBe("home");
  });
});

describe("the agent view in another device's workspace", () => {
  it("falls back to Main there, and stays in this device's", () => {
    expect(carried({ name: "agent" }, far)).toEqual({ name: "main" });
    expect(carried({ name: "agent" }, "work")).toEqual({ name: "agent" });
  });
});

describe("linkWord", () => {
  const h = (status: HostMirror["status"], since?: number): HostMirror => ({ status, since, projects: [], tasks: [] });
  it("says connected, connecting the first time, and not connected after a loss", () => {
    expect(linkWord(h("ok"))).toBe("연결됨");
    expect(linkWord(undefined)).toBe("연결 중");
    expect(linkWord(h("connecting"))).toBe("연결 중");
    expect(linkWord(h("waiting"))).toBe("연결 중");
    expect(linkWord(h("connecting", 1))).toBe("연결 안 됨");
    expect(linkWord(h("lost", 1))).toBe("연결 안 됨");
    expect(linkWord(h("off"))).toBe("연결 안 됨");
    expect(linkWord(h("denied"))).toBe("연결 안 됨");
  });
});

describe("linkTone (the Mac bar's status color)", () => {
  const h = (status: HostMirror["status"], since?: number): HostMirror => ({ status, since, projects: [], tasks: [] });
  it("tells connected, trying, lost and disconnected here apart", () => {
    expect(linkTone(h("ok"))).toBe("ok");
    expect(linkTone(undefined)).toBe("trying");
    expect(linkTone(h("connecting"))).toBe("trying");
    expect(linkTone(h("waiting"))).toBe("trying");
    expect(linkTone(h("connecting", 1))).toBe("down");
    expect(linkTone(h("lost", 1))).toBe("down");
    expect(linkTone(h("denied"))).toBe("down");
    expect(linkTone(h("off"))).toBe("off");
  });
});
