// Math in agent prose: $…$, \(…\) inline and $$…$$, \[…\] on their own lines, drawn with KaTeX.
// KaTeX loads the first time a reply has math; until then the TeX shows as it was written.
// A lone "$" stays money: "$5 and $10" is not math (the closing $ may not follow a space or
// come before a digit), the way pandoc reads it.
import type { TokenizerAndRendererExtension, Tokens } from "marked";

type Katex = typeof import("katex").default;
let lib: Katex | undefined;
let loading: Promise<Katex> | undefined;
/** KaTeX and its stylesheet, loaded once */
const loadKatex = () =>
  (loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([k]) => (lib = k.default)));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// the same formula comes back on every streamed update: drawn once
const drawn = new Map<string, string>();
/** the formula as HTML, or undefined while KaTeX isn't loaded */
function mathHtml(tex: string, display: boolean): string | undefined {
  if (!lib) return undefined;
  const key = `${display ? "D" : "I"}${tex}`;
  let html = drawn.get(key);
  if (html === undefined) {
    html = lib.renderToString(tex, { displayMode: display, throwOnError: false, strict: false, trust: false, output: "html" });
    if (drawn.size > 500) drawn.clear();
    drawn.set(key, html);
  }
  return html;
}

const place = (tex: string, display: boolean, src: string) => {
  const tag = display ? "div" : "span";
  const cls = display ? "md-math md-math-block" : "md-math";
  const html = mathHtml(tex, display);
  return html === undefined
    ? `<${tag} class="${cls}" data-tex="${esc(tex)}"${display ? ' data-display=""' : ""}>${esc(src)}</${tag}>`
    : `<${tag} class="${cls} on">${html}</${tag}>`;
};

/** a single-$ formula: "$" then no space, up to a "$" with no space before it and no digit after */
export function inlineDollar(src: string): { raw: string; tex: string } | undefined {
  if (src[0] !== "$" || src[1] === "$" || !src[1] || /\s/.test(src[1])) return undefined;
  for (let i = 1; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "\n") return undefined;
    if (c !== "$") continue;
    if (/\s/.test(src[i - 1]!) || /\d/.test(src[i + 1] ?? "")) return undefined;
    return { raw: src.slice(0, i + 1), tex: src.slice(1, i) };
  }
  return undefined;
}

interface MathToken extends Tokens.Generic {
  tex: string;
  display: boolean;
}

const blockMath: TokenizerAndRendererExtension = {
  name: "mathBlock",
  level: "block",
  // only where a line starts with $$ or \[, so a paragraph ends there
  start: (src) => {
    const m = /(^|\n)[ \t]*(\$\$|\\\[)/.exec(src);
    return m ? m.index + m[1]!.length : undefined;
  },
  tokenizer(src) {
    const m = /^[ \t]*(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/.exec(src);
    if (!m) return undefined;
    return { type: "mathBlock", raw: m[0], tex: (m[1] ?? m[2]!).trim(), display: true } as MathToken;
  },
  renderer: (t) => place((t as MathToken).tex, true, t.raw.trim()),
};

const inlineMath: TokenizerAndRendererExtension = {
  name: "mathInline",
  level: "inline",
  start: (src) => {
    const m = /\$|\\\(/.exec(src);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    let m = /^\$\$(?!\$)([\s\S]+?)\$\$/.exec(src);
    if (m) return { type: "mathInline", raw: m[0], tex: m[1]!.trim(), display: true } as MathToken;
    m = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (m) return { type: "mathInline", raw: m[0], tex: m[1]!.trim(), display: false } as MathToken;
    const d = inlineDollar(src);
    if (d) return { type: "mathInline", raw: d.raw, tex: d.tex, display: false } as MathToken;
    return undefined;
  },
  renderer: (t) => place((t as MathToken).tex, (t as MathToken).display, t.raw),
};

export const mathExtensions = [blockMath, inlineMath];

/** draw the formulas still shown as TeX (KaTeX wasn't loaded when the HTML was made) */
export function drawMath(root: HTMLElement) {
  const waiting = root.querySelectorAll<HTMLElement>(".md-math[data-tex]");
  if (!waiting.length) return;
  void loadKatex().then(() => {
    for (const el of waiting) {
      if (!el.isConnected) continue;
      const html = mathHtml(el.dataset.tex ?? "", el.dataset.display !== undefined);
      if (html === undefined) continue;
      el.innerHTML = html;
      el.removeAttribute("data-tex");
      el.classList.add("on");
    }
  });
}
