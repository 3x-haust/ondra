import { describe, expect, it, vi } from "vitest";
import { ComputerSession, type ComputerAction, type GuestExecute } from "../../extensions/lib/computer-session";

const ok = (command: string, data: Record<string, unknown>) => ({ version: "2.6", ok: true, command, data });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=";
const screenshot = (extra = {}) => ok("screenshot", { image: { mimeType: "image/png", data: png, width: 1, height: 1, ...extra } });
const corruptPng = (offset: number, byte: number) => {
  const bytes = Buffer.from(png, "base64");
  bytes[offset] = byte;
  return bytes.toString("base64");
};
const started = () => ok("session", {
  session_id: "guest-session-1", name: null, trace: "off", created_at: 123,
  next: "export AGENT_DESKTOP_SESSION=guest-session-1",
  activation: { environment: "AGENT_DESKTOP_SESSION", value: "guest-session-1" },
});
const snapshot = (id = "s1", extra = {}) => ok("snapshot", {
  app: "TextEdit", snapshot_id: id, complete: true,
  tree: { role: "window", children: Array.from({ length: 8 }, (_, i) => ({ role: "textfield", name: `Field ${i}`, value: "initial", ref_id: `@${id}:e${i + 10}` })) },
  ...extra,
});
const delivered = (command = "click", delivery = "delivered_unverified") => ok(command, {
  action: command, disposition: { delivery, retry: delivery === "not_delivered" ? "safe" : delivery === "unknown" ? "unknown" : "unsafe" },
});
const failed = (command = "click", delivery = "not_delivered") => ({
  version: "2.6", ok: false, command,
  error: { code: "TIMEOUT", message: "expired", disposition: { delivery, retry: delivery === "not_delivered" ? "safe" : delivery === "unknown" ? "unknown" : "unsafe" },
    recovery: { strategy: "refresh_snapshot_then_retry_original" } },
});
function guest(...responses: unknown[]) {
  const execute = vi.fn<GuestExecute>(async () => {
    if (!responses.length) throw new Error("Unexpected guest command");
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  });
  return { execute, session: new ComputerSession(execute) };
}
function ready(...responses: unknown[]) {
  return guest(started(), ok("launch", { app: "TextEdit", pid: 4 }), snapshot(), ...responses);
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// The injected boundary is a fake guest. These tests never execute a CLI or OS action.
describe("ComputerSession", () => {
  it.each([false, true])("uses the same workload for compact and forced-full including post-action snapshots (%s)", async forceFull => {
    const changed = snapshot("s3");
    (changed.data.tree as { children: { value: string }[] }).children[0].value = "updated";
    const responses = [started(), ok("launch", {}), snapshot(), delivered(), snapshot("s2"), changed];
    const execute = vi.fn<GuestExecute>(async () => responses.shift());
    const session = new ComputerSession(execute, { forceFull });
    const first = await session.start("TextEdit");
    const second = await session.act({ kind: "click", epoch: first.observation!.epoch, ref: "e1" });
    const third = await session.observe(false);
    expect([first.observation!.kind, second.observation!.kind, third.kind]).toEqual(
      forceFull ? ["full", "full", "full"] : ["full", "unchanged", "delta"],
    );
    expect(execute.mock.calls.map(([argv]) => argv)).toEqual([
      ["session", "start", "--no-trace"],
      ["--session", "guest-session-1", "launch", "TextEdit"],
      ["--session", "guest-session-1", "snapshot", "--app", "TextEdit"],
      ["--session", "guest-session-1", "click", "@s1:e10"],
      ["--session", "guest-session-1", "snapshot", "--app", "TextEdit"],
      ["--session", "guest-session-1", "snapshot", "--app", "TextEdit"],
    ]);
  });

  it("captures only guest image bytes on explicit look and consumes prior action refs", async () => {
    const { session, execute } = ready(screenshot(), snapshot("s2"));
    const first = await session.start("TextEdit");
    const image = await session.look();
    expect(image).toEqual({ mimeType: "image/png", data: png, width: 1, height: 1 });
    expect(execute.mock.calls[3][0]).toEqual(["--session", "guest-session-1", "screenshot", "--app", "TextEdit"]);
    for (const action of [{ kind: "click", ref: "e1" }, { kind: "press", key: "return" }]) {
      await expect(session.act({ ...action, epoch: first.observation!.epoch } as ComputerAction)).rejects.toThrow("Fresh actionable");
    }
    expect(execute).toHaveBeenCalledTimes(4);
    expect((await session.observe()).snapshot_id).toBe("s2");
  });

  it.each([
    { mimeType: "image/jpeg" }, { data: "" }, { data: png + "\n" }, { data: "!!!!" },
    { data: "A".repeat(4 * Math.ceil((4 * 1024 * 1024 + 1) / 3)) },
    { data: Buffer.from("not a PNG").toString("base64") },
    { data: Buffer.from(png, "base64").subarray(0, 33).toString("base64") },
    { data: png.slice(0, -2) + "J=" },
    { data: corruptPng(0, 0) }, { data: corruptPng(11, 12) }, { data: corruptPng(19, 2) },
    { data: corruptPng(24, 7) }, { data: corruptPng(25, 1) }, { data: corruptPng(26, 1) },
    { data: corruptPng(27, 1) }, { data: corruptPng(28, 2) }, { data: corruptPng(32, 0) },
    { data: corruptPng(45, 255) }, { data: corruptPng(63, 0) },
    { data: Buffer.concat([Buffer.from(png, "base64"), Buffer.from([0])]).toString("base64") },
    { width: 0 }, { width: 2 }, { width: 8193 }, { height: 1.5 }, { width: "1" },
    { width: 8192, height: 8192 }, { path: "/host/private.png" },
  ])("rejects malformed or oversized screenshot data and invalidates refs (case %#)", async extra => {
    const { session, execute } = ready(screenshot(extra), snapshot("s2"));
    const first = await session.start("TextEdit");
    await expect(session.look()).rejects.toThrow(/screenshot|PNG/);
    await expect(session.act({ kind: "click", epoch: first.observation!.epoch, ref: "e1" })).rejects.toThrow("Fresh actionable");
    expect(execute).toHaveBeenCalledTimes(4);
    expect((await session.observe()).kind).toBe("full");
  });

  it.each([ok("screenshot", { path: "/host/private.png" }), snapshot(), failed("screenshot"), new Error("capture disconnected")])(
    "never reads a returned path, falls back or retries after failed screenshot", async response => {
      const { session, execute } = ready(response);
      await session.start("TextEdit");
      await expect(session.look()).rejects.toThrow();
      expect(execute).toHaveBeenCalledTimes(4);
    },
  );

  it("does not capture without an active session or after an already aborted call", async () => {
    const empty = guest();
    await expect(empty.session.look()).rejects.toThrow("No active session");
    expect(empty.execute).not.toHaveBeenCalled();
    const { session, execute } = ready();
    const first = await session.start("TextEdit");
    await expect(session.look(AbortSignal.abort())).rejects.toThrow("aborted");
    await expect(session.act({ kind: "press", epoch: first.observation!.epoch, key: "return" })).rejects.toThrow("Fresh actionable");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each(["resetObservations", "forceFull", "cancel"] as const)("rejects late screenshot after %s", async method => {
    const { session, execute } = ready(screenshot());
    await session.start("TextEdit");
    const pending = deferred();
    execute.mockImplementationOnce(() => pending.promise);
    const running = session.look();
    await expect(session.observe()).rejects.toThrow("in progress");
    session[method]();
    pending.resolve(screenshot());
    await expect(running).rejects.toThrow(/reset|aborted/);
    expect(await session.look()).toMatchObject({ data: png });
  });

  it("uses data.session_id from a session envelope and scopes launch and the first full snapshot", async () => {
    const { session, execute } = ready();
    const result = await session.start("TextEdit");

    expect(result.sessionId).toBe("guest-session-1");
    expect(result.launch).toMatchObject({ ok: true, outcome: "unknown" });
    expect(result.observation).toMatchObject({ kind: "full", snapshot_id: "s1" });
    expect(execute.mock.calls.map(([argv]) => argv)).toEqual([
      ["session", "start", "--no-trace"],
      ["--session", "guest-session-1", "launch", "TextEdit"],
      ["--session", "guest-session-1", "snapshot", "--app", "TextEdit"],
    ]);
  });

  it.each(["TextEdit", "Calculator"])("refuses duplicate start for %s without relaunching", async app => {
    const { session, execute } = ready();
    await session.start("TextEdit");
    await expect(session.start(app)).rejects.toThrow("already started");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each(["", " ", "--headed", "TextEdit\0", "TextEdit\n", "x".repeat(513)])("rejects invalid app %j before dispatch", async app => {
    const { session, execute } = guest();
    await expect(session.start(app)).rejects.toThrow("Invalid app");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { ...started(), command: "session start" },
    ok("session", { id: "wrong-field", activation: { value: "do-not-use" } }),
    ok("session", { session_id: "../foreign" }),
    failed("session"), new Error("connection lost"),
  ])("never launches or retries after a failed or ambiguous session start", async response => {
    const { session, execute } = guest(response);
    await expect(session.start("TextEdit")).rejects.toThrow();
    await expect(session.start("TextEdit")).rejects.toThrow("already started");
    await expect(session.observe()).rejects.toThrow("No active session");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("observes even after ambiguous launch without relaunching", async () => {
    const { session, execute } = guest(started(), new Error("launch lost"), snapshot());
    const result = await session.start("TextEdit");
    expect(result.launch).toEqual({ ok: null, outcome: "unknown", error: "launch lost" });
    expect(result.observation?.kind).toBe("full");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("returns compact observations and explicit full baselines without changing CLI scope", async () => {
    const { session } = ready(snapshot("s2"), snapshot("s3"), snapshot("s4"), snapshot("s5"));
    const first = await session.start("TextEdit");
    expect(await session.observe()).toMatchObject({ kind: "unchanged", base_epoch: first.observation!.epoch });
    expect((await session.observe(true)).kind).toBe("full");
    session.forceFull();
    expect((await session.observe()).kind).toBe("full");
    session.resetObservations();
    expect((await session.observe()).kind).toBe("full");
  });

  it.each(["click", "set-value", "press"] as const)("dispatches exactly one typed %s then observes, consuming the old epoch", async kind => {
    const { session, execute } = ready(delivered(kind), snapshot("s2"));
    const first = await session.start("TextEdit");
    const epoch = first.observation!.epoch;
    const action: ComputerAction = kind === "click" ? { kind, epoch, ref: "e1" }
      : kind === "set-value" ? { kind, epoch, ref: "e1", value: "--headed; $(bad) 한글\n\"" }
      : { kind, epoch, key: "s", modifiers: ["cmd"] };
    const result = await session.act(action);

    const expected = kind === "click" ? ["click", "@s1:e10"]
      : kind === "set-value" ? ["set-value", "@s1:e10", "--", "--headed; $(bad) 한글\n\""]
      : ["press", "cmd+s", "--app", "TextEdit"];
    expect(execute.mock.calls[3][0]).toEqual(["--session", "guest-session-1", ...expected]);
    expect(execute.mock.calls[4][0]).toEqual(["--session", "guest-session-1", "snapshot", "--app", "TextEdit"]);
    expect(result.action).toMatchObject({ ok: true, outcome: "unknown" });
    expect(result.observation).toMatchObject({ kind: "unchanged", base_epoch: epoch, snapshot_id: "s2" });
    await expect(session.act(action)).rejects.toThrow("Fresh actionable");
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it.each([
    "click @e1", [{ kind: "click" }], { kind: "batch" },
    { kind: "click", ref: "@s1:e10" }, { kind: "click", ref: "e1", app: "Finder" },
    { kind: "click", ref: "e1", command: "launch" },
    { kind: "set-value", ref: "e1", value: "bad\0" },
    { kind: "press", key: "cmd+s" }, { kind: "press", key: "return --force" },
    { kind: "press", key: "q", modifiers: ["cmd", "cmd"] },
    { kind: "press", key: "q", modifiers: ["--force"] },
    { kind: "press", key: "q", modifiers: new Array(1) },
    { kind: "press", key: "s", force: true },
  ])("refuses raw commands and invalid typed fields without consuming the valid epoch", async input => {
    const { session, execute } = ready(delivered(), snapshot("s2"));
    const first = await session.start("TextEdit");
    const epoch = first.observation!.epoch;
    const action = typeof input === "object" && !Array.isArray(input) ? { epoch, ...input } : input;
    await expect(session.act(action as ComputerAction)).rejects.toThrow();
    expect(execute).toHaveBeenCalledTimes(3);
    await session.act({ kind: "click", epoch, ref: "e1" });
    expect(execute).toHaveBeenCalledTimes(5);
  });

  it.each([
    [delivered("click", "delivered_verified"), true, "verified"],
    [delivered(), true, "unknown"],
    [failed(), false, "not_delivered"],
    [failed("click", "delivery_uncertain"), false, "unknown"],
    [failed("click", "delivered_verified"), false, "unknown"],
    [new Error("lost response"), null, "unknown"],
    [ok("click", {}), null, "unknown"],
    [ok("click", { disposition: { delivery: "delivered_verified", retry: "safe" } }), null, "unknown"],
    [delivered("set-value"), null, "unknown"],
  ])("preserves delivery uncertainty separately from observation and never retries", async (response, commandOk, outcome) => {
    const { session, execute } = ready(response, snapshot("s2"));
    const first = await session.start("TextEdit");
    const result = await session.act({ kind: "click", epoch: first.observation!.epoch, ref: "e1" });
    expect(result.action).toMatchObject({ ok: commandOk, outcome });
    expect(result.observation).toMatchObject({ kind: commandOk === true ? "unchanged" : "full", snapshot_id: "s2" });
    if (commandOk === true) expect(result.observation).toHaveProperty("base_epoch", first.observation!.epoch);
    await expect(session.act({ kind: "click", epoch: first.observation!.epoch, ref: "e1" })).rejects.toThrow("Fresh actionable");
    expect(execute.mock.calls.filter(([argv]) => argv.includes("click"))).toHaveLength(1);
  });

  it("chains unchanged and delta observations after actions using only fresh refs", async () => {
    const changed = snapshot("s3");
    (changed.data.tree as { children: { value: string }[] }).children[0].value = "updated";
    const { session, execute } = ready(delivered(), snapshot("s2"), delivered("set-value"), changed);
    const first = await session.start("TextEdit");
    const click: ComputerAction = { kind: "click", epoch: first.observation!.epoch, ref: "e1" };
    const second = await session.act(click);

    expect(second.observation).toEqual({
      kind: "unchanged", epoch: second.observation!.epoch, base_epoch: first.observation!.epoch, snapshot_id: "s2",
    });
    await expect(session.act(click)).rejects.toThrow("Fresh actionable");
    const third = await session.act({ kind: "set-value", epoch: second.observation!.epoch, ref: "e1", value: "updated" });
    expect(execute.mock.calls[5][0]).toEqual(["--session", "guest-session-1", "set-value", "@s2:e10", "--", "updated"]);
    expect(third.observation).toEqual({
      kind: "delta", epoch: third.observation!.epoch, base_epoch: second.observation!.epoch, snapshot_id: "s3",
      changes: [{ op: "set", path: ["data", "tree", "children", 0, "value"], value: "updated" }],
    });
    await expect(session.act({ kind: "press", epoch: second.observation!.epoch, key: "return" })).rejects.toThrow("Fresh actionable");
    expect(execute).toHaveBeenCalledTimes(7);
  });

  it.each([false, true])("requires a fresh observation after failed capture (structured=%s)", async structured => {
    const { session, execute } = ready(delivered("click", "delivered_verified"), structured ? failed("snapshot") : new Error("capture lost"), snapshot("s3"));
    const first = await session.start("TextEdit");
    const action: ComputerAction = { kind: "click", epoch: first.observation!.epoch, ref: "e1" };
    const result = await session.act(action);
    expect(result.action).toMatchObject({ ok: true, outcome: "verified" });
    if (structured) expect(result.observation).toMatchObject({ kind: "full", snapshot: { ok: false } });
    else expect(result.observationError).toBe("capture lost");
    await expect(session.act(action)).rejects.toThrow("Fresh actionable");
    expect(execute).toHaveBeenCalledTimes(5);
    expect((await session.observe()).kind).toBe("full");
  });

  it.each([
    { complete: false }, { identity_unproven: true }, { truncated: true },
    { tree: { role: "window", children: [{ role: "button", ref_id: "@s1:e1", subtree_truncated: true }] } },
    { tree: { role: "window", children: [{ role: "button", ref_id: "@s1:e1" }, { role: "button", ref_id: "@s1:e1" }] } },
  ])("refuses click and press from incomplete or ambiguous observations", async extra => {
    const { session, execute } = guest(started(), ok("launch", {}), snapshot("s1", extra));
    const first = await session.start("TextEdit");
    for (const action of [{ kind: "click", ref: "e1" }, { kind: "press", key: "return" }]) {
      await expect(session.act({ ...action, epoch: first.observation!.epoch } as ComputerAction)).rejects.toThrow("Fresh actionable");
    }
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each([
    { complete: false }, { identity_unproven: true }, { truncated: true },
    { tree: { role: "window", children: [{ role: "button", ref_id: "@s2:e1", subtree_truncated: true }] } },
    { tree: { role: "window", children: [{ role: "button", ref_id: "@s2:e1" }, { role: "button", ref_id: "@s2:e1" }] } },
  ])("refuses old and new action epochs after an incomplete post-action observation", async extra => {
    const { session, execute } = ready(delivered(), snapshot("s2", extra), snapshot("s3"));
    const first = await session.start("TextEdit");
    const result = await session.act({ kind: "click", epoch: first.observation!.epoch, ref: "e1" });
    expect(result.observation?.snapshot_id).toBe("s2");
    for (const epoch of [first.observation!.epoch, result.observation!.epoch]) {
      for (const action of [{ kind: "click", ref: "e1" }, { kind: "press", key: "return" }]) {
        await expect(session.act({ ...action, epoch } as ComputerAction)).rejects.toThrow("Fresh actionable");
      }
    }
    expect(execute).toHaveBeenCalledTimes(5);
    expect((await session.observe()).snapshot_id).toBe("s3");
  });

  it("rejects an unknown alias and another session's epoch before dispatch", async () => {
    const a = ready();
    const b = ready();
    const first = await a.session.start("TextEdit");
    const other = await b.session.start("TextEdit");
    await expect(a.session.act({ kind: "click", epoch: first.observation!.epoch, ref: "e99" })).rejects.toThrow("Unknown");
    await expect(a.session.act({ kind: "click", epoch: other.observation!.epoch, ref: "e1" })).rejects.toThrow("Fresh actionable");
    expect(a.execute).toHaveBeenCalledTimes(3);
  });

  it("rejects concurrent start, observe, act and stop while a dispatch is pending", async () => {
    const { session, execute } = ready(snapshot("s2"));
    const first = await session.start("TextEdit");
    const pending = deferred();
    execute.mockImplementationOnce(() => pending.promise);
    const action: ComputerAction = { kind: "click", epoch: first.observation!.epoch, ref: "e1" };
    const running = session.act(action);
    for (const operation of [() => session.start("TextEdit"), () => session.observe(), () => session.act(action), () => session.stop()]) {
      await expect(operation()).rejects.toThrow("already in progress");
    }
    expect(execute).toHaveBeenCalledTimes(4);
    pending.resolve(delivered());
    await running;
  });

  it.each(["signal", "cancel"])("invalidates on %s, keeps the lock until settlement and requires fresh capture", async method => {
    const { session, execute } = ready(snapshot("s3"));
    const first = await session.start("TextEdit");
    const pending = deferred();
    execute.mockImplementationOnce(() => pending.promise);
    const controller = new AbortController();
    const action: ComputerAction = { kind: "click", epoch: first.observation!.epoch, ref: "e1" };
    const running = session.act(action, controller.signal);
    if (method === "signal") controller.abort(); else session.cancel();
    expect(execute.mock.calls[3][1]?.aborted).toBe(true);
    await expect(session.observe()).rejects.toThrow("already in progress");
    pending.resolve(delivered("click", "delivered_verified"));
    const result = await running;
    expect(result.action).toMatchObject({ ok: null, outcome: "unknown" });
    expect(result.observationError).toContain("aborted");
    expect(execute).toHaveBeenCalledTimes(4);
    await expect(session.act(action)).rejects.toThrow("Fresh actionable");
    expect((await session.observe()).kind).toBe("full");
  });

  it("does not dispatch an already aborted call and invalidates its preceding observation", async () => {
    const { session, execute } = ready();
    const first = await session.start("TextEdit");
    const controller = new AbortController();
    controller.abort();
    const action: ComputerAction = { kind: "click", epoch: first.observation!.epoch, ref: "e1" };
    await expect(session.act(action, controller.signal)).rejects.toThrow("aborted");
    await expect(session.act(action)).rejects.toThrow("Fresh actionable");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each(["resetObservations", "forceFull"] as const)("starts a full baseline after %s during action dispatch", async method => {
    const { session, execute } = ready(snapshot("s2"), snapshot("s3"));
    const first = await session.start("TextEdit");
    const pending = deferred();
    execute.mockImplementationOnce(() => pending.promise);
    const running = session.act({ kind: "click", epoch: first.observation!.epoch, ref: "e1" });
    session[method]();
    pending.resolve(delivered());
    const result = await running;
    expect(result.observation).toMatchObject({ kind: "full", snapshot_id: "s2" });
    expect(await session.observe()).toMatchObject({ kind: "unchanged", base_epoch: result.observation!.epoch });
  });

  it.each(["resetObservations", "forceFull", "cancel"] as const)("never accepts a late post-action observation after %s", async method => {
    const { session, execute } = ready(snapshot("s3"));
    const first = await session.start("TextEdit");
    const pending = deferred();
    const capturing = deferred();
    execute.mockResolvedValueOnce(delivered()).mockImplementationOnce(() => {
      capturing.resolve(undefined);
      return pending.promise;
    });
    const running = session.act({ kind: "click", epoch: first.observation!.epoch, ref: "e1" });
    await capturing.promise;
    session[method]();
    pending.resolve(snapshot("s2"));
    const result = await running;
    expect(result.observation).toBeUndefined();
    expect(result.observationError).toMatch(/reset|aborted/);
    await expect(session.act({ kind: "press", epoch: first.observation!.epoch, key: "return" })).rejects.toThrow("Fresh actionable");
    expect((await session.observe()).kind).toBe("full");
  });

  it.each(["reset", "abort"])("never accepts a late observation after %s", async reason => {
    const { session, execute } = ready(snapshot("s3"));
    const first = await session.start("TextEdit");
    const pending = deferred();
    execute.mockImplementationOnce(() => pending.promise);
    const running = session.observe();
    if (reason === "reset") session.resetObservations(); else session.cancel();
    pending.resolve(snapshot("s2"));
    await expect(running).rejects.toThrow(/reset|aborted/);
    await expect(session.act({ kind: "press", epoch: first.observation!.epoch, key: "return" })).rejects.toThrow("Fresh actionable");
    expect((await session.observe()).kind).toBe("full");
  });

  it("retains a returned session ID for cleanup if start was aborted before launch", async () => {
    const pending = deferred();
    const { session, execute } = guest(ok("session", { session_id: "guest-session-1", ended_at: 124 }));
    execute.mockImplementationOnce(() => pending.promise);
    const running = session.start("TextEdit");
    session.cancel();
    pending.resolve(started());
    await expect(running).rejects.toThrow("aborted");
    expect((await session.stop()).ok).toBe(true);
    expect(execute.mock.calls.map(([argv]) => argv)).toEqual([
      ["session", "start", "--no-trace"], ["--session", "guest-session-1", "session", "end", "guest-session-1"],
    ]);
  });

  it("ends only its namespace, blocks later work, and makes repeated stop a local no-op", async () => {
    const { session, execute } = ready(ok("session", { session_id: "guest-session-1", ended_at: 124 }));
    const first = await session.start("TextEdit");
    expect((await session.stop()).ok).toBe(true);
    expect(await session.stop()).toEqual({ ok: true, outcome: "not_delivered" });
    await expect(session.observe()).rejects.toThrow("No active session");
    await expect(session.act({ kind: "click", epoch: first.observation!.epoch, ref: "e1" })).rejects.toThrow("No active session");
    await expect(session.start("Calculator")).rejects.toThrow("already started");
    expect(execute.mock.calls[3][0]).toEqual(["--session", "guest-session-1", "session", "end", "guest-session-1"]);
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it.each([new Error("end lost"), ok("session", { session_id: "foreign", ended_at: 124 }), ok("session", { session_id: "guest-session-1" })])("keeps uncertain stop closed to actions and allows only explicit idempotent cleanup", async response => {
    const { session, execute } = ready(response, ok("session", { session_id: "guest-session-1", ended_at: 124 }));
    await session.start("TextEdit");
    expect(await session.stop()).toMatchObject({ ok: null, outcome: "unknown" });
    await expect(session.observe()).rejects.toThrow("No active session");
    expect(execute).toHaveBeenCalledTimes(4);
    expect((await session.stop()).ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(5);
  });
});
