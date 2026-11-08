import { getDocument, GlobalWorkerOptions, PasswordResponses } from "pdfjs-dist/legacy/build/pdf.mjs";
import { EventBus, PDFLinkService, PDFViewer } from "pdfjs-dist/legacy/web/pdf_viewer.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import "./styles/pdf.css";
import { bindPdfGestures, MAX_PDF_SCALE, MIN_PDF_SCALE, pdfScale } from "./lib/pdf-gestures";
import { lang, t } from "./i18n";
import { setState } from "./state/store";

// The viewer sits in an iframe of the app: use the app's language (its <html lang>), else the Mac's.
try {
  const l = window.parent !== window ? window.parent.document.documentElement.lang : "";
  if (l === "ko" || l === "en") setState("settings", "language", l);
} catch {
  // another origin: keep the Mac's language
}
document.documentElement.lang = lang();
// pdf.html's own labels (written in Korean) in the app's language
for (const el of document.querySelectorAll<HTMLElement>("[title], [aria-label]")) {
  for (const a of ["title", "aria-label"]) {
    const v = el.getAttribute(a);
    if (v) el.setAttribute(a, t(v));
  }
}
for (const el of document.querySelectorAll<HTMLElement>("option, #password-form button")) {
  if (el.textContent) el.textContent = t(el.textContent);
}
document.querySelector("#status")!.textContent = t("불러오는 중…");

GlobalWorkerOptions.workerSrc = workerUrl;
// Vite emits these with their original names: PDF.js requests them by name.
const assets = import.meta.glob<string>("../node_modules/pdfjs-dist/{cmaps,standard_fonts,wasm}/*", {
  query: "?url", import: "default", eager: true,
});
const assetDir = (dir: string) => {
  const url = Object.entries(assets).find(([path]) => path.includes(`/${dir}/`))![1];
  return new URL(".", new URL(url, location.href)).href;
};
const container = document.querySelector<HTMLDivElement>("#container")!;
const page = document.querySelector<HTMLInputElement>("#page")!;
const fit = document.querySelector<HTMLSelectElement>("#fit")!;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const previous = document.querySelector<HTMLButtonElement>("#previous")!;
const next = document.querySelector<HTMLButtonElement>("#next")!;
const minus = document.querySelector<HTMLButtonElement>("#minus")!;
const plus = document.querySelector<HTMLButtonElement>("#plus")!;
const bus = new EventBus();
const links = new PDFLinkService({ eventBus: bus, externalLinkTarget: 2, externalLinkRel: "noopener noreferrer" });
const viewer = new PDFViewer({ container, eventBus: bus, linkService: links });
links.setViewer(viewer);
let ready = false;
let targetScale: number | undefined;
const zoom = (factor: number, origin: [number, number]) => {
  if (!ready) return;
  const scale = pdfScale(targetScale ?? viewer.currentScale, factor);
  const page = document.elementFromPoint(...origin)?.closest<HTMLElement>(".page")
    ?? viewer.getPageView(viewer.currentPageNumber - 1).div;
  const contentBounds = () => {
    const r = page.getBoundingClientRect();
    return { left: r.left + page.clientLeft, top: r.top + page.clientTop, width: page.clientWidth, height: page.clientHeight };
  };
  const before = contentBounds();
  const x = (origin[0] - before.left) / before.width;
  const y = (origin[1] - before.top) / before.height;
  viewer.updateScale({ scaleFactor: scale / viewer.currentScale, drawingDelay: 150 });
  // Retain sub-percent deltas that PDF.js rounds away when updating the scale.
  targetScale = scale;
  // Anchor document content, excluding the fixed page border and margins.
  const after = contentBounds();
  container.scrollLeft += after.left + x * after.width - origin[0];
  container.scrollTop += after.top + y * after.height - origin[1];
};
const unbind = bindPdfGestures(document.documentElement, container, zoom);
const center = (): [number, number] => {
  const r = container.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2];
};
plus.onclick = () => zoom(1.1, center());
minus.onclick = () => zoom(1 / 1.1, center());
previous.onclick = () => viewer.currentPageNumber--;
next.onclick = () => viewer.currentPageNumber++;
page.onchange = () => {
  const n = Number(page.value);
  if (Number.isInteger(n) && n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n;
  page.value = String(viewer.currentPageNumber);
};
fit.onchange = () => {
  if (fit.value !== "custom") viewer.currentScaleValue = fit.value;
};
bus.on("pagechanging", ({ pageNumber }: { pageNumber: number }) => {
  page.value = String(pageNumber);
  previous.disabled = pageNumber === 1;
  next.disabled = pageNumber === viewer.pagesCount;
});
bus.on("scalechanging", ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
  targetScale = undefined;
  document.querySelector("#scale")!.textContent = `${Math.round(scale * 100)}%`;
  fit.value = presetValue === "page-width" || presetValue === "page-fit" ? presetValue : scale === 1 ? "1" : "custom";
  minus.disabled = scale <= MIN_PDF_SCALE;
  plus.disabled = scale >= MAX_PDF_SCALE;
});
bus.on("pagesinit", () => {
  ready = true;
  status.hidden = true;
  for (const control of [page, fit, plus, minus]) control.disabled = false;
  previous.disabled = true;
  next.disabled = viewer.pagesCount === 1;
  page.max = String(viewer.pagesCount);
  document.querySelector("#pages")!.textContent = `/ ${viewer.pagesCount}`;
  viewer.currentScaleValue = "page-width";
});
const resize = new ResizeObserver(() => {
  if (!ready) return;
  if (fit.value === "page-width" || fit.value === "page-fit") viewer.currentScaleValue = fit.value;
  viewer.update();
});
resize.observe(container);
// The iframe keeps document keys out of the surrounding app's shortcuts.
container.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) return;
  if ((e.ctrlKey || e.metaKey) && ["+", "=", "-", "0"].includes(e.key)) {
    e.preventDefault();
    if (e.key === "0") viewer.currentScaleValue = "page-fit";
    else zoom(e.key === "-" ? 1 / 1.1 : 1.1, center());
  }
});
const source = new URLSearchParams(location.search).get("file");
if (source) {
  const original = document.createElement("a");
  original.textContent = t("원본 보기");
  original.href = source;
  document.querySelector("nav")!.append(original);
  const task = getDocument({
    url: source,
    cMapUrl: assetDir("cmaps"), cMapPacked: true,
    standardFontDataUrl: assetDir("standard_fonts"), wasmUrl: assetDir("wasm"),
  });
  const passwordDialog = document.querySelector<HTMLDialogElement>("#password-dialog")!;
  const password = document.querySelector<HTMLInputElement>("#password")!;
  let cancelled = false;
  task.onPassword = (updatePassword: (value: string) => void, reason: number) => {
    password.value = "";
    document.querySelector("#password-message")!.textContent = reason === PasswordResponses.INCORRECT_PASSWORD
      ? t("비밀번호가 맞지 않아요") : t("PDF 비밀번호");
    document.querySelector<HTMLFormElement>("#password-form")!.onsubmit = (e) => {
      e.preventDefault();
      const value = password.value;
      password.value = "";
      passwordDialog.close();
      updatePassword(value);
    };
    passwordDialog.showModal();
  };
  const cancelPassword = () => {
    cancelled = true;
    password.value = "";
    passwordDialog.close();
    status.textContent = t("PDF 열기를 취소했어요");
    void task.destroy();
  };
  document.querySelector<HTMLButtonElement>("#password-cancel")!.onclick = cancelPassword;
  passwordDialog.oncancel = (e) => { e.preventDefault(); cancelPassword(); };
  task.promise.then((doc) => {
    viewer.setDocument(doc);
    links.setDocument(doc);
  }).catch(() => {
    if (cancelled) return;
    status.hidden = false;
    status.textContent = t("PDF를 열지 못했어요 · 원본 보기로 열 수 있어요");
  });
  window.addEventListener("pagehide", () => {
    ready = false;
    unbind();
    resize.disconnect();
    viewer.setDocument(null);
    links.setDocument(null);
    void task.destroy();
  }, { once: true });
} else {
  status.textContent = t("PDF 파일이 없어요");
}
