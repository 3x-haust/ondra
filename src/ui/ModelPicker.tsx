// Model + effort, as one chip with a popover. Lists what the account's
// login can actually use (asked from the engine once per account).
import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { accountById } from "../state/store";
import { ignoredKey, noModifiers } from "../lib/shortcuts";
import type { Permission } from "../state/types";
import { modelsNow, rankModels, refreshModels } from "../engine/modelList";
import { Icon } from "./Icon";
import { t } from "../i18n";

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
  window.addEventListener("keydown", (e) => e.key === "Escape" && !ignoredKey(e) && noModifiers(e) && openPop() && (e.preventDefault(), e.stopPropagation(), setOpenPop(null)), true);
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
  const label = () => (props.model ? prettyModel(props.model) : auto() ? prettyModel(auto()!) : t("모델 선택"));
  const effort = () => effortOf(props.thinking);
  const current = () => props.model || auto() || "";
  const ranked = () => rankModels(models() ?? []);
  const groups = () => ranked().latest;
  const PROVIDER: Record<string, string> = { "openai-codex": "OpenAI · ChatGPT 계정", openai: "OpenAI", anthropic: "Anthropic · Claude 계정", google: "Google" };
  const provider = (id: string) => (PROVIDER[id] ? t(PROVIDER[id]) : id);
  const Item = (p: { m: string }) => (
    <button type="button" class="pop-item" onClick={() => (props.onChange(p.m, effort()), setOpen(false))}>
      <span class="pop-item-main">{prettyModel(p.m)}</span>
      <Show when={current() === p.m}><Icon name="check" size={14} /></Show>
    </button>
  );
  return (
    <div class="picker" onClick={(e) => e.stopPropagation()}>
      <button type="button" class="chip model-chip" classList={{ on: open() }} onClick={() => setOpen(!open())} title={t("모델 · 추론 강도")}>
        <span class="model-name">{label()}</span>
        <Show when={current()}><span class="model-effort">{effort()}</span></Show>
        <Icon name="down" size={12} class="muted" />
      </button>
      <Show when={open()}>
        <div class="pop model-pop" classList={{ up: props.up }}>
          <EffortSlider value={effort()} onChange={(id) => props.onChange(props.model, id)} />
          <div class="pop-sep" />
          <div class="pop-scroll">
            <Show when={!loading()} fallback={<div class="pop-empty"><span class="spin sm" />{t("모델 불러오는 중")}</div>}>
              <Show when={ranked().often.length}>
                <div class="pop-label">{t("자주 씀")}</div>
                <For each={ranked().often}>{(m) => <Item m={m} />}</For>
              </Show>
              <For each={groups()}>
                {([id, list]) => (
                  <>
                    <div class="pop-label">{provider(id)}</div>
                    <For each={list}>{(m) => <Item m={m} />}</For>
                  </>
                )}
              </For>
              <Show when={ranked().older.length}>
                <button type="button" class="pop-item pop-more" onClick={() => setShowOld(!showOld())}>
                  <span class="pop-item-main">{t("이전 모델 {n}개", { n: ranked().older.length })}</span>
                  <Icon name={showOld() ? "down" : "chevron"} size={12} class="muted" />
                </button>
                <Show when={showOld()}><For each={ranked().older}>{(m) => <Item m={m} />}</For></Show>
              </Show>
              <Show when={!groups().length && !ranked().often.length}><div class="pop-empty">{t("모델 없음")}</div></Show>
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
      <button type="button" class={`chip perm-chip p-${cur().id}`} classList={{ on: open(), full: cur().id === "full" }} onClick={() => setOpen(!open())} title={t("권한")}>
        <Icon name={cur().icon} size={14} />
        {t(cur().label)}
      </button>
      <Show when={open()}>
        <div class="pop up left perm-pop" style={{ bottom: "calc(100% + 8px)", top: "auto" }}>
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
              {x.label}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
