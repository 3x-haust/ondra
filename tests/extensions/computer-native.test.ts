import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { connectComputerNative } from "../../extensions/lib/computer-native";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(reply: (request: any, socket: Socket) => void) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "cn-")));
  chmodSync(directory, 0o700);
  const path = join(directory, "native.sock");
  const peers = new Set<Socket>();
  const requests: any[] = [];
  const server = createServer(socket => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => peers.delete(socket));
    let text = "";
    socket.on("data", chunk => {
      text += chunk.toString();
      let end: number;
      while ((end = text.indexOf("\n")) >= 0) {
        const request = JSON.parse(text.slice(0, end));
        text = text.slice(end + 1);
        requests.push(request);
        reply(request, socket);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  chmodSync(path, 0o600);
  cleanup.push(async () => {
    for (const socket of peers) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  return { path, directory, requests, peers };
}
const success = (request: any, socket: Socket, result: unknown = { connectionDir: "/private/fixture" }) => {
  socket.write(JSON.stringify({ version: 1, id: request.id, ok: true, result }) + "\n");
};
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Fixture condition was not reached");
};

describe("native computer channel client", () => {
  it("registers once, renews on the same session and releases without VM arguments", async () => {
    const lease = { version: 1, taskId: "fixture", expiresAt: 123 };
    const f = await fixture((req, socket) => {
      if (req.op === "register") success(req, socket);
      if (req.op === "renew") success(req, socket, lease);
      if (req.op === "release") socket.end();
    });
    const client = await connectComputerNative(f.path, "session-1", new AbortController().signal);
    expect(client.connectionDir).toBe("/private/fixture");
    expect(await client.authority.renew(new AbortController().signal)).toEqual(lease);
    client.close();
    client.close();
    expect(client.authority.invalidated.aborted).toBe(true);
    await until(() => f.requests.length === 3);
    expect(f.requests.map(r => r.op)).toEqual(["register", "renew", "release"]);
    for (const request of f.requests) {
      expect(Object.keys(request).sort()).toEqual(["id", "op", "sessionId", "version"]);
      expect(request.sessionId).toBe("session-1");
    }
    await expect(client.authority.renew(new AbortController().signal)).rejects.toThrow("GUEST_REVOKED");
  });

  it("sends unknown and invalidates immediately instead of retrying", async () => {
    const f = await fixture((req, socket) => { if (req.op === "register") success(req, socket); });
    const client = await connectComputerNative(f.path, "s", new AbortController().signal);
    client.close(true);
    expect(client.authority.invalidated.aborted).toBe(true);
    await until(() => f.requests.length === 2);
    expect(f.requests[1].op).toBe("unknown");
  });

  it.each(["end", "revoke"])("invalidates on native %s", async event => {
    const f = await fixture(success);
    const client = await connectComputerNative(f.path, "s", new AbortController().signal);
    for (const socket of f.peers) {
      if (event === "end") socket.end();
      else socket.write('{"version":1,"event":"revoked","code":"GUEST_REVOKED"}\n');
    }
    await until(() => client.authority.invalidated.aborted);
    await expect(client.authority.renew(new AbortController().signal)).rejects.toThrow("GUEST_REVOKED");
    expect(f.requests).toHaveLength(1);
  });

  it("sanitizes errors and does not reconnect after setup refusal", async () => {
    const f = await fixture((req, socket) => socket.write(JSON.stringify({ version: 1, id: req.id, ok: false,
      error: { code: "GUEST_SETUP_REQUIRED", message: "private-secret" } }) + "\n"));
    await expect(connectComputerNative(f.path, "s", new AbortController().signal)).rejects.toThrow("GUEST_SETUP_REQUIRED");
    expect(f.requests).toHaveLength(1);
  });

  it.each(["wrong-id", "invalid-utf8", "oversized", "non-object", "extra-registration"])("rejects %s response", async kind => {
    const f = await fixture((req, socket) => {
      if (kind === "wrong-id") success({ id: "other" }, socket);
      if (kind === "invalid-utf8") socket.write(Buffer.from([0xff, 10]));
      if (kind === "oversized") socket.write("x".repeat(16385) + "\n");
      if (kind === "non-object") socket.write("[]\n");
      if (kind === "extra-registration") success(req, socket, { connectionDir: "/private/fixture", verified: true });
    });
    await expect(connectComputerNative(f.path, "s", new AbortController().signal)).rejects.toThrow(/NATIVE_/);
    expect(f.requests).toHaveLength(1);
  });

  it("rejects public socket permissions before sending any request", async () => {
    const f = await fixture(success);
    chmodSync(f.path, 0o666);
    await expect(connectComputerNative(f.path, "s", new AbortController().signal)).rejects.toThrow("UNSAFE_NATIVE_SOCKET");
    expect(f.requests).toHaveLength(0);
  });

  it("cancels pending registration and renewal without retaining authority", async () => {
    const f = await fixture((req, socket) => { if (req.op === "register" && req.sessionId === "renew-test") success(req, socket); });
    const initial = new AbortController();
    const registering = connectComputerNative(f.path, "cancel-test", initial.signal);
    const rejected = expect(registering).rejects.toThrow("CANCELLED");
    await until(() => f.requests.length === 1);
    initial.abort();
    await rejected;
    const client = await connectComputerNative(f.path, "renew-test", new AbortController().signal);
    const active = new AbortController();
    const renewing = client.authority.renew(active.signal);
    const cancelled = expect(renewing).rejects.toThrow("CANCELLED");
    active.abort();
    await cancelled;
    expect(client.authority.invalidated.aborted).toBe(true);
  });

  it("refuses concurrent renewals and makes stale response IDs terminal", async () => {
    const f = await fixture((req, socket) => { if (req.op === "register") success(req, socket); });
    const client = await connectComputerNative(f.path, "s", new AbortController().signal);
    const first = client.authority.renew(new AbortController().signal);
    const rejected = expect(first).rejects.toThrow("NATIVE_PROTOCOL_ERROR");
    await expect(client.authority.renew(new AbortController().signal)).rejects.toThrow("NATIVE_CHANNEL_BUSY");
    await until(() => f.requests.length === 2);
    for (const socket of f.peers) success(f.requests[0], socket);
    await rejected;
    expect(client.authority.invalidated.aborted).toBe(true);
  });
});
