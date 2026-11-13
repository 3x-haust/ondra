import { describe, expect, it } from "vitest";
import { allowedPath, asHostPath, cacheName, capText, cleanRoots, mentions, normPath, repoPath, tooWide, under, uploadName } from "./farPaths";

const HOME = "/Users/me";

describe("paths another Mac asks for", () => {
  it("are made absolute and plain", () => {
    expect(normPath("~/work/app", HOME)).toBe("/Users/me/work/app");
    expect(normPath("~", HOME)).toBe("/Users/me");
    expect(normPath("/a/./b//c/../d/", HOME)).toBe("/a/b/d");
    expect(normPath("file:///Users/me/a%20b.png", HOME)).toBe("/Users/me/a b.png");
  });
  it("are refused when they aren't absolute or climb above the disk", () => {
    expect(normPath("work/app", HOME)).toBeUndefined();
    expect(normPath("/../etc", HOME)).toBeUndefined();
    expect(normPath("/a\0b", HOME)).toBeUndefined();
    expect(normPath("", HOME)).toBeUndefined();
  });
  it("count as inside a folder only when they are", () => {
    expect(under("/a/b", "/a/b")).toBe(true);
    expect(under("/a/b/c", "/a/b")).toBe(true);
    expect(under("/a/bc", "/a/b")).toBe(false);
  });
});

describe("folders another Mac may reach", () => {
  it("never include the disk, /Users or the home folder and above", () => {
    for (const r of ["/", "/Users", "/Volumes", "/tmp", HOME]) expect(tooWide(r, HOME)).toBe(true);
    expect(tooWide("/Users/me/work/app", HOME)).toBe(false);
    expect(tooWide("/tmp/ondra-scratch/t1", HOME)).toBe(false);
  });
  it("are cleaned: wide ones dropped, each once", () => {
    expect(cleanRoots(["~/work/app", "/Users/me/work/app/", "~", undefined, "/", "relative"], HOME)).toEqual(["/Users/me/work/app"]);
  });
  it("let in what is inside them, and a file a job named, nothing else", () => {
    const roots = ["/Users/me/work/app"];
    expect(allowedPath("~/work/app/src/a.ts", roots, HOME)).toBe("/Users/me/work/app/src/a.ts");
    expect(allowedPath("~/work/app/../secret/key", roots, HOME)).toBeUndefined();
    expect(allowedPath("~/work/apple/x", roots, HOME)).toBeUndefined();
    expect(allowedPath("/etc/passwd", roots, HOME)).toBeUndefined();
    expect(allowedPath("~/.ssh/id_ed25519", roots, HOME)).toBeUndefined();
    const named = (p: string) => p === "/tmp/shot.png";
    expect(allowedPath("/tmp/shot.png", roots, HOME, named)).toBe("/tmp/shot.png");
    expect(allowedPath("/tmp/other.png", roots, HOME, named)).toBeUndefined();
  });
  it("count a file a job named only when it named that whole path", () => {
    expect(mentions("saved to /tmp/a.png.", "/tmp/a.png")).toBe(true);
    expect(mentions("![shot](/tmp/a.png)", "/tmp/a.png")).toBe(true);
    expect(mentions("`/src/a.ts:12`", "/src/a.ts")).toBe(true);
    expect(mentions("/tmp/a.png.bak", "/tmp/a.png")).toBe(false);
    expect(mentions("/tmp/a.png2", "/tmp/a.png")).toBe(false);
    expect(mentions("x/tmp/a.png", "/tmp/a.png")).toBe(false);
  });
  it("take repo paths only as relative paths that stay inside", () => {
    expect(repoPath("src/a.ts")).toBe("src/a.ts");
    expect(repoPath("../a.ts")).toBeUndefined();
    expect(repoPath("src/../../a.ts")).toBeUndefined();
    expect(repoPath("/etc/passwd")).toBeUndefined();
  });
});

describe("paths sent to another Mac", () => {
  it("say ~ for this Mac's home, so that Mac reads its own", () => {
    expect(asHostPath("/Users/me/work/app", HOME)).toBe("~/work/app");
    expect(asHostPath("/Users/me", HOME)).toBe("~");
    expect(asHostPath("/Users/meg/x", HOME)).toBe("/Users/meg/x");
    expect(asHostPath("/Users/other/x", HOME)).toBe("/Users/other/x");
    expect(asHostPath("~/x", HOME)).toBe("~/x");
  });
});

describe("cached and sent files", () => {
  it("are named by Mac, path and version, keeping the extension", () => {
    const a = cacheName("h1", "/x/shot.png", 10);
    expect(a).toMatch(/^[0-9a-z]+-a\.png$/);
    expect(cacheName("h1", "/x/shot.png", 11)).not.toBe(a);
    expect(cacheName("h2", "/x/shot.png", 10)).not.toBe(a);
    expect(cacheName("h1", "/x/noext", 1)).toMatch(/\.bin$/);
  });
  it("keep a readable, safe name when sent", () => {
    expect(uploadName("/Users/me/Desktop/My Shot (1).png", 36, "abc")).toBe("10-abc-My_Shot_1_.png");
    expect(uploadName("/x/..hidden", 1, "r")).toBe("1-r-hidden");
  });
});

describe("text sent in one answer", () => {
  it("is cut at a line end when too long, and says so", () => {
    expect(capText("abc", 10)).toEqual({ text: "abc", cut: false });
    expect(capText("one\ntwo\nthree", 9)).toEqual({ text: "one\ntwo\n", cut: true });
    // a character is never split
    const r = capText("가나다라", 7);
    expect(r.cut).toBe(true);
    expect(r.text).toBe("가나");
  });
});
