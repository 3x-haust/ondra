// A board on screen: an explanation that builds up step by step. Each step's things
// appear at once (a short fade), what earlier steps drew steps back, and the only
// motion is what means something: a request travelling its way, a number counting,
// a ring around what this step is about. The steps can be paged through (click one,
// ← →, or play them from the start); with none picked the whole board shows.
// A 3D model is built part by part instead (three-view.ts).
// Plain DOM (no Solid) so a reply that is still streaming can move the same board
// into its re-rendered text and keep going where it was.
import { headings, labelSize, parseBoard, type Board, type Mark, type Tone } from "./parse";
import { completePart, engineReady, isProgram, loadEngine, runProgram } from "./program";
import { iconNode, iconsReady, loadIcons } from "./icons";
import { short } from "./names";
import { head, polyline, type Pt } from "./sketch";
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

// 3D parts come in over a step's couple of seconds; steps follow each other at reading pace
const GAP = 70;
const STEP_GAP = 450;
/** easing in and out */
const ease = (p: number) => 0.5 - Math.cos(Math.PI * p) / 2;
/** how long a step stays when the board plays itself: time to read it and watch what moves */
const dwell = (text: string, moving: boolean) => Math.max(moving ? 3200 : 2200, Math.min(7000, 900 + text.length * 75));

// boards already drawn once: shown whole when they come back (scrolling, reopening the job)
const SEEN_KEY = "ondra.boards.seen";
const seen = new Set<string>((() => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "[]") as string[]; } catch { return []; } })());
const remember = (h: string) => {
  seen.add(h);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-400))); } catch { /* private mode */ }
};
const hashOf = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };

const quiet = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

type Built = { g: SVGGElement; under?: SVGElement; motion?: Motion };
/** what moves while a mark's step is on */
type Motion =
  | { kind: "travel"; way: SVGPathElement; token: SVGGElement }
  | { kind: "count"; text: SVGTextElement; from: number; to: number; unit: string }
  | { kind: "pulse"; e: SVGElement };

/** a number as it reads: whole numbers with separators, else the decimals the values have */
function figure(v: number, from: number, to: number): string {
  const places = Math.min(3, Math.max(...[from, to].map((n) => (String(n).split(".")[1] ?? "").length)));
  return v.toLocaleString(undefined, { minimumFractionDigits: places, maximumFractionDigits: places });
}

/** an icon's elements into a group (drawn on a 24 grid, scaled to its size) */
function fillIcon(g: SVGGElement, name: string): boolean {
  const node = iconNode(name);
  if (!node) return false;
  g.textContent = "";
  for (const [tag, attrs] of node) {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) if (k !== "key") e.setAttribute(k, v);
    g.appendChild(e);
  }
  return true;
}

/** what one mark draws, as it finally looks */
function build(m: Mark): Built {
  const g = el("g", { class: "bd-mark" });
  const line = (d: string, width = "width" in m && m.width ? m.width : 1.8) => {
    const p = el("path", { d, fill: "none", stroke: m.color ?? LINE[m.tone], "stroke-width": width, "stroke-linecap": "round", "stroke-linejoin": "round" });
    if (m.dash) p.setAttribute("stroke-dasharray", "6 5");
    g.appendChild(p);
    return p;
  };
  const words = (x: number, y: number, s: string, size: number, opts: { anchor?: string; bold?: boolean; tone?: Tone; color?: string; free?: boolean } = {}) => {
    const tx = el("text", { x, y, "font-size": size, "text-anchor": opts.anchor ?? "start", "dominant-baseline": "middle",
      fill: opts.color ?? INK[opts.tone ?? (m.tone === "ink" ? "ink" : m.tone)], "font-weight": opts.bold ? 600 : 500 });
    // words standing on the paper (not inside a shape) keep a little paper around them, so a line under them doesn't cut them
    if (opts.free) tx.setAttribute("class", "bd-free");
    tx.textContent = s;
    g.appendChild(tx);
    return tx;
  };
  switch (m.kind) {
    case "box": {
      const r = Math.min(8, m.w / 4, m.h / 4);
      g.appendChild(el("rect", { x: m.x, y: m.y, width: m.w, height: m.h, rx: r, fill: m.bare ? "none" : soft(m.tone, m.fill ? 20 : m.tone === "ink" && !m.color ? 4 : 10, m.color),
        stroke: m.color ?? LINE[m.tone], "stroke-width": m.bare ? 1.2 : 1.8, ...(m.dash ? { "stroke-dasharray": "6 5" } : {}) }));
      if (m.label) words(m.x + m.w / 2, m.labelY ?? m.y + m.h / 2, m.label, labelSize(m), { anchor: "middle", tone: m.tone === "quiet" ? "quiet" : "ink" });
      break;
    }
    case "circle": {
      g.appendChild(el("circle", { cx: m.x, cy: m.y, r: m.r, fill: soft(m.tone, m.fill ? 20 : m.tone === "ink" && !m.color ? 4 : 10, m.color),
        stroke: m.color ?? LINE[m.tone], "stroke-width": 1.8, ...(m.dash ? { "stroke-dasharray": "6 5" } : {}) }));
      if (m.label) words(m.x, m.y, m.label, m.size ?? Math.max(13, Math.min(20, m.r * 0.45)), { anchor: "middle", tone: "ink" });
      break;
    }
    case "line":
    case "arrow":
    case "curve": {
      const pts = m.pts as Pt[];
      line(polyline(pts, m.kind === "curve"), 1.6);
      if (m.head) line(head(pts[pts.length - 2], pts[pts.length - 1]), 1.6);
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
      if (m.fill) g.appendChild(el("path", { d: m.d, fill: soft(m.tone, 22, m.color), stroke: "none" }));
      line(m.d);
      break;
    }
    case "mark": {
      const p = el("rect", { x: m.x - 2, y: m.y, width: m.w + 4, height: m.h, rx: Math.min(6, m.h / 2), fill: soft(m.tone, 38, m.color) });
      return { g, under: p };
    }
    case "dot":
      g.appendChild(el("circle", { cx: m.x, cy: m.y, r: m.r, fill: m.color ?? INK[m.tone] }));
      break;
    case "icon": {
      // the picture on a soft tile, its name under it
      const k = m.size / 24;
      const tile = el("rect", { x: m.x - 6, y: m.y - 6, width: m.size + 12, height: m.size + 12, rx: Math.min(14, m.size / 4), fill: soft(m.tone, m.tone === "ink" && !m.color ? 5 : 12, m.color) });
      const pic = el("g", { transform: `translate(${m.x} ${m.y}) scale(${k})`, fill: "none", stroke: m.color ?? INK[m.tone], "stroke-width": 1.75, "stroke-linecap": "round", "stroke-linejoin": "round", "data-icon": m.name });
      g.append(tile, pic);
      // unknown (or not loaded yet): a plain tile with the name in it until the pictures come
      if (!fillIcon(pic, m.name)) pic.appendChild(el("rect", { x: 3, y: 3, width: 18, height: 18, rx: 4, "stroke-dasharray": "2 2", "stroke-width": 1 }));
      if (m.label) words(m.x + m.size / 2, m.y + m.size + 20, m.label, 14, { anchor: "middle", tone: "ink", free: true });
      break;
    }
    case "travel": {
      // the way it goes is drawn by connect(); here only what goes along it
      const way = el("path", { d: polyline(m.pts as Pt[], !!m.curve), fill: "none", stroke: "none" });
      const token = el("g", { class: "bd-token" });
      token.appendChild(el("circle", { r: m.r + 5, fill: soft(m.tone, 22, m.color) }));
      token.appendChild(el("circle", { r: m.r, fill: m.color ?? INK[m.tone] }));
      if (m.label) {
        const tx = el("text", { y: -m.r - 10, "font-size": 13, "text-anchor": "middle", "font-weight": 600, fill: m.color ?? INK[m.tone], class: "bd-free" });
        tx.textContent = m.label;
        token.appendChild(tx);
      }
      g.append(way, token);
      return { g, motion: { kind: "travel", way, token } };
    }
    case "count": {
      const tx = words(m.x, m.y, figure(m.to, m.from, m.to) + (m.unit ?? ""), m.size, { bold: m.bold, tone: m.tone, color: m.color, anchor: m.align, free: true });
      return { g, motion: { kind: "count", text: tx, from: m.from, to: m.to, unit: m.unit ?? "" } };
    }
    case "pulse": {
      const r = el("rect", { x: m.x, y: m.y, width: m.w, height: m.h, rx: Math.min(14, m.h / 3), fill: "none", stroke: m.color ?? INK[m.tone], "stroke-width": 2, class: "bd-pulse" });
      g.appendChild(r);
      return { g, motion: { kind: "pulse", e: r } };
    }
  }
  return { g };
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
    case "icon": return [m.x - 6, m.y - 6, m.x + m.size + 6, m.y + m.size + (m.label ? 30 : 6)];
    case "pulse": return [m.x, m.y, m.x + m.w, m.y + m.h];
    case "count": {
      const w = (String(m.to).length + (m.unit?.length ?? 0)) * m.size * 0.62, x0 = m.align === "middle" ? m.x - w / 2 : m.align === "end" ? m.x - w : m.x;
      return [x0, m.y - m.size, x0 + w, m.y + m.size];
    }
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

type Drawn = { key: string; g: SVGGElement; under?: SVGElement; motion?: Motion; step: number };

type BoardOptions = { big?: boolean; onExpand?: (src: string) => void; onAsk?: (text: string) => void };

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
  private underLayer?: SVGGElement;
  /** the step being looked at; null: the whole board */
  private focus: number | null = null;
  /** while it streams in, the newest step is shown, until the user picks one */
  private live = true;
  private playing = 0;
  private motionRaf = 0;
  private motionFrom = 0;
  private three?: ThreeView;
  private threeLoading = false;
  private disposed = false;
  private readonly head: HTMLDivElement;
  private readonly titleEl: HTMLSpanElement;
  private readonly stage: HTMLDivElement;
  private readonly stepsEl: HTMLOListElement;
  private readonly tag: HTMLDivElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly againBtn: HTMLButtonElement;

  constructor(private readonly opts: BoardOptions = {}) {
    this.root = document.createElement("div");
    this.root.className = `bd${opts.big ? " bd-big" : ""}`;
    this.root.tabIndex = 0;
    this.root.addEventListener("keydown", (e) => this.key(e));
    this.head = document.createElement("div");
    this.head.className = "bd-head";
    this.titleEl = document.createElement("span");
    this.titleEl.className = "bd-title";
    const tools = document.createElement("span");
    tools.className = "bd-tools";
    this.playBtn = this.button(t("처음부터 보기"), "M7 5v14l11-7z", () => (this.playing ? this.stop() : this.play()));
    this.againBtn = this.button(t("다시 그리기"), "M4 12a8 8 0 1 0 2.3-5.6M4 4v4h4", () => this.replay(0));
    this.againBtn.style.display = "none";
    tools.append(this.playBtn, this.againBtn);
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

  /** the board's source as it stands; what is new appears after what is already there */
  update(src: string, done = false): void {
    // the chat may have moved this board into a new spot, which WebKit leaves blank until drawn again
    this.three?.wake();
    if (src === this.src && !done) return;
    const first = !this.src;
    this.src = src;
    if (first) this.instant = quiet() || seen.has(hashOf(src)) || !!this.opts.big;
    this.draw(done);
  }

  /** draw the source as it stands (update decides whether there is anything new) */
  private draw(done: boolean): void {
    const src = this.src;
    // the last line may still be arriving: wait for it to settle before drawing it
    clearTimeout(this.settle);
    const whole = done || this.instant;
    if (isProgram(src)) {
      // a program runs up to its last complete statement; the interpreter loads on the first one.
      // Once it has, draw what is there now: going through update would see the same source and
      // skip it, leaving a board that arrived whole (a reopened chat) blank
      if (!engineReady()) {
        void loadEngine().then(() => !this.disposed && this.draw(done));
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
      // finished: the whole board, unless the user is looking at a step
      if (this.live && !this.board?.parts.length) {
        this.live = false;
        this.show(null);
      }
      const left = Math.max(0, this.clock - performance.now());
      this.timers.push(window.setTimeout(() => remember(this.hash), left + 200));
    }
  }

  private render(b: Board) {
    this.board = b;
    this.titleEl.textContent = b.title ?? "";
    this.head.classList.toggle("bd-head-empty", !b.title);
    this.root.style.setProperty("--bd-ratio", `${b.w} / ${b.h}`);
    const solid = b.parts.length > 0;
    // (display, not hidden: the button's own style would show it anyway)
    this.playBtn.style.display = solid || b.steps.filter((x) => x.text).length < 2 ? "none" : "";
    this.againBtn.style.display = solid ? "" : "none";
    this.renderSteps(b);
    if (solid) this.render3d(b);
    else this.render2d(b);
  }

  private renderSteps(b: Board) {
    const texts = b.steps.map((s) => s.text).filter(Boolean);
    this.stepsEl.hidden = !texts.length;
    b.steps.forEach((s, i) => {
      let li = this.stepsEl.children[i] as HTMLLIElement | undefined;
      if (!li) {
        li = document.createElement("li");
        // a 3D model is built again from that step; a drawing shows that step (again: the whole board)
        li.onclick = () => (this.board?.parts.length ? this.replay(i) : (this.stop(), this.live = false, this.show(this.focus === i ? null : i, true)));
        this.stepsEl.appendChild(li);
      }
      li.title = b.parts.length ? t("이 단계부터 다시 그리기") : t("이 단계 보기");
      if (li.textContent !== s.text) li.textContent = s.text;
      li.hidden = !s.text;
    });
    while (this.stepsEl.children.length > b.steps.length) this.stepsEl.lastElementChild!.remove();
  }

  /** the 3D build's marker on the step being built */
  private nowStep(i: number | null) {
    [...this.stepsEl.children].forEach((li, k) => li.classList.toggle("is-now", k === i));
  }

  /** when the next new piece may start, and the step marker for it (3D) */
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
      this.svg.append(this.underLayer, this.ink);
      this.stage.appendChild(this.svg);
      if (this.opts.onAsk) {
        this.stage.appendChild(this.tag);
        this.lasso();
      }
    }
    if (b.title) this.svg.setAttribute("aria-label", b.title);
    const marks = headings(b.marks);
    const fresh: Drawn[] = [];
    let icons = false;
    marks.forEach((m, i) => {
      if (m.kind === "icon") icons = true;
      const key = JSON.stringify(m);
      const old = this.drawn[i];
      if (old?.key === key) return;
      const d: Drawn = { key, step: m.step, ...build(m) };
      if (old) {
        // changed while the line was still arriving: swap it in place
        old.g.replaceWith(d.g);
        if (old.under && d.under) old.under.replaceWith(d.under);
        else old.under?.remove();
      } else {
        this.ink!.appendChild(d.g);
        if (d.under) this.underLayer!.appendChild(d.under);
        fresh.push(d);
      }
      this.drawn[i] = d;
    });
    for (const d of this.drawn.slice(b.marks.length)) { d.g.remove(); d.under?.remove(); }
    this.drawn.length = b.marks.length;
    // the pictures load once; boards drawn before they came get them now
    if (icons && !iconsReady()) void loadIcons().then(() => {
      if (this.disposed || !this.svg) return;
      for (const g of this.svg.querySelectorAll<SVGGElement>("g[data-icon]")) fillIcon(g, g.dataset.icon!);
    });
    this.fit(b);
    // streaming: the newest step is the one shown; finished or seen before: the whole board
    if (this.live && !this.instant) this.show(Math.max(0, b.steps.length - 1), false, fresh);
    else this.show(this.focus, false, this.instant ? [] : fresh);
  }

  /**
   * Show one step (what came before it steps back, what comes after waits) or, with null,
   * the whole board. Things new to the eye fade in; the step's motion starts.
   */
  private show(i: number | null, user = false, fresh: Drawn[] = []) {
    const last = (this.board?.steps.length ?? 1) - 1;
    if (i !== null) i = Math.max(0, Math.min(last, i));
    const was = this.focus;
    this.focus = i;
    const appear: Drawn[] = [...fresh];
    for (const d of this.drawn) {
      const ahead = i !== null && d.step > i;
      const past = i !== null && d.step < i;
      const wasHidden = d.g.getAttribute("visibility") === "hidden";
      for (const e of [d.g, d.under]) {
        if (!e) continue;
        e.setAttribute("visibility", ahead ? "hidden" : "visible");
        e.classList.toggle("bd-past", past);
      }
      if (!ahead && wasHidden && !fresh.includes(d)) appear.push(d);
    }
    [...this.stepsEl.children].forEach((li, k) => {
      li.classList.toggle("is-now", k === i);
      li.classList.toggle("is-ahead", i !== null && k > i);
    });
    this.root.classList.toggle("bd-focused", i !== null);
    if (!quiet()) {
      appear.filter((d) => d.g.getAttribute("visibility") !== "hidden").forEach((d, k) => {
        for (const e of [d.g, d.under]) if (e) this.anims.push(e.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: Math.min(k * 28, 360), easing: "ease-out", fill: "backwards" }));
      });
    }
    if (user || was !== i || fresh.length) this.moveFrom(i);
  }

  /** the motion of the step shown: tokens travel their way, numbers count, a ring breathes */
  private moveFrom(i: number | null) {
    cancelAnimationFrame(this.motionRaf);
    this.motionRaf = 0;
    const on = this.drawn.filter((d) => d.motion && i !== null && d.step === i);
    for (const d of this.drawn) {
      const m = d.motion;
      if (!m) continue;
      const active = on.includes(d);
      if (m.kind === "travel") m.token.setAttribute("visibility", active ? "visible" : "hidden");
      if (m.kind === "pulse") m.e.classList.toggle("is-on", active && !quiet());
      if (m.kind === "count" && !active) m.text.textContent = figure(m.to, m.from, m.to) + m.unit;
      if (m.kind === "pulse" && !active) d.g.setAttribute("visibility", "hidden");
      if (m.kind === "pulse" && active) d.g.setAttribute("visibility", "visible");
    }
    if (!on.length || quiet()) {
      for (const d of on) if (d.motion?.kind === "travel") this.place(d.motion, 1);
      return;
    }
    this.motionFrom = performance.now();
    const frame = () => {
      const ms = performance.now() - this.motionFrom;
      let more = false;
      for (const d of on) {
        const m = d.motion!;
        if (m.kind === "travel") {
          // along its way, a short rest at the end, again
          const len = m.way.getTotalLength?.() ?? 0;
          const go = Math.max(900, Math.min(2400, len * 4)), cycle = go + 700;
          this.place(m, ease(Math.min(1, (ms % cycle) / go)));
          more = true;
        } else if (m.kind === "count") {
          const k = Math.min(1, ms / 1100);
          m.text.textContent = figure(m.from + (m.to - m.from) * ease(k), m.from, m.to) + m.unit;
          if (k < 1) more = true;
        }
      }
      this.motionRaf = more && !this.disposed ? requestAnimationFrame(frame) : 0;
    };
    this.motionRaf = requestAnimationFrame(frame);
  }

  private place(m: Extract<Motion, { kind: "travel" }>, k: number) {
    const len = m.way.getTotalLength?.() ?? 0;
    if (!len) return;
    const at = m.way.getPointAtLength(len * k);
    m.token.setAttribute("transform", `translate(${at.x.toFixed(1)} ${at.y.toFixed(1)})`);
  }

  /** the steps one after another from the first, at reading pace, then the whole board */
  private play() {
    if (!this.board || this.board.parts.length) return;
    this.stop();
    this.live = false;
    const steps = this.board.steps;
    const go = (i: number) => {
      if (i >= steps.length) return this.stop(true);
      this.show(i, true);
      const moving = this.drawn.some((d) => d.step === i && d.motion);
      this.playing = window.setTimeout(() => go(i + 1), dwell(steps[i].text, moving));
    };
    this.root.classList.add("bd-playing");
    go(0);
  }

  private stop(toWhole = false) {
    clearTimeout(this.playing);
    this.playing = 0;
    this.root.classList.remove("bd-playing");
    if (toWhole) this.show(null, true);
  }

  private key(e: KeyboardEvent) {
    if (!this.board || this.board.parts.length) return;
    const last = this.board.steps.length - 1;
    const at = this.focus;
    let next: number | null | undefined;
    if (e.key === "ArrowRight") next = at === null ? 0 : at >= last ? null : at + 1;
    else if (e.key === "ArrowLeft") next = at === null ? last : at <= 0 ? null : at - 1;
    else if (e.key === "Escape" && this.svg?.classList.contains("bd-picking")) return void (e.preventDefault(), this.unpick());
    else if (e.key === "Escape" && at !== null) next = null;
    if (next === undefined) return;
    e.preventDefault();
    this.stop();
    this.live = false;
    this.show(next, true);
  }

  /**
   * Only as tall as what is drawn (steps still to come count: the board doesn't jump
   * as they show). Measured from the drawing itself when it is on screen, else from the marks.
   */
  private fit(b: Board) {
    let top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    const take = (x0: number, y0: number, x1: number, y1: number) => { left = Math.min(left, x0); top = Math.min(top, y0); right = Math.max(right, x1); bottom = Math.max(bottom, y1); };
    const box = this.svg?.isConnected ? (() => { try { return [this.ink!.getBBox(), this.underLayer!.getBBox()]; } catch { return []; } })() : [];
    for (const r of box) if (r.width || r.height) take(r.x, r.y, r.x + r.width, r.y + r.height);
    if (!Number.isFinite(top)) for (const m of b.marks) take(...extent(m));
    const any = Number.isFinite(top) && Number.isFinite(bottom);
    const x0 = any ? Math.min(0, Math.floor(left - 16)) : 0;
    const w = any ? Math.max(480, Math.ceil(right + 24) - x0) : b.w;
    const y0 = any ? Math.max(0, Math.floor(top - 24)) : 0;
    const h = any ? Math.max(140, Math.ceil(bottom + 24 - y0)) : b.h;
    this.svg!.setAttribute("viewBox", `${x0} ${y0} ${w} ${h}`);
    this.root.style.setProperty("--bd-ratio", `${w} / ${h}`);
  }

  private render3d(b: Board) {
    if (!this.three) {
      if (this.threeLoading || this.asleep) return;
      this.threeLoading = true;
      this.stage.textContent = "";
      this.stage.classList.add("bd-3d");
      this.stage.appendChild(this.tag);
      void import("./three-view").then(({ createThreeView }) => {
        if (this.disposed) return;
        this.threeLoading = false;
        this.three = createThreeView(this.stage, { onPick: (i, at) => this.pick(i, at), onLost: () => this.lost() });
        this.watch();
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
  private asleep = false;
  private revived = 0;
  private io?: IntersectionObserver;
  private nap = 0;

  /** let go of the 3D view (and its GPU context) and build it again, at once and whole, when wanted */
  private release() {
    this.three?.dispose();
    this.three = undefined;
    this.parts3d = 0;
    this.tag.hidden = true;
  }
  private rebuild() {
    if (!this.board?.parts.length || this.disposed) return;
    this.instant = true;
    this.render3d(this.board);
  }
  /** the GPU context was taken away: a new view in its place (a few times at most) */
  private lost() {
    queueMicrotask(() => {
      this.release();
      if (this.revived++ < 3) this.rebuild();
    });
  }
  /** a 3D board out of sight for a while gives its GPU context back; it is rebuilt when seen again */
  private watch() {
    if (this.io) return;
    this.io = new IntersectionObserver((es) => {
      const seen = es.some((e) => e.isIntersecting);
      clearTimeout(this.nap);
      if (seen && this.asleep) {
        this.asleep = false;
        this.rebuild();
      } else if (!seen && this.three) {
        this.nap = window.setTimeout(() => { this.asleep = true; this.release(); }, 4000);
      }
    });
    this.io.observe(this.stage);
  }

  /** A drag across the drawing picks what it covers: the rest steps back, and what the picked
   *  marks say can go to the composer as a quote (인용). */
  private lasso() {
    let from: { x: number; y: number; cx: number; cy: number } | null = null;
    let box: HTMLDivElement | null = null;
    const stage = this.stage;
    stage.classList.add("bd-pickable");
    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.svg || this.three || (e.target as Element).closest(".bd-tag")) return;
      this.unpick();
      const r = stage.getBoundingClientRect();
      from = { x: e.clientX - r.left, y: e.clientY - r.top, cx: e.clientX, cy: e.clientY };
    });
    stage.addEventListener("pointermove", (e) => {
      if (!from) return;
      if (!box && Math.hypot(e.clientX - from.cx, e.clientY - from.cy) < 6) return;
      if (!box) {
        box = document.createElement("div");
        box.className = "bd-lasso";
        stage.appendChild(box);
        stage.setPointerCapture(e.pointerId);
      }
      const r = stage.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      Object.assign(box.style, { left: `${Math.min(x, from.x)}px`, top: `${Math.min(y, from.y)}px`, width: `${Math.abs(x - from.x)}px`, height: `${Math.abs(y - from.y)}px` });
    });
    const end = (e: PointerEvent) => {
      if (box && from) this.pickArea(from.cx, from.cy, e.clientX, e.clientY);
      box?.remove();
      box = null;
      from = null;
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", () => (box?.remove(), (box = null), (from = null)));
  }

  /** the marks inside a dragged area (screen points), what they say, and a 인용 button by it */
  private pickArea(x1: number, y1: number, x2: number, y2: number) {
    const ctm = this.svg?.getScreenCTM()?.inverse();
    if (!ctm) return;
    const a = new DOMPoint(Math.min(x1, x2), Math.min(y1, y2)).matrixTransform(ctm);
    const b = new DOMPoint(Math.max(x1, x2), Math.max(y1, y2)).matrixTransform(ctm);
    const picked = this.drawn
      .filter((d) => d.g.getAttribute("visibility") !== "hidden")
      .map((d) => {
        try {
          return { d, r: d.g.getBBox() };
        } catch {
          return undefined;
        }
      })
      .filter((x): x is { d: Drawn; r: DOMRect } => !!x && x.r.x < b.x && x.r.x + x.r.width > a.x && x.r.y < b.y && x.r.y + x.r.height > a.y);
    // what they say, top to bottom, left to right, each once
    const said = [...new Set(
      picked
        .sort((p, q) => p.r.y - q.r.y || p.r.x - q.r.x)
        .flatMap((p) => [...p.d.g.querySelectorAll("text")].map((x) => x.textContent?.trim() ?? ""))
        .filter(Boolean),
    )];
    if (!picked.length || !said.length) return;
    this.svg!.classList.add("bd-picking");
    for (const p of picked) p.d.g.classList.add("bd-picked");
    this.tag.textContent = "";
    const name = document.createElement("b");
    name.textContent = short(said.join(" · "));
    this.tag.append(name);
    const ask = document.createElement("button");
    ask.className = "btn sm";
    ask.textContent = t("인용");
    ask.onclick = (e) => {
      e.stopPropagation();
      this.opts.onAsk!(`${this.board?.title ? `${this.board.title} · ` : ""}${said.join(", ")}`);
      this.unpick();
    };
    this.tag.append(ask);
    const s = this.stage.getBoundingClientRect();
    this.tag.style.left = `${Math.max(8, Math.min(Math.max(x1, x2) - s.left - 120, this.stage.clientWidth - 220))}px`;
    this.tag.style.top = `${Math.max(8, Math.min(y1, y2) - s.top - 44)}px`;
    this.tag.hidden = false;
  }

  private unpick() {
    if (!this.svg?.classList.contains("bd-picking")) return;
    this.svg.classList.remove("bd-picking");
    for (const g of this.svg.querySelectorAll(".bd-picked")) g.classList.remove("bd-picked");
    this.tag.hidden = true;
  }

  /** a part clicked: its name by it, and a way to ask about it */
  private pick(i: number | null, at?: { x: number; y: number }) {
    const p = i === null ? undefined : this.board?.parts[i];
    if (!p || !at) return void (this.tag.hidden = true);
    this.tag.textContent = "";
    // a part with no name of its own (a pin in a row) goes by the nearest named part of its step, or the step
    const dist = (q: typeof p) => Math.hypot(q.at[0] - p.at[0], q.at[1] - p.at[1], q.at[2] - p.at[2]);
    const kin = this.board!.parts.filter((q) => q.label && q.step === p.step).sort((a, b) => dist(a) - dist(b))[0];
    const label = short(p.label) || (kin ? short(kin.label) : "") || this.board!.steps[p.step]?.text || "";
    if (!label) return void (this.tag.hidden = true);
    const name = document.createElement("b");
    name.textContent = label;
    this.tag.append(name);
    if (this.opts.onAsk) {
      const ask = document.createElement("button");
      ask.className = "btn sm";
      ask.textContent = t("이 부분 묻기");
      ask.onclick = (e) => {
        e.stopPropagation();
        this.opts.onAsk!(this.board?.title ? `${this.board.title} · ${label}` : label);
        this.tag.hidden = true;
        this.three?.select(null);
      };
      this.tag.append(ask);
    }
    this.tag.style.left = `${Math.min(at.x, this.stage.clientWidth - 160)}px`;
    this.tag.style.top = `${Math.max(8, at.y - 44)}px`;
    this.tag.hidden = false;
  }

  /** build a 3D model again from a step (the steps before it stay as they are) */
  replay(from: number): void {
    if (!this.board) return;
    if (!this.board.parts.length) return this.show(from, true);
    this.stopAll();
    this.instant = false;
    this.clock = performance.now();
    this.lastStep = -1;
    this.three?.set([], undefined);
    this.parts3d = 0;
    const keep = this.board.parts.filter((p) => p.step < from).length;
    this.three?.set(this.board.parts.slice(0, keep), undefined);
    this.parts3d = keep;
    this.render3d(this.board);
  }

  private stopAll() {
    for (const a of this.anims) a.cancel();
    this.anims = [];
    cancelAnimationFrame(this.motionRaf);
    this.motionRaf = 0;
    clearTimeout(this.playing);
    this.playing = 0;
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
    this.io?.disconnect();
    clearTimeout(this.nap);
  }
}
