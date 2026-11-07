import { createEffect, For, onMount, Show } from "solid-js";
import { loadReleases, notesFor, releases, releasesFailed, releasesLoading, setNotesFor } from "../engine/releaseNotes";
import { Markdown } from "./Markdown";
import { Sheet } from "./Sheet";
import "./releaseNotes.css";

const day = (t?: number) => (t ? new Date(t).toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" }) : "");

export function ReleaseNotes(props: { current: string }) {
  let body!: HTMLDivElement;
  onMount(() => void loadReleases());
  createEffect(() => {
    const v = notesFor();
    if (!v || !releases().length) return;
    queueMicrotask(() => body?.querySelector(`[data-version="${CSS.escape(v)}"]`)?.scrollIntoView({ block: "start" }));
  });
  return (
    <Sheet title="릴리즈 노트" class="rn-sheet" onClose={() => setNotesFor(null)}>
      <div class="rn-list" ref={body}>
        <Show
          when={releases().length}
          fallback={
            <Show when={releasesLoading() || releasesFailed()}>
              <div class="rn-empty">
                <Show when={!releasesLoading()} fallback="불러오는 중…">
                  릴리즈 노트를 불러오지 못했어요
                  <button class="btn sm" onClick={() => void loadReleases()}>다시 시도</button>
                </Show>
              </div>
            </Show>
          }
        >
          <For each={releases()}>
            {(r) => (
              <section class="rn-entry" data-version={r.version}>
                <header class="rn-head">
                  <b>{r.version}</b>
                  <Show when={r.version === props.current}><span class="rn-now">지금 버전</span></Show>
                  <span class="rn-date">{day(r.date)}</span>
                </header>
                <Show when={r.notes} fallback={<p class="rn-none">적힌 내용이 없어요</p>}>
                  <Markdown class="rn-md" text={r.notes} />
                </Show>
              </section>
            )}
          </For>
        </Show>
      </div>
    </Sheet>
  );
}
