// The app's web view shows no native tooltip: a `title` only turns the cursor, its words never
// show. This draws them instead, for every element with a `title` (and SVG shapes with a <title>
// inside), once for the whole app: a short wait the first time, at once while moving from one to
// the next, gone on leaving, a press, a key or a scroll. While it shows, the element's `title`
// waits in `data-tip-title` so a browser that does draw tooltips doesn't draw a second one.

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/** how long the pointer rests before the first tip shows (ms) */
const WAIT = 450;
/** after one hides, the next shows at once within this (ms) */
const WARM = 600;
const GAP = 6;
const EDGE = 8;

/** Where the tip goes: centred under the element, over it when there's no room below, kept inside the window. */
export function placeTip(at: Rect, tip: { width: number; height: number }, view: { width: number; height: number }): { left: number; top: number; above: boolean } {
  const above = at.bottom + GAP + tip.height > view.height - EDGE && at.top - GAP - tip.height >= EDGE;
  const top = above ? at.top - GAP - tip.height : at.bottom + GAP;
  const left = Math.min(Math.max(EDGE, at.left + at.width / 2 - tip.width / 2), Math.max(EDGE, view.width - EDGE - tip.width));
  return { left: Math.round(left), top: Math.round(top), above };
}

/** the words a hovered element's tip says, and the element they belong to */
function tipOf(target: EventTarget | null): { el: Element; text: string } | undefined {
  if (!(target instanceof Element)) return undefined;
  const el = target.closest("[title], [data-tip-title]");
  if (el) {
    const text = (el.getAttribute("title") ?? el.getAttribute("data-tip-title") ?? "").trim();
    if (text) return { el, text };
  }
  // an SVG shape names itself with a <title> child (the memory graph's nodes)
  for (let g: Element | null = target; g && g instanceof SVGElement; g = g.parentElement) {
    const t = [...g.children].find((c) => c.tagName.toLowerCase() === "title");
    if (t?.textContent?.trim()) return { el: g, text: t.textContent.trim() };
  }
  return undefined;
}

let installed = false;

export function installTooltips() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const box = document.createElement("div");
  box.className = "app-tip";
  box.setAttribute("role", "tooltip");
  box.hidden = true;
  document.body.append(box);

  let cur: Element | undefined;
  let timer = 0;
  let hiddenAt = 0;

  const restore = () => {
    if (cur && cur.hasAttribute("data-tip-title")) {
      // a title set again meanwhile (the element changed) wins
      if (!cur.hasAttribute("title")) cur.setAttribute("title", cur.getAttribute("data-tip-title")!);
      cur.removeAttribute("data-tip-title");
    }
  };
  const hide = () => {
    clearTimeout(timer);
    if (!box.hidden) hiddenAt = performance.now();
    box.hidden = true;
    restore();
    cur = undefined;
  };
  const show = (el: Element, text: string) => {
    if (!el.isConnected) return;
    box.textContent = text;
    box.hidden = false;
    box.style.left = "0px";
    box.style.top = "0px";
    const r = el.getBoundingClientRect();
    const p = placeTip(r, box.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
    box.style.left = `${p.left}px`;
    box.style.top = `${p.top}px`;
    box.classList.toggle("above", p.above);
  };

  document.addEventListener(
    "pointerover",
    (e) => {
      if (e.pointerType === "touch") return;
      const t = tipOf(e.target);
      if (t?.el === cur) return;
      const warm = !box.hidden || performance.now() - hiddenAt < WARM;
      hide();
      if (!t) return;
      cur = t.el;
      // the native one would show too where a browser draws them
      if (t.el.hasAttribute("title")) {
        t.el.setAttribute("data-tip-title", t.el.getAttribute("title")!);
        t.el.removeAttribute("title");
      }
      if (warm) show(t.el, t.text);
      else timer = window.setTimeout(() => cur === t.el && show(t.el, t.text), WAIT);
    },
    true,
  );
  document.addEventListener(
    "pointerout",
    (e) => {
      if (cur && !(e.relatedTarget instanceof Node && cur.contains(e.relatedTarget))) hide();
    },
    true,
  );
  for (const ev of ["pointerdown", "keydown", "wheel"]) document.addEventListener(ev, hide, true);
  window.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
}
