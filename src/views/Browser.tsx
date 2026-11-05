// The shared browser every job uses, seen through the app's own tab in it.
// Signing in here signs every job in (one profile, kept across restarts).
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { sharedBrowserGo, sharedBrowserOpen } from "../lib/native";
import { Icon } from "../ui/Icon";

/** Keys that type nothing themselves but must reach the page (as the agent-browser dashboard sends them). */
const KEYS: Record<string, { text?: string; code: number }> = {
  Enter: { text: "\r", code: 13 },
  Tab: { text: "\t", code: 9 },
  Backspace: { text: "\b", code: 8 },
  Escape: { code: 27 },
  ArrowLeft: { code: 37 },
  ArrowUp: { code: 38 },
  ArrowRight: { code: 39 },
  ArrowDown: { code: 40 },
  Delete: { code: 46 },
  Home: { code: 36 },
  End: { code: 35 },
  PageUp: { code: 33 },
  PageDown: { code: 34 },
};

const mods = (e: MouseEvent | KeyboardEvent | WheelEvent) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);

const BUTTON = ["left", "middle", "right"] as const;

/** `example.com/login` → `https://example.com/login`; anything else is left alone. */
function address(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/\S*)?$/i.test(v)) return `${/^(localhost|127\.)/.test(v) ? "http" : "https"}://${v}`;
  return null;
}

export function BrowserView() {
  const [frame, setFrame] = createSignal<string | null>(null);
  const [size, setSize] = createSignal({ w: 1280, h: 800 });
  const [url, setUrl] = createSignal("");
  const [draft, setDraft] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [live, setLive] = createSignal(false);
  let ws: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  let screen: HTMLImageElement | undefined;
  let keys: HTMLTextAreaElement | undefined;

  const connect = async () => {
    if (!alive) return;
    let port = 0;
    try {
      port = await sharedBrowserOpen();
    } catch {
      setFailed(true);
    }
    if (!alive) return;
    if (!port) {
      timer = setTimeout(connect, 4000);
      return;
    }
    setFailed(false);
    ws = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=15`);
    ws.onopen = () => setLive(true);
    ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(m.data);
        if (msg.type === "frame") {
          setFrame(`data:image/jpeg;base64,${msg.data}`);
          if (msg.metadata?.deviceWidth) setSize({ w: msg.metadata.deviceWidth, h: msg.metadata.deviceHeight });
        } else if (msg.type === "url" && msg.url) setUrl(msg.url);
        else if (msg.type === "tabs") {
          const mine = (msg.tabs as { active?: boolean; url?: string }[] | undefined)?.find((t) => t.active);
          if (mine?.url) setUrl(mine.url);
        }
      } catch {
        /* not ours */
      }
    };
    ws.onclose = () => {
      setLive(false);
      if (alive) timer = setTimeout(connect, 1500);
    };
  };
  onMount(connect);
  onCleanup(() => {
    alive = false;
    clearTimeout(timer);
    ws?.close();
  });

  const send = (msg: Record<string, unknown>) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const point = (e: MouseEvent) => {
    const r = screen!.getBoundingClientRect();
    return { x: Math.round(((e.clientX - r.left) / r.width) * size().w), y: Math.round(((e.clientY - r.top) / r.height) * size().h) };
  };
  const mouse = (e: MouseEvent, eventType: string) => {
    const { x, y } = point(e);
    const button = eventType === "mouseMoved" ? (e.buttons & 1 ? "left" : "none") : (BUTTON[e.button] ?? "left");
    send({ type: "input_mouse", eventType, x, y, button, clickCount: eventType === "mouseMoved" ? 0 : Math.max(1, e.detail), modifiers: mods(e) });
  };
  let moving = 0;
  const move = (e: MouseEvent) => {
    if (moving) return;
    moving = requestAnimationFrame(() => {
      moving = 0;
      mouse(e, "mouseMoved");
    });
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    const { x, y } = point(e);
    send({ type: "input_mouse", eventType: "mouseWheel", x, y, button: "none", clickCount: 0, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: mods(e) });
  };
  const key = (e: KeyboardEvent, eventType: "keyDown" | "keyUp") => {
    // an IME is composing (Korean and the like): the text arrives on compositionend
    if (e.isComposing || e.key === "Process" || e.keyCode === 229) return;
    // ⌘V arrives as a paste event, so the text goes in whole
    if (e.metaKey && e.key.toLowerCase() === "v") return;
    e.preventDefault();
    const known = KEYS[e.key];
    const printable = e.key.length === 1 && !e.metaKey && !e.ctrlKey;
    const text = eventType === "keyDown" ? (known?.text ?? (printable ? e.key : undefined)) : undefined;
    const windowsVirtualKeyCode = known?.code ?? (e.key.length === 1 ? e.key.toUpperCase().charCodeAt(0) : 0);
    send({ type: "input_keyboard", eventType, key: e.key, code: e.code, text, windowsVirtualKeyCode, modifiers: mods(e) });
  };
  const typeText = (text: string) => {
    if (text) send({ type: "input_keyboard", eventType: "char", text });
    if (keys) keys.value = "";
  };

  const go = (raw: string) => {
    const target = address(raw);
    setDraft(null);
    if (!target) return;
    setUrl(target);
    void sharedBrowserGo("open", target).catch(() => {});
  };

  return (
    <div class="browser-view">
      <div class="head" data-tauri-drag-region>
        <h1>브라우저</h1>
      </div>
      <div class="bpane">
        <div class="bbar">
          <button class="icon-btn sm" title="뒤로" onClick={() => void sharedBrowserGo("back").catch(() => {})}>
            <Icon name="back" size={14} />
          </button>
          <button class="icon-btn sm" title="앞으로" onClick={() => void sharedBrowserGo("forward").catch(() => {})}>
            <Icon name="arrow" size={14} />
          </button>
          <button class="icon-btn sm" title="새로고침" onClick={() => void sharedBrowserGo("reload").catch(() => {})}>
            <Icon name="refresh" size={14} />
          </button>
          <label class="burl">
            <span class="bdot" classList={{ live: live() && !!frame() }} />
            <input
              class="burl-in"
              spellcheck={false}
              autocomplete="off"
              value={draft() ?? url().replace(/^about:blank$/, "")}
              onFocus={(e) => {
                setDraft(e.currentTarget.value);
                e.currentTarget.select();
              }}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onBlur={() => setDraft(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  go(e.currentTarget.value);
                  e.currentTarget.blur();
                } else if (e.key === "Escape") e.currentTarget.blur();
              }}
            />
          </label>
        </div>
        <div class="bscreen" onMouseDown={() => keys?.focus()}>
          <Show when={frame()} fallback={<div class="bempty">{failed() ? "브라우저를 열 수 없어요" : "브라우저 여는 중"}</div>}>
            {(f) => (
              <img
                ref={screen}
                src={f()}
                alt=""
                draggable={false}
                onMouseDown={(e) => {
                  e.preventDefault();
                  keys?.focus();
                  mouse(e, "mousePressed");
                  // a drag may end outside the picture
                  window.addEventListener("mouseup", (u) => mouse(u, "mouseReleased"), { once: true });
                }}
                onMouseMove={move}
                onWheel={wheel}
                onContextMenu={(e) => e.preventDefault()}
              />
            )}
          </Show>
          <textarea
            ref={keys}
            class="bkeys"
            aria-hidden="true"
            tabindex={-1}
            onKeyDown={(e) => key(e, "keyDown")}
            onKeyUp={(e) => key(e, "keyUp")}
            onCompositionEnd={(e) => typeText(e.data)}
            onPaste={(e) => {
              e.preventDefault();
              typeText(e.clipboardData?.getData("text/plain") ?? "");
            }}
          />
        </div>
      </div>
    </div>
  );
}
