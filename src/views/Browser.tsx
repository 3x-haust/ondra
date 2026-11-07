// The in-app browser: a real webview (the system's WebKit) laid over this view's
// page area. This view is its toolbar and keeps the webview on the area it owns;
// sign-ins made in it are copied to the shared browser the jobs use.
import { createSignal, onCleanup, onMount } from "solid-js";
import { inBrowserGo, inBrowserHide, inBrowserShow, onInBrowserPage } from "../lib/native";
import { state } from "../state/store";
import { browserTarget, paletteOpen, setBrowserTarget } from "../state/ui";
import { Icon } from "../ui/Icon";

/** `example.com/login` → `https://example.com/login`; words → a search. */
function address(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/\S*)?$/i.test(v)) return `${/^(localhost|127\.)/.test(v) ? "http" : "https"}://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

/** `embedded`: inside the right panel. */
export function BrowserView(_props: { embedded?: boolean }) {
  const [url, setUrl] = createSignal("");
  const [loading, setLoading] = createSignal(false);
  const [draft, setDraft] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  let area!: HTMLDivElement;
  let placed = "";
  let alive = true;

  // keep the webview exactly on the area (it moves with resizes and the panel's width)
  const place = () => {
    if (!alive || !area) return;
    const r = area.getBoundingClientRect();
    const hidden = paletteOpen() || r.width < 20 || r.height < 20 || !area.isConnected;
    const key = hidden ? "hidden" : `${state.space}:${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)}`;
    const target = browserTarget();
    if (key === placed && !target) return;
    placed = key;
    if (hidden) return void inBrowserHide();
    if (target) setBrowserTarget(null);
    inBrowserShow({ x: r.left, y: r.top, w: r.width, h: r.height }, state.space, target ?? undefined)
      .then(() => setFailed(false))
      .catch(() => {
        placed = "";
        setFailed(true);
      });
  };
  let frame = 0;
  const tick = () => {
    place();
    frame = requestAnimationFrame(tick);
  };
  onMount(() => {
    frame = requestAnimationFrame(tick);
    const off = onInBrowserPage((p) => {
      // each space has its own page; another space's loads aren't this toolbar's
      if (p.space && p.space !== state.space) return;
      setLoading(p.loading);
      if (p.url && p.url !== "about:blank") setUrl(p.url);
    });
    onCleanup(() => void off.then((f) => f()));
  });
  onCleanup(() => {
    alive = false;
    cancelAnimationFrame(frame);
    void inBrowserHide();
  });

  const go = (raw: string) => {
    const target = address(raw);
    setDraft(null);
    if (!target) return;
    setUrl(target);
    void inBrowserGo("open", state.space, target).catch(() => {});
  };

  return (
    <div class="browser-view embedded">
      <div class="bpane">
        <div class="bbar">
          <button class="icon-btn sm" title="뒤로" onClick={() => void inBrowserGo("back", state.space).catch(() => {})}>
            <Icon name="back" size={14} />
          </button>
          <button class="icon-btn sm" title="앞으로" onClick={() => void inBrowserGo("forward", state.space).catch(() => {})}>
            <Icon name="arrow" size={14} />
          </button>
          <button class="icon-btn sm" title="새로고침" onClick={() => void inBrowserGo("reload", state.space).catch(() => {})}>
            <Icon name="refresh" size={14} />
          </button>
          <label class="burl">
            <span class="bdot" classList={{ live: loading() }} />
            <input
              class="burl-in"
              spellcheck={false}
              autocomplete="off"
              placeholder="주소나 검색어"
              value={draft() ?? url()}
              onFocus={(e) => {
                setDraft(e.currentTarget.value);
                e.currentTarget.select();
              }}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onBlur={() => setDraft(null)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.isComposing) {
                  go(e.currentTarget.value);
                  e.currentTarget.blur();
                } else if (e.key === "Escape") e.currentTarget.blur();
              }}
            />
          </label>
        </div>
        <div class="bscreen" ref={area}>
          {failed() ? <div class="bempty">브라우저를 열 수 없어요</div> : !url() ? <div class="bempty">열린 페이지 없음</div> : null}
        </div>
      </div>
    </div>
  );
}
