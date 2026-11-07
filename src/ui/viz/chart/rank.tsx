// Comparison by position: lollipop, Cleveland dot plot, dumbbell, range bars,
// bullet; and rank / change between points in time: slope and bump charts.
import { For, Show, type JSX } from "solid-js";
import { scaleLinear } from "d3-scale";
import { line, curveMonotoneX } from "d3-shape";
import { defineViz } from "../registry";
import { series, useTip } from "../kit";
import { arr, barPath, clamp, dodge, extent, isNum, normSeries, ranksOf, str, toNum, valueDomain } from "./math";
import { AX, ChFrame, colorOf, cut, fmtC, fmtV, hover, MUTED, TipBody, tw, type TipRow } from "./common";

const unitOf = (b: any) => str(b.unit) || undefined;

/**
 * Rows of categories with a shared horizontal value axis: the label column at
 * the left, an optional value column at the right, one row drawer per category.
 */
function Rows(props: {
  label?: string;
  class?: string;
  cats: string[];
  domain: [number, number];
  legend?: { label: string; color: string; dash?: boolean }[];
  right?: (c: number) => string;
  rowH?: number;
  fmt?: (v: number) => string;
  draw: (c: number, xs: (v: number) => number, yMid: number) => JSX.Element;
  tip: (c: number) => { title?: string; rows: TipRow[]; foot?: string };
  /** a sub label under the category name */
  sub?: (c: number) => string;
}) {
  const tip = useTip();
  const rh = () => props.rowH ?? (props.sub ? 38 : 28);
  return (
    <ChFrame label={props.label} class={props.class} height={() => props.cats.length * rh() + 28} legend={props.legend}>
      {(w, h) => {
        const lw = Math.min(Math.max(0, ...props.cats.map((c) => tw(c))), w * (w < 480 ? 0.3 : 0.26)) + 10;
        const rw = props.right ? Math.max(0, ...props.cats.map((_, c) => tw(props.right!(c)))) + 12 : 10;
        const x0 = lw + 8, x1 = w - rw - 6;
        const xs = scaleLinear().domain(props.domain).range([x0, x1]).nice(Math.max(2, Math.floor((x1 - x0) / 80)));
        const ticks = xs.ticks(Math.max(2, Math.floor((x1 - x0) / 80)));
        const fmt = props.fmt ?? fmtC;
        const ym = (c: number) => 4 + c * rh() + rh() / 2;
        return (
          <>
            <g class="viz-axis">
              <For each={ticks}>
                {(t) => (
                  <>
                    <line class="viz-grid" x1={Math.round(xs(t)) + 0.5} x2={Math.round(xs(t)) + 0.5} y1={2} y2={h - 22} />
                    <text x={xs(t)} y={h - 6} text-anchor="middle">{fmt(t)}</text>
                  </>
                )}
              </For>
            </g>
            <For each={props.cats}>
              {(cat, c) => (
                <g class="viz-mark" {...hover(tip, () => <TipBody {...props.tip(c())} />)}>
                  <rect class="ch-hit" x={0} y={ym(c()) - rh() / 2} width={w} height={rh()} />
                  <text class="ch-cat" x={lw} y={props.sub ? ym(c()) - 7 : ym(c())} dy="0.32em" text-anchor="end">{cut(cat, lw - 4)}</text>
                  <Show when={props.sub}><text class="ch-note" x={lw} y={ym(c()) + 9} dy="0.32em" text-anchor="end">{cut(props.sub!(c()), lw - 4, 11.5)}</text></Show>
                  {props.draw(c(), xs, ym(c()))}
                  <Show when={props.right}><text class="ch-val" x={w - 4} y={ym(c())} dy="0.32em" text-anchor="end">{props.right!(c())}</text></Show>
                </g>
              )}
            </For>
          </>
        );
      }}
    </ChFrame>
  );
}
const itemsOf = (b: any) => arr<any>(b.items).filter((i) => i && typeof i === "object");

defineViz({
  type: "lollipop",
  family: "chart",
  title: "롤리팝",
  when: "많은 항목의 크기를 막대보다 가볍게 순위대로 비교",
  render: (b: any) => {
    const ps = itemsOf(b)
      .map((i, k) => ({ label: str(i.label, `항목 ${k + 1}`), value: toNum(i.value), em: !!(i.em ?? i.highlight) }))
      .filter((p): p is { label: string; value: number; em: boolean } => p.value !== null);
    if (b.sort !== false) ps.sort((a, c) => c.value - a.value);
    const unit = unitOf(b);
    const anyEm = ps.some((p) => p.em);
    const ext = extent(ps.map((p) => p.value));
    return (
      <Rows
        label={str(b.label)}
        cats={ps.map((p) => p.label)}
        domain={valueDomain(ext, "always")}
        rowH={24}
        right={(c) => fmtV(ps[c].value, unit)}
        draw={(c, xs, y) => {
          const color = anyEm && !ps[c].em ? MUTED : series(0);
          return (
            <>
              <line class="ch-stem" x1={xs(0)} x2={xs(ps[c].value)} y1={y} y2={y} style={{ stroke: color, opacity: 0.45 }} />
              <circle class="ch-dot" cx={xs(ps[c].value)} cy={y} r={5} fill={color} />
            </>
          );
        }}
        tip={(c) => ({ title: ps[c].label, rows: [{ label: "", value: fmtV(ps[c].value, unit) }] })}
      />
    );
  },
  examples: [
    {
      label: "언어별 저장소 수",
      unit: "개",
      items: [
        { label: "TypeScript", value: 412 },
        { label: "Python", value: 365 },
        { label: "Go", value: 188, highlight: true },
        { label: "Java", value: 171 },
        { label: "Rust", value: 96 },
        { label: "Kotlin", value: 74 },
        { label: "Swift", value: 51 },
        { label: "C++", value: 38 },
      ],
    },
  ],
});

defineViz({
  type: "dotPlot",
  family: "chart",
  title: "점 그래프 (클리블랜드)",
  when: "항목마다 여러 집단의 값을 한 줄 위의 점으로 비교",
  render: (b: any) => {
    const names = arr<any>(b.series).map((s, k) => str(typeof s === "object" && s ? s.label : s, `계열 ${k + 1}`)).slice(0, 8);
    const rows = itemsOf(b).map((i, k) => ({ label: str(i.label, `항목 ${k + 1}`), values: arr(i.values).map(toNum) }));
    const unit = unitOf(b);
    const ext = extent(rows.flatMap((r) => r.values));
    const dom = valueDomain(ext, b.zero ? "always" : "auto");
    return (
      <Rows
        label={str(b.label)}
        cats={rows.map((r) => r.label)}
        domain={dom}
        rowH={26}
        legend={names.length > 1 ? names.map((n, k) => ({ label: n, color: series(k) })) : undefined}
        draw={(c, xs, y) => {
          const vs = rows[c].values.map((v, k) => ({ v, k })).filter((r): r is { v: number; k: number } => r.v !== null);
          const e = extent(vs.map((r) => r.v));
          return (
            <>
              <line class="viz-grid" x1={xs(dom[0])} x2={xs(dom[1])} y1={y} y2={y} />
              <Show when={e}><line class="ch-stem" x1={xs(e![0])} x2={xs(e![1])} y1={y} y2={y} /></Show>
              <For each={vs}>{(r) => <circle class="ch-dot" cx={xs(r.v)} cy={y} r={5} fill={series(r.k)} />}</For>
            </>
          );
        }}
        tip={(c) => ({ title: rows[c].label, rows: names.map((n, k) => ({ color: series(k), label: n, value: fmtV(rows[c].values[k], unit) })) })}
      />
    );
  },
  examples: [
    {
      label: "직군별 평균 연봉",
      unit: "만 원",
      series: ["신입", "5년 차", "10년 차"],
      items: [
        { label: "백엔드", values: [4300, 6800, 9200] },
        { label: "프론트엔드", values: [4100, 6300, 8400] },
        { label: "데이터 분석", values: [4400, 6600, 8800] },
        { label: "디자인", values: [3600, 5200, 7100] },
        { label: "기획", values: [3800, 5600, 7600] },
      ],
    },
  ],
});

defineViz({
  type: "dumbbell",
  family: "chart",
  title: "덤벨 (전·후)",
  when: "항목마다 이전 값에서 이후 값으로 얼마나, 어느 방향으로 바뀌었나",
  render: (b: any) => {
    const names = arr<any>(b.series).map((s) => str(s));
    const from = str(b.from, names[0] || "이전"), to = str(b.to, names[1] || "이후");
    const rows = itemsOf(b)
      .map((i, k) => {
        const v = arr(i.values);
        return { label: str(i.label, `항목 ${k + 1}`), a: toNum(i.before ?? i.from ?? v[0]), b: toNum(i.after ?? i.to ?? v[1]) };
      })
      .filter((r): r is { label: string; a: number; b: number } => r.a !== null && r.b !== null);
    if (b.sort !== false) rows.sort((p, q) => q.b - q.a - (p.b - p.a));
    const unit = unitOf(b);
    const dom = valueDomain(extent(rows.flatMap((r) => [r.a, r.b])), b.zero ? "always" : "auto");
    const ca = "var(--viz-seq-3)", cb = "var(--viz-seq-6)";
    const sign = (d: number) => `${d > 0 ? "+" : ""}${fmtC(d, unit === "%" ? "%p" : undefined)}`;
    return (
      <Rows
        label={str(b.label)}
        cats={rows.map((r) => r.label)}
        domain={dom}
        legend={[{ label: from, color: ca }, { label: to, color: cb }]}
        right={(c) => sign(rows[c].b - rows[c].a)}
        draw={(c, xs, y) => (
          <>
            <line class="ch-stem" x1={xs(rows[c].a)} x2={xs(rows[c].b)} y1={y} y2={y} />
            <circle class="ch-dot" cx={xs(rows[c].a)} cy={y} r={5} fill={ca} />
            <circle class="ch-dot" cx={xs(rows[c].b)} cy={y} r={5} fill={cb} />
          </>
        )}
        tip={(c) => ({ title: rows[c].label, rows: [{ color: ca, label: from, value: fmtV(rows[c].a, unit) }, { color: cb, label: to, value: fmtV(rows[c].b, unit) }], foot: `변화 ${sign(rows[c].b - rows[c].a)}` })}
      />
    );
  },
  examples: [
    {
      label: "캐시 도입 전후 응답 시간",
      unit: "ms",
      from: "도입 전",
      to: "도입 후",
      items: [
        { label: "상품 목록", values: [420, 135] },
        { label: "상품 상세", values: [310, 118] },
        { label: "검색 자동완성", values: [180, 74] },
        { label: "장바구니", values: [260, 241] },
        { label: "주문 내역", values: [390, 402] },
      ],
    },
  ],
});

defineViz({
  type: "rangeBars",
  family: "chart",
  title: "범위 막대",
  when: "항목마다 최소~최대 범위가 어디에 걸쳐 있나 (현재값 점 선택)",
  render: (b: any) => {
    const rows = itemsOf(b)
      .map((i, k) => ({ label: str(i.label, `항목 ${k + 1}`), lo: toNum(i.min ?? i.lo), hi: toNum(i.max ?? i.hi), v: toNum(i.value) }))
      .filter((r): r is { label: string; lo: number; hi: number; v: number | null } => r.lo !== null && r.hi !== null)
      .map((r) => (r.lo > r.hi ? { ...r, lo: r.hi, hi: r.lo } : r));
    const unit = unitOf(b);
    const dom = valueDomain(extent(rows.flatMap((r) => [r.lo, r.hi, r.v])), b.zero ? "always" : "auto");
    const hasV = rows.some((r) => r.v !== null);
    return (
      <Rows
        label={str(b.label)}
        cats={rows.map((r) => r.label)}
        domain={dom}
        legend={hasV ? [{ label: "범위", color: "var(--viz-seq-2)" }, { label: str(b.valueLabel, "현재"), color: series(0) }] : undefined}
        right={(c) => `${fmtC(rows[c].lo)}~${fmtC(rows[c].hi)}`}
        draw={(c, xs, y) => {
          const r = rows[c];
          const x = xs(r.lo), wd = Math.max(4, xs(r.hi) - x);
          return (
            <>
              <rect x={x} y={y - 6} width={wd} height={12} rx={6} fill={hasV ? "var(--viz-seq-2)" : series(0)} />
              <Show when={r.v !== null}><circle class="ch-dot" cx={xs(r.v!)} cy={y} r={5} fill={series(0)} /></Show>
            </>
          );
        }}
        tip={(c) => ({ title: rows[c].label, rows: [{ label: "최소", value: fmtV(rows[c].lo, unit) }, { label: "최대", value: fmtV(rows[c].hi, unit) }, ...(rows[c].v !== null ? [{ label: str(b.valueLabel, "현재"), value: fmtV(rows[c].v, unit) }] : [])] })}
      />
    );
  },
  examples: [
    {
      label: "도시별 11월 기온",
      unit: "°C",
      valueLabel: "평균",
      items: [
        { label: "서울", min: -3.1, max: 17.8, value: 7.4 },
        { label: "부산", min: 3.2, max: 21.4, value: 12.6 },
        { label: "제주", min: 6.8, max: 22.1, value: 14.2 },
        { label: "강릉", min: -0.4, max: 19.9, value: 9.8 },
        { label: "대관령", min: -9.6, max: 12.3, value: 2.1 },
      ],
    },
  ],
});

// ───────────── bullet

defineViz({
  type: "bullet",
  family: "chart",
  title: "불릿 차트",
  when: "각 지표가 목표 대비 어디쯤이고, 나쁨·보통·좋음 구간 중 어디에 있나",
  render: (b: any) => {
    const rows = itemsOf(b)
      .map((i, k) => ({ label: str(i.label, `지표 ${k + 1}`), v: toNum(i.value), t: toNum(i.target), bands: arr(i.bands).map(toNum).filter(isNum).sort((a, c) => a - c), max: toNum(i.max), unit: str(i.unit) || unitOf(b), note: str(i.note) }))
      .filter((r) => r.v !== null) as { label: string; v: number; t: number | null; bands: number[]; max: number | null; unit?: string; note: string }[];
    const tip = useTip();
    const RH = 44;
    return (
      <ChFrame label={str(b.label)} height={() => rows.length * RH + 6}>
        {(w) => {
          const lw = Math.min(Math.max(0, ...rows.map((r) => tw(r.label, 12.5, 500))), w * 0.3) + 10;
          const rw = Math.max(0, ...rows.map((r) => tw(fmtV(r.v, r.unit), 12.5, 600))) + 12;
          const x0 = lw + 8, x1 = w - rw - 4;
          return (
            <For each={rows}>
              {(r, k) => {
                const max = r.max ?? Math.max(r.v, r.t ?? 0, ...r.bands) * 1.05;
                const xs = scaleLinear().domain([0, max || 1]).range([x0, x1]);
                const y = k() * RH + 8;
                const shades = ["var(--viz-grid)", "color-mix(in srgb, var(--viz-grid) 55%, var(--viz-base))", "var(--viz-base)"];
                const edges = [0, ...r.bands.filter((v) => v < max), max];
                const ticks = xs.ticks(3);
                return (
                  <g class="viz-mark" {...hover(tip, () => <TipBody title={r.label} rows={[{ label: "현재", value: fmtV(r.v, r.unit) }, ...(r.t !== null ? [{ label: "목표", value: fmtV(r.t, r.unit) }] : []), ...(r.bands.length ? [{ label: "구간", value: r.bands.map((v) => fmtC(v)).join(" / ") }] : [])]} />)}>
                    <rect class="ch-hit" x={0} y={y - 6} width={w} height={RH} />
                    <text class="ch-cat" x={lw} y={y + 8} dy="0.32em" text-anchor="end" style={{ "font-weight": 500 }}>{cut(r.label, lw - 4, 12.5, 500)}</text>
                    <Show when={r.note}><text class="ch-note" x={lw} y={y + 23} dy="0.32em" text-anchor="end">{cut(r.note, lw - 4, 11.5)}</text></Show>
                    <For each={edges.slice(1)}>{(e, i) => <rect x={xs(edges[i()])} y={y} width={Math.max(0, xs(e) - xs(edges[i()]))} height={16} fill={shades[Math.min(2, edges.length - 2 - i())] ?? shades[0]} />}</For>
                    <path d={barPath(x0, y + 5, Math.max(0, xs(Math.min(r.v, max)) - x0), 6, "r", 3)} fill={series(0)} />
                    <Show when={r.t !== null}><rect x={xs(Math.min(r.t!, max)) - 1} y={y - 3} width={2.5} height={22} rx={1} fill="var(--ink)" /></Show>
                    <g class="viz-axis">
                      <For each={ticks}>{(t) => <text x={clamp(xs(t), x0 + 6, x1 - 6)} y={y + 30} text-anchor="middle" style={{ "font-size": "11px" }}>{fmtC(t)}</text>}</For>
                    </g>
                    <text class="ch-val strong" x={w - 4} y={y + 8} dy="0.32em" text-anchor="end">{fmtV(r.v, r.unit)}</text>
                  </g>
                );
              }}
            </For>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "3분기 핵심 지표",
      items: [
        { label: "매출", unit: "억 원", value: 268, target: 280, bands: [200, 250, 300] },
        { label: "신규 고객", unit: "명", value: 4120, target: 3800, bands: [2500, 3500, 4500] },
        { label: "고객 만족도", unit: "점", value: 4.1, target: 4.3, bands: [3, 4, 5], max: 5 },
        { label: "이탈률", note: "낮을수록 좋음", unit: "%", value: 3.8, target: 3, bands: [2, 4, 6] },
      ],
    },
  ],
});

// ───────────── slope

defineViz({
  type: "slope",
  family: "chart",
  title: "기울기 차트",
  when: "두 시점 사이에 항목마다 값이 오르고 내린 정도와 순서 변화",
  render: (b: any) => {
    const cols = arr<any>(b.x ?? b.series).map((s) => str(s));
    const A = cols[0] || "이전", B = cols[1] || "이후";
    const rows = itemsOf(b)
      .map((i, k) => {
        const v = arr(i.values);
        return { label: str(i.label, `항목 ${k + 1}`), a: toNum(i.from ?? v[0]), b: toNum(i.to ?? v[1]), em: !!(i.em ?? i.highlight) };
      })
      .filter((r): r is { label: string; a: number; b: number; em: boolean } => r.a !== null && r.b !== null);
    const unit = unitOf(b);
    const anyEm = rows.some((r) => r.em);
    const tip = useTip();
    return (
      <ChFrame label={str(b.label)} height={(w) => clamp(w * 0.62, 240, 380)}>
        {(w, h) => {
          const e = extent(rows.flatMap((r) => [r.a, r.b])) ?? [0, 1];
          const dom: [number, number] = [e[0] - (e[1] - e[0]) * 0.04, e[1] + (e[1] - e[0]) * 0.04 || 1];
          const top = 30, bottom = 10;
          const ys = scaleLinear().domain(dom).range([h - bottom, top]);
          const lt = (r: (typeof rows)[number]) => fmtC(r.a);
          const rt = (r: (typeof rows)[number]) => `${fmtC(r.b)}  ${r.label}`;
          const lw = Math.max(0, ...rows.map((r) => tw(lt(r)))) + 8;
          const rwMax = w * 0.42;
          const rw = Math.min(rwMax, Math.max(0, ...rows.map((r) => tw(rt(r))))) + 8;
          const x0 = lw + 4, x1 = w - rw - 4;
          const ly = dodge(rows.map((r) => ys(r.a)), 15, top, h - bottom);
          const ry = dodge(rows.map((r) => ys(r.b)), 15, top, h - bottom);
          const col = (k: number) => colorOf(k, rows[k].em, anyEm);
          return (
            <>
              <line class="viz-base" x1={x0} x2={x0} y1={top - 6} y2={h - bottom} />
              <line class="viz-base" x1={x1} x2={x1} y1={top - 6} y2={h - bottom} />
              <text class="ch-panel-title" x={x0} y={12} text-anchor="middle">{cut(A, 120)}</text>
              <text class="ch-panel-title" x={x1} y={12} text-anchor="middle">{cut(B, 120)}</text>
              <For each={rows.map((r, k) => ({ r, k })).sort((p, q) => Number(!anyEm || p.r.em) - Number(!anyEm || q.r.em))}>
                {({ r, k }) => (
                  <g class="viz-mark" {...hover(tip, () => <TipBody title={r.label} rows={[{ label: A, value: fmtV(r.a, unit) }, { label: B, value: fmtV(r.b, unit) }]} foot={`변화 ${r.b - r.a > 0 ? "+" : ""}${fmtV(r.b - r.a, unit)}`} />)}>
                    <line x1={x0} x2={x1} y1={ys(r.a)} y2={ys(r.b)} stroke="transparent" stroke-width="12" />
                    <line class="ch-line" x1={x0} x2={x1} y1={ys(r.a)} y2={ys(r.b)} stroke={col(k)} />
                    <circle class="ch-dot" cx={x0} cy={ys(r.a)} r={4} fill={col(k)} />
                    <circle class="ch-dot" cx={x1} cy={ys(r.b)} r={4} fill={col(k)} />
                    <text class="ch-val" x={x0 - 8} y={ly[k]} dy="0.32em" text-anchor="end">{lt(r)}</text>
                    <text class="ch-end" x={x1 + 8} y={ry[k]} dy="0.32em">{cut(rt(r), w - x1 - 10)}</text>
                  </g>
                )}
              </For>
            </>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "브랜드별 시장 점유율",
      unit: "%",
      x: ["2024년", "2026년"],
      items: [
        { label: "브랜드 A", values: [31.2, 27.4] },
        { label: "브랜드 B", values: [22.8, 29.1], em: true },
        { label: "브랜드 C", values: [18.5, 17.9] },
        { label: "브랜드 D", values: [12.1, 9.6] },
        { label: "자체 브랜드", values: [8.4, 11.2] },
      ],
    },
  ],
});

// ───────────── bump

defineViz({
  type: "bump",
  family: "chart",
  title: "범프 차트 (순위 변화)",
  when: "여러 항목의 순위가 시간에 따라 어떻게 뒤바뀌었나",
  render: (b: any) => {
    const d = normSeries(b);
    const ss = d.series.slice(0, 12);
    const ranks = b.rank ? ss.map((s) => s.values.map((v) => (v === null ? null : Math.round(v)))) : ranksOf(ss.map((s) => s.values));
    const n = Math.max(1, ...ranks.flat().filter(isNum));
    const anyEm = ss.some((s) => s.em);
    const unit = unitOf(b);
    const tip = useTip();
    const RH = 30;
    return (
      <ChFrame label={str(b.label)} height={() => n * RH + 34}>
        {(w, h) => {
          const both = w >= 520;
          const nameW = Math.min(w * (both ? 0.18 : 0.3), Math.max(0, ...ss.map((s) => tw(s.label))) + 10);
          const x0 = (both ? nameW : 0) + 26, x1 = w - nameW - 12;
          const step = d.x.length > 1 ? (x1 - x0) / (d.x.length - 1) : 0;
          const px = (i: number) => x0 + i * step;
          const py = (r: number) => 10 + (r - 1) * RH + RH / 2;
          const xl = d.x.map((x) => String(x));
          const keepX = new Set(xl.map((_, i) => i).filter((i) => i % Math.max(1, Math.ceil(Math.max(0, ...xl.map((l) => tw(l, AX))) / Math.max(1, step - 8))) === 0 || i === xl.length - 1));
          const col = (k: number) => colorOf(k, ss[k].em, anyEm);
          const first = (k: number) => ranks[k].findIndex((r) => r !== null);
          const last = (k: number) => ranks[k].reduce<number>((p, r, i) => (r !== null ? i : p), -1);
          return (
            <>
              <g class="viz-axis">
                <For each={Array.from({ length: n }, (_, i) => i + 1)}>{(r) => <text x={both ? nameW + 8 : 8} y={py(r)} dy="0.32em">{r}</text>}</For>
                <For each={xl}>{(l, i) => <Show when={keepX.has(i())}><text x={px(i())} y={h - 6} text-anchor="middle">{l}</text></Show>}</For>
              </g>
              <For each={ss.map((s, k) => ({ s, k })).sort((p, q) => Number(!anyEm || p.s.em) - Number(!anyEm || q.s.em))}>
                {({ s, k }) => {
                  const idx = ranks[k].map((_, i) => i);
                  const dd = line<number>().defined((i) => ranks[k][i] !== null).x(px).y((i) => py(ranks[k][i]!)).curve(curveMonotoneX)(idx) ?? "";
                  return (
                    <g class="viz-mark" {...hover(tip, () => <TipBody title={s.label} rows={xl.map((l, i) => ({ label: l, value: ranks[k][i] !== null ? `${ranks[k][i]}위${b.rank || s.values[i] === null ? "" : ` · ${fmtV(s.values[i], unit)}`}` : "–" }))} />)}>
                      <path d={dd} fill="none" stroke="transparent" stroke-width="14" />
                      <path d={dd} class="ch-line" stroke={col(k)} style={{ "stroke-width": "2.5px" }} />
                      <For each={ranks[k]}>{(r, i) => <Show when={r !== null}><circle class="ch-dot" cx={px(i())} cy={py(r!)} r={4.5} fill={col(k)} /></Show>}</For>
                      <Show when={both && first(k) >= 0}><text class="ch-end" x={nameW - 2} y={py(ranks[k][first(k)]!)} dy="0.32em" text-anchor="end">{cut(s.label, nameW - 6)}</text></Show>
                      <Show when={last(k) >= 0}><text class="ch-end" x={px(last(k)) + 10} y={py(ranks[k][last(k)]!)} dy="0.32em">{cut(s.label, w - px(last(k)) - 12)}</text></Show>
                    </g>
                  );
                }}
              </For>
            </>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "금융 앱 카테고리 순위",
      rank: true,
      x: ["6월", "7월", "8월", "9월", "10월", "11월"],
      series: [
        { label: "머니로그", values: [1, 1, 2, 2, 1, 1] },
        { label: "지갑플러스", values: [2, 3, 1, 1, 2, 3] },
        { label: "우리 앱", values: [5, 4, 4, 3, 3, 2], em: true },
        { label: "세이브온", values: [3, 2, 3, 4, 4, 4] },
        { label: "뱅크노트", values: [4, 5, 5, 5, 5, 5] },
      ],
    },
  ],
});
