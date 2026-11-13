import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./hosts", () => ({
  askHost: vi.fn(async (_h: string, fn: string, args: unknown[]) => (fn === "far.upload" ? `/there/${String(args[0])}` : { fn, args })),
  tellHost: vi.fn(),
  onPeerKind: vi.fn(),
}));
vi.mock("../lib/native", async (orig) => {
  const real = await orig<typeof import("../lib/native")>();
  return {
    ...real,
    fsFiles: vi.fn(async () => ["here"]),
    gitChanges: vi.fn(async () => ({ isRepo: true, branch: null, files: [], patch: "" })),
    revealPath: vi.fn(async () => {}),
    farStat: vi.fn(async (p: string) => (p.endsWith("/dir") ? { size: 0, modified: 1, dir: true } : { size: 700_000, modified: 1, dir: false })),
    // 700 000 bytes: a 512 KB piece, then the rest
    farPiece: vi.fn(async (_p: string, off: number) => ({ data: btoa("\0".repeat(Math.min(512 << 10, 700_000 - off))), size: 700_000, modified: 1 })),
  };
});

import { askHost, tellHost } from "./hosts";
import { farPiece, fsFiles, gitChanges, revealPath } from "../lib/native";
import { changesIn, farError, farTerm, listFiles, onMac, revealOn, sendFiles, srcOf } from "./far";
import { refreshEngine } from "./rpc";

beforeAll(async () => {
  // outside the app: home /Users/me
  await refreshEngine();
});
beforeEach(() => vi.clearAllMocks());

describe("where a thing is done", () => {
  it("here when it is this Mac's, as before", async () => {
    expect(await listFiles(undefined, "/Users/me/work/app")).toEqual(["here"]);
    expect(fsFiles).toHaveBeenCalledWith("/Users/me/work/app");
    await changesIn(undefined, "/Users/me/work/app", "main");
    expect(gitChanges).toHaveBeenCalledWith("/Users/me/work/app", "main");
    await revealOn(undefined, "/Users/me/x");
    expect(revealPath).toHaveBeenCalledWith("/Users/me/x");
    expect(askHost).not.toHaveBeenCalled();
  });

  it("on that Mac when it is another Mac's, with this Mac's home said as ~", async () => {
    await listFiles("H", "/Users/me/work/app");
    expect(askHost).toHaveBeenCalledWith("H", "far.files", ["~/work/app"]);
    await changesIn("H", "/Users/other/app", undefined, true);
    expect(askHost).toHaveBeenCalledWith("H", "far.changes", ["/Users/other/app", null, true]);
    await revealOn("H", "~/x");
    expect(askHost).toHaveBeenCalledWith("H", "far.reveal", ["~/x"]);
    expect(fsFiles).not.toHaveBeenCalled();
    expect(revealPath).not.toHaveBeenCalled();
  });

  it("takes any call the same way", async () => {
    const here = vi.fn(async () => "local");
    expect(await onMac(undefined, "far.pr", ["t1"], here)).toBe("local");
    expect(await onMac("H", "far.pr", ["t1"], here)).toEqual({ fn: "far.pr", args: ["t1"] });
    expect(here).toHaveBeenCalledTimes(1);
  });

  it("shows this Mac's files as they are", () => {
    expect(srcOf("/Users/me/a.png", undefined)).toBe("/Users/me/a.png");
  });
});

describe("attachments for another Mac", () => {
  it("go there in pieces, and the message carries that Mac's paths", async () => {
    const out = await sendFiles("H", ["/Users/me/Desktop/shot.png"]);
    const ups = vi.mocked(askHost).mock.calls.filter((c) => c[1] === "far.upload");
    expect(ups.map((c) => (c[2] as unknown[])[1])).toEqual([0, 512 << 10]);
    expect(vi.mocked(farPiece)).toHaveBeenCalledTimes(2);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\/there\/[0-9a-z]+-[0-9a-z]+-shot\.png$/);
  });
  it("can't be folders", async () => {
    await expect(sendFiles("H", ["/Users/me/dir"])).rejects.toThrow();
    expect(askHost).not.toHaveBeenCalled();
  });
});

describe("a terminal on another Mac", () => {
  it("sends keys in small batches without waiting for an answer", async () => {
    vi.useFakeTimers();
    const io = farTerm("H", "t1", "term1");
    io.write("l");
    io.write("s\r");
    expect(tellHost).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(tellHost).toHaveBeenCalledWith("H", { t: "pty-in", id: "term1", data: "ls\r" });
    io.resize(100, 30);
    io.resize(120, 40);
    vi.advanceTimersByTime(200);
    expect(vi.mocked(tellHost).mock.calls.filter((c) => (c[1] as { t: string }).t === "pty-size")).toEqual([["H", { t: "pty-size", id: "term1", cols: 120, rows: 40 }]]);
    vi.useRealTimers();
  });
});

describe("errors from another Mac", () => {
  it("say to update an older Ondra there", () => {
    expect(farError(new Error("unknown: far.files"))).toBe("그 Mac의 Ondra를 업데이트해야 볼 수 있어요");
    expect(farError(new Error("그 Mac에서 열 수 없는 위치예요"))).toBe("그 Mac에서 열 수 없는 위치예요");
  });
});
