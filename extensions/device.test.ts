import { describe, expect, it, vi } from "vitest";
// the engine provides typebox at run time; the schemas don't matter here
vi.mock("typebox", () => ({ Type: new Proxy({}, { get: () => () => ({}) }) }));
import { alreadyBaked, bakeable, baseAvdName, freePort, internal, portsIn, missingBakes, needsRunner, pickPhone, readOnlyBoot, runSteps, spareName, spareOf, spareScript, staleLock, stepArgs, templateName } from "./device";

describe("steps in one call", () => {
  it("runs them in order on the job's session and stops at the first that fails", async () => {
    const ran: string[][] = [];
    const exec = async (args: string[]) => {
      ran.push(args);
      return args[0] === "fill" ? { ok: false, out: "no element @e3" } : { ok: true, out: `did ${args[0]}` };
    };
    const r = await runSteps(["press @e1 --settle", 'wait text "Home"', 'fill @e3 "a b"', "back --settle"], exec);
    expect(ran.map((a) => a[0])).toEqual(["press", "wait", "fill"]);
    expect(ran[2]).toEqual(["fill", "@e3", "a b"]);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("✓ press @e1 --settle");
    expect(r.text).toContain('✗ fill @e3 "a b"');
    expect(r.text).toContain("no element @e3");
    expect(r.text).toContain("not run: back --settle");
  });

  it("gives the last step's output in full, the earlier ones as a line", async () => {
    const r = await runSteps(["press @e1", "snapshot -i"], async (a) => ({ ok: true, out: a[0] === "snapshot" ? "@e1 button Login\n@e2 field" : "pressed" }));
    expect(r.ok).toBe(true);
    expect(r.text.endsWith("@e1 button Login\n@e2 field")).toBe(true);
  });

  it("strips device flags and refuses what the tool manages", () => {
    expect(stepArgs("agent-device press @e1 --session other --udid X")).toEqual(["press", "@e1"]);
    expect(stepArgs("shutdown")).toMatch(/isn't allowed/);
    expect(stepArgs("   ")).toMatch(/empty/);
  });
});

describe("fast devices", () => {
  it("an iOS template per device type and runtime, named so nothing else takes it", () => {
    expect(templateName("iPhone 17", "com.apple.CoreSimulator.SimRuntime.iOS-26-3")).toBe("ondra-template-iPhone-17-iOS-26-3");
    expect(baseAvdName("Pixel_9_API_36")).toBe("ondra-base-Pixel_9_API_36");
  });

  it("picks the newest iPhone whichever way the runtime lists them, plain before Pro", () => {
    const newestFirst = ["iPhone 18 Pro", "iPhone 18 Pro Max", "iPhone 17 Pro", "iPhone 17e", "iPhone Air", "iPhone 17", "iPhone 11"];
    expect(pickPhone(newestFirst)).toBe("iPhone 18 Pro");
    expect(pickPhone([...newestFirst].reverse())).toBe("iPhone 18 Pro");
    expect(pickPhone(["iPhone 17 Pro", "iPhone 17", "iPhone 16"])).toBe("iPhone 17");
    expect(pickPhone(["iPhone Air"])).toBe("iPhone Air");
  });

  it("templates and snapshot bases are the tool's own: no job drives them by name", () => {
    expect(internal("ondra-template-iPhone-17-iOS-26-3")).toBe(true);
    expect(internal("ondra-base-Pixel_9")).toBe(true);
    expect(internal("ondra-tmwabc123")).toBe(false);
    expect(internal("Pixel_9")).toBe(false);
  });

  it("an Android job boots the clean snapshot read-only: seconds, nothing kept, several at once", () => {
    const a = readOnlyBoot("ondra-base-Pixel_9");
    expect(a.slice(0, 2)).toEqual(["-avd", "ondra-base-Pixel_9"]);
    expect(a).toContain("-read-only");
    expect(a.join(" ")).toContain("-snapshot clean");
    expect(a).toContain("-no-snapshot-save");
    expect(a).not.toContain("-wipe-data");
  });
});

describe("host apps baked into the device", () => {
  it("only host shells are baked (Expo Go): a job's own build never goes into a shared template", () => {
    expect(bakeable("ios", "host.exp.Exponent")).toBe(true);
    expect(bakeable("android", "host.exp.exponent")).toBe(true);
    expect(bakeable("ios", "com.leviosa.yomates")).toBe(false);
  });

  it("an install of a baked app on a device made from that template is skipped", () => {
    const keys = ["host.exp.Exponent@2.33.1"];
    expect(alreadyBaked(keys, "host.exp.Exponent@2.33.1")).toBe(true);
    expect(alreadyBaked(keys, "host.exp.Exponent@2.34.0")).toBe(false);
    expect(alreadyBaked(undefined, "host.exp.Exponent@2.33.1")).toBe(false);
  });

  it("a template wants what's baked and it doesn't have yet", () => {
    const apps = [{ key: "host.exp.Exponent@2.33.1", path: "/a/Expo Go.app", platform: "ios" as const }, { key: "host.exp.exponent@1", path: "/a/expo.apk", platform: "android" as const }];
    expect(missingBakes(apps, "ios", ["host.exp.Exponent@2.33.1"])).toEqual([]);
    expect(missingBakes(apps, "ios", []).map((a) => a.key)).toEqual(["host.exp.Exponent@2.33.1"]);
    expect(missingBakes(apps, "android", undefined).map((a) => a.key)).toEqual(["host.exp.exponent@1"]);
  });
});

describe("a spare device waiting for the next job", () => {
  it("is the tool's own until a job takes it, and is named for its template", () => {
    expect(spareName("ondra-template-iPhone-18-Pro-iOS-27-0", 123)).toBe("ondra-spare-iPhone-18-Pro-iOS-27-0-123");
    expect(internal("ondra-spare-iPhone-18-Pro-iOS-27-0-123")).toBe(true);
    expect(spareOf("ondra-template-iPhone-18-Pro-iOS-27-0", ["ondra-spare-iPhone-18-Pro-iOS-27-0-9", "ondra-spare-iPhone-17-iOS-27-0-3", "Pixel"])).toEqual(["ondra-spare-iPhone-18-Pro-iOS-27-0-9"]);
  });

  it("the script keeps its runner warm, and deletes the device unless a job renamed it", () => {
    const sh = spareScript({ template: "TPL-UDID", name: "ondra-spare-x-1", minutes: 15 });
    expect(sh).toContain('simctl clone "TPL-UDID" "ondra-spare-x-1"');
    expect(sh).toContain("prepare ios-runner");
    expect(sh).toMatch(/snapshot .*--session/);
    // taken by a job (renamed): left alone
    expect(sh).toContain('grep -q "ondra-spare-x-1 ("');
    expect(sh).toContain("simctl delete");
    expect(sh.startsWith("sleep")).toBe(false);
  });

  it("after a cold start it waits before starting its own runner, so the job's isn't slowed by two at once", () => {
    expect(spareScript({ template: "T", name: "n", minutes: 15, delay: 120 }).startsWith("sleep 120\n")).toBe(true);
  });

  it("commands that don't need the runner don't wait for it", () => {
    expect(needsRunner(["install", "/a.app"])).toBe(false);
    expect(needsRunner(["uninstall", "x"])).toBe(false);
    expect(needsRunner(["press", "@e1"])).toBe(true);
    expect(needsRunner(["open", "x"])).toBe(true);
  });
});

describe("a lock left by a process that died", () => {
  it("is taken at once when its owner is gone, not after ten minutes", () => {
    expect(staleLock({ pid: 42, ageMs: 5_000 }, () => false)).toBe(true);
    expect(staleLock({ pid: 42, ageMs: 5_000 }, () => true)).toBe(false);
    expect(staleLock({ ageMs: 5_000 }, () => true)).toBe(false);
    expect(staleLock({ pid: 42, ageMs: 700_000 }, () => true)).toBe(true);
  });
});

describe("an emulator's port", () => {
  it("is one no emulator has, even if one is still going away on it (its serial would be taken for the next)", () => {
    expect(freePort(new Set())).toBe(5554);
    expect(freePort(new Set([5554, 5556]))).toBe(5558);
    expect(freePort(new Set([5554]), 1)).toBe(5558);
    const all = new Set(Array.from({ length: 64 }, (_, i) => 5554 + i * 2));
    expect(freePort(all)).toBeUndefined();
  });

  it("the ports in use come from adb's list", () => {
    expect(portsIn(["List of devices attached", "emulator-5554\tdevice", "emulator-5560\toffline", "R5CT\tdevice", ""])).toEqual(new Set([5554, 5560]));
  });
});
