import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  latest: "0.29.1" as string | null,
  prepared: [] as string[],
  installed: [] as string[],
}));

vi.mock("../lib/native", () => ({
  checkForUpdate: async () => (native.latest ? { version: native.latest } : null),
  prepareUpdate: async () => {
    native.prepared.push(native.latest!);
    return true;
  },
  installUpdate: async () => {
    native.installed.push(native.latest!);
  },
  onUpdateProgress: () => Promise.resolve(() => {}),
}));

describe("updates go to the newest release", () => {
  beforeEach(() => {
    native.latest = "0.29.1";
    native.prepared = [];
    native.installed = [];
  });

  it("a release that came out after the check is the one shown and installed", async () => {
    const u = await import("./update");
    await u.checkUpdate(true);
    expect(u.available()).toBe("0.29.1");
    expect(u.updateReady()).toBe("0.29.1");
    native.latest = "0.30.0";
    await u.installNow();
    expect(u.available()).toBe("0.30.0");
    expect(native.installed).toEqual(["0.30.0"]);
  });

  it("a newer release found later is fetched, not left at the older one", async () => {
    vi.resetModules();
    const u = await import("./update");
    await u.checkUpdate(true);
    native.latest = "0.30.0";
    await u.checkUpdate(true);
    expect(u.available()).toBe("0.30.0");
    expect(u.updateReady()).toBe("0.30.0");
    expect(native.prepared).toEqual(["0.29.1", "0.30.0"]);
  });
});
