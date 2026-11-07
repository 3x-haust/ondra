// Uncertainty and effects: how sure, how big, and is the difference real.
//   errorbars · forest · funnelPlot · signif
import { createMemo, For, Show } from "solid-js";
import { defineViz } from "../registry";
import { arr, col, ColPlot, Dot, ell, fix, Nearest, Plot, RowPlot, SM, str, Tip, tw, withU } from "./common";
import { BoxMark, boxTip, groupsWithStats } from "./dist";
import { extent, isNum, logDomain, pooled, pText, stars, toNum } from "./math";
import { rnorm } from "./sample";

/** a bar rounded at its data end (4px), square at the baseline */
export function barPath(x: number, y0: number, y1: number, w: number, r = 4): string {
  const up = y1 < y0, h = Math.abs(y1 - y0), rr = Math.min(r, w / 2, h);
  if (h < 0.5) return "";
  return up
    ? `M${x},${y0}V${y1 + rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 + rr}V${y0}Z`
    : `M${x},${y0}V${y1 - rr}Q${x},${y1} ${x + rr},${y1}H${x + w - rr}Q${x + w},${y1} ${x + w},${y1 - rr}V${y0}Z`;
}

type Err = "sd" | "se" | "ci";
const ERR: Record<Err, string> = { sd: "표준편차", se: "표준오차", ci: "95% 신뢰구간" };
interface EItem { label: string; value: number; sd?: number; se?: number; lo?: number; hi?: number; n?: number; group?: string; em?: boolean }
/** the interval an item carries: explicit lo/hi, else value ± sd or se */
function intervalOf(i: EItem, err: Err): [number, number] | null {
  if (isNum(i.lo) && isNum(i.hi)) return [i.lo, i.hi];
  const e = err === "se" ? i.se ?? i.sd : err === "sd" ? i.sd ?? i.se : i.se !== undefined ? i.se * 1.96 : i.sd;
  return isNum(e) ? [i.value - e, i.value + e] : null;
}
const itemsOf = (b: any): EItem[] =>
  arr<any>(b.items).filter((i) => i && isNum(toNum(i.value ?? i.mean))).map((i, k) => ({
    label: str(i.label) || `${k + 1}`, value: toNum(i.value ?? i.mean), sd: num0(i.sd), se: num0(i.se), lo: num0(i.lo ?? i.ci?.[0]), hi: num0(i.hi ?? i.ci?.[1]), n: num0(i.n), group: str(i.group) || undefined, em: !!(i.em ?? i.highlight),
  }));
const num0 = (v: unknown) => (isNum(toNum(v)) ? toNum(v) : undefined);
const errOf = (b: any): Err => (b.err === "se" || b.err === "ci" || b.err === "sd" ? b.err : arr<any>(b.items).some((i) => i?.lo !== undefined || i?.ci) ? "ci" : arr<any>(b.items).some((i) => i?.se !== undefined) ? "se" : "sd");

/** categories × groups, dodged inside each band */
function layoutOf(items: EItem[]) {
  const cats: string[] = [], groups: string[] = [];
  for (const i of items) {
    if (!cats.includes(i.label)) cats.push(i.label);
    if (i.group && !groups.includes(i.group)) groups.push(i.group);
  }
  return { cats, groups: groups.slice(0, 8) };
}

interface EbB { label?: string; unit?: string; y?: string; err?: Err; mode?: "bar" | "dot"; connect?: boolean; items?: EItem[]; pairs?: { a: string; b: string; p?: number; text?: string }[] }
/** bars or dots with error whiskers; shared by errorbars and signif */
function MeanErr(b: EbB & { brackets?: boolean }) {
  const items = () => itemsOf(b);
  const L = createMemo(() => layoutOf(items()));
  const err = () => errOf(b);
  const mode = () => (b.mode === "dot" || b.connect ? "dot" : b.mode === "bar" ? "bar" : b.brackets ? "bar" : "dot");
  const vals = () => items().flatMap((i) => [i.value, ...(intervalOf(i, err()) ?? [])]);
  const dom = (): [number, number] => {
    const [lo, hi] = extent(vals(), 0.08);
    return mode() === "bar" ? [Math.min(0, lo), Math.max(0, hi)] : [lo, hi];
  };
  const pairs = () => arr<any>(b.pairs).filter((p) => p && L().cats.includes(str(p.a)) && L().cats.includes(str(p.b)) && p.a !== p.b);
  const levels = () => stackLevels(pairs().map((p) => [L().cats.indexOf(str(p.a)), L().cats.indexOf(str(p.b))]));
  const legend = () => [...L().groups.map((g, i) => ({ label: g, color: col(i) })), ...(L().groups.length > 1 ? [] : [])];
  return (
    <Show when={items().length}>
      <ColPlot label={b.label} legend={L().groups.length > 1 ? legend() : undefined} cats={L().cats} y={{ domain: dom(), title: b.y ?? (b.unit ? `(${b.unit})` : undefined) }} pad={{ t: b.brackets ? Math.max(...levels().map((l) => l + 1), 0) * 22 : 0 }} bandPad={0.28}>
        {(c) => {
          const ng = () => Math.max(1, L().groups.length);
          const slot = () => c.band / ng();
          const bw = () => Math.min(24, slot() * 0.7);
          const xOf = (i: EItem) => c.colX(L().cats.indexOf(i.label)) - c.band / 2 + slot() * (Math.max(0, L().groups.indexOf(i.group ?? "")) + 0.5);
          const colorOf = (i: EItem) => (items().some((x) => x.em) && !i.em ? "var(--viz-other)" : col(Math.max(0, L().groups.indexOf(i.group ?? ""))));
          const tip = (i: EItem) => {
            const iv = intervalOf(i, err());
            return `${withU(fix(i.value), b.unit)}${iv ? `\n${ERR[err()]} ${fix(iv[0])} – ${fix(iv[1])}` : ""}\n${i.label}${i.group ? ` · ${i.group}` : ""}${i.n ? `\nn = ${i.n}` : ""}`;
          };
          // the top of each column's marks, for brackets
          const tops = () => L().cats.map((cat) => Math.min(c.y0 + c.ih, ...items().filter((i) => i.label === cat).map((i) => c.Y(Math.max(i.value, intervalOf(i, err())?.[1] ?? i.value)))));
          return (
            <g>
              <Show when={b.connect && L().groups.length}>
                <For each={L().groups.length ? L().groups : [""]}>
                  {(g, k) => {
                    const pts = () => items().filter((i) => (i.group ?? "") === g).map((i) => `${xOf(i)},${c.Y(i.value)}`);
                    return <polyline class="st-line" style={{ stroke: col(k()), "stroke-width": 1.5, opacity: 0.8 }} points={pts().join(" ")} />;
                  }}
                </For>
              </Show>
              <For each={items()}>
                {(i) => {
                  const iv = () => intervalOf(i, err());
                  const x = () => xOf(i);
                  return (
                    <Tip tip={tip(i)}>
                      <Show when={mode() === "bar"}>
                        <path d={barPath(x() - bw() / 2, c.Y(0), c.Y(i.value), bw())} style={{ fill: colorOf(i) }} />
                        <rect x={x() - slot() / 2} y={c.y0} width={slot()} height={c.ih} fill="transparent" />
                      </Show>
                      <Show when={iv()}>
                        <line class="st-whisker" style={{ stroke: mode() === "bar" ? "var(--ink-2)" : colorOf(i) }} x1={x()} x2={x()} y1={c.Y(iv()![0])} y2={c.Y(iv()![1])} />
                        <line class="st-whisker" style={{ stroke: mode() === "bar" ? "var(--ink-2)" : colorOf(i) }} x1={x() - 4} x2={x() + 4} y1={c.Y(iv()![0])} y2={c.Y(iv()![0])} />
                        <line class="st-whisker" style={{ stroke: mode() === "bar" ? "var(--ink-2)" : colorOf(i) }} x1={x() - 4} x2={x() + 4} y1={c.Y(iv()![1])} y2={c.Y(iv()![1])} />
                      </Show>
                      <Show when={mode() === "dot"}><Dot x={x()} y={c.Y(i.value)} r={4.5} color={colorOf(i)} /></Show>
                    </Tip>
                  );
                }}
              </For>
              <Show when={b.brackets}>
                <Brackets pairs={pairs()} cats={L().cats} colX={c.colX} tops={tops()} minY={8} />
              </Show>
            </g>
          );
        }}
      </ColPlot>
    </Show>
  );
}
/** interval stacking: each pair gets the lowest level that doesn't overlap a shorter pair on it */
function stackLevels(spans: [number, number][]): number[] {
  const order = spans.map((s, i) => [Math.min(...s), Math.max(...s), i] as const).sort((a, b) => a[1] - a[0] - (b[1] - b[0]));
  const out = new Array(spans.length).fill(0);
  const used: [number, number, number][] = [];
  for (const [a, b, i] of order) {
    let lv = 0;
    while (used.some(([x, y, l]) => l === lv && !(b < x || a > y))) lv++;
    used.push([a, b, lv]);
    out[i] = lv;
  }
  return out;
}
/** significance brackets over columns, placed above whatever is under them */
function Brackets(props: { pairs: any[]; cats: string[]; colX: (i: number) => number; tops: number[]; minY: number }) {
  const placed = createMemo(() => {
    const top = [...props.tops];
    const spans = props.pairs.map((p) => {
      const a = props.cats.indexOf(str(p.a)), b = props.cats.indexOf(str(p.b));
      return { a: Math.min(a, b), b: Math.max(a, b), p };
    }).sort((x, y) => x.b - x.a - (y.b - y.a));
    return spans.map((s) => {
      const y = Math.max(props.minY + 14, Math.min(...top.slice(s.a, s.b + 1)) - 10);
      for (let k = s.a; k <= s.b; k++) top[k] = y - 16;
      const p = toNum(s.p.p);
      return { x1: props.colX(s.a), x2: props.colX(s.b), y, text: str(s.p.text) || stars(p), tip: `${s.p.a} vs ${s.p.b}${isNum(p) ? `\n${pText(p)}` : ""}` };
    });
  });
  return (
    <g>
      <For each={placed()}>
        {(k) => (
          <Tip tip={k.tip}>
            <path class="st-thin" style={{ stroke: "var(--ink-2)", "stroke-width": 1 }} d={`M${k.x1 + 2},${k.y + 5}V${k.y}H${k.x2 - 2}V${k.y + 5}`} />
            <text class="st-dl" x={(k.x1 + k.x2) / 2} y={k.y - 3} text-anchor="middle">{k.text}</text>
          </Tip>
        )}
      </For>
    </g>
  );
}

defineViz<EbB>({
  type: "errorbars",
  family: "stat",
  title: "오차 막대 (평균 ± SD/SE/CI)",
  when: "그룹별 평균과 그 불확실성, 두 요인의 상호작용",
  render: (b) => MeanErr(b),
  examples: [
    { label: "배치 크기별 처리량", unit: "req/s", y: "처리량 (req/s)", err: "sd", mode: "bar", items: [{ label: "16", value: 412, sd: 18, n: 5 }, { label: "32", value: 768, sd: 25, n: 5 }, { label: "64", value: 1290, sd: 61, n: 5 }, { label: "128", value: 1655, sd: 140, n: 5 }, { label: "256", value: 1702, sd: 210, n: 5 }] },
    {
      label: "복용량 × 성별 혈압 변화", unit: "mmHg", y: "수축기 혈압 변화 (mmHg)", err: "ci", connect: true,
      items: [
        { label: "위약", group: "남성", value: -1.2, lo: -3.4, hi: 1.0 }, { label: "10mg", group: "남성", value: -6.8, lo: -9.1, hi: -4.5 }, { label: "20mg", group: "남성", value: -11.3, lo: -13.9, hi: -8.7 },
        { label: "위약", group: "여성", value: -0.6, lo: -2.7, hi: 1.5 }, { label: "10mg", group: "여성", value: -4.1, lo: -6.4, hi: -1.8 }, { label: "20mg", group: "여성", value: -12.9, lo: -15.6, hi: -10.2 },
      ],
    },
  ],
});

// ───────────── significance brackets

interface SigB extends EbB { series?: { label: string; values: number[] }[] }
function Signif(b: SigB) {
  const boxes = () => groupsWithStats({ series: b.series }).filter((g) => g.values.length);
  return (
    <Show when={boxes().length} fallback={MeanErr({ ...b, brackets: true })}>
      <SigBoxes b={b} />
    </Show>
  );
}
function SigBoxes(props: { b: SigB }) {
  const gs = () => groupsWithStats({ series: props.b.series }).filter((g) => g.values.length);
  const cats = () => gs().map((g) => g.label);
  const pairs = () => arr<any>(props.b.pairs).filter((p) => p && cats().includes(str(p.a)) && cats().includes(str(p.b)) && p.a !== p.b);
  const levels = () => stackLevels(pairs().map((p) => [cats().indexOf(str(p.a)), cats().indexOf(str(p.b))]));
  return (
    <ColPlot label={props.b.label} cats={cats()} y={{ domain: extent(gs().flatMap((g) => [g.stats!.min, g.stats!.max]), 0.05), title: props.b.y ?? (props.b.unit ? `(${props.b.unit})` : undefined) }} pad={{ t: Math.max(0, ...levels().map((l) => l + 1)) * 22 }}>
      {(c) => {
        const half = () => Math.min(c.band * 0.3, 18);
        const g = { horiz: false, pv: (v: number) => c.Y(v), pc: (i: number) => c.colX(i), band: c.band, xy: (v: number, p: number) => [p, v] as [number, number], c };
        const tops = () => gs().map((x) => c.Y(Math.max(x.stats!.hi, ...x.stats!.outliers)) - 4);
        return (
          <g>
            <For each={gs()}>{(x, i) => <BoxMark g={g} i={i()} s={x.stats!} color={col(0)} half={half()} tip={boxTip(x, props.b.unit)} />}</For>
            <Brackets pairs={pairs()} cats={cats()} colX={c.colX} tops={tops()} minY={8} />
          </g>
        );
      }}
    </ColPlot>
  );
}
defineViz<SigB>({
  type: "signif",
  family: "stat",
  title: "유의성 표시 (p값 별표)",
  when: "그룹 간 차이가 통계적으로 유의한가 (막대·상자 위 괄호와 *)",
  render: Signif,
  examples: [
    { label: "처리별 세포 생존율", unit: "%", y: "생존율 (%)", err: "se", items: [{ label: "대조군", value: 92.4, se: 2.1, n: 6 }, { label: "약물 A", value: 71.8, se: 3.4, n: 6 }, { label: "약물 B", value: 54.2, se: 4.0, n: 6 }, { label: "A+B", value: 38.5, se: 3.1, n: 6 }], pairs: [{ a: "대조군", b: "약물 A", p: 0.0021 }, { a: "약물 A", b: "약물 B", p: 0.013 }, { a: "약물 B", b: "A+B", p: 0.041 }, { a: "대조군", b: "A+B", p: 0.00004 }] },
    { label: "교수법별 시험 점수", y: "점수", series: [{ label: "강의식", values: rnorm(40, 68, 9, 91, 0) }, { label: "토론식", values: rnorm(40, 73, 8, 92, 0) }, { label: "플립러닝", values: rnorm(40, 79, 7, 93, 0) }], pairs: [{ a: "강의식", b: "토론식", p: 0.08 }, { a: "토론식", b: "플립러닝", p: 0.004 }, { a: "강의식", b: "플립러닝", p: 0.0003 }] },
  ],
});

// ───────────── forest plot

interface FItem { label: string; value: number; lo: number; hi: number; weight?: number; n?: number; note?: string; em?: boolean }
interface ForestB { label?: string; x?: string; log?: boolean; null?: number; left?: string; right?: string; items?: FItem[]; pooled?: { label?: string; value: number; lo: number; hi: number; note?: string }; digits?: number }
function Forest(b: ForestB) {
  const items = () => arr<any>(b.items).filter((i) => i && [i.value, i.lo, i.hi].every((v) => isNum(toNum(v))) && (!b.log || (i.lo > 0 && i.value > 0))).map((i, k) => ({ label: str(i.label) || `${k + 1}`, value: +i.value, lo: +i.lo, hi: +i.hi, weight: num0(i.weight), n: num0(i.n), note: str(i.note) || (isNum(i.n) ? `n = ${i.n}` : undefined), em: !!i.em }));
  const pool = () => (b.pooled && [b.pooled.value, b.pooled.lo, b.pooled.hi].every(isNum) ? b.pooled : null);
  const rows = () => [...items().map((i) => i.label), ...(pool() ? [pool()!.label ?? "전체"] : [])];
  const nul = () => (isNum(b.null) ? b.null : b.log ? 1 : 0);
  const all = () => [...items().flatMap((i) => [i.lo, i.hi]), ...(pool() ? [pool()!.lo, pool()!.hi] : []), nul()];
  const dom = (): [number, number] => (b.log ? logDomain(all()) : extent(all(), 0.06));
  const txt = (v: number, lo: number, hi: number) => `${fix(v, b.digits ?? 2)} [${fix(lo, b.digits ?? 2)}, ${fix(hi, b.digits ?? 2)}]`;
  const maxW = () => Math.max(1e-9, ...items().map((i) => i.weight ?? 0));
  const colW = () => Math.max(...[...items(), ...(pool() ? [pool()!] : [])].map((i: any) => tw(txt(i.value, i.lo, i.hi), SM))) + 12;
  return (
    <Show when={items().length}>
          <RowPlot
            label={b.label} rows={rows()} rowH={items().some((i) => i.note) || pool()?.note ? 38 : 30} sub={(i) => (i < items().length ? items()[i].note : pool()?.note)}
            x={{ domain: dom(), log: b.log, title: b.x }} pad={(w) => ({ r: w >= 500 ? colW() : 0, b: b.left || b.right ? 18 : 0 })}
          >
            {(c) => {
              const wide = c.w >= 500;
              const sq = (i: FItem) => (i.weight ? 2.5 + Math.sqrt(i.weight / maxW()) * Math.min(5, c.band * 0.18) : 4.5);
              return (
                <g>
                  <line class="st-ref-solid" style={{ stroke: "var(--ink-3)" }} x1={c.X(nul())} x2={c.X(nul())} y1={c.y0} y2={c.y0 + c.ih} />
                  <Show when={pool()}><line class="st-ref" x1={c.X(pool()!.value)} x2={c.X(pool()!.value)} y1={c.y0} y2={c.y0 + c.ih} /></Show>
                  <For each={items()}>
                    {(i, k) => (
                      <Tip tip={`${txt(i.value, i.lo, i.hi)}\n${i.label}${i.weight ? `\n가중치 ${fix(i.weight)}%` : ""}${i.n ? `\nn = ${i.n}` : ""}`}>
                        <rect x={c.x0} y={c.rowY(k()) - c.band / 2} width={c.iw} height={c.band} fill="transparent" />
                        <line class="st-whisker" style={{ stroke: "var(--ink-2)" }} x1={Math.max(c.x0, c.X(i.lo))} x2={Math.min(c.x0 + c.iw, c.X(i.hi))} y1={c.rowY(k())} y2={c.rowY(k())} />
                        <rect x={c.X(i.value) - sq(i)} y={c.rowY(k()) - sq(i)} width={sq(i) * 2} height={sq(i) * 2} rx={1} style={{ fill: i.em ? col(1) : col(0) }} />
                      </Tip>
                    )}
                  </For>
                  <Show when={pool()}>
                    {(p) => {
                      const y = () => c.rowY(items().length);
                      return (
                        <Tip tip={`${txt(p().value, p().lo, p().hi)}\n${p().label ?? "전체"}`}>
                          <path d={`M${c.X(p().lo)},${y()}L${c.X(p().value)},${y() - 7}L${c.X(p().hi)},${y()}L${c.X(p().value)},${y() + 7}Z`} style={{ fill: "var(--ink-2)" }} />
                        </Tip>
                      );
                    }}
                  </Show>
                  <Show when={wide}>
                    <For each={[...items(), ...(pool() ? [pool()!] : [])] as any[]}>
                      {(i, k) => <text class="st-cell-v" classList={{ "st-strong": k() === items().length }} x={c.x0 + c.iw + 14} y={c.rowY(k())} dy="0.32em">{txt(i.value, i.lo, i.hi)}</text>}
                    </For>
                  </Show>
                  <Show when={b.left}><text class="st-mute" x={c.X(nul()) - 6} y={c.y0 + c.ih + 52} text-anchor="end">{ell(`← ${b.left}`, c.X(nul()) - c.x0 + 30, SM)}</text></Show>
                  <Show when={b.right}><text class="st-mute" x={c.X(nul()) + 6} y={c.y0 + c.ih + 52} text-anchor="start">{ell(`${b.right} →`, c.x0 + c.iw - c.X(nul()) + 10, SM)}</text></Show>
                </g>
              );
            }}
          </RowPlot>
    </Show>
  );
}

defineViz<ForestB>({
  type: "forest",
  family: "stat",
  title: "포레스트 플롯",
  when: "여러 연구·하위집단의 효과 크기와 신뢰구간, 합친 결과",
  render: Forest,
  examples: [
    {
      label: "운동 중재의 우울 점수 효과 (메타분석)", x: "표준화 평균차 (SMD)", left: "운동 우세", right: "대조 우세",
      items: [
        { label: "김 외 (2019)", value: -0.42, lo: -0.78, hi: -0.06, weight: 14.2, n: 120 }, { label: "Park et al. (2020)", value: -0.31, lo: -0.59, hi: -0.03, weight: 19.8, n: 196 },
        { label: "이 외 (2020)", value: -0.65, lo: -1.21, hi: -0.09, weight: 7.1, n: 52 }, { label: "Choi & Han (2021)", value: 0.05, lo: -0.33, hi: 0.43, weight: 13.0, n: 108 },
        { label: "정 외 (2022)", value: -0.27, lo: -0.48, hi: -0.06, weight: 26.4, n: 352 }, { label: "Yoon et al. (2023)", value: -0.51, lo: -0.86, hi: -0.16, weight: 19.5, n: 132 },
      ],
      pooled: { label: "전체 (랜덤효과)", value: -0.31, lo: -0.45, hi: -0.17, note: "I² = 21%" },
    },
    { label: "하위집단별 오즈비", x: "오즈비 (로그 척도)", log: true, items: [{ label: "65세 이상", value: 1.84, lo: 1.21, hi: 2.8, note: "n = 412" }, { label: "65세 미만", value: 1.22, lo: 0.94, hi: 1.58, note: "n = 1,036" }, { label: "당뇨 있음", value: 2.31, lo: 1.42, hi: 3.76, note: "n = 233" }, { label: "당뇨 없음", value: 1.17, lo: 0.92, hi: 1.49, note: "n = 1,215" }], pooled: { label: "전체", value: 1.38, lo: 1.14, hi: 1.67 } },
  ],
});

// ───────────── funnel plot

interface FunB { label?: string; x?: string; log?: boolean; pooled?: number; items?: { label?: string; value: number; se: number }[] }
function Funnel(b: FunB) {
  const items = () => arr<any>(b.items).filter((i) => i && isNum(toNum(i.value)) && toNum(i.se) > 0 && (!b.log || i.value > 0)).map((i, k) => ({ label: str(i.label) || `연구 ${k + 1}`, value: +i.value, se: +i.se }));
  // on a log axis (odds/risk ratios) the funnel is symmetric in log space
  const tx = (v: number) => (b.log ? Math.log(v) : v);
  const ux = (v: number) => (b.log ? Math.exp(v) : v);
  const centre = () => (isNum(b.pooled) ? tx(b.pooled) : pooled(items().map((i) => ({ value: tx(i.value), se: i.se })))?.value ?? 0);
  const seMax = () => Math.max(...items().map((i) => i.se)) * 1.1;
  const xs = () => [...items().map((i) => i.value), ux(centre() - 1.96 * seMax()), ux(centre() + 1.96 * seMax())];
  return (
    <Show when={items().length}>
      <Plot label={b.label} height={(w) => Math.min(360, Math.max(240, w * 0.6))} x={{ domain: b.log ? [Math.min(...xs()), Math.max(...xs())] : extent(xs(), 0.04), log: b.log, title: b.x, nice: !b.log }} y={{ domain: [seMax(), 0], title: "표준오차", nice: false, fmt: (v) => fix(v) }}>
        {(c) => {
          const pts = () => items().map((i) => ({ x: c.X(i.value), y: c.Y(i.se), color: col(0), tip: `${i.label}\n효과 ${fix(i.value)}\nSE ${fix(i.se)}` }));
          return (
            <g>
              <path style={{ fill: "var(--ink-3)", "fill-opacity": 0.06 }} d={`M${c.X(ux(centre()))},${c.Y(0)}L${c.X(ux(centre() - 1.96 * seMax()))},${c.Y(seMax())}L${c.X(ux(centre() + 1.96 * seMax()))},${c.Y(seMax())}Z`} />
              <path class="st-ref" d={`M${c.X(ux(centre() - 1.96 * seMax()))},${c.Y(seMax())}L${c.X(ux(centre()))},${c.Y(0)}L${c.X(ux(centre() + 1.96 * seMax()))},${c.Y(seMax())}`} />
              <line class="st-ref-solid" style={{ stroke: "var(--ink-3)" }} x1={c.X(ux(centre()))} x2={c.X(ux(centre()))} y1={c.Y(0)} y2={c.Y(seMax())} />
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={4} style={{ fill: p.color, "fill-opacity": 0.8, stroke: "var(--viz-gap)", "stroke-width": 1.5 }} />}</For>
              <Nearest pts={pts()} box={c} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<FunB>({
  type: "funnelPlot",
  family: "stat",
  title: "깔때기 그림 (메타분석)",
  when: "작은 연구일수록 효과가 한쪽으로 치우치나 (출판 편향)",
  render: Funnel,
  examples: [
    {
      label: "연구별 효과와 정밀도", x: "로그 오즈비",
      items: [0.12, 0.31, -0.05, 0.42, 0.28, 0.19, 0.55, 0.61, 0.24, 0.35, 0.72, 0.09, 0.47, 0.83, 0.3, 0.26, 0.38, 0.95].map((v, i) => ({ label: `연구 ${i + 1}`, value: v, se: [0.08, 0.11, 0.14, 0.18, 0.09, 0.12, 0.24, 0.27, 0.1, 0.15, 0.31, 0.13, 0.2, 0.36, 0.07, 0.16, 0.21, 0.41][i] })),
    },
  ],
});
