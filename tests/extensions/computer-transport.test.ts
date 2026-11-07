import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPUTER_GUEST_ENDPOINT, ComputerTransport, type VerifiedGuestMetadata } from "../../extensions/lib/computer-transport";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
const VM = "11111111-2222-3333-4444-555555555555";
const HOST = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NONCE = "1".repeat(64);
const privateKey = "test-only-private-identity";
const hostKey = `ssh-ed25519 ${Buffer.concat([Buffer.from("0000000b7373682d6564323535313900000020", "hex"), Buffer.alloc(32, 1)]).toString("base64")}`;
let directory: string;
let metadata: VerifiedGuestMetadata;
let children: FakeChild[];
let onRequest: (child: FakeChild, request: Record<string, unknown>) => void;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  input = "";
  kill = vi.fn(() => true);
  stdin = new Writable({
    write: (chunk, _encoding, callback) => { this.input += String(chunk); callback(); },
    final: callback => { onRequest(this, JSON.parse(this.input)); callback(); },
  });
}

function response(request: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { version: 1, requestId: request.requestId, taskId: metadata.taskId, vmUuid: VM, bootNonce: NONCE, result: { ok: true, data: { text: "안녕" } }, ...extra };
}

function reply(child: FakeChild, value: unknown, code: number | null = 0, signal: string | null = null) {
  child.stdout.write(JSON.stringify(value));
  child.emit("close", code, signal);
}

function saveManifest(extra: Record<string, unknown> = {}) {
  const { version, taskId, vmUuid, bootNonce, host, port, username } = metadata;
  writeFileSync(join(directory, "manifest.json"), JSON.stringify({ version, taskId, vmUuid, bootNonce, host, port, username, ...extra }), { mode: 0o600 });
}

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "computer-transport-")));
  chmodSync(directory, 0o700);
  metadata = {
    version: 1, taskId: "task-123", vmUuid: VM, hostUuid: HOST, bootNonce: NONCE,
    host: "192.168.64.2", port: 22, username: "ondra", sshHostKey: hostKey,
    identitySha256: createHash("sha256").update(privateKey).digest("hex"), expiresAt: Date.now() + 60_000,
  };
  saveManifest();
  writeFileSync(join(directory, "identity"), privateKey, { mode: 0o600 });
  writeFileSync(join(directory, "known_hosts"), `ondra-guest-${VM} ${hostKey}\n`, { mode: 0o600 });
  children = [];
  onRequest = (child, request) => reply(child, response(request));
  spawn.mockReset();
  spawn.mockImplementation(() => {
    const child = new FakeChild();
    children.push(child);
    queueMicrotask(() => child.emit("spawn"));
    return child;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe("pinned guest transport", () => {
  it("sends identity first and preserves hostile argv only in stdin JSON", async () => {
    vi.stubEnv("SSH_AUTH_SOCK", "/host-agent");
    vi.stubEnv("SSH_ASKPASS", "/host-program");
    vi.stubEnv("ONDRA_GUEST_HOST", "127.0.0.1");
    const argv = ["type", "$(touch /host); `id` ' \" \\ \n --proxy-command=evil", "한글 😀"];
    const result = await new ComputerTransport(directory, metadata).execute(argv);

    expect(result).toEqual({ ok: true, data: { text: "안녕" } });
    expect(spawn).toHaveBeenCalledTimes(2);
    const identity = JSON.parse(children[0].input);
    const command = JSON.parse(children[1].input);
    expect(identity).toEqual({ version: 1, op: "identity", requestId: expect.any(String) });
    expect(command).toEqual({ version: 1, op: "exec", requestId: expect.any(String), taskId: metadata.taskId, vmUuid: VM, bootNonce: NONCE, argv });
    expect(identity.requestId).not.toBe(command.requestId);
    for (const [binary, args, options] of spawn.mock.calls) {
      expect(binary).toBe("/usr/bin/ssh");
      expect(args.slice(0, 5)).toEqual(["-F", "/dev/null", "-T", "-a", "-x"]);
      expect(args.slice(-9)).toEqual(["-i", join(directory, "identity"), "-p", "22", "-l", "ondra", "--", "192.168.64.2", COMPUTER_GUEST_ENDPOINT]);
      expect(args.at(-1)).toBe(COMPUTER_GUEST_ENDPOINT);
      expect(args).not.toContain(argv[1]);
      expect(options).toEqual({ shell: false, stdio: ["pipe", "pipe", "pipe"], cwd: directory, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } });
      expect(args).toEqual(expect.arrayContaining([
        "BatchMode=yes", "StrictHostKeyChecking=yes", `UserKnownHostsFile=\"${directory}/known_hosts\"`, "GlobalKnownHostsFile=/dev/null", "KnownHostsCommand=none",
        `HostKeyAlias=ondra-guest-${VM}`, "HostKeyAlgorithms=ssh-ed25519", "UpdateHostKeys=no", "VerifyHostKeyDNS=no", "CheckHostIP=no",
        "IdentitiesOnly=yes", "IdentityAgent=none", "CertificateFile=none", "PreferredAuthentications=publickey", "PasswordAuthentication=no",
        "KbdInteractiveAuthentication=no", "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes", "Tunnel=no", "ProxyCommand=none",
        "ProxyJump=none", "PermitLocalCommand=no", "ControlMaster=no", "ControlPath=none", "ControlPersist=no", "RequestTTY=no",
        "EscapeChar=none", "ConnectionAttempts=1", "ServerAliveInterval=5", "ServerAliveCountMax=1", "LogLevel=ERROR",
      ]));
      expect(args.some((arg: string) => /^ConnectTimeout=\d+$/.test(arg))).toBe(true);
    }
  });

  it("quotes private directories containing spaces for OpenSSH", async () => {
    const nested = join(directory, "private files");
    mkdirSync(nested, { mode: 0o700 });
    for (const name of ["manifest.json", "identity", "known_hosts"]) renameSync(join(directory, name), join(nested, name));
    await new ComputerTransport(nested, metadata).execute(["snapshot"]);
    expect(spawn.mock.calls[0][1]).toContain(`UserKnownHostsFile=\"${nested}/known_hosts\"`);
  });

  it.each([
    ["host", "127.0.0.1"], ["host", "localhost"], ["host", "example.com"], ["host", "8.8.8.8"],
    ["host", "192.168.64.2; id"], ["host", "-oProxyCommand=evil"], ["username", "root;id"], ["username", "-F"],
    ["port", "22 -oProxyCommand=evil"], ["port", 0], ["port", 65536], ["taskId", "other/task"],
    ["vmUuid", HOST], ["vmUuid", "not-a-uuid"], ["hostUuid", ""], ["bootNonce", "short"],
    ["sshHostKey", `${hostKey}\n* ${hostKey}`], ["identitySha256", ""], ["expiresAt", 0], ["expiresAt", Number.MAX_SAFE_INTEGER],
  ])("rejects unverified or injectable %s=%s without spawning", (key, value) => {
    expect(() => new ComputerTransport(directory, { ...metadata, [key]: value })).toThrow("Guest transport:");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["taskId", "vmUuid", "bootNonce", "host", "port", "username", "version", "extra"]) (
    "rejects manifest %s that differs from independent lifecycle metadata", async key => {
      saveManifest({ [key]: "other" });
      await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ code: "MANIFEST_MISMATCH", delivery: "not_delivered" });
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it.each([0o640, 0o604, 0o700, 0o4600, 0o2600, 0o1600])("rejects unsafe private-file mode %s", async mode => {
    chmodSync(join(directory, "identity"), mode);
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ code: "UNSAFE_PRIVATE_FILE", delivery: "not_delivered" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["manifest.json", "identity", "known_hosts"])("rejects nonprivate, linked and nonregular %s", async name => {
    const file = join(directory, name);
    chmodSync(file, 0o644);
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ delivery: "not_delivered" });
    chmodSync(file, 0o600);
    linkSync(file, join(directory, "hardlink"));
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ delivery: "not_delivered" });
    rmSync(join(directory, "hardlink"));
    renameSync(file, join(directory, "original"));
    symlinkSync(join(directory, "original"), file);
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ delivery: "not_delivered" });
    rmSync(file);
    mkdirSync(file, { mode: 0o700 });
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ delivery: "not_delivered" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["%h", "$HOME", "\";id", "'", "\\", "\n"])("rejects OpenSSH path expansion or quoting %s", async suffix => {
    const unsafe = join(directory, suffix);
    mkdirSync(unsafe, { mode: 0o700 });
    await expect(new ComputerTransport(unsafe, metadata).execute(["snapshot"])).rejects.toMatchObject({ code: "UNSAFE_DIRECTORY", delivery: "not_delivered" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a public task directory, aliases and missing files", async () => {
    chmodSync(directory, 0o755);
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ code: "UNSAFE_DIRECTORY" });
    chmodSync(directory, 0o700);
    const alias = join(directory, "alias");
    symlinkSync(directory, alias);
    await expect(new ComputerTransport(alias, metadata).execute(["snapshot"])).rejects.toMatchObject({ code: "UNSAFE_DIRECTORY" });
    rmSync(join(directory, "identity"));
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ code: "UNSAFE_MANIFEST_FILES" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["identity", "wrong", "IDENTITY_KEY_MISMATCH"], ["known_hosts", `* ${hostKey}\n`, "HOST_KEY_MISMATCH"],
    ["known_hosts", `ondra-guest-${VM} ${hostKey}\nother ${hostKey}\n`, "HOST_KEY_MISMATCH"],
    ["manifest.json", "{", "UNSAFE_MANIFEST_FILES"], ["manifest.json", " ".repeat(4097), "UNSAFE_PRIVATE_FILE"],
  ])("rejects changed or malformed %s", async (name, content, code) => {
    writeFileSync(join(directory, name), content);
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ code, delivery: "not_delivered" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["requestId", "vmUuid", "bootNonce", "taskId", "version"])("checks the guest's own %s before delivering argv", async key => {
    onRequest = (child, request) => reply(child, response(request, { [key]: "wrong" }));
    const transport = new ComputerTransport(directory, metadata);
    await expect(transport.execute(["click", "e1"])).rejects.toMatchObject({ code: "GUEST_IDENTITY_MISMATCH", delivery: "not_delivered" });
    await expect(transport.execute(["click", "e1"])).rejects.toMatchObject({ code: "TRANSPORT_CLOSED" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("revalidates private files between identity and execution", async () => {
    onRequest = (child, request) => {
      writeFileSync(join(directory, "known_hosts"), `* ${hostKey}\n`);
      reply(child, response(request));
    };
    await expect(new ComputerTransport(directory, metadata).execute(["click", "e1"])).rejects.toMatchObject({ code: "HOST_KEY_MISMATCH", delivery: "not_delivered" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([[], "snapshot", ["type", "\0"], [1], Array(257).fill("x"), ["type", "x".repeat(65537)]])("rejects invalid argv %j", async argv => {
    await expect(new ComputerTransport(directory, metadata).execute(argv as string[])).rejects.toMatchObject({ code: "INVALID_ARGV", delivery: "not_delivered" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects sparse argv instead of serializing holes as null", async () => {
    await expect(new ComputerTransport(directory, metadata).execute(new Array<string>(1))).rejects.toMatchObject({ code: "INVALID_ARGV", delivery: "not_delivered" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a task directory belonging to another UID", async () => {
    vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ code: "UNSAFE_DIRECTORY", delivery: "not_delivered" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("returns guest failure envelopes unchanged rather than claiming action success", async () => {
    const result = { ok: false, error: { code: "PERMISSION_DENIED", recovery: "request_guest_permission" } };
    onRequest = (child, request) => reply(child, response(request, { result }));
    await expect(new ComputerTransport(directory, metadata).execute(["click"])).resolves.toEqual(result);
  });

  it("bounds total request size", async () => {
    await expect(new ComputerTransport(directory, metadata).execute(Array(5).fill("x".repeat(65536)))).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 60001])("rejects invalid timeout %s", async timeoutMs => {
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"], { timeoutMs })).rejects.toMatchObject({ code: "INVALID_TIMEOUT" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not trust later mutation of verified metadata or caller argv", async () => {
    const transport = new ComputerTransport(directory, metadata);
    const argv = ["snapshot"];
    const result = transport.execute(argv);
    metadata.host = "127.0.0.1";
    metadata.bootNonce = "2".repeat(64);
    argv[0] = "evil";
    await result;
    expect(spawn.mock.calls[1][1]).toContain("192.168.64.2");
    expect(JSON.parse(children[1].input).argv).toEqual(["snapshot"]);
  });
});

describe("cancellation and ambiguous delivery", () => {
  it("pre-aborted calls never spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new ComputerTransport(directory, metadata).execute(["click"], { signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED", delivery: "not_delivered" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["identity", "exec"])("cancels during %s with conservative delivery and no retry", async phase => {
    const controller = new AbortController();
    const transport = new ComputerTransport(directory, metadata);
    onRequest = (child, request) => {
      if (request.op === phase) controller.abort();
      else reply(child, response(request));
    };
    await expect(transport.execute(["click"], { signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED", delivery: phase === "exec" ? "unknown" : "not_delivered" });
    expect(children.at(-1)?.kill).toHaveBeenCalledWith("SIGKILL");
    await expect(transport.execute(["click"])).rejects.toMatchObject({ code: "TRANSPORT_CLOSED" });
    expect(spawn).toHaveBeenCalledTimes(phase === "exec" ? 2 : 1);
  });

  it("cancels before process spawn without sending request bytes", async () => {
    const controller = new AbortController();
    spawn.mockImplementation(() => { const child = new FakeChild(); children.push(child); return child; });
    const pending = new ComputerTransport(directory, metadata).execute(["click"], { signal: controller.signal });
    controller.abort();
    children[0].emit("spawn");
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED", delivery: "not_delivered" });
    expect(children[0].input).toBe("");
  });

  it.each(["identity", "exec"])("bounds elapsed time during %s even if SSH never closes", async phase => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    onRequest = (child, request) => { if (request.op !== phase) reply(child, response(request)); };
    const pending = new ComputerTransport(directory, metadata).execute(["click"], { timeoutMs: 20 });
    const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT", delivery: phase === "exec" ? "unknown" : "not_delivered" });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(children.at(-1)?.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not send bytes if spawn arrives after the deadline", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    spawn.mockImplementation(() => { const child = new FakeChild(); children.push(child); return child; });
    const pending = new ComputerTransport(directory, metadata).execute(["click"], { timeoutMs: 10 });
    vi.setSystemTime(Date.now() + 11);
    children[0].emit("spawn");
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT", delivery: "not_delivered" });
    expect(children[0].input).toBe("");
  });

  it("limits a running command to the remaining verified lease", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    onRequest = (child, request) => { if (request.op === "identity") reply(child, response(request)); };
    const pending = new ComputerTransport(directory, { ...metadata, expiresAt: Date.now() + 10 }).execute(["click"], { timeoutMs: 100 });
    const assertion = expect(pending).rejects.toMatchObject({ code: "TIMEOUT", delivery: "unknown" });
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(children[1].kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("expires the verified lifecycle lease and does not begin another request", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const transport = new ComputerTransport(directory, { ...metadata, expiresAt: Date.now() + 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(transport.execute(["snapshot"])).rejects.toMatchObject({ code: "GUEST_LEASE_EXPIRED" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["exit", "signal", "malformed", "wrong identity", "missing result", "stdin", "stdout", "stderr", "error"])("marks %s after action dispatch unknown and closes transport", async failure => {
    onRequest = (child, request) => {
      if (request.op === "identity") return reply(child, response(request));
      if (failure === "exit") return reply(child, response(request), 255);
      if (failure === "signal") return reply(child, response(request), null, "SIGTERM");
      if (failure === "malformed") { child.stdout.write("not json"); return child.emit("close", 0, null); }
      if (failure === "wrong identity") return reply(child, response(request, { vmUuid: HOST }));
      if (failure === "missing result") { const value: Record<string, unknown> = response(request); delete value.result; return reply(child, value); }
      if (failure === "error") return child.emit("error", new Error("sensitive SSH output"));
      return child[failure as "stdin" | "stdout" | "stderr"].emit("error", new Error("sensitive SSH output"));
    };
    const transport = new ComputerTransport(directory, metadata);
    await expect(transport.execute(["click"])).rejects.toMatchObject({ name: "ComputerTransportError", delivery: "unknown" });
    await expect(transport.execute(["click"])).rejects.toMatchObject({ code: "TRANSPORT_CLOSED" });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid UTF-8 instead of silently changing the guest result", async () => {
    onRequest = (child, request) => {
      if (request.op === "identity") return reply(child, response(request));
      const valid = JSON.stringify(response(request, { result: "X" }));
      const split = valid.indexOf('"X"');
      child.stdout.write(Buffer.concat([Buffer.from(valid.slice(0, split + 1)), Buffer.from([0xff]), Buffer.from(valid.slice(split + 2))]));
      child.emit("close", 0, null);
    };
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ code: "INVALID_RESPONSE", delivery: "unknown" });
  });

  it.each(["stdout", "stderr"])("bounds %s and never returns truncated success", async stream => {
    onRequest = (child, request) => {
      if (request.op === "identity") return reply(child, response(request));
      child.stdout.write(" ");
      child[stream as "stdout" | "stderr"].write(Buffer.alloc(8 * 1024 * 1024, 32));
      reply(child, response(request));
    };
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ code: "OUTPUT_LIMIT", delivery: "unknown" });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("does not fall back when OpenSSH fails before spawn", async () => {
    spawn.mockImplementation(() => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("error", new Error("ENOENT")));
      return child;
    });
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ code: "SSH_ERROR", delivery: "not_delivered" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0]).toBe("/usr/bin/ssh");
  });

  it("normalizes synchronous spawn failure without exposing host error details", async () => {
    spawn.mockImplementation(() => { throw new Error("private host detail"); });
    await expect(new ComputerTransport(directory, metadata).execute(["snapshot"])).rejects.toMatchObject({ code: "SSH_ERROR", delivery: "not_delivered" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("reports failure to terminate SSH without hanging cancellation", async () => {
    const controller = new AbortController();
    onRequest = (child, request) => {
      if (request.op === "identity") return reply(child, response(request));
      child.kill.mockImplementation(() => { throw new Error("EPERM private detail"); });
      controller.abort();
    };
    await expect(new ComputerTransport(directory, metadata).execute(["click"], { signal: controller.signal })).rejects.toMatchObject({ code: "SSH_TERMINATION_FAILED", delivery: "unknown" });
  });

  it("rejects concurrent requests and dispose aborts the active operation", async () => {
    const transport = new ComputerTransport(directory, metadata);
    onRequest = () => {};
    const pending = transport.execute(["click"]);
    await expect(transport.execute(["click"])).rejects.toMatchObject({ code: "TRANSPORT_BUSY", delivery: "not_delivered" });
    transport.dispose();
    transport.dispose();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED", delivery: "not_delivered" });
    await expect(transport.execute(["click"])).rejects.toMatchObject({ code: "TRANSPORT_CLOSED" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
