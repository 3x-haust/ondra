// Distributions: how values spread, per group.
//   histogram · density · ridgeline · box · violin · strip · beeswarm · raincloud · ecdf · qq
import { area, curveBasis, curveStepAfter, line } from "d3-shape";
import { createMemo, For, Show, type JSX } from "solid-js";
import { defineViz } from "../registry";
import {
  arr, Cell, col, ColPlot, Crosshair, fix, groupsOf, Nearest, nums, Plot, RefLines, refsOf, RowPlot, str, Tip, tw, withU, type Ctx,
} from "./common";
import { boxStats, clamp, ecdf, extent, histogram, jitter, kde, kdeRange, qq, swarm, thresholds, type BoxStats, type Pt } from "./math";
import { rlognorm, rnorm } from "./sample";
import { t } from "../../../i18n";

type G = { label: string; values: number[]; em?: boolean };
const legendOf = (gs: G[]) => gs.map((g, i) => ({ label: g.label, color: col(i) }));
const title = (b: any): string | undefined => str(b.x) || str(b.y) || str(b.axis) || undefined;

// ───────────── histogram

interface HistB { label?: string; unit?: string; x?: string; y?: string; values?: number[]; series?: { label: string; values: number[] }[]; bins?: number | { x0: number; x1: number; n: number }[]; density?: boolean; refs?: { x: number; label?: string }[] }
function Histogram(b: HistB) {
  const gs = () => groupsOf(b).slice(0, 3).filter((g) => g.values.length);
  const pre = () => (Array.isArray(b.bins) ? arr<any>(b.bins).filter((x) => Number.isFinite(x?.x0) && Number.isFinite(x?.x1) && x.x1 > x.x0).map((x) => ({ x0: +x.x0, x1: +x.x1, n: Number(x.n ?? x.count) || 0 })) : null);
  const data = createMemo(() => {
    const p = pre();
    if (p?.length) return { th: [p[0].x0, ...p.map((x) => x.x1)], hs: [p], names: [str(b.label)] };
    const all = gs().flatMap((g) => g.values);
    const th = thresholds(all, typeof b.bins === "number" ? b.bins : undefined);
    return { th, hs: gs().map((g) => histogram(g.values, th)), names: gs().map((g) => g.label) };
  });
  const yv = (h: { n: number; x0: number; x1: number }, total: number) => (b.density ? h.n / (total * (h.x1 - h.x0) || 1) : h.n);
  const totals = () => data().hs.map((h) => h.reduce((s, x) => s + x.n, 0));
  const ymax = () => Math.max(1e-9, ...data().hs.flatMap((h, k) => h.map((x) => yv(x, totals()[k]))));
  const many = () => data().hs.length > 1;
  return (
    <Show when={data().th.length > 1}>
      <Plot
        label={b.label} legend={many() ? data().names.map((n, i) => ({ label: n, color: col(i) })) : undefined}
        x={{ domain: [data().th[0], data().th[data().th.length - 1]], nice: false, title: b.x ?? (b.unit ? `(${b.unit})` : undefined) }}
        y={{ domain: [0, ymax() * 1.05], title: b.y ?? (b.density ? t("밀도") : t("빈도")) }}
      >
        {(c) => (
          <g>
            <For each={data().hs}>
              {(h, k) => (
                <Show
                  when={many()}
                  fallback={<For each={h}>{(x) => <Cell x={c.X(x.x0) + 1} y={c.Y(yv(x, totals()[k()]))} w={c.X(x.x1) - c.X(x.x0) - 2} h={c.Y(0) - c.Y(yv(x, totals()[k()]))} fill={col(0)} rx={1} tip={`${fix(yv(x, totals()[k()]))}\n${withU(`${fix(x.x0)}–${fix(x.x1)}`, b.unit)}`} />}</For>}
                >
                  <path class="st-band" style={{ fill: col(k()), "fill-opacity": 0.22 }} d={stepPath(h.map((x) => [c.X(x.x0), c.X(x.x1), c.Y(yv(x, totals()[k()]))]), c.Y(0), true)} />
                  <path class="st-thin" style={{ stroke: col(k()), "stroke-width": 1.5 }} d={stepPath(h.map((x) => [c.X(x.x0), c.X(x.x1), c.Y(yv(x, totals()[k()]))]), c.Y(0), false)} />
                </Show>
              )}
            </For>
            <Show when={many()}>
              <For each={data().hs[0]}>
                {(x, i) => (
                  <Tip tip={`${withU(`${fix(x.x0)}–${fix(x.x1)}`, b.unit)}\n${data().hs.map((h, k) => `${data().names[k]} ${fix(yv(h[i()], totals()[k]))}`).join("\n")}`}>
                    <rect x={c.X(x.x0)} y={c.y0} width={Math.max(0, c.X(x.x1) - c.X(x.x0))} height={c.ih} fill="transparent" />
                  </Tip>
                )}
              </For>
            </Show>
            <RefLines refs={refsOf(b.refs)} c={c} />
          </g>
        )}
      </Plot>
    </Show>
  );
}
/** a stepped outline over bins [x0, x1, y] (closed to the baseline when `fill`) */
function stepPath(bins: [number, number, number][], base: number, fill: boolean): string {
  if (!bins.length) return "";
  let d = `M${bins[0][0]},${base}`;
  for (const [x0, x1, y] of bins) d += `L${x0},${y}L${x1},${y}`;
  d += `L${bins[bins.length - 1][1]},${base}`;
  return fill ? d + "Z" : d;
}

defineViz<HistB>({
  type: "histogram",
  family: "stat",
  title: "히스토그램",
  when: "값이 어느 구간에 몰려 있나, 두세 그룹의 분포가 어떻게 다른가",
  render: Histogram,
  examples: [
    { label: "API 응답 시간 분포", unit: "ms", x: "응답 시간 (ms)", values: rlognorm(400, Math.log(180), 0.35, 7), refs: [{ x: 300, label: "SLO 300ms" }] },
    { label: "배포 전후 응답 시간", unit: "ms", x: "응답 시간 (ms)", series: [{ label: "배포 전", values: rnorm(300, 240, 45, 3, 0) }, { label: "배포 후", values: rnorm(300, 185, 35, 4, 0) }] },
  ],
});

// ───────────── density

interface DensB { label?: string; unit?: string; x?: string; values?: number[]; series?: { label: string; values: number[] }[]; bw?: number; rug?: boolean; refs?: { x: number; label?: string }[] }
function Density(b: DensB) {
  const gs = () => groupsOf(b).slice(0, 6).filter((g) => g.values.length > 1);
  const D = createMemo(() => {
    const all = gs().flatMap((g) => g.values);
    const [lo, hi] = gs().length ? gs().map((g) => kdeRange(g.values, b.bw)).reduce((a, r) => [Math.min(a[0], r[0]), Math.max(a[1], r[1])], [Infinity, -Infinity]) : [0, 1];
    const curves = gs().map((g) => kde(g.values, lo, hi, b.bw, 100));
    const ymax = Math.max(1e-9, ...curves.flat().map((p) => p[1]));
    return { lo, hi, curves, ymax, n: all.length };
  });
  return (
    <Show when={gs().length}>
      <Plot label={b.label} legend={gs().length > 1 ? legendOf(gs()) : undefined} x={{ domain: [D().lo, D().hi], title: b.x ?? (b.unit ? `(${b.unit})` : undefined) }} y={{ domain: [0, D().ymax * 1.08], title: t("밀도"), fmt: (v) => fix(v) }}>
        {(c) => (
          <g>
            <For each={D().curves}>
              {(cv, k) => (
                <g>
                  <path class="st-area" style={{ fill: col(k()), "fill-opacity": gs().length > 2 ? 0.07 : 0.12 }} d={area<Pt>().x((p) => c.X(p[0])).y0(c.Y(0)).y1((p) => c.Y(p[1]))(cv) ?? ""} />
                  <path class="st-line" style={{ stroke: col(k()) }} d={line<Pt>().x((p) => c.X(p[0])).y((p) => c.Y(p[1]))(cv) ?? ""} />
                </g>
              )}
            </For>
            <Show when={(b.rug ?? true) && gs().length === 1 && gs()[0].values.length <= 300}>
              <For each={gs()[0].values}>{(v) => <line class="st-ref-solid" style={{ stroke: col(0), opacity: 0.5 }} x1={c.X(v)} x2={c.X(v)} y1={c.Y(0)} y2={c.Y(0) - 6} />}</For>
            </Show>
            <RefLines refs={refsOf(b.refs)} c={c} />
            <Crosshair
              box={c} xs={D().curves[0]?.map((p) => c.X(p[0])) ?? []}
              read={(i) => `${withU(fix(D().curves[0][i][0]), b.unit)}\n${gs().map((g, k) => `${g.label ? g.label + " " : ""}${fix(D().curves[k][i][1])}`).join("\n")}`}
              dots={(i) => D().curves.map((cv, k) => ({ y: c.Y(cv[i]?.[1] ?? 0), color: col(k) }))}
            />
          </g>
        )}
      </Plot>
    </Show>
  );
}
defineViz<DensB>({
  type: "density",
  family: "stat",
  title: "밀도 곡선 (KDE)",
  when: "연속값의 분포 모양을 매끈하게, 여러 그룹을 겹쳐 비교",
  render: Density,
  examples: [
    { label: "모델별 예측 오차", x: "오차 (원)", series: [{ label: "선형 회귀", values: rnorm(250, 0, 1200, 11, 0) }, { label: "그래디언트 부스팅", values: rnorm(250, 150, 650, 12, 0) }, { label: "신경망", values: rnorm(250, -80, 820, 13, 0) }] },
  ],
});

// ───────────── ridgeline

interface RidgeB { label?: string; unit?: string; x?: string; series?: { label: string; values: number[]; em?: boolean }[]; bw?: number }
function Ridgeline(b: RidgeB) {
  const gs = () => groupsOf(b).filter((g) => g.values.length > 1).slice(0, 30);
  const D = createMemo(() => {
    const rs = gs().map((g) => kdeRange(g.values, b.bw));
    const lo = Math.min(...rs.map((r) => r[0])), hi = Math.max(...rs.map((r) => r[1]));
    const curves = gs().map((g) => kde(g.values, lo, hi, b.bw, 90));
    return { lo, hi, curves, ymax: Math.max(1e-9, ...curves.flat().map((p) => p[1])) };
  });
  const anyEm = () => gs().some((g) => g.em);
  const rowH = (w: number) => (w < 480 ? 26 : 30);
  return (
    <Show when={gs().length}>
      <RowPlot label={b.label} rows={gs().map((g) => g.label)} rowH={rowH} pad={{ t: 22 }} x={{ domain: [D().lo, D().hi], title: b.x ?? (b.unit ? `(${b.unit})` : undefined) }}>
        {(c) => (
          <g>
            <For each={D().curves}>
              {(cv, i) => {
                const base = () => c.rowY(i()) + c.band * 0.45;
                const amp = () => c.band * 1.7;
                const d = () => area<Pt>().curve(curveBasis).x((p) => c.X(p[0])).y0(base()).y1((p) => base() - (p[1] / D().ymax) * amp())(cv) ?? "";
                const ln = () => line<Pt>().curve(curveBasis).x((p) => c.X(p[0])).y((p) => base() - (p[1] / D().ymax) * amp())(cv) ?? "";
                const g = () => gs()[i()];
                const st = () => boxStats(g().values)!;
                const on = () => !anyEm() || g().em;
                return (
                  <Tip tip={`${g().label}\n${t("중앙값 {v}", { v: withU(fix(st().median), b.unit) })}\nn = ${st().n}`}>
                    <path d={d()} style={{ fill: "var(--viz-gap)" }} />
                    <path d={d()} style={{ fill: on() ? col(0) : "var(--viz-other)", "fill-opacity": on() ? 0.22 : 0.18 }} />
                    <path class="st-thin" d={ln()} style={{ stroke: on() ? col(0) : "var(--viz-other)", "stroke-width": 1.5 }} />
                    <line class="st-ref-solid" x1={c.x0} x2={c.x0 + c.iw} y1={base()} y2={base()} />
                  </Tip>
                );
              }}
            </For>
          </g>
        )}
      </RowPlot>
    </Show>
  );
}
defineViz<RidgeB>({
  type: "ridgeline",
  family: "stat",
  title: "능선 그래프 (리지라인)",
  when: "여러 그룹(월·지역·버전)의 분포가 어떻게 이동하나",
  render: Ridgeline,
  examples: [
    {
      label: "월별 일 최고기온 (서울)", x: "기온 (°C)",
      series: ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"].map((m, i) => ({ label: m, values: rnorm(31, [2, 5, 11, 18, 24, 28, 30, 31, 27, 20, 12, 4][i], [3.2, 3.5, 4, 3.8, 3, 2.4, 2.2, 2.3, 2.6, 3.4, 4, 3.6][i], 100 + i) })),
    },
  ],
});

// ───────────── group plots: box · violin · strip · beeswarm

type Geo = { horiz: boolean; pv: (v: number) => number; pc: (i: number) => number; band: number; xy: (pv: number, pc: number) => [number, number]; c: Ctx };
type GroupIn = { label: string; values: number[]; stats?: BoxStats; em?: boolean; note?: string };

/** groups from raw values or from given quartiles (box only) */
function groupsWithStats(b: any): GroupIn[] {
  const src = arr<any>(b.series).length ? arr<any>(b.series) : arr<any>(b.groups).length ? arr<any>(b.groups) : arr<any>(b.items);
  const raw = src.length ? src : nums(b.values).length ? [{ label: "", values: b.values }] : [];
  return raw.filter((g) => g && typeof g === "object").map((g, i) => {
    const values = nums(g.values);
    let stats = values.length ? boxStats(values) ?? undefined : undefined;
    if (!stats && [g.q1, g.median, g.q3].every(Number.isFinite)) {
      const lo = Number.isFinite(g.min) ? g.min : g.q1, hi = Number.isFinite(g.max) ? g.max : g.q3;
      stats = { n: Number(g.n) || 0, min: lo, max: hi, q1: g.q1, median: g.median, q3: g.q3, lo, hi, mean: Number.isFinite(g.mean) ? g.mean : NaN, outliers: nums(g.outliers) };
    }
    return { label: str(g.label) || `${i + 1}`, values, stats, em: !!(g.em ?? g.highlight), note: str(g.note) || undefined };
  }).filter((g) => g.stats);
}
function horizOf(b: any, labels: string[]): boolean {
  if (b.dir === "h" || b.horizontal === true) return true;
  if (b.dir === "v" || b.horizontal === false) return false;
  return labels.length > 6 || labels.some((l) => tw(l) > 80);
}
/** frames groups along one axis and values along the other */
function Groups(props: { b: any; gs: GroupIn[]; domain: [number, number]; rowH?: number; colH?: (w: number) => number; children: (g: Geo) => JSX.Element; legend?: { label: string; color: string }[] }) {
  const labels = () => props.gs.map((g) => g.label);
  const horiz = () => horizOf(props.b, labels());
  const t = () => title(props.b) ?? (props.b.unit ? `(${props.b.unit})` : undefined);
  return (
    <Show
      when={horiz()}
      fallback={
        <ColPlot label={props.b.label} legend={props.legend} cats={labels()} y={{ domain: props.domain, title: t() }} height={props.colH}>
          {(c) => props.children({ horiz: false, pv: (v) => c.Y(v), pc: (i) => c.colX(i), band: c.band, xy: (v, p) => [p, v], c })}
        </ColPlot>
      }
    >
      <RowPlot label={props.b.label} legend={props.legend} rows={labels()} rowH={props.rowH ?? 40} x={{ domain: props.domain, title: t() }} sub={(i) => props.gs[i].note}>
        {(c) => props.children({ horiz: true, pv: (v) => c.X(v), pc: (i) => c.rowY(i), band: c.band, xy: (v, p) => [v, p], c })}
      </RowPlot>
    </Show>
  );
}
const rectOf = (g: Geo, v0: number, v1: number, c0: number, c1: number) => {
  const [xa, ya] = g.xy(g.pv(v0), c0), [xb, yb] = g.xy(g.pv(v1), c1);
  return { x: Math.min(xa, xb), y: Math.min(ya, yb), w: Math.abs(xb - xa), h: Math.abs(yb - ya) };
};
const seg = (g: Geo, v0: number, v1: number, c0: number, c1: number) => {
  const [x1, y1] = g.xy(v0, c0), [x2, y2] = g.xy(v1, c1);
  return { x1, y1, x2, y2 };
};
const domainOf = (gs: GroupIn[], pad = 0.06): [number, number] => extent(gs.flatMap((g) => [g.stats!.min, g.stats!.max, ...g.values, ...g.stats!.outliers].filter(Number.isFinite)), pad);
const colorFor = (gs: GroupIn[], i: number) => (gs.some((g) => g.em) && !gs[i].em ? "var(--viz-other)" : col(0));
const boxTip = (g: GroupIn, unit?: string) => {
  const s = g.stats!;
  return `${g.label}\n${t("중앙값 {v}", { v: withU(fix(s.median), unit) })}\nQ1–Q3 ${fix(s.q1)}–${fix(s.q3)}\n${t("수염 {v}", { v: `${fix(s.lo)}–${fix(s.hi)}` })}${Number.isFinite(s.mean) ? `\n${t("평균 {v}", { v: fix(s.mean) })}` : ""}${s.n ? `\nn = ${s.n}` : ""}${s.outliers.length ? `\n${t("이상치 {n}개", { n: s.outliers.length })}` : ""}`;
};

/** one box: whiskers, IQR box, median, outliers */
function BoxMark(p: { g: Geo; i: number; s: BoxStats; color: string; half: number; tip: string; mean?: boolean; outliers?: boolean }) {
  const c = () => p.g.pc(p.i);
  return (
    <Tip tip={p.tip}>
      <line class="st-whisker" style={{ stroke: p.color }} {...seg(p.g, p.g.pv(p.s.lo), p.g.pv(p.s.q1), c(), c())} />
      <line class="st-whisker" style={{ stroke: p.color }} {...seg(p.g, p.g.pv(p.s.q3), p.g.pv(p.s.hi), c(), c())} />
      <line class="st-whisker" style={{ stroke: p.color }} {...seg(p.g, p.g.pv(p.s.lo), p.g.pv(p.s.lo), c() - p.half * 0.45, c() + p.half * 0.45)} />
      <line class="st-whisker" style={{ stroke: p.color }} {...seg(p.g, p.g.pv(p.s.hi), p.g.pv(p.s.hi), c() - p.half * 0.45, c() + p.half * 0.45)} />
      {(() => {
        const r = () => rectOf(p.g, p.s.q1, p.s.q3, c() - p.half, c() + p.half);
        return <rect x={r().x} y={r().y} width={r().w} height={Math.max(1, r().h)} rx={2} style={{ fill: p.color, "fill-opacity": 0.14, stroke: p.color, "stroke-width": 1.5 }} />;
      })()}
      <line style={{ stroke: p.color, "stroke-width": 2.5 }} {...seg(p.g, p.g.pv(p.s.median), p.g.pv(p.s.median), c() - p.half, c() + p.half)} />
      <Show when={p.mean && Number.isFinite(p.s.mean)}>
        {(() => { const [x, y] = p.g.xy(p.g.pv(p.s.mean), c()); return <path d={`M${x},${y - 4}L${x + 4},${y}L${x},${y + 4}L${x - 4},${y}Z`} style={{ fill: "var(--viz-gap)", stroke: p.color, "stroke-width": 1.5 }} />; })()}
      </Show>
      <Show when={p.outliers !== false}>
        <For each={p.s.outliers}>{(v) => { const [x, y] = p.g.xy(p.g.pv(v), c()); return <circle cx={x} cy={y} r={3} style={{ fill: "var(--viz-gap)", stroke: p.color, "stroke-width": 1.5 }} />; }}</For>
      </Show>
    </Tip>
  );
}

interface BoxB { label?: string; unit?: string; y?: string; dir?: "h" | "v"; points?: boolean; mean?: boolean; series?: { label: string; values?: number[]; q1?: number; median?: number; q3?: number; min?: number; max?: number; outliers?: number[]; mean?: number; n?: number; em?: boolean; note?: string }[] }
function BoxPlot(b: BoxB) {
  const gs = () => groupsWithStats(b);
  return (
    <Show when={gs().length}>
      <Groups b={b} gs={gs()} domain={domainOf(gs())}>
        {(g) => (
          <g>
            <For each={gs()}>
              {(x, i) => {
                const half = () => Math.min(g.band * 0.32, 18);
                return (
                  <g>
                    <Show when={b.points && x.values.length}>
                      <For each={x.values}>{(v, k) => { const [px, py] = g.xy(g.pv(v), g.pc(i()) + jitter(k(), i() + 3) * half() * 0.9); return <circle cx={px} cy={py} r={2.2} style={{ fill: colorFor(gs(), i()), "fill-opacity": 0.45 }} />; }}</For>
                    </Show>
                    <BoxMark g={g} i={i()} s={x.stats!} color={colorFor(gs(), i())} half={half()} tip={boxTip(x, b.unit)} mean={b.mean} outliers={!b.points} />
                  </g>
                );
              }}
            </For>
          </g>
        )}
      </Groups>
    </Show>
  );
}
defineViz<BoxB>({
  type: "box",
  family: "stat",
  title: "상자 그림 (박스플롯)",
  when: "그룹별 중앙값·사분위·이상치를 한 번에 비교",
  render: BoxPlot,
  examples: [
    { label: "지역별 주문 금액", unit: "천 원", y: "주문 금액 (천 원)", mean: true, series: [{ label: "서울", values: rlognorm(120, Math.log(42), 0.45, 21) }, { label: "경기", values: rlognorm(120, Math.log(36), 0.4, 22) }, { label: "부산", values: rlognorm(80, Math.log(31), 0.42, 23) }, { label: "대구", values: rlognorm(60, Math.log(28), 0.38, 24) }, { label: "광주", values: rlognorm(50, Math.log(27), 0.4, 25) }] },
    {
      label: "빌드 단계별 소요 시간", unit: "초", y: "소요 시간 (초)", dir: "h",
      series: [
        { label: "의존성 설치", q1: 31, median: 38, q3: 47, min: 22, max: 68, outliers: [94, 121], n: 412 },
        { label: "타입 검사", q1: 18, median: 21, q3: 25, min: 14, max: 34, outliers: [52], n: 412 },
        { label: "단위 테스트", q1: 52, median: 61, q3: 74, min: 40, max: 105, outliers: [140], n: 412, em: true },
        { label: "번들링 및 코드 서명", q1: 24, median: 27, q3: 31, min: 19, max: 41, n: 398 },
        { label: "업로드", q1: 6, median: 9, q3: 14, min: 3, max: 25, outliers: [48, 61, 77], n: 398 },
      ],
    },
  ],
});

// violin

interface ViolinB { label?: string; unit?: string; y?: string; dir?: "h" | "v"; bw?: number; series?: { label: string; values: number[]; em?: boolean }[] }
function Violin(b: ViolinB) {
  const gs = () => groupsWithStats(b).filter((g) => g.values.length > 2);
  const D = createMemo(() => {
    const curves = gs().map((g) => {
      const [lo, hi] = kdeRange(g.values, b.bw);
      const [mn, mx] = extent(g.values);
      // a violin stops a little past the data instead of trailing off into the axis
      return kde(g.values, Math.max(lo, mn - (mx - mn) * 0.05), Math.min(hi, mx + (mx - mn) * 0.05), b.bw, 70);
    });
    const dom = extent(curves.flat().map((p) => p[0]), 0.02);
    return { curves, dom };
  });
  return (
    <Show when={gs().length}>
      <Groups b={b} gs={gs()} domain={D().dom}>
        {(g) => (
          <g>
            <For each={D().curves}>
              {(cv, i) => {
                const half = () => Math.min(g.band * 0.45, 46);
                const mx = () => Math.max(1e-9, ...cv.map((p) => p[1]));
                const d = () => {
                  const up = cv.map((p) => g.xy(g.pv(p[0]), g.pc(i()) - (p[1] / mx()) * half()));
                  const dn = [...cv].reverse().map((p) => g.xy(g.pv(p[0]), g.pc(i()) + (p[1] / mx()) * half()));
                  return line<[number, number]>().curve(curveBasis)([...up, ...dn]) + "Z";
                };
                const s = () => gs()[i()].stats!;
                const color = () => colorFor(gs(), i());
                return (
                  <Tip tip={boxTip(gs()[i()], b.unit)}>
                    <path d={d()} style={{ fill: color(), "fill-opacity": 0.16, stroke: color(), "stroke-width": 1.5 }} />
                    <line style={{ stroke: "var(--ink-3)", "stroke-width": 1 }} {...seg(g, g.pv(s().lo), g.pv(s().hi), g.pc(i()), g.pc(i()))} />
                    <line style={{ stroke: "var(--ink-2)", "stroke-width": 5, "stroke-linecap": "round" }} {...seg(g, g.pv(s().q1), g.pv(s().q3), g.pc(i()), g.pc(i()))} />
                    {(() => { const [x, y] = g.xy(g.pv(s().median), g.pc(i())); return <circle cx={x} cy={y} r={3.5} style={{ fill: "var(--viz-gap)", stroke: "var(--ink-2)", "stroke-width": 1.5 }} />; })()}
                  </Tip>
                );
              }}
            </For>
          </g>
        )}
      </Groups>
    </Show>
  );
}
defineViz<ViolinB>({
  type: "violin",
  family: "stat",
  title: "바이올린 플롯",
  when: "그룹별 분포 모양(봉우리가 둘인지, 치우침)까지 비교",
  render: Violin,
  examples: [
    { label: "실험군별 반응 시간", unit: "ms", y: "반응 시간 (ms)", series: [{ label: "대조군", values: rnorm(140, 420, 60, 31, 0) }, { label: "카페인", values: rnorm(140, 375, 48, 32, 0) }, { label: "수면 부족", values: [...rnorm(80, 470, 45, 33, 0), ...rnorm(60, 600, 50, 34, 0)] }] },
  ],
});

// strip and beeswarm

interface DotsB { label?: string; unit?: string; y?: string; dir?: "h" | "v"; mean?: boolean; series?: { label: string; values: number[]; em?: boolean }[] }
function DotGroups(b: DotsB & { swarm?: boolean }) {
  const gs = () => groupsWithStats(b).filter((g) => g.values.length);
  return (
    <Show when={gs().length}>
      <Groups b={b} gs={gs()} domain={domainOf(gs(), 0.05)} rowH={b.swarm ? 52 : 40}>
        {(g) => {
          const pts = createMemo(() => {
            const out: { x: number; y: number; tip: string; color: string; r: number }[] = [];
            gs().forEach((grp, i) => {
              const pos = grp.values.map((v) => g.pv(v));
              const room = g.band * 0.46;
              let r = 4, off: number[] = [];
              if (b.swarm) {
                for (r of [4, 3.5, 3, 2.5, 2, 1.6]) {
                  off = swarm(pos, r + 0.6);
                  if (Math.max(0, ...off.map(Math.abs)) <= room) break;
                }
                const m = Math.max(0, ...off.map(Math.abs));
                if (m > room) off = off.map((o) => (o * room) / m);
              } else {
                r = grp.values.length > 120 ? 2.5 : 3.2;
                off = grp.values.map((_, k) => jitter(k, i + 5) * Math.min(room * 0.7, 22));
              }
              grp.values.forEach((v, k) => {
                const [x, y] = g.xy(pos[k], g.pc(i) + off[k]);
                out.push({ x, y, r, color: colorFor(gs(), i), tip: `${withU(fix(v), b.unit)}\n${grp.label}` });
              });
            });
            return out;
          });
          return (
            <g>
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={p.r} style={{ fill: p.color, "fill-opacity": b.swarm ? 0.85 : 0.6, stroke: b.swarm ? "var(--viz-gap)" : "none", "stroke-width": 1 }} />}</For>
              <Show when={b.mean ?? true}>
                <For each={gs()}>
                  {(grp, i) => {
                    const m = () => grp.values.reduce((s, v) => s + v, 0) / grp.values.length;
                    const half = () => Math.min(g.band * 0.42, 30);
                    return <line style={{ stroke: "var(--ink)", "stroke-width": 2, "stroke-linecap": "round" }} {...seg(g, g.pv(m()), g.pv(m()), g.pc(i()) - half(), g.pc(i()) + half())} />;
                  }}
                </For>
              </Show>
              <Nearest pts={pts()} box={g.c} />
            </g>
          );
        }}
      </Groups>
    </Show>
  );
}
defineViz<DotsB>({
  type: "strip",
  family: "stat",
  title: "스트립 플롯 (지터)",
  when: "표본이 적을 때 그룹별 값을 하나하나 점으로, 평균선과 함께",
  render: (b) => DotGroups({ ...b, swarm: false }),
  examples: [
    { label: "학습률별 검증 정확도 (시드 10개)", y: "검증 정확도 (%)", unit: "%", series: [{ label: "1e-4", values: rnorm(10, 81.2, 0.9, 41, 2) }, { label: "3e-4", values: rnorm(10, 83.6, 0.6, 42, 2), em: true }, { label: "1e-3", values: rnorm(10, 82.9, 1.4, 43, 2) }, { label: "3e-3", values: rnorm(10, 78.4, 3.1, 44, 2) }] },
  ],
});
defineViz<DotsB>({
  type: "beeswarm",
  family: "stat",
  title: "벌떼 그림 (비스웜)",
  when: "점이 겹치지 않게 모든 값을 보여 분포와 개수를 함께",
  render: (b) => DotGroups({ ...b, swarm: true }),
  examples: [
    { label: "브라우저별 첫 화면 표시 시간", unit: "초", y: "LCP (초)", dir: "h", series: [{ label: "Chrome", values: rlognorm(90, Math.log(1.9), 0.3, 51, 2) }, { label: "Safari", values: rlognorm(70, Math.log(2.2), 0.32, 52, 2) }, { label: "Firefox", values: rlognorm(40, Math.log(2.1), 0.28, 53, 2) }, { label: "삼성 인터넷", values: rlognorm(45, Math.log(2.6), 0.35, 54, 2) }] },
  ],
});

// ───────────── raincloud (always horizontal: cloud above, box on the line, rain below)

interface RainB { label?: string; unit?: string; x?: string; bw?: number; series?: { label: string; values: number[]; em?: boolean }[] }
function Raincloud(b: RainB) {
  const gs = () => groupsWithStats(b).filter((g) => g.values.length > 2).slice(0, 8);
  const D = createMemo(() => {
    const curves = gs().map((g) => {
      const [mn, mx] = extent(g.values);
      return kde(g.values, mn - (mx - mn) * 0.04, mx + (mx - mn) * 0.04, b.bw, 70);
    });
    return { curves, dom: extent(curves.flat().map((p) => p[0]), 0.02) };
  });
  return (
    <Show when={gs().length}>
      <RowPlot label={b.label} legend={gs().length > 1 ? gs().map((g, i) => ({ label: g.label, color: col(i) })) : undefined} rows={gs().map((g) => g.label)} rowH={(w) => (w < 480 ? 80 : 92)} x={{ domain: D().dom, title: b.x ?? (b.unit ? `(${b.unit})` : undefined) }}>
        {(c) => (
          <g>
            <For each={gs()}>
              {(grp, i) => {
                const cy = () => c.rowY(i()) - c.band * 0.04;
                const amp = () => c.band * 0.4;
                const cv = () => D().curves[i()];
                const mx = () => Math.max(1e-9, ...cv().map((p) => p[1]));
                const s = () => grp.stats!;
                const color = col(i());
                return (
                  <Tip tip={boxTip(grp, b.unit)}>
                    <path d={(area<Pt>().curve(curveBasis).x((p) => c.X(p[0])).y0(cy() - 6).y1((p) => cy() - 6 - (p[1] / mx()) * amp())(cv()) ?? "")} style={{ fill: color, "fill-opacity": 0.18, stroke: color, "stroke-width": 1.5 }} />
                    <line style={{ stroke: "var(--ink-3)", "stroke-width": 1 }} x1={c.X(s().lo)} x2={c.X(s().hi)} y1={cy()} y2={cy()} />
                    <rect x={c.X(s().q1)} y={cy() - 3} width={Math.max(1, c.X(s().q3) - c.X(s().q1))} height={6} rx={2} style={{ fill: "var(--ink-2)" }} />
                    <circle cx={c.X(s().median)} cy={cy()} r={3.5} style={{ fill: "var(--viz-gap)", stroke: "var(--ink-2)", "stroke-width": 1.5 }} />
                    <For each={grp.values}>{(v, k) => <circle cx={c.X(v)} cy={cy() + 10 + Math.abs(jitter(k(), i() + 9)) * c.band * 0.3} r={2.2} style={{ fill: color, "fill-opacity": 0.55 }} />}</For>
                  </Tip>
                );
              }}
            </For>
          </g>
        )}
      </RowPlot>
    </Show>
  );
}
defineViz<RainB>({
  type: "raincloud",
  family: "stat",
  title: "레인클라우드 플롯",
  when: "분포 모양·요약 통계·원자료를 한 그림에 (발표·논문용)",
  render: Raincloud,
  examples: [
    { label: "UI 버전별 작업 완료 시간", unit: "초", x: "완료 시간 (초)", series: [{ label: "기존 화면", values: rnorm(60, 48, 9, 61, 1) }, { label: "새 화면 A", values: rnorm(60, 39, 7, 62, 1) }, { label: "새 화면 B", values: [...rnorm(40, 35, 5, 63, 1), ...rnorm(20, 55, 6, 64, 1)] }] },
  ],
});

// ───────────── ECDF

interface EcdfB { label?: string; unit?: string; x?: string; series?: { label: string; values: number[] }[]; values?: number[]; refs?: { x?: number; y?: number; label?: string }[] }
function Ecdf(b: EcdfB) {
  const gs = () => groupsOf(b).filter((g) => g.values.length).slice(0, 6);
  const D = createMemo(() => {
    const [lo, hi] = extent(gs().flatMap((g) => g.values), 0.02);
    const steps = gs().map((g) => ecdf(g.values));
    return { lo, hi, steps };
  });
  const F = (st: Pt[], x: number) => { let f = 0; for (const p of st) if (p[0] <= x) f = p[1]; return f; };
  return (
    <Show when={gs().length}>
      <Plot label={b.label} legend={gs().length > 1 ? legendOf(gs()) : undefined} x={{ domain: [D().lo, D().hi], title: b.x ?? (b.unit ? `(${b.unit})` : undefined) }} y={{ domain: [0, 1], nice: false, ticks: [0, 0.25, 0.5, 0.75, 1], fmt: (v) => `${Math.round(v * 100)}%`, title: t("누적 비율") }}>
        {(c) => {
          const grid = () => Array.from({ length: 101 }, (_, i) => D().lo + ((D().hi - D().lo) * i) / 100);
          return (
            <g>
              <For each={D().steps}>
                {(st, k) => <path class="st-line" style={{ stroke: col(k()) }} d={line<Pt>().curve(curveStepAfter).x((p) => c.X(p[0])).y((p) => c.Y(p[1]))([[D().lo, 0], ...st, [D().hi, 1]]) ?? ""} />}
              </For>
              <RefLines refs={refsOf(b.refs)} c={c} />
              <Crosshair box={c} xs={grid().map((x) => c.X(x))} read={(i) => `${t("{v} 이하", { v: withU(fix(grid()[i]), b.unit) })}\n${gs().map((g, k) => `${g.label ? g.label + " " : ""}${Math.round(F(D().steps[k], grid()[i]) * 1000) / 10}%`).join("\n")}`} dots={(i) => D().steps.map((st, k) => ({ y: c.Y(F(st, grid()[i])), color: col(k) }))} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<EcdfB>({
  type: "ecdf",
  family: "stat",
  title: "누적 분포 (ECDF)",
  when: "값 x 이하가 몇 %인가, 백분위(p50·p95)를 그룹끼리 비교",
  render: Ecdf,
  examples: [
    { label: "버전별 페이지 로드 시간", unit: "ms", x: "로드 시간 (ms)", series: [{ label: "v2.3", values: rlognorm(300, Math.log(900), 0.4, 71) }, { label: "v2.4", values: rlognorm(300, Math.log(720), 0.33, 72) }], refs: [{ y: 0.95, label: "p95" }] },
  ],
});

// ───────────── QQ plot

interface QqB { label?: string; unit?: string; values?: number[]; series?: { label: string; values: number[] }[] }
function Qq(b: QqB) {
  const gs = () => groupsOf(b).filter((g) => g.values.length > 2).slice(0, 3);
  const D = createMemo(() => gs().map((g) => qq(g.values)));
  const xr = () => extent(D().flatMap((d) => d.pts.map((p) => p[0])), 0.05);
  const yr = () => extent(D().flatMap((d) => d.pts.map((p) => p[1])), 0.05);
  return (
    <Show when={gs().length}>
      <Plot label={b.label} legend={gs().length > 1 ? legendOf(gs()) : undefined} height={(w) => clamp(Math.round(w * 0.7), 240, 420)} x={{ domain: xr(), title: t("이론 분위수 (정규)"), grid: true }} y={{ domain: yr(), title: `${t("표본 분위수")}${b.unit ? ` (${b.unit})` : ""}` }}>
        {(c) => {
          const pts = () => D().flatMap((d, k) => d.pts.map((p) => ({ x: c.X(p[0]), y: c.Y(p[1]), r: 3, color: col(k), tip: `${withU(fix(p[1]), b.unit)}\n${t("이론 {v}", { v: fix(p[0]) })}${gs()[k].label ? `\n${gs()[k].label}` : ""}` })));
          return (
            <g>
              <For each={D()}>
                {(d, k) => {
                  const [a, z] = xr();
                  return <line class="st-ref" style={{ stroke: gs().length > 1 ? col(k()) : "var(--ink-3)" }} x1={c.X(a)} x2={c.X(z)} y1={c.Y(d.line.icpt + d.line.slope * a)} y2={c.Y(d.line.icpt + d.line.slope * z)} />;
                }}
              </For>
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={3} style={{ fill: p.color, "fill-opacity": 0.75, stroke: "var(--viz-gap)", "stroke-width": 1 }} />}</For>
              <Nearest pts={pts()} box={c} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<QqB>({
  type: "qq",
  family: "stat",
  title: "Q-Q 플롯",
  when: "표본이 정규분포를 따르나 (꼬리가 두꺼운지, 치우쳤는지)",
  render: Qq,
  examples: [
    { label: "회귀 잔차의 정규성", series: [{ label: "모형 1 (선형)", values: rnorm(120, 0, 1, 81, 3) }, { label: "모형 2 (로그 변환 전)", values: rlognorm(120, 0, 0.6, 82, 3).map((v) => +(v - 1.2).toFixed(3)) }] },
  ],
});

export { BoxMark, Groups, groupsWithStats, boxTip, colorFor, domainOf, rectOf, seg };
