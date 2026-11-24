// A job's tab in the shared browser, live: JPEG frames over the stream ondra-browser serves
// (CDP screencast), the page's address, and clicks sent back. The panel's browser and the
// floating preview both watch a job this way.
import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { browserStreamPort } from "../lib/native";

/** how long frames laid out for another size are passed over after the page is asked to fit */
export const FIT_MS = 1500;

export function useBrowserStream(job: () => { id: string; space?: string } | undefined, opts: { fps?: number } = {}) {
  const [frame, setFrame] = createSignal<string | null>(null);
  const [size, setSize] = createSignal({ w: 1280, h: 800 });
  const [url, setUrl] = createSignal("");
  let ws: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gen = 0;
  /** the area the page is shown in, sent so the page is laid out at that size */
  let area: { width: number; height: number } | undefined;
  /** when the page was last asked to take that size: frames still laid out for another one
   *  (the last frame kept from before, a page catching up) are passed over for a moment, so the
   *  pane doesn't first show the page shrunk to fit and then jump */
  let askedAt = 0;
  const sendArea = () => {
    if (area && ws?.readyState === WebSocket.OPEN) (ws.send(JSON.stringify({ type: "viewport", ...area })), (askedAt = Date.now()));
  };
  // the browser lays a page out no narrower than 320 (Daemon.fit)
  const stale = (w: unknown) => !!area && typeof w === "number" && Math.abs(w - Math.min(Math.max(area.width, 320), 3840)) > 4 && Date.now() - askedAt < FIT_MS;
  /** a frame passed over: shown after all if no fitted one comes (a page that doesn't refit) */
  let held: { src: string; w: number; h: number } | undefined;
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  const show = (src: string, w?: number, h?: number) => {
    held = undefined;
    clearTimeout(holdTimer);
    setFrame(src);
    if (w) setSize({ w, h: h ?? size().h });
  };
  let tries = 0;

  const stop = () => {
    gen++;
    clearTimeout(timer);
    clearTimeout(holdTimer);
    held = undefined;
    ws?.close();
    ws = undefined;
  };
  const connect = async (id: string, space: string | undefined, g: number) => {
    const port = await browserStreamPort(id, space);
    if (g !== gen) return;
    // the job's browser is often a moment from up: look again soon, then less often
    if (!port) return void (timer = setTimeout(() => connect(id, space, g), tries++ < 6 ? 700 : 2500));
    const sock = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=${opts.fps ?? 10}`);
    ws = sock;
    sock.onopen = sendArea;
    sock.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (msg.type === "frame") {
          const src = `data:image/jpeg;base64,${msg.data}`;
          if (stale(msg.metadata?.deviceWidth)) {
            held = { src, w: msg.metadata.deviceWidth, h: msg.metadata.deviceHeight };
            clearTimeout(holdTimer);
            holdTimer = setTimeout(() => held && show(held.src, held.w, held.h), Math.max(0, askedAt + FIT_MS - Date.now()));
            return;
          }
          show(src, msg.metadata?.deviceWidth, msg.metadata?.deviceHeight);
        } else if (msg.type === "url" && msg.url) setUrl(msg.url);
      } catch {
        /* not a message of ours */
      }
    };
    sock.onclose = () => {
      if (g === gen) timer = setTimeout(() => connect(id, space, g), 2500);
    };
  };
  // a different job (or none): drop the old stream and its last frame, watch the new one
  createEffect(
    on(
      () => job()?.id,
      (id) => {
        stop();
        tries = 0;
        setFrame(null);
        setUrl("");
        const j = job();
        if (id && j) void connect(id, j.space, gen);
      },
    ),
  );
  onCleanup(stop);

  /** a left click at x/y on the shown frame (0..1 of its width and height) */
  const click = (fx: number, fy: number) => {
    if (ws?.readyState !== WebSocket.OPEN) return;
    const x = Math.round(fx * size().w);
    const y = Math.round(fy * size().h);
    for (const eventType of ["mousePressed", "mouseReleased"]) ws.send(JSON.stringify({ type: "input_mouse", eventType, x, y, button: "left", clickCount: 1 }));
  };
  /** lay the page out at w×h (the panel's page area) while this watches */
  const fit = (w: number, h: number) => {
    const next = { width: Math.floor(w), height: Math.floor(h) };
    if (next.width < 50 || next.height < 50 || (area && area.width === next.width && area.height === next.height)) return;
    area = next;
    sendArea();
  };
  return { frame, size, url, click, fit };
}
