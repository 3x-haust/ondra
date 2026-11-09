import { describe, expect, it } from "vitest";
import { capText, changedFiles, fileOrder, groupFiles, parsePatch, resultMarks, statusLetter, stepChange, stepFile, type ChangedFile } from "./diffModel";

const PATCH = `diff --git a/src/guard.ts b/src/auth/guard.ts
similarity index 90%
rename from src/guard.ts
rename to src/auth/guard.ts
index 1a2b3c4..5d6e7f8 100644
--- a/src/guard.ts
+++ b/src/auth/guard.ts
@@ -1,2 +1,2 @@
-export const a = 1;
+export const a = 2;
 export const b = 1;
diff --git a/public/logo.png b/public/logo.png
index 1111111..2222222 100644
Binary files a/public/logo.png and b/public/logo.png differ
diff --git a/old.txt b/old.txt
deleted file mode 100644
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-x
+y
`;

const file = (path: string, status: ChangedFile["status"] = "M"): ChangedFile => ({ path, status, add: 1, del: 0, binary: false });

describe("parsing a patch", () => {
  it("reads a rename's old and new path, binary files and deletions", () => {
    const [ren, bin, del] = parsePatch(PATCH);
    expect(ren).toMatchObject({ path: "src/auth/guard.ts", old: "src/guard.ts", status: "R", add: 1, del: 1 });
    expect(bin).toMatchObject({ path: "public/logo.png", binary: true, hunks: [] });
    expect(del).toMatchObject({ path: "old.txt", status: "D", del: 1 });
  });
});

describe("status letters", () => {
  it.each([["M", "M"], [" M", "M"], ["A", "A"], ["?", "A"], ["??", "A"], ["D", "D"], ["R", "R"], ["R100", "R"], ["C", "A"], ["T", "M"], ["", "M"]])("%j is %s", (git, shown) => {
    expect(statusLetter(git)).toBe(shown);
  });
});

describe("the changed files", () => {
  it("takes git's list and adds what only the patch knows", () => {
    const files = changedFiles(
      [
        { path: "src/auth/guard.ts", status: "R", add: 1, del: 1 },
        { path: "public/logo.png", status: "M", add: 0, del: 0 },
        { path: "notes/new.md", status: "?", add: 3, del: 0 },
      ],
      PATCH,
    );
    expect(files.map((f) => [f.status, f.path, f.old, f.binary])).toEqual([
      ["R", "src/auth/guard.ts", "src/guard.ts", false],
      ["M", "public/logo.png", undefined, true],
      ["A", "notes/new.md", undefined, false],
      // in the patch but not the list (a list that was cut short)
      ["D", "old.txt", undefined, false],
      ["M", "README.md", undefined, false],
    ]);
  });
});

describe("grouping by folder", () => {
  const files = [file("src/b.ts"), file("README.md"), file("src/a.ts"), file("docs/x/setup.md", "A"), file("package.json")];
  it("puts the top first, then folders in order, files by name", () => {
    const g = groupFiles(files);
    expect(g.map((x) => [x.dir, x.files.map((f) => f.path)])).toEqual([
      ["", ["README.md", "package.json"]],
      ["docs/x", ["docs/x/setup.md"]],
      ["src", ["src/a.ts", "src/b.ts"]],
    ]);
    expect(fileOrder(g).map((f) => f.path)).toEqual(["README.md", "package.json", "docs/x/setup.md", "src/a.ts", "src/b.ts"]);
  });
  it("filters by path, ignoring case, and by a rename's old path", () => {
    expect(fileOrder(groupFiles(files, " SRC/")).map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(groupFiles([{ ...file("src/auth/guard.ts", "R"), old: "src/legacy.ts" }], "legacy")).toHaveLength(1);
    expect(groupFiles(files, "nothing")).toEqual([]);
  });
  it("steps to the next and previous file, none past the ends", () => {
    const order = fileOrder(groupFiles(files));
    expect(stepFile(order, "package.json", 1)?.path).toBe("docs/x/setup.md");
    expect(stepFile(order, "README.md", -1)).toBeUndefined();
    expect(stepFile(order, "src/b.ts", 1)).toBeUndefined();
    // the shown file was filtered out: from the first (or the last going back)
    expect(stepFile(order, "gone.ts", 1)?.path).toBe("README.md");
    expect(stepFile(order, "gone.ts", -1)?.path).toBe("src/b.ts");
  });
});

describe("the size cap", () => {
  it("keeps a short file whole", () => {
    expect(capText("a\nb\n", 3)).toEqual({ text: "a\nb\n", cut: false });
    expect(capText("a\nb\nc\n", 3)).toEqual({ text: "a\nb\nc\n", cut: false });
    expect(capText("a\nb\nc", 3)).toEqual({ text: "a\nb\nc", cut: false });
  });
  it("cuts after the last line it keeps", () => {
    expect(capText("a\nb\nc\nd\n", 2)).toEqual({ text: "a\nb\n", cut: true });
    expect(capText("1\n".repeat(30_000)).text.split("\n")).toHaveLength(20_001);
  });
  it("says so when the file was already cut when read", () => {
    expect(capText("a\n", 5, true)).toEqual({ text: "a\n", cut: true });
  });
});

describe("next and previous change (F7 / ⇧F7)", () => {
  const starts = [3, 10, 40];
  it("goes from the cursor when no change was gone to", () => {
    expect(stepChange(starts, 1, 1)).toBe(0);
    expect(stepChange(starts, 3, 1)).toBe(1);
    expect(stepChange(starts, 20, 1)).toBe(2);
    expect(stepChange(starts, 20, -1)).toBe(1);
    expect(stepChange(starts, 3, -1)).toBeNull();
  });
  it("goes on from the change it is on", () => {
    expect(stepChange(starts, 1, 1, 0)).toBe(1);
    expect(stepChange(starts, 1, -1, 1)).toBe(0);
  });
  it("is at an edge past the last or before the first (the next file is next)", () => {
    expect(stepChange(starts, 50, 1)).toBeNull();
    expect(stepChange(starts, 1, 1, 2)).toBeNull();
    expect(stepChange(starts, 1, -1, 0)).toBeNull();
    expect(stepChange([], 1, 1)).toBeNull();
  });
});

describe("the applied file's gutter", () => {
  it("marks added, changed and removed lines", () => {
    const m = resultMarks(
      [
        { fromA: 2, toA: 2, fromB: 2, toB: 4 }, // two lines added before old line 2
        { fromA: 5, toA: 6, fromB: 7, toB: 8 }, // one line changed
        { fromA: 9, toA: 11, fromB: 11, toB: 11 }, // two lines removed before new line 11
        { fromA: 20, toA: 21, fromB: 30, toB: 30 }, // the last line removed: marks the end
      ],
      29,
    );
    expect([...m]).toEqual([[2, "add"], [3, "add"], [7, "mod"], [11, "del"], [29, "del"]]);
  });
});
