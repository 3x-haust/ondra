// Model + effort, as one chip with a popover. Lists what the account's
// login can actually use (asked from the engine once per account).
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { accountById } from "../state/store";
import { ignoredKey, noModifiers } from "../lib/shortcuts";
import type { Permission } from "../state/types";
import { modelsNow, rankModels, refreshModels } from "../engine/modelList";
import { Icon } from "./Icon";
import { accountName } from "./AccountPicker";
import { canUseTools, connectionOf, connModelLabel } from "../engine/connections";
import { t } from "../i18n";

/** `name` is the Korean key: show it with t(name) (낮음 · 보통 · 높음 · 매우 높음 · 최대). */
export const EFFORTS: { id: string; label: string; name: string }[] = [
  { id: "low", label: "low", name: "낮음" },
  { id: "medium", label: "medium", name: "보통" },
  { id: "high", label: "high", name: "높음" },
  { id: "xhigh", label: "xhigh", name: "매우 높음" },
  { id: "max", label: "max", name: "최대" },
];
export const effortLabel = (id: string) => t(EFFORTS.find((e) => e.id === id)?.name ?? id);
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
  window.addEventListener("keydown", (e) => e.key === "Escape" && !ignoredKey(e) && noModifiers(e) && openPop() && (e.preventDefault(), e.stopPropagation(), setOpenPop(null)), true);
}
export const anyPop = () => openPop() !== null;
export const closePops = () => setOpenPop(null);
export function usePop(): [() => boolean, (v: boolean) => void] {
  const me = Symbol();
  onCleanup(() => openPop() === me && setOpenPop(null));
  return [() => openPop() === me, (v) => setOpenPop(v ? me : null)];
}

/** The nearest box that clips what is inside it (a scroller), else the window. */
function clipBox(el: HTMLElement) {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p);
    if (/(auto|scroll|hidden|clip)/.test(`${o.overflowY}${o.overflowX}`)) {
      const r = p.getBoundingClientRect();
      return { top: Math.max(0, r.top), bottom: Math.min(innerHeight, r.bottom) };
    }
  }
  return { top: 0, bottom: innerHeight };
}

/**
 * Place a popover beside the box it is positioned against: on the side it
 * was drawn for when it fits there, else on the side with more room, scrolling
 * if even that is short. It never covers its control.
 */
export function placePop(el: HTMLElement) {
  // what it is positioned against: its picker, or the input's edge for the composer's menus
  const host = (el.offsetParent as HTMLElement | null) ?? el.parentElement;
  if (!host || !el.isConnected) return;
  const a = host.getBoundingClientRect();
  const box = clipBox(host);
  const gap = 6;
  const above = a.top - box.top - gap - 4;
  const below = box.bottom - a.bottom - gap - 4;
  el.style.maxHeight = "";
  const h = el.offsetHeight;
  const r = el.getBoundingClientRect();
  // a screen can ask its menus to drop down (the new-task form); otherwise the side it was drawn for
  const prefer = el.closest<HTMLElement>("[data-pops]")?.dataset.pops;
  const wasUp = prefer === "down" ? false : prefer === "up" ? true : r.bottom <= a.top + 1;
  const up = wasUp ? h <= above || above >= below : !(h <= below || below >= above);
  el.style.top = up ? "auto" : `calc(100% + ${gap}px)`;
  el.style.bottom = up ? `calc(100% + ${gap}px)` : "auto";
  el.classList.toggle("up", up);
  const room = Math.floor(up ? above : below);
  if (h > room) {
    el.style.maxHeight = `${Math.max(120, room)}px`;
    el.style.overflowY = "auto";
  }
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
  const [q, setQ] = createSignal("");
  const auto = () => accountById(props.accountId)?.model;
  // a direct connection's models go by their own names ("llama3.1:8b"), as one list under the connection
  const direct = () => !!connectionOf(props.accountId);
  const nameOf = (m: string) => connModelLabel(props.accountId, m) ?? prettyModel(m);
  const label = () => (props.model ? nameOf(props.model) : auto() ? nameOf(auto()!) : t("모델 선택"));
  const noTools = (m: string) => !canUseTools(props.accountId, m);
  const effort = () => effortOf(props.thinking);
  const current = () => props.model || auto() || "";
  const all = () => models() ?? [];
  const ranked = () => rankModels(all());
  // a short list is shown whole; "자주 씀" only earns its place in front of a long one
  const long = () => all().length > 6 && !direct();
  const often = () => (long() ? ranked().often : []);
  const groups = (): [string, string[]][] =>
    long() ? ranked().latest : [...new Set(all().map((m) => m.split("/")[0]))].map((pv) => [pv, all().filter((m) => m.split("/")[0] === pv)]);
  const older = () => (long() ? ranked().older : []);
  // typing finds any model, the folded older ones too
  const found = () => {
    const k = q().trim().toLowerCase();
    return k ? all().filter((m) => m.toLowerCase().includes(k) || nameOf(m).toLowerCase().includes(k)) : null;
  };
  const PROVIDER: Record<string, string> = { "openai-codex": "OpenAI · ChatGPT 계정", openai: "OpenAI", anthropic: "Anthropic · Claude 계정", google: "Google" };
  const provider = (id: string) => (PROVIDER[id] ? t(PROVIDER[id]) : id);
  // the models of one account: it is named the way the usage chip names it; several providers keep theirs
  const heading = (id: string) => (groups().length <= 1 && accountName(props.accountId)) || provider(id);
  const Item = (p: { m: string }) => (
    <button type="button" class="pop-item" classList={{ on: current() === p.m }} onClick={() => (props.onChange(p.m, effort()), setOpen(false))}>
      <span class="pop-item-main">{nameOf(p.m)}</span>
      <Show when={noTools(p.m)}><span class="model-tag" title={t("도구 없이 대화만 해요")}>{t("도구 없음")}</span></Show>
      <Show when={current() === p.m}><Icon name="check" size={14} /></Show>
    </button>
  );
  return (
    <div class="picker" onClick={(e) => e.stopPropagation()}>
      <button type="button" class="chip model-chip" classList={{ on: open() }} onClick={() => (setQ(""), setOpen(!open()))} title={current() ? [label(), effortLabel(effort()), noTools(current()) ? t("도구 없이 대화만 해요") : ""].filter(Boolean).join(" · ") : t("모델 · 추론 강도")}>
        <span class="model-name">{label()}</span>
        <Show when={current() && noTools(current())}><span class="model-effort">{t("도구 없음")}</span></Show>
        <Show when={current()}><span class="model-effort">{effortLabel(effort())}</span></Show>
        <Icon name="down" size={12} class="muted" />
      </button>
      <Show when={open()}>
        <div class="pop model-pop" classList={{ up: props.up }} role="dialog" aria-label={[t("모델 · 추론 강도"), accountName(props.accountId)].filter(Boolean).join(" · ")}>
          <EffortSlider value={effort()} onChange={(id) => props.onChange(props.model, id)} />
          <div class="pop-sep" />
          <Show when={all().length > 8}>
            <div class="model-find">
              <Icon name="search" size={14} />
              <input
                placeholder={t("모델 찾기")}
                aria-label={t("모델 찾기")}
                value={q()}
                onInput={(e) => setQ(e.currentTarget.value)}
                onKeyDown={(e) => {
                  const f = found();
                  if (e.key === "Enter" && f?.length) (props.onChange(f[0], effort()), setOpen(false));
                }}
                ref={(el) => setTimeout(() => el.focus(), 0)}
              />
            </div>
          </Show>
          <div class="pop-scroll">
            <Show when={!loading()} fallback={<div class="pop-empty"><span class="spin sm" />{t("모델 불러오는 중…")}</div>}>
              <Show
                when={found()}
                fallback={
                  <>
                    <Show when={often().length}>
                      <div class="pop-label">{t("자주 씀")}</div>
                      <For each={often()}>{(m) => <Item m={m} />}</For>
                    </Show>
                    <For each={groups()}>
                      {([id, list]) => (
                        <>
                          <div class="pop-label">{heading(id)}</div>
                          <For each={list}>{(m) => <Item m={m} />}</For>
                        </>
                      )}
                    </For>
                    <Show when={older().length}>
                      <button type="button" class="pop-item pop-more" onClick={() => setShowOld(!showOld())} aria-expanded={showOld()}>
                        <span class="pop-item-main">{t("이전 모델 {n}개", { n: older().length })}</span>
                        <Icon name={showOld() ? "down" : "chevron"} size={12} class="muted" />
                      </button>
                      <Show when={showOld()}><For each={older()}>{(m) => <Item m={m} />}</For></Show>
                    </Show>
                    <Show when={!all().length}><div class="pop-empty">{t("모델 없음")}</div></Show>
                  </>
                }
              >
                {(f) => (
                  <Show when={f().length} fallback={<div class="pop-empty">{t("모델 없음")}</div>}>
                    <For each={f()}>{(m) => <Item m={m} />}</For>
                  </Show>
                )}
              </Show>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
}

// ───────────── what a job may do without asking
export const PERMISSIONS: { id: Permission; label: string; icon: string; desc: string }[] = [
  { id: "ask", label: "매번 묻기", icon: "lock", desc: "수정 전에 확인" },
  { id: "edits", label: "편집 허용", icon: "pencil", desc: "폴더 안 파일은 바로 수정" },
  { id: "full", label: "전체 권한", icon: "shield", desc: "확인 없이 모두 실행" },
];

export function PermissionPicker(props: { value: Permission; onChange: (p: Permission) => void }) {
  const [open, setOpen] = usePop();
  const cur = () => PERMISSIONS.find((p) => p.id === props.value) ?? PERMISSIONS[1];
  return (
    <div class="picker" onClick={(e) => e.stopPropagation()}>
      <button type="button" class="chip perm-chip" classList={{ [`p-${cur().id}`]: true, on: open(), full: cur().id === "full" }} onClick={() => setOpen(!open())} title={t("권한")}>
        <Icon name={cur().icon} size={14} />
        {t(cur().label)}
      </button>
      <Show when={open()}>
        <div class="pop up left perm-pop">
          <For each={PERMISSIONS}>
            {(p) => (
              <button type="button" class={`perm-item p-${p.id}`} classList={{ on: p.id === cur().id }} onClick={() => (props.onChange(p.id), setOpen(false))}>
                <span class="perm-title">
                  <Icon name={p.icon} size={16} />
                  {t(p.label)}
                  <Show when={p.id === cur().id}><Icon name="check" size={14} class="perm-check" /></Show>
                </span>
                <span class="perm-desc">{t(p.desc)}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/** 추론 강도 as a segmented control, a cell per level: click one, or the arrow keys. */
function EffortSlider(props: { value: string; onChange: (id: string) => void }) {
  const n = EFFORTS.length;
  const at = () => Math.max(0, EFFORTS.findIndex((e) => e.id === props.value));
  const set = (i: number) => {
    const id = EFFORTS[Math.min(n - 1, Math.max(0, i))].id;
    if (id !== props.value) props.onChange(id);
  };
  const key = (e: KeyboardEvent) => {
    if (ignoredKey(e) || !noModifiers(e)) return;
    const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (e.key === "Home") return e.preventDefault(), set(0);
    if (e.key === "End") return e.preventDefault(), set(n - 1);
    if (d) e.preventDefault(), set(at() + d);
  };
  return (
    <div class="eff">
      <div class="eff-head">
        <span>{t("추론 강도")}</span>
      </div>
      <div class="eff-seg" role="radiogroup" tabindex="0" aria-label={t("추론 강도")} onKeyDown={key}>
        <For each={EFFORTS}>
          {(x, i) => (
            <button type="button" role="radio" tabindex="-1" aria-checked={i() === at()} classList={{ on: i() === at() }} onClick={() => set(i())}>
              {t(x.name)}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
