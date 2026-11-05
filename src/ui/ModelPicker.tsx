// Model + effort, as one chip with a popover. Lists what the account's
// login can actually use (asked from the engine once per account).
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { accountById } from "../state/store";
import type { Permission } from "../state/types";
import { modelsNow, rankModels, refreshModels } from "../engine/modelList";
import { Icon } from "./Icon";

export const EFFORTS: { id: string; label: string }[] = [
  { id: "low", label: "low" },
  { id: "medium", label: "medium" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh" },
  { id: "max", label: "max" },
];
/** effort when nothing was picked */
export const effortOf = (t: string | undefined) => (EFFORTS.some((e) => e.id === t) ? t! : "high");

/** "openai-codex/gpt-6.1-sol" → "GPT-6.1 Sol" */
export function prettyModel(m: string): string {
  const id = m.split("/").pop() ?? m;
  return id
    .split("-")
    .map((p, i) => (i === 0 && /^(gpt|o\d)/i.test(p) ? p.toUpperCase() : /^\d/.test(p) ? p : p[0].toUpperCase() + p.slice(1)))
    .join(" ")
    .replace(/^GPT (\d)/, "GPT-$1")
    .replace(/^Claude (\w+) (\d+) (\d+)/, "Claude $1 $2.$3");
}


/** One popover open at a time across the app: opening one closes the others; Esc closes it. */
const [openPop, setOpenPop] = createSignal<symbol | null>(null);
if (typeof window !== "undefined") {
  window.addEventListener("click", () => setOpenPop(null));
  window.addEventListener("keydown", (e) => e.key === "Escape" && openPop() && (e.stopPropagation(), setOpenPop(null)), true);
}
export const anyPop = () => openPop() !== null;
export const closePops = () => setOpenPop(null);
export function usePop(): [() => boolean, (v: boolean) => void] {
  const me = Symbol();
  onCleanup(() => openPop() === me && setOpenPop(null));
  return [() => openPop() === me, (v) => setOpenPop(v ? me : null)];
}

export function ModelPicker(props: {
  accountId: string;
  model: string;
  thinking: string;
  onChange: (model: string, thinking: string) => void;
  /** open upward (inside a composer at the bottom) */
  up?: boolean;
}) {
  const [open, setOpen] = usePop();
  // the kept list shows at once; the engine is asked again behind it
  const [asked] = createResource(() => (open() ? props.accountId : false), (id) => refreshModels(id as string));
  const models = () => modelsNow(props.accountId) ?? asked();
  const loading = () => !models() && asked.loading;
  const [showOld, setShowOld] = createSignal(false);
  const auto = () => accountById(props.accountId)?.model;
  const label = () => (props.model ? prettyModel(props.model) : auto() ? prettyModel(auto()!) : "모델 고르기");
  const effort = () => effortOf(props.thinking);
  const current = () => props.model || auto() || "";
  const ranked = () => rankModels(models() ?? []);
  const groups = () => ranked().latest;
  const PROVIDER: Record<string, string> = { "openai-codex": "OpenAI · ChatGPT 계정", openai: "OpenAI", anthropic: "Anthropic · Claude 계정", google: "Google" };
  const Item = (p: { m: string }) => (
    <button type="button" class="pop-item" onClick={() => (props.onChange(p.m, effort()), setOpen(false))}>
      <span class="pop-item-main">{prettyModel(p.m)}</span>
      <Show when={current() === p.m}><Icon name="check" size={14} /></Show>
    </button>
  );
  return (
    <div class="picker" onClick={(e) => e.stopPropagation()}>
      <button type="button" class="chip model-chip" classList={{ on: open() }} onClick={() => setOpen(!open())} title="모델과 생각 깊이">
        <span class="model-name">{label()}</span>
        <span class="model-effort">{effort()}</span>
        <Icon name="down" size={12} class="muted" />
      </button>
      <Show when={open()}>
        <div class="pop model-pop" classList={{ up: props.up }}>
          <EffortSlider value={effort()} onChange={(id) => props.onChange(props.model, id)} />
          <div class="pop-sep" />
          <div class="pop-scroll">
            <Show when={!loading()} fallback={<div class="pop-empty"><span class="spin sm" /> 모델 불러오는 중</div>}>
              <Show when={ranked().often.length}>
                <div class="pop-label">자주 쓰는</div>
                <For each={ranked().often}>{(m) => <Item m={m} />}</For>
              </Show>
              <For each={groups()}>
                {([provider, list]) => (
                  <>
                    <div class="pop-label">{PROVIDER[provider] ?? provider}</div>
                    <For each={list}>{(m) => <Item m={m} />}</For>
                  </>
                )}
              </For>
              <Show when={ranked().older.length}>
                <button type="button" class="pop-item pop-more" onClick={() => setShowOld(!showOld())}>
                  <span class="pop-item-main">이전 모델 {ranked().older.length}개</span>
                  <Icon name={showOld() ? "down" : "chevron"} size={12} class="muted" />
                </button>
                <Show when={showOld()}><For each={ranked().older}>{(m) => <Item m={m} />}</For></Show>
              </Show>
              <Show when={!groups().length && !ranked().often.length}><div class="pop-empty">모델 없음</div></Show>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

// ───────────── what a job may do without asking
export const PERMISSIONS: { id: Permission; label: string; icon: string; desc: string }[] = [
  { id: "ask", label: "매번 묻기", icon: "lock", desc: "파일을 고치거나 명령을 실행하기 전에 매번 물어봐요. 읽기는 묻지 않아요." },
  { id: "edits", label: "편집 허용", icon: "pencil", desc: "작업 폴더 안의 파일은 묻지 않고 고쳐요. 명령과 폴더 밖은 물어봐요." },
  { id: "full", label: "전체 권한", icon: "shield", desc: "명령 실행과 폴더 밖까지 묻지 않고 다 해요." },
];

export function PermissionPicker(props: { value: Permission; onChange: (p: Permission) => void }) {
  const [open, setOpen] = usePop();
  const cur = () => PERMISSIONS.find((p) => p.id === props.value) ?? PERMISSIONS[1];
  return (
    <div class="picker" onClick={(e) => e.stopPropagation()}>
      <button type="button" class={`chip perm-chip p-${cur().id}`} classList={{ on: open(), full: cur().id === "full" }} onClick={() => setOpen(!open())} title="묻지 않고 해도 되는 것">
        <Icon name={cur().icon} size={13} />
        {cur().label}
      </button>
      <Show when={open()}>
        <div class="pop up left perm-pop" style={{ bottom: "calc(100% + 8px)", top: "auto" }}>
          <For each={PERMISSIONS}>
            {(p) => (
              <button type="button" class={`perm-item p-${p.id}`} classList={{ on: p.id === cur().id }} onClick={() => (props.onChange(p.id), setOpen(false))}>
                <span class="perm-title">
                  <Icon name={p.icon} size={14} />
                  {p.label}
                  <Show when={p.id === cur().id}><Icon name="check" size={14} class="perm-check" /></Show>
                </span>
                <span class="perm-desc">{p.desc}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** 생각 깊이 as a slider with a stop per level: drag, click a stop, or arrow keys. */
function EffortSlider(props: { value: string; onChange: (id: string) => void }) {
  const n = EFFORTS.length;
  const at = () => Math.max(0, EFFORTS.findIndex((e) => e.id === props.value));
  const pct = (i: number) => (i / (n - 1)) * 100;
  let track!: HTMLDivElement;
  const from = (x: number) => {
    const r = track.getBoundingClientRect();
    const h = r.height;
    return Math.round(Math.min(1, Math.max(0, (x - r.left - h / 2) / (r.width - h))) * (n - 1));
  };
  const set = (i: number) => {
    const id = EFFORTS[Math.min(n - 1, Math.max(0, i))].id;
    if (id !== props.value) props.onChange(id);
  };
  const down = (e: PointerEvent) => {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    el.focus();
    set(from(e.clientX));
    const move = (m: PointerEvent) => set(from(m.clientX));
    const up = () => (el.removeEventListener("pointermove", move), el.removeEventListener("pointerup", up));
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };
  const key = (e: KeyboardEvent) => {
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (e.key === "Home") return e.preventDefault(), set(0);
    if (e.key === "End") return e.preventDefault(), set(n - 1);
    if (d) e.preventDefault(), set(at() + d);
  };
  return (
    <div class="eff">
      <div class="eff-head">
        <span>생각 깊이</span>
        <b>{EFFORTS[at()].label}</b>
      </div>
      <div
        class="eff-slider"
        role="slider"
        tabindex="0"
        aria-label="생각 깊이"
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={at()}
        aria-valuetext={EFFORTS[at()].label}
        onPointerDown={down}
        onKeyDown={key}
      >
        <div class="eff-track" ref={track}>
          <div class="eff-fill" style={{ width: `calc(var(--eh) + (100% - var(--eh)) * ${pct(at()) / 100})` }} />
          <For each={EFFORTS}>{(_, i) => <i class="eff-stop" classList={{ on: i() <= at() }} style={{ left: `calc(var(--eh) / 2 + (100% - var(--eh)) * ${pct(i()) / 100})` }} />}</For>
          <div class="eff-thumb" style={{ left: `calc(var(--eh) / 2 + (100% - var(--eh)) * ${pct(at()) / 100})` }} />
        </div>
      </div>
      <div class="eff-ends">
        <span>{EFFORTS[0].label}</span>
        <span>{EFFORTS[n - 1].label}</span>
      </div>
    </div>
  );
}
