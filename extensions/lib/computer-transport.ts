import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isIPv4 } from "node:net";
import { isAbsolute, join, resolve } from "node:path";

export const COMPUTER_GUEST_ENDPOINT = "/usr/local/libexec/ondra-computer-endpoint";
const MAX_OUTPUT = 8 * 1024 * 1024;
const MAX_INPUT = 256 * 1024;
const MAX_LEASE_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface GuestManifest {
  version: 1;
  taskId: string;
  vmUuid: string;
  bootNonce: string;
  host: string;
  port: number;
  username: string;
}

/**
 * Trusted lifecycle-manager input, NOT values inferred from an environment variable,
 * an address, or the manifest itself. The caller must independently bind this task's
 * running, isolated local macOS VM to its hardware UUID, per-boot secret nonce,
 * freshly provisioned SSH host key, endpoint installation and client identity.
 * hostUuid is the independently obtained host hardware UUID. expiresAt is a short
 * lease; the caller must dispose the transport on VM stop/reboot/ownership change.
 * This module does not prove VM lifecycle, guest permissions or host noninterference.
 */
export interface VerifiedGuestMetadata extends GuestManifest {
  hostUuid: string;
  sshHostKey: string;
  identitySha256: string;
  expiresAt: number;
}

export type ComputerDelivery = "not_delivered" | "unknown";
export class ComputerTransportError extends Error {
  constructor(public readonly code: string, public readonly delivery: ComputerDelivery) {
    super(`Guest transport: ${code} (${delivery})`);
    this.name = "ComputerTransportError";
  }
}

function refuse(code: string): never {
  throw new ComputerTransportError(code, "not_delivered");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateMetadata(value: VerifiedGuestMetadata): void {
  if (!record(value) || value.version !== 1 || typeof value.taskId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(value.taskId) || typeof value.vmUuid !== "string" || !UUID.test(value.vmUuid) ||
      typeof value.hostUuid !== "string" || !UUID.test(value.hostUuid) || value.vmUuid === value.hostUuid ||
      typeof value.bootNonce !== "string" || !/^[0-9a-f]{64}$/.test(value.bootNonce) ||
      typeof value.host !== "string" || !isIPv4(value.host) ||
      !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(value.host) ||
      !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
      typeof value.username !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(value.username) ||
      typeof value.identitySha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.identitySha256) ||
      typeof value.sshHostKey !== "string" || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(value.sshHostKey) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + MAX_LEASE_MS) {
    refuse("UNVERIFIED_GUEST");
  }
  const key = Buffer.from(value.sshHostKey.slice("ssh-ed25519 ".length), "base64");
  if (key.length !== 51 || key.subarray(0, 19).toString("hex") !== "0000000b7373682d6564323535313900000020") refuse("INVALID_HOST_KEY");
}

/** Reads bounded, private, single-link regular files without following final symlinks. */
function privateFile(path: string, limit: number): Buffer {
  const uid = process.getuid?.();
  if (uid === undefined) refuse("UNSUPPORTED_HOST");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || ![0o400, 0o600].includes(stat.mode & 0o7777) || stat.nlink !== 1 || stat.size < 1 || stat.size > limit) {
      refuse("UNSAFE_PRIVATE_FILE");
    }
    const bytes = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > limit) refuse("PRIVATE_FILE_TOO_LARGE");
    return bytes.subarray(0, used);
  } finally {
    closeSync(fd);
  }
}

function connectionFiles(directory: string, expected: VerifiedGuestMetadata): { identity: string; knownHosts: string } {
  try {
    // OpenSSH expands tokens and parses quoting in some filename options.
    if (!isAbsolute(directory) || directory !== resolve(directory) || /[\x00-\x1f\x7f%$"'\\]/.test(directory) ||
        realpathSync(directory) !== directory) refuse("UNSAFE_DIRECTORY");
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) refuse("UNSAFE_DIRECTORY");
    const manifest: unknown = JSON.parse(privateFile(join(directory, "manifest.json"), 4096).toString("utf8"));
    const fields = ["version", "taskId", "vmUuid", "bootNonce", "host", "port", "username"] as const;
    if (!record(manifest) || Object.keys(manifest).length !== fields.length || fields.some(key => manifest[key] !== expected[key])) {
      refuse("MANIFEST_MISMATCH");
    }
    const identity = join(directory, "identity");
    const knownHosts = join(directory, "known_hosts");
    const digest = createHash("sha256").update(privateFile(identity, 32 * 1024)).digest("hex");
    if (digest !== expected.identitySha256) refuse("IDENTITY_KEY_MISMATCH");
    const pin = `ondra-guest-${expected.vmUuid} ${expected.sshHostKey}\n`;
    if (privateFile(knownHosts, 4096).toString("utf8") !== pin) refuse("HOST_KEY_MISMATCH");
    return { identity, knownHosts };
  } catch (error) {
    if (error instanceof ComputerTransportError) throw error;
    refuse("UNSAFE_MANIFEST_FILES");
  }
}

function sshArguments(directory: string, guest: VerifiedGuestMetadata, timeoutMs: number): string[] {
  const files = connectionFiles(directory, guest);
  const options = [
    "BatchMode=yes", "StrictHostKeyChecking=yes", `UserKnownHostsFile="${files.knownHosts}"`,
    "GlobalKnownHostsFile=/dev/null", "KnownHostsCommand=none", `HostKeyAlias=ondra-guest-${guest.vmUuid}`, "HostKeyAlgorithms=ssh-ed25519",
    "UpdateHostKeys=no", "VerifyHostKeyDNS=no", "CheckHostIP=no", "IdentitiesOnly=yes", "IdentityAgent=none",
    "CertificateFile=none", "PreferredAuthentications=publickey", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no",
    "ForwardAgent=no", "ForwardX11=no", "ClearAllForwardings=yes", "Tunnel=no", "ProxyCommand=none", "ProxyJump=none",
    "PermitLocalCommand=no", "ControlMaster=no", "ControlPath=none", "ControlPersist=no", "RequestTTY=no",
    "EscapeChar=none", "ConnectionAttempts=1", `ConnectTimeout=${Math.max(1, Math.ceil(timeoutMs / 1000))}`,
    "ServerAliveInterval=5", "ServerAliveCountMax=1", "LogLevel=ERROR",
  ];
  return ["-F", "/dev/null", "-T", "-a", "-x", ...options.flatMap(option => ["-o", option]),
    "-i", files.identity, "-p", String(guest.port), "-l", guest.username, "--", guest.host, COMPUTER_GUEST_ENDPOINT];
}

/**
 * Executes only the fixed guest endpoint. Request and response are single JSON
 * documents. identity requests contain only version, op and a fresh requestId;
 * the endpoint must read taskId/vmUuid/bootNonce from its own provisioned state,
 * not echo client claims. exec requests also carry that identity plus argv.
 * The endpoint must check identity BEFORE executing its fixed desktop binary
 * with argv (never a shell), and return {version:1, requestId, taskId, vmUuid,
 * bootNonce, result}. Result is the unmodified desktop envelope, not proof of
 * action success. stdout must contain no banners/logs; stderr is not exposed.
 *
 * The private directory contains manifest.json (GuestManifest), identity and
 * known_hosts (exactly `ondra-guest-<vmUuid> <sshHostKey>\n`). Keep it immutable
 * for the lease: OpenSSH reopens key files. POSIX ownership is not a sandbox
 * against other processes with the same UID/root; lifecycle ownership remains
 * the caller's responsibility. No TOFU, DNS, proxy, local command or fallback.
 */
export class ComputerTransport {
  private readonly guest: Readonly<VerifiedGuestMetadata>;
  private active?: AbortController;
  private closed = false;

  constructor(private readonly directory: string, verified: VerifiedGuestMetadata) {
    validateMetadata(verified);
    this.guest = Object.freeze({ ...verified });
  }

  /** Stops the local SSH client, not a guarantee that a remote action stopped. */
  dispose(): void {
    this.closed = true;
    this.active?.abort();
  }

  async execute(argv: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<unknown> {
    if (this.closed) refuse("TRANSPORT_CLOSED");
    if (this.active) refuse("TRANSPORT_BUSY");
    if (options.signal?.aborted) refuse("CANCELLED");
    const timeout = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_LEASE_MS) refuse("INVALID_TIMEOUT");
    if (!Array.isArray(argv) || argv.length < 1 || argv.length > 256) refuse("INVALID_ARGV");
    const args = [...argv];
    if (args.some(arg => typeof arg !== "string" || arg.includes("\0") || Buffer.byteLength(arg) > 65536)) refuse("INVALID_ARGV");
    if (Buffer.byteLength(JSON.stringify(args)) > MAX_INPUT - 1024) refuse("INPUT_TOO_LARGE");
    const deadline = Math.min(Date.now() + timeout, this.guest.expiresAt);
    if (deadline <= Date.now()) refuse("GUEST_LEASE_EXPIRED");
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.active = controller;
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      await this.exchange("identity", undefined, controller.signal, deadline);
      return await this.exchange("exec", args, controller.signal, deadline);
    } catch (error) {
      // Never retry an ambiguous action or reuse an unproven connection.
      this.closed = true;
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      this.active = undefined;
    }
  }

  private async exchange(op: "identity" | "exec", argv: string[] | undefined, signal: AbortSignal, deadline: number): Promise<unknown> {
    if (signal.aborted) refuse("CANCELLED");
    if (deadline <= Date.now()) refuse("TIMEOUT");
    const requestId = randomUUID();
    const request = op === "identity" ? { version: 1, op, requestId } : {
      version: 1, op, requestId, taskId: this.guest.taskId, vmUuid: this.guest.vmUuid, bootNonce: this.guest.bootNonce, argv,
    };
    const args = sshArguments(this.directory, this.guest, deadline - Date.now());
    if (signal.aborted) refuse("CANCELLED");
    if (deadline <= Date.now()) refuse("TIMEOUT");
    return new Promise((resolveResult, reject) => {
      let sent = false;
      let settled = false;
      let size = 0;
      const chunks: Buffer[] = [];
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn("/usr/bin/ssh", args, {
          shell: false, stdio: ["pipe", "pipe", "pipe"], cwd: this.directory,
          env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        });
      } catch {
        reject(new ComputerTransportError("SSH_ERROR", "not_delivered"));
        return;
      }
      const delivery = (): ComputerDelivery => op === "exec" && sent ? "unknown" : "not_delivered";
      const finish = (error?: ComputerTransportError, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        if (error) {
          // Killing SSH cannot retract input already accepted by the guest.
          try { child.kill("SIGKILL"); }
          catch { error = new ComputerTransportError("SSH_TERMINATION_FAILED", delivery()); }
          reject(error);
        } else resolveResult(result);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const fail = (code: string) => finish(new ComputerTransportError(code, delivery()));
      const onAbort = () => fail("CANCELLED");
      const timer = setTimeout(() => fail("TIMEOUT"), Math.max(1, deadline - Date.now()));
      signal.addEventListener("abort", onAbort, { once: true });
      child.on("error", () => fail("SSH_ERROR"));
      child.stdin.on("error", () => fail("STDIN_ERROR"));
      child.stdout.on("error", () => fail("STDOUT_ERROR"));
      child.stderr.on("error", () => fail("STDERR_ERROR"));
      const data = (chunk: Buffer, stdout: boolean) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_OUTPUT) return fail("OUTPUT_LIMIT");
        if (stdout) chunks.push(chunk);
      };
      child.stdout.on("data", (chunk: Buffer) => data(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => data(chunk, false));
      child.once("spawn", () => {
        if (settled) return;
        if (signal.aborted) return onAbort();
        if (Date.now() >= deadline) return fail("TIMEOUT");
        sent = true;
        child.stdin.end(`${JSON.stringify(request)}\n`);
      });
      child.once("close", (code, exitSignal) => {
        if (settled) return;
        if (signal.aborted) return onAbort();
        if (Date.now() >= deadline) return fail("TIMEOUT");
        if (code !== 0 || exitSignal) return fail("SSH_EXIT");
        let response: unknown;
        try { response = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
        catch { return fail("INVALID_RESPONSE"); }
        if (!record(response) || response.version !== 1 || response.requestId !== requestId ||
            response.taskId !== this.guest.taskId || response.vmUuid !== this.guest.vmUuid || response.bootNonce !== this.guest.bootNonce) {
          return fail("GUEST_IDENTITY_MISMATCH");
        }
        if (op === "exec" && !Object.prototype.hasOwnProperty.call(response, "result")) return fail("INVALID_RESPONSE");
        finish(undefined, response.result);
      });
      if (signal.aborted) onAbort();
    });
  }
}
