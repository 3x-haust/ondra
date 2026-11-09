import { describe, expect, it } from "vitest";
import {
  buildTree, capText, changedFiles, closeTab, cycleTab, fileOrder, folderKeys, foldersOf, hiddenPart, listRows, openTab, parsePatch, pinTab, resultMarks, revealRegion,
  statusLetter, stepAcross, stepChange, stepFile, tabKey, treeRows, unchangedRegions, type ChangedFile, type Tab,
} from "./diffModel";

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
  it.each([["M", "M"], [" M", "M"], ["A", "A"], ["?", "U"], ["??", "U"], ["D", "D"], ["R", "R"], ["R100", "R"], ["C", "A"], ["T", "M"], ["", "M"]])("%j is %s", (git, shown) => {
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
      ["U", "notes/new.md", undefined, false],
      // in the patch but not the list (a list that was cut short)
      ["D", "old.txt", undefined, false],
      ["M", "README.md", undefined, false],
    ]);
  });
});

describe("the source control tree", () => {
  const files = [file("src/b.ts"), file("README.md"), file("src/a.ts"), file("docs/x/setup.md", "A"), file("src/auth/deep/guard.ts"), file("package.json")];
  const shape = (rows: ReturnType<typeof treeRows>) => rows.map((r) => `${"  ".repeat(r.depth)}${r.kind === "dir" ? (r.open ? "v " : "> ") : ""}${r.name}`);
  it("puts folders first, then files, each by name, and compacts a folder with one folder in it", () => {
    expect(shape(treeRows(buildTree(files), new Set()))).toEqual([
      "v docs/x",
      "  setup.md",
      "v src",
      "  v auth/deep",
      "    guard.ts",
      "  a.ts",
      "  b.ts",
      "package.json",
      "README.md",
    ]);
  });
  it("can keep every folder as its own row", () => {
    expect(shape(treeRows(buildTree([file("a/b/c.ts")], false), new Set()))).toEqual(["v a", "  v b", "    c.ts"]);
  });
  it("hides what a closed folder holds and knows each row's folder", () => {
    const rows = treeRows(buildTree(files), new Set(["src/"]));
    expect(shape(rows)).toEqual(["v docs/x", "  setup.md", "> src", "package.json", "README.md"]);
    expect(rows[1].parent).toBe("docs/x/");
    expect(rows[3].parent).toBeUndefined();
  });
  it("lists every folder, and the ones a file is in", () => {
    const tree = buildTree(files);
    expect(folderKeys(tree)).toEqual(["docs/x/", "src/", "src/auth/deep/"]);
    expect(foldersOf(tree, "src/auth/deep/guard.ts")).toEqual(["src/", "src/auth/deep/"]);
    expect(foldersOf(tree, "README.md")).toEqual([]);
  });
  it("as a list: by path, the name first and its folder after", () => {
    expect(listRows(files).map((r) => [r.name, r.dir])).toEqual([
      ["setup.md", "docs/x"],
      ["package.json", ""],
      ["README.md", ""],
      ["a.ts", "src"],
      ["guard.ts", "src/auth/deep"],
      ["b.ts", "src"],
    ]);
  });
  it("orders the files as the tree or the list shows them", () => {
    expect(fileOrder(files, "tree").map((f) => f.path)).toEqual(["docs/x/setup.md", "src/auth/deep/guard.ts", "src/a.ts", "src/b.ts", "package.json", "README.md"]);
    expect(fileOrder(files, "list").map((f) => f.path)).toEqual(["docs/x/setup.md", "package.json", "README.md", "src/a.ts", "src/auth/deep/guard.ts", "src/b.ts"]);
  });
  it("steps to the next and previous file, none past the ends", () => {
    const order = fileOrder(files, "tree");
    expect(stepFile(order, "src/b.ts", 1)?.path).toBe("package.json");
    expect(stepFile(order, "docs/x/setup.md", -1)).toBeUndefined();
    expect(stepFile(order, "README.md", 1)).toBeUndefined();
    // the shown file is gone from the list: from the first (or the last going back)
    expect(stepFile(order, "gone.ts", 1)?.path).toBe("docs/x/setup.md");
    expect(stepFile(order, "gone.ts", -1)?.path).toBe("README.md");
  });
});

describe("the editor's tabs", () => {
  const diff = (path: string) => ({ kind: "diff" as const, path });
  const keys = (tabs: Tab[]) => tabs.map((t) => `${t.path}${t.pinned ? "" : "*"}`);
  it("replaces the preview tab with the next file opened", () => {
    let s = openTab([], undefined, diff("a.ts"));
    s = openTab(s.tabs, s.active, diff("b.ts"));
    expect(keys(s.tabs)).toEqual(["b.ts*"]);
    expect(s.active).toBe("diff:b.ts");
  });
  it("keeps a pinned tab and opens the next preview after the active tab", () => {
    let s = openTab([], undefined, diff("a.ts"), true);
    s = openTab(s.tabs, s.active, diff("b.ts"), true);
    s = openTab(s.tabs, "diff:a.ts", diff("c.ts"));
    expect(keys(s.tabs)).toEqual(["a.ts", "c.ts*", "b.ts"]);
    s = openTab(s.tabs, s.active, diff("d.ts"));
    expect(keys(s.tabs)).toEqual(["a.ts", "d.ts*", "b.ts"]);
  });
  it("shows a tab already open, pinning it when asked (a double click)", () => {
    let s = openTab([], undefined, diff("a.ts"));
    s = openTab(s.tabs, s.active, diff("a.ts"), true);
    expect(keys(s.tabs)).toEqual(["a.ts"]);
    expect(keys(pinTab([{ ...diff("x"), pinned: false }], "diff:x"))).toEqual(["x"]);
  });
  it("keeps the change and the file as two tabs", () => {
    let s = openTab([], undefined, diff("a.ts"), true);
    s = openTab(s.tabs, s.active, { kind: "file", path: "a.ts" }, true);
    expect(s.tabs.map(tabKey)).toEqual(["diff:a.ts", "file:a.ts"]);
  });
  it("shows the next tab when the active one closes, the one before at the end", () => {
    const tabs: Tab[] = ["a", "b", "c"].map((p) => ({ ...diff(p), pinned: true }));
    expect(closeTab(tabs, "diff:b", "diff:b").active).toBe("diff:c");
    expect(closeTab(tabs, "diff:c", "diff:c").active).toBe("diff:b");
    expect(closeTab(tabs, "diff:a", "diff:c").active).toBe("diff:a");
    expect(closeTab([tabs[0]], "diff:a", "diff:a")).toEqual({ tabs: [], active: undefined });
  });
  it("cycles round the ends (⌃Tab)", () => {
    const tabs: Tab[] = ["a", "b"].map((p) => ({ ...diff(p), pinned: true }));
    expect(cycleTab(tabs, "diff:b", 1)).toBe("diff:a");
    expect(cycleTab(tabs, "diff:a", -1)).toBe("diff:b");
    expect(cycleTab([], undefined, 1)).toBeUndefined();
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

describe("next and previous change across the files", () => {
  const order = [file("a.ts"), file("b.ts"), file("c.ts")];
  it("stays in the file while it has a change that way", () => {
    expect(stepAcross(order, "b.ts", 2, 1)).toEqual({ change: 2 });
  });
  it("opens the next file at its first change, the previous at its last", () => {
    expect(stepAcross(order, "b.ts", null, 1)).toEqual({ file: order[2], at: "first" });
    expect(stepAcross(order, "b.ts", null, -1)).toEqual({ file: order[0], at: "last" });
  });
  it("stops at the last file's last change and the first file's first", () => {
    expect(stepAcross(order, "c.ts", null, 1)).toBeNull();
    expect(stepAcross(order, "a.ts", null, -1)).toBeNull();
  });
});

describe("the hidden unchanged lines", () => {
  // 100 lines; line 30 changed, 2 lines added after old line 60
  const chunks = [
    { fromA: 30, toA: 31, fromB: 30, toB: 31 },
    { fromA: 61, toA: 61, fromB: 61, toB: 63 },
  ];
  it("hides all but 3 lines next to each change", () => {
    const r = unchangedRegions(chunks, 100, 102);
    expect(r).toEqual([
      { a: 1, b: 1, len: 29, top: 0, bottom: 3 },
      { a: 31, b: 31, len: 30, top: 3, bottom: 3 },
      { a: 61, b: 63, len: 40, top: 3, bottom: 0 },
    ]);
    expect(r.map(hiddenPart)).toEqual([{ from: 0, count: 26 }, { from: 3, count: 24 }, { from: 3, count: 37 }]);
  });
  it("shows a short stretch whole", () => {
    // lines 1-4 (1 left to hide), 6-13 (2 left), 15-23 (3 left: hidden), 25 alone
    const r = unchangedRegions([5, 14, 24].map((l) => ({ fromA: l, toA: l + 1, fromB: l, toB: l + 1 })), 25, 25);
    expect(r.map((x) => [x.a, x.len])).toEqual([[1, 4], [6, 8], [15, 9], [25, 1]]);
    expect(r.map(hiddenPart)).toEqual([null, null, { from: 3, count: 3 }, null]);
  });
  it("hides a file with no change whole", () => {
    expect(unchangedRegions([], 50, 50).map(hiddenPart)).toEqual([{ from: 0, count: 50 }]);
  });
  it("shows 20 more above or below, or all of it", () => {
    const r = unchangedRegions(chunks, 100, 102)[1];
    expect(hiddenPart(revealRegion(r, "above"))).toEqual({ from: 23, count: 4 });
    expect(hiddenPart(revealRegion(r, "below"))).toEqual({ from: 3, count: 4 });
    expect(hiddenPart(revealRegion(revealRegion(r, "above"), "below"))).toBeNull();
    expect(hiddenPart(revealRegion(r, "all"))).toBeNull();
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
