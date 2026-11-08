// Composition (after json-render: blocks inside blocks): a responsive grid of
// any blocks, and a 16:9 slide with a title and nested blocks that scales with
// the column and shrinks its body to fit.
import { createContext, createSignal, For, onCleanup, onMount, Show, useContext } from "solid-js";
import type { Block } from "../../../state/types";
import { BlockView } from "../../Blocks";
import { defineViz } from "../registry";
import { arr, str, texts, type Checked } from "./util";

/** how deep blocks are nested; past MAX nothing more is drawn */
const Depth = createContext(0);
const MAX = 3;

type Child = Block & { span?: number };
/** keep the children that are blocks (an object with a string "type") */
function children(raw: unknown, where: string, dropped: string[]): Child[] {
  const out: Child[] = [];
  arr(raw).forEach((x, i) => {
    if (x && typeof x === "object" && typeof (x as { type?: unknown }).type === "string") out.push(x as Child);
    else dropped.push(`${where}[${i}]: type이 있는 블록이 아님`);
  });
  return out;
}

/* ───────────── layout ───────────── */

interface LayoutB { label?: string; cols?: number; items?: unknown[] }
function checkLayout(b: LayoutB): Checked<LayoutB & { _c: Child[] }> {
  const dropped: string[] = [];
  return { block: { ...b, _c: children(b.items, "items", dropped).slice(0, 12) }, dropped };
}
function Layout(props: { b: ReturnType<typeof checkLayout>["block"] }) {
  const depth = useContext(Depth);
  const cols = () => Math.max(1, Math.min(4, Math.round(props.b.cols ?? Math.min(3, props.b._c.length || 1))));
  return (
    <Show when={depth < MAX}>
      <div class={`sl-layout c${cols()}`}>
        <Show when={props.b.label}><div class="blk-label">{props.b.label}</div></Show>
        <div class="sl-layout-grid">
          <Depth.Provider value={depth + 1}>
            <For each={props.b._c}>
              {(c) => <div class="sl-layout-cell" style={{ "--span": Math.max(1, Math.min(cols(), Math.round(c.span ?? 1))) }}><BlockView block={c} /></div>}
            </For>
          </Depth.Provider>
        </div>
      </div>
    </Show>
  );
}
defineViz<LayoutB>({
  type: "layout",
  family: "slide",
  title: "레이아웃 (블록 묶기)",
  when: "여러 블록을 2–4열 격자로 나란히 놓을 때 (KPI 묶음, 사진 목록, 비교 한 쌍)",
  check: checkLayout,
  render: (b) => <Layout b={b as ReturnType<typeof checkLayout>["block"]} />,
  examples: [
    {
      cols: 3,
      items: [
        { type: "metric", label: "월 매출", value: "12.8억", delta: "+6.7%", trend: [9.1, 9.8, 10.2, 11, 11.9, 12.8] },
        { type: "metric", label: "유료 고객", value: "4,210", delta: "+312", trend: [3200, 3450, 3610, 3800, 3900, 4210] },
        { type: "metric", label: "이탈률", value: "4.1%", delta: "+1.1%p", trend: [2.8, 3, 3.1, 3.5, 3.9, 4.1] },
      ],
    },
    {
      cols: 2,
      items: [
        { type: "quote", text: "검색 결과가 너무 많아 고르기 어려워요", by: "인터뷰 P2" },
        { type: "prosCons", pros: [{ label: "필터 사용률 2배" }], cons: [{ label: "첫 화면 결과 수 감소" }] },
      ],
    },
  ],
});

/* ───────────── slide ───────────── */

interface SlideB { title?: string; subtitle?: string; label?: string; no?: number | string; foot?: string; cols?: number; bullets?: unknown[]; items?: unknown[] }
function checkSlide(b: SlideB): Checked<SlideB & { _c: Child[] }> {
  const dropped: string[] = [];
  return { block: { ...b, _c: children(b.items, "items", dropped).slice(0, 6) }, dropped };
}
/** the width a slide is laid out at: the column, but never under MIN (it scales down instead) */
const MIN = 560;
function Slide(props: { b: ReturnType<typeof checkSlide>["block"] }) {
  const depth = useContext(Depth);
  let host!: HTMLDivElement, body!: HTMLDivElement, content!: HTMLDivElement;
  const [w, setW] = createSignal(720);
  const [k, setK] = createSignal(1);
  const D = () => Math.max(w(), MIN);
  const s = () => w() / D();
  const fit = () => {
    if (!body || !content) return;
    const avail = body.clientHeight, natural = content.scrollHeight;
    const next = natural > avail && natural > 0 ? Math.max(0.5, avail / natural) : 1;
    if (Math.abs(next - k()) > 0.01) setK(next);
  };
  onMount(() => {
    const ro = new ResizeObserver(() => setW(Math.max(240, Math.round(host.clientWidth))));
    ro.observe(host);
    const rc = new ResizeObserver(() => requestAnimationFrame(fit));
    rc.observe(content);
    rc.observe(body);
    onCleanup(() => (ro.disconnect(), rc.disconnect()));
  });
  const bullets = () => texts(props.b.bullets);
  const cols = () => Math.max(1, Math.min(3, Math.round(props.b.cols ?? Math.min(2, props.b._c.length || 1))));
  return (
    <Show when={depth < MAX}>
      <div class="sl-slide-host" ref={host} style={{ height: `${(D() * 9) / 16 * s()}px` }}>
        <div role="group" class="sl-slide" style={{ width: `${D()}px`, height: `${(D() * 9) / 16}px`, transform: s() < 1 ? `scale(${s()})` : undefined, "--d": `${D()}px` }} aria-label={props.b.title ?? props.b.label}>
          <div class="sl-slide-head">
            <h3>{props.b.title ?? props.b.label}</h3>
            <Show when={props.b.subtitle}><p>{props.b.subtitle}</p></Show>
          </div>
          <div class="sl-slide-body" ref={body}>
            <div class="sl-slide-content" ref={content} style={{ transform: k() < 1 ? `scale(${k()})` : undefined }}>
              <Show when={bullets().length}><ul class="sl-slide-bullets"><For each={bullets()}>{(t) => <li>{t}</li>}</For></ul></Show>
              <Show when={props.b._c.length}>
                <div class="sl-slide-grid" style={{ "--cols": cols() }}>
                  <Depth.Provider value={depth + 1}>
                    <For each={props.b._c}>{(c) => <div class="sl-slide-cell" style={{ "--span": Math.max(1, Math.min(cols(), Math.round(c.span ?? 1))) }}><BlockView block={c} /></div>}</For>
                  </Depth.Provider>
                </div>
              </Show>
            </div>
          </div>
          <Show when={props.b.foot || props.b.no !== undefined}>
            <div class="sl-slide-foot"><span>{str(props.b.foot)}</span><Show when={props.b.no !== undefined}><span class="num">{props.b.no}</span></Show></div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
defineViz<SlideB>({
  type: "slide",
  family: "slide",
  title: "슬라이드",
  when: "제목과 블록 몇 개를 16:9 발표 한 장으로 묶어 보여 줄 때",
  check: checkSlide,
  render: (b) => <Slide b={b as ReturnType<typeof checkSlide>["block"]} />,
  examples: [
    {
      title: "결제 실패, 재시도로 70%를 되살린다",
      subtitle: "10월 결제 실패 4,120건 분석",
      no: 7,
      foot: "결제 로그 2026. 10. 1.–10. 31.",
      cols: 2,
      items: [
        { type: "funnel", unit: "건", items: [{ label: "결제 시도", value: 182400 }, { label: "1차 실패", value: 4120 }, { label: "재시도 성공", value: 2890 }] },
        { type: "points", cols: 1, items: [{ label: "실패의 절반은 일시 오류", note: "PG 타임아웃 52%" }, { label: "재시도 큐 도입", note: "3회, 지수 백오프", em: true }] },
      ],
    },
    {
      title: "2027 우선순위",
      subtitle: "영향은 크고 노력은 적은 것부터",
      bullets: ["결제 재시도와 검색 자동완성을 1분기에 끝낸다", "온보딩 개편은 2분기 디자인 확정 후 시작", "레거시 API 이전은 보류"],
    },
  ],
});
