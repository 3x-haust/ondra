// The canvas's dot grid, drawn rather than tiled. A CSS background tile of 20 × zoom px gets rounded
// to whole pixels, differently at each zoom, so the dots jumped about while zooming; here each dot
// sits at its exact place. When dots get too close (zoomed far out) every other one drops, as in
// design tools, so the grid stays quiet and cheap.
import { createEffect, onCleanup, onMount } from "solid-js";

const STEP = 20;
/** closer than this on screen and the grid thins out */
const MIN_GAP = 11;
const R = 1;

export function DotGrid(props: { pan: { x: number; y: number }; zoom: number; on: boolean }) {
  let el!: HTMLCanvasElement;
  let frame = 0;
  let size = { w: 0, h: 0, dpr: 1 };
  let color = "";
  const draw = () => {
    frame = 0;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!props.on || !w || !h) return;
    let gap = STEP * props.zoom;
    while (gap < MIN_GAP) gap *= 2;
    const x0 = (((props.pan.x % gap) + gap) % gap);
    const y0 = (((props.pan.y % gap) + gap) % gap);
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let y = y0; y < h + R; y += gap) {
      for (let x = x0; x < w + R; x += gap) {
        ctx.moveTo(x + R, y);
        ctx.arc(x, y, R, 0, Math.PI * 2);
      }
    }
    ctx.fill();
  };
  const later = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  const measure = () => {
    const r = el.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    size = { w: r.width, h: r.height, dpr };
    el.width = Math.round(r.width * dpr);
    el.height = Math.round(r.height * dpr);
    color = getComputedStyle(el).getPropertyValue("--cv-dot").trim() || "rgb(128 128 128 / 12%)";
    draw();
  };
  onMount(() => {
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // the theme changes the dot colour
    const mo = new MutationObserver(measure);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", measure);
    onCleanup(() => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", measure);
      cancelAnimationFrame(frame);
    });
  });
  createEffect(() => {
    void props.pan.x, props.pan.y, props.zoom, props.on;
    later();
  });
  return <canvas class="cv-dots" ref={el} aria-hidden="true" />;
}
