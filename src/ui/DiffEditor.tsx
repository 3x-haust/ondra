// One file's change in CodeMirror, read-only: side by side (MergeView), inline
// (unifiedMergeView), or the applied file whole with its changed lines marked in
// the gutter. Unchanged stretches fold ("n줄 펼치기"); F7 / ⇧F7 step through the
// changes as in VS Code. Loaded only when the changes editor opens.
import { createEffect, on, onCleanup } from "solid-js";
import { drawSelection, EditorView, gutter, GutterMarker, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { Compartment, EditorState, RangeSet, Text, type Extension } from "@codemirror/state";
import { LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { defaultKeymap } from "@codemirror/commands";
import { Chunk, getChunks, MergeView, unifiedMergeView } from "@codemirror/merge";
import { colors, theme } from "./Editor";
import { resultMarks, stepChange, type Mark } from "./diffModel";
import { lang, t } from "../i18n";

export type DiffMode = "split" | "inline" | "result";
export interface DiffApi {
  next: () => void;
  prev: () => void;
  focus: () => void;
}

// the panel's diff colours (Review.tsx: --diff-add / --diff-del, strong for the changed words)
const diffTheme = EditorView.theme({
  "&.cm-merge-a .cm-changedLine, .cm-deletedChunk": { backgroundColor: "var(--diff-del) !important" },
  "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine": { backgroundColor: "var(--diff-add) !important" },
  "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText": { background: "var(--diff-del-strong) !important", borderRadius: "2px" },
  "&.cm-merge-b .cm-changedText": { background: "var(--diff-add-strong) !important", borderRadius: "2px" },
  "&.cm-merge-b .cm-deletedText": { background: "var(--diff-del-strong) !important" },
  ".cm-deletedChunk": { paddingLeft: "0 !important" },
  ".cm-deletedChunk .cm-deletedLine": { paddingLeft: "6px" },
  ".cm-changeGutter": { width: "3px", paddingLeft: "0", marginLeft: "2px" },
  "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": { background: "var(--bad) !important" },
  "&.cm-merge-b .cm-changedLineGutter": { background: "var(--ok) !important" },
  ".cm-inlineChangedLineGutter": { background: "var(--accent) !important" },
  ".cm-collapsedLines": {
    padding: "3px 12px !important",
    background: "var(--code-sep) !important",
    color: "var(--ink-3) !important",
    fontFamily: "var(--font)",
    fontSize: "var(--fs-xs)",
    "&:before, &:after": { content: "none !important" },
    "&:hover": { color: "var(--ink) !important" },
  },
  // opaque: code scrolled sideways goes under the line numbers, not through them
  ".cm-gutters": { backgroundColor: "var(--code-surface) !important" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
  ".cm-mergeSpacer": { backgroundColor: "transparent" },
  // the applied file's gutter: added, changed, removed just above
  ".cg-gutter": { width: "4px" },
  ".cg-gutter .cg-mark": { width: "3px", height: "100%" },
  ".cg-gutter .cg-mark.add": { background: "var(--ok)" },
  ".cg-gutter .cg-mark.mod": { background: "var(--accent)" },
  ".cg-gutter .cg-mark.del": { height: "0", width: "0", borderTop: "4px solid transparent", borderBottom: "4px solid transparent", borderLeft: "5px solid var(--bad)", marginTop: "-4px" },
});

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

const docOf = (s: string) => Text.of(s.split("\n"));
/** a chunk's lines on each side (1-based, `to` past the last; equal when empty there) */
function lineRanges(chunks: readonly Chunk[], a: Text, b: Text) {
  const first = (d: Text, p: number) => (p > d.length ? d.lines + 1 : d.lineAt(p).number);
  return chunks.map((c) => ({
    fromA: first(a, c.fromA),
    toA: c.toA > c.fromA ? a.lineAt(c.endA).number + 1 : first(a, c.fromA),
    fromB: first(b, c.fromB),
    toB: c.toB > c.fromB ? b.lineAt(c.endB).number + 1 : first(b, c.fromB),
  }));
}

export function DiffEditor(props: {
  path: string;
  a: string;
  b: string;
  mode: DiffMode;
  wrap: boolean;
  /** a newly opened file goes to its first change, or its last when stepped back into */
  start?: "first" | "last";
  /** the change gone to (-1: the cursor moved on its own) of how many */
  onCount?: (cur: number, total: number) => void;
  /** F7 past the last change, ⇧F7 before the first */
  onEdge?: (dir: 1 | -1) => void;
  onEscape?: () => void;
  ref?: (api: DiffApi) => void;
}) {
  let host!: HTMLDivElement;
  let merge: MergeView | undefined;
  let single: EditorView | undefined;
  /** the applied file's changes (that mode has no merge extension to ask) */
  let own: readonly Chunk[] = [];
  let cur = -1;
  let moving = false;
  let shown = "";
  const grammar = new Compartment();

  const target = () => merge?.b ?? single;
  const chunks = (): readonly Chunk[] => (merge ? merge.chunks : props.mode === "result" ? own : single ? (getChunks(single.state)?.chunks ?? []) : []);
  const report = () => props.onCount?.(cur, chunks().length);

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
    const scroller = merge?.dom ?? v.scrollDOM;
    const block = v.lineBlockAt(pos);
    const box = scroller.getBoundingClientRect();
    scroller.scrollTop += v.documentTop + block.top + block.height / 2 - box.top - scroller.clientHeight / 2;
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

  const shared = (): Extension[] => [
    lineNumbers(),
    highlightSpecialChars(),
    drawSelection(),
    EditorState.readOnly.of(true),
    EditorState.phrases.of({ "$ unchanged lines": t("{n}줄 펼치기", { n: "$" }) }),
    search({ top: true }),
    highlightSelectionMatches(),
    keymap.of([
      { key: "F7", run: () => (step(1), true) },
      { key: "Shift-F7", run: () => (step(-1), true) },
      ...searchKeymap,
      { key: "Escape", run: () => (props.onEscape?.(), !!props.onEscape) },
      ...defaultKeymap,
    ]),
    grammar.of([]),
    theme,
    diffTheme,
    syntaxHighlighting(colors),
    props.wrap ? EditorView.lineWrapping : [],
    EditorView.updateListener.of((u) => {
      if (u.selectionSet && !moving && cur >= 0) {
        cur = -1;
        report();
      }
    }),
  ];
  const fold = { collapseUnchanged: { margin: 3, minSize: 4 }, diffConfig: { scanLimit: 2000, timeout: 400 } };

  function destroy() {
    merge?.destroy();
    single?.destroy();
    merge = single = undefined;
  }
  function build() {
    const same = shown === props.path;
    const scroller = merge?.dom ?? single?.scrollDOM;
    const top = same ? (scroller?.scrollTop ?? 0) : 0;
    // stepping into the next file with F7 keeps the keys in the editor
    const had = host.contains(document.activeElement);
    destroy();
    cur = -1;
    if (props.mode === "split") {
      merge = new MergeView({ a: { doc: props.a, extensions: shared() }, b: { doc: props.b, extensions: shared() }, parent: host, gutter: true, highlightChanges: true, ...fold });
    } else if (props.mode === "inline") {
      single = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: props.b,
          extensions: [shared(), unifiedMergeView({ original: props.a, gutter: true, highlightChanges: true, syntaxHighlightDeletions: true, mergeControls: false, ...fold })],
        }),
      });
    } else {
      const a = docOf(props.a);
      const b = docOf(props.b);
      own = Chunk.build(a, b, fold.diffConfig);
      const marks = resultMarks(lineRanges(own, a, b), b.lines);
      const set = RangeSet.of([...marks].filter(([l]) => l <= b.lines).sort((x, y) => x[0] - y[0]).map(([l, k]) => new MarkDot(k).range(b.line(l).from)));
      single = new EditorView({
        parent: host,
        state: EditorState.create({ doc: b, extensions: [shared(), gutter({ class: "cg-gutter", markers: () => set })] }),
      });
    }
    const name = props.path.split("/").pop() ?? "";
    const path = props.path;
    void LanguageDescription.matchFilename(languages, name)
      ?.load()
      .then((support) => {
        if (props.path !== path) return;
        for (const v of merge ? [merge.a, merge.b] : single ? [single] : []) v.dispatch({ effects: grammar.reconfigure(support) });
      });
    shown = props.path;
    if (had) target()?.focus();
    if (same) {
      requestAnimationFrame(() => {
        const s = merge?.dom ?? single?.scrollDOM;
        if (s) s.scrollTop = top;
      });
      report();
    } else if (chunks().length) go(props.start === "last" ? chunks().length - 1 : 0);
    else report();
  }

  // the language too: the folded lines' label is in it
  createEffect(on(() => [props.path, props.a, props.b, props.mode, props.wrap, lang()], build));
  props.ref?.({ next: () => step(1), prev: () => step(-1), focus: () => target()?.focus() });
  onCleanup(destroy);
  return <div class="cg-cm" ref={host} />;
}
