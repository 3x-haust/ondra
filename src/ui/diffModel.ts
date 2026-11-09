// What a job changed, shaped for showing: a unified patch parsed into files →
// hunks → lines (the panel's cards), and the changes editor's pieces: the source
// control tree (or list), the editor tabs, the unchanged stretches it hides, and
// the changes stepped through, as VS Code does them.
import type { GitFile } from "../lib/native";

export type Status = "A" | "M" | "D" | "R";
export type Line = { kind: "ctx" | "add" | "del"; old?: number; new?: number; text: string };
export type Hunk = { head: string; where: string; lines: Line[] };
/** `old`: the path before a rename */
export type DiffFile = { path: string; old?: string; status: Status; binary: boolean; add: number; del: number; hunks: Hunk[] };

export function parsePatch(patch: string): DiffFile[] {
  const out: DiffFile[] = [];
  for (const sec of patch.split(/^(?=diff --git )/m)) {
    if (!sec.startsWith("diff --git")) continue;
    const rows = sec.split("\n");
    const m = rows[0].match(/^diff --git a\/(.*) b\/(.*)$/);
    const f: DiffFile = { path: m?.[2] ?? rows[0], status: "M", binary: false, add: 0, del: 0, hunks: [] };
    let h: Hunk | null = null;
    let o = 0;
    let n = 0;
    for (const r of rows.slice(1)) {
      if (!h) {
        if (r.startsWith("new file")) f.status = "A";
        else if (r.startsWith("deleted file")) f.status = "D";
        else if (r.startsWith("rename from ")) (f.status = "R"), (f.old = r.slice(12));
        else if (r.startsWith("rename to ")) f.path = r.slice(10);
        else if (r.startsWith("Binary files") || r === "GIT binary patch") f.binary = true;
      }
      const hh = r.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/);
      if (hh) {
        o = +hh[1];
        n = +hh[2];
        h = { head: r, where: hh[3].trim(), lines: [] };
        f.hunks.push(h);
        continue;
      }
      if (!h || r.startsWith("\\")) continue;
      if (r.startsWith("+")) {
        h.lines.push({ kind: "add", new: n++, text: r.slice(1) });
        f.add++;
      } else if (r.startsWith("-")) {
        h.lines.push({ kind: "del", old: o++, text: r.slice(1) });
        f.del++;
      } else if (r.startsWith(" ") || r === "") {
        if (r === "" && h.lines.length && rows[rows.length - 1] === r) continue;
        h.lines.push({ kind: "ctx", old: o++, new: n++, text: r.slice(1) });
      }
    }
    out.push(f);
  }
  return out;
}

/** a changed file's letter, as VS Code's source control shows it: U is untracked (new, not yet added) */
export type FileStatus = Status | "U";
/** git's status letters as the list shows them: untracked is U, a copy is a new file, a type change is M */
export function statusLetter(s: string): FileStatus {
  const c = s.trim().charAt(0).toUpperCase();
  return c === "?" ? "U" : c === "A" || c === "C" ? "A" : c === "D" ? "D" : c === "R" ? "R" : "M";
}

export interface ChangedFile {
  path: string;
  /** before a rename */
  old?: string;
  status: FileStatus;
  add: number;
  del: number;
  binary: boolean;
}

/** git's file list, with what only the patch knows (a rename's old path, binary files). The list
 *  comes first: the patch is capped and can miss files; a file only in the patch still counts. */
export function changedFiles(files: GitFile[], patch: string): ChangedFile[] {
  const parsed = new Map(parsePatch(patch).map((f) => [f.path, f]));
  const out = new Map<string, ChangedFile>();
  for (const g of files) {
    const p = parsed.get(g.path);
    const status = statusLetter(g.status);
    out.set(g.path, { path: g.path, old: status === "R" ? p?.old : undefined, status, add: g.add, del: g.del, binary: !!p?.binary });
  }
  for (const p of parsed.values()) if (!out.has(p.path)) out.set(p.path, { path: p.path, old: p.old, status: p.status, add: p.add, del: p.del, binary: p.binary });
  return [...out.values()];
}

export const splitPath = (p: string): [string, string] => {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i), p.slice(i + 1)];
};

const byName = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

// ───────────── the source control view: a tree (folders, compacted) or a flat list

export type TreeNode =
  | { kind: "dir"; path: string; name: string; children: TreeNode[] }
  | { kind: "file"; path: string; name: string; file: ChangedFile };

/**
 * The files as folders and files, folders first, each by name. `compact` joins a folder whose only
 * child is a folder into one row ("src/auth"), as VS Code's compact folders do.
 */
export function buildTree(files: ChangedFile[], compact = true): TreeNode[] {
  interface Dir { dirs: Map<string, Dir>; files: ChangedFile[] }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    let d = root;
    for (const part of f.path.split("/").slice(0, -1)) {
      if (!d.dirs.has(part)) d.dirs.set(part, { dirs: new Map(), files: [] });
      d = d.dirs.get(part)!;
    }
    d.files.push(f);
  }
  const walk = (d: Dir, base: string): TreeNode[] => [
    ...[...d.dirs].sort(([a], [b]) => byName(a, b)).map(([name, sub]): TreeNode => {
      let path = base ? `${base}/${name}` : name;
      let label = name;
      while (compact && !sub.files.length && sub.dirs.size === 1) {
        const [[next, deeper]] = [...sub.dirs];
        path += `/${next}`;
        label += `/${next}`;
        sub = deeper;
      }
      return { kind: "dir", path, name: label, children: walk(sub, path) };
    }),
    ...[...d.files].sort((a, b) => byName(splitPath(a.path)[1], splitPath(b.path)[1])).map((f): TreeNode => ({ kind: "file", path: f.path, name: splitPath(f.path)[1], file: f })),
  ];
  return walk(root, "");
}

/** one row of the view: a folder (open or not) or a file, at its depth; in the list, a file and its folder */
export interface Row {
  key: string;
  kind: "dir" | "file";
  depth: number;
  name: string;
  file?: ChangedFile;
  open?: boolean;
  /** the folder row it sits in (← goes there) */
  parent?: string;
  /** list mode: the folder, dimmed after the name */
  dir?: string;
}

/** The tree's rows as shown: a closed folder (its key, "src/") hides what is in it. Names sort as VS Code's do, case aside. */
export function treeRows(nodes: TreeNode[], closed: ReadonlySet<string>, depth = 0, parent?: string): Row[] {
  const out: Row[] = [];
  for (const n of nodes) {
    if (n.kind === "file") out.push({ key: n.path, kind: "file", depth, name: n.name, file: n.file, parent });
    else {
      const key = `${n.path}/`;
      const open = !closed.has(key);
      out.push({ key, kind: "dir", depth, name: n.name, open, parent });
      if (open) out.push(...treeRows(n.children, closed, depth + 1, key));
    }
  }
  return out;
}

/** The list: every file by its path, the name first and its folder after it. */
export function listRows(files: ChangedFile[], depth = 0, parent?: string): Row[] {
  return [...files]
    .sort((a, b) => byName(a.path, b.path))
    .map((f) => ({ key: f.path, kind: "file" as const, depth, name: splitPath(f.path)[1], dir: splitPath(f.path)[0], file: f, parent }));
}

/** the files in the order the view lists them, folded folders included (next and previous file) */
export function fileOrder(files: ChangedFile[], mode: "tree" | "list"): ChangedFile[] {
  return (mode === "tree" ? treeRows(buildTree(files), new Set()) : listRows(files)).flatMap((r) => (r.file ? [r.file] : []));
}

/** every folder in the tree (collapse all) */
export function folderKeys(nodes: TreeNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "dir" ? [`${n.path}/`, ...folderKeys(n.children)] : []));
}

/** the folders a file sits in, so revealing it opens them */
export function foldersOf(nodes: TreeNode[], path: string): string[] {
  for (const n of nodes) {
    if (n.kind !== "dir" || !path.startsWith(`${n.path}/`)) continue;
    return [`${n.path}/`, ...foldersOf(n.children, path)];
  }
  return [];
}

// ───────────── the editor's tabs: a preview tab is replaced by the next one, a pinned one stays

export interface Tab {
  /** "diff": the change; "file": the file as it is now */
  kind: "diff" | "file";
  path: string;
  pinned: boolean;
}
export const tabKey = (t: Pick<Tab, "kind" | "path">) => `${t.kind}:${t.path}`;

/**
 * Open a tab as VS Code does: one already open is shown (and pinned when asked); a new preview tab takes
 * the place of the current preview, otherwise it goes after the active tab.
 */
export function openTab(tabs: Tab[], active: string | undefined, next: Omit<Tab, "pinned">, pin = false): { tabs: Tab[]; active: string } {
  const key = tabKey(next);
  const at = tabs.findIndex((t) => tabKey(t) === key);
  if (at >= 0) return { tabs: pin && !tabs[at].pinned ? tabs.map((t, i) => (i === at ? { ...t, pinned: true } : t)) : tabs, active: key };
  const tab: Tab = { ...next, pinned: pin };
  const preview = tabs.findIndex((t) => !t.pinned);
  if (preview >= 0) return { tabs: tabs.map((t, i) => (i === preview ? tab : t)), active: key };
  const i = tabs.findIndex((t) => tabKey(t) === active);
  return { tabs: [...tabs.slice(0, i + 1), tab, ...tabs.slice(i + 1)], active: key };
}

/** keep a tab open (double click, an edit in VS Code): it is no longer the preview */
export const pinTab = (tabs: Tab[], key: string): Tab[] => tabs.map((t) => (tabKey(t) === key ? { ...t, pinned: true } : t));

/** Close a tab; closing the active one shows the tab after it, or the one before at the end. */
export function closeTab(tabs: Tab[], active: string | undefined, key: string): { tabs: Tab[]; active: string | undefined } {
  const i = tabs.findIndex((t) => tabKey(t) === key);
  if (i < 0) return { tabs, active };
  const rest = tabs.filter((_, j) => j !== i);
  if (active !== key) return { tabs: rest, active };
  const next = rest[Math.min(i, rest.length - 1)];
  return { tabs: rest, active: next && tabKey(next) };
}

/** the tab `dir` away from the active one, round the ends (⌃Tab, ⌃⇧Tab) */
export function cycleTab(tabs: Tab[], active: string | undefined, dir: 1 | -1): string | undefined {
  if (!tabs.length) return undefined;
  const i = tabs.findIndex((t) => tabKey(t) === active);
  return tabKey(tabs[(Math.max(i, 0) + (i < 0 ? 0 : dir) + tabs.length) % tabs.length]);
}

/** the file `dir` steps away from `path` in the list's order; none past either end */
export function stepFile(order: ChangedFile[], path: string | undefined, dir: 1 | -1): ChangedFile | undefined {
  const i = order.findIndex((f) => f.path === path);
  if (i < 0) return order[dir > 0 ? 0 : order.length - 1];
  return order[i + dir];
}

/** the most lines one side shows: past it the editor slows down and the rest isn't read */
export const MAX_LINES = 20_000;

/** A side's text, cut after `max` lines; `cut` says it was (or was already cut when read). */
export function capText(text: string, max = MAX_LINES, alreadyCut = false): { text: string; cut: boolean } {
  let at = -1;
  for (let i = 0; i < max; i++) {
    at = text.indexOf("\n", at + 1);
    if (at < 0) return { text, cut: alreadyCut };
  }
  // exactly `max` lines with a final newline is the whole file
  return at === text.length - 1 ? { text, cut: alreadyCut } : { text: text.slice(0, at + 1), cut: true };
}

/**
 * The change to go to from the cursor, as F7 / ⇧F7 do: `starts` are the changes' first lines in
 * order, `line` the cursor's, `current` the change last gone to (when the cursor is still on it).
 * Null past the last (or before the first): the next or previous file is next.
 */
export function stepChange(starts: number[], line: number, dir: 1 | -1, current?: number): number | null {
  if (!starts.length) return null;
  if (current !== undefined && current >= 0 && current < starts.length) {
    const to = current + dir;
    return to >= 0 && to < starts.length ? to : null;
  }
  if (dir > 0) {
    const i = starts.findIndex((s) => s > line);
    return i < 0 ? null : i;
  }
  for (let i = starts.length - 1; i >= 0; i--) if (starts[i] < line) return i;
  return null;
}

/** how a changed line shows in the applied file's gutter: added, changed, or lines removed just above it */
export type Mark = "add" | "mod" | "del";
/**
 * The applied file's gutter from the changed ranges (line numbers on each side, `to` past the last
 * line, so a range with from === to is empty there): lines only in the new file are added, lines that
 * replace old ones are changed, and a removal marks the line after it (the last line at the end).
 */
export function resultMarks(chunks: { fromA: number; toA: number; fromB: number; toB: number }[], lines: number): Map<number, Mark> {
  const out = new Map<number, Mark>();
  for (const c of chunks) {
    if (c.toB > c.fromB) for (let l = c.fromB; l < c.toB; l++) out.set(l, c.toA > c.fromA ? "mod" : "add");
    else if (c.toA > c.fromA) {
      const at = Math.min(Math.max(c.fromB, 1), Math.max(lines, 1));
      if (!out.has(at)) out.set(at, "del");
    }
  }
  return out;
}

/**
 * F7 / ⇧F7 across the files: the change to go to in this file, or else the next (or previous) file with a
 * change to open, at its first (or last) change. `step` is stepChange's answer in this file.
 */
export function stepAcross(order: ChangedFile[], path: string | undefined, step: number | null, dir: 1 | -1): { change: number } | { file: ChangedFile; at: "first" | "last" } | null {
  if (step !== null) return { change: step };
  const next = stepFile(order, path, dir);
  return next ? { file: next, at: dir > 0 ? "first" : "last" } : null;
}

// ───────────── the unchanged stretches the diff hides ("n hidden lines")

/** VS Code's defaults: 3 lines kept around a change, at least 3 to hide, 20 more on each reveal */
export const HIDE = { context: 3, min: 3, reveal: 20 };

/**
 * An unchanged stretch: its first line on each side, how long it is, and how many of its lines show at
 * the top and the bottom (the rest is hidden).
 */
export interface Region {
  a: number;
  b: number;
  len: number;
  top: number;
  bottom: number;
}

/**
 * The stretches between the changes (line numbers on each side, `to` past the last line), each hidden
 * but for `context` lines next to a change; one with fewer than `min` lines left to hide shows whole.
 */
export function unchangedRegions(chunks: { fromA: number; toA: number; fromB: number; toB: number }[], linesA: number, linesB: number, context = HIDE.context, min = HIDE.min): Region[] {
  const out: Region[] = [];
  let a = 1;
  let b = 1;
  const add = (len: number, first: boolean, last: boolean) => {
    if (len <= 0) return;
    const top = first ? 0 : Math.min(context, len);
    const bottom = last ? 0 : Math.min(context, len - top);
    const hidden = len - top - bottom;
    out.push(hidden >= min ? { a, b, len, top, bottom } : { a, b, len, top: len, bottom: 0 });
  };
  for (const c of chunks) {
    add(Math.min(c.fromA - a, c.fromB - b), out.length === 0 && a === 1, false);
    a = c.toA;
    b = c.toB;
  }
  add(Math.min(linesA - a + 1, linesB - b + 1), a === 1 && b === 1, true);
  return out;
}

/** the hidden lines of a stretch: the first (offset into it) and how many, or null when all of it shows */
export function hiddenPart(r: Region): { from: number; count: number } | null {
  const count = r.len - r.top - r.bottom;
  return count > 0 ? { from: r.top, count } : null;
}

/** more of a stretch: `n` lines at its top (above) or bottom (below), or all of it */
export function revealRegion(r: Region, where: "above" | "below" | "all", n = HIDE.reveal): Region {
  const hidden = r.len - r.top - r.bottom;
  if (where === "all" || hidden <= n) return { ...r, top: r.len - r.bottom };
  return where === "above" ? { ...r, top: r.top + n } : { ...r, bottom: r.bottom + n };
}
