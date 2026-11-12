// A board on screen: the drawing appears stroke by stroke in the order it explains,
// with the step being drawn named under it. A board already seen is shown whole.
// Plain DOM (no Solid) so a reply that is still streaming can move the same board
// into its re-rendered text and keep drawing where it was.
import { parseBoard, type Board, type Mark, type Tone } from "./parse";
import { box, head, polyline, ring, rng, swipe, type Pt } from "./sketch";
import type { ThreeView } from "./three-view";
import { t } from "../../i18n";

const SVG = "http://www.w3.org/2000/svg";
const INK: Record<Tone, string> = {
  ink: "var(--ink)", quiet: "var(--ink-3)", accent: "var(--accent)", ok: "var(--ok)", warn: "var(--warn)",
  bad: "var(--bad)", live: "var(--live)", violet: "var(--merged)",
};
const soft = (tone: Tone, pct = 12) => `color-mix(in srgb, ${INK[tone]} ${pct}%, transparent)`;

// pen pace
const PX_PER_MS = 0.9;
const GAP = 70;
const STEP_GAP = 450;
const stroke = (len: number) => Math.max(160, Math.min(900, len / PX_PER_MS));

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
function build(m: Mark, seed: number): { g: SVGGElement; under?: SVGElement; pieces: { e: SVGElement; ms: number; kind: "pen" | "fade" }[] } {
  const rand = rng(seed);
  const g = el("g", { class: "bd-mark" });
  const pieces: { e: SVGElement; ms: number; kind: "pen" | "fade" }[] = [];
  const pen = (d: string, len: number, width = 2.4) => {
    const p = el("path", { d, fill: "none", stroke: INK[m.tone], "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round", pathLength: 1 });
    if (m.dash) p.setAttribute("stroke-dasharray", "0.012 0.018");
    g.appendChild(p);
    pieces.push({ e: p, ms: stroke(len), kind: m.dash ? "fade" : "pen" });
    return p;
  };
  const words = (x: number, y: number, s: string, size: number, opts: { anchor?: string; bold?: boolean; tone?: Tone } = {}) => {
    const tx = el("text", { x, y, "font-size": size, "text-anchor": opts.anchor ?? "start", "dominant-baseline": "middle",
      fill: INK[opts.tone ?? (m.tone === "ink" ? "ink" : m.tone)], "font-weight": opts.bold ? 600 : 500 });
    tx.textContent = s;
    g.appendChild(tx);
    pieces.push({ e: tx, ms: Math.max(180, Math.min(600, s.length * 28)), kind: "fade" });
  };
  switch (m.kind) {
    case "box": {
      if (m.fill) { const f = el("rect", { x: m.x, y: m.y, width: m.w, height: m.h, rx: 10, fill: soft(m.tone) }); g.appendChild(f); pieces.push({ e: f, ms: 200, kind: "fade" }); }
      pen(box(m.x, m.y, m.w, m.h, rand), 2 * (m.w + m.h));
      if (m.label) words(m.x + m.w / 2, m.y + m.h / 2, m.label, Math.max(13, Math.min(20, m.h * 0.34)), { anchor: "middle", tone: m.tone === "quiet" ? "quiet" : "ink" });
      break;
    }
    case "circle": {
      if (m.fill) { const f = el("circle", { cx: m.x, cy: m.y, r: m.r, fill: soft(m.tone) }); g.appendChild(f); pieces.push({ e: f, ms: 200, kind: "fade" }); }
      pen(ring(m.x, m.y, m.r, rand), 2 * Math.PI * m.r);
      if (m.label) words(m.x, m.y, m.label, Math.max(13, Math.min(20, m.r * 0.45)), { anchor: "middle", tone: "ink" });
      break;
    }
    case "line":
    case "arrow":
    case "curve": {
      const pts = m.pts as Pt[];
      const len = pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
      pen(polyline(pts, rand, m.kind === "curve"), len);
      if (m.head) pen(head(pts[pts.length - 2], pts[pts.length - 1], rand), 30);
      if (m.label) {
        const mid = pts[Math.floor((pts.length - 1) / 2)], nxt = pts[Math.floor((pts.length - 1) / 2) + 1];
        const vertical = Math.abs(nxt[0] - mid[0]) < Math.abs(nxt[1] - mid[1]);
        words((mid[0] + nxt[0]) / 2 + (vertical ? 10 : 0), (mid[1] + nxt[1]) / 2 + (vertical ? 0 : -14), m.label, 15, { anchor: vertical ? "start" : "middle", tone: m.tone === "ink" ? "quiet" : m.tone });
      }
      break;
    }
    case "text":
      words(m.x, m.y, m.text, m.size, { bold: m.bold, tone: m.tone });
      break;
    case "mark": {
      const p = el("path", { d: swipe(m.x, m.y, m.w, m.h, rand), fill: "none", stroke: soft(m.tone, 38), "stroke-width": m.h, "stroke-linecap": "round", pathLength: 1 });
      pieces.push({ e: p, ms: stroke(m.w), kind: "pen" });
      return { g, under: p, pieces };
    }
    case "dot": {
      const d = el("circle", { cx: m.x, cy: m.y, r: m.r, fill: INK[m.tone] });
      g.appendChild(d);
      pieces.push({ e: d, ms: 140, kind: "fade" });
      break;
    }
  }
  return { g, pieces };
}

type Drawn = { key: string; g: SVGGElement; under?: SVGElement; pieces: { e: SVGElement; ms: number; kind: "pen" | "fade" }[]; step: number };

export type BoardOptions = { big?: boolean; onExpand?: (src: string) => void; onAsk?: (text: string) => void };

export class BoardView {
  readonly root: HTMLDivElement;
  private src = "";
  private board?: Board;
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

  /** the board's source as it stands; new strokes are drawn after the ones already there */
  update(src: string, done = false): void {
    if (src === this.src && !done) return;
    const first = !this.src;
    this.src = src;
    if (first) this.instant = quiet() || seen.has(hashOf(src)) || !!this.opts.big;
    // the last line may still be arriving: wait for it to settle before drawing it
    clearTimeout(this.settle);
    const lines = src.split("\n");
    const ready = done || this.instant ? src : lines.slice(0, -1).join("\n");
    this.render(parseBoard(ready));
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
  }

  /** when the next new piece may start, and the step marker for it */
  private slot(step: number, ms: number): number {
    const now = performance.now();
    let at = Math.max(now, this.clock);
    if (step !== this.lastStep) {
      if (this.lastStep >= 0) at += STEP_GAP;
      const s = step;
      this.timers.push(window.setTimeout(() => this.nowStep(s), at - now));
      this.lastStep = step;
    }
    this.clock = at + ms + GAP;
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
      this.svg.append(this.underLayer, this.ink);
      this.stage.appendChild(this.svg);
    }
    this.svg.setAttribute("viewBox", `0 0 ${b.w} ${b.h}`);
    if (b.title) this.svg.setAttribute("aria-label", b.title);
    let added = false;
    b.marks.forEach((m, i) => {
      const key = JSON.stringify(m);
      const old = this.drawn[i];
      if (old?.key === key) return;
      const made = build(m, i * 7919 + 17);
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
    if (added) this.finish();
  }

  private play(d: Drawn) {
    for (const p of d.pieces) {
      const delay = this.slot(d.step, p.kind === "pen" ? p.ms : Math.min(p.ms, 220));
      const frames = p.kind === "pen" ? [{ strokeDashoffset: 1, strokeDasharray: "1 1" }, { strokeDashoffset: 0, strokeDasharray: "1 1" }] : [{ opacity: 0 }, { opacity: 1 }];
      this.anims.push(p.e.animate(frames, { duration: p.ms, delay, easing: p.kind === "pen" ? "cubic-bezier(.35,.1,.25,1)" : "ease-out", fill: "backwards" }));
    }
  }

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
    const delays = this.instant ? undefined : b.parts.map((p, i) => (this.parts3d > i ? 0 : this.slot(p.step, 420)));
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
