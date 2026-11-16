// The card that shows when the pointer rests on a web link in agent prose: the site, the page's
// title and what it is about, so a source can be judged without opening it. The page's own
// <head> is read by the app (link_card), once per address; the card can be pointed at and clicked.
import { linkCard, type LinkCardInfo } from "../lib/native";
import { openLink } from "./links";
import { shortUrl } from "../lib/links";

const SHOW_AFTER = 400;
const HIDE_AFTER = 120;
const GAP = 6;

const known = new Map<string, Promise<LinkCardInfo | null>>();
/** what a page says about itself, asked once per address (the hover card, link chips, site icons) */
export const cardOf = (url: string) => {
  let p = known.get(url);
  if (!p) {
    p = linkCard(url).catch(() => null);
    if (known.size > 300) known.clear();
    known.set(url, p);
  }
  return p;
};

let card: HTMLDivElement | undefined;
let anchor: HTMLElement | undefined;
let showing: string | undefined;
let timer: number | undefined;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string) {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function fill(c: HTMLDivElement, url: string, i: LinkCardInfo | null | undefined) {
  const { host, rest } = shortUrl(url);
  const head = el("div", "lc-site");
  if (i?.icon) {
    const img = el("img", "lc-icon");
    img.src = i.icon;
    img.alt = "";
    img.addEventListener("error", () => img.replaceWith(el("span", "lc-icon lc-letter", host[0]?.toUpperCase() ?? "")), { once: true });
    head.append(img);
  } else head.append(el("span", "lc-icon lc-letter", host[0]?.toUpperCase() ?? ""));
  head.append(el("span", "lc-name", i?.site || host));
  const parts: HTMLElement[] = [head];
  if (i?.title) parts.push(el("div", "lc-title", i.title));
  if (i?.description) parts.push(el("div", "lc-desc", i.description));
  parts.push(el("div", "lc-url", host + rest));
  c.replaceChildren(...parts);
  c.classList.toggle("loading", i === undefined);
}

function place(c: HTMLDivElement, a: HTMLElement) {
  const r = a.getBoundingClientRect();
  const w = c.offsetWidth;
  const h = c.offsetHeight;
  let x = r.left + r.width / 2 - w / 2;
  x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  const below = r.bottom + GAP + h <= window.innerHeight - 8 || r.top - GAP - h < 8;
  c.style.left = `${Math.round(x)}px`;
  c.style.top = `${Math.round(below ? r.bottom + GAP : r.top - GAP - h)}px`;
}

function hide() {
  clearTimeout(timer);
  card?.remove();
  showing = undefined;
  anchor = undefined;
}

function show(a: HTMLElement, url: string) {
  if (!card) {
    card = el("div", "link-card");
    card.setAttribute("role", "tooltip");
    card.addEventListener("mouseenter", () => clearTimeout(timer));
    card.addEventListener("mouseleave", () => later(hide, HIDE_AFTER));
    card.addEventListener("click", (e) => {
      const to = showing;
      hide();
      if (to) openLink(to, { event: e });
    });
  }
  const c = card;
  showing = url;
  anchor = a;
  fill(c, url, undefined);
  document.body.append(c);
  place(c, a);
  void cardOf(url).then((i) => {
    if (showing !== url || !c.isConnected) return;
    fill(c, url, i);
    place(c, a);
  });
}

function later(f: () => void, ms: number) {
  clearTimeout(timer);
  timer = window.setTimeout(f, ms);
}

const linkOf = (t: EventTarget | null) => {
  const a = (t as HTMLElement | null)?.closest?.("a[data-href]") as HTMLElement | null;
  const href = a ? decodeURI(a.dataset.href ?? "") : "";
  return a && /^https?:\/\//.test(href) ? { a, href } : undefined;
};

let wired = false;
/** cards for the web links inside `root` (one listener pair per prose block) */
export function linkCards(root: HTMLElement) {
  if (!wired) {
    wired = true;
    // it belongs to where the link was: scrolling, a click or a key puts it away
    window.addEventListener("scroll", (e) => card?.contains(e.target as Node) || hide(), true);
    window.addEventListener("pointerdown", (e) => card?.contains(e.target as Node) || hide(), true);
    window.addEventListener("keydown", hide, true);
    window.addEventListener("blur", hide);
  }
  root.addEventListener("mouseover", (e) => {
    const l = linkOf(e.target);
    if (!l) return;
    if (l.a === anchor) return clearTimeout(timer);
    later(() => l.a.isConnected && show(l.a, l.href), SHOW_AFTER);
  });
  root.addEventListener("mouseout", (e) => {
    const l = linkOf(e.target);
    if (!l || l.a.contains(e.relatedTarget as Node)) return;
    if (l.a === anchor) later(hide, HIDE_AFTER);
    else clearTimeout(timer);
  });
}
