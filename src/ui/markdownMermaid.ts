// A ```mermaid block in agent prose, drawn as a diagram in the app's own colours.
// Mermaid is big, so it loads the first time a reply has one. Diagrams draw one at a time
// (Mermaid keeps one global config) and are kept by source and theme, so a reply that
// re-renders while it streams shows the drawn picture straight away.
type Mermaid = typeof import("mermaid").default;
let loading: Promise<Mermaid> | undefined;
const load = () =>
  (loading ??= import("mermaid").then((m) => m.default).catch((e: unknown) => {
    loading = undefined;
    throw e;
  }));

const drawn = new Map<string, string>();
const failed = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();
let n = 0;

const dark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
};
const key = (src: string) => `${dark() ? "D" : "L"}${src}`;

/** the app's colours, read from its tokens, so a diagram looks like the rest of the chat */
function palette() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, or: string) => css.getPropertyValue(name).trim() || or;
  const d = dark();
  const ink = v("--ink", d ? "#f4f4f5" : "#18181b");
  const ink3 = v("--ink-3", "#71717a");
  const card = v("--card", d ? "#0d0d0d" : "#ffffff");
  const muted = v("--muted", d ? "#18181b" : "#fafafa");
  const line = v("--line", d ? "#27272a" : "#e4e4e7");
  const accent = v("--accent", "#1f6fd8");
  return {
    darkMode: d,
    background: v("--surface", card),
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontSize: "13px",
    primaryColor: muted,
    primaryTextColor: ink,
    primaryBorderColor: line,
    secondaryColor: card,
    tertiaryColor: card,
    lineColor: ink3,
    textColor: ink,
    mainBkg: muted,
    nodeBorder: line,
    clusterBkg: card,
    clusterBorder: line,
    edgeLabelBackground: card,
    noteBkgColor: muted,
    noteTextColor: ink,
    noteBorderColor: line,
    actorBkg: muted,
    actorBorder: line,
    actorTextColor: ink,
    signalColor: ink3,
    signalTextColor: ink,
    labelTextColor: ink,
    git0: accent,
  };
}

/** the diagram's SVG when it was drawn before (this theme), else undefined */
export const mermaidSvg = (src: string) => drawn.get(key(src));
/** it was tried and isn't a diagram Mermaid can read: shown as code */
export const mermaidFailed = (src: string) => failed.has(key(src));

/** draw one diagram; undefined when Mermaid can't read it */
export function drawMermaid(src: string): Promise<string | undefined> {
  const k = key(src);
  const ready = drawn.get(k);
  if (ready !== undefined) return Promise.resolve(ready);
  if (failed.has(k)) return Promise.resolve(undefined);
  const job = queue.then(async () => {
    const again = drawn.get(k);
    if (again !== undefined) return again;
    const mermaid = await load();
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "base", themeVariables: palette() });
    try {
      // pictures inside labels stay text
      const { svg } = await mermaid.render(`md-mermaid-${n++}`, src.replace(/<((?:img|image)\s)/gi, "&lt;$1"));
      if (drawn.size > 100) drawn.clear();
      drawn.set(k, svg);
      return svg;
    } catch {
      failed.add(k);
      return undefined;
    }
  });
  queue = job.catch(() => undefined);
  return job;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** the HTML for a ```mermaid block; `closed`: its closing fence has come (the reply may still be streaming) */
export function mermaidBlock(src: string, closed: boolean, waiting: string): string {
  const svg = mermaidSvg(src);
  if (svg !== undefined) return `<figure class="md-svg md-mermaid">${svg}</figure>`;
  if (closed && mermaidFailed(src)) return `<pre><code class="language-mermaid">${esc(src)}</code></pre>`;
  return `<div class="md-mermaid-wait"${closed ? ' data-ready=""' : ""}><pre hidden>${esc(src)}</pre><p class="md-svg-wait">${esc(waiting)}</p></div>`;
}

/** draw the diagrams whose block has closed and put each in place */
export function drawMermaidIn(root: HTMLElement) {
  for (const spot of root.querySelectorAll<HTMLElement>(".md-mermaid-wait[data-ready]")) {
    const src = spot.querySelector("pre")?.textContent ?? "";
    void drawMermaid(src).then((svg) => {
      if (!spot.isConnected) return;
      if (svg === undefined) {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.className = "language-mermaid";
        code.textContent = src;
        pre.append(code);
        spot.replaceWith(pre);
        return;
      }
      const fig = document.createElement("figure");
      fig.className = "md-svg md-mermaid";
      fig.innerHTML = svg;
      spot.replaceWith(fig);
    });
  }
}
