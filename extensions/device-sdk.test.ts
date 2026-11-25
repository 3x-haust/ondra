import { afterEach, describe, expect, it, vi } from "vitest";
// the engine provides typebox at run time; the schemas don't matter here
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));

/** The device tool on a computer without an Android SDK, talking to a pretend app. */
async function setup(status: Record<string, unknown>, after: Record<string, unknown> = {}) {
  vi.resetModules();
  vi.stubEnv("ANDROID_HOME", "/nowhere/sdk");
  vi.stubEnv("ONDRA_BRIDGE", "http://127.0.0.1:1/bridge");
  vi.stubEnv("ONDRA_BRIDGE_TOKEN", "t");
  const gets: string[] = [];
  let now = { sdk: "/data/android/sdk", adb: true, emulator: false, avd: false, busy: null, percent: 0, size: 0, license: null, accel: null, ...status };
  vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
    const { args } = JSON.parse(init.body);
    if (args.get) {
      gets.push(args.get);
      now = { ...now, ...after };
    }
    return { json: async () => now };
  });
  const m = await import("./device");
  return { m, gets };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("an Android emulator for a computer without one", () => {
  it("asks once with the size and license, then has the app get it and uses Ondra's SDK", async () => {
    const { m, gets } = await setup({ size: 1_700_000_000, license: "Terms" }, { emulator: true, avd: true });
    const confirm = vi.fn(async () => true);
    expect(await m.androidReady({ hasUI: true, ui: { confirm } })).toBeUndefined();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][1]).toContain("약 1.7GB");
    expect(confirm.mock.calls[0][1]).toContain("Terms");
    expect(gets).toEqual(["emulator"]);
    expect(process.env.ANDROID_HOME).toBe("/data/android/sdk");
  });

  it("gets nothing when the user says no, and doesn't ask again in the job", async () => {
    const { m, gets } = await setup({ size: 1_700_000_000, license: "Terms" });
    const confirm = vi.fn(async () => false);
    expect(await m.androidReady({ hasUI: true, ui: { confirm } })).toMatch(/declined/);
    expect(await m.androidReady({ hasUI: true, ui: { confirm } })).toMatch(/declined/);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(gets).toEqual([]);
  });

  it("gets adb without asking", async () => {
    const { m, gets } = await setup({ adb: false, emulator: true, avd: true }, { adb: true });
    const confirm = vi.fn(async () => true);
    expect(await m.androidReady({ hasUI: true, ui: { confirm } })).toBeUndefined();
    expect(gets).toEqual(["adb"]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("says how to turn virtualization on instead of downloading what can't run", async () => {
    const { m, gets } = await setup({ size: 1_700_000_000, license: "Terms", accel: "windows" });
    const confirm = vi.fn(async () => true);
    expect(await m.androidReady({ hasUI: true, ui: { confirm } })).toMatch(/Windows Hypervisor Platform/);
    expect(confirm).not.toHaveBeenCalled();
    expect(gets).toEqual([]);
  });
});
