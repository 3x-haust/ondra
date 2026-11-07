// Change over time: line, step, area (plain, stacked, 100%, stream), forecast
// fan, surplus/deficit, cumulative, burn-up/down and small multiples.
import { For, Show } from "solid-js";
import { area, curveLinear, curveMonotoneX, curveStepAfter, line } from "d3-shape";
import { defineViz } from "../registry";
import { series } from "../kit";
import { arr, clamp, cumulate, dodge, extent, isNum, normSeries, parseTime, stackSeries, str, toNum, valueDomain, xKind, type Series } from "./math";
import { box, ChFrame, colorOf, Crosshair, cut, FS, fmtV, inkOn, makeX, makeY, pct, TipBody, tw, XTicks, YGrid, type TipRow } from "./common";

type X = (string | number)[];
let uid = 0;

export interface LS {
  label: string;
  values: (number | null)[];
  color: string;
  dash?: boolean;
  /** wash under the line (opacity) */
  area?: number;
  /** drawn behind, no end label (guides: plan, projection) */
  quiet?: boolean;
  /** drawn behind and thinner, still labelled (not the emphasised series) */
  muted?: boolean;
  /** extra tooltip text for point i */
  note?: (i: number) => string;
}
interface Ev { x: unknown; label: string; series?: string }
const curveOf = (c?: string) => (c === "step" ? curveStepAfter : c === "smooth" ? curveMonotoneX : curveLinear);

/** where an x value (label, number or date) falls in xs */
export function xIndex(xs: X, v: unknown): number {
  const kind = xKind(xs);
  if (kind === "cat") return xs.findIndex((x) => String(x) === String(v));
  const want = kind === "time" ? parseTime(v) : toNum(v);
  if (want === null) return -1;
  let best = -1, d = Infinity;
  xs.forEach((x, i) => {
    const t = kind === "time" ? parseTime(x)! : (x as number);
    if (Math.abs(t - want) < d) (d = Math.abs(t - want)), (best = i);
  });
  return best;
}
const targetOf = (t: unknown): { value: number; label: string } | null => {
  if (isNum(t)) return { value: t, label: "목표" };
  if (t && typeof t === "object" && isNum(toNum((t as any).value))) return { value: toNum((t as any).value)!, label: str((t as any).label, "목표") };
  return null;
};

/**
 * The shared line plot: gridlines, lines (with washes, bands, markers), a target
 * rule, events, direct end labels that never overlap, and a crosshair.
 */
export function LinePlot(props: {
  label?: string;
  unit?: string;
  x: X;
  lines: LS[];
  bands?: { lo: (number | null)[]; hi: (number | null)[]; color: string; opacity: number; label?: string }[];
  log?: boolean;
  target?: unknown;
  events?: unknown;
  markers?: boolean;
  curve?: string;
  zero?: "auto" | "always";
  /** "name" for several series, "value" for one, or none */
  ends?: "name" | "value" | "none";
  legend?: { label: string; color: string; dash?: boolean }[];
  extraTip?: (i: number) => TipRow[];
  class?: string;
}) {
  const lines = () => props.lines.filter((l) => l.values.some((v) => v !== null));
  const target = () => targetOf(props.target);
  const events = (): Ev[] => arr<any>(props.events).filter((e) => e && typeof e === "object" && str(e.label)).map((e) => ({ x: e.x, label: str(e.label), series: str(e.series) || undefined }));
  const rules = () => events().filter((e) => !e.series);
  const ends = () => props.ends ?? (lines().filter((l) => !l.quiet).length > 1 ? "name" : "value");
  const legend = () => props.legend ?? (lines().length > 1 ? lines().map((l) => ({ label: l.label, color: l.color, dash: l.dash })) : undefined);
  const height = (w: number) => clamp(w * 0.5, 210, 300) + (rules().length ? 18 : 0);
  return (
    <ChFrame label={props.label} class={`ch-lines ${props.class ?? ""}`} height={height} legend={legend()}>
      {(w, h) => {
        const ls = lines();
        const all = ls.flatMap((l) => l.values).concat((props.bands ?? []).flatMap((b) => [...b.lo, ...b.hi]));
        const t = target();
        const log = !!props.log && all.some((v) => isNum(v) && v > 0);
        const ext = extent([...all.filter((v) => !log || (isNum(v) && v > 0)), ...(t ? [t.value] : [])]);
        const dom = log ? (ext ?? [1, 10]) : valueDomain(ext, props.zero);
        const top = rules().length ? 26 : 10;
        const bottom = 26;
        const y = makeY(dom, top, h - bottom, { log, unit: props.unit });
        // end labels: their room at the right
        const endText = (l: LS) => {
          const last = [...l.values].reverse().find((v) => v !== null) ?? null;
          return ends() === "value" ? fmtV(last, props.unit) : l.label;
        };
        const showEnds = ends() !== "none" && ls.filter((l) => !l.quiet).length <= 6;
        const endMax = Math.min(w * (w < 480 ? 0.26 : 0.22), 140);
        const endW = showEnds ? Math.min(endMax, Math.max(0, ...ls.filter((l) => !l.quiet).map((l) => tw(endText(l))))) : 0;
        const x0 = Math.ceil(y.width) + 10;
        const x1 = w - (showEnds ? endW + 16 : 10);
        const X = makeX(props.x, x0, x1);
        const b = box(x0, top, x1 - x0, h - bottom - top, w, h);
        const ys = (v: number | null) => (v === null || (log && v <= 0) ? null : y.s(v));
        const pathOf = (vals: (number | null)[]) =>
          line<number>()
            .defined((i) => ys(vals[i]) !== null)
            .x((i) => X.pos(i))
            .y((i) => ys(vals[i])!)
            .curve(curveOf(props.curve))(vals.map((_, i) => i)) ?? "";
        const base = y.s(log ? dom[0] : clamp(0, dom[0], dom[1]));
        const washOf = (vals: (number | null)[]) =>
          area<number>()
            .defined((i) => ys(vals[i]) !== null)
            .x((i) => X.pos(i))
            .y0(base)
            .y1((i) => ys(vals[i])!)
            .curve(curveOf(props.curve))(vals.map((_, i) => i)) ?? "";
        const bandOf = (lo: (number | null)[], hi: (number | null)[]) =>
          area<number>()
            .defined((i) => ys(lo[i]) !== null && ys(hi[i]) !== null)
            .x((i) => X.pos(i))
            .y0((i) => ys(lo[i])!)
            .y1((i) => ys(hi[i])!)
            .curve(curveOf(props.curve))(lo.map((_, i) => i)) ?? "";
        const lastIdx = (l: LS) => {
          for (let i = l.values.length - 1; i >= 0; i--) if (ys(l.values[i]) !== null) return i;
          return -1;
        };
        // labels at the right end, spread apart; a leader line when moved
        const named = ls.filter((l) => !l.quiet && lastIdx(l) >= 0);
        const wantY = named.map((l) => ys(l.values[lastIdx(l)])!);
        const gotY = dodge(wantY, 15, b.y0 + 4, b.y0 + b.ih);
        // events
        const ruleEvs = rules()
          .map((e) => ({ e, i: xIndex(props.x, e.x) }))
          .filter((r) => r.i >= 0);
        const rows: number[] = [];
        const placed = ruleEvs.map((r) => {
          const x = X.pos(r.i);
          const text = cut(r.e.label, 120, 11.5);
          const tw0 = tw(text, 11.5);
          const lx = clamp(x - tw0 / 2, 0, w - tw0);
          let row = rows.findIndex((end) => end + 6 < lx);
          if (row < 0 && rows.length < 1) row = rows.push(-Infinity) - 1;
          if (row < 0) return { x, text: "", lx, row: 0, full: r.e.label };
          rows[row] = lx + tw0;
          return { x, text, lx, row, full: r.e.label };
        });
        const pointEvs = events()
          .filter((e) => e.series)
          .map((e) => {
            const l = ls.find((s) => s.label === e.series);
            const i = xIndex(props.x, e.x);
            const v = l && i >= 0 ? ys(l.values[i]) : null;
            return l && v !== null ? { x: X.pos(i), y: v, text: cut(e.label, 120, 11.5), full: e.label } : null;
          })
          .filter((p): p is NonNullable<typeof p> => !!p);
        const tipFor = (i: number) => (
          <TipBody
            title={X.label(i)}
            rows={[
              ...ls
                .map((l) => ({ l, v: l.values[i] }))
                .filter((r) => r.v !== null)
                .sort((a, c) => (c.v as number) - (a.v as number))
                .map((r) => ({ color: r.l.color, key: (r.l.dash ? "dash" : "line") as "dash" | "line", label: r.l.label + (r.l.note ? ` ${r.l.note(i)}` : ""), value: fmtV(r.v, props.unit) })),
              ...(props.extraTip?.(i) ?? []),
            ]}
            foot={t ? `${t.label} ${fmtV(t.value, props.unit)}` : undefined}
          />
        );
        const order = [...ls].sort((a, c) => Number(!!c.quiet || !!c.muted) - Number(!!a.quiet || !!a.muted));
        return (
          <>
            <YGrid y={y} x0={b.x0} x1={b.x0 + b.iw} zero={!log} />
            <XTicks ticks={X.ticks} y={h - 8} w={w} />
            <For each={props.bands ?? []}>{(bd) => <path d={bandOf(bd.lo, bd.hi)} fill={bd.color} opacity={bd.opacity} />}</For>
            <For each={order.filter((l) => l.area)}>{(l) => <path d={washOf(l.values)} fill={l.color} opacity={l.area} />}</For>
            <Show when={t}>
              <line class="ch-target" x1={b.x0} x2={b.x0 + b.iw} y1={y.s(t!.value)} y2={y.s(t!.value)} />
              <text class="ch-note" x={b.x0 + 4} y={y.s(t!.value) - b.y0 < 14 ? y.s(t!.value) + 13 : y.s(t!.value) - 5}>{cut(`${t!.label} ${fmtV(t!.value, props.unit)}`, b.iw / 2, 11.5)}</text>
            </Show>
            <For each={placed}>
              {(p) => (
                <g>
                  <line class="ch-event" x1={p.x} x2={p.x} y1={b.y0 - 4} y2={b.y0 + b.ih} />
                  <Show when={p.text}><text class="ch-note" x={p.lx} y={12 + p.row * 14}>{p.text}</text></Show>
                </g>
              )}
            </For>
            <For each={order}>
              {(l) => <path d={pathOf(l.values)} class="ch-line" classList={{ dash: !!l.dash, quiet: !!l.quiet || !!l.muted }} stroke={l.color} />}
            </For>
            <Show when={props.markers}>
              <For each={order}>
                {(l) => <For each={l.values}>{(v, i) => <Show when={ys(v) !== null}><circle class="ch-dot" cx={X.pos(i())} cy={ys(v)!} r={3.5} fill={l.color} /></Show>}</For>}
              </For>
            </Show>
            <For each={named}>{(l) => <circle class="ch-dot" cx={X.pos(lastIdx(l))} cy={ys(l.values[lastIdx(l)])!} r={4} fill={l.color} />}</For>
            <Show when={showEnds}>
              <For each={named}>
                {(l, k) => {
                  const lx = X.pos(lastIdx(l)) + 8;
                  const moved = Math.abs(gotY[k()] - wantY[k()]) > 3;
                  return (
                    <g>
                      <Show when={moved}><path class="ch-leader" d={`M${lx - 3},${wantY[k()]}L${lx + 3},${gotY[k()]}`} /></Show>
                      <text class="ch-end" x={lx + (moved ? 6 : 0)} y={gotY[k()]} dy="0.32em">{cut(endText(l), w - lx - 8)}</text>
                    </g>
                  );
                }}
              </For>
            </Show>
            <For each={pointEvs}>
              {(p) => (
                <g>
                  <circle class="ch-ring" cx={p.x} cy={p.y} r={6.5} />
                  <text class="ch-note" x={clamp(p.x, b.x0 + tw(p.text, 11.5) / 2, b.x0 + b.iw - tw(p.text, 11.5) / 2)} y={Math.max(11, p.y - 12)} text-anchor="middle">{p.text}</text>
                </g>
              )}
            </For>
            <Crosshair
              b={b}
              n={props.x.length}
              pos={X.pos}
              points={(i) => ls.filter((l) => ys(l.values[i]) !== null).map((l) => ({ x: X.pos(i), y: ys(l.values[i])!, color: l.color }))}
              tip={tipFor}
            />
          </>
        );
      }}
    </ChFrame>
  );
}

/** the series of a block as lines: fixed colours, emphasis greys the rest */
const toLines = (ss: Series[], wash?: number): LS[] => {
  const anyEm = ss.some((s) => s.em);
  return ss.map((s, i) => ({ label: s.label, values: s.values, color: colorOf(i, s.em, anyEm), dash: s.dash, muted: anyEm && !s.em, area: wash }));
};

const SALES_X = ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"];

defineViz({
  type: "line",
  family: "chart",
  title: "꺾은선",
  when: "값이 시간에 따라 어떻게 변했나, 여러 계열을 함께",
  render: (b: any) => {
    const d = normSeries(b);
    return <LinePlot label={str(b.label)} unit={str(b.unit) || undefined} x={d.x} lines={toLines(d.series)} log={!!b.log} target={b.target} events={b.events} markers={!!b.markers} curve={b.curve === "smooth" ? "smooth" : undefined} />;
  },
  examples: [
    {
      label: "월별 활성 사용자",
      unit: "명",
      x: SALES_X,
      series: [
        { label: "웹", values: [41200, 43800, 45100, 44300, 47900, 51200, 53800, 52600, 55900, 58400, 60100, 63500] },
        { label: "iOS", values: [22100, 23900, 26800, 29400, 31800, 33200, 36900, 38800, 40200, 43600, 45900, 48200] },
        { label: "안드로이드", values: [18300, 18900, 19400, 21800, 22900, 24100, 24800, 26900, 27300, 28800, 30400, 31900] },
      ],
      events: [{ x: "4월", label: "앱 개편" }, { x: "9월", label: "추석 캠페인" }],
      target: { value: 60000, label: "웹 목표" },
    },
    {
      label: "응답 시간 p95 (로그 축)",
      unit: "ms",
      log: true,
      markers: true,
      x: ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10"],
      series: [
        { label: "검색 API", values: [182, 176, 190, 2380, 1460, 240, 205, 198, 188, 181], em: true },
        { label: "결제 API", values: [96, 101, 94, 120, 110, 98, 102, 97, 95, 99] },
        { label: "로그인 API", values: [41, 39, 44, 46, 43, 40, 42, 39, 41, 40] },
      ],
      events: [{ x: "2026-10-04", label: "인덱스 재빌드", series: "검색 API" }],
    },
  ],
});

defineViz({
  type: "stepLine",
  family: "chart",
  title: "계단선",
  when: "값이 특정 시점에 한 번에 바뀌는 것(가격, 요금제, 설정값)이 언제 어떻게 바뀌었나",
  render: (b: any) => {
    const d = normSeries(b);
    return <LinePlot label={str(b.label)} unit={str(b.unit) || undefined} x={d.x} lines={toLines(d.series)} target={b.target} events={b.events} curve="step" />;
  },
  examples: [
    {
      label: "기준금리 변화",
      unit: "%",
      x: ["2022-01", "2022-04", "2022-07", "2022-10", "2023-01", "2023-07", "2024-01", "2024-10", "2024-11", "2025-02", "2025-05", "2026-01"],
      series: [{ label: "기준금리", values: [1.25, 1.5, 2.25, 3.0, 3.5, 3.5, 3.5, 3.25, 3.0, 2.75, 2.5, 2.5] }],
      events: [{ x: "2024-10", label: "인하 시작" }],
    },
  ],
});

defineViz({
  type: "area",
  family: "chart",
  title: "영역",
  when: "한 계열의 양이 시간에 따라 어떻게 쌓이고 줄었나 (계열은 1~3개)",
  render: (b: any) => {
    const d = normSeries(b);
    return <LinePlot label={str(b.label)} unit={str(b.unit) || undefined} x={d.x} lines={toLines(d.series.slice(0, 3), 0.1)} zero="always" target={b.target} events={b.events} curve={b.curve === "smooth" ? "smooth" : undefined} />;
  },
  examples: [
    {
      label: "일별 트래픽",
      unit: "GB",
      x: ["11/1", "11/2", "11/3", "11/4", "11/5", "11/6", "11/7", "11/8", "11/9", "11/10", "11/11", "11/12", "11/13", "11/14"],
      series: [{ label: "트래픽", values: [412, 398, 455, 470, 488, 362, 341, 430, 452, 515, 702, 560, 498, 476] }],
      events: [{ x: "11/11", label: "빼빼로데이 이벤트" }],
    },
  ],
});

// ───────────── stacked areas

function StackPlot(props: { b: any; mode: "stack" | "percent" | "stream" }) {
  const d = () => normSeries(props.b);
  const unit = () => str(props.b.unit) || undefined;
  const ss = () => d().series.slice(0, 9);
  return (
    <ChFrame
      label={str(props.b.label)}
      class="ch-stack"
      height={(w) => clamp(w * 0.5, 210, 300)}
      legend={ss().length > 1 ? ss().map((s, i) => ({ label: s.label, color: series(i) })) : undefined}
    >
      {(w, h) => {
        const mode = props.mode;
        const st = stackSeries(ss().map((s) => s.values), mode);
        const lo = Math.min(0, ...st.flat().map((p) => p[0]));
        const hi = Math.max(...st.flat().map((p) => p[1]), mode === "percent" ? 1 : 0);
        const top = 10, bottom = 26;
        const y = makeY([lo, hi || 1], top, h - bottom, { fmt: mode === "percent" ? (v) => `${Math.round(v * 100)}%` : undefined, count: mode === "percent" ? 4 : undefined });
        const x0 = mode === "stream" ? 8 : Math.ceil(y.width) + 10;
        const X = makeX(d().x, x0, w - 10);
        const b = box(x0, top, w - 10 - x0, h - top - bottom, w, h);
        const ys = mode === "percent" ? y.s : y.s;
        const cv = mode === "stream" ? curveMonotoneX : props.b.curve === "smooth" ? curveMonotoneX : curveLinear;
        const pathOf = (k: number) =>
          area<number>()
            .x((i) => X.pos(i))
            .y0((i) => ys(st[k][i][0]))
            .y1((i) => ys(st[k][i][1]))
            .curve(cv)(d().x.map((_, i) => i)) ?? "";
        const totals = d().x.map((_, i) => ss().reduce((n, s) => n + (s.values[i] ?? 0), 0));
        // a name inside its band, where the band is thickest and the text fits
        const inLabels = ss().map((s, k) => {
          let best = -1, th = 0;
          d().x.forEach((_, i) => {
            const t = ys(st[k][i][0]) - ys(st[k][i][1]);
            const edge = X.pos(i) - b.x0 > 30 && b.x0 + b.iw - X.pos(i) > 30;
            if (t > th && edge) (th = t), (best = i);
          });
          const text = cut(s.label, 110);
          const fits = best >= 0 && th >= 18 && tw(text) + 12 < Math.min(X.pos(best) - b.x0, b.x0 + b.iw - X.pos(best)) * 2;
          return fits ? { x: X.pos(best), y: (ys(st[k][best][0]) + ys(st[k][best][1])) / 2, text, color: series(k) } : null;
        });
        return (
          <>
            <Show when={mode !== "stream"} fallback={<line class="viz-base" x1={b.x0} x2={b.x0 + b.iw} y1={h - bottom + 0.5} y2={h - bottom + 0.5} />}>
              <YGrid y={y} x0={b.x0} x1={b.x0 + b.iw} />
            </Show>
            <XTicks ticks={X.ticks} y={h - 8} w={w} />
            <For each={ss()}>{(_, k) => <path class="ch-band" d={pathOf(k())} fill={series(k())} />}</For>
            <For each={inLabels}>{(l) => <Show when={l}><text class={inkOn(l!.color)} x={l!.x} y={l!.y} dy="0.32em" text-anchor="middle">{l!.text}</text></Show>}</For>
            <Crosshair
              b={b}
              n={d().x.length}
              pos={X.pos}
              points={(i) => ss().map((_, k) => ({ x: X.pos(i), y: ys(st[k][i][1]), color: series(k) }))}
              tip={(i) => (
                <TipBody
                  title={X.label(i)}
                  rows={ss()
                    .map((s, k) => ({ s, k }))
                    .reverse()
                    .map(({ s, k }) => ({
                      color: series(k),
                      key: "box" as const,
                      label: s.label,
                      value: mode === "percent" ? `${pct(((s.values[i] ?? 0) / (totals[i] || 1)) * 100)} · ${fmtV(s.values[i], unit())}` : fmtV(s.values[i], unit()),
                    }))}
                  foot={`합계 ${fmtV(totals[i], unit())}`}
                />
              )}
            />
          </>
        );
      }}
    </ChFrame>
  );
}

const CHANNEL = {
  x: ["2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"],
  series: [
    { label: "검색", values: [3120, 3340, 3010, 2980, 3260, 3410, 3380, 3290, 3150, 3070, 3360, 3520] },
    { label: "SNS", values: [1480, 1620, 1710, 1890, 2140, 2380, 2610, 2790, 3020, 3180, 3350, 3610] },
    { label: "직접 방문", values: [1910, 2050, 1880, 1840, 1920, 1960, 2010, 1980, 1950, 1990, 2040, 2110] },
    { label: "제휴", values: [620, 680, 590, 610, 720, 810, 790, 840, 880, 910, 960, 1020] },
  ],
};
defineViz({
  type: "stackedArea",
  family: "chart",
  title: "누적 영역",
  when: "전체 양과 그 구성이 시간에 따라 함께 어떻게 변했나",
  render: (b: any) => <StackPlot b={b} mode="stack" />,
  examples: [{ label: "유입 경로별 방문", unit: "명", ...CHANNEL }],
});
defineViz({
  type: "percentArea",
  family: "chart",
  title: "100% 누적 영역",
  when: "구성 비율이 시간에 따라 어떻게 바뀌었나 (전체 크기는 무시)",
  render: (b: any) => <StackPlot b={b} mode="percent" />,
  examples: [{ label: "유입 경로 비중", unit: "명", ...CHANNEL }],
});
defineViz({
  type: "stream",
  family: "chart",
  title: "스트림그래프",
  when: "여러 범주의 양이 시간에 따라 흐르듯 커지고 줄어드는 모양 (정확한 값보다 흐름)",
  render: (b: any) => <StackPlot b={b} mode="stream" />,
  examples: [
    {
      label: "장르별 주간 재생 수",
      unit: "회",
      x: ["1주", "2주", "3주", "4주", "5주", "6주", "7주", "8주", "9주", "10주", "11주", "12주", "13주", "14주"],
      series: [
        { label: "발라드", values: [820, 860, 910, 880, 840, 790, 760, 800, 870, 960, 1040, 1120, 1180, 1210] },
        { label: "힙합", values: [640, 700, 820, 980, 1120, 1260, 1310, 1250, 1130, 990, 880, 820, 790, 760] },
        { label: "K-팝", values: [1420, 1380, 1460, 1520, 1610, 1580, 1490, 1530, 1690, 1810, 1760, 1650, 1580, 1540] },
        { label: "인디", values: [310, 340, 360, 420, 480, 520, 610, 680, 720, 690, 640, 600, 580, 560] },
        { label: "OST", values: [260, 240, 230, 280, 360, 520, 710, 820, 760, 610, 480, 400, 350, 330] },
      ],
    },
  ],
});

// ───────────── forecast fan

defineViz({
  type: "fan",
  family: "chart",
  title: "예측 구간(팬 차트)",
  when: "앞으로 어떻게 될 것 같고, 그 불확실성 범위는 얼마인가",
  render: (b: any) => {
    const xs: X = arr<any>(b.x).map((v) => (isNum(v) ? v : str(v)));
    const n = xs.length;
    const pad = (v: unknown) => Array.from({ length: n }, (_, i) => toNum(arr(v)[i]));
    const actual = pad(b.values ?? b.actual);
    const fc = pad(b.forecast);
    // the forecast starts from the last actual point so the two lines meet
    const lastA = actual.reduce<number>((k, v, i) => (v !== null ? i : k), -1);
    if (lastA >= 0 && fc[lastA] === null && fc.some((v) => v !== null)) fc[lastA] = actual[lastA];
    const lo = pad(b.lo), hi = pad(b.hi), lo2 = pad(b.lo2), hi2 = pad(b.hi2);
    for (const [l, hh] of [[lo, hi], [lo2, hi2]] as const) if (lastA >= 0 && l[lastA] === null && l.some((v) => v !== null)) (l[lastA] = actual[lastA]), (hh[lastA] = actual[lastA]);
    const c = series(0);
    const bands = [
      ...(lo2.some((v) => v !== null) ? [{ lo: lo2, hi: hi2, color: c, opacity: 0.1, label: str(b.band2, "95% 구간") }] : []),
      ...(lo.some((v) => v !== null) ? [{ lo, hi, color: c, opacity: 0.2, label: str(b.band, "80% 구간") }] : []),
    ];
    const unit = str(b.unit) || undefined;
    return (
      <LinePlot
        label={str(b.label)}
        unit={unit}
        x={xs}
        zero="auto"
        target={b.target}
        events={b.events}
        ends="none"
        class="ch-fan"
        lines={[
          { label: str(b.actualLabel, "실적"), values: actual, color: c },
          { label: str(b.forecastLabel, "예측"), values: fc, color: c, dash: true },
        ]}
        bands={bands}
        legend={[{ label: str(b.actualLabel, "실적"), color: c }, { label: str(b.forecastLabel, "예측"), color: c, dash: true }, ...bands.map((bd) => ({ label: bd.label!, color: `color-mix(in srgb, ${c} ${bd.opacity === 0.1 ? 22 : 40}%, transparent)` }))]}
        extraTip={(i) => [
          ...(lo[i] !== null && hi[i] !== null && i !== lastA ? [{ label: str(b.band, "80% 구간"), value: `${fmtV(lo[i], unit)} ~ ${fmtV(hi[i], unit)}` }] : []),
          ...(lo2[i] !== null && hi2[i] !== null && i !== lastA ? [{ label: str(b.band2, "95% 구간"), value: `${fmtV(lo2[i], unit)} ~ ${fmtV(hi2[i], unit)}` }] : []),
        ]}
      />
    );
  },
  examples: [
    {
      label: "분기 매출 전망",
      unit: "억 원",
      x: ["24 1Q", "24 2Q", "24 3Q", "24 4Q", "25 1Q", "25 2Q", "25 3Q", "25 4Q", "26 1Q", "26 2Q", "26 3Q", "26 4Q"],
      values: [182, 195, 201, 228, 214, 231, 240, 262, null, null, null, null],
      forecast: [null, null, null, null, null, null, null, null, 251, 268, 279, 301],
      lo: [null, null, null, null, null, null, null, null, 240, 250, 255, 268],
      hi: [null, null, null, null, null, null, null, null, 262, 286, 303, 334],
      lo2: [null, null, null, null, null, null, null, null, 232, 238, 238, 245],
      hi2: [null, null, null, null, null, null, null, null, 270, 298, 320, 357],
    },
  ],
});

// ───────────── surplus / deficit

defineViz({
  type: "surplus",
  family: "chart",
  title: "흑자·적자 선",
  when: "값이 기준선보다 위였던 때와 아래였던 때, 그 크기",
  render: (b: any) => {
    const d = normSeries(b);
    const s = d.series[0] ?? { label: "값", values: [] };
    const base = toNum(b.base) ?? 0;
    const unit = str(b.unit) || undefined;
    const above = str(b.above, "기준 위"), below = str(b.below, "기준 아래");
    const id = `ch-sd-${++uid}`;
    return (
      <ChFrame label={str(b.label)} height={(w) => clamp(w * 0.46, 200, 280)} legend={[{ label: above, color: "var(--viz-div-p2)" }, { label: below, color: "var(--viz-div-n2)" }]}>
        {(w, h) => {
          const ext = extent([...s.values, base]);
          const y = makeY(valueDomain(ext, "always"), 10, h - 26, { unit });
          const x0 = Math.ceil(y.width) + 10;
          const X = makeX(d.x, x0, w - 10);
          const b0 = box(x0, 10, w - 10 - x0, h - 36, w, h);
          const yb = y.s(base);
          const idx = s.values.map((_, i) => i);
          const ar = area<number>().defined((i) => s.values[i] !== null).x((i) => X.pos(i)).y0(yb).y1((i) => y.s(s.values[i]!))(idx) ?? "";
          const ln = line<number>().defined((i) => s.values[i] !== null).x((i) => X.pos(i)).y((i) => y.s(s.values[i]!))(idx) ?? "";
          return (
            <>
              <defs>
                <clipPath id={`${id}-a`}><rect x={0} y={0} width={w} height={Math.max(0, yb)} /></clipPath>
                <clipPath id={`${id}-b`}><rect x={0} y={yb} width={w} height={Math.max(0, h - yb)} /></clipPath>
              </defs>
              <YGrid y={y} x0={b0.x0} x1={b0.x0 + b0.iw} zero={false} />
              <XTicks ticks={X.ticks} y={h - 8} w={w} />
              <path d={ar} fill="var(--viz-div-p2)" opacity="0.35" clip-path={`url(#${id}-a)`} />
              <path d={ar} fill="var(--viz-div-n2)" opacity="0.35" clip-path={`url(#${id}-b)`} />
              <line class="viz-base" x1={b0.x0} x2={b0.x0 + b0.iw} y1={yb} y2={yb} />
              <path d={ln} class="ch-line" stroke="var(--ink-2)" style={{ "stroke-width": "1.5px" }} />
              <Crosshair
                b={b0}
                n={d.x.length}
                pos={X.pos}
                points={(i) => (s.values[i] !== null ? [{ x: X.pos(i), y: y.s(s.values[i]!), color: s.values[i]! >= base ? "var(--viz-div-p2)" : "var(--viz-div-n2)" }] : [])}
                tip={(i) => (
                  <TipBody
                    title={X.label(i)}
                    rows={[{ label: s.label, value: fmtV(s.values[i], unit) }, ...(s.values[i] !== null ? [{ label: s.values[i]! >= base ? above : below, value: fmtV(Math.abs(s.values[i]! - base), unit) }] : [])]}
                  />
                )}
              />
            </>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "월별 무역수지",
      unit: "억 달러",
      above: "흑자",
      below: "적자",
      x: ["24.11", "24.12", "25.1", "25.2", "25.3", "25.4", "25.5", "25.6", "25.7", "25.8", "25.9", "25.10", "25.11", "25.12", "26.1", "26.2"],
      values: [56, 64, -19, 42, 48, 49, 69, 91, 65, 66, 95, 60, 97, 122, 87, -6],
    },
  ],
});

// ───────────── cumulative and burn charts

defineViz({
  type: "cumulative",
  family: "chart",
  title: "누적 합계",
  when: "기간마다 더해진 값이 지금까지 모두 얼마가 되었나, 목표까지 얼마 남았나",
  render: (b: any) => {
    const d = normSeries(b);
    const unit = str(b.unit) || undefined;
    const lines = toLines(d.series).map((l, k) => ({ ...l, values: cumulate(d.series[k].values), note: (i: number) => (d.series[k].values[i] !== null ? `(+${fmtV(d.series[k].values[i], unit)})` : "") }));
    return <LinePlot label={str(b.label)} unit={unit} x={d.x} lines={lines} zero="always" target={b.target} events={b.events} curve="linear" />;
  },
  examples: [
    {
      label: "올해 누적 가입자",
      unit: "명",
      x: SALES_X.slice(0, 10),
      series: [
        { label: "2026년", values: [1820, 1640, 2210, 2480, 2390, 2710, 3020, 2860, 3340, 3510] },
        { label: "2025년", values: [1420, 1380, 1690, 1720, 1810, 1950, 2140, 2080, 2230, 2310] },
      ],
      target: { value: 30000, label: "연간 목표" },
    },
  ],
});

function Burn(props: { b: any; mode: "up" | "down" }) {
  const b = props.b;
  const xs: X = arr<any>(b.x).map((v) => (isNum(v) ? v : str(v)));
  const n = Math.max(xs.length, arr(b.done).length, arr(b.remaining).length, arr(b.scope).length);
  const x = xs.length >= n ? xs : Array.from({ length: n }, (_, i) => xs[i] ?? `${i + 1}일`);
  const at = (v: unknown, i: number) => toNum(arr(v)[i]);
  const unit = str(b.unit) || undefined;
  const scope = x.map((_, i) => at(b.scope, i));
  // scope carries forward over days it wasn't given
  for (let i = 1; i < n; i++) if (scope[i] === null && scope[i - 1] !== null) scope[i] = scope[i - 1];
  const done = x.map((_, i) => at(b.done, i));
  let main: (number | null)[];
  if (props.mode === "down") main = Array.isArray(b.remaining) ? x.map((_, i) => at(b.remaining, i)) : done.map((v, i) => (v !== null && scope[i] !== null ? scope[i]! - v : null));
  else main = done;
  const lastMain = main.reduce<number>((k, v, i) => (v !== null ? i : k), -1);
  const first = main.findIndex((v) => v !== null);
  const startV = props.mode === "down" ? (main[first] ?? scope[0] ?? 0) : 0;
  const endV = props.mode === "down" ? 0 : (scope[n - 1] ?? scope.find((v) => v !== null) ?? 0);
  const ideal = b.ideal === false ? null : x.map((_, i) => startV + ((endV - startV) * i) / Math.max(1, n - 1));
  // projection at the pace so far
  let proj: (number | null)[] | null = null;
  if (b.projection !== false && lastMain > first && first >= 0 && lastMain < n - 1) {
    const pace = (main[lastMain]! - main[first]!) / (lastMain - first);
    proj = x.map((_, i) => (i < lastMain ? null : Math.max(0, main[lastMain]! + pace * (i - lastMain))));
  }
  const lines: LS[] = [
    ...(ideal ? [{ label: "계획", values: ideal, color: "var(--viz-muted)", dash: true, quiet: true } as LS] : []),
    ...(props.mode === "up" && scope.some((v) => v !== null) ? [{ label: "전체 범위", values: scope, color: series(1) } as LS] : []),
    { label: props.mode === "down" ? "남은 일" : "완료", values: main, color: series(0) },
    ...(proj ? [{ label: "현재 속도", values: proj, color: series(0), dash: true, quiet: true } as LS] : []),
  ];
  return <LinePlot label={str(b.label)} unit={unit} x={x} lines={lines} zero="always" events={b.events} ends="none" />;
}
const SPRINT_X = ["11/3", "11/4", "11/5", "11/6", "11/7", "11/10", "11/11", "11/12", "11/13", "11/14"];
defineViz({
  type: "burnup",
  family: "chart",
  title: "번업 차트",
  when: "완료한 일이 늘어나는 속도로 전체 범위를 언제 다 끝낼까 (범위가 바뀌어도 보임)",
  render: (b: any) => <Burn b={b} mode="up" />,
  examples: [
    {
      label: "스프린트 24 진행",
      unit: "pt",
      x: SPRINT_X,
      scope: [40, 40, 40, 44, 44, 44, 48, 48, 48, 48],
      done: [0, 3, 8, 11, 15, 19, 22, null, null, null],
      events: [{ x: "11/6", label: "결제 이슈 추가" }],
    },
  ],
});
defineViz({
  type: "burndown",
  family: "chart",
  title: "번다운 차트",
  when: "남은 일이 계획대로 줄고 있나, 이 속도면 마감에 끝나나",
  render: (b: any) => <Burn b={b} mode="down" />,
  examples: [{ label: "스프린트 24 남은 일", unit: "pt", x: SPRINT_X, remaining: [40, 38, 33, 33, 29, 25, 26, null, null, null] }],
});

// ───────────── small multiples

defineViz({
  type: "smallMultiples",
  family: "chart",
  title: "작은 여러 그래프",
  when: "계열이 많을 때 각각의 추이를 같은 눈금으로 나란히 비교",
  render: (b: any) => {
    const d = normSeries(b);
    const unit = str(b.unit) || undefined;
    const ss = d.series.slice(0, 24);
    const ext = extent(ss.flatMap((s) => s.values));
    const dom = valueDomain(ext, b.zero === false ? "auto" : "always");
    const colsOf = (w: number) => clamp(toNum(b.cols) ?? (w < 460 ? 2 : w < 700 ? 3 : 4), 1, 6);
    const PH = 92, HEAD = 26, GAP = 16;
    const height = (w: number) => {
      const c = colsOf(w);
      return Math.ceil(ss.length / c) * (PH + HEAD + GAP) + 6;
    };
    return (
      <ChFrame label={str(b.label)} class="ch-lines" height={height}>
        {(w) => {
          const c = colsOf(w);
          const y = makeY(dom, 0, PH, { unit, count: 2 });
          const lx0 = Math.ceil(y.width) + 8;
          const pw = (w - lx0 - GAP * (c - 1)) / c;
          return (
            <For each={ss}>
              {(s, k) => {
                const col = k() % c, row = Math.floor(k() / c);
                const ox = lx0 + col * (pw + GAP), oy = row * (PH + HEAD + GAP);
                const X = makeX(d.x, ox + 2, ox + pw - 4);
                const last = [...s.values].reverse().find((v) => v !== null) ?? null;
                const yy = (v: number) => oy + HEAD + y.s(v);
                const ln = (vals: (number | null)[]) => line<number>().defined((i) => vals[i] !== null).x((i) => X.pos(i)).y((i) => yy(vals[i]!))(vals.map((_, i) => i)) ?? "";
                const b0 = box(ox, oy + HEAD, pw - 4, PH, w, 0);
                const lastV = fmtV(last, unit);
                return (
                  <g>
                    <text class="ch-panel-title" x={ox} y={oy + 12}>{cut(s.label, pw - tw(lastV) - 12, FS, 500)}</text>
                    <text class="ch-val" x={ox + pw - 4} y={oy + 12} text-anchor="end">{lastV}</text>
                    <g class="viz-axis">
                      <For each={y.ticks}>
                        {(t) => (
                          <>
                            <line class={t === 0 ? "viz-base" : "viz-grid"} x1={ox} x2={ox + pw - 4} y1={Math.round(yy(t)) + 0.5} y2={Math.round(yy(t)) + 0.5} />
                            <Show when={col === 0}><text x={ox - 6} y={yy(t)} dy="0.32em" text-anchor="end">{y.fmt(t)}</text></Show>
                          </>
                        )}
                      </For>
                    </g>
                    <For each={ss.filter((o) => o !== s)}>{(o) => <path d={ln(o.values)} class="ch-ghost" />}</For>
                    <path d={ln(s.values)} class="ch-line" stroke={series(0)} />
                    <Crosshair b={b0} n={d.x.length} pos={X.pos} points={(i) => (s.values[i] !== null ? [{ x: X.pos(i), y: yy(s.values[i]!), color: series(0) }] : [])} tip={(i) => <TipBody title={`${s.label} · ${X.label(i)}`} rows={[{ label: "", value: fmtV(s.values[i], unit) }]} />} />
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
      label: "지역별 주간 주문 수",
      unit: "건",
      x: ["1주", "2주", "3주", "4주", "5주", "6주", "7주", "8주", "9주", "10주"],
      series: [
        { label: "서울", values: [3420, 3510, 3380, 3620, 3790, 3840, 3710, 3960, 4120, 4230] },
        { label: "경기", values: [2810, 2870, 2950, 3010, 2980, 3120, 3240, 3310, 3290, 3420] },
        { label: "부산", values: [1240, 1210, 1190, 1260, 1230, 1180, 1150, 1140, 1120, 1090] },
        { label: "대구", values: [880, 910, 940, 920, 960, 990, 1010, 1040, 1080, 1110] },
        { label: "인천", values: [1020, 1050, 1110, 1080, 1130, 1170, 1150, 1190, 1240, 1260] },
        { label: "광주·전남 지역", values: [640, 620, 650, 700, 760, 820, 870, 910, 960, 1010] },
      ],
    },
  ],
});
