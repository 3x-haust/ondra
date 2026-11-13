// Every emoji, with search in Korean and English and a bar of categories (the data is loaded the
// first time the picker opens, not with the app).
import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { Icon } from "./Icon";
import { t } from "../i18n";

interface Emoji { e: string; group: number; words: string; label: string }
interface Raw { unicode: string; label: string; tags?: string[]; group?: number; order?: number; hexcode: string }

/** the categories as the data numbers them (2, skin-tone parts, is left out) */
const GROUPS: { n: number; label: string; icon: string }[] = [
  { n: 0, label: "웃는 얼굴과 감정", icon: "😀" },
  { n: 1, label: "사람과 몸", icon: "👋" },
  { n: 3, label: "동물과 자연", icon: "🐻" },
  { n: 4, label: "음식과 음료", icon: "🍔" },
  { n: 5, label: "여행과 장소", icon: "✈️" },
  { n: 6, label: "활동", icon: "⚽" },
  { n: 7, label: "사물", icon: "💡" },
  { n: 8, label: "기호", icon: "❤️" },
  { n: 9, label: "깃발", icon: "🏳️" },
];

let cache: Promise<Emoji[]> | undefined;
/** Korean and English names and tags, joined per emoji, in the standard order */
function load(): Promise<Emoji[]> {
  cache ??= Promise.all([import("emojibase-data/ko/compact.json"), import("emojibase-data/en/compact.json")]).then(([ko, en]) => {
    const english = new Map<string, Raw>(((en.default ?? en) as Raw[]).map((x) => [x.hexcode, x]));
    return ((ko.default ?? ko) as Raw[])
      .filter((x) => x.group !== undefined && x.group !== 2)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((x) => {
        const o = english.get(x.hexcode);
        return { e: x.unicode, group: x.group!, label: x.label, words: [x.label, ...(x.tags ?? []), o?.label ?? "", ...(o?.tags ?? [])].join(" ").toLowerCase() };
      });
  });
  return cache;
}

export function EmojiPicker(props: { value?: string; onPick: (e: string) => void }) {
  const [all] = createResource(load);
  const [q, setQ] = createSignal("");
  let list!: HTMLDivElement;
  let search!: HTMLInputElement;
  onMount(() => requestAnimationFrame(() => search.focus()));
  const found = createMemo(() => {
    const words = q().trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? (all() ?? []).filter((x) => words.every((w) => x.words.includes(w))) : [];
  });
  const go = (n: number) => list.querySelector<HTMLElement>(`[data-group="${n}"]`)?.scrollIntoView({ block: "start" });
  const cell = (x: Emoji) => (
    <button class="ep-cell" classList={{ on: props.value === x.e }} title={x.label} aria-label={x.label} onClick={() => props.onPick(x.e)}>
      {x.e}
    </button>
  );
  return (
    <div class="ep">
      <label class="ep-search">
        <Icon name="search" size={14} />
        <input ref={search} value={q()} placeholder={t("이모지 검색")} aria-label={t("이모지 검색")} onInput={(e) => (setQ(e.currentTarget.value), list.scrollTo(0, 0))} />
        <Show when={q()}>
          <button class="ep-x" aria-label={t("지우기")} onClick={() => (setQ(""), search.focus())}>
            <Icon name="x" size={12} />
          </button>
        </Show>
      </label>
      <div class="ep-list" ref={list}>
        <Show when={all()} fallback={<div class="ep-empty"><span class="spin sm" /></div>}>
          <Show
            when={q().trim()}
            fallback={
              <For each={GROUPS}>
                {(g) => (
                  <section data-group={g.n}>
                    <h4 class="ep-h">{t(g.label)}</h4>
                    <div class="ep-grid">
                      <For each={all()!.filter((x) => x.group === g.n)}>{cell}</For>
                    </div>
                  </section>
                )}
              </For>
            }
          >
            <Show when={found().length} fallback={<div class="ep-empty">{t("찾는 이모지가 없어요")}</div>}>
              <div class="ep-grid">
                <For each={found()}>{cell}</For>
              </div>
            </Show>
          </Show>
        </Show>
      </div>
      <div class="ep-foot">
        <div class="ep-cats">
          <For each={GROUPS}>{(g) => <button class="ep-cat" title={t(g.label)} aria-label={t(g.label)} onClick={() => (setQ(""), queueMicrotask(() => go(g.n)))}>{g.icon}</button>}</For>
        </div>
      </div>
    </div>
  );
}
