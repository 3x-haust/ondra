// A settings tab with a connected device picked (Settings' 기기): that device's own settings for the
// tab, as it writes them (views/farPages.ts, asked over engine/remote.ts settingsPage). Seen here,
// changed on that device; asked again when the window comes back to the front.
import { createResource, For, onCleanup, Show } from "solid-js";
import { askHost, hostName } from "../engine/hosts";
import { lang, t } from "../i18n";
import type { SettingsTab } from "../state/ui";
import type { FarPage } from "./farPages";
import { GroupTitle, PageHead } from "./Settings";

/** the device's answer, or why there is none (an older Ondra doesn't know the question) */
const why = (e: unknown, host: string) => {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.startsWith("unknown:") ? t("{name}의 Ondra를 업데이트하면 볼 수 있어요", { name: hostName(host) }) : msg;
};

export function FarSettingsPage(props: { host: string; tab: SettingsTab }) {
  // 도구 starts a short-lived engine there the first time: more than the usual wait
  const [page, { refetch }] = createResource(() => askHost<FarPage>(props.host, "settingsPage", [props.tab, lang()], 120_000));
  const again = () => void refetch();
  window.addEventListener("focus", again);
  onCleanup(() => window.removeEventListener("focus", again));
  return (
    <>
      <PageHead tab={props.tab} />
      <p class="set-quiet ag-far-note">{t("{name}의 설정이에요. 그 기기에서 바꿀 수 있어요", { name: hostName(props.host) })}</p>
      <Show
        when={!page.error}
        fallback={<div class="set-group"><div class="empty-line">{why(page.error, props.host)}</div></div>}
      >
        <Show when={page()} fallback={<div class="set-group"><div class="empty-line">{t("불러오는 중…")}</div></div>}>
          {(p) => (
            <Show when={!p().empty} fallback={<div class="set-group"><div class="empty-line">{p().empty}</div></div>}>
              <For each={p().groups}>
                {(g) => (
                  <>
                    <Show when={g.title}>{(title) => <GroupTitle title={title()} />}</Show>
                    <div class="set-group">
                      <For each={g.rows}>
                        {(r) => (
                          <div class="set-row far-row" classList={{ two: !!r.sub, off: r.off }} data-set={r.title}>
                            <div class="set-label">
                              <b>{r.title}</b>
                              <Show when={r.sub}><span class="set-sub selectable">{r.sub}</span></Show>
                            </div>
                            <Show when={r.value}><div class="set-value"><span class="set-quiet">{r.value}</span></div></Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </>
                )}
              </For>
            </Show>
          )}
        </Show>
      </Show>
    </>
  );
}
