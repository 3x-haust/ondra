// Agent prose as markdown. Raw HTML is dropped and links only open http(s)
// URLs or reveal local paths, so nothing an agent writes can run in the app.
import { Marked, type Tokens } from "marked";
import { createEffect } from "solid-js";
import { fileSrc, openUrl } from "../lib/native";
import { previewFile } from "../state/ui";
import { openImage } from "./Lightbox";
import { langOf, tokenize, toHtml } from "./highlight";

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html() {
      return "";
    },
    link({ href, text }: Tokens.Link) {
      const safe = /^https?:\/\//.test(href) || href.startsWith("/") ? href : "";
      return safe ? `<a data-href="${encodeURI(safe)}">${text}</a>` : text;
    },
    // local pictures (screenshots the agent took) show inline; remote ones stay a link
    image({ href: raw, text }: Tokens.Image) {
      const href = plain(raw);
      const local = href.startsWith("/") && /\.(png|jpe?g|gif|webp|svg)$/i.test(href);
      return local ? `<img class="md-img" data-path="${encodeURI(href)}" src="${fileSrc(href)}" alt="${text.replace(/"/g, "")}">` : text;
    },
  },
});

// Agents write local paths as they are, spaces and all ("Application Support"),
// which markdown can't read as a link: wrap them in <> so it can.
const spacedPaths = (t: string) => t.replace(/\]\((\/[^)\n<>]*\s[^)\n<>]*)\)/g, "](<$1>)");
const plain = (href: string) => { try { return decodeURI(href); } catch { return href; } };

export function Markdown(props: { text: string; class?: string }) {
  const onClick = (e: MouseEvent) => {
    const img = (e.target as HTMLElement).closest("img[data-path]") as HTMLImageElement | null;
    if (img) return openImage(decodeURI(img.dataset.path ?? ""), [...(el?.querySelectorAll<HTMLImageElement>("img[data-path]") ?? [])].map((x) => decodeURI(x.dataset.path ?? "")));
    const a = (e.target as HTMLElement).closest("a[data-href]") as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const href = decodeURI(a.dataset.href ?? "");
    if (href.startsWith("/")) previewFile(href);
    else openUrl(href);
  };
  let el!: HTMLDivElement;
  // colour fenced code once the HTML is in; a block keeps its plain text until then
  createEffect(() => {
    void props.text;
    queueMicrotask(() => {
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
  return <div ref={el} class={`md ${props.class ?? ""}`} onClick={onClick} innerHTML={md.parse(spacedPaths(props.text), { async: false }) as string} />;
}
