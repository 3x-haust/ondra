// A job's tab in the shared browser, live: JPEG frames over the stream agent-browser serves
// (CDP screencast), the page's address, and clicks sent back. The panel's browser and the
// floating preview both watch a job this way.
import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { browserStreamPort } from "../lib/native";

export function useBrowserStream(job: () => { id: string; space?: string } | undefined, opts: { fps?: number } = {}) {
  const [frame, setFrame] = createSignal<string | null>(null);
  const [size, setSize] = createSignal({ w: 1280, h: 800 });
  const [url, setUrl] = createSignal("");
  let ws: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gen = 0;

  const stop = () => {
    gen++;
    clearTimeout(timer);
    ws?.close();
    ws = undefined;
  };
  const connect = async (id: string, space: string | undefined, g: number) => {
    const port = await browserStreamPort(id, space);
    if (g !== gen) return;
    if (!port) return void (timer = setTimeout(() => connect(id, space, g), 2500));
    const sock = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=${opts.fps ?? 10}`);
    ws = sock;
    sock.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (msg.type === "frame") {
          setFrame(`data:image/jpeg;base64,${msg.data}`);
          if (msg.metadata?.deviceWidth) setSize({ w: msg.metadata.deviceWidth, h: msg.metadata.deviceHeight });
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
  return { frame, size, url, click };
}
