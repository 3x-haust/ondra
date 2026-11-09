// A small code editor for the times a file has to be read or fixed by hand:
// line numbers, highlighting for the file's language, find (⌘F), undo, and ⌘S to
// save. Loaded only when a file is opened for editing.
import { onCleanup, onMount } from "solid-js";
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Compartment, EditorState } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags as t } from "@lezer/highlight";

// colors come from the app's own tokens, so the editor follows light and dark
export const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "var(--fs-code)", color: "var(--ink)", backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "20px" },
  ".cm-content": { caretColor: "var(--accent)", padding: "8px 0" },
  ".cm-cursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "1.5px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--ink-4)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 12px", minWidth: "3ch" },
  ".cm-activeLine": { backgroundColor: "var(--hover)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--ink-2)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "color-mix(in oklab, var(--accent) 28%, transparent) !important" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in oklab, var(--accent) 14%, transparent)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--ink) 12%, transparent)", outline: "none" },
  ".cm-searchMatch": { backgroundColor: "color-mix(in oklab, var(--warn) 30%, transparent)", outline: "none" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in oklab, var(--warn) 55%, transparent)" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--hover)", border: "none", color: "var(--ink-3)" },
  ".cm-panels": { backgroundColor: "var(--card)", color: "var(--ink)", borderColor: "var(--line)" },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line)" },
  ".cm-panel.cm-search": { padding: "8px 12px", fontFamily: "inherit", fontSize: "var(--fs-xs)" },
  ".cm-panel.cm-search input, .cm-panel.cm-search button": { fontFamily: "inherit", fontSize: "var(--fs-xs)" },
  ".cm-textfield": { background: "var(--bg)", border: "1px solid var(--line)", borderRadius: "var(--r-sm)", color: "var(--ink)", padding: "4px 8px" },
  ".cm-button": { backgroundImage: "none", background: "var(--hover)", border: "none", borderRadius: "var(--r-sm)", color: "var(--ink-2)", padding: "4px 8px" },
  ".cm-tooltip": { backgroundColor: "var(--card)", border: "1px solid var(--line)", borderRadius: "var(--r-lg)" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent-soft)", color: "var(--ink)" },
});

// the same Pierre colors the file viewer uses (--hl-* in t3.css, per theme)
export const colors = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword], color: "var(--hl-kw)" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "var(--hl-str)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--hl-num)" },
  { tag: [t.comment, t.lineComment, t.blockComment], color: "var(--hl-com)" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--hl-fn)" },
  { tag: [t.typeName, t.className, t.namespace], color: "var(--hl-type)" },
  { tag: [t.tagName], color: "var(--hl-tag)" },
  { tag: [t.propertyName, t.attributeName, t.punctuation, t.bracket, t.operator], color: "var(--hl-punct)" },
  { tag: [t.heading], fontWeight: "600" },
  { tag: [t.link, t.url], color: "var(--accent)", textDecoration: "underline" },
]);

export function Editor(props: {
  path: string;
  text: string;
  /** ⌘S or the save button; resolves true once it is on disk */
  onSave: (text: string) => Promise<boolean>;
  onDirty?: (dirty: boolean) => void;
  /** lets the header's button save too */
  ref?: (api: { save: () => void }) => void;
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;
  let saved = props.text;
  const lang = new Compartment();
  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.text,
        extensions: [
          basicSetup,
          keymap.of([
            indentWithTab,
            { key: "Mod-s", preventDefault: true, run: () => (save(), true) },
          ]),
          lang.of([]),
          theme,
          syntaxHighlighting(colors),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) props.onDirty?.(u.state.doc.toString() !== saved);
          }),
        ],
      }),
    });
    props.ref?.({ save });
    view.focus();
    // the language's grammar loads on its own, after the text is already there
    const desc = LanguageDescription.matchFilename(languages, props.path.split("/").pop() ?? "");
    void desc?.load().then((support) => view?.dispatch({ effects: lang.reconfigure(support) }));
  });
  onCleanup(() => view?.destroy());
  function save() {
    if (!view) return;
    const text = view.state.doc.toString();
    void props.onSave(text).then((ok) => {
      if (!ok || !view) return;
      // what is on disk now counts as clean
      saved = text;
      props.onDirty?.(view.state.doc.toString() !== saved);
    });
  }
  // keep editor keys (⌘F, ⌘Z, arrows, Escape in the search panel) away from app shortcuts
  return <div class="cm-host" ref={host} onKeyDown={(e) => e.stopPropagation()} />;
}
