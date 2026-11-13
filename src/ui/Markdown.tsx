// Agent prose as markdown. Raw HTML is dropped and links only open http(s)
// URLs or reveal local paths, so nothing an agent writes can run in the app.
import { Marked, type Tokens } from "marked";
import { rangeTilde } from "./markdownTilde";
import { cjkStrong } from "./markdownCjk";
import { createEffect, onCleanup } from "solid-js";
import { fileSrc } from "../lib/native";
import { srcOf, useHost } from "../engine/far";
import { linkTip } from "../lib/links";
import { linkMenu, openLink } from "./links";
import { previewFile } from "../state/ui";
import { openBoard, openDrawing, openImage } from "./Lightbox";
import { BoardView } from "./board/view";
import { composerFor } from "./QuoteBar";
import { safeSvg } from "./svgSafe";
import { langOf, tokenize, toHtml } from "./highlight";
import { t } from "../i18n";

// pictures GitHub hosts (PR comments); anything else remote stays text
const GITHUB_IMG = /^https:\/\/(github\.com\/user-attachments\/|user-images\.githubusercontent\.com\/|private-user-images\.githubusercontent\.com\/|avatars\.githubusercontent\.com\/|raw\.githubusercontent\.com\/)/;

const make = (github: boolean) => new Marked({
  gfm: true,
  breaks: true,
  tokenizer: { del: rangeTilde, emStrong: cjkStrong },
  renderer: {
    html() {
      return "";
    },
    // a picture the agent drew: shown when it is a clean drawing, else the code as it was
    code({ text, lang }: Tokens.Code) {
      // an explanation drawn stroke by stroke: a place for it, filled in once the HTML is in
      if ((lang ?? "").trim().toLowerCase() === "board")
        return `<div class="md-board" data-n="${boardN++}"><pre hidden>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre></div>`;
      if ((lang ?? "").trim().toLowerCase() !== "svg") return false;
      const svg = safeSvg(text);
      if (svg) return `<figure class="md-svg" title="${t("크게 보기")}">${svg}</figure>`;
      // still being written (the answer streams in): a quiet line, not the code scrolling past
      return /<\/svg>/i.test(text) ? false : `<p class="md-svg-wait">${t("그림 그리는 중")}</p>`;
    },
    link({ href, text }: Tokens.Link) {
      const safe = /^https?:\/\//.test(href) || href.startsWith("/") ? href : "";
      if (!safe) return text;
      // where it goes, when the words don't say (a bare URL already does)
      const tip = linkTip(plain(safe), text);
      return `<a data-href="${encodeURI(safe)}"${tip ? ` title="${tip.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")}"` : ""}>${text}</a>`;
    },
    // local pictures (screenshots the agent took) show inline; remote ones stay a link
    image({ href: raw, text }: Tokens.Image) {
      const href = plain(raw);
      const local = href.startsWith("/") && /\.(png|jpe?g|gif|webp|svg)$/i.test(href);
      if (github && GITHUB_IMG.test(href)) return `<img class="md-img md-remote" data-href="${encodeURI(href)}" src="${encodeURI(href)}" alt="${text.replace(/"/g, "")}" loading="lazy">`;
      return local ? `<img class="md-img" data-path="${encodeURI(href)}" src="${fileSrc(href)}" alt="${text.replace(/"/g, "")}">` : text;
    },
  },
});
// boards in the text being parsed, numbered so each keeps its view while the text streams in
let boardN = 0;
/**
 * Boards whose text just went away, kept a moment: the same reply re-rendered (its answer
 * finishing, the list around it redrawn) picks its board up again and it draws on from
 * where it was instead of starting over.
 */
const parked: { v: BoardView; timer: number }[] = [];
function park(v: BoardView) {
  parked.push({ v, timer: window.setTimeout(() => { const i = parked.findIndex((p) => p.v === v); if (i >= 0) parked.splice(i, 1); v.dispose(); }, 1500) });
}
function unpark(src: string): BoardView | undefined {
  const same = (a: string, b: string) => { const n = Math.min(a.length, b.length, 120); return n >= 8 && a.slice(0, n) === b.slice(0, n); };
  const i = parked.findIndex((p) => same(p.v.source, src));
  if (i < 0) return undefined;
  const [p] = parked.splice(i, 1);
  clearTimeout(p.timer);
  return p.v;
}
const md = make(false);
const mdGithub = make(true);

// Agents write local paths as they are, spaces and all ("Application Support"),
// which markdown can't read as a link: wrap them in <> so it can.
const spacedPaths = (t: string) => t.replace(/\]\((\/[^)\n<>]*\s[^)\n<>]*)\)/g, "](<$1>)");
const plain = (href: string) => { try { return decodeURI(href); } catch { return href; } };

/** `github`: the text comes from GitHub (a PR's comments), so pictures it hosts show inline */
export function Markdown(props: { text: string; class?: string; github?: boolean }) {
  // a reply of another Mac's job: its pictures are there, fetched and shown from a copy here
  const host = useHost();
  const onClick = (e: MouseEvent) => {
    const drawing = (e.target as HTMLElement).closest("figure.md-svg");
    if (drawing) return openDrawing(drawing.innerHTML);
    const remote = (e.target as HTMLElement).closest("img.md-remote") as HTMLImageElement | null;
    if (remote) return void openLink(decodeURI(remote.dataset.href ?? ""), { event: e });
    const img = (e.target as HTMLElement).closest("img[data-path]") as HTMLImageElement | null;
    if (img) return openImage(decodeURI(img.dataset.path ?? ""), [...(el?.querySelectorAll<HTMLImageElement>("img[data-path]") ?? [])].map((x) => decodeURI(x.dataset.path ?? "")), host());
    const a = (e.target as HTMLElement).closest("a[data-href]") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const href = decodeURI(a.dataset.href ?? "");
    if (href.startsWith("/")) previewFile(href);
    else openLink(href, { event: e });
  };
  // a web link's menu: open here, in the default browser, copy
  const onMenu = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a[data-href], img.md-remote") as HTMLElement | null;
    if (a) linkMenu(decodeURI(a.dataset.href ?? ""))(e);
  };
  let el!: HTMLDivElement;
  const boards = new Map<number, BoardView>();
  onCleanup(() => boards.forEach((b) => park(b)));
  const html = () => {
    boardN = 0;
    return (props.github ? mdGithub : md).parse(spacedPaths(props.text), { async: false }) as string;
  };
  // colour fenced code once the HTML is in; a block keeps its plain text until then
  createEffect(() => {
    void props.text;
    queueMicrotask(() => {
      // a picture that needs a GitHub login the app doesn't have: its link instead
      for (const img of el?.querySelectorAll<HTMLImageElement>("img.md-remote") ?? []) {
        const swap = () => {
          const a = document.createElement("a");
          a.dataset.href = img.dataset.href ?? "";
          a.textContent = img.alt || t("사진");
          img.replaceWith(a);
        };
        if (img.complete && !img.naturalWidth) swap();
        else img.addEventListener("error", swap, { once: true });
      }
      // boards: the same view moves into the re-rendered text and draws on from where it was
      const here = new Set<number>();
      for (const spot of el?.querySelectorAll<HTMLElement>("div.md-board") ?? []) {
        const n = Number(spot.dataset.n);
        here.add(n);
        const src = spot.querySelector("pre")?.textContent ?? "";
        let v = boards.get(n);
        if (!v) {
          // its own root finds the composer: a board picked up by another render lives in that one's text
          v = unpark(src);
          if (!v) {
            const made: BoardView = new BoardView({
              onExpand: (src) => openBoard(src, (text) => composerFor(made.root)?.quote(text)),
              onAsk: (text) => composerFor(made.root)?.quote(text),
            });
            v = made;
          }
          boards.set(n, v);
        }
        spot.replaceWith(v.root);
        v.update(src);
      }
      for (const [n, v] of boards) if (!here.has(n)) (park(v), boards.delete(n));
      for (const code of el?.querySelectorAll<HTMLElement>("pre > code[class*='language-']") ?? []) {
        const lang = langOf(/language-([\w+-]+)/.exec(code.className)?.[1] ?? "");
        const src = code.textContent ?? "";
        void tokenize(src.replace(/\n$/, ""), lang).then((t) => {
          if (t && code.isConnected && code.textContent === src) {
            code.innerHTML = toHtml(t);
            code.classList.add("tk-on");
          }
        });
      }
    });
  });
  // runs after the HTML is in; again when a picture from that Mac has come
  createEffect(() => {
    void props.text;
    const h = host();
    if (!h || !el) return;
    for (const img of el.querySelectorAll<HTMLImageElement>("img.md-img[data-path]")) {
      const s = srcOf(decodeURI(img.dataset.path ?? ""), h);
      if (!s) img.removeAttribute("src");
      else if (img.getAttribute("src") !== s) img.src = s;
    }
  });
  return <div ref={el} class={`md ${props.class ?? ""}`} onClick={onClick} onContextMenu={onMenu} innerHTML={html()} />;
}
