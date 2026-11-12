// A board as a drawing program: the agent writes a little JavaScript that calls
// drawing functions (box, pen, path, arc, text, part, ...), so it can draw what the
// thing looks like, with loops and arithmetic, instead of placing fixed shapes.
//
// The program never runs in the app. It runs in QuickJS compiled to WebAssembly: a
// separate interpreter with no window, no network, no files, no app functions, only
// the drawing functions below (plain JS inside it), a time limit and a memory limit.
// What comes back is data (a list of marks), checked here before anything is drawn.
import type { QuickJSWASMModule } from "quickjs-emscripten-core";
import { DIMS, MATERIALS, TONES, type Board, type Part, type Shape, type Tone } from "./parse";

/** the drawing functions, inside the sandbox */
const PRELUDE = String.raw`
"use strict";
const __o = { title: "", w: 800, h: 450, steps: [], marks: [], parts: [], error: "" };
let __seed = 1234567;
Math.random = () => { __seed = (__seed * 1103515245 + 12345) % 2147483648; return __seed / 2147483648; };
const __n = (v, d) => (typeof v === "number" && isFinite(v) ? v : d === undefined ? 0 : d);
const __s = (v) => (v === undefined || v === null ? undefined : String(v));
const __at = () => Math.max(0, __o.steps.length - 1);
const __pt = (p) => [__n(p && p[0]), __n(p && p[1])];
function __mark(m, o) {
  if (__o.marks.length >= 800) throw new Error("too many marks (800 at most)");
  o = o || {};
  m.step = __at();
  if (o.color !== undefined) m.color = String(o.color);
  if (o.dash) m.dash = true;
  if (o.width !== undefined) m.width = __n(o.width);
  __o.marks.push(m);
}
function title(s) { __o.title = String(s); }
function size(w, h) { __o.w = __n(w, 800); __o.h = __n(h, 450); }
function step(s) { __o.steps.push(String(s === undefined ? "" : s)); }
// every shape gives back where it is, so the next can be placed by it, not by guessed numbers
const __g = (x, y, w, h) => ({ x, y, w, h, left: x, top: y, right: x + w, bottom: y + h, cx: x + w / 2, cy: y + h / 2 });
function measure(s, size) {
  size = __n(size, 18); let w = 0;
  for (const ch of String(s)) { const c = ch.codePointAt(0); w += c > 0x2e80 ? 0.96 : ch === " " ? 0.3 : /[A-Z0-9%]/.test(ch) ? 0.64 : /[il.,:;'|!]/.test(ch) ? 0.3 : 0.54; }
  return w * size;
}
function box(x, y, w, h, o) {
  o = o || {}; x = __n(x); y = __n(y); w = __n(w); h = __n(h);
  __mark({ kind: "box", x, y, w, h, label: __s(o.label), size: o.size, fill: !!o.fill, bare: !!o.bare }, o);
  return __g(x, y, w, h);
}
function circle(x, y, r, o) {
  o = o || {}; x = __n(x); y = __n(y); r = __n(r);
  __mark({ kind: "circle", x, y, r, label: __s(o.label), size: o.size, fill: !!o.fill }, o);
  return __g(x - r, y - r, 2 * r, 2 * r);
}
const __span = (p) => { const xs = p.map((q) => q[0]), ys = p.map((q) => q[1]); const x = Math.min(...xs), y = Math.min(...ys); return __g(x, y, Math.max(...xs) - x, Math.max(...ys) - y); };
function line(x1, y1, x2, y2, o) { o = o || {}; const p = [[__n(x1), __n(y1)], [__n(x2), __n(y2)]]; __mark({ kind: o.arrow ? "arrow" : "line", pts: p, label: __s(o.label), head: !!o.arrow }, o); return __span(p); }
function arrow(x1, y1, x2, y2, o) { return line(x1, y1, x2, y2, Object.assign({}, o, { arrow: true })); }
function pen(pts, o) { o = o || {}; const p = (pts || []).slice(0, 400).map(__pt); if (p.length < 2) return undefined; __mark({ kind: "curve", pts: p, label: __s(o.label), head: !!o.arrow }, o); return __span(p); }
function curve(pts, o) { return pen(pts, o); }
function poly(pts, o) {
  o = o || {};
  const p = (pts || []).slice(0, 400).map(__pt);
  if (p.length < 2) return;
  let d = "M" + p[0][0] + " " + p[0][1];
  for (let i = 1; i < p.length; i++) d += "L" + p[i][0] + " " + p[i][1];
  if (o.open !== true) d += "Z";
  __mark({ kind: "path", d, fill: !!o.fill }, o);
  return __span(p);
}
function path(d, o) { o = o || {}; __mark({ kind: "path", d: String(d), fill: !!o.fill }, o); }
function ellipse(cx, cy, rx, ry, o) {
  o = o || {};
  cx = __n(cx); cy = __n(cy); rx = __n(rx); ry = __n(ry, rx);
  __mark({ kind: "path", d: "M" + (cx - rx) + " " + cy + "A" + rx + " " + ry + " 0 1 1 " + (cx + rx) + " " + cy + "A" + rx + " " + ry + " 0 1 1 " + (cx - rx) + " " + cy + "Z", fill: !!o.fill }, o);
  return __g(cx - rx, cy - ry, 2 * rx, 2 * ry);
}
function arc(cx, cy, r, from, to, o) {
  o = o || {};
  const a0 = (__n(from) * Math.PI) / 180, a1 = (__n(to) * Math.PI) / 180, n = Math.max(6, Math.min(90, Math.round(Math.abs(a1 - a0) * 12)));
  const p = [];
  for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; p.push([__n(cx) + Math.cos(a) * __n(r), __n(cy) + Math.sin(a) * __n(r)]); }
  return pen(p, o);
}
function text(x, y, s, o) {
  o = o || {}; x = __n(x); y = __n(y); s = String(s);
  const size = __n(o.size, 18), w = measure(s, size) * (o.bold ? 1.04 : 1);
  __mark({ kind: "text", x, y, text: s, size, bold: !!o.bold, align: __s(o.align) }, o);
  const x0 = o.align === "center" ? x - w / 2 : o.align === "right" ? x - w : x;
  return __g(x0, y - size * 0.62, w, size * 1.24);
}
/** a word or short phrase in a rounded tag, sized to its words; {center: true} puts its middle at x, y */
function chip(x, y, s, o) {
  o = o || {}; s = String(s);
  const size = __n(o.size, 16), h = Math.round(size * 2.1), w = Math.round(measure(s, size) + size * 1.5);
  if (o.center) { x = __n(x) - w / 2; y = __n(y) - h / 2; }
  return box(x, y, w, h, Object.assign({}, o, { label: s, size }));
}
/** chips side by side (or {down: true} stacked), returned in order; {center: true} centres the row on x */
function row(x, y, items, o) {
  o = o || {}; items = (items || []).slice(0, 40);
  const gap = __n(o.gap, 10), size = __n(o.size, 16), h = Math.round(size * 2.1);
  const ws = items.map((s) => Math.round(measure(String(s), size) + size * 1.5));
  const total = o.down ? items.length * h + (items.length - 1) * gap : ws.reduce((a, b) => a + b, 0) + (items.length - 1) * gap;
  let at = o.down ? __n(y) - (o.center ? total / 2 : 0) : __n(x) - (o.center ? total / 2 : 0);
  return items.map((s, i) => {
    const per = Array.isArray(o.colors) ? Object.assign({}, o, { color: o.colors[i] }) : o;
    const g = o.down ? box(__n(x) - (o.center ? ws[i] / 2 : 0), at, ws[i], h, Object.assign({}, per, { label: String(s), size })) : box(at, __n(y), ws[i], h, Object.assign({}, per, { label: String(s), size }));
    at += (o.down ? h : ws[i]) + gap;
    return g;
  });
}
const __isG = (a) => a && typeof a === "object" && !Array.isArray(a) && "cx" in a;
/** where a line toward (tx, ty) leaves a shape's edge */
function __edge(a, tx, ty, pad) {
  if (!__isG(a)) return __pt(a);
  const dx = tx - a.cx, dy = ty - a.cy;
  if (!dx && !dy) return [a.cx, a.cy];
  const k = Math.min(dx ? (a.w / 2 + pad) / Math.abs(dx) : Infinity, dy ? (a.h / 2 + pad) / Math.abs(dy) : Infinity);
  return [a.cx + dx * k, a.cy + dy * k];
}
const __ok = (a) => __isG(a) || (Array.isArray(a) && typeof a[0] === "number" && typeof a[1] === "number" && isFinite(a[0]) && isFinite(a[1]));
const __c = (a) => (__isG(a) ? [a.cx, a.cy] : __pt(a));
/** an arrow from one shape (or point) to another, edge to edge; {bend: 40} curves it, {label} names it */
function connect(a, b, o) {
  o = o || {};
  if (!__ok(a) || !__ok(b)) return undefined;
  const ca = __c(a), cb = __c(b);
  const p = __edge(a, cb[0], cb[1], 6), q = __edge(b, ca[0], ca[1], 8);
  const bend = __n(o.bend);
  if (!bend) return line(p[0], p[1], q[0], q[1], Object.assign({ arrow: o.arrow !== false }, o));
  const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2, l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  pen([p, [mx - ((q[1] - p[1]) / l) * bend, my + ((q[0] - p[0]) / l) * bend], q], Object.assign({ arrow: o.arrow !== false }, o));
}
/** a short note at (x, y) with a thin leader to what it is about (a shape or a point) */
function label(x, y, s, to, o) {
  o = o || {};
  const t = text(x, y, s, Object.assign({ size: 15, color: "quiet" }, o, { align: o.align || "left" }));
  if (__ok(to)) {
    const c = __c(to), from = __edge(t, c[0], c[1], 4), end = __isG(to) ? __edge(to, from[0], from[1], 2) : c;
    line(from[0], from[1], end[0], end[1], { color: "quiet", width: 1 });
    dot(end[0], end[1], { r: 2.5, color: "quiet" });
  }
  return t;
}
/** a small bar chart: [["이름", 값], …]; {pick: i} colours the one that matters, values ≤ 1 show as % */
function bars(x, y, items, o) {
  o = o || {}; items = (items || []).slice(0, 12); x = __n(x); y = __n(y);
  const size = __n(o.size, 15), h = Math.round(size * 1.5), gap = Math.round(size * 0.6), W = __n(o.w, 220);
  const nameW = Math.max(0, ...items.map((it) => measure(String(it[0]), size))) + 14;
  const max = Math.max(1e-9, ...items.map((it) => Math.abs(__n(it[1]))));
  const pct = items.every((it) => __n(it[1]) >= 0 && __n(it[1]) <= 1);
  items.forEach((it, i) => {
    const v = __n(it[1]), yy = y + i * (h + gap), on = o.pick === i, c = on ? o.color || "accent" : "quiet";
    text(x, yy + h / 2, it[0], { size, color: on ? "ink" : "quiet", bold: on });
    box(x + nameW, yy, Math.max(4, (Math.abs(v) / max) * W), h, { color: c, fill: true });
    text(x + nameW + Math.max(4, (Math.abs(v) / max) * W) + 8, yy + h / 2, pct ? Math.round(v * 100) + "%" : String(v), { size: size - 1, color: on ? "ink" : "quiet" });
  });
  return __g(x, y, nameW + W + 50, items.length * (h + gap) - gap);
}
/** numbers in a row of cells (a vector, a row of a table); strong values are tinted */
function cells(x, y, values, o) {
  o = o || {}; values = (values || []).slice(0, 24); x = __n(x); y = __n(y);
  const s = __n(o.size, 40), max = Math.max(1e-9, ...values.map((v) => Math.abs(__n(v))));
  values.forEach((v, i) => {
    const n = __n(v), strong = Math.abs(n) >= max * 0.5;
    box(x + i * s, y, s, s * 0.8, { color: strong ? (n < 0 ? "warn" : o.color || "accent") : "quiet", fill: strong, label: String(v), size: Math.round(s * 0.3) });
  });
  return __g(x, y, values.length * s, s * 0.8);
}
/** a quiet frame around a part of the board, its name at its top-left */
function panel(x, y, w, h, name, o) {
  o = o || {};
  const g = box(x, y, w, h, Object.assign({ color: "quiet", dash: true, bare: true }, o, { label: undefined }));
  if (name) text(__n(x) + 12, __n(y) + 16, name, { size: 13, color: "quiet", bold: true });
  return g;
}
function highlight(x, y, w, h, o) { o = o || {}; __mark({ kind: "mark", x: __n(x), y: __n(y), w: __n(w), h: __n(h) }, Object.assign({ color: "yellow" }, o)); return __g(__n(x), __n(y), __n(w), __n(h)); }
function dot(x, y, o) { o = o || {}; const r = __n(o.r, 5); __mark({ kind: "dot", x: __n(x), y: __n(y), r }, o); return __g(__n(x) - r, __n(y) - r, 2 * r, 2 * r); }
function part(name, shape, dims, at, o) {
  o = o || {};
  if (__o.parts.length >= 160) throw new Error("too many parts (160 at most)");
  __o.parts.push({ step: __at(), label: String(name), shape: String(shape), dims: (Array.isArray(dims) ? dims : [dims]).map((d) => __n(d)),
    at: __pt3(at), rot: __pt3(o.rot), look: String(o.color || o.material || "plastic") });
}
function __pt3(p) { p = p || []; return [__n(p[0]), __n(p[1]), __n(p[2])]; }
`;

/** colour words a program may use; anything else must be a #hex */
const COLORS: Record<string, string> = {
  red: "#e5534b", orange: "#f0883e", yellow: "#f2c94c", green: "#3fa66a", teal: "#2aa198", sky: "#4ba3e3", blue: "#2f6fdb",
  purple: "#8957e5", pink: "#e06aa6", brown: "#a0673d", tan: "#d9a877", gray: "#8b8f98", grey: "#8b8f98",
};
/** the same words on a 3D part: the colour such a thing has (a green board, not a candy green) */
const REAL: Record<string, string> = {
  red: "#b3362f", orange: "#d9772b", yellow: "#e2b33c", green: "#1f6b3e", teal: "#1d7f78", sky: "#5c9fd6", blue: "#24509e",
  purple: "#5d3f9e", pink: "#d77fa8", brown: "#6e4a2f", tan: "#c9a37a", gray: "#7c8088", grey: "#7c8088", black: "#202226", white: "#eeeeec",
};
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** a mark's colour: one of the app's tones, or a colour word / #hex turned into a checked #hex */
function paint(c: unknown): { tone: Tone; color?: string } {
  const v = String(c ?? "").trim().toLowerCase();
  if (!v) return { tone: "ink" };
  if ((TONES as string[]).includes(v)) return { tone: v as Tone };
  if (v === "black") return { tone: "ink" };
  if (v === "gray" || v === "grey") return { tone: "quiet" };
  if (COLORS[v]) return { tone: "ink", color: COLORS[v] };
  if (HEX.test(v)) return { tone: "ink", color: v };
  return { tone: "ink" };
}
function look(c: unknown): string {
  const v = String(c ?? "").trim().toLowerCase();
  if ((MATERIALS as string[]).includes(v) || (TONES as string[]).includes(v)) return v;
  if (REAL[v]) return REAL[v];
  if (HEX.test(v)) return v;
  return "plastic";
}

const PATH = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+\-eE]*$/;
const num = (v: unknown, lo = -5000, hi = 5000) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);
const str = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : undefined);

/** a path's rough length (for how long the pen takes): the distance between the numbers it visits */
function pathLength(d: string): number {
  const ns = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  let len = 0;
  for (let i = 2; i + 1 < ns.length; i += 2) len += Math.hypot(ns[i] - ns[i - 2], ns[i + 1] - ns[i - 1]);
  return Math.max(40, Math.min(4000, len));
}

/** what the program made, checked: only known kinds, finite numbers in range, short strings, real colours */
export function boardOf(raw: any): Board {
  const b: Board = { w: 800, h: 450, steps: [], marks: [], parts: [], problems: [] };
  if (typeof raw?.title === "string" && raw.title) b.title = raw.title.slice(0, 120);
  b.w = num(raw?.w, 100, 2000) || 800;
  b.h = num(raw?.h, 100, 2000) || 450;
  for (const s of Array.isArray(raw?.steps) ? raw.steps.slice(0, 40) : []) b.steps.push({ text: String(s).replace(/^\s*(?:\d{1,2}[.)]|[①-⑳]|\(\d{1,2}\))\s*/, "").slice(0, 300) });
  for (const m of Array.isArray(raw?.marks) ? raw.marks.slice(0, 800) : []) {
    const step = Math.max(0, Math.min(39, Math.floor(num(m?.step, 0, 39))));
    const common = { step, ...paint(m?.color), ...(m?.dash ? { dash: true } : {}) };
    const label = str(m?.label, 200);
    const width = m?.width !== undefined ? num(m.width, 0.5, 40) : undefined;
    switch (m?.kind) {
      case "box":
        if (num(m.w) > 0 && num(m.h) > 0) b.marks.push({ kind: "box", ...common, x: num(m.x), y: num(m.y), w: num(m.w), h: num(m.h), ...(label ? { label } : {}),
          ...(m.fill ? { fill: true } : {}), ...(m.bare ? { bare: true } : {}), ...(typeof m.size === "number" ? { size: num(m.size, 9, 48) } : {}) });
        break;
      case "circle":
        if (num(m.r) > 0) b.marks.push({ kind: "circle", ...common, x: num(m.x), y: num(m.y), r: num(m.r), ...(label ? { label } : {}), ...(m.fill ? { fill: true } : {}),
          ...(typeof m.size === "number" ? { size: num(m.size, 9, 48) } : {}) });
        break;
      case "line":
      case "arrow":
      case "curve": {
        const pts = (Array.isArray(m.pts) ? m.pts.slice(0, 400) : []).map((p: any) => [num(p?.[0]), num(p?.[1])] as [number, number]);
        if (pts.length >= 2) b.marks.push({ kind: m.kind, ...common, pts, ...(label ? { label } : {}), ...(m.head ? { head: true } : {}), ...(width ? { width } : {}) });
        break;
      }
      case "path": {
        const d = typeof m.d === "string" ? m.d.slice(0, 20000) : "";
        if (d && PATH.test(d) && /^\s*[Mm]/.test(d)) b.marks.push({ kind: "path", ...common, d, len: pathLength(d), ...(m.fill ? { fill: true } : {}), ...(width ? { width } : {}) });
        break;
      }
      case "text": {
        const t = str(m.text, 300);
        const size = num(m.size, 10, 72) || 18;
        if (t) b.marks.push({ kind: "text", ...common, x: num(m.x), y: num(m.y), text: t, size, ...(m.bold ? { bold: true } : {}),
          ...(m.align === "center" || m.align === "middle" ? { align: "middle" as const } : m.align === "right" || m.align === "end" ? { align: "end" as const } : {}) });
        break;
      }
      case "mark":
        if (num(m.w) > 0 && num(m.h) > 0) b.marks.push({ kind: "mark", ...common, ...(common.tone === "ink" && !common.color ? { tone: "warn" as Tone } : {}), x: num(m.x), y: num(m.y), w: num(m.w), h: num(m.h) });
        break;
      case "dot":
        b.marks.push({ kind: "dot", ...common, x: num(m.x), y: num(m.y), r: num(m.r, 1, 60) || 5 });
        break;
    }
  }
  for (const p of Array.isArray(raw?.parts) ? raw.parts.slice(0, 160) : []) {
    const shape = String(p?.shape ?? "").toLowerCase() as Shape;
    if (!(shape in DIMS)) continue;
    const [lo, hi] = DIMS[shape];
    const dims = (Array.isArray(p.dims) ? p.dims : []).slice(0, hi).map((d: unknown) => num(d, 0, 1000));
    if (dims.length < lo || dims.some((d: number) => !(d > 0))) continue;
    const v3 = (a: any, lim: number) => [num(a?.[0], -lim, lim), num(a?.[1], -lim, lim), num(a?.[2], -lim, lim)] as [number, number, number];
    b.parts.push({ step: Math.max(0, Math.floor(num(p.step, 0, 39))), label: String(p.label ?? "").slice(0, 60), shape, dims, at: v3(p.at, 1000), rot: v3(p.rot, 360), look: look(p.look) } as Part);
  }
  if (raw?.error) b.problems.push(String(raw.error).slice(0, 300));
  if (!b.steps.length) b.steps.push({ text: "" });
  return b;
}

/** Is this board a program (calls like `box(…)`, statements), not the line form? */
export function isProgram(src: string): boolean {
  return /^\s*(?:title|step|size|box|circle|ellipse|line|arrow|curve|pen|poly|path|arc|text|highlight|dot|part|chip|row|connect|label|bars|cells|panel)\s*\(/m.test(src) || /^\s*(?:const|let|var|for|function|if)\b/m.test(src);
}

/** the part of a program that is complete so far: up to the last line that ends outside any bracket, string or comment */
export function completePart(src: string): string {
  let depth = 0, end = 0;
  let q: string | null = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === "\\") i++;
      else if (c === q) q = null;
      else if (c === "\n" && q !== "`") q = null; // a broken quote ends with its line
      continue;
    }
    if (c === "/" && src[i + 1] === "/") { const nl = src.indexOf("\n", i); if (nl < 0) break; i = nl - 1; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); if (e < 0) break; i = e + 1; continue; }
    if (c === '"' || c === "'" || c === "`") q = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth = Math.max(0, depth - 1);
    else if (c === "\n" && depth === 0) end = i + 1;
  }
  return src.slice(0, end);
}

let engine: Promise<QuickJSWASMModule> | undefined;
let ready: QuickJSWASMModule | undefined;
/** load the interpreter (once, on the first program board) */
export function loadEngine(): Promise<QuickJSWASMModule> {
  engine ??= import("quickjs-emscripten-core").then(async ({ newQuickJSWASMModuleFromVariant }) => {
    const variant = await import("@jitl/quickjs-singlefile-browser-release-sync");
    ready = await newQuickJSWASMModuleFromVariant((variant as any).default ?? variant);
    return ready;
  });
  return engine;
}
export const engineReady = () => ready;

/**
 * Run a program in a fresh sandbox and read back what it drew; undefined until the
 * interpreter has loaded. `broken`: it didn't parse, so nothing of it ran.
 */
export function runProgram(code: string): { board: Board; broken: boolean } | undefined {
  if (!ready) return undefined;
  const rt = ready.newRuntime();
  rt.setMemoryLimit(32 * 1024 * 1024);
  rt.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + 400;
  rt.setInterruptHandler(() => Date.now() > deadline);
  const vm = rt.newContext();
  try {
    const pre = vm.evalCode(PRELUDE, "board-prelude.js");
    if (pre.error) { pre.error.dispose(); return { board: boardOf({ error: "board engine failed to start" }), broken: true }; }
    pre.value.dispose();
    const run = vm.evalCode(code, "board.js");
    let error = "";
    let broken = false;
    if (run.error) {
      const e = vm.dump(run.error);
      error = String(e?.message ?? e ?? "error");
      broken = e?.name === "SyntaxError";
      run.error.dispose();
    } else run.value.dispose();
    const out = vm.evalCode("JSON.stringify(__o)", "out.js");
    if (out.error) { out.error.dispose(); return { board: boardOf({ error: error || "no drawing came back" }), broken: true }; }
    const text = vm.getString(out.value);
    out.value.dispose();
    const raw = JSON.parse(text);
    if (error) raw.error = error;
    return { board: boardOf(raw), broken };
  } catch (e) {
    return { board: boardOf({ error: e instanceof Error ? e.message : String(e) }), broken: true };
  } finally {
    vm.dispose();
    rt.dispose();
  }
}
