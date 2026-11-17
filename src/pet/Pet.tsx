// The pet window's page (#pet): the pet walks the screen and climbs its walls, falls, is picked up
// and thrown, sleeps, and says what the main window tells it (a job done, a question, a failure).
// A question with choices is answered right in its bubble; a click on the bubble opens that job.
// Its window is moved and sized every frame to just hold it (and its bubble), so the rest of the
// screen stays clickable. The behaviour is brain.ts; this file reads the world and draws.
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { availableMonitors } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { fileSrc, inTauri, onEvent, petClicked, petFrame, petGet, petList, petTell, petWindows, type PetConfig, type PetWord } from "../lib/native";
import { actFor, type Body, type Box, hear, meet, type Other, pictureFor, release, shown, step, wallMiddle, type Win, type Word, type World, worldOf } from "./brain";
import { BUILTIN, parseSpec, type PictureBody, type PetSpec, pictureBody } from "./spec";
import { t } from "../i18n";

const BUBBLE_W = 240;
const ASK_W = 280;
const MENU_W = 168;
/** its menu closes by itself when the pointer never comes to it */
const MENU_IDLE_MS = 5_000;

async function loadSpec(id: string, v = 0): Promise<PetSpec> {
  if (!id || id === "default") return BUILTIN;
  const found = (await petList().catch(() => [])).find((p) => p.id === id);
  return (found && parseSpec(found.id, found.json, (f) => `${fileSrc(`${found.dir}/${f}`)}?v=${v}`)) || BUILTIN;
}

/** the work areas of the screens, in points */
async function screens(): Promise<Box[]> {
  const ms = await availableMonitors().catch(() => []);
  const out = ms.map((m) => {
    const s = m.scaleFactor || 1;
    const a = m.workArea ?? { position: m.position, size: m.size };
    return { x: a.position.x / s, y: a.position.y / s, w: a.size.width / s, h: a.size.height / s };
  });
  return out.length ? out : [{ x: 0, y: 25, w: window.screen.availWidth || 1440, h: (window.screen.availHeight || 875) - 25 }];
}

const inBox = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.w && y >= b.y - 4 && y <= b.y + b.h + 4;

export function Pet() {
  // which pet this window is (#pet/0, #pet/1, …): the first one says what happened, the others react
  const index = Number(location.hash.split("/")[1]) || 0;
  const talker = index === 0;
  const [spec, setSpec] = createSignal<PetSpec>(BUILTIN);
  const [config, setConfig] = createSignal<PetConfig>({ on: false, ids: ["default"], size: 88 });
  const [body, setBody] = createSignal<Body>({ x: 400, y: 400, vx: 0, vy: 0, act: "fall", dir: 1, until: 0, stirred: Date.now() });
  const [words, setWords] = createSignal<Word[]>([]);
  // the picture shown, in its own pixels, and the character's height in idle: every act is drawn at one scale
  // (that height is the pet's size), so a GIF with room above for sparkles or Zz is not shrunk to fit
  // every picture's own size, by address (all are loaded up front and stacked: switching acts shows
  // another one already loaded and playing, so nothing blinks while a GIF loads)
  const [sizes, setSizes] = createSignal<Record<string, { w: number; h: number }>>({});
  const nat = () => sizes()[pic() ?? ""] ?? sizes()[spec().actions.idle ?? ""] ?? { w: 80, h: 100 };
  const [refH, setRefH] = createSignal(100);
  /** where the character is in each picture, by address (for walls: its front, not the picture's edge, touches) */
  const [bodies, setBodies] = createSignal<Record<string, PictureBody>>({});
  const [bubbleH, setBubbleH] = createSignal(60);
  const [now, setNow] = createSignal(Date.now());
  let busy = 0;
  let wins: Win[] = [];
  let works: Box[] = [];
  let work: Box = { x: 0, y: 25, w: 1440, h: 850 };
  let world: World = { ledges: [], walls: [] };
  let placed = false;
  /** the other pets, as they last said; when it last met each; when it last said where it is */
  const others = new Map<number, Other & { at: number }>();
  const met = new Map<number, number>();
  let told = 0;

  const size = () => Math.max(40, Math.min(200, config().sizes?.[config().ids[index] ?? ""] || config().size || 88));
  const pic = () => pictureFor(spec().actions, body().act);
  const pics = () => [...new Set(Object.values(spec().actions).filter((x): x is string => !!x))];
  const scale = () => size() / Math.max(1, refH());
  const petW = () => Math.round(nat().w * scale());
  const petH = () => Math.round(nat().h * scale());
  const wallOf = () => {
    const id = body().wall;
    return id === undefined ? undefined : world.walls.find((w) => w.id === id);
  };
  // on a wall it says nothing: something to say brings it down first
  const word = () => (body().wall === undefined ? shown(words(), now()) : undefined);
  /** the bubble sits over the empty top of the picture (most pets have room above their head) */
  const overlap = () => Math.round(petH() * 0.22);
  // its right-click menu, drawn in its own window over its head like a bubble. Not the system's menu: that
  // one runs its own loop while open, and the pets moving their windows meanwhile froze the whole app
  const [menuOpen, setMenuOpen] = createSignal(false);
  /** what is over its head: its menu, or what it has to say */
  const card = () => (menuOpen() ? "menu" : word() ? "word" : undefined);
  const bubbleW = () => (menuOpen() ? MENU_W : word()?.ask ? ASK_W : BUBBLE_W);
  /** the window: where and how big, in screen points */
  const frame = () => {
    const b = body();
    const w = wallOf();
    let pet = { x: b.x - petW() / 2, y: b.y - petH(), w: petW(), h: petH() };
    if (w) {
      // upright beside the wall, facing it, its front against it (not the empty edge of its picture)
      const m = wallMiddle(w, b.y, petW());
      const p = bodies()[pic() ?? ""];
      const gap = p ? ((w.side === 1) !== flip() ? p.w - 1 - p.box.r : p.box.l) * (petW() / p.w) : 0;
      pet = { x: m.x - petW() / 2 + w.side * gap, y: m.y - petH() / 2, w: petW(), h: petH() };
    }
    if (!card()) return pet;
    const fw = Math.max(pet.w, bubbleW());
    const up = bubbleH() - overlap();
    return { x: pet.x + pet.w / 2 - fw / 2, y: pet.y - up, w: fw, h: pet.h + up };
  };

  const relook = () => {
    const b = body();
    work = works.find((s) => inBox(s, b.x, b.y)) ?? works[0] ?? work;
    world = worldOf(work, wins.filter((w) => w.x < work.x + work.w && w.x + w.w > work.x));
  };
  const refresh = async () => {
    wins = await petWindows().catch(() => []);
    relook();
  };

  const apply = async (c: PetConfig) => {
    setConfig(c);
    const sp = await loadSpec(c.ids[index] ?? c.ids[0] ?? "default", c.v);
    // sized by the character standing in idle, not by its picture (room drawn around it doesn't shrink it)
    void pictureBody(sp.actions.idle ?? "").then((p) => p && setRefH(p.box.b - p.box.t + 1));
    for (const src of [sp.actions.climb, sp.actions.cling]) if (src) void pictureBody(src).then((p) => p && setBodies((m) => ({ ...m, [src]: p })));
    setSpec(sp);
  };

  const hearWord = (w: PetWord) => {
    if (w.kind === "busy") return void (busy = w.n);
    if (talker) setWords((l) => hear(l, w));
    if (w.kind === "clear") return;
    // it wakes and reacts: happy, alarmed or sad (in the air it lands first; on a wall it lets go)
    setBody((b) => (b.act === "drag" || b.act === "fall" ? { ...b, stirred: Date.now() } : { ...b, act: actFor(w.kind), until: Date.now() + 2_400, stirred: Date.now() }));
  };

  // dragging: where the pointer held it, and how fast it moved (to throw it)
  let grab: { dx: number; dy: number; x: number; y: number; at: number; vx: number; vy: number; moved: number } | undefined;
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (menuOpen()) closeMenu();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    let b = body();
    const w = wallOf();
    if (w) {
      // picked off the wall: upright again, under the pointer
      const m = wallMiddle(w, b.y, petW());
      b = { ...b, wall: undefined, act: "drag", x: m.x, y: m.y + petH() / 2, on: undefined };
      setBody(b);
    }
    grab = { dx: e.screenX - b.x, dy: e.screenY - b.y, x: e.screenX, y: e.screenY, at: performance.now(), vx: 0, vy: 0, moved: 0 };
  };
  const move = (e: PointerEvent) => {
    if (!grab) return;
    const t0 = performance.now();
    const dt = Math.max(1, t0 - grab.at) / 1000;
    grab.vx = (e.screenX - grab.x) / dt;
    grab.vy = (e.screenY - grab.y) / dt;
    grab.moved += Math.abs(e.screenX - grab.x) + Math.abs(e.screenY - grab.y);
    grab.x = e.screenX;
    grab.y = e.screenY;
    grab.at = t0;
    if (grab.moved > 4) setBody((b) => ({ ...b, act: "drag", x: e.screenX - grab!.dx, y: e.screenY - grab!.dy, stirred: Date.now() }));
  };
  const up = () => {
    const g = grab;
    grab = undefined;
    if (!g) return;
    if (g.moved > 4) {
      setBody((b) => release(b, g.vx, g.vy));
      relook();
      return;
    }
    // a click on what it says opens that job, right on its screen; on the pet it is happy to be petted
    const w = word();
    if (w) {
      void petClicked({ taskId: w.taskId });
      if (w.kind !== "waiting") setWords((l) => hear(l, { kind: "clear", taskId: w.taskId }));
      return;
    }
    // clicked: it giggles (poke); asleep, it wakes up first
    setBody((b) => ({ ...b, act: b.act === "sleep" ? "idle" : "poke", until: Date.now() + 1_600, stirred: Date.now(), on: b.act === "drag" ? undefined : b.on }));
  };
  const dbl = () => void petClicked({});
  /** an answer from the bubble: the main window answers the job, the bubble goes */
  const answer = (w: Word, optionId: string) => {
    if (!w.ask) return;
    void petTell({ answer: { decisionId: w.ask.decisionId, optionId } });
    setWords((l) => hear(l, { kind: "clear", taskId: w.taskId }));
    setBody((b) => ({ ...b, act: "happy", until: Date.now() + 1_400, stirred: Date.now() }));
  };
  /** right click: its menu over its head; it stands still while the menu is open */
  let menuTimer = 0;
  let menuHovered = false;
  const closeMenu = () => {
    clearTimeout(menuTimer);
    setMenuOpen(false);
  };
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    if (menuOpen()) return closeMenu();
    menuHovered = false;
    setMenuOpen(true);
    clearTimeout(menuTimer);
    menuTimer = window.setTimeout(() => !menuHovered && closeMenu(), MENU_IDLE_MS);
  };
  const asleep = () => body().act === "sleep";
  const menuItems = () => [
    { id: "settings", label: t("펫 설정…"), run: () => void petClicked({ settings: true }) },
    {
      id: "sleep",
      label: asleep() ? t("깨우기") : t("재우기"),
      run: () => {
        const wake = asleep();
        setBody((b) => (wake ? { ...b, act: "happy", until: Date.now() + 1_600, stirred: Date.now() } : { ...b, act: "sleep", until: Date.now() + 120_000, stirred: 0 }));
      },
    },
    { id: "hide", label: t("펫 숨기기"), run: () => void petTell({ hide: true }) },
  ];

  onMount(async () => {
    // listen first, so a config set while this page loads isn't missed
    const un = [await onEvent<PetConfig>("pet:config", (c) => void apply(c)), await onEvent<PetWord>("pet:say", hearWord)];
    // tests of the real app (debug builds only): put the pet somewhere, e.g. at a wall, to see what it does there
    if (import.meta.env.DEV) un.push(await onEvent<Partial<Body>>("pet:poke", (p) => setBody((b) => ({ ...b, ...p }))));
    // the other pets: each says where it is a few times a second; one not heard from for a while is gone
    un.push(await onEvent<Other & { at?: number }>("pet:where", (o) => o.i !== index && others.set(o.i, { ...o, at: Date.now() })));
    works = await screens();
    work = works[0];
    const c = await petGet().catch(() => null);
    if (c) await apply(c);
    const b = body();
    // it comes down from the top of the screen, somewhere on the right (the others a little apart)
    setBody({ ...b, x: work.x + work.w * Math.max(0.15, 0.75 - index * 0.13), y: work.y + 10, act: "fall", dir: index % 2 ? -1 : 1 });
    placed = true;
    await refresh();
    const look = setInterval(() => void refresh(), 700);
    const scr = setInterval(async () => ((works = await screens()), relook()), 15_000);
    let last = performance.now();
    let sent = "";
    let raf = 0;
    const tick = (t0: number) => {
      const dt = Math.min(0.05, (t0 - last) / 1000);
      last = t0;
      const n = Date.now();
      setNow(n);
      const hold = words().some((w) => w.kind === "waiting") ? "alert" : undefined;
      for (const [i, o] of others) if (n - o.at > 2_000) others.delete(i);
      const near = [...others.values()];
      if (!menuOpen()) setBody((b) => {
        const moved = step(b, world, work, dt, n, Math.random, { busy: busy > 0, hold, size: { w: petW(), h: petH() }, others: near });
        return hold || !near.length ? moved : meet(moved, near, n, met, petW());
      });
      // where it is, for the others (only when there are others, a few times a second)
      if (inTauri && config().ids.length > 1 && n - told > 150) {
        told = n;
        const b = body();
        void emit("pet:where", { i: index, x: Math.round(b.x), y: Math.round(b.y), act: b.act, dir: b.dir, wall: b.wall }).catch(() => {});
      }
      if (placed) {
        const f = frame();
        const key = [f.x, f.y, f.w, f.h].map(Math.round).join(",");
        if (key !== sent) {
          sent = key;
          const [x, y, w, h] = key.split(",").map(Number);
          void petFrame(x, y, w, h);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    onCleanup(() => (cancelAnimationFrame(raf), clearInterval(look), clearInterval(scr), un.forEach((f) => f())));
  });

  /** mirrored when it should face the other way from its pictures */
  const flip = () => {
    const b = body();
    const w = wallOf();
    // on a wall it faces the wall (climbing pictures are drawn upright, reaching up)
    const wantRight = w ? w.side === 1 : b.dir === 1;
    return wantRight !== (spec().faces === "right");
  };
  const imgStyle = (): JSX.CSSProperties => {
    const base = { width: `${petW()}px`, height: `${petH()}px` };
    const mirror = flip() ? "scaleX(-1)" : "";
    return { ...base, transform: mirror || undefined };
  };
  const say = (w: Word) => (w.kind === "done" ? t("다 했어요") : w.kind === "waiting" ? w.title : t("잘 안 됐어요"));
  let bubbleEl: HTMLDivElement | undefined;
  onMount(() => {
    const ro = new ResizeObserver(() => bubbleEl && setBubbleH(Math.ceil(bubbleEl.offsetHeight)));
    let seen: Element | undefined;
    const watch = setInterval(() => {
      if (bubbleEl && bubbleEl !== seen) (ro.observe(bubbleEl), (seen = bubbleEl));
    }, 200);
    onCleanup(() => (clearInterval(watch), ro.disconnect()));
  });

  return (
    <div
      class="pet"
      onDblClick={dbl}
      onContextMenu={menu}
      onPointerLeave={() => menuHovered && closeMenu()}
      onKeyDown={(e) => e.key === "Escape" && closeMenu()}
    >
      <Show when={menuOpen()}>
        <div ref={bubbleEl} class="pet-bubble pet-menu" role="menu" style={{ "margin-bottom": `${-overlap()}px` }} onPointerEnter={() => (menuHovered = true)}>
          <For each={menuItems()}>
            {(m) => (
              <button
                class="pet-menu-item"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  m.run();
                }}
              >
                {m.label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={card() === "word" && word()}>
        {(w) => (
          <div
            ref={bubbleEl}
            class={`pet-bubble pet-${w().kind}`}
            role="button"
            tabIndex={0}
            style={{ "margin-bottom": `${-overlap()}px` }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
          >
            <b>{say(w())}</b>
            <span class="pet-bubble-text">{w().ask?.question ?? (w().kind === "waiting" ? t("물어볼 게 있어요") : w().title)}</span>
            <Show when={w().ask?.options.length}>
              <div class="pet-opts" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
                <For each={w().ask!.options}>
                  {(o) => (
                    <button class="pet-opt" classList={{ primary: !!o.primary }} title={o.label} onClick={() => answer(w(), o.id)}>
                      {o.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        )}
      </Show>
      <For each={pics()}>
        {(src) => (
          <img
            class="pet-img"
            classList={{ off: src !== pic() }}
            src={src}
            alt={src === pic() ? spec().name : ""}
            draggable={false}
            style={imgStyle()}
            onLoad={(e) => {
              const im = e.currentTarget;
              if (im.naturalHeight) setSizes((m) => ({ ...m, [src]: { w: im.naturalWidth, h: im.naturalHeight } }));
            }}
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
          />
        )}
      </For>
    </div>
  );
}
