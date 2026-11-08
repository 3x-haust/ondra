// Every registered chart kind with its examples, in both themes (open with ?gallery).
import { createSignal, For } from "solid-js";
import { BlockView } from "../ui/Blocks";
import { allViz } from "../ui/viz";
import type { VizFamily } from "../ui/viz/registry";
import type { Block } from "../state/types";
import { t } from "../i18n";

const NAMES: Record<VizFamily, string> = { stat: "통계·논문", chart: "비교·추이·구성", relation: "관계·흐름·계층·지도", slide: "발표·업무 도식" };

export function VizGallery() {
  const [theme, setTheme] = createSignal(document.documentElement.dataset.theme ?? "light");
  const flip = (t: string) => ((document.documentElement.dataset.theme = t), setTheme(t));
  flip(theme());
  const families = () => (Object.keys(NAMES) as VizFamily[]).map((f) => ({ f, specs: allViz().filter((s) => s.family === f) })).filter((x) => x.specs.length);
  return (
    <div class="viz-gallery">
      <header>
        <h1>{t("차트 {n}종", { n: allViz().length })}</h1>
        <button class="btn sm" onClick={() => flip(theme() === "dark" ? "light" : "dark")}>{theme() === "dark" ? t("라이트") : t("다크")}</button>
      </header>
      <For each={families()}>
        {(g) => (
          <section>
            <h2>{t(NAMES[g.f])} · {g.specs.length}</h2>
            <div class="viz-gallery-grid">
              <For each={g.specs}>
                {(s) => (
                  <For each={s.examples}>
                    {(ex) => (
                      <article data-kind={s.type}>
                        <p class="viz-gallery-name"><b>{s.title}</b> <code>{s.type}</code></p>
                        <BlockView block={{ type: s.type, ...ex } as Block} />
                      </article>
                    )}
                  </For>
                )}
              </For>
            </div>
          </section>
        )}
      </For>
    </div>
  );
}
