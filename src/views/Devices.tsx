// Device hub: iOS simulators and Android emulators/phones in one place.
// Running ones show their screen (a fresh screenshot every few seconds); the open one
// is live — iOS frames as the screen changes, Android screenshots in a loop — and you
// drive it straight from here: touch and drag, type, home, rotate, screenshot, record.
import { Camera, Keyboard, RotateCw } from "lucide-solid";
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type Component } from "solid-js";
import {
  deviceBoot, deviceDelete, deviceInput, deviceInputWarm, deviceKey, deviceKeyboard, deviceLandscape, deviceRecord, deviceRecording, deviceRelease,
  deviceRotate, deviceScreenshot, deviceShot, deviceShutdown, deviceStream, deviceStreamPoke, deviceStreamStop, deviceTouch, fileSrc, revealPath,
  type Device, type DeviceAction,
} from "../lib/native";
import { devices, refreshDevices, usedBy } from "../state/devices";
import { openTask, setView, toast, view } from "../state/ui";
import { Icon } from "../ui/Icon";

type Filter = "all" | "ios" | "android";
const ago = (ms?: number | null) => {
  if (!ms) return "";
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 60 ? `${Math.max(1, m)}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`;
};
const platformLabel = (d: Device) => (d.platform === "ios" ? "iOS" : "Android") + (d.kind === "phone" ? " 기기" : "");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function act(label: string, f: () => Promise<unknown>) {
  try {
    await f();
    toast(label);
  } catch (e) {
    toast(errText(e), "bad");
  }
  setTimeout(() => void refreshDevices(), 800);
}

/** Icons the shared set doesn't have, drawn the same way. */
const extra: Record<string, Component<any>> = { keyboard: Keyboard, rotate: RotateCw, camera: Camera };
const Glyph = (p: { name: string; size?: number }) => {
  const C = extra[p.name];
  return C ? <C size={p.size ?? 16} stroke-width={1.75} class="icon" aria-hidden="true" /> : <Icon name={p.name} size={p.size} />;
};

/** 켜짐 / 사용 중 / 꺼짐, with its dot. */
function Status(props: { d: Device }) {
  const st = () => (!props.d.booted ? "off" : usedBy(props.d)?.status === "running" ? "busy" : "on");
  return (
    <span class={`dev-status ${st()}`}>
      <span class="dev-dot" />
      {st() === "off" ? "꺼짐" : st() === "busy" ? "사용 중" : "켜짐"}
    </span>
  );
}

function Actions(props: { d: Device }) {
  const [sure, setSure] = createSignal(false);
  return (
    <div class="dev-acts">
      <Show
        when={props.d.booted}
        fallback={<button class="btn sm" onClick={() => void act(`${props.d.name} 켜는 중이에요`, () => deviceBoot(props.d))}>켜기</button>}
      >
        <Show when={props.d.kind !== "phone"}>
          <button class="btn sm" onClick={() => void act(`${props.d.name} 껐어요`, () => deviceShutdown(props.d))}>끄기</button>
        </Show>
      </Show>
      <Show when={props.d.kind !== "phone" && !props.d.booted}>
        <button
          class="btn sm ghost"
          classList={{ danger: sure() }}
          onBlur={() => setSure(false)}
          onClick={() => (sure() ? void act(`${props.d.name} 지웠어요`, () => deviceDelete(props.d)) : setSure(true))}
        >
          {sure() ? "정말 지우기" : "지우기"}
        </button>
      </Show>
    </div>
  );
}

function UsedBy(props: { d: Device }) {
  const t = createMemo(() => usedBy(props.d));
  return (
    <Show when={t()}>
      {(x) => (
        <button class="dev-job" onClick={() => openTask(x().id)} title="이 일 열기">
          <span class={`dot ${x().status === "running" ? "live" : ""}`} />
          {x().status === "running" ? "쓰는 중 · " : "마지막 사용 · "}
          {x().title}
        </button>
      )}
    </Show>
  );
}

/**
 * A small picture of a running device, refreshed every few seconds while it can be
 * seen. A new screenshot replaces the old one only once it has loaded, so it never blinks.
 */
function Thumb(props: { d: Device; hidden: boolean; onOpen: () => void }) {
  const [src, setSrc] = createSignal("");
  let alive = true;
  let pending = false;
  // each picture costs the device a full-screen capture: only for cards on screen
  let seen = true;
  let el!: HTMLButtonElement;
  const grab = async () => {
    // hidden (another device is open), scrolled away or the window is in the back: skip
    if (pending || document.hidden || props.hidden || !seen) return;
    pending = true;
    const p = await deviceShot(props.d).catch(() => "");
    pending = false;
    if (!alive || !p) return;
    const url = `${fileSrc(p)}?v=${Date.now()}`;
    const img = new Image();
    img.onload = () => alive && setSrc(url);
    img.src = url;
  };
  onMount(() => {
    void grab();
    const id = setInterval(() => void grab(), 5000);
    const io = new IntersectionObserver(([e]) => {
      const was = seen;
      seen = e.isIntersecting;
      if (seen && !was) void grab();
    });
    io.observe(el);
    onCleanup(() => ((alive = false), clearInterval(id), io.disconnect()));
  });
  // shown again (the open device closed): fresh at once
  createEffect(on(() => props.hidden, (h) => !h && void grab(), { defer: true }));
  return (
    <button ref={el} class="dev-screen" classList={{ android: props.d.platform === "android" }} onClick={() => props.onOpen()} title="열어서 조작하기">
      <Show when={src()} fallback={<span class="dev-wait">화면 가져오는 중</span>}>
        <img src={src()} alt={`${props.d.name} 화면`} draggable={false} />
      </Show>
    </button>
  );
}

// Turned to landscape from here, per device, for as long as the app runs. An iOS
// simulator's framebuffer stays portrait when turned, so its picture is turned here.
const [turned, setTurned] = createSignal<Record<string, boolean>>({});
const [recording, setRecording] = createSignal<string[]>([]);
/** per device: speed its live screen up again (an Android one slows down while still) */
const pokes = new Map<string, () => void>();

/**
 * The open device's screen, live. iOS: frames as the screen changes, up to 30 a
 * second, and touches go to the device as they happen (press, drag, let go). Android:
 * screenshots in a loop, a click is a tap and a drag a swipe. With the screen focused,
 * typing goes to the device.
 */
function LiveScreen(props: { d: Device }) {
  const ios = props.d.platform === "ios";
  const [size, setSize] = createSignal<{ w: number; h: number } | null>(null);
  const [box, setBox] = createSignal({ w: 0, h: 0 });
  const [mark, setMark] = createSignal<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [, setPolling] = createSignal(false);
  const turn = () => ios && !!turned()[props.d.id];
  /** size changes snap; only a rotation turns smoothly */
  const [turning, setTurning] = createSignal(false);
  createEffect(on(turn, () => { setTurning(true); setTimeout(() => setTurning(false), 400); }, { defer: true }));
  let stage!: HTMLDivElement;
  let canvas!: HTMLCanvasElement;
  let alive = true;

  // ── frames → canvas. Decoding runs off the main thread; when frames arrive faster
  // than they decode, only the newest is kept.
  let latest: ArrayBuffer | null = null;
  let decoding = false;
  const paint = (img: CanvasImageSource, w: number, h: number) => {
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    canvas.getContext("2d")?.drawImage(img, 0, 0);
    const s = size();
    if (!s || s.w !== w || s.h !== h) setSize({ w, h });
  };
  const pump = async () => {
    decoding = true;
    while (latest && alive) {
      const buf = latest;
      latest = null;
      try {
        const bmp = await createImageBitmap(new Blob([buf]));
        if (alive) paint(bmp, bmp.width, bmp.height);
        bmp.close();
      } catch {
        /* a bad frame: wait for the next */
      }
    }
    decoding = false;
  };

  // ── the stream, with a fallback to screenshots when it can't run
  let token: number | null = null;
  let tries = 0;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  const poll = () => {
    if (pollTimer) return;
    setPolling(true);
    let pending = false;
    const grab = async () => {
      if (pending || document.hidden) return;
      pending = true;
      const p = await deviceShot(props.d).catch(() => "");
      pending = false;
      if (!alive || !p) return;
      const img = new Image();
      img.onload = () => alive && paint(img, img.naturalWidth, img.naturalHeight);
      img.src = `${fileSrc(p)}?v=${Date.now()}`;
    };
    void grab();
    pollTimer = setInterval(() => void grab(), 1200);
  };
  // the window in the back: no frames (they cost the device and the Mac); back in front, again
  let paused = false;
  const start = async () => {
    // frames as big as the stage shows them, not bigger
    const tall = stage?.clientHeight || window.innerHeight;
    const max = Math.min(2400, Math.round(Math.max(tall, 480) * (window.devicePixelRatio || 1)));
    let got = false;
    const t = await deviceStream(props.d, { max, fps: ios ? 30 : 6 }, (buf) => {
      if (!alive || paused) return;
      if (buf.byteLength === 0) {
        // ended: try again a couple of times, then settle for screenshots
        token = null;
        if (got) tries = 0;
        if (++tries <= 2) setTimeout(() => alive && void start(), 1500);
        else poll();
        return;
      }
      got = true;
      latest = buf;
      if (!decoding) void pump();
    }).catch(() => null);
    if (!alive || paused) return void (t != null && deviceStreamStop(t));
    if (t == null) poll();
    else token = t;
  };
  const visibility = () => {
    if (document.hidden && !paused && !pollTimer) {
      paused = true;
      if (token != null) void deviceStreamStop(token);
      token = null;
    } else if (!document.hidden && paused) {
      paused = false;
      tries = 0;
      void start();
    }
  };
  /** an Android stream slows down on a still screen; a touch brings it back at once */
  const poke = () => !ios && token != null && void deviceStreamPoke(token);
  pokes.set(props.d.id, poke);
  onCleanup(() => pokes.get(props.d.id) === poke && pokes.delete(props.d.id));
  onMount(() => {
    void start();
    if (ios) void deviceInputWarm(props.d).catch(() => {});
    void deviceLandscape(props.d).then((land) => alive && setTurned((t) => ({ ...t, [props.d.id]: land })));
    const ro = new ResizeObserver(([e]) => setBox({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(stage);
    document.addEventListener("visibilitychange", visibility);
    onCleanup(() => {
      alive = false;
      document.removeEventListener("visibilitychange", visibility);
      ro.disconnect();
      clearInterval(pollTimer);
      if (token != null) void deviceStreamStop(token);
      if (ios) void deviceRelease(props.d);
    });
  });

  // ── fit the picture in the stage, turned or not
  const fit = createMemo(() => {
    const s = size() ?? { w: 9, h: 19.5 };
    const b = box();
    const [w, h] = turn() ? [s.h, s.w] : [s.w, s.h];
    const k = Math.min(b.w / w, b.h / h) || 0;
    return { w: Math.floor(w * k), h: Math.floor(h * k) };
  });

  // ── input. Steps go one after another; moves in between collapse into the newest.
  let chain: Promise<unknown> = Promise.resolve();
  let failed = false;
  const fail = (e: unknown) => {
    if (failed) return;
    failed = true;
    toast(errText(e), "bad");
    setTimeout(() => (failed = false), 3000);
  };
  const queue = (f: () => Promise<unknown>) => (chain = chain.then(f).catch(fail));
  let moveTo: { x: number; y: number } | null = null;
  const touch = (phase: "down" | "move" | "up", p: { x: number; y: number }) => {
    if (phase !== "move") return void queue(() => deviceTouch(props.d, phase, p.x, p.y));
    const queued = moveTo !== null;
    moveTo = p;
    if (!queued)
      queue(() => {
        const m = moveTo!;
        moveTo = null;
        return deviceTouch(props.d, "move", m.x, m.y);
      });
  };
  const send = async (action: DeviceAction, o: Parameters<typeof deviceInput>[2] = {}) => {
    poke();
    setBusy(true);
    await deviceInput(props.d, action, o).catch(fail);
    setBusy(false);
  };

  /** pointer → where on the device's own (portrait) screen, 0..1; and where on the picture, for the mark */
  const at = (e: PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const u = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const v = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    // the picture is turned a quarter clockwise: undo it
    return { dev: turn() ? { x: v, y: 1 - u } : { x: u, y: v }, view: { x: u, y: v } };
  };
  let start0: { x: number; y: number; t: number } | null = null;
  const down = (e: PointerEvent) => {
    if (e.button !== 0 || !size()) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).focus();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* not a live pointer */
    }
    const p = at(e);
    setMark(p.view);
    start0 = { ...p.dev, t: Date.now() };
    if (ios) touch("down", p.dev);
  };
  const move = (e: PointerEvent) => {
    if (!start0) return;
    const p = at(e);
    setMark(p.view);
    if (ios) touch("move", p.dev);
  };
  const up = (e: PointerEvent) => {
    if (!start0) return;
    const s = start0;
    start0 = null;
    const p = at(e);
    setMark(null);
    if (ios) return touch("up", p.dev);
    const ms = Math.min(1500, Math.max(100, Date.now() - s.t));
    if (Math.hypot(p.dev.x - s.x, p.dev.y - s.y) < 0.02) void send("tap", { x: s.x, y: s.y });
    else void send("swipe", { x: s.x, y: s.y, x2: p.dev.x, y2: p.dev.y, ms });
  };
  const keys = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
  const key = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // iOS takes the physical key (its own input source picks the letter); Android the character
    const physical = ios && /^(Key[A-Z]|Digit\d|Space|Minus|Equal|Bracket|Backslash|Semicolon|Quote|Backquote|Comma|Period|Slash)/.test(e.code);
    if (!physical && (e.isComposing || (e.key.length !== 1 && !keys.has(e.key)))) return;
    e.preventDefault();
    const k = { key: e.key, code: e.code, shift: e.shiftKey };
    poke();
    queue(() => deviceKey(props.d, k));
  };
  const paste = (e: ClipboardEvent) => {
    const t = e.clipboardData?.getData("text/plain");
    if (!t) return;
    e.preventDefault();
    void send("text", { text: t });
  };

  return (
    <div class="dev-stage" ref={stage}>
      <div
        class="dev-frame"
        classList={{ android: !ios, busy: busy(), ready: !!size(), turning: turning() }}
        style={{ width: `${fit().w}px`, height: `${fit().h}px` }}
        tabIndex={0}
        role="application"
        aria-label={`${props.d.name} 화면`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
        onPaste={paste}
      >
        <canvas
          ref={canvas}
          class="dev-canvas"
          style={{
            width: `${turn() ? fit().h : fit().w}px`,
            height: `${turn() ? fit().w : fit().h}px`,
            transform: `translate(-50%, -50%) rotate(${turn() ? 90 : 0}deg)`,
          }}
        />
        <Show when={!size()}>
          <span class="dev-wait">화면 가져오는 중</span>
        </Show>
        <Show when={mark()}>{(m) => <span class="dev-mark" style={{ left: `${m().x * 100}%`, top: `${m().y * 100}%` }} />}</Show>
      </div>
    </div>
  );
}

/** The grouped buttons beside the open device. */
function Tools(props: { d: Device }) {
  const ios = props.d.platform === "ios";
  const [kb, setKb] = createSignal(false);
  const rec = () => recording().includes(props.d.id);
  const run = async (f: () => Promise<unknown>) => {
    pokes.get(props.d.id)?.();
    try {
      await f();
    } catch (e) {
      toast(errText(e), "bad");
    }
  };
  const saved = (label: string, p: string) => toast(label, "info", { label: "보기", run: () => void revealPath(p) });
  const T = (p: { icon: string; label: string; on?: boolean; class?: string; click: () => unknown }) => (
    <button class={`icon-btn dev-tool ${p.class ?? ""}`} classList={{ on: !!p.on }} title={p.label} aria-label={p.label} aria-pressed={p.on} onClick={() => void p.click()}>
      <Glyph name={p.icon} size={16} />
    </button>
  );
  return (
    <div class="dev-tools" role="toolbar" aria-label="기기 조작">
      <div class="dev-tools-group">
        <T icon="home" label="홈" click={() => run(() => deviceInput(props.d, "home"))} />
        <T icon="back" label="뒤로" click={() => run(() => deviceInput(props.d, "back"))} />
      </div>
      <div class="dev-tools-group">
        <Show when={ios}>
          <T icon="keyboard" label={kb() ? "키보드 숨기기" : "키보드 보이기"} on={kb()} click={() => run(async () => setKb(await deviceKeyboard(props.d)))} />
        </Show>
        <T
          icon="rotate"
          label="돌리기"
          on={!!turned()[props.d.id]}
          click={() => run(async () => {
            const land = await deviceRotate(props.d);
            setTurned((t) => ({ ...t, [props.d.id]: land }));
          })}
        />
      </div>
      <div class="dev-tools-group">
        <T icon="camera" label="스크린샷" click={() => run(async () => saved("스크린샷을 데스크톱에 저장했어요", await deviceScreenshot(props.d)))} />
        <T
          icon={rec() ? "stop" : "video"}
          label={rec() ? "녹화 멈추기" : "녹화"}
          class={rec() ? "rec" : ""}
          click={() => run(async () => {
            const p = await deviceRecord(props.d);
            setRecording(await deviceRecording());
            if (p) saved("녹화를 데스크톱에 저장했어요", p);
          })}
        />
      </div>
    </div>
  );
}

/** Longer text (any language) goes through the device's clipboard. */
function TypeBox(props: { d: Device }) {
  const [text, setText] = createSignal("");
  const send = async (action: DeviceAction, o: { text?: string } = {}) => {
    try {
      await deviceInput(props.d, action, o);
    } catch (e) {
      toast(errText(e), "bad");
    }
  };
  return (
    <div class="dev-side">
      <form
        class="dev-type"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text();
          if (!t) return void send("enter");
          setText("");
          void send("text", { text: t });
        }}
      >
        <input placeholder="글자 보내기" value={text()} onInput={(e) => setText(e.currentTarget.value)} />
      </form>
    </div>
  );
}

/** A running device: its screen (click to drive it) and what's using it. */
function LiveCard(props: { d: Device; hidden: boolean; onOpen: () => void }) {
  return (
    <div class="dev-card">
      <Thumb d={props.d} hidden={props.hidden} onOpen={props.onOpen} />
      <div class="dev-info">
        <div class="dev-name">
          <b>{props.d.name}</b>
        </div>
        <div class="dev-sub">{platformLabel(props.d)} · {props.d.runtime}</div>
        <Status d={props.d} />
        <UsedBy d={props.d} />
        <Actions d={props.d} />
      </div>
    </div>
  );
}

/** One device, large, driven from here. */
function Control(props: { d: Device; onClose: () => void }) {
  onMount(() => {
    void deviceRecording().then(setRecording);
    const k = (e: KeyboardEvent) => e.key === "Escape" && !(e.target as HTMLElement).closest("input, .dev-frame") && props.onClose();
    window.addEventListener("keydown", k);
    onCleanup(() => window.removeEventListener("keydown", k));
  });
  return (
    <div class="dev-control">
      <div class="dev-control-head">
        <button class="icon-btn" title="목록으로 (Esc)" onClick={props.onClose}><Icon name="back" size={15} /></button>
        <b>{props.d.name}</b>
        <Status d={props.d} />
        <span class="dev-sub">{platformLabel(props.d)} · {props.d.runtime}</span>
        <Show when={recording().includes(props.d.id)}>
          <span class="dev-rec-label">녹화 중</span>
        </Show>
        <UsedBy d={props.d} />
        <span class="spacer" />
        <Actions d={props.d} />
      </div>
      <div class="dev-live">
        <LiveScreen d={props.d} />
        <Tools d={props.d} />
        <TypeBox d={props.d} />
      </div>
    </div>
  );
}

/** "iOS 26.3" before "iOS 18.6" before Android; numbers compared as numbers. */
const byRuntime = (a: string, b: string) => {
  const os = (s: string) => (s.startsWith("iOS") ? 0 : s.startsWith("Android") ? 2 : 1);
  return os(a) - os(b) || b.localeCompare(a, undefined, { numeric: true });
};

export function Devices() {
  const [filter, setFilter] = createSignal<Filter>("all");
  // the open device lives in the view, so the sidebar can open one and light only that row
  const focus = () => { const v = view(); return v.name === "devices" ? v.device : undefined; };
  const setFocus = (device?: string) => setView({ name: "devices", device });
  const focused = () => devices().find((d) => d.id === focus() && d.booted);
  onMount(() => void refreshDevices());
  const shown = () => devices().filter((d) => filter() === "all" || d.platform === filter());
  const on = () => shown().filter((d) => d.booted);
  const off = () => shown().filter((d) => !d.booted).sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
  /** switched-off devices by OS version */
  const groups = createMemo(() => {
    const m = new Map<string, Device[]>();
    for (const d of off()) m.set(d.runtime, [...(m.get(d.runtime) ?? []), d]);
    return [...m.entries()].sort((a, b) => byRuntime(a[0], b[0]));
  });
  const count = (p: Filter) => devices().filter((d) => p === "all" || d.platform === p).length;
  return (
    <div class="devices-view">
      <div class="head" data-tauri-drag-region>
        <h1>디바이스</h1>
        <span class="muted dev-count">{devices().filter((d) => d.booted).length}개 켜짐 · 전체 {devices().length}개</span>
        <span class="spacer" />
        <div class="seg">
          <For each={[["all", "전체"], ["ios", "iOS"], ["android", "Android"]] as [Filter, string][]}>
            {([id, label]) => (
              <button classList={{ on: filter() === id }} onClick={() => setFilter(id)}>
                {label} <span class="muted">{count(id)}</span>
              </button>
            )}
          </For>
        </div>
        <button class="icon-btn" title="새로고침" onClick={() => void refreshDevices()}><Icon name="refresh" size={15} /></button>
      </div>
      <Show when={focused()} keyed>
        {(d) => <Control d={d} onClose={() => setFocus(undefined)} />}
      </Show>
      <div class="devices-body" classList={{ hidden: !!focused() }}>
        <div class="dev-section">켜져 있어요 <span class="muted">{on().length}</span></div>
        <div class="dev-grid">
          <For each={on()} fallback={<p class="sb-empty">켜진 기기 없음</p>}>
            {(d) => <LiveCard d={d} hidden={!!focused()} onOpen={() => setFocus(d.id)} />}
          </For>
        </div>
        <Show when={off().length}>
          <div class="dev-section">꺼져 있어요 <span class="muted">{off().length}</span></div>
          <div class="dev-list">
            <For each={groups()}>
              {([runtime, list]) => (
                <div class="dev-group">
                  <div class="dev-group-head">{runtime} <span class="muted">{list.length}</span></div>
                  <For each={list}>
                    {(d) => (
                      <div class="dev-row">
                        <Icon name="phone" size={15} class="muted" />
                        <b>{d.name}</b>
                        <span class="dev-sub">{platformLabel(d)}</span>
                        <Show when={d.lastUsed}><span class="dev-sub">{ago(d.lastUsed)}</span></Show>
                        <UsedBy d={d} />
                        <span class="spacer" />
                        <Actions d={d} />
                      </div>
                    )}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
