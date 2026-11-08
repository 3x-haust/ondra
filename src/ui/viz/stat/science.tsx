// Science figures: matrices, survival, omics, pharmacology, multivariate, surveys, quality.
//   corr · clustermap · survival · volcano · manhattan · maplot · dose · parallel · ternary · likert · spc
import { line, curveStepAfter } from "d3-shape";
import { ticks as d3ticks } from "d3-array";
import { createMemo, For, Show } from "solid-js";
import { div, Frame, seq, status, useTip } from "../kit";
import { defineViz } from "../registry";
import { arr, col, onDiv, onSeq, Crosshair, DIV_STOPS, ell, fix, Nearest, nums, Plot, RowPlot, ScaleKey, SEQ_STOPS, SM, str, Tip, tw, withU, type Ctx } from "./common";
import { clamp, dendroLines, extent, fit4pl, hclust, isNum, kaplanMeier, likert, logDomain, logistic4, placeLabels, pText, spc, stars, sum, ternary, toNum, type Pt } from "./math";
import { pointsOf } from "./rel";
import { rng, rnorm } from "./sample";
import { t } from "../../../i18n";

// ───────────── matrix heatmaps (correlation, clustered)

interface HeatIn { rows: string[]; cols: string[]; m: number[][]; color: (v: number) => string; on: (v: number) => string; fmt: (v: number) => string; tip: (i: number, j: number) => string; rowTree?: { x1: number; x2: number; y1: number; y2: number }[]; colTree?: { x1: number; x2: number; y1: number; y2: number }[]; mask?: (i: number, j: number) => boolean; mark?: (i: number, j: number) => string }
function heatLayout(h: HeatIn, w: number) {
  const tree = 36;
  const rl = Math.min(w * 0.3, Math.max(0, ...h.rows.map((r) => tw(r, SM))) + 4);
  const left = (h.rowTree ? tree + 4 : 0) + rl + 8;
  const cell = clamp(Math.floor((w - left - 4) / Math.max(1, h.cols.length)), 8, 64);
  const tilt = h.cols.some((c) => tw(c, SM) > cell - 4);
  const colLab = tilt ? Math.min(80, Math.max(...h.cols.map((c) => tw(c, SM)))) * 0.75 + 12 : 18;
  const top = (h.colTree ? tree + 4 : 0) + colLab;
  return { tree, rl, left, cell, tilt, top, h: top + cell * h.rows.length + 4 };
}
function HeatGrid(props: { h: HeatIn; w: number }) {
  const L = () => heatLayout(props.h, props.w);
  const tip = useTip();
  return (
    <g>
      <Show when={props.h.colTree}>
        <g transform={`translate(${L().left},0)`}>
          <For each={props.h.colTree}>{(s) => <line class="st-dendro" x1={(s.x1 + 0.5) * L().cell} x2={(s.x2 + 0.5) * L().cell} y1={L().tree - s.y1 * (L().tree - 2)} y2={L().tree - s.y2 * (L().tree - 2)} />}</For>
        </g>
      </Show>
      <Show when={props.h.rowTree}>
        <g transform={`translate(0,${L().top})`}>
          <For each={props.h.rowTree}>{(s) => <line class="st-dendro" y1={(s.x1 + 0.5) * L().cell} y2={(s.x2 + 0.5) * L().cell} x1={L().tree - s.y1 * (L().tree - 2)} x2={L().tree - s.y2 * (L().tree - 2)} />}</For>
        </g>
      </Show>
      <For each={props.h.cols}>
        {(c, j) => (
          <Show when={L().tilt} fallback={<text class="st-mute" x={L().left + (j() + 0.5) * L().cell} y={L().top - 6} text-anchor="middle"><title>{c}</title>{ell(c, L().cell - 2, SM)}</text>}>
            <text class="st-mute" transform={`translate(${L().left + (j() + 0.5) * L().cell + 3},${L().top - 5}) rotate(-45)`} text-anchor="start"><title>{c}</title>{ell(c, 80, SM)}</text>
          </Show>
        )}
      </For>
      <For each={props.h.rows}>
        {(r, i) => (
          <g>
            <Show when={L().cell >= 11}><text x={L().left - 6} y={L().top + (i() + 0.5) * L().cell} dy="0.32em" text-anchor="end" style={{ "font-size": "12px" }}><title>{r}</title>{ell(r, L().rl, SM)}</text></Show>
            <For each={props.h.cols}>
              {(_, j) => {
                const v = () => props.h.m[i()]?.[j()];
                const on = () => isNum(v()) && (!props.h.mask || props.h.mask(i(), j()));
                return (
                  <Show when={on()}>
                    <g class="viz-mark" onMouseMove={(e) => tip.show(e, props.h.tip(i(), j()))} onMouseLeave={tip.hide}>
                      <rect x={L().left + j() * L().cell + 1} y={L().top + i() * L().cell + 1} width={L().cell - 2} height={L().cell - 2} rx={L().cell > 20 ? 3 : 1} style={{ fill: props.h.color(v()!) }} />
                      <Show when={L().cell >= 34}>
                        <text class={`st-cell-v ${props.h.on(v()!)}`} x={L().left + (j() + 0.5) * L().cell} y={L().top + (i() + 0.5) * L().cell} dy="0.35em" text-anchor="middle" style={{ "font-size": L().cell >= 44 ? "12px" : "10.5px" }}>
                          {props.h.fmt(v()!)}{props.h.mark?.(i(), j()) ?? ""}
                        </text>
                      </Show>
                    </g>
                  </Show>
                );
              }}
            </For>
          </g>
        )}
      </For>
    </g>
  );
}

interface CorrB { label?: string; vars?: string[]; matrix?: number[][]; p?: number[][]; lower?: boolean }
function Corr(b: CorrB) {
  const vars = () => arr<any>(b.vars).map(str).slice(0, 30);
  const m = () => vars().map((_, i) => vars().map((_, j) => clamp(toNum(arr<any>(arr<any>(b.matrix)[i])[j]), -1, 1)));
  const p = (i: number, j: number) => toNum(arr<any>(arr<any>(b.p)[i])[j]);
  const h = (): HeatIn => ({
    rows: vars(), cols: vars(), m: m(),
    color: (v) => div(v), on: (v) => onDiv(v), fmt: (v) => fix(v, 2).replace(/^(-?)0\./, "$1."),
    tip: (i, j) => `r = ${fix(m()[i][j], 2)}${isNum(p(i, j)) ? ` · ${pText(p(i, j))}` : ""}\n${vars()[i]} × ${vars()[j]}`,
    mask: b.lower ? (i, j) => i >= j : undefined,
    mark: arr(b.p).length ? (i, j) => (i !== j && isNum(p(i, j)) && p(i, j) < 0.05 ? stars(p(i, j)) : "") : undefined,
  });
  return (
    <Show when={vars().length >= 2}>
      <Frame label={b.label} class="st" height={(w) => heatLayout(h(), w).h} margin={{ t: 0, r: 0, b: 0, l: 0 }} below={<ScaleKey stops={DIV_STOPS} lo="−1" hi="+1" title={t("상관계수 r")} />}>
        {(box) => <HeatGrid h={h()} w={box.w} />}
      </Frame>
    </Show>
  );
}
defineViz<CorrB>({
  type: "corr",
  family: "stat",
  title: "상관 행렬",
  when: "변수끼리 얼마나, 어느 방향으로 같이 움직이나",
  render: Corr,
  examples: [
    {
      label: "매장 지표 상관 (피어슨)", vars: ["방문객", "체류 시간", "객단가", "재구매율", "할인율", "반품률"],
      matrix: [[1, 0.42, 0.18, 0.35, 0.51, 0.08], [0.42, 1, 0.47, 0.58, 0.12, -0.21], [0.18, 0.47, 1, 0.39, -0.33, -0.12], [0.35, 0.58, 0.39, 1, 0.05, -0.46], [0.51, 0.12, -0.33, 0.05, 1, 0.27], [0.08, -0.21, -0.12, -0.46, 0.27, 1]],
      p: [[0, 0.001, 0.08, 0.002, 0.0001, 0.4], [0.001, 0, 0.0004, 0.00001, 0.22, 0.04], [0.08, 0.0004, 0, 0.0009, 0.003, 0.25], [0.002, 0.00001, 0.0009, 0, 0.6, 0.0002], [0.0001, 0.22, 0.003, 0.6, 0, 0.01], [0.4, 0.04, 0.25, 0.0002, 0.01, 0]],
    },
  ],
});

interface ClusterB { label?: string; rows?: string[]; cols?: string[]; matrix?: number[][]; cluster?: "both" | "rows" | "cols" | "none"; values?: boolean; key?: string }
function Clustermap(b: ClusterB) {
  const D = createMemo(() => {
    const rows = arr<any>(b.rows).map(str).slice(0, 60), cols = arr<any>(b.cols).map(str).slice(0, 40);
    const m = rows.map((_, i) => cols.map((_, j) => toNum(arr<any>(arr<any>(b.matrix)[i])[j])));
    const cl = b.cluster ?? "both";
    const rt = (cl === "both" || cl === "rows") && rows.length > 2 ? hclust(m) : null;
    const ct = (cl === "both" || cl === "cols") && cols.length > 2 ? hclust(cols.map((_, j) => m.map((r) => r[j]))) : null;
    const ro = rt?.order ?? rows.map((_, i) => i), co = ct?.order ?? cols.map((_, j) => j);
    const vals = m.flat().filter(isNum);
    const [lo, hi] = vals.length ? extent(vals) : [0, 1];
    const diverging = lo < 0 && hi > 0;
    const amax = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    return { rows: ro.map((i) => rows[i]), cols: co.map((j) => cols[j]), m: ro.map((i) => co.map((j) => m[i][j])), rt: rt ? dendroLines(rt) : undefined, ct: ct ? dendroLines(ct) : undefined, lo, hi, diverging, amax };
  });
  const tone = (v: number) => (D().diverging ? v / D().amax : (v - D().lo) / (D().hi - D().lo || 1));
  const h = (): HeatIn => ({
    rows: D().rows, cols: D().cols, m: D().m, rowTree: D().rt, colTree: D().ct,
    color: (v) => (D().diverging ? div(tone(v)) : seq(tone(v))), on: (v) => (D().diverging ? onDiv(tone(v)) : onSeq(tone(v))), fmt: (v) => fix(v, Math.abs(v) < 10 ? 1 : 0),
    tip: (i, j) => `${fix(D().m[i][j])}\n${D().rows[i]} · ${D().cols[j]}`,
  });
  return (
    <Show when={D().rows.length && D().cols.length}>
      <Frame label={b.label} class="st" height={(w) => heatLayout(h(), w).h} margin={{ t: 0, r: 0, b: 0, l: 0 }} below={<ScaleKey stops={D().diverging ? DIV_STOPS : SEQ_STOPS} lo={fix(D().diverging ? -D().amax : D().lo)} hi={fix(D().diverging ? D().amax : D().hi)} title={str(b.key) || t("값")} />}>
        {(box) => <HeatGrid h={b.values === false ? { ...h(), fmt: () => "" } : h()} w={box.w} />}
      </Frame>
    </Show>
  );
}
defineViz<ClusterB>({
  type: "clustermap",
  family: "stat",
  title: "군집 히트맵 (덴드로그램)",
  when: "행·열을 비슷한 것끼리 묶어 행렬의 패턴을 찾기 (유전자 발현, 사용자군)",
  render: Clustermap,
  examples: [
    (() => {
      const genes = ["IL6", "TNF", "CXCL8", "IL1B", "CCL2", "MKI67", "TOP2A", "CDK1", "PCNA", "COL1A1", "COL3A1", "FN1"];
      const samples = ["대조 1", "대조 2", "대조 3", "LPS 1", "LPS 2", "LPS 3", "TGF-β 1", "TGF-β 2"];
      const r = rnorm(genes.length * samples.length, 0, 0.35, 501, 2);
      const eff = (g: number, s: number) => (g < 5 ? (s >= 3 && s < 6 ? 2.1 : -0.6) : g < 9 ? (s < 3 ? 0.9 : -0.5) : s >= 6 ? 2.0 : -0.7);
      return { label: "처리별 유전자 발현 (z-점수)", key: "z-점수", rows: genes, cols: samples, matrix: genes.map((_, g) => samples.map((_, s) => +(eff(g, s) + r[g * samples.length + s]).toFixed(2))) };
    })(),
  ],
});

// ───────────── Kaplan–Meier survival

interface SurvB { label?: string; x?: string; unit?: string; ci?: boolean; p?: number; risk?: boolean; series?: { label: string; times?: number[]; events?: number[]; steps?: number[][]; censor?: number[] }[] }
function Survival(b: SurvB) {
  const S = createMemo(() => arr<any>(b.series).filter((s) => s && typeof s === "object").slice(0, 6).map((s, i) => {
    const t = arr<any>(s.times);
    if (t.length) return { label: str(s.label) || `${i + 1}`, km: kaplanMeier(t, arr(s.events)), raw: true };
    // already-computed steps [[t, S]] (no CI, no at-risk counts)
    const st = arr<any>(s.steps).filter((p) => Array.isArray(p) && isNum(toNum(p[0])) && isNum(toNum(p[1]))).map((p) => ({ t: toNum(p[0]), s: toNum(p[1]), lo: toNum(p[1]), hi: toNum(p[1]) }));
    const steps = st.length && st[0].t > 0 ? [{ t: 0, s: 1, lo: 1, hi: 1 }, ...st] : st;
    const cen = nums(s.censor);
    const sAt = (x: number) => { let v = 1; for (const q of steps) if (q.t <= x) v = q.s; return v; };
    return { label: str(s.label) || `${i + 1}`, km: { steps, censored: cen.map((x) => [x, sAt(x)] as Pt), atRisk: () => NaN, median: steps.find((q) => q.s <= 0.5)?.t ?? null, end: Math.max(...steps.map((q) => q.t), ...cen, 0) }, raw: false };
  }).filter((s) => s.km.steps.length > 1));
  const end = () => Math.max(...S().map((s) => s.km.end), 1);
  const showRisk = () => b.risk !== false && S().some((s) => s.raw);
  const sAt = (steps: { t: number; s: number }[], x: number) => { let v = 1; for (const q of steps) if (q.t <= x) v = q.s; return v; };
  return (
    <Show when={S().length}>
      <Plot
        label={b.label} legend={S().length > 1 ? S().map((s, i) => ({ label: s.label, color: col(i) })) : undefined}
        x={{ domain: [0, end()], title: str(b.x) || (b.unit ? `${t("시간")} (${b.unit})` : t("시간")) }}
        y={{ domain: [0, 1], nice: false, ticks: [0, 0.25, 0.5, 0.75, 1], fmt: (v) => `${Math.round(v * 100)}%`, title: t("생존 확률") }}
        pad={{ b: showRisk() ? 24 + 17 * S().length : 0 }}
        height={(w) => clamp(Math.round(w * 0.55), 230, 360) + (showRisk() ? 24 + 17 * S().length : 0)}
      >
        {(c) => {
          const ticks = () => d3ticks(0, end(), Math.max(3, Math.floor(c.iw / 64))).filter((t) => t <= end());
          const st = (s: { km: { steps: { t: number; s: number }[] } }, k: "s" | "lo" | "hi") => [...s.km.steps.map((q: any) => [q.t, q[k]] as Pt), [end(), s.km.steps[s.km.steps.length - 1][k as "s"]] as Pt];
          const grid = () => Array.from({ length: 81 }, (_, i) => (end() * i) / 80);
          return (
            <g>
              <For each={S()}>
                {(s, k) => (
                  <g>
                    <Show when={(b.ci ?? S().length <= 2) && s.raw}>
                      <path class="st-band" style={{ fill: col(k()) }} d={bandStep(st(s, "lo"), st(s, "hi"), c)} />
                    </Show>
                    <path class="st-line" style={{ stroke: col(k()) }} d={line<Pt>().curve(curveStepAfter).x((p) => c.X(p[0])).y((p) => c.Y(p[1]))(st(s, "s")) ?? ""} />
                    <For each={s.km.censored}>{(p) => <line style={{ stroke: col(k()), "stroke-width": 1.5 }} x1={c.X(p[0])} x2={c.X(p[0])} y1={c.Y(p[1]) - 4} y2={c.Y(p[1]) + 4} />}</For>
                  </g>
                )}
              </For>
              <Show when={isNum(b.p)}><text class="st-mute" x={c.x0 + 6} y={c.y0 + c.ih - 8}>{`log-rank ${pText(b.p!)}`}</text></Show>
              <Crosshair box={c} xs={grid().map((x) => c.X(x))} read={(i) => `${withU(fix(grid()[i]), b.unit)}\n${S().map((s) => `${s.label} ${Math.round(sAt(s.km.steps, grid()[i]) * 1000) / 10}%`).join("\n")}`} dots={(i) => S().map((s, k) => ({ y: c.Y(sAt(s.km.steps, grid()[i])), color: col(k) }))} />
              <Show when={showRisk()}>
                <g class="viz-axis">
                  <text class="viz-axis-title" x={c.x0} y={c.y0 + c.ih + 56} style={{ "font-size": "11px" }}>{t("위험 대상 수")}</text>
                  <For each={S()}>
                    {(s, k) => (
                      <g>
                        <line style={{ stroke: col(k()), "stroke-width": 3, "stroke-linecap": "round" }} x1={c.x0 - 34} x2={c.x0 - 22} y1={c.y0 + c.ih + 70 + k() * 17} y2={c.y0 + c.ih + 70 + k() * 17} />
                        <For each={ticks()}>{(t) => <text x={c.X(t)} y={c.y0 + c.ih + 70 + k() * 17} dy="0.32em" text-anchor="middle" style={{ "font-size": "12px" }}>{s.raw ? s.km.atRisk(t) : ""}</text>}</For>
                      </g>
                    )}
                  </For>
                </g>
              </Show>
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
/** a stepped band between two step lines */
function bandStep(lo: Pt[], hi: Pt[], c: Ctx): string {
  const stepPts = (p: Pt[]) => p.flatMap((q, i) => (i ? [[q[0], p[i - 1][1]], q] : [q]) as Pt[]);
  const a = stepPts(hi), z = stepPts(lo).reverse();
  return `M${[...a, ...z].map((p) => `${c.X(p[0])},${c.Y(p[1])}`).join("L")}Z`;
}
defineViz<SurvB>({
  type: "survival",
  family: "stat",
  title: "카플란-마이어 생존 곡선",
  when: "시간이 지나며 사건(사망·이탈·고장)이 일어나지 않은 비율, 그룹 비교",
  render: Survival,
  examples: [
    (() => {
      const r = rng(601);
      const gen = (n: number, scale: number) => {
        const times: number[] = [], events: number[] = [];
        for (let i = 0; i < n; i++) {
          const t = -Math.log(Math.max(1e-6, r())) * scale, cens = 6 + r() * 30;
          times.push(+Math.min(t, cens, 36).toFixed(1));
          events.push(t < cens && t < 36 ? 1 : 0);
        }
        return { times, events };
      };
      return { label: "치료군별 무진행 생존", unit: "개월", x: "추적 기간 (개월)", p: 0.0031, series: [{ label: "표준 치료", ...gen(110, 14) }, { label: "병용 치료", ...gen(108, 26) }] };
    })(),
  ],
});

// ───────────── volcano and MA plots

interface OmicsItem { label?: string; x: number; y: number; p: number }
interface VolB { label?: string; x?: string; fc?: number; alpha?: number; top?: number; items?: { label?: string; x?: number; fc?: number; lfc?: number; p: number }[] }
const sigClass = (lfc: number, p: number, fc: number, alpha: number) => (p < alpha && lfc >= fc ? "up" : p < alpha && lfc <= -fc ? "down" : "ns");
const SIG_COLOR = { up: "var(--viz-div-p2)", down: "var(--viz-div-n2)", ns: "var(--viz-other)" } as const;
function Volcano(b: VolB) {
  const fc = () => (isNum(b.fc) ? Math.abs(b.fc) : 1), alpha = () => (isNum(b.alpha) ? b.alpha : 0.05);
  const items = createMemo(() => arr<any>(b.items).map((i) => ({ label: str(i?.label), x: toNum(i?.x ?? i?.lfc ?? i?.fc), p: toNum(i?.p) })).filter((i) => isNum(i.x) && i.p > 0 && i.p <= 1).map((i) => ({ ...i, y: -Math.log10(i.p) })));
  const counts = () => ({ up: items().filter((i) => sigClass(i.x, i.p, fc(), alpha()) === "up").length, down: items().filter((i) => sigClass(i.x, i.p, fc(), alpha()) === "down").length });
  const xm = () => Math.max(...items().map((i) => Math.abs(i.x)), fc() * 1.5) * 1.05;
  return (
    <Show when={items().length}>
      <Plot
        label={b.label} legend={[{ label: t("증가 {n}", { n: counts().up }), color: SIG_COLOR.up }, { label: t("감소 {n}", { n: counts().down }), color: SIG_COLOR.down }, { label: t("유의하지 않음"), color: SIG_COLOR.ns }]}
        x={{ domain: [-xm(), xm()], title: str(b.x) || t("log₂ 배수 변화") }} y={{ domain: [0, Math.max(...items().map((i) => i.y), -Math.log10(alpha())) * 1.08], title: "−log₁₀ p" }}
      >
        {(c) => <OmicsMarks c={c} items={items()} cls={(i) => sigClass(i.x, i.p, fc(), alpha())} top={b.top ?? 8} vlines={[-fc(), fc()]} hline={-Math.log10(alpha())} tipX="log₂FC" />}
      </Plot>
    </Show>
  );
}
function OmicsMarks(props: { c: Ctx; items: OmicsItem[]; cls: (i: OmicsItem) => "up" | "down" | "ns"; top: number; vlines: number[]; hline?: number; zero?: boolean; tipX: string; tipY?: string }) {
  const c = props.c;
  const pts = createMemo(() => props.items.map((i) => ({ x: c.X(i.x), y: c.Y(i.y), r: 3, k: props.cls(i), label: i.label, p: i.p, color: SIG_COLOR[props.cls(i)], tip: `${i.label ? i.label + "\n" : ""}${props.tipX} ${fix(i.x, 2)}${props.tipY ? `\n${props.tipY} ${fix(i.y, 2)}` : ""}\n${pText(i.p)}` })));
  const labelled = createMemo(() => {
    const top = uniqLabels(pts().filter((p) => p.k !== "ns" && p.label).sort((a, z) => a.p - z.p)).slice(0, clamp(props.top, 0, 30));
    const spots = placeLabels(top.map((p) => ({ x: p.x, y: p.y, w: tw(p.label!, SM) + 2, h: 14 })), { x: c.x0, y: c.y0, w: c.iw, h: c.ih }, top.map((p) => ({ x: p.x - 4, y: p.y - 4, w: 8, h: 8 })), 4);
    return top.map((p, i) => ({ p, r: spots[i] }));
  });
  return (
    <g>
      <Show when={props.zero}><line class="st-ref-solid" x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(0)} y2={c.Y(0)} /></Show>
      <For each={props.vlines}>{(v) => <Show when={props.zero} fallback={<line class="st-ref" x1={c.X(v)} x2={c.X(v)} y1={c.y0} y2={c.y0 + c.ih} />}><line class="st-ref" x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(v)} y2={c.Y(v)} /></Show>}</For>
      <Show when={props.hline !== undefined}><line class="st-ref" x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(props.hline!)} y2={c.Y(props.hline!)} /></Show>
      <For each={pts().filter((p) => p.k === "ns")}>{(p) => <circle cx={p.x} cy={p.y} r={2.2} style={{ fill: p.color, "fill-opacity": 0.6 }} />}</For>
      <For each={pts().filter((p) => p.k !== "ns")}>{(p) => <circle cx={p.x} cy={p.y} r={3} style={{ fill: p.color, stroke: "var(--viz-gap)", "stroke-width": 0.8 }} />}</For>
      <For each={labelled()}>
        {(l) => (
          <Show when={l.r}>
            <line style={{ stroke: "var(--ink-3)", "stroke-width": 0.75 }} x1={l.p.x} y1={l.p.y} x2={clamp(l.p.x, l.r!.x, l.r!.x + l.r!.w)} y2={clamp(l.p.y, l.r!.y, l.r!.y + l.r!.h)} />
            <text class="st-dl" x={l.r!.x + 1} y={l.r!.y + 11}>{l.p.label}</text>
          </Show>
        )}
      </For>
      <Nearest pts={pts()} box={c} reach={16} />
    </g>
  );
}
/** one label per name: the first (strongest) point that carries it */
const uniqLabels = <T extends { label?: string }>(a: T[]) => a.filter((p, i) => a.findIndex((q) => q.label === p.label) === i);
function genes(n: number, seed: number) {
  const r = rng(seed), z = rnorm(n, 0, 1, seed + 1, 4);
  const names = [
    "TP53", "MYC", "EGFR", "KRAS", "CDKN1A", "GADD45A", "MDM2", "BAX", "FAS", "SESN1", "PLK1", "CCNB1", "AURKA", "BUB1", "E2F1", "CDC20", "FOXM1", "HMGB2",
    "TNFRSF10B", "BBC3", "PMAIP1", "RRM2B", "XPC", "DDB2", "ZMAT3", "TIGAR", "SPATA18", "AEN", "PHLDA3", "TRIAP1", "CCNE2", "MCM2", "MCM10", "CDK1",
    "TOP2A", "MKI67", "KIF20A", "CENPF", "TPX2", "NUSAP1", "UBE2C", "BIRC5", "PTTG1", "CCNA2", "DLGAP5", "KIF2C", "HMMR", "NEK2", "ASPM", "TTK",
    "SERPINE1", "IL6", "CXCL8", "ATF3", "EGR1", "FOS", "JUN", "DUSP1", "KLF4", "HES1",
  ];
  return z.map((v, i) => {
    const de = i < 60 ? (i % 2 ? 1 : -1) * (1.2 + r() * 2.5) : v * 0.35;
    const p = i < 60 ? Math.pow(10, -(2 + r() * 14)) : Math.min(1, Math.max(1e-4, r() ** 0.8));
    return { label: i < names.length ? names[i] : `G${1000 + i}`, x: +de.toFixed(2), p: +p.toPrecision(3), mean: +(4 + r() * 10 + (i < 60 ? 1 : 0)).toFixed(2) };
  });
}
const G = genes(1400, 611);
defineViz<VolB>({
  type: "volcano",
  family: "stat",
  title: "볼케이노 플롯",
  when: "어떤 유전자(항목)가 크게, 그리고 유의하게 늘거나 줄었나",
  render: Volcano,
  examples: [{ label: "약물 처리 후 차등 발현 유전자", fc: 1, alpha: 0.01, items: G.map((g) => ({ label: g.label, x: g.x, p: g.p })) }],
});

interface MaB { label?: string; x?: string; y?: string; fc?: number; alpha?: number; top?: number; items?: { label?: string; x: number; y: number; p?: number; sig?: boolean }[] }
function MaPlot(b: MaB) {
  const fc = () => (isNum(b.fc) ? Math.abs(b.fc) : 1), alpha = () => (isNum(b.alpha) ? b.alpha : 0.05);
  const items = createMemo(() => arr<any>(b.items).map((i) => ({ label: str(i?.label), x: toNum(i?.x), y: toNum(i?.y), p: isNum(toNum(i?.p)) ? toNum(i.p) : i?.sig ? 0 : 1 })).filter((i) => isNum(i.x) && isNum(i.y)));
  const cls = (i: OmicsItem) => (i.p < alpha() && i.y >= fc() ? "up" : i.p < alpha() && i.y <= -fc() ? "down" : "ns") as "up" | "down" | "ns";
  const ym = () => Math.max(...items().map((i) => Math.abs(i.y)), fc() * 1.5) * 1.08;
  return (
    <Show when={items().length}>
      <Plot label={b.label} legend={[{ label: t("증가"), color: SIG_COLOR.up }, { label: t("감소"), color: SIG_COLOR.down }, { label: t("유의하지 않음"), color: SIG_COLOR.ns }]} x={{ domain: extent(items().map((i) => i.x), 0.03), title: str(b.x) || t("평균 발현 (log₂)") }} y={{ domain: [-ym(), ym()], title: str(b.y) || t("log₂ 배수 변화") }}>
        {(c) => <OmicsMarks c={c} items={items()} cls={cls} top={b.top ?? 6} vlines={[-fc(), fc()]} zero tipX={t("평균")} tipY="log₂FC" />}
      </Plot>
    </Show>
  );
}
defineViz<MaB>({
  type: "maplot",
  family: "stat",
  title: "MA 플롯",
  when: "발현량 수준에 따라 배수 변화가 어떻게 퍼지나 (정규화 점검)",
  render: MaPlot,
  examples: [{ label: "약물 처리 vs 대조 (MA)", alpha: 0.01, items: G.map((g) => ({ label: g.label, x: g.mean, y: g.x, p: g.p })) }],
});

// ───────────── Manhattan plot

interface ManB { label?: string; line?: number; suggest?: number; top?: number; items?: { chr: string | number; pos: number; p: number; label?: string }[] }
const chrKey = (c: string) => (/^\d+$/.test(c) ? +c : c.toUpperCase() === "X" ? 23 : c.toUpperCase() === "Y" ? 24 : /^MT?$/i.test(c) ? 25 : 26);
function Manhattan(b: ManB) {
  const D = createMemo(() => {
    const it = arr<any>(b.items).map((i) => ({ chr: str(i?.chr).replace(/^chr/i, ""), pos: toNum(i?.pos), p: toNum(i?.p), label: str(i?.label) })).filter((i) => i.chr && isNum(i.pos) && i.p > 0 && i.p <= 1);
    const chrs = [...new Set(it.map((i) => i.chr))].sort((a, z) => chrKey(a) - chrKey(z) || a.localeCompare(z));
    const span = new Map<string, [number, number]>();
    for (const i of it) { const s = span.get(i.chr) ?? [Infinity, -Infinity]; span.set(i.chr, [Math.min(s[0], i.pos), Math.max(s[1], i.pos)]); }
    const off = new Map<string, number>();
    let acc = 0;
    const gap = Math.max(...[...span.values()].map((s) => s[1] - s[0]), 1) * 0.04;
    const mids: { chr: string; x: number }[] = [];
    for (const c of chrs) { const s = span.get(c)!; off.set(c, acc - s[0]); mids.push({ chr: c, x: acc + (s[1] - s[0]) / 2 }); acc += s[1] - s[0] + gap; }
    return { pts: it.map((i) => ({ ...i, gx: i.pos + off.get(i.chr)!, y: -Math.log10(i.p), ci: chrs.indexOf(i.chr) })), mids, total: acc - gap };
  });
  const gw = () => (isNum(b.line) ? b.line : 5e-8), sg = () => (isNum(b.suggest) ? b.suggest : 1e-5);
  return (
    <Show when={D().pts.length}>
      <Plot label={b.label} x={{ domain: [0, D().total], nice: false, ticks: [], title: t("염색체") }} y={{ domain: [0, Math.max(...D().pts.map((p) => p.y), -Math.log10(gw())) * 1.08], title: "−log₁₀ p" }}>
        {(c) => {
          const pts = () => D().pts.map((p) => ({ x: c.X(p.gx), y: c.Y(p.y), r: 2.5, color: col(0), alt: p.ci % 2 === 1, hit: p.p < gw(), label: p.label, p: p.p, tip: `${p.label ? p.label + "\n" : ""}chr${p.chr}:${p.pos.toLocaleString("ko-KR")}\n${pText(p.p)}` }));
          const labs = createMemo(() => {
            const top = uniqLabels(pts().filter((p) => p.hit && p.label).sort((a, z) => a.p - z.p)).slice(0, clamp(b.top ?? 6, 0, 20));
            const spots = placeLabels(top.map((p) => ({ x: p.x, y: p.y, w: tw(p.label, SM) + 2, h: 14 })), { x: c.x0, y: c.y0, w: c.iw, h: c.ih }, [], 4);
            return top.map((p, i) => ({ p, r: spots[i] }));
          });
          const keep = () => { const out: { chr: string; x: number }[] = []; let last = -Infinity; for (const m of D().mids) { const x = c.X(m.x), w = tw(m.chr, SM); if (x - w / 2 > last + 4) { out.push(m); last = x + w / 2; } } return out; };
          return (
            <g>
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={p.hit ? 3.2 : 2.2} style={{ fill: p.hit ? "var(--viz-div-p2)" : p.alt ? "var(--viz-seq-3)" : p.color, "fill-opacity": p.hit ? 1 : 0.8 }} />}</For>
              <line class="st-ref" style={{ stroke: "var(--viz-bad)" }} x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(-Math.log10(gw()))} y2={c.Y(-Math.log10(gw()))} />
              <line class="st-ref" x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(-Math.log10(sg()))} y2={c.Y(-Math.log10(sg()))} />
              <For each={labs()}>{(l) => <Show when={l.r}><text class="st-dl" x={l.r!.x + 1} y={l.r!.y + 11}>{l.p.label}</text></Show>}</For>
              <g class="viz-axis"><For each={keep()}>{(m) => <text x={c.X(m.x)} y={c.y0 + c.ih + 17} text-anchor="middle" style={{ "font-size": "12px" }}>{m.chr}</text>}</For></g>
              <Nearest pts={pts()} box={c} reach={14} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<ManB>({
  type: "manhattan",
  family: "stat",
  title: "맨해튼 플롯 (GWAS)",
  when: "유전체 어디에 형질과 유의하게 연관된 변이가 있나",
  render: Manhattan,
  examples: [
    (() => {
      const r = rng(621);
      const lens = [248, 242, 198, 190, 181, 171, 159, 145, 138, 134, 135, 133, 114, 107, 102, 90, 83, 80, 59, 64, 47, 51];
      const items: { chr: string; pos: number; p: number; label?: string }[] = [];
      const peaks: Record<number, [number, string]> = { 2: [60, "APOB"], 6: [32, "HLA-DRB1"], 11: [116, "APOA1"], 19: [45, "APOE"] };
      lens.forEach((L, ci) => {
        const chr = ci + 1;
        for (let k = 0; k < 70; k++) {
          const pos = Math.round(r() * L * 1e6);
          let p = Math.min(1, r() ** 1.1);
          const pk = peaks[chr];
          if (pk && Math.abs(pos / 1e6 - pk[0]) < 6) p = Math.pow(10, -(3 + (6 - Math.abs(pos / 1e6 - pk[0])) * (1.4 + r())));
          items.push({ chr: String(chr), pos, p: +p.toPrecision(3), label: pk && p < 5e-8 ? pk[1] : undefined });
        }
      });
      return { label: "LDL 콜레스테롤 GWAS", items };
    })(),
  ],
});

// ───────────── dose–response

interface DoseB { label?: string; x?: string; y?: string; unit?: string; fit?: boolean; series?: { label: string; points: unknown[]; bottom?: number; top?: number; ec50?: number; hill?: number }[] }
function Dose(b: DoseB) {
  const S = createMemo(() => arr<any>(b.series).filter((s) => s && typeof s === "object").slice(0, 6).map((s, i) => {
    const pts = pointsOf(s.points).filter((p) => p.x > 0);
    const given = [s.bottom, s.top, s.ec50, s.hill].every((v) => isNum(toNum(v))) ? { bottom: +s.bottom, top: +s.top, ec50: +s.ec50, hill: +s.hill } : null;
    const fit = given ?? (b.fit === false ? null : fit4pl(pts.map((p) => [p.x, p.y])));
    return { label: str(s.label) || `${i + 1}`, pts, fit };
  }).filter((s) => s.pts.length || s.fit));
  const xd = () => logDomain(S().flatMap((s) => [...s.pts.map((p) => p.x), ...(s.fit ? [s.fit.ec50] : [])]));
  const u = () => str(b.unit);
  return (
    <Show when={S().length}>
      <Plot label={b.label} legend={S().map((s, i) => ({ label: `${s.label}${s.fit ? ` · EC₅₀ ${fix(s.fit.ec50)}${u() ? " " + u() : ""}` : ""}`, color: col(i) }))} x={{ domain: xd(), log: true, title: str(b.x) || `${t("농도")}${u() ? ` (${u()})` : ""}` }} y={{ domain: extent(S().flatMap((s) => [...s.pts.map((p) => p.y), ...(s.fit ? [s.fit.bottom, s.fit.top] : [])]), 0.06), title: str(b.y) || t("반응") }}>
        {(c) => {
          const grid = () => Array.from({ length: 100 }, (_, i) => xd()[0] * Math.pow(xd()[1] / xd()[0], i / 99));
          const pts = () => S().flatMap((s, k) => s.pts.map((p) => ({ x: c.X(p.x), y: c.Y(p.y), r: 3.5, color: col(k), tip: `${fix(p.y)} @ ${withU(fix(p.x), u())}\n${s.label}` })));
          return (
            <g>
              <For each={S()}>
                {(s, k) => (
                  <Show when={s.fit}>
                    {(f) => (
                      <g>
                        <path class="st-line" style={{ stroke: col(k()) }} d={line<number>().x((x) => c.X(x)).y((x) => c.Y(logistic4(x, f())))(grid()) ?? ""} />
                        <line class="st-ref" style={{ stroke: col(k()) }} x1={c.X(f().ec50)} x2={c.X(f().ec50)} y1={c.Y(logistic4(f().ec50, f()))} y2={c.y0 + c.ih} />
                      </g>
                    )}
                  </Show>
                )}
              </For>
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={p.r} style={{ fill: p.color, stroke: "var(--viz-gap)", "stroke-width": 1.5 }} />}</For>
              <Nearest pts={pts()} box={c} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<DoseB>({
  type: "dose",
  family: "stat",
  title: "용량-반응 곡선 (4PL)",
  when: "농도가 높아질수록 반응이 어떻게 변하나, EC₅₀(IC₅₀)는 얼마인가",
  render: Dose,
  examples: [
    (() => {
      const doses = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30];
      const e = rnorm(60, 0, 3, 631, 1);
      const mk = (ec: number, h: number, off: number) => doses.flatMap((d, i) => [0, 1, 2].map((k) => [d, +(100 - 95 / (1 + Math.pow(ec / d, h)) + e[off + i * 3 + k] * 0.8).toFixed(1)]));
      return { label: "후보 화합물 세포 생존 억제", unit: "μM", y: "세포 생존율 (%)", series: [{ label: "화합물 A", points: mk(0.12, 1.1, 0) }, { label: "화합물 B", points: mk(1.6, 1.4, 30) }] };
    })(),
  ],
});

// ───────────── parallel coordinates

interface ParB { label?: string; vars?: string[]; rows?: { label?: string; values: number[]; group?: string; em?: boolean }[] }
function Parallel(b: ParB) {
  const vars = () => arr<any>(b.vars).map(str).slice(0, 12);
  const rows = () => arr<any>(b.rows).filter((r) => r && Array.isArray(r.values)).map((r) => ({ label: str(r.label), values: vars().map((_, j) => toNum(r.values[j])), group: str(r.group), em: !!(r.em ?? r.highlight) })).slice(0, 400);
  const groups = () => [...new Set(rows().map((r) => r.group).filter(Boolean))].slice(0, 8);
  const doms = () => vars().map((_, j) => extent(rows().map((r) => r.values[j]).filter(isNum)));
  const anyEm = () => rows().some((r) => r.em);
  return (
    <Show when={vars().length >= 2 && rows().length}>
      <Frame label={b.label} class="st" legend={groups().length > 1 ? groups().map((g, i) => ({ label: g, color: col(i) })) : undefined} height={(w) => clamp(Math.round(w * 0.55), 240, 360)} margin={{ t: 0, r: 0, b: 0, l: 0 }}>
        {(box) => {
          const L = () => {
            const n = vars().length;
            const ends = Math.max(tw(vars()[0], 12.5), tw(vars()[n - 1], 12.5), tw(fix(doms()[0][1]), SM), tw(fix(doms()[n - 1][1]), SM));
            const pad = clamp(ends / 2 + 4, 24, box.w * 0.14);
            const step = (box.w - pad * 2) / (n - 1);
            // names that don't fit side by side go on two staggered rows
            const two = vars().some((v) => tw(v, 12.5) > step - 8);
            const max = (j: number) => Math.min(two ? step * 2 - 10 : step - 8, j === 0 || j === n - 1 ? pad * 2 - 4 : Infinity);
            return { n, pad, step, two, max, top: two ? 56 : 40, bot: box.h - 24 };
          };
          const X = (j: number) => L().pad + j * L().step;
          const Y = (j: number, v: number) => L().bot - ((v - doms()[j][0]) / (doms()[j][1] - doms()[j][0] || 1)) * (L().bot - L().top);
          const tip = useTip();
          return (
            <g>
              <For each={rows()}>
                {(r) => {
                  const d = () => r.values.map((v, j) => (isNum(v) ? `${X(j)},${Y(j, v)}` : null)).filter(Boolean).join("L");
                  const color = () => (anyEm() && !r.em ? "var(--viz-other)" : col(Math.max(0, groups().indexOf(r.group))));
                  return <path class="viz-mark st-thin" d={`M${d()}`} style={{ stroke: color(), "stroke-opacity": anyEm() && !r.em ? 0.45 : rows().length > 60 ? 0.35 : 0.75, "stroke-width": r.em ? 2.5 : 1.25 }} onMouseMove={(e) => tip.show(e, `${r.label || r.group || ""}\n${vars().map((v, j) => `${v} ${fix(r.values[j])}`).join("\n")}`)} onMouseLeave={tip.hide} />;
                }}
              </For>
              <For each={vars()}>
                {(v, j) => (
                  <g>
                    <line class="st-axisline" x1={X(j())} x2={X(j())} y1={L().top} y2={L().bot} />
                    <text class="st-strong" x={X(j())} y={L().two && j() % 2 ? 30 : 14} text-anchor="middle" style={{ "font-size": "12.5px" }}><title>{v}</title>{ell(v, L().max(j()), 12.5)}</text>
                    <text class="st-mute" x={X(j())} y={L().top - 6} text-anchor="middle">{fix(doms()[j()][1])}</text>
                    <text class="st-mute" x={X(j())} y={L().bot + 15} text-anchor="middle">{fix(doms()[j()][0])}</text>
                  </g>
                )}
              </For>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}
defineViz<ParB>({
  type: "parallel",
  family: "stat",
  title: "평행 좌표 그림",
  when: "여러 지표를 동시에 놓고 항목·그룹의 프로필을 비교",
  render: Parallel,
  examples: [
    (() => {
      const cars = [["경차", 72, 1.0, 16.8, 950, 1500], ["준중형", 123, 1.6, 14.2, 1290, 2300], ["중형", 160, 2.0, 12.6, 1500, 3100], ["대형", 290, 3.3, 9.4, 1800, 4800], ["SUV", 202, 2.2, 11.3, 1850, 3900], ["전기", 204, 0, 5.4, 1900, 4600]] as const;
      const e = rnorm(120, 0, 1, 641, 3);
      return {
        label: "차급별 자동차 사양", vars: ["출력 (마력)", "배기량 (L)", "복합 연비 (km/L)", "공차 중량 (kg)", "가격 (만 원)"],
        rows: Array.from({ length: 36 }, (_, i) => { const c = cars[i % 6]; return { group: c[0], values: [c[1] * (1 + e[i] * 0.08), c[2] ? c[2] * (1 + e[i + 36] * 0.06) : 0, c[3] * (1 + e[i + 72] * 0.07), c[4] * (1 + e[i + 1] * 0.05), c[5] * (1 + e[i + 2] * 0.1)].map((v) => +v.toFixed(1)) }; }).filter((r) => ["경차", "중형", "SUV"].includes(r.group)),
      };
    })(),
  ],
});

// ───────────── ternary

interface TerB { label?: string; vars?: string[]; points?: unknown[]; series?: { label: string; points: unknown[] }[] }
function Ternary(b: TerB) {
  const names = () => { const v = arr<any>(b.vars).map(str); return [v[0] || "A", v[1] || "B", v[2] || "C"]; };
  const parse = (v: unknown) => arr<any>(v).map((p) => (Array.isArray(p) ? { a: toNum(p[0]), b: toNum(p[1]), c: toNum(p[2]), label: str(p[3]) } : { a: toNum(p?.a), b: toNum(p?.b), c: toNum(p?.c), label: str(p?.label) })).map((p) => ({ ...p, xy: ternary(p.a, p.b, p.c) })).filter((p) => p.xy);
  const S = () => (arr(b.series).length ? arr<any>(b.series).map((s, i) => ({ label: str(s?.label) || `${i + 1}`, pts: parse(s?.points) })) : [{ label: "", pts: parse(b.points) }]).filter((s) => s.pts.length).slice(0, 6);
  return (
    <Show when={S().length}>
      <Frame label={b.label} class="st" legend={S().length > 1 ? S().map((s, i) => ({ label: s.label, color: col(i) })) : undefined} height={(w) => Math.min(Math.round((Math.min(w, 520) - 60) * 0.87) + 64, 520)} margin={{ t: 0, r: 0, b: 0, l: 0 }}>
        {(box) => {
          const side = () => Math.min(box.w - 60, (box.h - 64) / 0.866);
          const ox = () => (box.w - side()) / 2, oy = () => 26 + side() * 0.866;
          const P = (xy: Pt) => [ox() + xy[0] * side(), oy() - xy[1] * side()] as Pt;
          const tri = () => [P([0, 0]), P([1, 0]), P([0.5, 0.866])];
          const grid = [0.2, 0.4, 0.6, 0.8];
          const pts = () => S().flatMap((s, k) => s.pts.map((p) => { const [x, y] = P(p.xy!); const t = p.a + p.b + p.c; return { x, y, r: 4, color: col(k), tip: `${p.label ? p.label + "\n" : ""}${names()[0]} ${Math.round((p.a / t) * 100)}% · ${names()[1]} ${Math.round((p.b / t) * 100)}% · ${names()[2]} ${Math.round((p.c / t) * 100)}%` }; }));
          const ln = (a: [number, number, number], z: [number, number, number]) => { const p = P(ternary(...a)!), q = P(ternary(...z)!); return { x1: p[0], y1: p[1], x2: q[0], y2: q[1] }; };
          return (
            <g>
              <For each={grid}>
                {(g) => (
                  <g>
                    <line class="st-tri-grid" {...ln([g, 1 - g, 0], [g, 0, 1 - g])} />
                    <line class="st-tri-grid" {...ln([1 - g, g, 0], [0, g, 1 - g])} />
                    <line class="st-tri-grid" {...ln([1 - g, 0, g], [0, 1 - g, g])} />
                    <text class="st-mute" x={P(ternary(g, 0, 1 - g)!)[0] + 5} y={P(ternary(g, 0, 1 - g)!)[1]} dy="0.32em" style={{ "font-size": "11px" }}>{Math.round(g * 100)}</text>
                    <text class="st-mute" x={P(ternary(1 - g, g, 0)!)[0] - 5} y={P(ternary(1 - g, g, 0)!)[1]} dy="0.32em" text-anchor="end" style={{ "font-size": "11px" }}>{Math.round(g * 100)}</text>
                    <text class="st-mute" x={P(ternary(0, 1 - g, g)!)[0]} y={oy() + 14} text-anchor="middle" style={{ "font-size": "11px" }}>{Math.round(g * 100)}</text>
                  </g>
                )}
              </For>
              <path class="st-axisline" d={`M${tri().map((p) => p.join(",")).join("L")}Z`} />
              <text class="st-strong" x={tri()[2][0]} y={tri()[2][1] - 9} text-anchor="middle" style={{ "font-size": "12.5px" }}>{ell(names()[0], box.w * 0.5, 12.5)}</text>
              <text class="st-strong" x={tri()[0][0] - 4} y={oy() + 30} text-anchor="start" style={{ "font-size": "12.5px" }}>{ell(names()[1], side() * 0.45, 12.5)}</text>
              <text class="st-strong" x={tri()[1][0] + 4} y={oy() + 30} text-anchor="end" style={{ "font-size": "12.5px" }}>{ell(names()[2], side() * 0.45, 12.5)}</text>
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={p.r} style={{ fill: p.color, "fill-opacity": 0.8, stroke: "var(--viz-gap)", "stroke-width": 1.5 }} />}</For>
              <Nearest pts={pts()} box={{ x0: 0, y0: 0, iw: box.w, ih: box.h }} />
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}
defineViz<TerB>({
  type: "ternary",
  family: "stat",
  title: "삼각 그림 (3성분 구성비)",
  when: "세 성분의 비율(합 100%)로 이루어진 항목이 어디에 놓이나",
  render: Ternary,
  examples: [
    (() => {
      const r = rng(651);
      const mk = (a: number, b2: number, c: number, n: number) => Array.from({ length: n }, () => { const x = a + (r() - 0.5) * 18, y = b2 + (r() - 0.5) * 18; return [+Math.max(1, x).toFixed(0), +Math.max(1, y).toFixed(0), +Math.max(1, 100 - x - y + c * 0).toFixed(0)]; });
      return { label: "토양 시료의 입자 구성", vars: ["점토", "모래", "미사"], series: [{ label: "논", points: mk(42, 18, 0, 14) }, { label: "밭", points: mk(18, 52, 0, 14) }, { label: "산지", points: mk(15, 28, 0, 12) }] };
    })(),
  ],
});

// ───────────── Likert diverging stacked bars

interface LikB { label?: string; levels?: string[]; items?: { label: string; values: number[] }[]; sort?: boolean }
function Likert(b: LikB) {
  const levels = () => arr<any>(b.levels).map(str).filter(Boolean).slice(0, 7);
  const K = () => levels().length;
  const items = () => {
    const it = arr<any>(b.items).filter((i) => i && Array.isArray(i.values)).map((i) => ({ label: str(i.label), segs: likert(i.values, K()) }));
    if (b.sort) it.sort((a, z) => agree(z.segs) - agree(a.segs));
    return it;
  };
  const mid = () => (K() - 1) / 2;
  const agree = (s: { pct: number }[]) => sum(s.filter((_, i) => i > mid()).map((x) => x.pct));
  const disagree = (s: { pct: number }[]) => sum(s.filter((_, i) => i < mid()).map((x) => x.pct));
  // disagree side warm, agree side cool, neutral grey
  const tOf = (i: number) => (mid() ? -(i - mid()) / mid() : 0);
  const fill = (i: number) => div(tOf(i));
  const ext = () => Math.max(50, ...items().flatMap((i) => [-i.segs[0]?.lo, i.segs[i.segs.length - 1]?.hi]).filter(isNum));
  return (
    <Show when={K() >= 2 && items().length}>
      <RowPlot label={b.label} legend={levels().map((l, i) => ({ label: l, color: fill(i) }))} rows={items().map((i) => i.label)} labelMax={0.3} rowH={(w) => (w < 480 ? 30 : 34)} x={{ domain: [-ext(), ext()], fmt: (v) => `${Math.abs(Math.round(v))}%` }} pad={(w) => ({ l: w > 460 ? 34 : 30, r: w > 460 ? 34 : 30 })}>
        {(c) => (
          <g>
            <For each={items()}>
              {(it, r) => {
                const h = () => Math.min(22, c.band * 0.68);
                const y = () => c.rowY(r()) - h() / 2;
                return (
                  <g>
                    <For each={it.segs}>
                      {(s, i) => (
                        <Tip tip={`${fix(s.pct, 1)}%\n${levels()[i()]}\n${it.label}`}>
                          <rect x={c.X(s.lo) + (s.pct > 0 ? 1 : 0)} y={y()} width={Math.max(0, c.X(s.hi) - c.X(s.lo) - (s.pct > 0 ? 2 : 0))} height={h()} style={{ fill: fill(i()) }} />
                          <Show when={c.X(s.hi) - c.X(s.lo) > tw(`${Math.round(s.pct)}`, SM) + 8 && h() >= 16}>
                            <text class={`st-cell-v ${onDiv(tOf(i()))}`} x={(c.X(s.lo) + c.X(s.hi)) / 2} y={c.rowY(r())} dy="0.35em" text-anchor="middle">{Math.round(s.pct)}</text>
                          </Show>
                        </Tip>
                      )}
                    </For>
                    <text class="st-dl" x={c.X(it.segs[0].lo) - 5} y={c.rowY(r())} dy="0.32em" text-anchor="end">{`${Math.round(disagree(it.segs))}%`}</text>
                    <text class="st-dl" x={c.X(it.segs[it.segs.length - 1].hi) + 5} y={c.rowY(r())} dy="0.32em">{`${Math.round(agree(it.segs))}%`}</text>
                  </g>
                );
              }}
            </For>
            <line style={{ stroke: "var(--ink-2)", "stroke-width": 1 }} x1={c.X(0)} x2={c.X(0)} y1={c.y0 - 2} y2={c.y0 + c.ih} />
          </g>
        )}
      </RowPlot>
    </Show>
  );
}
defineViz<LikB>({
  type: "likert",
  family: "stat",
  title: "리커트 척도 (발산형 누적 막대)",
  when: "설문 문항별 동의·비동의가 어느 쪽으로 얼마나 기울었나",
  render: Likert,
  examples: [
    {
      label: "사내 도구 만족도 설문 (n = 312)", sort: true, levels: ["전혀 아니다", "아니다", "보통", "그렇다", "매우 그렇다"],
      items: [{ label: "배포가 빠르다", values: [12, 31, 64, 128, 77] }, { label: "문서를 찾기 쉽다", values: [48, 92, 81, 66, 25] }, { label: "장애 알림이 적절하다", values: [21, 45, 98, 104, 44] }, { label: "코드 리뷰가 도움이 된다", values: [6, 14, 41, 139, 112] }, { label: "온보딩 자료가 충분하다", values: [39, 77, 102, 71, 23] }],
    },
  ],
});

// ───────────── SPC control chart

interface SpcB { label?: string; unit?: string; y?: string; x?: string; values?: number[]; labels?: string[]; center?: number; ucl?: number; lcl?: number }
function Control(b: SpcB) {
  const v = () => arr<any>(b.values).map(toNum);
  const L = createMemo(() => spc(v(), { center: b.center, ucl: b.ucl, lcl: b.lcl }));
  const labs = () => arr<any>(b.labels).map(str);
  const anyOut = () => L().out.some(Boolean), anyRun = () => L().run.some((r, i) => r && !L().out[i]);
  return (
    <Show when={v().filter(isNum).length > 1}>
      <Plot
        label={b.label}
        legend={[{ label: t("측정값"), color: col(0) }, ...(anyOut() ? [{ label: t("관리 한계 이탈"), color: status.bad }] : []), ...(anyRun() ? [{ label: t("8점 연속 한쪽"), color: status.warn }] : [])]}
        x={{ domain: [0.5, v().length + 0.5], nice: false, ticks: v().map((_, i) => i + 1), fmt: (x) => labs()[Math.round(x) - 1] || String(Math.round(x)), title: str(b.x) || undefined }}
        y={{ domain: extent([...v().filter(isNum), L().ucl, L().lcl], 0.08), title: str(b.y) || (b.unit ? `(${b.unit})` : undefined) }}
        pad={(w) => ({ r: w > 460 ? 58 : 0 })}
      >
        {(c) => {
          const lines = () => [{ v: L().ucl, n: "UCL", dash: true }, { v: L().center, n: "CL", dash: false }, { v: L().lcl, n: "LCL", dash: true }];
          const pts = () => v().map((y, i) => (isNum(y) ? { x: c.X(i + 1), y: c.Y(y), r: L().out[i] ? 5 : L().run[i] ? 4.5 : 3, color: L().out[i] ? status.bad : L().run[i] ? status.warn : col(0), tip: `${withU(fix(y), b.unit)}\n${labs()[i] || `#${i + 1}`}${L().out[i] ? `\n${t("관리 한계 이탈")}` : L().run[i] ? `\n${t("8점 연속 한쪽")}` : ""}` } : null)).filter((p): p is NonNullable<typeof p> => !!p);
          const wide = () => c.w > 460;
          return (
            <g>
              <For each={lines()}>{(l) => <line class={l.dash ? "st-ref" : "st-ref-solid"} style={l.dash ? { stroke: status.bad } : { stroke: "var(--ink-3)" }} x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(l.v)} y2={c.Y(l.v)} />}</For>
              <path class="st-thin" style={{ stroke: col(0), "stroke-width": 1.5 }} d={pts().map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join("")} />
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={p.r} style={{ fill: p.color, stroke: "var(--viz-gap)", "stroke-width": 1.5 }} />}</For>
              <For each={lines()}>
                {(l) => (
                  <g>
                    <Show when={wide()} fallback={<text class="st-dl" x={c.x0 + c.iw - 2} y={c.Y(l.v) + (l.n === "LCL" ? 13 : -4)} text-anchor="end">{`${l.n} ${fix(l.v)}`}</text>}>
                      <text class="st-dl" x={c.x0 + c.iw + 6} y={c.Y(l.v)} dy="0.32em">{`${l.n} ${fix(l.v)}`}</text>
                    </Show>
                  </g>
                )}
              </For>
              <Nearest pts={pts()} box={c} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<SpcB>({
  type: "spc",
  family: "stat",
  title: "관리도 (SPC)",
  when: "공정이 안정적인가, 관리 한계를 벗어난 점이나 이상 패턴이 있나",
  render: Control,
  examples: [
    { label: "충전 라인 용량 (I 관리도)", unit: "mL", y: "충전량 (mL)", x: "로트", values: [500.2, 499.8, 500.5, 500.1, 499.6, 500.3, 500.0, 499.9, 500.4, 501.9, 500.2, 499.7, 500.6, 500.5, 500.7, 500.4, 500.8, 500.6, 500.9, 500.5, 500.7, 500.3, 498.4, 500.1] },
  ],
});
