// What a job's reverse engineering has found so far, read from the trace that
// `ondra-binary` appends to the job's artifacts folder (.reverse/trace.jsonl):
// one line when an operation starts, one when it finishes or fails. The 리버싱
// view draws from this; nothing here is guessed or sampled.

import type { Task } from "../state/types";

/** Whether a job (or one of its subagents) has used the bundled analyzer. */
export function usesReverse(t: Task, all: Task[]): boolean {
  const used = (x: Task) => x.entries.some((e) => e.kind === "tool" && /\bondra-binary\b/.test(`${e.tool.target} ${e.tool.detail ?? ""}`));
  return used(t) || all.some((k) => k.parentId === t.id && used(k));
}

export interface RFn {
  name: string;
  addr: number;
  size: number;
}
/** an instruction: address, bytes, text, kind (call, cjmp, jmp, ret…), jump target, fall-through */
export interface ROp {
  a: number;
  b: string;
  d: string;
  t: string;
  j?: number;
  f?: number;
}
export interface RAsm {
  name: string;
  addr: number;
  size: number;
  ops: ROp[];
  totalOps: number;
  at: number;
}
/** decompiler pseudocode, with the instruction addresses each line came from */
export interface RCode {
  code: string;
  lines: number[][];
  totalLines: number;
  at: number;
}
export interface RSection {
  name: string;
  vaddr: number;
  vsize: number;
  perm: string;
}
export type ROpName = "inspect" | "functions" | "disassemble" | "decompile";
export interface RStep {
  seq: string;
  op: ROpName;
  file: string;
  /** when it started (or finished, if the start line is missing) */
  at: number;
  /** how long it took; unset while running */
  ms?: number;
  address?: number;
  filter?: string;
  /** functions found, or instructions / lines read */
  count?: number;
  state: "live" | "ok" | "fail";
  error?: string;
}
export interface RBinary {
  file: string;
  sha256?: string;
  size?: number;
  target: Record<string, unknown>;
  sections: RSection[];
  /** every function known so far, by address */
  fns: RFn[];
  /** functions a name search found */
  matched: Set<number>;
  asm: Map<number, RAsm>;
  code: Map<number, RCode>;
  /** when it was last worked on */
  last: number;
}
export interface RTrace {
  bins: RBinary[];
  steps: RStep[];
}

export const emptyTrace = (): RTrace => ({ bins: [], steps: [] });

type Raw = Record<string, unknown> & { t?: string; seq?: string; op?: string; at?: number; file?: string };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" ? v : "");

function binary(tr: RTrace, file: string): RBinary {
  let b = tr.bins.find((x) => x.file === file);
  if (!b) {
    b = { file, target: {}, sections: [], fns: [], matched: new Set(), asm: new Map(), code: new Map(), last: 0 };
    tr.bins.push(b);
  }
  return b;
}

function addFns(b: RBinary, list: RFn[], replace: boolean) {
  const by = new Map((replace ? [] : b.fns).map((f) => [f.addr, f]));
  for (const f of list) by.set(f.addr, f);
  b.fns = [...by.values()].sort((x, y) => x.addr - y.addr);
}

/** Read new trace lines into a new trace (the old one is left as it was). */
export function readTrace(prev: RTrace, text: string): RTrace {
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return prev;
  const tr: RTrace = {
    steps: [...prev.steps],
    bins: prev.bins.map((b) => ({ ...b, fns: b.fns, matched: new Set(b.matched), asm: new Map(b.asm), code: new Map(b.code) })),
  };
  for (const line of lines) {
    let e: Raw;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const op = str(e.op) as ROpName;
    const seq = str(e.seq);
    const at = num(e.at) ?? 0;
    if (!seq || !["inspect", "functions", "disassemble", "decompile"].includes(op)) continue;
    const i = tr.steps.findIndex((s) => s.seq === seq);
    const base: RStep = i >= 0 ? tr.steps[i] : { seq, op, file: str(e.file), at, state: "live", address: num(e.address), filter: str(e.filter) || undefined };
    if (e.t === "start") {
      if (i < 0) tr.steps.push(base);
      continue;
    }
    if (e.t === "fail") {
      const s: RStep = { ...base, state: "fail", ms: Math.max(0, at - base.at), error: str(e.error).split("\n")[0].slice(0, 300) };
      if (i >= 0) tr.steps[i] = s;
      else tr.steps.push(s);
      continue;
    }
    if (e.t !== "done") continue;
    const file = str(e.file) || base.file;
    const b = binary(tr, file);
    b.last = Math.max(b.last, at);
    b.sha256 = str(e.sha256) || b.sha256;
    b.size = num(e.size) ?? b.size;
    if (e.target && typeof e.target === "object") b.target = e.target as Record<string, unknown>;
    const v = (e.view ?? {}) as Record<string, unknown>;
    const address = num(e.address);
    let count: number | undefined;
    if (op === "inspect" && Array.isArray(v.sections)) {
      b.sections = (v.sections as Record<string, unknown>[])
        .map((x) => ({ name: str(x.name), vaddr: num(x.vaddr) ?? 0, vsize: num(x.vsize) ?? 0, perm: str(x.perm) }))
        .filter((x) => x.vsize > 0);
    } else if (op === "functions" && Array.isArray(v.functions)) {
      const list = (v.functions as unknown[][])
        .map((f) => ({ name: str(f[0]), addr: num(f[1]) ?? -1, size: num(f[2]) ?? 0 }))
        .filter((f) => f.addr >= 0);
      const filter = str(e.filter);
      addFns(b, list, !filter);
      if (filter) for (const f of list) b.matched.add(f.addr);
      count = list.length;
    } else if (op === "disassemble" && Array.isArray(v.ops)) {
      const ops = (v.ops as Record<string, unknown>[])
        .map((o) => ({ a: num(o.a) ?? -1, b: str(o.b), d: str(o.d), t: str(o.t), j: num(o.j), f: num(o.f) }))
        .filter((o) => o.a >= 0);
      const addr = num(v.addr) ?? address ?? ops[0]?.a ?? 0;
      const fn: RFn = { name: str(v.name) || hex(addr), addr, size: num(v.size) ?? 0 };
      if (!b.fns.some((f) => f.addr === addr)) addFns(b, [fn], false);
      b.asm.set(addr, { ...fn, ops, totalOps: num(v.totalOps) ?? ops.length, at });
      count = ops.length;
    } else if (op === "decompile" && typeof v.code === "string" && address !== undefined) {
      const lines = Array.isArray(v.lines) ? (v.lines as unknown[]).map((l) => (Array.isArray(l) ? l.filter((x): x is number => typeof x === "number") : [])) : [];
      b.code.set(address, { code: v.code, lines, totalLines: num(v.totalLines) ?? lines.length, at });
      count = num(v.totalLines);
    }
    const s: RStep = { ...base, file, state: "ok", ms: i >= 0 ? Math.max(0, at - base.at) : undefined, address: address ?? base.address, filter: str(e.filter) || base.filter, count };
    if (i >= 0) tr.steps[i] = s;
    else tr.steps.push(s);
  }
  tr.steps.sort((x, y) => x.at - y.at);
  return tr;
}

export const hex = (n: number) => `0x${n.toString(16)}`;

/** The function an address falls in. */
export function fnAt(b: RBinary, addr: number): RFn | undefined {
  let lo = 0;
  let hi = b.fns.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (b.fns[mid].addr <= addr) lo = mid + 1;
    else hi = mid - 1;
  }
  const f = b.fns[hi];
  return f && addr < f.addr + Math.max(1, f.size) ? f : undefined;
}

/**
 * A readable name for a symbol: engine prefixes dropped, and Swift or Itanium
 * C++ mangling read as far as its length-prefixed names ("main.isSecure").
 * The full name stays available where it is shown.
 */
export function shortName(name: string): string {
  const n = name.replace(/^(sym\.imp\.|sym\.|method\.|fcn\.|sub\.|imp\.)/, "");
  const parts = (s: string) => {
    const out: string[] = [];
    let i = 0;
    while (i < s.length) {
      const m = /^(\d+)/.exec(s.slice(i));
      if (!m) break;
      const len = Number(m[1]);
      const word = s.slice(i + m[1].length, i + m[1].length + len);
      if (!len || word.length < len) break;
      out.push(word);
      i += m[1].length + len;
    }
    return out;
  };
  const swift = /^_*\$?s(\d.*)$/.exec(n);
  if (swift) {
    const p = parts(swift[1]);
    if (p.length) return p.slice(0, 2).join(".");
  }
  const cpp = /^_*ZN(?:K)?(\d.*)$/.exec(n);
  if (cpp) {
    const p = parts(cpp[1]);
    if (p.length) return p.join("::");
  }
  const cfn = /^_*Z(\d.*)$/.exec(n);
  if (cfn) {
    const p = parts(cfn[1]);
    if (p.length) return p[0];
  }
  return n;
}

/** How far each function has been read: 0 unknown, 1 listed, 2 found by name, 3 disassembled, 4 decompiled. */
export function depth(b: RBinary, addr: number): number {
  if (b.code.has(addr)) return 4;
  if (b.asm.has(addr)) return 3;
  if (b.matched.has(addr)) return 2;
  return 1;
}

/** The address range the map covers: the executable sections that hold code, widened to every known function. */
export function span(b: RBinary): { lo: number; hi: number; sections: RSection[] } {
  const all = b.sections.filter((s) => s.perm.includes("x"));
  // constants and strings can sit in executable segments too: keep the sections functions are in
  const coded = all.filter((s) => b.fns.some((f) => f.addr >= s.vaddr && f.addr < s.vaddr + s.vsize));
  const exec = coded.length ? coded : all;
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of exec) (lo = Math.min(lo, s.vaddr)), (hi = Math.max(hi, s.vaddr + s.vsize));
  if (b.fns.length) {
    lo = Math.min(lo, b.fns[0].addr);
    const last = b.fns[b.fns.length - 1];
    hi = Math.max(hi, last.addr + Math.max(1, last.size));
  }
  if (!Number.isFinite(lo) || hi <= lo) return { lo: 0, hi: 0, sections: [] };
  return { lo, hi, sections: exec.filter((s) => s.vaddr < hi && s.vaddr + s.vsize > lo).sort((x, y) => x.vaddr - y.vaddr) };
}

/** Each cell of a `cells`-cell map over the range: the deepest state of any function in it. */
export function cellDepths(b: RBinary, cells: number): Uint8Array {
  const out = new Uint8Array(cells);
  const { lo, hi } = span(b);
  if (hi <= lo) return out;
  const per = (hi - lo) / cells;
  for (const f of b.fns) {
    const d = depth(b, f.addr);
    const a = Math.max(0, Math.floor((f.addr - lo) / per));
    const z = Math.min(cells - 1, Math.floor((f.addr + Math.max(1, f.size) - 1 - lo) / per));
    for (let c = a; c <= z; c++) if (out[c] < d) out[c] = d;
  }
  return out;
}

/** Jump arrows inside a listing: from row, to row, and a lane so arrows that overlap sit side by side. */
export interface Arrow {
  from: number;
  to: number;
  lane: number;
  cond: boolean;
}
export function arrows(ops: ROp[], maxLanes = 6): { list: Arrow[]; lanes: number } {
  const row = new Map(ops.map((o, i) => [o.a, i]));
  const raw: Omit<Arrow, "lane">[] = [];
  ops.forEach((o, i) => {
    if (o.j === undefined || (o.t !== "jmp" && o.t !== "cjmp")) return;
    const to = row.get(o.j);
    if (to !== undefined && to !== i) raw.push({ from: i, to, cond: o.t === "cjmp" });
  });
  // shortest first, each in the innermost lane free over its whole span
  raw.sort((x, y) => Math.abs(x.to - x.from) - Math.abs(y.to - y.from));
  const used: [number, number][][] = [];
  const list: Arrow[] = raw.map((r) => {
    const lo = Math.min(r.from, r.to);
    const hi = Math.max(r.from, r.to);
    let lane = used.findIndex((spans) => spans.every(([a, z]) => z < lo || a > hi));
    if (lane < 0) lane = used.push([]) - 1;
    used[lane].push([lo, hi]);
    return { ...r, lane: Math.min(lane, maxLanes - 1) };
  });
  return { list, lanes: Math.min(used.length, maxLanes) };
}

/** What a function calls (known targets, in order) and which read functions call it. */
export function calls(b: RBinary, addr: number): { out: { addr: number; name: string }[]; in: RFn[] } {
  const asm = b.asm.get(addr);
  const seen = new Set<number>();
  const out: { addr: number; name: string }[] = [];
  for (const o of asm?.ops ?? []) {
    if (!/call/.test(o.t) || o.j === undefined || seen.has(o.j)) continue;
    seen.add(o.j);
    const f = b.fns.find((x) => x.addr === o.j);
    const target = /\b((?:sym|fcn|method|sub)\.[\w.$@:<>-]+)/.exec(o.d)?.[1];
    out.push({ addr: o.j, name: f?.name ?? target ?? hex(o.j) });
  }
  const callers: RFn[] = [];
  for (const [a, x] of b.asm) {
    if (a !== addr && x.ops.some((o) => /call/.test(o.t) && o.j === addr)) callers.push(b.fns.find((f) => f.addr === a) ?? { name: x.name, addr: a, size: x.size });
  }
  return { out, in: callers };
}
