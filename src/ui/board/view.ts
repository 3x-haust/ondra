// A board on screen: the drawing appears stroke by stroke in the order it explains,
// a pen point at the end of the line being drawn, the step being drawn named under
// it. A board already seen is shown whole.
// Plain DOM (no Solid) so a reply that is still streaming can move the same board
// into its re-rendered text and keep drawing where it was.
import { parseBoard, type Board, type Mark, type Tone } from "./parse";
import { completePart, engineReady, isProgram, loadEngine, runProgram } from "./program";
import { box, head, polyline, ring, swipe, type Pt } from "./sketch";
import type { ThreeView } from "./three-view";
import { t } from "../../i18n";

const SVG = "http://www.w3.org/2000/svg";
const INK: Record<Tone, string> = {
  ink: "var(--ink)", quiet: "var(--ink-3)", accent: "var(--accent)", ok: "var(--ok)", warn: "var(--warn)",
  bad: "var(--bad)", live: "var(--live)", violet: "var(--merged)",
};
/** lines in plain ink are drawn a shade lighter than text */
const LINE: Record<Tone, string> = { ...INK, ink: "var(--ink-2)" };
const soft = (tone: Tone, pct = 12, color?: string) => `color-mix(in srgb, ${color ?? INK[tone]} ${pct}%, transparent)`;

// pen pace
const PX_PER_MS = 0.9;
const GAP = 70;
const STEP_GAP = 450;
const stroke = (len: number) => Math.max(160, Math.min(900, len / PX_PER_MS));
/** the pen speeds up and slows down at the ends of a stroke */
const ease = (p: number) => 0.5 - Math.cos(Math.PI * p) / 2;

// boards already drawn once: shown whole when they come back (scrolling, reopening the job)
const SEEN_KEY = "ondra.boards.seen";
const seen = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]; } catch { return []; } })());
const remember = (h: string) => {
  seen.add(h);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-400))); } catch { /* private mode */ }
};
export const hashOf = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };

const quiet = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

/** what one mark draws: its pieces in drawing order, each with how long the pen takes */
function build(m: Mark): { g: SVGGElement; under?: SVGElement; pieces: { e: SVGElement; ms: number; kind: "pen" | "fade" }[] } {
  const g = el("g", { class: "bd-mark" });
  const pieces: { e: SVGElement; ms: number; kind: "pen" | "fade" }[] = [];
  const pen = (d: string, len: number, width = "width" in m && m.width ? m.width : 1.8) => {
    const p = el("path", { d, fill: "none", stroke: m.color ?? LINE[m.tone], "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round", pathLength: 1 });
    // short even dashes whatever the stroke's length (it is measured as 1)
    if (m.dash) p.setAttribute("stroke-dasharray", `${(6 / Math.max(len, 1)).toFixed(5)} ${(5 / Math.max(len, 1)).toFixed(5)}`);
    g.appendChild(p);
    pieces.push({ e: p, ms: stroke(len), kind: m.dash ? "fade" : "pen" });
    return p;
  };
  const words = (x: number, y: number, s: string, size: number, opts: { anchor?: string; bold?: boolean; tone?: Tone; color?: string; free?: boolean } = {}) => {
    const tx = el("text", { x, y, "font-size": size, "text-anchor": opts.anchor ?? "start", "dominant-baseline": "middle",
      fill: opts.color ?? INK[opts.tone ?? (m.tone === "ink" ? "ink" : m.tone)], "font-weight": opts.bold ? 600 : 500 });
    // words standing on the paper (not inside a shape) keep a little paper around them, so a line under them doesn't cut them
    if (opts.free) tx.setAttribute("class", "bd-free");
    tx.textContent = s;
    g.appendChild(tx);
    pieces.push({ e: tx, ms: Math.max(180, Math.min(600, s.length * 28)), kind: "fade" });
  };
  switch (m.kind) {
    case "box": {
      // the outline first, then its tint washes in (stronger when asked to be filled)
      const r = Math.min(8, m.w / 4, m.h / 4);
      const f = m.bare ? undefined : el("rect", { x: m.x, y: m.y, width: m.w, height: m.h, rx: r, fill: soft(m.tone, m.fill ? 20 : m.tone === "ink" && !m.color ? 4 : 10, m.color) });
      if (f) g.appendChild(f);
      pen(box(m.x, m.y, m.w, m.h), 2 * (m.w + m.h), m.bare ? 1.2 : undefined);
      if (f) pieces.push({ e: f, ms: 260, kind: "fade" });
      if (m.label) words(m.x + m.w / 2, m.y + m.h / 2, m.label, m.size ?? Math.max(13, Math.min(20, m.h * 0.34)), { anchor: "middle", tone: m.tone === "quiet" ? "quiet" : "ink" });
      break;
    }
    case "circle": {
      const f = el("circle", { cx: m.x, cy: m.y, r: m.r, fill: soft(m.tone, m.fill ? 20 : m.tone === "ink" && !m.color ? 4 : 10, m.color) });
      g.appendChild(f);
      pen(ring(m.x, m.y, m.r), 2 * Math.PI * m.r);
      pieces.push({ e: f, ms: 260, kind: "fade" });
      if (m.label) words(m.x, m.y, m.label, m.size ?? Math.max(13, Math.min(20, m.r * 0.45)), { anchor: "middle", tone: "ink" });
      break;
    }
    case "line":
    case "arrow":
    case "curve": {
      const pts = m.pts as Pt[];
      const len = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
      pen(polyline(pts, m.kind === "curve"), len, 1.6);
      if (m.head) pen(head(pts[pts.length - 2], pts[pts.length - 1]), 24, 1.6);
      if (m.label) {
        const mid = pts[Math.floor((pts.length - 1) / 2)], nxt = pts[Math.floor((pts.length - 1) / 2) + 1];
        const vertical = Math.abs(nxt[0] - mid[0]) < Math.abs(nxt[1] - mid[1]);
        words((mid[0] + nxt[0]) / 2 + (vertical ? 10 : 0), (mid[1] + nxt[1]) / 2 + (vertical ? 0 : -14), m.label, 15, { anchor: vertical ? "start" : "middle", tone: m.tone === "ink" ? "quiet" : m.tone, free: true });
      }
      break;
    }
    case "text":
      words(m.x, m.y, m.text, m.size, { bold: m.bold, tone: m.tone, color: m.color, anchor: m.align, free: true });
      break;
    case "path": {
      // a shape the program drew: its tint first when filled, then the pen goes round it
      if (m.fill) { const f = el("path", { d: m.d, fill: soft(m.tone, 22, m.color), stroke: "none" }); g.appendChild(f); }
      pen(m.d, m.len);
      if (m.fill) pieces.push({ e: g.firstChild as SVGElement, ms: 260, kind: "fade" });
      break;
    }
    case "mark": {
      const p = el("path", { d: swipe(m.x, m.y, m.w, m.h), fill: "none", stroke: soft(m.tone, 38, m.color), "stroke-width": m.h, "stroke-linecap": "round", pathLength: 1 });
      pieces.push({ e: p, ms: stroke(m.w), kind: "pen" });
      return { g, under: p, pieces };
    }
    case "dot": {
      const d = el("circle", { cx: m.x, cy: m.y, r: m.r, fill: m.color ?? INK[m.tone] });
      g.appendChild(d);
      pieces.push({ e: d, ms: 140, kind: "fade" });
      break;
    }
  }
  return { g, pieces };
}

/** the part of the board a mark covers, labels included (text width is a guess) */
function extent(m: Mark): [number, number, number, number] {
  const tw = (s: string, size: number) => s.length * size * 0.62;
  switch (m.kind) {
    case "box": return [m.x, m.y, m.x + m.w, m.y + m.h];
    case "circle": return [m.x - m.r, m.y - m.r, m.x + m.r, m.y + m.r];
    case "text": {
      const w = tw(m.text, m.size), x0 = m.align === "middle" ? m.x - w / 2 : m.align === "end" ? m.x - w : m.x;
      return [x0, m.y - m.size, x0 + w, m.y + m.size];
    }
    case "mark": return [m.x, m.y, m.x + m.w, m.y + m.h];
    case "dot": return [m.x - m.r, m.y - m.r, m.x + m.r, m.y + m.r];
    case "path": {
      // the points the pen goes to (an arc's end, not its radii and flags)
      const xs: number[] = [], ys: number[] = [];
      for (const [, cmd, args] of m.d.matchAll(/([MLCSQTAHV])([^MLCSQTAHVZmlcsqtahvz]*)/g)) {
        const n = (args.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
        if (cmd === "H") xs.push(...n);
        else if (cmd === "V") ys.push(...n);
        else if (cmd === "A") for (let i = 0; i + 6 < n.length; i += 7) { xs.push(n[i + 5] - n[i], n[i + 5] + n[i]); ys.push(n[i + 6] - n[i + 1], n[i + 6] + n[i + 1]); }
        else for (let i = 0; i + 1 < n.length; i += 2) { xs.push(n[i]); ys.push(n[i + 1]); }
      }
      return xs.length && ys.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : [0, 0, 0, 0];
    }
    default: {
      const xs = m.pts.map((p) => p[0]), ys = m.pts.map((p) => p[1]);
      return [Math.min(...xs), Math.min(...ys) - (m.label ? 26 : 0), Math.max(...xs), Math.max(...ys)];
    }
  }
}

type Drawn = { key: string; g: SVGGElement; under?: SVGElement; pieces: { e: SVGElement; ms: number; kind: "pen" | "fade" }[]; step: number };

export type BoardOptions = { big?: boolean; onExpand?: (src: string) => void; onAsk?: (text: string) => void };

export class BoardView {
  readonly root: HTMLDivElement;
  private src = "";
  private board?: Board;
  /** the program text last run */
  private ran = "";
  private hash = "";
  private instant = false;
  private drawn: Drawn[] = [];
  private anims: Animation[] = [];
  private timers: number[] = [];
  private clock = 0;
  private lastStep = -1;
  private settle = 0;
  private svg?: SVGSVGElement;
  private ink?: SVGGElement;
  private penDot?: SVGGElement;
  /** pen strokes waiting or being drawn, each revealed along its length on its own clock */
  private strokes: { e: SVGElement; at: number; ms: number }[] = [];
  private raf = 0;
  private underLayer?: SVGGElement;
  private three?: ThreeView;
  private threeLoading = false;
  private disposed = false;
  private readonly head: HTMLDivElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly stage: HTMLDivElement;
  private readonly stepsEl: HTMLOListElement;
  private readonly tag: HTMLDivElement;

  constructor(private readonly opts: BoardOptions = {}) {
    this.root = document.createElement("div");
    this.root.className = `bd${opts.big ? " bd-big" : ""}`;
    this.head = document.createElement("div");
    this.head.className = "bd-head";
    this.titleEl = document.createElement("span");
    this.titleEl.className = "bd-title";
    const tools = document.createElement("span");
    tools.className = "bd-tools";
    const again = this.button(t("다시 그리기"), "M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4", () => this.replay(0));
    tools.append(again);
    if (opts.onExpand) tools.append(this.button(t("크게 보기"), "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7", () => opts.onExpand!(this.src)));
    this.head.append(this.titleEl, tools);
    this.stage = document.createElement("div");
    this.stage.className = "bd-stage";
    this.tag = document.createElement("div");
    this.tag.className = "bd-tag";
    this.tag.hidden = true;
    this.stepsEl = document.createElement("ol");
    this.stepsEl.className = "bd-steps";
    this.root.append(this.head, this.stage, this.stepsEl);
  }

  private button(label: string, d: string, run: () => void) {
    const b = document.createElement("button");
    b.className = "icon-btn sm";
    b.title = label;
    b.setAttribute("aria-label", label);
    const s = el("svg", { viewBox: "0 0 24 24", width: 14, height: 14, fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" });
    s.appendChild(el("path", { d }));
    b.appendChild(s);
    b.onclick = (e) => (e.stopPropagation(), run());
    return b;
  }

  /** the source drawn so far */
  get source(): string {
    return this.src;
  }

  /** the board's source as it stands; new strokes are drawn after the ones already there */
  update(src: string, done = false): void {
    // the chat may have moved this board into a new spot, which WebKit leaves blank until drawn again
    this.three?.wake();
    if (src === this.src && !done) return;
    const first = !this.src;
    this.src = src;
    if (first) this.instant = quiet() || seen.has(hashOf(src)) || !!this.opts.big;
    // the last line may still be arriving: wait for it to settle before drawing it
    clearTimeout(this.settle);
    const whole = done || this.instant;
    if (isProgram(src)) {
      // a program runs up to its last complete statement; the interpreter loads on the first one
      if (!engineReady()) {
        void loadEngine().then(() => !this.disposed && this.update(this.src, whole));
        return;
      }
      const ready = whole ? src : completePart(src);
      if (ready !== this.ran) {
        this.ran = ready;
        const out = runProgram(ready);
        // a statement that doesn't parse yet (the settle came mid-line): keep what was drawn
        if (out && !(out.broken && this.board)) this.render(out.board);
      }
    } else {
      const lines = src.split("\n");
      this.render(parseBoard(whole ? src : lines.slice(0, -1).join("\n")));
    }
    if (!done && !this.instant) this.settle = window.setTimeout(() => this.update(this.src, true), 700);
    if (done || this.instant) {
      this.hash = hashOf(src);
      // remembered once its drawing has had time to finish
      const left = Math.max(0, this.clock - performance.now());
      this.timers.push(window.setTimeout(() => remember(this.hash), left + 200));
    }
  }

  private render(b: Board) {
    this.board = b;
    this.titleEl.textContent = b.title ?? "";
    this.head.classList.toggle("bd-head-empty", !b.title);
    this.root.style.setProperty("--bd-ratio", `${b.w} / ${b.h}`);
    this.renderSteps(b);
    if (b.parts.length) this.render3d(b);
    else this.render2d(b);
  }

  private renderSteps(b: Board) {
    const texts = b.steps.map((s) => s.text).filter(Boolean);
    this.stepsEl.hidden = !texts.length;
    b.steps.forEach((s, i) => {
      let li = this.stepsEl.children[i] as HTMLLIElement | undefined;
      if (!li) {
        li = document.createElement("li");
        li.onclick = () => this.replay(i);
        li.title = t("이 단계부터 다시 그리기");
        this.stepsEl.appendChild(li);
      }
      if (li.textContent !== s.text) li.textContent = s.text;
      li.hidden = !s.text;
    });
    while (this.stepsEl.children.length > b.steps.length) this.stepsEl.lastElementChild!.remove();
  }

  private nowStep(i: number | null) {
    [...this.stepsEl.children].forEach((li, k) => li.classList.toggle("is-now", k === i));
    // while a step is drawn, what came before it steps back so the eye goes to the new part
    for (const d of this.drawn) {
      const past = i !== null && d.step < i;
      d.g.classList.toggle("bd-past", past);
      d.under?.classList.toggle("bd-past", past);
    }
  }

  /** when the next new piece may start, and the step marker for it */
  private slot(step: number, ms: number, gap = GAP): number {
    const now = performance.now();
    let at = Math.max(now, this.clock);
    if (step !== this.lastStep) {
      if (this.lastStep >= 0) at += STEP_GAP;
      const s = step;
      this.timers.push(window.setTimeout(() => this.nowStep(s), at - now));
      this.lastStep = step;
    }
    this.clock = at + ms + gap;
    return at - now;
  }

  private finish() {
    const left = Math.max(0, this.clock - performance.now());
    this.timers.push(window.setTimeout(() => this.nowStep(null), left + 300));
  }

  private render2d(b: Board) {
    if (!this.svg) {
      this.stage.textContent = "";
      this.svg = el("svg", { class: "bd-svg", role: "img" });
      this.underLayer = el("g", {});
      this.ink = el("g", {});
      this.penDot = el("g", { class: "bd-pen", visibility: "hidden" });
      this.penDot.append(el("circle", { r: 9, class: "bd-pen-glow" }), el("circle", { r: 3.5, class: "bd-pen-tip" }));
      this.svg.append(this.underLayer, this.ink, this.penDot);
      this.stage.appendChild(this.svg);
    }
    if (b.title) this.svg.setAttribute("aria-label", b.title);
    let added = false;
    b.marks.forEach((m, i) => {
      const key = JSON.stringify(m);
      const old = this.drawn[i];
      if (old?.key === key) return;
      const made = build(m);
      const d: Drawn = { key, step: m.step, ...made };
      if (old) {
        // changed while the line was still arriving: swap it in place, no second drawing
        old.g.replaceWith(d.g);
        if (old.under && d.under) old.under.replaceWith(d.under);
        else old.under?.remove();
      } else {
        this.ink!.appendChild(d.g);
        if (d.under) this.underLayer!.appendChild(d.under);
        if (!this.instant) { this.play(d); added = true; }
      }
      this.drawn[i] = d;
    });
    for (const d of this.drawn.slice(b.marks.length)) { d.g.remove(); d.under?.remove(); }
    this.drawn.length = b.marks.length;
    this.fit(b);
    if (added) this.finish();
  }

  /**
   * Only as tall as what is drawn (it grows downward as the board comes in; the scale
   * stays). Measured from the drawing itself when it is on screen, else from the marks.
   */
  private fit(b: Board) {
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    const take = (x0: number, y0: number, x1: number, y1: number) => { left = Math.min(left, x0); top = Math.min(top, y0); right = Math.max(right, x1); bottom = Math.max(bottom, y1); };
    const box = this.svg?.isConnected ? (() => { try { return [this.ink!.getBBox(), this.underLayer!.getBBox()]; } catch { return []; } })() : [];
    for (const r of box) if (r.width || r.height) take(r.x, r.y, r.x + r.width, r.y + r.height);
    if (!Number.isFinite(top)) for (const m of b.marks) take(...extent(m));
    const any = Number.isFinite(top) && Number.isFinite(bottom);
    // the width it was drawn for, widened only when something reaches past it
    const x0 = any ? Math.min(0, Math.floor(left - 16)) : 0;
    // as wide as the drawing (so a small one is not lost in empty paper), never narrower than 480
    const w = any ? Math.max(480, Math.ceil(right + 24) - x0) : b.w;
    const y0 = any ? Math.max(0, Math.floor(top - 24)) : 0;
    const h = any ? Math.max(140, Math.ceil(bottom + 24 - y0)) : b.h;
    this.svg!.setAttribute("viewBox", `${x0} ${y0} ${w} ${h}`);
    this.root.style.setProperty("--bd-ratio", `${w} / ${h}`);
  }

  private play(d: Drawn) {
    for (const p of d.pieces) {
      const delay = this.slot(d.step, p.kind === "pen" ? p.ms : Math.min(p.ms, 220));
      if (p.kind === "pen") this.pen(p.e, delay, p.ms);
      else this.anims.push(p.e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: p.ms, delay, easing: "ease-out", fill: "backwards" }));
    }
  }

  /** a stroke hidden until its turn, then drawn from start to end with the pen point on its tip */
  private pen(e: SVGElement, delay: number, ms: number) {
    e.style.strokeDasharray = "1 1";
    e.style.strokeDashoffset = "1";
    this.strokes.push({ e, at: performance.now() + delay, ms });
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = () => {
    this.raf = 0;
    const now = performance.now();
    let tip: { e: SVGElement; k: number } | undefined;
    this.strokes = this.strokes.filter((s) => {
      const p = (now - s.at) / s.ms;
      if (p >= 1) {
        s.e.style.strokeDasharray = "";
        s.e.style.strokeDashoffset = "";
        return false;
      }
      if (p > 0) {
        const k = ease(p);
        s.e.style.strokeDashoffset = String(1 - k);
        tip = { e: s.e, k };
      }
      return true;
    });
    const dot = this.penDot;
    if (dot) {
      const path = tip?.e as SVGPathElement | undefined;
      // a wide highlighter swipe has no pen point
      if (path && path.getTotalLength && Number(path.getAttribute("stroke-width")) < 4) {
        const at = path.getPointAtLength(path.getTotalLength() * tip!.k);
        dot.setAttribute("transform", `translate(${at.x.toFixed(1)} ${at.y.toFixed(1)})`);
        dot.setAttribute("visibility", "visible");
      } else if (!this.strokes.length || !tip) dot.setAttribute("visibility", "hidden");
    }
    if (this.strokes.length) this.raf = requestAnimationFrame(this.tick);
  };

  private render3d(b: Board) {
    if (!this.three) {
      if (this.threeLoading) return;
      this.threeLoading = true;
      this.stage.textContent = "";
      this.stage.classList.add("bd-3d");
      this.stage.appendChild(this.tag);
      void import("./three-view").then(({ createThreeView }) => {
        if (this.disposed) return;
        this.three = createThreeView(this.stage, { onPick: (i, at) => this.pick(i, at) });
        this.render3d(this.board!);
      });
      return;
    }
    // a step is built in about two seconds however many parts it has (a row of 40 pins comes in as a sweep)
    const per = new Map<number, number>();
    for (const p of b.parts) per.set(p.step, (per.get(p.step) ?? 0) + 1);
    const delays = this.instant ? undefined : b.parts.map((p, i) => (this.parts3d > i ? 0 : this.slot(p.step, Math.max(25, Math.min(420, 2200 / (per.get(p.step) ?? 1))), 0)));
    const grew = b.parts.length > this.parts3d;
    this.parts3d = b.parts.length;
    this.three.set(b.parts, delays);
    if (grew && !this.instant) this.finish();
  }
  private parts3d = 0;

  /** a part clicked: its name by it, and a way to ask about it */
  private pick(i: number | null, at?: { x: number; y: number }) {
    const p = i === null ? undefined : this.board?.parts[i];
    if (!p || !at) return void (this.tag.hidden = true);
    this.tag.textContent = "";
    const name = document.createElement("b");
    name.textContent = p.label;
    this.tag.append(name);
    if (this.opts.onAsk) {
      const ask = document.createElement("button");
      ask.className = "btn sm";
      ask.textContent = t("이 부분 묻기");
      ask.onclick = (e) => {
        e.stopPropagation();
        this.opts.onAsk!(this.board?.title ? `${this.board.title} · ${p.label}` : p.label);
        this.tag.hidden = true;
        this.three?.select(null);
      };
      this.tag.append(ask);
    }
    this.tag.style.left = `${Math.min(at.x, this.stage.clientWidth - 160)}px`;
    this.tag.style.top = `${Math.max(8, at.y - 44)}px`;
    this.tag.hidden = false;
  }

  /** draw again from a step (the steps before it stay as they are) */
  replay(from: number): void {
    if (!this.board) return;
    this.stopAll();
    this.instant = false;
    this.clock = performance.now();
    this.lastStep = -1;
    if (this.board.parts.length) {
      this.three?.set([], undefined);
      this.parts3d = 0;
      const keep = this.board.parts.filter((p) => p.step < from).length;
      this.three?.set(this.board.parts.slice(0, keep), undefined);
      this.parts3d = keep;
      this.render3d(this.board);
      return;
    }
    for (const d of this.drawn) if (d.step >= from) this.play(d);
    this.finish();
  }

  private stopAll() {
    for (const a of this.anims) a.cancel();
    this.anims = [];
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const s of this.strokes) { s.e.style.strokeDasharray = ""; s.e.style.strokeDashoffset = ""; }
    this.strokes = [];
    this.penDot?.setAttribute("visibility", "hidden");
    for (const id of this.timers) clearTimeout(id);
    this.timers = [];
    this.nowStep(null);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.settle);
    this.stopAll();
    this.three?.dispose();
    this.three = undefined;
  }
}
