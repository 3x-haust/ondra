import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createComputerRuntime, registerComputerGuest, type ComputerGuestAuthority } from "../../extensions/lib/computer-runtime";
import type { VerifiedGuestMetadata } from "../../extensions/lib/computer-transport";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
let directory: string;
let guest: VerifiedGuestMetadata;
let authority: ComputerGuestAuthority;
let invalidated: AbortController;
let renew: ReturnType<typeof vi.fn<ComputerGuestAuthority["renew"]>>;
let request: (child: Child, value: Record<string, unknown>) => void;
let unregister: (() => void) | undefined;
class Child extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  input = "";
  kill = vi.fn(() => true);
  stdin = new Writable({
    write: (chunk, _encoding, done) => { this.input += String(chunk); done(); },
    final: done => { request(this, JSON.parse(this.input)); done(); },
  });
}
function reply(child: Child, value: Record<string, unknown>) {
  child.stdout.write(JSON.stringify({ version: 1, requestId: value.requestId, taskId: guest.taskId,
    vmUuid: guest.vmUuid, bootNonce: guest.bootNonce, result: { ok: true } }));
  child.emit("close", 0, null);
}
function bind() {
  unregister = registerComputerGuest({ taskId: guest.taskId, artifactsDir: directory, connectionDir: directory, authority });
  return createComputerRuntime({ taskId: guest.taskId, artifactsDir: directory });
}
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "computer-runtime-")));
  invalidated = new AbortController();
  const key = `ssh-ed25519 ${Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), Buffer.alloc(32, 1)]).toString("base64")}`;
  guest = { version: 1, taskId: "runtime-test", hostUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    vmUuid: "11111111-2222-3333-4444-555555555555", bootNonce: "1".repeat(64), host: "192.168.64.2",
    port: 22, username: "ondra-computer", sshHostKey: key,
    identitySha256: createHash("sha256").update("private-key").digest("hex"), expiresAt: Date.now() + 50000 };
  const { version, taskId, vmUuid, bootNonce, host, port, username } = guest;
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ version, taskId, vmUuid, bootNonce, host, port, username }), { mode: 0o600 });
  writeFileSync(join(directory, "identity"), "private-key", { mode: 0o600 });
  writeFileSync(join(directory, "known_hosts"), `ondra-guest-${vmUuid} ${key}\n`, { mode: 0o600 });
  renew = vi.fn(async () => ({ ...guest, expiresAt: Date.now() + 50000 }));
  authority = { invalidated: invalidated.signal, renew };
  request = reply;
  spawn.mockReset();
  spawn.mockImplementation(() => { const child = new Child(); queueMicrotask(() => child.emit("spawn")); return child; });
});
afterEach(() => { unregister?.(); unregister = undefined; vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

it("does not convert environment or manifest claims into lifecycle authority", () => {
  vi.stubEnv("ONDRA_GUEST_DIRECTORY", directory);
  expect(() => createComputerRuntime({ taskId: guest.taskId, artifactsDir: directory })).toThrow("GUEST_SETUP_REQUIRED");
  expect(spawn).not.toHaveBeenCalled();
});
it("renews lifecycle evidence before the first exchange and reuses only a fresh lease", async () => {
  const runtime = bind();
  await expect(runtime.execute(["snapshot"])).resolves.toEqual({ ok: true });
  await expect(runtime.execute(["snapshot"])).resolves.toEqual({ ok: true });
  expect(renew).toHaveBeenCalledTimes(1);
  expect(spawn).toHaveBeenCalledTimes(2);
  const later = Date.now() + 21000;
  renew.mockResolvedValueOnce({ ...guest, expiresAt: later + 20000 });
  vi.spyOn(Date, "now").mockReturnValue(later);
  await expect(runtime.execute(["snapshot"])).resolves.toEqual({ ok: true });
  expect(renew).toHaveBeenCalledTimes(2);
  await expect(runtime.execute(["snapshot"])).resolves.toEqual({ ok: true });
  expect(renew).toHaveBeenCalledTimes(3);
  vi.restoreAllMocks();
  expect(spawn.mock.calls.every(call => call[0] === "/usr/bin/ssh")).toBe(true);
  await runtime.dispose();
  expect(existsSync(join(directory, "runtime.lock"))).toBe(false);
});
it.each(["taskId", "vmUuid", "hostUuid", "bootNonce", "sshHostKey", "identitySha256", "host", "port", "username"])("never rolls over %s during renewal", async field => {
  const runtime = bind();
  renew.mockResolvedValueOnce({ ...guest, expiresAt: Date.now() + 20000 });
  await runtime.execute(["snapshot"]);
  renew.mockResolvedValueOnce({ ...guest, [field]: field === "port" ? 23 : "changed" });
  await expect(runtime.execute(["snapshot"])).rejects.toThrow("GUEST_BINDING_CHANGED");
  expect(spawn).toHaveBeenCalledTimes(1);
  await runtime.dispose();
});
it("rejects concurrent runtimes and concurrent operations", async () => {
  const runtime = bind();
  expect(() => createComputerRuntime({ taskId: guest.taskId, artifactsDir: directory })).toThrow("GUEST_ALREADY_CLAIMED");
  let finish!: (value: VerifiedGuestMetadata) => void;
  renew.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = runtime.execute(["snapshot"]);
  await expect(runtime.execute(["snapshot"])).rejects.toThrow("RUNTIME_BUSY");
  finish(guest);
  await pending;
  await runtime.dispose();
});
it("keeps an ambiguous dispatch quarantined across disposal and re-registration", async () => {
  const runtime = bind();
  request = child => child.emit("close", 255, null);
  await expect(runtime.execute(["click", "e1"])).rejects.toMatchObject({ delivery: "unknown" });
  await expect(runtime.execute(["snapshot"])).rejects.toThrow("RUNTIME_CLOSED");
  await expect(runtime.dispose()).rejects.toThrow("GUEST_QUARANTINED");
  expect(existsSync(join(directory, "runtime.lock"))).toBe(true);
  unregister!();
  unregister = registerComputerGuest({ taskId: guest.taskId, artifactsDir: directory, connectionDir: directory, authority });
  expect(() => createComputerRuntime({ taskId: guest.taskId, artifactsDir: directory })).toThrow("GUEST_LOCKED");
  expect(spawn).toHaveBeenCalledTimes(1);
});
it("cancels renewal without dispatch even when the native authority resolves late", async () => {
  const runtime = bind();
  let finish!: (value: VerifiedGuestMetadata) => void;
  renew.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = runtime.execute(["click", "e1"]);
  const rejected = expect(pending).rejects.toThrow("CANCELLED");
  await runtime.dispose();
  await rejected;
  finish(guest);
  await Promise.resolve();
  expect(spawn).not.toHaveBeenCalled();
});
it("revokes idle and in-flight leases on lifecycle invalidation", async () => {
  const runtime = bind();
  const controller = new AbortController();
  request = () => invalidated.abort();
  await expect(runtime.execute(["click", "e1"], controller.signal)).rejects.toMatchObject({ delivery: "unknown" });
  await expect(runtime.dispose()).rejects.toThrow("GUEST_QUARANTINED");
});
it("pre-abort never renews or sends and dispose is idempotent", async () => {
  const runtime = bind();
  const controller = new AbortController(); controller.abort();
  await expect(runtime.execute(["click"], controller.signal)).rejects.toThrow("CANCELLED");
  expect(renew).not.toHaveBeenCalled();
  const disposal = runtime.dispose();
  expect(runtime.dispose()).toBe(disposal);
  await disposal;
});
it("bounds native renewal and aborts it without accepting late evidence", async () => {
  vi.useFakeTimers();
  const runtime = bind();
  let nativeSignal!: AbortSignal;
  renew.mockImplementationOnce(signal => { nativeSignal = signal; return new Promise(() => {}); });
  const pending = runtime.execute(["snapshot"]);
  const rejected = expect(pending).rejects.toThrow("LIFECYCLE_TIMEOUT");
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
  expect(nativeSignal.aborted).toBe(true);
  expect(spawn).not.toHaveBeenCalled();
  await runtime.dispose();
});
it("disposal waits for cancellation classification and never clears an uncertain lock", async () => {
  const runtime = bind();
  let dispatched!: () => void;
  const reached = new Promise<void>(resolve => { dispatched = resolve; });
  request = () => dispatched();
  const pending = runtime.execute(["click", "e1"]);
  const rejected = expect(pending).rejects.toMatchObject({ delivery: "unknown" });
  await reached;
  const disposal = runtime.dispose();
  expect(runtime.dispose()).toBe(disposal);
  await expect(disposal).rejects.toThrow("GUEST_QUARANTINED");
  await rejected;
  expect(existsSync(join(directory, "runtime.lock"))).toBe(true);
});
it("keeps host lifecycle exception details out of tool errors", async () => {
  const runtime = bind();
  renew.mockRejectedValueOnce(new Error("secret bootstrap detail"));
  await expect(runtime.execute(["snapshot"])).rejects.toThrow("LIFECYCLE_UNVERIFIED");
  expect(spawn).not.toHaveBeenCalled();
  await runtime.dispose();
});
it("does not accept a replaced ownership marker", async () => {
  const runtime = bind();
  renameSync(join(directory, "runtime.lock"), join(directory, "old.lock"));
  writeFileSync(join(directory, "runtime.lock"), "other-owner", { mode: 0o600 });
  await expect(runtime.execute(["snapshot"])).rejects.toThrow("GUEST_OWNERSHIP_LOST");
  await expect(runtime.dispose()).rejects.toThrow("GUEST_OWNERSHIP_LOST");
  expect(spawn).not.toHaveBeenCalled();
});
it("fails closed on expired leases and never sends an exec", async () => {
  const runtime = bind();
  renew.mockResolvedValueOnce({ ...guest, expiresAt: 0 });
  await expect(runtime.execute(["snapshot"])).rejects.toThrow("UNVERIFIED_GUEST");
  expect(spawn).not.toHaveBeenCalled();
  await runtime.dispose();
});
