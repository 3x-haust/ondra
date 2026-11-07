// Paper tables and formulas: the results table, typeset equations and scaling plots.
//   results · equation · scaling
import { line } from "d3-shape";
import { createMemo, createResource, For, onCleanup, Show } from "solid-js";
import { defineViz } from "../registry";
import { arr, col, fix, Nearest, Plot, SM, str, tw } from "./common";
import { isNum, logDomain, placeLabels, powerFit, ranks, toNum } from "./math";
import { pointsOf } from "./rel";

// ───────────── results table

type Cell = number | [number, number] | string | null;
interface ResCol { label: string; better?: "up" | "down"; digits?: number }
interface ResB { label?: string; note?: string; columns?: (ResCol | string)[]; rows?: { label: string; values: Cell[]; em?: boolean; group?: string }[]; digits?: number }
function Results(b: ResB) {
  const cols = () => arr<any>(b.columns).map((c) => (typeof c === "string" ? { label: c } : { label: str(c?.label), better: c?.better === "down" ? "down" : c?.better === "up" ? "up" : undefined, digits: isNum(c?.digits) ? c.digits : undefined })) as ResCol[];
  const rows = () => arr<any>(b.rows).filter((r) => r && typeof r === "object").map((r) => ({ label: str(r.label), values: arr<any>(r.values), em: !!(r.em ?? r.highlight), group: str(r.group) }));
  const mean = (v: any): number | null => (Array.isArray(v) ? (isNum(toNum(v[0])) ? toNum(v[0]) : null) : isNum(toNum(v)) && typeof v !== "boolean" ? toNum(v) : null);
  const R = createMemo(() => cols().map((c, j) => (c.better ? ranks(rows().map((r) => mean(r.values[j])), c.better) : { best: new Set<number>(), second: new Set<number>() })));
  const digits = (j: number) => cols()[j]?.digits ?? b.digits;
  const show = (v: any, j: number) => {
    if (Array.isArray(v) && isNum(toNum(v[0]))) return { m: fix(toNum(v[0]), digits(j)), s: isNum(toNum(v[1])) ? fix(toNum(v[1]), digits(j)) : "" };
    if (typeof v === "number") return { m: fix(v, digits(j)), s: "" };
    if (typeof v === "string") return { m: v, s: "" };
    return { m: "–", s: "" };
  };
  return (
    <Show when={cols().length && rows().length}>
      <div class="blk viz st-results-blk">
        <Show when={b.label}><div class="blk-label">{b.label}</div></Show>
        <div class="st-results">
          <table>
            <thead>
              <tr>
                <th />
                <For each={cols()}>
                  {(c) => <th>{c.label}<Show when={c.better}><span class="st-arrow" title={c.better === "up" ? "높을수록 좋음" : "낮을수록 좋음"}>{c.better === "up" ? "↑" : "↓"}</span></Show></th>}
                </For>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(r, i) => (
                  <>
                    <Show when={r.group && r.group !== rows()[i() - 1]?.group}>
                      <tr class="st-group"><td colSpan={cols().length + 1}>{r.group}</td></tr>
                    </Show>
                    <tr classList={{ em: r.em }}>
                      <td>{r.label}</td>
                      <For each={cols()}>
                        {(_, j) => {
                          const v = () => show(r.values[j()], j());
                          const best = () => R()[j()].best.has(i()), second = () => R()[j()].second.has(i());
                          const body = () => (
                            <>
                              {v().m}
                              <Show when={v().s}><span class="st-pm"> ± {v().s}</span></Show>
                            </>
                          );
                          return <td>{best() ? <b>{body()}</b> : second() ? <u>{body()}</u> : body()}</td>;
                        }}
                      </For>
                    </tr>
                  </>
                )}
              </For>
            </tbody>
            <Show when={b.note}><caption>{b.note}</caption></Show>
          </table>
        </div>
      </div>
    </Show>
  );
}
defineViz<ResB>({
  type: "results",
  family: "stat",
  title: "결과 표 (논문형)",
  when: "여러 방법을 여러 지표로 비교: 최고는 굵게, 두 번째는 밑줄",
  render: Results,
  examples: [
    {
      label: "벤치마크 결과 (5회 평균 ± 표준편차)", digits: 1, note: "굵게: 최고, 밑줄: 두 번째. ↑ 높을수록, ↓ 낮을수록 좋음.",
      columns: [{ label: "정확도 (%)", better: "up" }, { label: "F1", better: "up", digits: 3 }, { label: "지연 (ms)", better: "down" }, { label: "파라미터", digits: 0 }],
      rows: [
        { group: "기존 방법", label: "BERT-base", values: [[84.2, 0.4], [0.821, 0.006], [18.4, 0.9], "110M"] },
        { group: "기존 방법", label: "RoBERTa-base", values: [[86.1, 0.3], [0.843, 0.004], [19.1, 1.1], "125M"] },
        { group: "기존 방법", label: "DistilBERT", values: [[82.7, 0.5], [0.806, 0.007], [9.6, 0.4], "66M"] },
        { group: "제안 방법", label: "Ours-small", values: [[85.9, 0.3], [0.846, 0.005], [8.9, 0.5], "48M"] },
        { group: "제안 방법", label: "Ours-base", em: true, values: [[87.4, 0.2], [0.861, 0.003], [16.2, 0.7], "112M"] },
      ],
    },
  ],
});

// ───────────── equation (KaTeX, fonts bundled; loaded on first use)

const katexMod = () => Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([k]) => k.default);
/** a wide formula steps down in size to fit its column (to 70%), then scrolls */
function fitEq(el: HTMLDivElement) {
  const fit = () => {
    el.style.fontSize = "";
    const inner = el.firstElementChild as HTMLElement | null;
    const need = inner?.querySelector(".katex")?.scrollWidth ?? 0;
    if (need > el.clientWidth && el.clientWidth > 0) el.style.fontSize = `${Math.max(0.7, el.clientWidth / need) * 100}%`;
  };
  let last = -1;
  const ro = new ResizeObserver(() => { if (el.clientWidth !== last) { last = el.clientWidth; requestAnimationFrame(fit); } });
  ro.observe(el);
  onCleanup(() => ro.disconnect());
}
interface EqB { label?: string; tex?: string; lines?: string[]; number?: string; terms?: { tex: string; label: string }[] }
function Equation(b: EqB) {
  const lines = () => (arr<any>(b.lines).length ? arr<any>(b.lines).map(str) : [str(b.tex)]).filter(Boolean);
  const [katex] = createResource(katexMod);
  const render = (tex: string, display: boolean) => {
    const k = katex();
    if (!k) return null;
    try { return k.renderToString(tex, { displayMode: display, throwOnError: false, output: "htmlAndMathml", strict: "ignore" }); } catch { return null; }
  };
  return (
    <Show when={lines().length}>
      <div class="blk viz st-eq">
        <Show when={b.label}><div class="blk-label">{b.label}</div></Show>
        <For each={lines()}>
          {(t, i) => (
            <div class="st-eq-row">
              <Show when={render(t, true)} fallback={<div class="st-eq-raw">{t}</div>}>{(h) => <div class="st-eq-body" ref={fitEq} innerHTML={h()} />}</Show>
              <Show when={b.number && (lines().length === 1 || i() === lines().length - 1)}><span class="st-eq-num">{b.number}</span></Show>
            </div>
          )}
        </For>
        <Show when={arr(b.terms).length}>
          <dl class="st-eq-terms">
            <For each={arr<any>(b.terms).filter((x) => x && x.tex)}>
              {(x) => (
                <>
                  <dt><Show when={render(str(x.tex), false)} fallback={<code>{str(x.tex)}</code>}>{(h) => <span innerHTML={h()} />}</Show></dt>
                  <dd>{str(x.label)}</dd>
                </>
              )}
            </For>
          </dl>
        </Show>
      </div>
    </Show>
  );
}
defineViz<EqB>({
  type: "equation",
  family: "stat",
  title: "수식 (LaTeX)",
  when: "모델·손실 함수·통계량의 정의를 논문처럼 조판해 보여 주기",
  render: Equation,
  examples: [
    { label: "스케일드 닷 프로덕트 어텐션", tex: "\\operatorname{Attention}(Q,K,V)=\\operatorname{softmax}\\!\\left(\\frac{QK^{\\top}}{\\sqrt{d_k}}\\right)V", number: "(1)", terms: [{ tex: "Q,K,V", label: "쿼리·키·값 행렬" }, { tex: "d_k", label: "키 벡터의 차원" }] },
    { label: "로지스틱 회귀의 손실", lines: ["\\mathcal{L}(\\theta) = -\\frac{1}{n}\\sum_{i=1}^{n}\\big[y_i\\log \\hat{p}_i + (1-y_i)\\log(1-\\hat{p}_i)\\big] + \\lambda\\lVert\\theta\\rVert_2^2", "\\hat{p}_i = \\sigma(\\theta^{\\top}x_i) = \\frac{1}{1+e^{-\\theta^{\\top}x_i}}"], number: "(2)" },
  ],
});

// ───────────── log-scale benchmark / scaling plot

interface ScaleB { label?: string; x?: string; y?: string; logx?: boolean; logy?: boolean; fit?: boolean; connect?: boolean; series?: { label: string; points: unknown[] }[]; points?: unknown[] }
function Scaling(b: ScaleB) {
  const lx = () => b.logx !== false, ly = () => b.logy !== false;
  const S = createMemo(() => {
    const raw = arr<any>(b.series).length ? arr<any>(b.series).map((s, i) => ({ label: str(s?.label) || `${i + 1}`, pts: pointsOf(s?.points) })) : [{ label: "", pts: pointsOf(b.points) }];
    return raw.map((s) => ({ ...s, pts: s.pts.filter((p) => (!lx() || p.x > 0) && (!ly() || p.y > 0)).sort((a, z) => a.x - z.x) })).filter((s) => s.pts.length).slice(0, 6).map((s) => ({ ...s, fit: b.fit ? powerFit(s.pts.map((p) => [p.x, p.y])) : null }));
  });
  const all = () => S().flatMap((s) => s.pts);
  const legend = () => S().map((s, i) => ({ label: `${s.label || "측정"}${s.fit ? ` · 기울기 ${fix(s.fit.b, 2)}` : ""}`, color: col(i) }));
  return (
    <Show when={all().length}>
      <Plot
        label={b.label} legend={S().length > 1 || S()[0]?.fit ? legend() : undefined}
        x={{ domain: lx() ? logDomain(all().map((p) => p.x)) : [Math.min(...all().map((p) => p.x)), Math.max(...all().map((p) => p.x))], log: lx(), title: str(b.x) || undefined, grid: true }}
        y={{ domain: ly() ? logDomain(all().map((p) => p.y)) : [Math.min(0, ...all().map((p) => p.y)), Math.max(...all().map((p) => p.y)) * 1.05], log: ly(), title: str(b.y) || undefined }}
      >
        {(c) => {
          const pts = () => S().flatMap((s, k) => s.pts.map((p) => ({ x: c.X(p.x), y: c.Y(p.y), r: 4, color: col(k), label: p.label, tip: `${p.label ? p.label + "\n" : ""}${fix(p.x)} → ${fix(p.y)}${s.label ? `\n${s.label}` : ""}` })));
          const labs = createMemo(() => {
            const it = pts().filter((p) => p.label);
            const spots = placeLabels(it.map((p) => ({ x: p.x, y: p.y, w: tw(p.label!, SM) + 2, h: 14 })), { x: c.x0, y: c.y0, w: c.iw, h: c.ih }, pts().map((p) => ({ x: p.x - 4, y: p.y - 4, w: 8, h: 8 })), 5);
            return it.map((p, i) => ({ p, r: spots[i] }));
          });
          return (
            <g>
              <For each={S()}>
                {(s, k) => (
                  <g>
                    <Show when={s.fit}>
                      {(f) => {
                        const [a, z] = [s.pts[0].x, s.pts[s.pts.length - 1].x];
                        return <line class="st-ref" style={{ stroke: col(k()) }} x1={c.X(a)} x2={c.X(z)} y1={c.Y(f().a * Math.pow(a, f().b))} y2={c.Y(f().a * Math.pow(z, f().b))} />;
                      }}
                    </Show>
                    <Show when={b.connect !== false && s.pts.length > 1}><path class="st-line" style={{ stroke: col(k()) }} d={line<{ x: number; y: number }>().x((p) => c.X(p.x)).y((p) => c.Y(p.y))(s.pts) ?? ""} /></Show>
                  </g>
                )}
              </For>
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={p.r} style={{ fill: p.color, stroke: "var(--viz-gap)", "stroke-width": 2 }} />}</For>
              <For each={labs()}>{(l) => <Show when={l.r}><text class="st-dl" x={l.r!.x + 1} y={l.r!.y + 11}>{l.p.label}</text></Show>}</For>
              <Nearest pts={pts()} box={c} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<ScaleB>({
  type: "scaling",
  family: "stat",
  title: "로그 스케일 성능·스케일링 그림",
  when: "크기(데이터·파라미터·입력)가 몇 배 커질 때 시간·손실이 어떻게 변하나",
  render: Scaling,
  examples: [
    { label: "모델 크기별 검증 손실", x: "파라미터 수", y: "검증 손실", fit: true, series: [{ label: "Transformer", points: [[1.2e7, 4.1, "12M"], [4.8e7, 3.55, "48M"], [1.6e8, 3.12, "160M"], [6.5e8, 2.74, "650M"], [2.4e9, 2.43, "2.4B"], [9.8e9, 2.17, "9.8B"]] }, { label: "LSTM", points: [[1.2e7, 4.45], [4.8e7, 4.02], [1.6e8, 3.74], [6.5e8, 3.55]] }] },
    { label: "정렬 알고리즘 실행 시간", x: "원소 수 n", y: "시간 (ms)", series: [{ label: "퀵 정렬", points: [[1e3, 0.08], [1e4, 0.95], [1e5, 11.2], [1e6, 131], [1e7, 1540, "1.5초"]] }, { label: "삽입 정렬", points: [[1e3, 0.6], [1e4, 58], [1e5, 5900, "5.9초"]] }, { label: "기수 정렬", points: [[1e3, 0.12], [1e4, 0.9], [1e5, 8.1], [1e6, 79], [1e7, 820]] }] },
  ],
});
