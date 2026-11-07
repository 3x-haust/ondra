import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { TextDecoder } from "node:util";
import type { ComputerGuestAuthority } from "./computer-runtime";
import { ComputerTransportError, type VerifiedGuestMetadata } from "./computer-transport";

const LIMIT = 16 * 1024;
const TIMEOUT = 5000;
const identifier = (value: string) => /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const failure = (code: string) => new ComputerTransportError(code, "not_delivered");
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function socketIdentity(path: string) {
  if (!isAbsolute(path) || path !== resolve(path) || realpathSync(path) !== path) throw failure("UNSAFE_NATIVE_SOCKET");
  const parent = lstatSync(dirname(path));
  const socket = lstatSync(path);
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o7777) !== 0o700 ||
      !socket.isSocket() || socket.uid !== parent.uid || (socket.mode & 0o7777) !== 0o600) throw failure("UNSAFE_NATIVE_SOCKET");
  return socket;
}

/** The path is only a hint. Native admission authenticates the actual engine PID
 * and generation. No VM launch, manifest loading, reconnect or authority fallback. */
export async function connectComputerNative(path: string, sessionId: string, signal: AbortSignal): Promise<{
  connectionDir: string;
  authority: ComputerGuestAuthority;
  close(unknown?: boolean): void;
}> {
  if (!identifier(sessionId)) throw failure("INVALID_NATIVE_SESSION");
  if (signal.aborted) throw failure("CANCELLED");
  let original: ReturnType<typeof socketIdentity>;
  try { original = socketIdentity(path); }
  catch { throw failure("UNSAFE_NATIVE_SOCKET"); }
  const socket = createConnection({ path });
  const revoked = new AbortController();
  let bytes = Buffer.alloc(0);
  let pending: { id: string; finish(error?: Error, value?: unknown): void } | undefined;
  let connectFinish: ((error?: Error) => void) | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (code: string) => {
    revoked.abort();
    pending?.finish(failure(code));
    connectFinish?.(failure(code));
    signal.removeEventListener("abort", abort);
    socket.destroy();
  };
  const abort = () => terminate("CANCELLED");
  signal.addEventListener("abort", abort, { once: true });
  socket.on("error", () => terminate("NATIVE_CHANNEL_ERROR"));
  socket.on("end", () => terminate("GUEST_REVOKED"));
  socket.on("close", () => { clearTimeout(closeTimer); terminate("GUEST_REVOKED"); });
  socket.on("data", (chunk: Buffer) => {
    // One response in flight; unsolicited data and oversized frames are terminal.
    if (bytes.length + chunk.length > LIMIT + 1) { terminate("NATIVE_FRAME_LIMIT"); return; }
    bytes = Buffer.concat([bytes, chunk]);
    const end = bytes.indexOf(10);
    if (end < 0) return;
    if (end !== bytes.length - 1) { terminate("NATIVE_PROTOCOL_ERROR"); return; }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end))); }
    catch { terminate("NATIVE_PROTOCOL_ERROR"); return; }
    bytes = Buffer.alloc(0);
    if (!record(value) || value.version !== 1) { terminate("NATIVE_PROTOCOL_ERROR"); return; }
    if (value.event === "revoked") { terminate("GUEST_REVOKED"); return; }
    if (!pending || value.id !== pending.id || typeof value.ok !== "boolean") { terminate("NATIVE_PROTOCOL_ERROR"); return; }
    if (!value.ok) {
      // Never surface arbitrary native messages, paths or response payloads.
      const code = record(value.error) && value.error.code === "GUEST_SETUP_REQUIRED" ? "GUEST_SETUP_REQUIRED" : "GUEST_REVOKED";
      terminate(code);
      return;
    }
    if (!record(value.result)) { terminate("NATIVE_PROTOCOL_ERROR"); return; }
    pending.finish(undefined, value.result);
  });

  function request(op: "register" | "renew", active: AbortSignal): Promise<unknown> {
    if (revoked.signal.aborted) return Promise.reject(failure("GUEST_REVOKED"));
    if (pending) return Promise.reject(failure("NATIVE_CHANNEL_BUSY"));
    return new Promise((resolveValue, reject) => {
      const id = randomUUID();
      const cancel = () => terminate("CANCELLED");
      const timer = setTimeout(() => terminate("NATIVE_CHANNEL_TIMEOUT"), TIMEOUT);
      pending = { id, finish(error, value) {
        clearTimeout(timer);
        active.removeEventListener("abort", cancel);
        pending = undefined;
        if (error) reject(error); else resolveValue(value);
      } };
      active.addEventListener("abort", cancel, { once: true });
      if (active.aborted) { cancel(); return; }
      socket.write(JSON.stringify({ version: 1, id, op, sessionId }) + "\n");
    });
  }

  try {
    await new Promise<void>((resolveConnected, reject) => {
      const timer = setTimeout(() => terminate("NATIVE_CHANNEL_TIMEOUT"), TIMEOUT);
      connectFinish = error => {
        clearTimeout(timer);
        connectFinish = undefined;
        if (error) reject(error); else resolveConnected();
      };
      socket.once("connect", () => {
        try {
          const current = socketIdentity(path);
          if (current.dev !== original.dev || current.ino !== original.ino) throw failure("UNSAFE_NATIVE_SOCKET");
          connectFinish?.();
        } catch { terminate("UNSAFE_NATIVE_SOCKET"); }
      });
      if (signal.aborted) abort();
    });
    const registration = await request("register", signal);
    if (!record(registration) || Object.keys(registration).length !== 1 || typeof registration.connectionDir !== "string") {
      throw failure("NATIVE_PROTOCOL_ERROR");
    }
    return {
      connectionDir: registration.connectionDir,
      authority: {
        invalidated: revoked.signal,
        async renew(active) {
          // ComputerTransport validates the entire metadata and private pin files.
          return await request("renew", active) as VerifiedGuestMetadata;
        },
      },
      close(unknown = false) {
        if (revoked.signal.aborted) return;
        revoked.abort();
        pending?.finish(failure("GUEST_REVOKED"));
        signal.removeEventListener("abort", abort);
        socket.end(JSON.stringify({ version: 1, id: randomUUID(), op: unknown ? "unknown" : "release", sessionId }) + "\n");
        closeTimer = setTimeout(() => socket.destroy(), TIMEOUT);
        closeTimer.unref();
      },
    };
  } catch (error) {
    terminate("GUEST_REVOKED");
    throw error;
  }
}
