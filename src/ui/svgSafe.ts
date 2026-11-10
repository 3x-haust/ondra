// A picture an agent drew as SVG (a ```svg block in its answer), made safe to put in the page:
// only drawing elements and attributes stay (no script, no foreignObject, no outside links,
// no event handlers), and its colours become the app's own tokens so it sits right in either theme.

const ELEMENTS = new Set([
  "svg", "g", "defs", "title", "desc", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "marker", "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "symbol", "use",
]);
const ATTRS = new Set([
  "viewbox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points",
  "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity",
  "fill-opacity", "fill-rule", "clip-rule", "opacity", "transform", "font-size", "font-weight", "font-style", "text-anchor",
  "dominant-baseline", "alignment-baseline", "letter-spacing", "dx", "dy", "id", "class", "offset", "stop-color", "stop-opacity",
  "marker-start", "marker-mid", "marker-end", "markerwidth", "markerheight", "refx", "refy", "orient", "markerunits",
  "gradientunits", "gradienttransform", "patternunits", "clip-path", "mask", "href", "xlink:href", "preserveaspectratio",
  "rotate", "textlength", "lengthadjust", "vector-effect", "paint-order",
]);
const PAINT = new Set(["fill", "stroke", "stop-color"]);

/** Hue (0–360), saturation and lightness (0–1) of a literal CSS colour, or null when it isn't one. */
export function hsl(value: string): { h: number; s: number; l: number } | null {
  const v = value.trim().toLowerCase();
  let r: number, g: number, b: number;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v);
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  const named: Record<string, string> = { black: "#000", white: "#fff", gray: "#808080", grey: "#808080", red: "#e33", green: "#3a3", blue: "#36f", orange: "#f90", yellow: "#fd0", purple: "#93c", teal: "#2aa", navy: "#124", silver: "#ccc" };
  if (hex) {
    const h = hex[1]!.length === 3 ? hex[1]!.split("").map((c) => c + c).join("") : hex[1]!;
    [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  } else if (rgb) {
    [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number) as [number, number, number];
  } else if (named[v]) return hsl(named[v]!);
  else return null;
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (d) h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}

/**
 * The app token a literal colour stands in for. Greys go by lightness (dark → surfaces, light → ink),
 * colours by hue to the app's own accents. `text` paints are always ink, so words stay readable.
 */
export function tokenColor(value: string, prop: string, text = false): string | null {
  const c = hsl(value);
  if (!c) return null;
  if (text && prop === "fill") return c.s < 0.25 ? (c.l < 0.55 ? "var(--ink-2)" : "var(--ink)") : hueToken(c.h, true);
  if (c.s < 0.18) {
    if (prop === "stroke") return c.l < 0.5 ? "var(--line-strong)" : "var(--ink-3)";
    return c.l < 0.2 ? "var(--surface)" : c.l < 0.45 ? "var(--card)" : c.l < 0.75 ? "var(--muted)" : "var(--ink)";
  }
  // a dark, muted colour (a blue-grey box) is a surface, not an accent
  if (prop === "fill" && c.l < 0.4 && c.s < 0.45) return "var(--card)";
  return hueToken(c.h, prop !== "fill" || c.l > 0.35);
}
function hueToken(h: number, strong: boolean): string {
  const name = h < 20 || h >= 330 ? "bad" : h < 50 ? "warn" : h < 70 ? "warn" : h < 165 ? "ok" : h < 195 ? "live" : h < 255 ? "accent" : "merged";
  return strong ? `var(--${name})` : `var(--${name === "accent" ? "accent-soft" : name === "merged" || name === "live" ? name : `${name}-soft`})`;
}

const URL_OK = (v: string) => !/url\(/i.test(v) || /^url\(\s*#[\w-]+\s*\)$/i.test(v.trim());

/** Keep only what draws; returns the cleaned markup, or null when nothing drawable is left. */
export function safeSvg(src: string): string | null {
  if (src.length > 80_000 || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(src.trim(), "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length) return null;
  let count = 0;
  const walk = (el: Element, inText: boolean): boolean => {
    if (++count > 3000) return false;
    for (const child of [...el.children]) {
      const name = child.nodeName.toLowerCase();
      if (!ELEMENTS.has(name)) {
        child.remove();
        continue;
      }
      if (!walk(child, inText || name === "text")) return false;
    }
    const isText = inText || el.nodeName.toLowerCase() === "text" || el.nodeName.toLowerCase() === "tspan";
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      const v = a.value;
      if (n === "style") {
        // a style attribute keeps only paint and font size, as attributes
        for (const decl of v.split(";")) {
          const [k, ...rest] = decl.split(":");
          const key = k?.trim().toLowerCase(), val = rest.join(":").trim();
          if (key && val && ATTRS.has(key) && URL_OK(val) && !el.hasAttribute(key)) el.setAttribute(key, val);
        }
        el.removeAttribute(a.name);
        continue;
      }
      if (!ATTRS.has(n) || !URL_OK(v)) {
        el.removeAttribute(a.name);
        continue;
      }
      // links only to its own parts (<use href="#a">)
      if ((n === "href" || n === "xlink:href") && !v.startsWith("#")) el.removeAttribute(a.name);
    }
    for (const p of PAINT) {
      const v = el.getAttribute(p);
      const tok = v ? tokenColor(v, p === "stop-color" ? "fill" : p, isText) : null;
      if (tok) el.setAttribute(p, tok);
    }
    return true;
  };
  if (!walk(root, false)) return null;
  // words on a coloured box (white on blue) stay light in both themes; on a plain box they are ink
  const strong = /^var\(--(accent|ok|warn|bad|live|merged)\)$/;
  const boxes = [...root.querySelectorAll("rect")].filter((r) => !r.closest("defs,marker,pattern,clipPath,mask"));
  for (const tx of root.querySelectorAll("text")) {
    const x = parseFloat(tx.getAttribute("x") ?? ""), y = parseFloat(tx.getAttribute("y") ?? "");
    if (Number.isNaN(x) || Number.isNaN(y) || tx.closest("[transform]")) continue;
    const under = boxes.filter((r) => {
      if (!(r.compareDocumentPosition(tx) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      const rx = parseFloat(r.getAttribute("x") ?? "0"), ry = parseFloat(r.getAttribute("y") ?? "0");
      const w = parseFloat(r.getAttribute("width") ?? "0"), h = parseFloat(r.getAttribute("height") ?? "0");
      return x >= rx && x <= rx + w && y >= ry && y <= ry + h;
    }).pop();
    if (!under) continue;
    const onColour = strong.test(under.getAttribute("fill") ?? "");
    for (const el of [tx, ...tx.querySelectorAll("tspan")]) {
      const f = el.getAttribute("fill");
      if (onColour && (!f || /^var\(--ink(-2)?\)$/.test(f))) el.setAttribute("fill", "var(--white)");
      else if (!onColour && f === "var(--white)") el.setAttribute("fill", "var(--ink)");
    }
  }
  // the drawn text sits in the app's font; the picture scales to the column
  if (!root.getAttribute("viewBox") && root.getAttribute("width") && root.getAttribute("height")) {
    root.setAttribute("viewBox", `0 0 ${parseFloat(root.getAttribute("width")!)} ${parseFloat(root.getAttribute("height")!)}`);
  }
  root.removeAttribute("width");
  root.removeAttribute("height");
  root.setAttribute("role", "img");
  if (!root.children.length) return null;
  return new XMLSerializer().serializeToString(root);
}
