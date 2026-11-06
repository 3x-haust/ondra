import { reconcile } from "solid-js/store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Device } from "../lib/native";
import { freshState, setState, state } from "./store";
import type { Task } from "./types";

const list: Device[] = [
  { id: "ym-app-twork00000001-aos", name: "ym-app-twork00000001-aos", platform: "android", kind: "emulator", runtime: "", booted: true, serial: "emulator-5624" },
  { id: "ONDRA-HOME-UDID", name: "ondra-thome00000001", platform: "ios", kind: "simulator", runtime: "", booted: true },
  { id: "ONDRA-WORK-UDID", name: "ondra-twork00000002", platform: "ios", kind: "simulator", runtime: "", booted: true },
  { id: "pixel_test", name: "pixel test", platform: "android", kind: "emulator", runtime: "", booted: false },
  { id: "IPHONE-UDID", name: "iPhone 17 Pro", platform: "ios", kind: "simulator", runtime: "", booted: false },
];
vi.mock("../lib/native", async (orig) => ({ ...(await orig<object>()), devicesList: async () => list }));
const { allowedDevices, deviceSpace, devicesIn, refreshDevices, setDeviceSpace, usedBy } = await import("./devices");

const job = (id: string, space: "home" | "work", extra: Partial<Task> = {}): Task => ({
  id, space, topic: "", title: id, ask: "", cwd: "/", status: "running",
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
  ...extra,
});
const ids = (ds: Device[]) => ds.map((d) => d.id);

beforeEach(async () => {
  setState(reconcile(freshState()));
  setState("spaces", [{ id: "home", label: "개인", folder: "~", rules: "" }, { id: "work", label: "회사", folder: "~", rules: "" }]);
  setState("tasks", [job("thome00000001", "home"), job("twork00000001", "work"), job("twork00000002", "work")]);
  await refreshDevices();
});

describe("devices per space", () => {
  it("gives each space its own, and the unplaced ones to both", () => {
    expect(deviceSpace(list[0])).toBe("work");
    expect(ids(devicesIn("home"))).toEqual(["ONDRA-HOME-UDID", "pixel_test", "IPHONE-UDID"]);
    expect(ids(devicesIn("work"))).toEqual(["ym-app-twork00000001-aos", "ONDRA-WORK-UDID", "pixel_test", "IPHONE-UDID"]);
  });

  it("moves a device the user puts in a space out of the other", () => {
    setDeviceSpace(list[3], "home");
    expect(ids(devicesIn("work"))).not.toContain("pixel_test");
    setDeviceSpace(list[3], undefined);
    expect(ids(devicesIn("work"))).toContain("pixel_test");
  });

  it("lets a job drive its space's devices, never another job's own", () => {
    const work = allowedDevices("work", "twork00000001");
    expect(work).toContain("emulator-5624");
    expect(work).toContain("pixel_test");
    expect(work).not.toContain("ONDRA-WORK-UDID");
    expect(work).not.toContain("ONDRA-HOME-UDID");
    expect(allowedDevices("work", "twork00000002")).toContain("ONDRA-WORK-UDID");
    expect(allowedDevices("home", "thome00000001")).not.toContain("emulator-5624");
  });

  it("shows only this space's job using a device", () => {
    setState("tasks", (ts) => [...ts, job("thome00000009", "home", { entries: [{ id: "e", at: 1, kind: "tool", tool: { kind: "bash", detail: "xcrun simctl boot IPHONE-UDID" } } as never] })]);
    setState("space", "work");
    expect(usedBy(list[4])).toBeUndefined();
    expect(usedBy(list[2])?.id).toBe("twork00000002");
    setState("space", "home");
    expect(usedBy(list[4])?.id).toBe("thome00000009");
    expect(usedBy(list[2])).toBeUndefined();
  });

  it("puts a device in the space whose job used it", async () => {
    setState("tasks", (ts) => [...ts, job("thome00000009", "home", { entries: [{ id: "e", at: 1, kind: "tool", tool: { kind: "bash", detail: "xcrun simctl boot IPHONE-UDID" } } as never] })]);
    await refreshDevices();
    expect(state.spaces.find((s) => s.id === "home")?.devices).toEqual(["IPHONE-UDID"]);
    expect(ids(devicesIn("work"))).not.toContain("IPHONE-UDID");
  });
});
