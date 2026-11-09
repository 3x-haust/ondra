// Agent prose as markdown. Raw HTML is dropped and links only open http(s)
// URLs or reveal local paths, so nothing an agent writes can run in the app.
import { Marked, type Tokens } from "marked";
import { createEffect } from "solid-js";
import { fileSrc } from "../lib/native";
import { linkTip } from "../lib/links";
import { linkMenu, openLink } from "./links";
import { previewFile } from "../state/ui";
import { openImage } from "./Lightbox";
import { langOf, tokenize, toHtml } from "./highlight";
import { t } from "../i18n";

// pictures GitHub hosts (PR comments); anything else remote stays text
const GITHUB_IMG = /^https:\/\/(github\.com\/user-attachments\/|user-images\.githubusercontent\.com\/|private-user-images\.githubusercontent\.com\/|avatars\.githubusercontent\.com\/|raw\.githubusercontent\.com\/)/;

const make = (github: boolean) => new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html() {
      return "";
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
const md = make(false);
const mdGithub = make(true);

// Agents write local paths as they are, spaces and all ("Application Support"),
// which markdown can't read as a link: wrap them in <> so it can.
const spacedPaths = (t: string) => t.replace(/\]\((\/[^)\n<>]*\s[^)\n<>]*)\)/g, "](<$1>)");
const plain = (href: string) => { try { return decodeURI(href); } catch { return href; } };

/** `github`: the text comes from GitHub (a PR's comments), so pictures it hosts show inline */
export function Markdown(props: { text: string; class?: string; github?: boolean }) {
  const onClick = (e: MouseEvent) => {
    const remote = (e.target as HTMLElement).closest("img.md-remote") as HTMLImageElement | null;
    if (remote) return void openLink(decodeURI(remote.dataset.href ?? ""), { event: e });
    const img = (e.target as HTMLElement).closest("img[data-path]") as HTMLImageElement | null;
    if (img) return openImage(decodeURI(img.dataset.path ?? ""), [...(el?.querySelectorAll<HTMLImageElement>("img[data-path]") ?? [])].map((x) => decodeURI(x.dataset.path ?? "")));
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
  return <div ref={el} class={`md ${props.class ?? ""}`} onClick={onClick} onContextMenu={onMenu} innerHTML={(props.github ? mdGithub : md).parse(spacedPaths(props.text), { async: false }) as string} />;
}
