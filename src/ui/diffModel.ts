// What a job changed, shaped for showing: a unified patch parsed into files →
// hunks → lines (the panel's cards), and the changes editor's file list, grouped
// by folder, with each side's text capped and the changes stepped through.
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

/** git's status letters as the list shows them: new and untracked are A, a copy is a new file, a type change is M */
export function statusLetter(s: string): Status {
  const c = s.trim().charAt(0).toUpperCase();
  return c === "A" || c === "?" || c === "C" ? "A" : c === "D" ? "D" : c === "R" ? "R" : "M";
}

export interface ChangedFile {
  path: string;
  /** before a rename */
  old?: string;
  status: Status;
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

export interface Group {
  /** the folder, "" for the top */
  dir: string;
  files: ChangedFile[];
}

/** Files by folder (the top first, then folders in order), each folder's files by name; `query` keeps
 *  the files whose path (or old path) has it, case aside. */
export function groupFiles(files: ChangedFile[], query = ""): Group[] {
  const q = query.trim().toLowerCase();
  const by = new Map<string, ChangedFile[]>();
  for (const f of files) {
    if (q && !f.path.toLowerCase().includes(q) && !f.old?.toLowerCase().includes(q)) continue;
    const dir = splitPath(f.path)[0];
    by.set(dir, [...(by.get(dir) ?? []), f]);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...by]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : cmp(a, b)))
    .map(([dir, list]) => ({ dir, files: list.sort((a, b) => cmp(splitPath(a.path)[1], splitPath(b.path)[1])) }));
}

/** the files in the order the list shows them (↑↓, next and previous file) */
export const fileOrder = (groups: Group[]) => groups.flatMap((g) => g.files);

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
