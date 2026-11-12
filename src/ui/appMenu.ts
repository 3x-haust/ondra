// A right-click anywhere in the app: Ondra's own menu for what is under the pointer
// (a picture: copy or save it; picked text: copy it; a web link: its link menu), and
// none where there is nothing to do. The web view's own menu (새로 고침, 뒤로) never shows:
// it acts on the app's page, not on what was clicked. Text fields keep the system's
// editing menu, and a part of the app with its own menu (a task, a file) handles it first.
import { revealPath, saveDownload } from "../lib/native";
import { toast } from "../state/ui";
import { t } from "../i18n";
import { linkMenuItems } from "./links";
import { openMenuAt, type MenuEntry } from "./taskMenu";

/** What the menu offers for a right-click on `target`, with `picked` the text selected then. */
export type MenuTarget = { kind: "image"; src: string; name: string } | { kind: "text"; text: string } | { kind: "link"; url: string } | { kind: "field" } | { kind: "none" };

export function menuTarget(target: Element | null, picked: string): MenuTarget {
  if (!target) return { kind: "none" };
  if (target.closest("input, textarea, [contenteditable=''], [contenteditable='true']")) return { kind: "field" };
  const img = target.closest("img");
  if (img?.currentSrc || img?.getAttribute("src")) {
    const src = img.currentSrc || img.getAttribute("src")!;
    return { kind: "image", src, name: imageName(src, img.alt) };
  }
  if (picked.trim()) return { kind: "text", text: picked };
  const a = target.closest("a[href]");
  const href = a?.getAttribute("href") ?? "";
  if (/^https?:\/\//.test(href)) return { kind: "link", url: href };
  return { kind: "none" };
}

/** a file name for a picture: its own name in the address, else its description, else "image" */
export function imageName(src: string, alt = ""): string {
  let last = "";
  if (!src.startsWith("data:") && !src.startsWith("blob:")) {
    try {
      last = decodeURIComponent(new URL(src, "http://x").pathname).split("/").pop() ?? "";
    } catch {
      last = "";
    }
  }
  const base = (last || alt || "image").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "image";
  return base;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "image/heic": "heic" };

async function fetchImage(src: string): Promise<Blob> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.blob();
}

/** the clipboard takes PNG: anything else is drawn once at its own size */
async function asPng(b: Blob): Promise<Blob> {
  if (b.type === "image/png") return b;
  const url = URL.createObjectURL(b);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || 1;
    c.height = img.naturalHeight || 1;
    c.getContext("2d")!.drawImage(img, 0, 0);
    return await new Promise((done, fail) => c.toBlob((p) => (p ? done(p) : fail(new Error(t("이미지를 만들지 못했어요")))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function copyImage(src: string) {
  try {
    // the promise form keeps the click's permission while the picture loads
    await navigator.clipboard.write([new ClipboardItem({ "image/png": fetchImage(src).then(asPng) })]);
    toast(t("이미지를 복사했어요"));
  } catch (e) {
    toast(t("복사하지 못했어요: {e}", { e: e instanceof Error ? e.message : String(e) }), "bad");
  }
}

export async function saveImage(src: string, name: string) {
  try {
    const b = await fetchImage(src);
    const ext = EXT[b.type] ?? "png";
    const file = /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${ext}`;
    const path = await saveDownload([...new Uint8Array(await b.arrayBuffer())], file);
    toast(t("다운로드 폴더에 저장했어요"), "info", { label: t("Finder에서 보기"), run: () => void revealPath(path) });
  } catch (e) {
    toast(t("저장하지 못했어요: {e}", { e: e instanceof Error ? e.message : String(e) }), "bad");
  }
}

const copyText = (text: string) =>
  void navigator.clipboard.writeText(text).then(
    () => toast(t("복사했어요")),
    (e) => toast(t("복사하지 못했어요: {e}", { e: e instanceof Error ? e.message : String(e) }), "bad"),
  );

export function menuItems(m: MenuTarget): MenuEntry[] {
  if (m.kind === "image")
    return [
      { id: "copy-image", label: t("이미지 복사"), icon: "copy", run: () => void copyImage(m.src) },
      { id: "save-image", label: t("이미지 저장"), icon: "download", run: () => void saveImage(m.src, m.name) },
      ...(/^https?:\/\//.test(m.src) ? (["sep", { id: "copy-image-link", label: t("이미지 주소 복사"), icon: "link", run: () => copyText(m.src) }] as MenuEntry[]) : []),
    ];
  if (m.kind === "text") return [{ id: "copy-text", label: t("복사"), icon: "copy", kbd: "⌘C", run: () => copyText(m.text) }];
  if (m.kind === "link") return linkMenuItems(m.url);
  return [];
}

function onContextMenu(e: MouseEvent) {
  // a part of the app with its own menu already answered
  if (e.defaultPrevented) return;
  // while building the app, ⌥ right-click still opens the web view's menu (Inspect Element)
  if (import.meta.env.DEV && e.altKey) return;
  const m = menuTarget(e.target instanceof Element ? e.target : null, window.getSelection()?.toString() ?? "");
  if (m.kind === "field") return;
  e.preventDefault();
  const items = menuItems(m);
  if (items.length) openMenuAt(`app:${m.kind}`, () => items, e);
}

/** Mounted once (App). */
export function installAppMenu(): () => void {
  window.addEventListener("contextmenu", onContextMenu);
  return () => window.removeEventListener("contextmenu", onContextMenu);
}
