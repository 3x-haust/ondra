// A board: an explanation the agent draws, one line per stroke, in the order it
// explains. It is data, never code: each line is a word and its numbers/words.
//
//   title 커피가 내려지는 원리
//   step 뜨거운 물이 위에서 부어져요
//   box 300 40 200 60 "뜨거운 물" accent fill
//   arrow 400 100 400 180 "통과"
//   step 원두 가루를 지나며 맛이 녹아 나와요
//   circle 400 240 50 "원두 가루" warn
//   text 480 250 "약 4분" quiet size=18
//
// A board with `part` lines is a 3D model instead: each part a shape, placed in
// metres-ish units, built step by step, turned by dragging, clickable by name.
//
//   part "받침" box 2 0.2 2 at 0 0 0 wood
//   part "기둥" cylinder 0.08 3 at 0 1.6 0 steel

export type Tone = "ink" | "quiet" | "accent" | "ok" | "warn" | "bad" | "live" | "violet";
export const TONES: Tone[] = ["ink", "quiet", "accent", "ok", "warn", "bad", "live", "violet"];
export type Material = "steel" | "wood" | "glass" | "gold" | "copper" | "rubber" | "plastic" | "stone" | "paper";
export const MATERIALS: Material[] = ["steel", "wood", "glass", "gold", "copper", "rubber", "plastic", "stone", "paper"];

type Common = { step: number; tone: Tone; dash?: boolean };
export type Mark =
  | (Common & { kind: "box"; x: number; y: number; w: number; h: number; label?: string; fill?: boolean })
  | (Common & { kind: "circle"; x: number; y: number; r: number; label?: string; fill?: boolean })
  | (Common & { kind: "line" | "arrow" | "curve"; pts: [number, number][]; label?: string; head?: boolean })
  | (Common & { kind: "text"; x: number; y: number; text: string; size: number; bold?: boolean })
  | (Common & { kind: "mark"; x: number; y: number; w: number; h: number })
  | (Common & { kind: "dot"; x: number; y: number; r: number });

export type Shape = "box" | "cylinder" | "cone" | "sphere" | "torus" | "capsule";
export type Part = {
  step: number;
  label: string;
  shape: Shape;
  /** box: w h d · cylinder: r h [r2] · cone: r h · sphere: r · torus: R r · capsule: r h */
  dims: number[];
  at: [number, number, number];
  /** degrees about x, y, z */
  rot: [number, number, number];
  look: Material | Tone;
};

export type Step = { text: string };
export type Board = { title?: string; w: number; h: number; steps: Step[]; marks: Mark[]; parts: Part[]; problems: string[] };

const DIMS: Record<Shape, [number, number]> = { box: [3, 3], cylinder: [2, 3], cone: [2, 2], sphere: [1, 1], torus: [2, 2], capsule: [2, 2] };
const MAX_MARKS = 300;
const MAX_PARTS = 120;

/** words of a line; "quoted text" is one word (\" inside it is a quote) */
export function words(line: string): string[] | undefined {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i])) { i++; continue; }
    if (line[i] === '"') {
      let s = "";
      i++;
      while (i < line.length && line[i] !== '"') { if (line[i] === "\\" && i + 1 < line.length) i++; s += line[i++]; }
      if (i >= line.length) return undefined; // unclosed: the line is still being written
      out.push(`"${s}`);
      i++;
    } else {
      let s = "";
      while (i < line.length && !/\s/.test(line[i])) s += line[i++];
      out.push(s);
    }
  }
  return out;
}

const isNum = (w: string) => /^-?(\d+\.?\d*|\.\d+)$/.test(w);
const quoted = (w: string) => w.startsWith('"');

export function parseBoard(src: string): Board {
  const b: Board = { w: 800, h: 450, steps: [], marks: [], parts: [], problems: [] };
  const step = () => Math.max(0, b.steps.length - 1);
  src.split("\n").forEach((raw, n) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) return;
    const sp = line.indexOf(" ");
    const head = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? "" : line.slice(sp + 1).trim();
    const bad = (why: string) => void (b.problems.length < 20 && b.problems.push(`${n + 1}: ${why}`));
    if (head === "title") return void (b.title = rest.replace(/^"|"$/g, "").slice(0, 120));
    if (head === "step") return void b.steps.push({ text: rest.replace(/^"|"$/g, "").slice(0, 300) });
    const ws = words(rest);
    if (!ws) return bad("unclosed quote");
    const nums = ws.filter(isNum).map(Number);
    const label = ws.find(quoted)?.slice(1);
    const flags = new Set(ws.filter((w) => !isNum(w) && !quoted(w)).map((w) => w.toLowerCase()));
    const tone = (TONES.find((t) => flags.has(t)) ?? (head === "mark" ? "warn" : "ink")) as Tone;
    const opt = (k: string) => { const f = [...flags].find((w) => w.startsWith(`${k}=`)); return f ? Number(f.slice(k.length + 1)) : undefined; };
    const common = { step: step(), tone, ...(flags.has("dash") ? { dash: true } : {}) };
    if (head === "size") {
      if (nums.length < 2 || nums[0] < 100 || nums[1] < 100 || nums[0] > 2000 || nums[1] > 2000) return bad("size W H, 100–2000");
      b.w = nums[0]; b.h = nums[1];
      return;
    }
    if (head === "part") {
      if (b.parts.length >= MAX_PARTS) return bad("too many parts");
      const shape = ws.find((w) => w.toLowerCase() in DIMS)?.toLowerCase() as Shape | undefined;
      if (!shape || !label) return bad("part \"name\" shape dims… at x y z");
      // numbers before `at` are the shape's sizes; three after `at` its place; three after `rot` its turn
      const lower = ws.map((w) => w.toLowerCase());
      const after = (k: string) => { const i = lower.indexOf(k); return i < 0 ? [] : lower.slice(i + 1).filter(isNum).slice(0, 3).map(Number); };
      const firstKey = Math.min(...["at", "rot"].map((k) => (lower.indexOf(k) < 0 ? ws.length : lower.indexOf(k))));
      const dims = ws.slice(0, firstKey).filter(isNum).map(Number);
      const [lo, hi] = DIMS[shape];
      if (dims.length < lo || dims.some((d) => !(d > 0) || d > 1000)) return bad(`${shape} needs ${lo} positive size${lo > 1 ? "s" : ""}`);
      const at = after("at"), rot = after("rot");
      const look = (MATERIALS.find((m) => flags.has(m)) ?? TONES.find((t) => flags.has(t)) ?? "plastic") as Part["look"];
      b.parts.push({ step: step(), label: label.slice(0, 60), shape, dims: dims.slice(0, hi),
        at: [at[0] ?? 0, at[1] ?? 0, at[2] ?? 0], rot: [rot[0] ?? 0, rot[1] ?? 0, rot[2] ?? 0], look });
      return;
    }
    if (b.marks.length >= MAX_MARKS) return bad("too many marks");
    const inside = (v: number) => Number.isFinite(v) && v > -5000 && v < 5000;
    if (!nums.every(inside)) return bad("number out of range");
    switch (head) {
      case "box":
      case "mark":
        if (nums.length < 4 || nums[2] <= 0 || nums[3] <= 0) return bad(`${head} x y w h`);
        if (head === "mark") return void b.marks.push({ kind: "mark", ...common, x: nums[0], y: nums[1], w: nums[2], h: nums[3] });
        return void b.marks.push({ kind: "box", ...common, x: nums[0], y: nums[1], w: nums[2], h: nums[3],
          ...(label ? { label } : {}), ...(flags.has("fill") ? { fill: true } : {}) });
      case "circle":
        if (nums.length < 3 || nums[2] <= 0) return bad("circle x y r");
        return void b.marks.push({ kind: "circle", ...common, x: nums[0], y: nums[1], r: nums[2], ...(label ? { label } : {}), ...(flags.has("fill") ? { fill: true } : {}) });
      case "dot":
        if (nums.length < 2) return bad("dot x y");
        return void b.marks.push({ kind: "dot", ...common, x: nums[0], y: nums[1], r: nums[2] ?? 5 });
      case "text": {
        if (nums.length < 2 || !label) return bad('text x y "words"');
        const size = opt("size");
        return void b.marks.push({ kind: "text", ...common, x: nums[0], y: nums[1], text: label.slice(0, 200),
          size: size && size >= 10 && size <= 64 ? size : 18, ...(flags.has("bold") ? { bold: true } : {}) });
      }
      case "line":
      case "arrow":
      case "curve": {
        // `size=` style words never carry points; plain numbers pair up as x y
        const pts: [number, number][] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) pts.push([nums[i], nums[i + 1]]);
        if (pts.length < 2) return bad(`${head} needs two points`);
        return void b.marks.push({ kind: head, ...common, pts: pts.slice(0, 40), ...(label ? { label } : {}),
          ...(head === "arrow" || flags.has("arrow") ? { head: true } : {}) });
      }
      default:
        return bad(`unknown "${head}"`);
    }
  });
  if (!b.steps.length) b.steps.push({ text: "" });
  return b;
}
