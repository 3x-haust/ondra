// A diagram as a picture: the SVG with its computed look written into it, drawn
// at 2x onto a canvas. Used to see it full size, save it to Downloads, or copy it.
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { revealPath, saveDownload } from "../lib/native";
import { ignoredKey, noModifiers } from "../lib/shortcuts";
import { Icon } from "./Icon";
import { toast } from "../state/ui";
import { t } from "../i18n";

const PROPS = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "stroke-linecap",
  "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight", "font-style", "letter-spacing",
  "text-anchor", "dominant-baseline", "paint-order", "visibility",
];

/**
 * The colour the picture really sits on: every background from the page down to
 * the diagram, see-through ones included, laid over each other into one solid
 * colour (a transparent picture pasted elsewhere loses its dark backdrop).
 */
function backdrop(el: Element): string {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches && document.documentElement.dataset.theme !== "light" || document.documentElement.dataset.theme === "dark";
  const chain: string[] = [];
  for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(getComputedStyle(e).backgroundColor);
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = dark ? "#141414" : "#ffffff";
  ctx.fillRect(0, 0, 1, 1);
  for (const bg of chain) {
    if (!bg || bg === "transparent") continue;
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

export async function svgPng(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const vb = svg.viewBox.baseVal;
  const w = vb?.width || svg.clientWidth;
  const h = vb?.height || svg.clientHeight;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...svg.querySelectorAll("*")];
  const to = [clone, ...clone.querySelectorAll("*")];
  from.forEach((el, i) => {
    const cs = getComputedStyle(el);
    (to[i] as SVGElement).setAttribute("style", PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(w));
  clone.setAttribute("height", String(h));
  const bg = backdrop(svg);
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("width", "100%");
  rect.setAttribute("height", "100%");
  rect.setAttribute("style", `fill:${bg}`);
  clone.insertBefore(rect, clone.firstChild);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
  await img.decode();
  const pad = 24;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((w + pad * 2) * scale);
  canvas.height = Math.round((h + pad * 2) * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, pad * scale, pad * scale, w * scale, h * scale);
  return new Promise((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error(t("이미지를 만들지 못했어요")))), "image/png"));
}

const bytes = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];
const fileName = (label?: string) => `${(label || "diagram").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) || "diagram"}.png`;

const [viewing, setViewing] = createSignal<{ svg: SVGSVGElement; label?: string } | null>(null);

/** The diagram itself, as big as the window allows, on the page's colour. */
export function viewVisual(svg: SVGSVGElement, label?: string) {
  setViewing({ svg, label });
}

export function VisualViewer() {
  const onKey = (e: KeyboardEvent) => {
    if (viewing() && e.key === "Escape" && !ignoredKey(e) && noModifiers(e)) (e.preventDefault(), e.stopPropagation(), setViewing(null));
  };
  onMount(() => window.addEventListener("keydown", onKey, true));
  onCleanup(() => window.removeEventListener("keydown", onKey, true));
  return (
    <Show when={viewing()}>
      {(v) => {
        const clone = v().svg.cloneNode(true) as SVGSVGElement;
        clone.removeAttribute("width");
        clone.removeAttribute("style");
        clone.classList.add("vv-svg");
        return (
          <div class="vv" onClick={() => setViewing(null)}>
            <div class="vv-bar" onClick={(e) => e.stopPropagation()}>
              <span class="vv-title">{v().label ?? ""}</span>
              <button class="icon-btn" title={t("이미지로 저장")} aria-label={t("이미지로 저장")} onClick={() => void saveVisual(v().svg, v().label)}><Icon name="download" size={15} /></button>
              <button class="icon-btn" title={t("이미지 복사")} aria-label={t("이미지 복사")} onClick={() => void copyVisual(v().svg)}><Icon name="copy" size={15} /></button>
              <button class="icon-btn" title={t("닫기 (Esc)")} aria-label={t("닫기")} onClick={() => setViewing(null)}><Icon name="x" size={15} /></button>
            </div>
            <div class="vv-stage" onClick={(e) => e.stopPropagation()}>{clone}</div>
          </div>
        );
      }}
    </Show>
  );
}

export async function saveVisual(svg: SVGSVGElement, label?: string) {
  try {
    const path = await saveDownload(await bytes(await svgPng(svg)), fileName(label));
    toast(t("다운로드 폴더에 저장했어요"), "info", { label: t("Finder에서 보기"), run: () => void revealPath(path) });
  } catch (e) {
    toast(t("저장하지 못했어요: {e}", { e: e instanceof Error ? e.message : String(e) }), "bad");
  }
}

export async function copyVisual(svg: SVGSVGElement) {
  try {
    // the promise form keeps the click's permission while the picture is drawn
    await navigator.clipboard.write([new ClipboardItem({ "image/png": svgPng(svg) })]);
    toast(t("이미지를 복사했어요"));
  } catch (e) {
    toast(t("복사하지 못했어요: {e}", { e: e instanceof Error ? e.message : String(e) }), "bad");
  }
}
