// The Mac bar at the foot of the sidebar, once another Mac is added (Settings › 연결): this Mac
// and each added one as a mark. Picking one (or ⌃1…⌃9) makes it where the current workspace's new
// work runs. Right-click: rename, an emoji or icon, a color (that can tint the whole window, so
// it's plain which Mac is in use), connection settings, disconnect or remove. The workspace tabs at the top
// stay as they are.
import { createEffect, createSignal, For, onCleanup, onMount, Show, type Component, type JSX } from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import {
  Anchor, Archive, Asterisk, BookOpen, Bookmark, Briefcase, Brush, Building2, Calendar, Camera, Car, Cloud, Code, Coffee, Crown,
  Database, Droplet, Dumbbell, Feather, File, Flag, Flame, Folder, Gamepad2, Gem, Ghost, Gift, Globe, Headphones, Heart, House, Inbox,
  Key, Laptop, Layers, LayoutGrid, Leaf, Lightbulb, Lock, Mail, Map, MessageCircle, Monitor, Moon, Mountain, Music, Orbit, Package,
  Palette, PawPrint, Pizza, Plane, Puzzle, Rocket, Shapes, Snowflake, Sparkles, SquareCheck, SquareTerminal, Star, Sun, Target, Minus, Plus, ChevronLeft, ChevronRight, RotateCcw,
  ThumbsUp, TrainFront, TreePine, Trophy, Umbrella, Users, Utensils, Wrench, Zap,
} from "lucide-solid";
import { setState, state } from "../state/store";
import { mirror } from "../state/mirror";
import { setView, toast } from "../state/ui";
import { askRemoveHost, hostConnectItem } from "./macActions";
import { ignoredKey, noModifiers, shortcutHint, type ShortcutId } from "../lib/shortcuts";
import { chosenComputer, hostState, localHere, setComputer } from "./ComputerPicker";
import { projectHue } from "./ProjectBadge";
import { ctxFor, openMenuAt, type MenuEntry } from "./taskMenu";
import { Icon } from "./Icon";
import { t } from "../i18n";
import { EmojiPicker } from "./EmojiPicker";

/** icons a Mac can take (by name, so the choice is kept as text) */
const MAC_ICONS: Record<string, Component<{ size?: number; "stroke-width"?: number; class?: string }>> = {
  monitor: Monitor, laptop: Laptop, house: House, building: Building2, briefcase: Briefcase, folder: Folder, inbox: Inbox, archive: Archive,
  star: Star, heart: Heart, bookmark: Bookmark, flag: Flag, zap: Zap, flame: Flame, sparkles: Sparkles, asterisk: Asterisk,
  lightbulb: Lightbulb, shapes: Shapes, grid: LayoutGrid, layers: Layers, database: Database, package: Package, puzzle: Puzzle, target: Target,
  calendar: Calendar, mail: Mail, check: SquareCheck, file: File, book: BookOpen, chat: MessageCircle, users: Users, terminal: SquareTerminal,
  code: Code, wrench: Wrench, brush: Brush, palette: Palette, camera: Camera, music: Music, headphones: Headphones, gamepad: Gamepad2,
  rocket: Rocket, plane: Plane, train: TrainFront, car: Car, anchor: Anchor, globe: Globe, map: Map, orbit: Orbit,
  sun: Sun, moon: Moon, cloud: Cloud, snowflake: Snowflake, droplet: Droplet, umbrella: Umbrella, mountain: Mountain, tree: TreePine,
  leaf: Leaf, paw: PawPrint, feather: Feather, coffee: Coffee, pizza: Pizza, utensils: Utensils, dumbbell: Dumbbell, trophy: Trophy,
  crown: Crown, gem: Gem, ghost: Ghost, gift: Gift, key: Key, lock: Lock, thumbs: ThumbsUp,
};
/** the colors a Mac can take: hues on one lightness and chroma, then slate and grey */
const HUES: { h: number; c: number }[] = [
  { h: 250, c: 0.14 }, { h: 275, c: 0.14 }, { h: 300, c: 0.14 }, { h: 330, c: 0.14 }, { h: 5, c: 0.15 }, { h: 30, c: 0.15 }, { h: 55, c: 0.14 },
  { h: 85, c: 0.13 }, { h: 125, c: 0.13 }, { h: 155, c: 0.13 }, { h: 185, c: 0.11 }, { h: 215, c: 0.12 }, { h: 260, c: 0.03 }, { h: 0, c: 0 },
];
const LOCAL = "local";

export interface Mac { id: string; name: string; icon?: string; emoji?: string; hue?: number; colors?: { h: number; c: number }[]; grain?: number; theme?: number; local: boolean }
type Look = Partial<Pick<Mac, "name" | "icon" | "emoji" | "hue" | "colors" | "grain" | "theme">>;

/** this Mac, then every Mac added, in the bar's order (⌃1 is this Mac) */
export function macs(): Mac[] {
  const me = state.settings.thisMac;
  return [
    { id: LOCAL, name: me?.name || t("이 Mac"), icon: me?.icon, emoji: me?.emoji, hue: me?.hue, colors: me?.colors, grain: me?.grain, theme: me?.theme, local: true },
    ...(state.settings.hosts ?? []).map((h) => ({ id: h.id, name: h.name, icon: h.icon, emoji: h.emoji, hue: h.hue, colors: h.colors, grain: h.grain, theme: h.theme, local: false })),
  ];
}
export const showMacBar = () => (state.settings.hosts ?? []).length > 0;

const statusOf = (m: Mac) => (m.local ? "ok" : (mirror.hosts[m.id]?.status ?? "connecting"));
const current = () => chosenComputer(state.space)?.host ?? LOCAL;
/** that Mac has this workspace (another Mac's tab may be only there; this Mac may have no account here) */
const hasHere = (m: Mac) => {
  if (m.local) return localHere(state.space);
  const label = state.spaces.find((s) => s.id === state.space)?.label;
  const h = state.settings.hosts?.find((x) => x.id === m.id);
  const labels = mirror.hosts[m.id]?.info?.spaces.map((s) => s.label) ?? h?.spaces;
  return !labels || labels.includes(label ?? "");
};

/** run the current workspace's new work on that Mac */
export function pickMac(id: string) {
  const m = macs().find((x) => x.id === id);
  if (!m) return;
  const space = t(state.spaces.find((s) => s.id === state.space)?.label ?? "");
  if (!hasHere(m)) return void toast(t("{mac}에는 {space} 워크스페이스가 없어요", { mac: m.name, space }));
  if (m.id === current()) return;
  setComputer(state.space, m.local ? undefined : { host: m.id });
  toast(t("{space} · 새 작업은 {mac}에서 해요", { space, mac: m.name }));
}

function setLook(id: string, patch: Look) {
  if (id === LOCAL) setState("settings", "thisMac", (x) => ({ ...(x ?? {}), ...patch }));
  else setState("settings", "hosts", (l) => (l ?? []).map((h) => (h.id === id ? { ...h, ...patch } : h)));
}

/** a Mac's color (its own pick, else one from its name), as CSS variables */
const hueIndex = (m: Mac) => m.hue ?? projectHue(m.name) % 12;
/** the colors picked on the field (up to three), else a preset */
const colorsOf = (m: Mac) => (m.colors?.length ? m.colors : [HUES[hueIndex(m)] ?? HUES[0]]);
const hueOf = (m: Mac) => colorsOf(m)[0];
/** the field: the color's hue is its direction from the middle, how much color its distance */
const MAX_C = 0.2;

/** grain for the window, as fine noise; how much is set by its opacity */
const grainUrl = (opacity: number) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='3' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/><feComponentTransfer><feFuncR type='linear' slope='2.2' intercept='-.6'/><feFuncG type='linear' slope='2.2' intercept='-.6'/><feFuncB type='linear' slope='2.2' intercept='-.6'/><feFuncA type='linear' slope='0' intercept='1'/></feComponentTransfer></filter><rect width='100%' height='100%' filter='url(#n)' opacity='${opacity.toFixed(3)}'/></svg>`)}")`;

/** the window's wash: the Mac's colors across it, as strong as asked, with its grain */
function washOf(m: Mac): string {
  const a = (m.theme ?? 0) / 100;
  const cs = colorsOf(m);
  const stops = cs.length === 1
    ? [`oklch(0.62 ${cs[0].c} ${cs[0].h} / ${(a * 0.5).toFixed(3)})`, `oklch(0.62 ${cs[0].c} ${cs[0].h} / ${(a * 0.3).toFixed(3)})`]
    : cs.map((c) => `oklch(0.62 ${c.c} ${c.h} / ${(a * 0.45).toFixed(3)})`);
  const layers = [`linear-gradient(160deg, ${stops.join(", ")})`];
  if (m.grain) layers.unshift(grainUrl((m.grain / 100) * 0.12));
  return layers.join(", ");
}
/** the same colors laid softly over the work area (blended, so text stays as it is) */
function workOf(m: Mac): string {
  const a = (m.theme ?? 0) / 100;
  const cs = colorsOf(m);
  const stops = (cs.length === 1 ? [cs[0], cs[0]] : cs).map((c, i) => `oklch(0.62 ${c.c} ${c.h} / ${(a * (cs.length === 1 && i ? 0.18 : 0.3)).toFixed(3)})`);
  const wash = `linear-gradient(160deg, ${stops.join(", ")})`;
  return m.grain ? `${grainUrl((m.grain / 100) * 0.05)}, ${wash}` : wash;
}
const tintVars = (m: Mac): JSX.CSSProperties => ({ "--mh": String(hueOf(m).h), "--mc": String(hueOf(m).c) });

/** a Mac's mark: its emoji, the icon picked for it, or a dot */
function MacMark(props: { mac: Mac; size?: number }) {
  const ic = () => (props.mac.icon ? MAC_ICONS[props.mac.icon] : undefined);
  return (
    <Show
      when={props.mac.emoji}
      fallback={
        <Show when={ic()} fallback={<i class="mbar-dot" aria-hidden="true" />}>
          <Dynamic component={ic()} size={props.size ?? 15} stroke-width={1.75} class="mbar-ic" />
        </Show>
      }
    >
      <span class="mbar-emoji" aria-hidden="true">{props.mac.emoji}</span>
    </Show>
  );
}

type Choice = "name" | "icon" | "color";
const [open, setOpen] = createSignal<{ id: string; at: DOMRect; pick: Choice }>();

/** a card over the bar that closes on Escape or a click elsewhere */
function Pop(props: { at: DOMRect; class: string; label: string; style?: JSX.CSSProperties; onClose?: () => void; children: JSX.Element }) {
  let el!: HTMLDivElement;
  const close = () => (props.onClose?.(), setOpen(undefined));
  onMount(() => {
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(props.at.left - 6, innerWidth - r.width - 8))}px`;
    el.style.top = `${Math.max(8, props.at.top - r.height - 8)}px`;
    const away = (e: Event) => !el.contains(e.target as Node) && close();
    const esc = (e: KeyboardEvent) => {
      if (ignoredKey(e)) return;
      if (e.key === "Escape" && noModifiers(e)) (e.preventDefault(), e.stopPropagation(), close());
    };
    setTimeout(() => document.addEventListener("pointerdown", away, true));
    document.addEventListener("keydown", esc, true);
    onCleanup(() => (document.removeEventListener("pointerdown", away, true), document.removeEventListener("keydown", esc, true)));
  });
  return (
    <div class={`ml-pop pop ${props.class}`} ref={el} role="dialog" aria-label={props.label} style={props.style}>
      {props.children}
    </div>
  );
}

function NamePop(props: { mac: Mac; at: DOMRect }) {
  let input!: HTMLInputElement;
  const commit = () => {
    const v = input.value.trim();
    if (v && v !== props.mac.name) setLook(props.mac.id, { name: v });
  };
  onMount(() => requestAnimationFrame(() => (input.focus(), input.select())));
  return (
    <Pop at={props.at} class="ml-name-pop" label={t("이름 바꾸기")} style={tintVars(props.mac)} onClose={commit}>
      <span class="ml-preview"><MacMark mac={props.mac} size={16} /></span>
      <input ref={input} class="ml-name" value={props.mac.name} aria-label={t("이름")} onKeyDown={(e) => e.key === "Enter" && !e.isComposing && (e.preventDefault(), commit(), setOpen(undefined))} />
    </Pop>
  );
}

function IconPop(props: { mac: Mac; at: DOMRect }) {
  const [tab, setTab] = createSignal<"emoji" | "icon">(props.mac.emoji ? "emoji" : "icon");
  return (
    <Pop at={props.at} class="ml-icon-pop" label={t("아이콘 바꾸기")} style={tintVars(props.mac)}>
      <div class="ml-top">
        <div class="ml-seg" role="tablist">
          <button role="tab" aria-selected={tab() === "emoji"} classList={{ on: tab() === "emoji" }} onClick={() => setTab("emoji")}>{t("이모지")}</button>
          <button role="tab" aria-selected={tab() === "icon"} classList={{ on: tab() === "icon" }} onClick={() => setTab("icon")}>{t("아이콘")}</button>
        </div>
        <button class="icon-btn sm ml-clear" title={t("점으로 되돌리기")} aria-label={t("점으로 되돌리기")} disabled={!props.mac.icon && !props.mac.emoji} onClick={() => setLook(props.mac.id, { icon: undefined, emoji: undefined })}>
          <Icon name="trash" size={15} />
        </button>
      </div>
      <Show
        when={tab() === "icon"}
        fallback={<EmojiPicker value={props.mac.emoji} onPick={(e) => setLook(props.mac.id, { emoji: e, icon: undefined })} />}
      >
        <div class="ml-grid">
          <For each={Object.entries(MAC_ICONS)}>
            {([name, ic]) => (
              <button class="ml-cell" classList={{ on: !props.mac.emoji && props.mac.icon === name }} aria-label={name} onClick={() => setLook(props.mac.id, { icon: name, emoji: undefined })}>
                <Dynamic component={ic} size={17} stroke-width={1.75} />
              </button>
            )}
          </For>
        </div>
      </Show>
    </Pop>
  );
}

/** a slider drawn as a wave up to where it is set, flatter the less (how strongly the window takes the color) */
function Wave(props: { value: number; label: string; onChange: (v: number) => void }) {
  let el!: HTMLDivElement;
  const at = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    props.onChange(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left - 10) / (r.width - 20))) * 20) * 5);
  };
  const keys = (e: KeyboardEvent) => {
    const d = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    props.onChange(Math.min(100, Math.max(0, props.value + d)));
  };
  // one wave per 24px, drawn across the whole width and cut off at the knob
  const path = () => {
    let d = "M 0 20";
    const a = (1 + (props.value / 100) * 11).toFixed(1);
    for (let x = 0; x < 600; x += 24) d += ` q 6 -${a} 12 0 t 12 0`;
    return d;
  };
  return (
    <div
      ref={el}
      class="ml-wave"
      role="slider"
      tabindex="0"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.value}
      title={props.label}
      style={{ "--v": String(props.value / 100) }}
      onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), at(e))}
      onPointerMove={(e) => e.buttons && at(e)}
      onKeyDown={keys}
    >
      <span class="ml-wave-track" />
      <svg class="ml-wave-line" viewBox="0 0 600 40" preserveAspectRatio="xMinYMid slice" aria-hidden="true">
        <path d={path()} />
      </svg>
      <span class="ml-wave-knob" />
    </div>
  );
}

/** a dial turned around from the top (the window's grain) */
function Dial(props: { value: number; label: string; onChange: (v: number) => void }) {
  let el!: HTMLDivElement;
  const at = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    const turn = Math.atan2(e.clientX - (r.left + r.width / 2), -(e.clientY - (r.top + r.height / 2))) / (2 * Math.PI);
    props.onChange(Math.round(((turn + 1) % 1) * 20) * 5);
  };
  const keys = (e: KeyboardEvent) => {
    const d = { ArrowLeft: -5, ArrowDown: -5, ArrowRight: 5, ArrowUp: 5 }[e.key];
    if (d === undefined) return;
    e.preventDefault();
    props.onChange(Math.min(100, Math.max(0, props.value + d)));
  };
  return (
    <div
      ref={el}
      class="ml-dial"
      role="slider"
      tabindex="0"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={props.value}
      title={props.label}
      onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId), at(e))}
      onPointerMove={(e) => e.buttons && at(e)}
      onKeyDown={keys}
    >
      <For each={Array.from({ length: 24 })}>{(_, i) => <i style={{ transform: `rotate(${i() * 15}deg) translateY(-25px)` }} classList={{ lit: i() * 15 < props.value * 3.6 }} />}</For>
      {/* the grain as it is set, to see */}
      <span class="ml-dial-face" style={{ "background-image": props.value ? grainUrl(0.15 + (props.value / 100) * 0.85) : "none" }} />
      <span class="ml-dial-notch" style={{ transform: `rotate(${props.value * 3.6}deg) translateY(-25px)` }} />
    </div>
  );
}

function ColorPop(props: { mac: Mac; at: DOMRect }) {
  const theme = () => props.mac.theme ?? 0;
  const cs = () => colorsOf(props.mac);
  const [active, setActive] = createSignal(0);
  const sel = () => Math.min(active(), cs().length - 1);
  let field!: HTMLDivElement;
  let presets!: HTMLDivElement;
  // ⌘Z / ⇧⌘Z step back and forth through what was changed here (one drag is one step)
  const look = () => JSON.stringify({ hue: props.mac.hue, colors: props.mac.colors, theme: props.mac.theme, grain: props.mac.grain });
  const back: string[] = [];
  const fwd: string[] = [];
  let prev = look();
  let last = 0;
  createEffect(() => {
    const now = look();
    if (now === prev) return;
    if (Date.now() - last > 400) (back.push(prev), (fwd.length = 0));
    last = Date.now();
    prev = now;
  });
  const go = (from: string[], to: string[]) => {
    const s = from.pop();
    if (s === undefined) return;
    to.push(look());
    const v = JSON.parse(s) as Look;
    prev = s;
    last = 0;
    setLook(props.mac.id, { hue: v.hue, colors: v.colors, theme: v.theme, grain: v.grain });
  };
  const undoKeys = (e: KeyboardEvent) => {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) go(fwd, back);
    else go(back, fwd);
  };
  // each press starts a step of its own (a drag that follows stays in it)
  const newStep = () => void (last = 0);
  onMount(() => (window.addEventListener("keydown", undoKeys, true), window.addEventListener("pointerdown", newStep, true)));
  onCleanup(() => (window.removeEventListener("keydown", undoKeys, true), window.removeEventListener("pointerdown", newStep, true)));
  const put = (list: { h: number; c: number }[]) => {
    setLook(props.mac.id, { colors: list.map((x) => ({ h: Math.round(x.h + 360) % 360, c: Math.round(Math.min(MAX_C, Math.max(0, x.c)) * 1000) / 1000 })) });
    // a color makes no sense unseen: the first pick also washes the window a little
    if (!theme()) setLook(props.mac.id, { theme: 40 });
  };
  const setOne = (i: number, x: { h: number; c: number }) => put(cs().map((y, j) => (j === i ? x : y)));
  // the point on the field: its direction is the hue, its distance from the middle the color
  let area!: HTMLDivElement;
  const at = (e: PointerEvent) => {
    const r = area.getBoundingClientRect();
    let dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const cx = Math.max(-1, Math.min(1, dx)), cy = Math.max(-1, Math.min(1, dy));
    const d = Math.max(Math.abs(cx), Math.abs(cy));
    dy = cy;
    dx = cx;
    setOne(sel(), { h: d < 0.04 ? cs()[sel()].h : (Math.atan2(dy, dx) * 180) / Math.PI, c: d * MAX_C });
  };
  // back from a color to its place: out along its direction, to the rim of the area at full color
  const spot = (x: { h: number; c: number }) => {
    const d = x.c / MAX_C, rad = (x.h * Math.PI) / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    const k = d / Math.max(Math.abs(cos), Math.abs(sin), 1e-6);
    return { left: `${50 + cos * k * 50}%`, top: `${50 + sin * k * 50}%` };
  };
  const keys = (i: number) => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 30 : 6;
    const x = cs()[i];
    const v = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, 0.01], ArrowDown: [0, -0.01] } as Record<string, number[]>)[e.key];
    if (!v) return;
    e.preventDefault();
    setOne(i, { h: x.h + v[0], c: x.c + v[1] });
  };
  const add = () => {
    const last = cs()[cs().length - 1];
    put([...cs(), { h: last.h + 120, c: Math.max(0.1, last.c) }]);
    setActive(cs().length - 1);
  };
  const drop = () => {
    put(cs().filter((_, j) => j !== sel()));
    setActive(0);
  };
  const modes = [
    { id: "system" as const, icon: Sparkles, label: "시스템" },
    { id: "light" as const, icon: Sun, label: "밝게" },
    { id: "dark" as const, icon: Moon, label: "어둡게" },
  ];
  return (
    <Pop at={props.at} class="ml-color-pop" label={t("색 바꾸기")} style={tintVars(props.mac)}>
      <div class="ml-bar">
        <div class="ml-modes" role="radiogroup" aria-label={t("화면 모드")}>
          <For each={modes}>
            {(m) => (
              <button role="radio" aria-checked={state.settings.theme === m.id} classList={{ on: state.settings.theme === m.id }} title={t(m.label)} aria-label={t(m.label)} onClick={() => setState("settings", "theme", m.id)}>
                <Dynamic component={m.icon} size={18} stroke-width={1.75} />
              </button>
            )}
          </For>
        </div>
        <div class="ml-count">
          <button aria-label={t("색 빼기")} title={t("색 빼기")} disabled={cs().length < 2} onClick={drop}>
            <Minus size={18} stroke-width={1.75} />
          </button>
          <button aria-label={t("색 더하기")} title={t("색 더하기")} disabled={cs().length > 2} onClick={add}>
            <Plus size={18} stroke-width={1.75} />
          </button>
        </div>
      </div>
      <div
        ref={field}
        class="ml-field"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          at(e);
        }}
        onPointerMove={(e) => e.buttons && field.hasPointerCapture(e.pointerId) && at(e)}
      >
        <div class="ml-area" ref={area}>
          <For each={cs()}>
            {(x, i) => (
              <button
                class="ml-knob"
                classList={{ on: i() === sel() && cs().length > 1 }}
                role="slider"
                aria-label={t("색 {n}", { n: i() + 1 })}
                aria-valuemin={0}
                aria-valuemax={360}
                aria-valuenow={x.h}
                style={{ ...spot(x), "--kh": String(x.h), "--kc": String(x.c) }}
                onPointerDown={() => setActive(i())}
                onFocus={() => setActive(i())}
                onKeyDown={keys(i())}
              />
            )}
          </For>
        </div>
      </div>
      <div class="ml-presets">
        <button class="ml-page" aria-label={t("이전")} onClick={() => presets.scrollBy({ left: -presets.clientWidth, behavior: "smooth" })}>
          <ChevronLeft size={18} stroke-width={1.75} />
        </button>
        <div class="ml-swatches" ref={presets} role="radiogroup" aria-label={t("색")}>
          <For each={HUES}>
            {(h, i) => (
              <button
                role="radio"
                aria-checked={!props.mac.colors?.length && hueIndex(props.mac) === i()}
                aria-label={t("색 {n}", { n: i() + 1 })}
                classList={{ on: !props.mac.colors?.length && hueIndex(props.mac) === i() }}
                style={{ "--mh": String(h.h), "--mc": String(h.c) }}
                onClick={() => (setLook(props.mac.id, { hue: i(), colors: undefined }), !theme() && setLook(props.mac.id, { theme: 40 }))}
              />
            )}
          </For>
        </div>
        <button class="ml-page" aria-label={t("다음")} onClick={() => presets.scrollBy({ left: presets.clientWidth, behavior: "smooth" })}>
          <ChevronRight size={18} stroke-width={1.75} />
        </button>
      </div>
      <div class="ml-row">
        <button class="ml-reset" title={t("기본으로 초기화")} aria-label={t("기본으로 초기화")} disabled={!props.mac.colors?.length && props.mac.hue === undefined && !theme() && !props.mac.grain} onClick={() => (setLook(props.mac.id, { colors: undefined, hue: undefined, theme: undefined, grain: undefined }), setActive(0))}>
          <RotateCcw size={16} stroke-width={1.75} />
        </button>
        <Wave value={theme()} label={t("색 진하기")} onChange={(v) => setLook(props.mac.id, { theme: v })} />
        <Dial value={props.mac.grain ?? 0} label={t("질감")} onChange={(v) => setLook(props.mac.id, { grain: v })} />
      </div>
    </Pop>
  );
}

function macMenu(m: Mac, at: DOMRect): MenuEntry[] {
  const pick = (p: Choice) => () => requestAnimationFrame(() => setOpen({ id: m.id, at, pick: p }));
  return [
    { id: "rename", label: t("이름 바꾸기"), icon: "pencil", run: pick("name") },
    "sep",
    { id: "icon", label: t("아이콘 바꾸기"), icon: "smilePlus", run: pick("icon") },
    { id: "color", label: t("색 바꾸기"), icon: "palette", run: pick("color") },
    { id: "settings", label: t("연결 설정"), icon: "gear", run: () => setView({ name: "settings", tab: "remote" }) },
    // the same two as in Settings › 연결: for now, or for good (asks first)
    ...(m.local ? [] : (["sep", hostConnectItem(m.id), "sep", { id: "remove", label: t("제거"), icon: "trash", danger: true, run: () => askRemoveHost(m.id) }] as MenuEntry[])),
  ];
}

export function MacBar() {
  // the Mac in use tints the window when its color is set to: set on <html>, read by .app
  createEffect(() => {
    const root = document.documentElement.style;
    const m = showMacBar() ? macs().find((x) => x.id === current()) : undefined;
    if (!m?.theme && !m?.grain) return void (root.removeProperty("--mac-wash"), root.removeProperty("--mac-work"));
    root.setProperty("--mac-wash", washOf(m));
    if (m.theme || m.grain) root.setProperty("--mac-work", workOf(m));
    else root.removeProperty("--mac-work");
  });
  return (
    <Show when={showMacBar()}>
      <div class="mbar" role="toolbar" aria-label={t("Mac")}>
        <For each={macs()}>
          {(m, i) => (
            <button
              class="mbar-mac"
              style={tintVars(m)}
              classList={{ on: current() === m.id, ctx: ctxFor() === `mac:${m.id}` || open()?.id === m.id, off: !hasHere(m), away: statusOf(m) !== "ok" }}
              aria-pressed={current() === m.id}
              aria-label={m.name}
              title={[m.name, m.local ? "" : hostState(m.id), i() < 9 ? shortcutHint(`mac${i() + 1}` as ShortcutId) : ""].filter(Boolean).join(" · ")}
              onClick={() => pickMac(m.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                const at = e.currentTarget.getBoundingClientRect();
                openMenuAt(`mac:${m.id}`, () => macMenu(m, at), e);
              }}
            >
              <MacMark mac={m} />
              {/* the one picked opens into a pill with its name */}
              <span class="mbar-name">{m.name}</span>
            </button>
          )}
        </For>
      </div>
      <Portal>
        <Show when={open()} keyed>
          {(o) => (
            <Show when={macs().find((m) => m.id === o.id)}>
              {(m) => (o.pick === "name" ? <NamePop mac={m()} at={o.at} /> : o.pick === "icon" ? <IconPop mac={m()} at={o.at} /> : <ColorPop mac={m()} at={o.at} />)}
            </Show>
          )}
        </Show>
      </Portal>
    </Show>
  );
}
