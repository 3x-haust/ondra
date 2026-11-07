import { afterEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {}, convertFileSrc: (path: string) => path }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); invoke.mockReset(); });

describe("computer preparation IPC", () => {
  it("never reports successful preparation in the browser preview", async () => {
    vi.stubGlobal("window", {});
    const native = await import("../src/lib/native");
    expect(await native.computerStatus()).toMatchObject({ prepared: false, error: "COMPUTER_UNSUPPORTED" });
    await expect(native.computerPrepare({ restoreImage: "/fixture/local.ipsw" })).rejects.toThrow("COMPUTER_UNSUPPORTED");
    await expect(native.computerOpenSetupViewer()).rejects.toThrow("COMPUTER_UNSUPPORTED");
    await expect(native.computerStart("t:job")).rejects.toThrow("COMPUTER_UNSUPPORTED");
    await expect(native.computerRecover("t:job")).rejects.toThrow("COMPUTER_UNSUPPORTED");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("only dispatches explicit commands with the complete task binding", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const native = await import("../src/lib/native");
    expect(invoke).not.toHaveBeenCalled();
    const state = { phase: "setup", busy: false, prepared: true, taskId: null, error: null };
    invoke.mockResolvedValue(state);
    const request = { restoreImage: "/fixture/local.ipsw" };
    expect(await native.computerPrepare(request)).toEqual(state);
    await native.computerOpenSetupViewer();
    await native.computerStart("t:job");
    await native.computerRecover("t:job");
    await native.computerStatus();
    expect(invoke.mock.calls).toEqual([
      ["computer_prepare", { request }], ["computer_open_setup_viewer", undefined],
      ["computer_start", { taskId: "t:job" }], ["computer_recover", { taskId: "t:job" }],
      ["computer_status", undefined],
    ]);
  });

  it("preserves native refusal without a fallback start", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const native = await import("../src/lib/native");
    invoke.mockRejectedValue("GUEST_QUARANTINED");
    await expect(native.computerStart("t:job")).rejects.toBe("GUEST_QUARANTINED");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("computer_start", { taskId: "t:job" });
  });
});
