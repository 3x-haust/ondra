// One file's change in CodeMirror, read-only, laid out as VS Code's diff editor: side by side (each
// side its own line numbers with − and + beside them, a sash between) or inline (the removed lines
// above the added, two columns of numbers). Unchanged stretches hide behind "n hidden lines" bars that
// show 20 more lines above or below, or all; an overview ruler on the right marks every change and
// scrolls. Or the applied file whole, its changed lines marked in the gutter as an editor marks them.
// Loaded only when the changes editor opens.
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import {
  Decoration, drawSelection, EditorView, gutter, GutterMarker, gutterLineClass, gutterWidgetClass, highlightSpecialChars, keymap,
  lineNumbers, lineNumberWidgetMarker, WidgetType, type BlockInfo, type DecorationSet,
} from "@codemirror/view";
import { Compartment, EditorState, RangeSet, RangeSetBuilder, StateEffect, StateField, Text, type Extension } from "@codemirror/state";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { defaultKeymap } from "@codemirror/commands";
import { Chunk, getChunks, getOriginalDoc, MergeView, unifiedMergeView } from "@codemirror/merge";
import { colors, theme } from "./Editor";
import { hiddenPart, resultMarks, revealRegion, stepChange, unchangedRegions, type Mark, type Region } from "./diffModel";
import { lang, t } from "../i18n";

export type DiffMode = "split" | "inline" | "result";
export interface DiffApi {
  next: () => void;
  prev: () => void;
  focus: () => void;
}

// ───────────── the look: the panel's diff colours, VS Code's shapes

const diffTheme = EditorView.theme({
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "var(--diff-del) !important" },
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "var(--diff-add) !important" },
  "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": { background: "var(--diff-del-strong) !important" },
  "&.cm-merge-b .cm-changedText": { background: "var(--diff-add-strong) !important" },
  "&.cm-merge-b .cm-deletedText": { background: "var(--diff-del-strong) !important" },
  ".cm-deletedChunk": { paddingLeft: "0 !important" },
  ".cm-deletedChunk .cm-deletedLine": { paddingLeft: "6px" },
  // the gutter beside a changed line takes its colour, as VS Code's does
  ".cm-gutterElement.cg-g-del": { backgroundColor: "var(--diff-del)" },
  ".cm-gutterElement.cg-g-add": { backgroundColor: "var(--diff-add)" },
  // opaque: code scrolled sideways goes under the line numbers, not through them
  ".cm-gutters": { backgroundColor: "var(--code-surface) !important" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 12px", minWidth: "4ch" },
  ".cg-ln-a .cm-gutterElement": { padding: "0 4px 0 12px", minWidth: "4ch", textAlign: "right", color: "var(--ink-4)" },
  ".cg-sign": { width: "14px" },
  ".cg-sign .cm-gutterElement": { textAlign: "center", color: "var(--ink-3)" },
  ".cg-stack > div": { height: "22px" },
  // where one side has no lines for the other's: VS Code's diagonal fill
  ".cm-mergeSpacer": {
    backgroundColor: "transparent",
    backgroundImage: "repeating-linear-gradient(-45deg, var(--line) 0 1px, transparent 1px 7px)",
  },
  // the hidden lines: a band across the gutter and the code
  ".cm-gutterElement.cg-band": { backgroundColor: "var(--code-sep)" },
  ".cg-hidden": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    height: "24px",
    padding: "0 8px",
    background: "var(--code-sep)",
    color: "var(--ink-3)",
    fontFamily: "var(--font)",
    fontSize: "var(--fs-xs)",
    cursor: "default",
    userSelect: "none",
  },
  ".cg-hidden-label": { cursor: "pointer" },
  ".cg-hidden-label:hover": { color: "var(--ink)" },
  ".cg-more": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "18px",
    height: "18px",
    padding: "0",
    border: "none",
    borderRadius: "3px",
    background: "transparent",
    color: "var(--ink-3)",
    cursor: "pointer",
  },
  ".cg-more:hover": { background: "var(--hover)", color: "var(--ink)" },
  ".cg-band-ctl": { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: "1px", height: "24px", paddingRight: "2px" },
  // the applied file's gutter: added, changed, removed just above
  ".cg-gutter": { width: "4px" },
  ".cg-gutter .cg-mark": { width: "3px", height: "100%" },
  ".cg-gutter .cg-mark.add": { background: "var(--ok)" },
  ".cg-gutter .cg-mark.mod": { background: "var(--accent)" },
  ".cg-gutter .cg-mark.del": { height: "0", width: "0", borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "5px solid var(--bad)", marginTop: "-4px" },
});

/** lucide's strokes, for the buttons drawn inside the editor (no Solid there) */
const STROKES = {
  up: ["m18 15-6-6-6 6"],
  down: ["m6 9 6 6 6-6"],
  unfold: ["M12 22v-6", "M12 8V2", "M4 12H2", "M10 12H8", "M16 12h-2", "M22 12h-2", "m15 19-3 3-3-3", "m15 5-3-3-3 3"],
};
function button(icon: keyof typeof STROKES, title: string, run: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "cg-more";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${STROKES[icon].map((d) => `<path d="${d}"/>`).join("")}</svg>`;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => (e.preventDefault(), e.stopPropagation(), run()));
  return b;
}

// ───────────── the hidden lines

type Reveal = (i: number, where: "above" | "below" | "all") => void;

class Hidden extends WidgetType {
  constructor(readonly i: number, readonly count: number, readonly reveal: Reveal) {
    super();
  }
  eq(o: Hidden) {
    return o.i === this.i && o.count === this.count;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cg-hidden";
    el.appendChild(button("unfold", t("숨긴 줄 모두 보기"), () => this.reveal(this.i, "all")));
    const label = el.appendChild(document.createElement("span"));
    label.className = "cg-hidden-label";
    label.textContent = t("{n}개 줄 숨김", { n: this.count });
    label.title = t("두 번 클릭하면 모두 펼쳐요");
    label.addEventListener("dblclick", (e) => (e.preventDefault(), this.reveal(this.i, "all")));
    return el;
  }
  ignoreEvent() {
    return true;
  }
  get estimatedHeight() {
    return 24;
  }
}
/** the band's part in the line numbers: 20 more above, 20 more below */
class HiddenControls extends GutterMarker {
  constructor(readonly w: Hidden) {
    super();
  }
  eq(o: HiddenControls) {
    return o.w.eq(this.w);
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cg-band-ctl";
    el.appendChild(button("up", t("위로 {n}줄 더 보기", { n: 20 }), () => this.w.reveal(this.w.i, "above")));
    el.appendChild(button("down", t("아래로 {n}줄 더 보기", { n: 20 }), () => this.w.reveal(this.w.i, "below")));
    return el;
  }
}
const setHidden = StateEffect.define<DecorationSet>();
const hiddenField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (d, tr) => tr.effects.reduce((x, e) => (e.is(setHidden) ? e.value : x), d),
  provide: (f) => EditorView.decorations.from(f),
});

// ───────────── the gutters: − and +, the old line numbers inline, the colour of a changed line

class ClassMarker extends GutterMarker {
  constructor(readonly elementClass: string) {
    super();
  }
}
const band = new ClassMarker("cg-band");
const delClass = new ClassMarker("cg-g-del");
const addClass = new ClassMarker("cg-g-add");
/** a column of lines (the old numbers, or −, beside the removed lines inline) */
class Stack extends GutterMarker {
  constructor(readonly lines: string[]) {
    super();
  }
  eq(o: Stack) {
    return o.lines.join("\n") === this.lines.join("\n");
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cg-stack";
    for (const l of this.lines) el.appendChild(document.createElement("div")).textContent = l;
    return el;
  }
}
const plus = new Stack(["+"]);
const minus = new Stack(["−"]);

class MarkDot extends GutterMarker {
  constructor(readonly kind: Mark) {
    super();
  }
  eq(o: MarkDot) {
    return o.kind === this.kind;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `cg-mark ${this.kind}`;
    return el;
  }
}

/** a chunk's lines on each side (1-based, `to` past the last; equal when empty there) */
interface Lines {
  fromA: number;
  toA: number;
  fromB: number;
  toB: number;
}
function lineRanges(chunks: readonly Chunk[], a: Text, b: Text): Lines[] {
  const first = (d: Text, p: number) => (p > d.length ? d.lines + 1 : d.lineAt(p).number);
  return chunks.map((c) => ({
    fromA: first(a, c.fromA),
    toA: c.toA > c.fromA ? a.lineAt(c.endA).number + 1 : first(a, c.fromA),
    fromB: first(b, c.fromB),
    toB: c.toB > c.fromB ? b.lineAt(c.endB).number + 1 : first(b, c.fromB),
  }));
}
/** a marker on every line of the given line ranges */
function onLines(doc: Text, ranges: [number, number][], marker: GutterMarker): RangeSet<GutterMarker> {
  const b = new RangeSetBuilder<GutterMarker>();
  for (const [from, to] of ranges) for (let l = from; l < to && l <= doc.lines; l++) b.add(doc.line(l).from, doc.line(l).from, marker);
  return b.finish();
}
const docOf = (s: string) => Text.of(s.split("\n"));

/** what the overview ruler marks: a change's place down the whole height (0..1), in which lane */
interface RulerMark {
  top: number;
  height: number;
  kind: "add" | "del" | "mod";
}
const RULER = 14;
/** where the sash between the two sides was left, for every file this session */
let split = 0.5;

export function DiffEditor(props: {
  path: string;
  a: string;
  b: string;
  mode: DiffMode;
  wrap: boolean;
  /** hide the unchanged stretches */
  collapse: boolean;
  /** a newly opened file goes to its first change, or its last when stepped back into */
  start?: "first" | "last";
  /** the change gone to (-1: the cursor moved on its own) of how many */
  onCount?: (cur: number, total: number) => void;
  /** F7 past the last change, ⇧F7 before the first */
  onEdge?: (dir: 1 | -1) => void;
  /** where the cursor is (the status bar) */
  onCursor?: (line: number, col: number) => void;
  /** the language the file is read as ("" when none) */
  onLanguage?: (name: string) => void;
  onEscape?: () => void;
  ref?: (api: DiffApi) => void;
}) {
  let root!: HTMLDivElement;
  let host!: HTMLDivElement;
  let merge: MergeView | undefined;
  let single: EditorView | undefined;
  /** the applied file's changes (that mode has no merge extension to ask) */
  let own: readonly Chunk[] = [];
  let ownMarks: [number, Mark][] = [];
  let regions: Region[] = [];
  let cur = -1;
  let moving = false;
  let shown = "";
  const grammar = new Compartment();
  const [marks, setMarks] = createSignal<RulerMark[]>([]);
  const [thumb, setThumb] = createSignal({ top: 0, height: 1 });
  const [sash, setSash] = createSignal(split);

  const target = () => merge?.b ?? single;
  const scroller = () => merge?.dom ?? single?.scrollDOM;
  const chunks = (): readonly Chunk[] => (merge ? merge.chunks : props.mode === "result" ? own : single ? (getChunks(single.state)?.chunks ?? []) : []);
  const docs = (): [Text, Text] | undefined => (merge ? [merge.a.state.doc, merge.b.state.doc] : single && props.mode === "inline" ? [getOriginalDoc(single.state), single.state.doc] : undefined);
  const ranges = (): Lines[] => {
    const d = docs();
    return d ? lineRanges(chunks(), d[0], d[1]) : [];
  };
  const report = () => props.onCount?.(cur, chunks().length);
  function cursorOf(v: EditorView | undefined) {
    if (!v) return;
    const head = v.state.selection.main.head;
    const line = v.state.doc.lineAt(head);
    props.onCursor?.(line.number, head - line.from + 1);
  }

  function go(i: number) {
    const v = target();
    const c = chunks()[i];
    if (!v || !c) return;
    cur = i;
    const pos = Math.min(c.fromB, v.state.doc.length);
    moving = true;
    v.dispatch({ selection: { anchor: pos } });
    moving = false;
    // scrolled to the middle by hand: CodeMirror's own scroll also moves the side's code sideways under its line numbers
    const s = scroller()!;
    const block = v.lineBlockAt(pos);
    const box = s.getBoundingClientRect();
    s.scrollTop += v.documentTop + block.top + block.height / 2 - box.top - s.clientHeight / 2;
    report();
  }
  function step(dir: 1 | -1) {
    const v = target();
    if (!v) return;
    const starts = chunks().map((c) => v.state.doc.lineAt(Math.min(c.fromB, v.state.doc.length)).number);
    const line = v.state.doc.lineAt(v.state.selection.main.head).number;
    const i = stepChange(starts, line, dir, cur >= 0 ? cur : undefined);
    if (i === null) props.onEdge?.(dir);
    else go(i);
  }

  // ── the hidden stretches, the same on both sides
  function paint() {
    const r = ranges();
    const d = docs();
    if (!d) return;
    const reveal: Reveal = (i, where) => {
      regions = regions.map((x, j) => (j === i ? revealRegion(x, where) : x));
      paint();
    };
    const decorate = (doc: Text, side: "a" | "b") => {
      const out = new RangeSetBuilder<Decoration>();
      regions.forEach((x, i) => {
        const h = hiddenPart(x);
        if (!h) return;
        const first = (side === "a" ? x.a : x.b) + h.from;
        const last = first + h.count - 1;
        if (first < 1 || last > doc.lines) return;
        out.add(doc.line(first).from, doc.line(last).to, Decoration.replace({ widget: new Hidden(i, h.count, reveal), block: true }));
      });
      return out.finish();
    };
    if (!regions.length && props.collapse) regions = unchangedRegions(r, d[0].lines, d[1].lines);
    if (merge) {
      merge.a.dispatch({ effects: setHidden.of(decorate(d[0], "a")) });
      merge.b.dispatch({ effects: setHidden.of(decorate(d[1], "b")) });
    } else single?.dispatch({ effects: setHidden.of(decorate(d[1], "b")) });
  }

  // ── the gutters for each layout
  /** side by side: one side's line numbers, − or + beside its changed lines, the band's buttons */
  function sideGutters(side: "a" | "b", doc: Text): Extension[] {
    const lines = ranges().map((c): [number, number] => (side === "a" ? [c.fromA, c.toA] : [c.fromB, c.toB]));
    const signs = onLines(doc, lines, side === "a" ? minus : plus);
    const tint = onLines(doc, lines, side === "a" ? delClass : addClass);
    return [
      lineNumbers(),
      lineNumberWidgetMarker.of((_v, w) => (w instanceof Hidden ? new HiddenControls(w) : null)),
      gutter({ class: "cg-sign", markers: () => signs, widgetMarker: () => null }),
      gutterLineClass.of(tint),
      gutterWidgetClass.of((_v, w) => (w instanceof Hidden ? band : null)),
    ];
  }
  /** inline: the old numbers, then the new, then − or +; the removed lines (a widget) get their old numbers */
  function inlineGutters(a: Text, b: Text, chunks: readonly Chunk[]): Extension[] {
    const r = lineRanges(chunks, a, b);
    // a new line's old number: the same line in an unchanged stretch, none in a change
    const old = new RangeSetBuilder<GutterMarker>();
    let shift = 0;
    let k = 0;
    for (let l = 1; l <= b.lines; l++) {
      while (k < r.length && l >= r[k].toB) (shift = r[k].toA - r[k].toB), k++;
      if (k < r.length && l >= r[k].fromB) continue;
      old.add(b.line(l).from, b.line(l).from, new Stack([String(l + shift)]));
    }
    const olds = old.finish();
    const removed = (block: BlockInfo) => {
      const i = chunks.findIndex((c) => c.fromB === block.from && c.toA > c.fromA);
      return i < 0 ? null : r[i];
    };
    const count = (x: Lines) => Array.from({ length: x.toA - x.fromA }, (_, j) => x.fromA + j);
    const lines = r.map((c): [number, number] => [c.fromB, c.toB]);
    return [
      gutter({
        class: "cg-ln-a",
        markers: () => olds,
        widgetMarker: (_v, w, block) => {
          if (w instanceof Hidden) return new HiddenControls(w);
          const x = removed(block);
          return x ? new Stack(count(x).map(String)) : null;
        },
        initialSpacer: () => new Stack([String(a.lines)]),
      }),
      lineNumbers(),
      gutter({
        class: "cg-sign",
        markers: () => onLines(b, lines, plus),
        widgetMarker: (_v, w, block) => {
          const x = w instanceof Hidden ? null : removed(block);
          return x ? new Stack(count(x).map(() => "−")) : null;
        },
      }),
      gutterLineClass.of(onLines(b, lines, addClass)),
      gutterWidgetClass.of((_v, w, block) => (w instanceof Hidden ? band : removed(block) ? delClass : null)),
    ];
  }

  const shared = (): Extension[] => [
    highlightSpecialChars(),
    drawSelection(),
    EditorState.readOnly.of(true),
    search({ top: true }),
    highlightSelectionMatches(),
    keymap.of([...searchKeymap, { key: "Escape", run: () => (props.onEscape?.(), !!props.onEscape) }, ...defaultKeymap]),
    grammar.of([]),
    hiddenField,
    theme,
    diffTheme,
    syntaxHighlighting(colors),
    props.wrap ? EditorView.lineWrapping : [],
    EditorView.updateListener.of((u) => {
      if (u.selectionSet && !moving && cur >= 0) {
        cur = -1;
        report();
      }
      if ((u.selectionSet && (u.view.hasFocus || u.view === target())) || (u.focusChanged && u.view.hasFocus)) cursorOf(u.view);
      if (u.heightChanged || u.geometryChanged || u.viewportChanged) queueRuler();
    }),
  ];
  const diffConfig = { scanLimit: 2000, timeout: 400 };

  function destroy() {
    merge?.destroy();
    single?.destroy();
    merge = single = undefined;
  }
  function build() {
    const same = shown === props.path;
    const top = same ? (scroller()?.scrollTop ?? 0) : 0;
    // the same file again (a refresh, another layout): the cursor and the change gone to stay
    const head = same ? target()?.state.selection.main.head : undefined;
    const was = same ? cur : -1;
    // stepping into the next file with F7 keeps the keys in the editor
    const had = host.contains(document.activeElement);
    destroy();
    cur = -1;
    regions = [];
    if (props.mode === "split") {
      const a = docOf(props.a);
      const b = docOf(props.b);
      merge = new MergeView({
        a: { doc: a, extensions: shared() },
        b: { doc: b, extensions: shared() },
        parent: host,
        gutter: false,
        highlightChanges: true,
        diffConfig,
      });
      merge.a.dispatch({ effects: StateEffect.appendConfig.of(sideGutters("a", merge.a.state.doc)) });
      merge.b.dispatch({ effects: StateEffect.appendConfig.of(sideGutters("b", merge.b.state.doc)) });
      (merge.a.dom.parentElement as HTMLElement).style.flex = `0 0 ${sash() * 100}%`;
    } else if (props.mode === "inline") {
      const a = docOf(props.a);
      const b = docOf(props.b);
      const c = Chunk.build(a, b, diffConfig);
      single = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: b,
          extensions: [
            shared(),
            inlineGutters(a, b, c),
            unifiedMergeView({ original: a, gutter: false, highlightChanges: true, syntaxHighlightDeletions: true, mergeControls: false, diffConfig }),
          ],
        }),
      });
    } else {
      const a = docOf(props.a);
      const b = docOf(props.b);
      own = Chunk.build(a, b, diffConfig);
      ownMarks = [...resultMarks(lineRanges(own, a, b), b.lines)];
      const set = RangeSet.of(ownMarks.filter(([l]) => l <= b.lines).sort((x, y) => x[0] - y[0]).map(([l, k]) => new MarkDot(k).range(b.line(l).from)));
      single = new EditorView({
        parent: host,
        state: EditorState.create({ doc: b, extensions: [shared(), lineNumbers(), gutter({ class: "cg-gutter", markers: () => set })] }),
      });
    }
    if (props.mode !== "result" && props.collapse) paint();
    scroller()?.addEventListener("scroll", queueRuler, { passive: true });
    const name = props.path.split("/").pop() ?? "";
    const path = props.path;
    const found = LanguageDescription.matchFilename(languages, name);
    props.onLanguage?.(found?.name ?? "");
    void found?.load().then((support) => {
      if (props.path !== path) return;
      for (const v of merge ? [merge.a, merge.b] : single ? [single] : []) v.dispatch({ effects: grammar.reconfigure(support) });
    });
    shown = props.path;
    if (had) target()?.focus();
    if (same) {
      const v = target();
      if (v && head !== undefined) {
        moving = true;
        v.dispatch({ selection: { anchor: Math.min(head, v.state.doc.length) } });
        moving = false;
      }
      cur = was < chunks().length ? was : -1;
      requestAnimationFrame(() => {
        const s = scroller();
        if (s) s.scrollTop = top;
      });
      report();
    } else if (chunks().length) go(props.start === "last" ? chunks().length - 1 : 0);
    else report();
    cursorOf(target());
    queueRuler();
  }

  // ── the overview ruler: every change down the whole height, and the part in view
  let rulerFrame = 0;
  function queueRuler() {
    if (!rulerFrame) rulerFrame = requestAnimationFrame(measureRuler);
  }
  function measureRuler() {
    rulerFrame = 0;
    const s = scroller();
    if (!s) return;
    const total = Math.max(s.scrollHeight, 1);
    setThumb({ top: s.scrollTop / total, height: Math.min(1, s.clientHeight / total) });
    const box = s.getBoundingClientRect();
    const at = (v: EditorView, from: number, to: number) => {
      const off = v.documentTop - box.top + s.scrollTop;
      const t0 = v.lineBlockAt(Math.min(from, v.state.doc.length)).top;
      const t1 = v.lineBlockAt(Math.min(Math.max(from, to - 1), v.state.doc.length)).bottom;
      return { top: (off + t0) / total, height: Math.max(t1 - t0, 0) / total };
    };
    const out: RulerMark[] = [];
    if (merge) {
      for (const c of merge.chunks) {
        if (c.toA > c.fromA) out.push({ ...at(merge.a, c.fromA, c.toA), kind: "del" });
        if (c.toB > c.fromB) out.push({ ...at(merge.b, c.fromB, c.toB), kind: "add" });
      }
    } else if (single && props.mode === "inline") {
      for (const c of chunks()) {
        const v = single;
        const block = v.lineBlockAt(Math.min(c.fromB, v.state.doc.length));
        const off = v.documentTop - box.top + s.scrollTop;
        if (c.toA > c.fromA) {
          // the removed lines sit above the line they were before
          const n = getOriginalDoc(v.state).lineAt(c.endA).number - getOriginalDoc(v.state).lineAt(c.fromA).number + 1;
          out.push({ top: (off + block.top) / total, height: (n * 20) / total, kind: "del" });
        }
        if (c.toB > c.fromB) out.push({ ...at(v, c.fromB, c.toB), kind: "add" });
      }
    } else if (single) {
      const v = single;
      const d = v.state.doc;
      for (const [line, kind] of ownMarks) if (line <= d.lines) out.push({ ...at(v, d.line(line).from, d.line(line).to + 1), kind });
    }
    setMarks(out);
  }
  let rulerEl!: HTMLDivElement;
  function rulerDown(e: PointerEvent) {
    const s = scroller();
    if (!s || e.button !== 0) return;
    e.preventDefault();
    const r = rulerEl.getBoundingClientRect();
    const th = thumb();
    const y = (e.clientY - r.top) / r.height;
    // on the slider: drag it from where it was taken; elsewhere: that place to the middle, then drag
    const grab = y >= th.top && y <= th.top + th.height ? y - th.top : th.height / 2;
    const to = (cy: number) => (s.scrollTop = ((cy - r.top) / r.height - grab) * s.scrollHeight);
    to(e.clientY);
    const move = (m: PointerEvent) => to(m.clientY);
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // ── the sash between the sides
  function sashDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const r = host.getBoundingClientRect();
    const move = (m: PointerEvent) => {
      const x = Math.min(0.85, Math.max(0.15, (m.clientX - r.left) / r.width));
      setSash(x);
      split = x;
      const wrap = merge?.a.dom.parentElement as HTMLElement | undefined;
      if (wrap) wrap.style.flex = `0 0 ${x * 100}%`;
    };
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up), root.classList.remove("sashing"));
    root.classList.add("sashing");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }
  const resetSash = () => {
    setSash((split = 0.5));
    const wrap = merge?.a.dom.parentElement as HTMLElement | undefined;
    if (wrap) wrap.style.flex = "0 0 50%";
  };

  // the language too: the hidden lines' label is in it
  createEffect(on(() => [props.path, props.a, props.b, props.mode, props.wrap, lang()], build));
  createEffect(
    on(
      () => props.collapse,
      (c) => {
        regions = [];
        if (!c) {
          for (const v of merge ? [merge.a, merge.b] : single ? [single] : []) v.dispatch({ effects: setHidden.of(Decoration.none) });
        } else if (props.mode !== "result") paint();
        queueRuler();
      },
      { defer: true },
    ),
  );
  onMount(() => {
    const ro = new ResizeObserver(queueRuler);
    ro.observe(host);
    onCleanup(() => ro.disconnect());
  });
  props.ref?.({ next: () => step(1), prev: () => step(-1), focus: () => target()?.focus() });
  onCleanup(() => {
    cancelAnimationFrame(rulerFrame);
    destroy();
  });
  return (
    <div class="cg-de" ref={root}>
      <div class="cg-cm" ref={host} />
      <Show when={props.mode === "split"}>
        <div
          class="cg-sash"
          style={{ left: `calc((100% - ${RULER}px) * ${sash()})` }}
          role="separator"
          aria-orientation="vertical"
          aria-label={t("두 쪽 사이 경계")}
          onPointerDown={sashDown}
          onDblClick={resetSash}
        />
      </Show>
      <div class="cg-ruler" ref={rulerEl} onPointerDown={rulerDown} aria-hidden="true">
        <For each={marks()}>{(m) => <span class={`cg-rm ${m.kind}`} style={{ top: `${m.top * 100}%`, height: `max(2px, ${m.height * 100}%)` }} />}</For>
        <span class="cg-thumb" classList={{ all: thumb().height >= 0.999 }} style={{ top: `${thumb().top * 100}%`, height: `${thumb().height * 100}%` }} />
      </div>
    </div>
  );
}
