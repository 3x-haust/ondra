// Syntax colour for diffs, files and code in chat: Shiki (JS regex engine, no
// wasm) with the Pierre themes T3 Code uses (Apache-2.0, @pierre/theme). Light and
// dark colours come out together so switching the app theme needs no re-render.
import type { HighlighterCore, ThemedToken } from "shiki/core";

const LANGS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  shellscript: () => import("shiki/langs/shellscript.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
};

const EXT: Record<string, string> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "json", css: "css", scss: "css", html: "html", svg: "html", xml: "html",
  md: "markdown", mdx: "markdown", rs: "rust", py: "python",
  sh: "shellscript", bash: "shellscript", zsh: "shellscript",
  yml: "yaml", yaml: "yaml", toml: "toml", go: "go", swift: "swift", sql: "sql", diff: "diff", patch: "diff",
};
const ALIAS: Record<string, string> = { ts: "typescript", js: "javascript", sh: "shellscript", bash: "shellscript", zsh: "shellscript", shell: "shellscript", py: "python", rs: "rust", yml: "yaml", md: "markdown" };

/** "src/a.tsx" → "tsx"; "```ts" → "typescript"; unknown → null */
export function langOf(nameOrTag: string): string | null {
  const s = nameOrTag.toLowerCase().trim();
  if (LANGS[s]) return s;
  if (ALIAS[s]) return ALIAS[s];
  const ext = s.split("/").pop()!.split(".").pop() ?? "";
  return EXT[ext] ?? null;
}

let core: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();
function highlighter() {
  core ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("@pierre/theme/pierre-light"),
      import("@pierre/theme/pierre-dark"),
    ]);
    // shiki wants plain mutable objects; pierre ships frozen ones
    const plain = (t: unknown) => JSON.parse(JSON.stringify(t));
    return createHighlighterCore({ themes: [plain(light.default), plain(dark.default)], langs: [], engine: createJavaScriptRegexEngine() });
  })();
  return core;
}

export interface Tok {
  text: string;
  /** light colour; the dark one rides along as --d */
  c?: string;
  d?: string;
}

const cache = new Map<string, Promise<Tok[][] | null>>();

/** Colour the lines of one piece of code. Lines tokenised together keep multi-line context. */
export function tokenize(code: string, lang: string | null): Promise<Tok[][] | null> {
  if (!lang || !LANGS[lang] || code.length > 200_000) return Promise.resolve(null);
  const key = `${lang}\u0000${code}`;
  if (!cache.has(key)) {
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(
      key,
      (async () => {
        try {
          const h = await highlighter();
          if (!loaded.has(lang)) {
            const mod = (await LANGS[lang]()) as { default: unknown };
            await h.loadLanguage(mod.default as never);
            loaded.add(lang);
          }
          const r = h.codeToTokens(code, { lang, themes: { light: "pierre-light", dark: "pierre-dark" } });
          return r.tokens.map((line: ThemedToken[]) =>
            line.map((t) => {
              const st = (t.htmlStyle ?? {}) as Record<string, string>;
              return { text: t.content, c: st.color, d: st["--shiki-dark"] };
            }),
          );
        } catch {
          return null;
        }
      })(),
    );
  }
  return cache.get(key)!;
}

/** For HTML strings (markdown code blocks). */
export function toHtml(lines: Tok[][]): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return lines
    .map((l) => l.map((t) => (t.c ? `<span style="color:${t.c};--d:${t.d ?? t.c}">${esc(t.text)}</span>` : esc(t.text))).join(""))
    .join("\n");
}
