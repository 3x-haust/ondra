import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ComputerTransport, ComputerTransportError, type VerifiedGuestMetadata } from "./computer-transport";

export type ComputerRuntimeJob = { taskId: string; artifactsDir: string };

/**
 * Privileged integration boundary, called only by trusted application bootstrap.
 * renew MUST obtain fresh evidence from the local VM owner, not read a manifest
 * or environment variable and label it verified. In particular it must bind:
 * - independent host IOPlatformUUID and the actual guest IOPlatformUUID;
 * - VZMacMachineIdentifier data used by the running VM (opaque, not a UUID string);
 * - the owned Lume child, start time, config flock and unchanged VM configuration;
 * - private LUME_HOME, explicit storage, display none, vnc disabled, network nat,
 *   no clipboard/shared folders, and no live native-viewer attachment path;
 * - independently provisioned endpoint, per-boot nonce, client key and host pin.
 * The endpoint must verify the real guest UUID and current boot itself.
 *
 * Abort invalidated BEFORE stopping/rebooting/reassigning the VM or changing any
 * of these properties. renew is read-only, abort-aware and bounded to 5 seconds.
 * Leases are at most 60 seconds. The authority must hold exclusive VM ownership
 * across leases, including across engine processes, not just this JS module.
 * Nothing here proves these native facts. There is deliberately no env/file
 * loader or default authority. Registration is not a model-facing tool.
 */
export interface ComputerGuestAuthority {
  readonly invalidated: AbortSignal;
  renew(signal: AbortSignal): Promise<VerifiedGuestMetadata>;
}

export type ComputerGuestRegistration = ComputerRuntimeJob & {
  /** Immutable private connection files, prepared by the trusted provisioner. */
  connectionDir: string;
  authority: ComputerGuestAuthority;
};

type Binding = {
  directory: string;
  authority: ComputerGuestAuthority;
  revoked: AbortController;
  claimed: boolean;
};
const bindings = new Map<string, Binding>();

function refuse(code: string): never { throw new ComputerTransportError(code, "not_delivered"); }
function jobKey(job: ComputerRuntimeJob): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(job.taskId) || !isAbsolute(job.artifactsDir) ||
      realpathSync(job.artifactsDir) !== job.artifactsDir) refuse("INVALID_JOB");
  return JSON.stringify([job.taskId, job.artifactsDir]);
}
function privateDirectory(directory: string) {
  if (!isAbsolute(directory) || directory !== resolve(directory) || realpathSync(directory) !== directory) refuse("UNSAFE_DIRECTORY");
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || process.getuid?.() !== stat.uid || (stat.mode & 0o7777) !== 0o700) refuse("UNSAFE_DIRECTORY");
  return stat;
}

/**
 * Install an already prepared guest's native lifecycle authority in this engine.
 * No VM is booted, adopted, stopped or provisioned by this call. Bootstrap must
 * register separately in each engine after acquiring its cross-process VM lease.
 * Revocation never clears runtime.lock: a crash or uncertain delivery requires
 * native reconciliation (old run stopped and outstanding actions impossible)
 * before the provisioner may retire the old connection directory.
 */
export function registerComputerGuest(input: ComputerGuestRegistration): () => void {
  const key = jobKey(input);
  if (bindings.has(key)) refuse("GUEST_ALREADY_REGISTERED");
  privateDirectory(input.connectionDir);
  if (input.authority.invalidated.aborted) refuse("GUEST_REVOKED");
  const revoked = new AbortController();
  const authority: ComputerGuestAuthority = Object.freeze({
    invalidated: input.authority.invalidated,
    renew: input.authority.renew.bind(input.authority),
  });
  const binding: Binding = { directory: input.connectionDir, authority, revoked, claimed: false };
  const invalidate = () => revoked.abort();
  authority.invalidated.addEventListener("abort", invalidate, { once: true });
  bindings.set(key, binding);
  return () => {
    invalidate();
    authority.invalidated.removeEventListener("abort", invalidate);
    if (bindings.get(key) === binding) bindings.delete(key);
  };
}

function renew(authority: ComputerGuestAuthority, signal: AbortSignal): Promise<VerifiedGuestMetadata> {
  return new Promise((resolveLease, reject) => {
    let settled = false;
    const controller = new AbortController();
    const finish = (error?: unknown, lease?: VerifiedGuestMetadata) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) { controller.abort(); reject(error); } else resolveLease(lease!);
    };
    const abort = () => finish(new ComputerTransportError("CANCELLED", "not_delivered"));
    const timer = setTimeout(() => finish(new ComputerTransportError("LIFECYCLE_TIMEOUT", "not_delivered")), 5000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    const failed = () => finish(new ComputerTransportError("LIFECYCLE_UNVERIFIED", "not_delivered"));
    try { authority.renew(controller.signal).then(lease => finish(undefined, lease), failed); }
    catch { failed(); }
  });
}

/** One claim, one boot, serial commands. Only ComputerTransport may dispatch. */
export function createComputerRuntime(job: ComputerRuntimeJob) {
  const taskId = job.taskId;
  const binding = bindings.get(jobKey(job));
  if (!binding) refuse("GUEST_SETUP_REQUIRED");
  if (binding.revoked.signal.aborted) refuse("GUEST_REVOKED");
  if (binding.claimed) refuse("GUEST_ALREADY_CLAIMED");
  const directory = privateDirectory(binding.directory);
  const lockPath = join(binding.directory, "runtime.lock");
  let lock: number;
  try { lock = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch { refuse("GUEST_LOCKED"); }
  const lockStat = fstatSync(lock);
  try { writeFileSync(lock, "owned\n"); }
  finally { closeSync(lock); }
  binding.claimed = true;
  let closed = false;
  let uncertain = false;
  let active: AbortController | undefined;
  let transport: ComputerTransport | undefined;
  let pending: Promise<void> | undefined;
  let disposal: Promise<void> | undefined;
  let identity: Readonly<VerifiedGuestMetadata> | undefined;
  const invalidate = () => { closed = true; active?.abort(); transport?.dispose(); };
  binding.revoked.signal.addEventListener("abort", invalidate, { once: true });

  function checkOwnership() {
    const current = privateDirectory(binding!.directory);
    const marker = lstatSync(lockPath);
    if (current.dev !== directory.dev || current.ino !== directory.ino ||
        marker.dev !== lockStat.dev || marker.ino !== lockStat.ino || marker.nlink !== 1 ||
        !marker.isFile() || marker.uid !== process.getuid?.() || (marker.mode & 0o7777) !== 0o600) refuse("GUEST_OWNERSHIP_LOST");
    if (binding!.revoked.signal.aborted) refuse("GUEST_REVOKED");
  }

  async function execute(argv: readonly string[], signal?: AbortSignal): Promise<unknown> {
    if (closed) refuse("RUNTIME_CLOSED");
    if (active) refuse("RUNTIME_BUSY");
    if (signal?.aborted) refuse("CANCELLED");
    // Snapshot before the first asynchronous boundary; transport validates grammar.
    if (!Array.isArray(argv)) refuse("INVALID_ARGV");
    const args = [...argv];
    const controller = new AbortController();
    active = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    let complete!: () => void;
    pending = new Promise<void>(resolvePending => { complete = resolvePending; });
    let dispatched = false;
    try {
      checkOwnership();
      const lease = { ...await renew(binding!.authority, controller.signal) };
      if (controller.signal.aborted || closed) refuse("CANCELLED");
      checkOwnership();
      const fields = ["version", "taskId", "hostUuid", "vmUuid", "bootNonce", "host", "port", "username", "sshHostKey", "identitySha256"] as const;
      if (lease.taskId !== taskId || (identity && fields.some(field => lease[field] !== identity![field]))) refuse("GUEST_BINDING_CHANGED");
      // Constructor validates lease age and independent host/guest distinction.
      transport = new ComputerTransport(binding!.directory, lease);
      identity ??= Object.freeze({ ...lease });
      dispatched = true;
      const value = await transport.execute(args, { signal: controller.signal });
      // A response racing revocation is not permission to continue this runtime.
      if (controller.signal.aborted || closed) throw new ComputerTransportError("CANCELLED", "unknown");
      return value;
    } catch (error) {
      closed = true;
      if (dispatched && (!(error instanceof ComputerTransportError) || error.delivery === "unknown")) uncertain = true;
      throw error;
    } finally {
      transport?.dispose();
      transport = undefined;
      signal?.removeEventListener("abort", abort);
      active = undefined;
      complete();
      pending = undefined;
    }
  }

  function dispose(): Promise<void> {
    if (disposal) return disposal;
    invalidate();
    disposal = (async () => {
      await pending;
      binding!.revoked.signal.removeEventListener("abort", invalidate);
      if (uncertain) refuse("GUEST_QUARANTINED");
      // Revocation is allowed during disposal, but a replaced marker is not ours.
      const current = privateDirectory(binding!.directory);
      const marker = lstatSync(lockPath);
      if (current.dev !== directory.dev || current.ino !== directory.ino ||
          marker.dev !== lockStat.dev || marker.ino !== lockStat.ino) refuse("GUEST_OWNERSHIP_LOST");
      unlinkSync(lockPath);
      // The registration remains single-use even after a clean disposal.
    })();
    return disposal;
  }
  return { execute, dispose };
}
