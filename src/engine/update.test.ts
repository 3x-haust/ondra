import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../state/types";

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

describe("a restart waits for the jobs at work", () => {
  const jobs = (...status: Task["status"][]) =>
    status.map((s, i) => ({ id: `j${i}`, space: "home", topic: "x", title: "x", ask: "x", cwd: "/", status: s, priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [] }) as Task);

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    native.latest = "0.31.0";
    native.prepared = [];
    native.installed = [];
  });
  afterEach(() => vi.useRealTimers());

  async function load() {
    const store = await import("../state/store");
    const ui = await import("../state/ui");
    const u = await import("./update");
    store.setState("settings", "language", "ko");
    return { setState: store.setState, ui, u };
  }

  it("with a job running, the notice restarts once it has ended, not now", async () => {
    const { setState, ui, u } = await load();
    setState("tasks", jobs("running"));
    await u.checkUpdate(true);
    const notice = ui.toasts().find((x) => x.action)!;
    expect(notice.action!.label).toBe("작업 끝나면 다시 시작");

    notice.action!.run();
    expect(u.restartQueued()).toBe(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(native.installed).toEqual([]);

    setState("tasks", 0, "status", "done");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(native.installed).toEqual(["0.31.0"]);
    expect(u.restartQueued()).toBe(false);
  });

  it("restarts right away when nothing runs; a job waiting for the user doesn't count", async () => {
    const { setState, ui, u } = await load();
    setState("tasks", jobs("waiting", "paused", "done"));
    await u.checkUpdate(true);
    const notice = ui.toasts().find((x) => x.action)!;
    expect(notice.action!.label).toBe("다시 시작");

    notice.action!.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(native.installed).toEqual(["0.31.0"]);
  });

  it("a queued restart can still go now", async () => {
    const { setState, u } = await load();
    setState("tasks", jobs("running"));
    await u.checkUpdate(true);
    u.restartWhenIdle();
    expect(u.restartQueued()).toBe(true);

    await u.installNow();
    expect(native.installed).toEqual(["0.31.0"]);
    expect(u.restartQueued()).toBe(false);
    // the jobs ending later doesn't restart a second time
    setState("tasks", 0, "status", "done");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(native.installed).toEqual(["0.31.0"]);
  });
});
