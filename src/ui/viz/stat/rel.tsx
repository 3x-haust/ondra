// Relationships between two (or a few) measures.
//   scatter · splom · hexbin · density2d · residual · blandAltman
import { contourDensity } from "d3-contour";
import { geoPath } from "d3-geo";
import { area, line } from "d3-shape";
import { createMemo, For, Show } from "solid-js";
import { Frame, seq, useTip } from "../kit";
import { defineViz } from "../registry";
import { arr, col, ell, fix, Nearest, Plot, RefLines, refsOf, ScaleKey, SEQ_STOPS, SM, str, Tip, tw, withU, type Ctx } from "./common";
import { clamp, extent, hexbin, linreg, loess, logDomain, mean, placeLabels, sd, toNum, type Pt } from "./math";
import { rnorm } from "./sample";
import { t } from "../../../i18n";

type P = { x: number; y: number; label?: string; em?: boolean };
/** points from [[x,y]], [[x,y,"label"]] or [{x,y,label}] */
export function pointsOf(v: unknown): P[] {
  return arr<any>(v).map((p): P | null => (Array.isArray(p) ? { x: toNum(p[0]), y: toNum(p[1]), label: str(p[2]) || undefined } : p && typeof p === "object" ? { x: toNum(p.x), y: toNum(p.y), label: str(p.label) || undefined, em: !!(p.em ?? p.highlight) } : null))
    .filter((p): p is P => !!p && Number.isFinite(p.x) && Number.isFinite(p.y));
}
export function seriesOf(b: any, max = 8): { label: string; pts: P[] }[] {
  const s = arr<any>(b.series).filter((x) => x && typeof x === "object").map((x, i) => ({ label: str(x.label) || `${i + 1}`, pts: pointsOf(x.points ?? x.values) }));
  const one = pointsOf(b.points);
  return (s.length ? s : one.length ? [{ label: str(b.name) || t("관측치"), pts: one }] : []).filter((x) => x.pts.length).slice(0, max);
}
const xTitle = (b: any) => str(b.x) || undefined;
const yTitle = (b: any) => str(b.y) || undefined;
const domOf = (vals: number[], log?: boolean): [number, number] => (log ? logDomain(vals) : extent(vals, 0.05));

/** labelled points: direct labels where they fit, the rest in the tip */
function PointLabels(props: { c: Ctx; pts: { x: number; y: number; label: string }[] }) {
  const placed = createMemo(() => {
    const items = props.pts.map((p) => ({ x: p.x, y: p.y, w: tw(p.label, SM) + 2, h: 14 }));
    const dots = props.pts.map((p) => ({ x: p.x - 5, y: p.y - 5, w: 10, h: 10 }));
    return placeLabels(items, { x: props.c.x0, y: props.c.y0, w: props.c.iw, h: props.c.ih }, dots, 5);
  });
  return (
    <g>
      <For each={props.pts}>{(p, i) => <Show when={placed()[i()]}>{(r) => <text class="st-dl" x={r().x + 1} y={r().y + 11}>{p.label}</text>}</Show>}</For>
    </g>
  );
}

// ───────────── scatter

interface ScatterB { label?: string; x?: string; y?: string; unit?: string; logx?: boolean; logy?: boolean; fit?: "linear" | "loess" | "none"; ci?: boolean; span?: number; points?: unknown[]; series?: { label: string; points: unknown[] }[]; refs?: { x?: number; y?: number; label?: string }[] }
function Scatter(b: ScatterB) {
  const S = () => seriesOf(b, 3);
  const all = () => S().flatMap((s) => s.pts);
  const fit = () => (b.fit === "linear" || b.fit === "loess" ? b.fit : "none");
  const fits = createMemo(() => S().map((s) => {
    const pts: Pt[] = s.pts.map((p) => [b.logx ? Math.log10(p.x) : p.x, b.logy ? Math.log10(p.y) : p.y]).filter((p) => p.every(Number.isFinite)) as Pt[];
    return { lin: fit() === "linear" ? linreg(pts) : null, lo: fit() === "loess" ? loess(pts, clamp(b.span ?? 0.75, 0.2, 1)) : [] };
  }));
  const one = () => S().length === 1;
  const fitColor = (k: number) => (one() ? "var(--ink-2)" : col(k));
  const legend = () => {
    const l = S().map((s, i) => ({ label: s.label, color: col(i) }));
    if (fit() === "none") return l;
    if (one()) {
      const f = fits()[0];
      return [...l, { label: f.lin ? t("선형 적합 · R² {v}", { v: fix(f.lin.r2, 2) }) : t("LOESS 평활"), color: "var(--ink-2)", dash: false }];
    }
    return S().map((s, i) => ({ label: fits()[i].lin ? `${s.label} · R² ${fix(fits()[i].lin!.r2, 2)}` : s.label, color: col(i) }));
  };
  const ux = (v: number) => (b.logx ? 10 ** v : v), uy = (v: number) => (b.logy ? 10 ** v : v);
  return (
    <Show when={all().length}>
      <Plot label={b.label} legend={legend()} x={{ domain: domOf(all().map((p) => p.x), b.logx), log: b.logx, title: xTitle(b), grid: true, nice: !b.logx }} y={{ domain: domOf(all().map((p) => p.y), b.logy), log: b.logy, title: yTitle(b) }}>
        {(c) => {
          const pts = () => S().flatMap((s, k) => s.pts.map((p) => ({ x: c.X(p.x), y: c.Y(p.y), color: col(k), r: 4, label: p.label, em: p.em, tip: `${p.label ? p.label + "\n" : ""}${fix(p.x)}, ${withU(fix(p.y), b.unit)}${S().length > 1 ? `\n${s.label}` : ""}` })));
          const xr = () => extent(all().map((p) => (b.logx ? Math.log10(p.x) : p.x)));
          const grid = () => Array.from({ length: 41 }, (_, i) => xr()[0] + ((xr()[1] - xr()[0]) * i) / 40);
          return (
            <g>
              <For each={fits()}>
                {(f, k) => (
                  <g>
                    <Show when={f.lin && b.ci !== false}>
                      <path class="st-band" style={{ fill: fitColor(k()) }} d={area<number>().x((x) => c.X(ux(x))).y0((x) => c.Y(uy(f.lin!.icpt + f.lin!.slope * x - f.lin!.band(x)))).y1((x) => c.Y(uy(f.lin!.icpt + f.lin!.slope * x + f.lin!.band(x))))(grid()) ?? ""} />
                    </Show>
                    <Show when={f.lin}><path class="st-line" style={{ stroke: fitColor(k()) }} d={line<number>().x((x) => c.X(ux(x))).y((x) => c.Y(uy(f.lin!.icpt + f.lin!.slope * x)))(grid()) ?? ""} /></Show>
                    <Show when={f.lo.length}><path class="st-line" style={{ stroke: fitColor(k()) }} d={line<Pt>().x((p) => c.X(ux(p[0]))).y((p) => c.Y(uy(p[1])))(f.lo) ?? ""} /></Show>
                  </g>
                )}
              </For>
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={p.em ? 5 : 3.5} style={{ fill: p.color, "fill-opacity": p.em ? 1 : all().length > 150 ? 0.45 : 0.75, stroke: "var(--viz-gap)", "stroke-width": 1 }} />}</For>
              <RefLines refs={refsOf(b.refs)} c={c} />
              <PointLabels c={c} pts={pts().filter((p) => p.label && (p.em || pts().filter((q) => q.label).length <= 12)) as any} />
              <Nearest pts={pts()} box={c} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<ScatterB>({
  type: "scatter",
  family: "stat",
  title: "산점도 + 회귀선",
  when: "두 변수가 함께 움직이나, 그 관계가 직선인가 곡선인가",
  render: Scatter,
  examples: [
    (() => {
      const x = rnorm(80, 32, 9, 101, 1);
      const e = rnorm(80, 0, 4.5, 102, 1);
      return { label: "광고비와 신규 가입자", x: "광고비 (백만 원)", y: "신규 가입자 (백 명)", fit: "linear" as const, points: x.map((v, i) => [v, +(4 + 0.62 * v + e[i]).toFixed(1)]) };
    })(),
    (() => {
      const x = Array.from({ length: 70 }, (_, i) => +(1 + i * 0.4 + rnorm(1, 0, 0.15, 200 + i, 2)[0]).toFixed(2));
      const e = rnorm(70, 0, 2.2, 103, 2);
      return { label: "학습 시간과 시험 점수 (포화)", x: "주당 학습 시간", y: "점수", fit: "loess" as const, points: x.map((v, i) => [v, +(40 + 45 * (1 - Math.exp(-v / 8)) + e[i]).toFixed(1)]) };
    })(),
  ],
});

// ───────────── scatter matrix (SPLOM)

interface SplomB { label?: string; vars?: string[]; rows?: number[][]; group?: string[] }
function Splom(b: SplomB) {
  const vars = () => arr<string>(b.vars).map(str).slice(0, 6);
  const rows = () => arr<any>(b.rows).filter(Array.isArray).map((r) => vars().map((_, j) => toNum(r[j])));
  const groups = () => {
    const g = arr<any>(b.group).map(str);
    const names: string[] = [];
    for (const x of g) if (x && !names.includes(x)) names.push(x);
    return { of: (i: number) => Math.max(0, names.indexOf(g[i] ?? "")), names: names.slice(0, 3) };
  };
  const doms = createMemo(() => vars().map((_, j) => extent(rows().map((r) => r[j]).filter(Number.isFinite), 0.08)));
  const n = () => vars().length;
  const corr = (a: number, c: number) => {
    const p = rows().filter((r) => Number.isFinite(r[a]) && Number.isFinite(r[c])).map((r) => [r[a], r[c]] as Pt);
    return linreg(p)?.r ?? NaN;
  };
  return (
    <Show when={n() >= 2 && rows().length}>
      <Frame label={b.label} class="st" legend={groups().names.length > 1 ? groups().names.map((g, i) => ({ label: g, color: col(i) })) : undefined} height={(w) => Math.min(w, 640)} margin={{ t: 0, r: 0, b: 0, l: 0 }}>
        {(box) => {
          const size = () => Math.min(box.w, 640);
          const cell = () => (size() - 4) / n();
          const gap = 4;
          const tip = useTip();
          return (
            <g>
              <For each={vars()}>
                {(_, i) => (
                  <For each={vars()}>
                    {(_, j) => {
                      const x0 = () => j() * cell() + gap / 2, y0 = () => i() * cell() + gap / 2, s = () => cell() - gap;
                      const X = (v: number) => x0() + ((v - doms()[j()][0]) / (doms()[j()][1] - doms()[j()][0] || 1)) * s();
                      const Y = (v: number) => y0() + s() - ((v - doms()[i()][0]) / (doms()[i()][1] - doms()[i()][0] || 1)) * s();
                      return (
                        <g>
                          <rect x={x0()} y={y0()} width={s()} height={s()} rx={4} style={{ fill: "none", stroke: "var(--viz-grid)" }} />
                          <Show when={i() === j()}>
                            {(() => {
                              const vals = () => rows().map((r) => r[i()]).filter(Number.isFinite);
                              const bins = () => {
                                const k = 12, [lo, hi] = doms()[i()];
                                const c = new Array(k).fill(0);
                                for (const v of vals()) c[clamp(Math.floor(((v - lo) / (hi - lo || 1)) * k), 0, k - 1)]++;
                                return c;
                              };
                              const mx = () => Math.max(1, ...bins());
                              return (
                                <g>
                                  <For each={bins()}>{(c, k) => <rect x={x0() + (k() * s()) / 12 + 0.5} y={y0() + s() - (c / mx()) * s() * 0.62} width={Math.max(0, s() / 12 - 1)} height={(c / mx()) * s() * 0.62} style={{ fill: "var(--viz-other)" }} />}</For>
                                  <text class="st-strong" x={x0() + 6} y={y0() + 16} style={{ "font-size": "12px" }}>{ell(vars()[i()], s() - 10, SM)}</text>
                                </g>
                              );
                            })()}
                          </Show>
                          <Show when={i() > j()}>
                            <For each={rows()}>{(r, k) => <Show when={Number.isFinite(r[i()]) && Number.isFinite(r[j()])}><circle cx={X(r[j()])} cy={Y(r[i()])} r={s() > 110 ? 2.4 : 1.8} style={{ fill: col(groups().of(k())), "fill-opacity": 0.6 }} /></Show>}</For>
                          </Show>
                          <Show when={i() < j()}>
                            {(() => {
                              const r = () => corr(i(), j());
                              return (
                                <g class="viz-mark" onMouseMove={(e) => tip.show(e, `r = ${fix(r(), 2)}\n${vars()[i()]} × ${vars()[j()]}`)} onMouseLeave={tip.hide}>
                                  <rect x={x0() + 1} y={y0() + 1} width={s() - 2} height={s() - 2} rx={3} style={{ fill: Number.isFinite(r()) ? (r() >= 0 ? "var(--viz-div-p2)" : "var(--viz-div-n2)") : "none", "fill-opacity": Number.isFinite(r()) ? Math.abs(r()) * 0.35 : 0 }} />
                                  <text x={x0() + s() / 2} y={y0() + s() / 2} dy="0.35em" text-anchor="middle" style={{ "font-size": s() > 90 ? "15px" : "12px", "font-variant-numeric": "tabular-nums" }}>{fix(r(), 2)}</text>
                                </g>
                              );
                            })()}
                          </Show>
                        </g>
                      );
                    }}
                  </For>
                )}
              </For>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}
defineViz<SplomB>({
  type: "splom",
  family: "stat",
  title: "산점도 행렬 (SPLOM)",
  when: "변수 여러 개의 쌍별 관계와 상관을 한눈에",
  render: Splom,
  examples: [
    (() => {
      const n = 90;
      const a = rnorm(n, 170, 8, 111, 1), e1 = rnorm(n, 0, 6, 112, 1), e2 = rnorm(n, 0, 3, 113, 1), e3 = rnorm(n, 0, 4, 114, 1);
      const sex = a.map((_, i) => (i % 2 ? "남" : "여"));
      const h = a.map((v, i) => +(v + (sex[i] === "남" ? 6 : -6)).toFixed(1));
      return { label: "신체 측정 변수 간 관계", vars: ["키 (cm)", "몸무게 (kg)", "허리둘레 (cm)", "악력 (kg)"], group: sex, rows: h.map((v, i) => [v, +(0.9 * v - 88 + e1[i]).toFixed(1), +(0.45 * v + 4 + e2[i] + e1[i] * 0.3).toFixed(1), +(0.35 * v - 26 + e3[i] + (sex[i] === "남" ? 8 : 0)).toFixed(1)]) };
    })(),
  ],
});

// ───────────── hexbin

interface HexB { label?: string; x?: string; y?: string; radius?: number; points?: unknown[] }
function Hexbin(b: HexB) {
  const pts = () => pointsOf(b.points);
  return (
    <Show when={pts().length}>
      <Plot label={b.label} x={{ domain: extent(pts().map((p) => p.x), 0.02), title: xTitle(b) }} y={{ domain: extent(pts().map((p) => p.y), 0.02), title: yTitle(b) }} below={<ScaleKey stops={SEQ_STOPS} lo={t("적음")} hi={t("많음")} title={t("점 개수")} />}>
        {(c) => {
          const r = () => clamp(b.radius ?? c.iw / 32, 5, 18);
          const bins = createMemo(() => hexbin(pts().map((p) => [c.X(p.x) - c.x0, c.Y(p.y) - c.y0]), r()));
          const mx = () => Math.max(1, ...bins().map((x) => x.n));
          const hex = () => {
            const rr = r() - 0.6;
            return Array.from({ length: 6 }, (_, k) => { const a = (Math.PI / 3) * k + Math.PI / 6; return `${rr * Math.cos(a)},${rr * Math.sin(a)}`; }).join("L");
          };
          return (
            <g>
              <defs><clipPath id={`hx-${c.w}`}><rect x={c.x0} y={c.y0} width={c.iw} height={c.ih} /></clipPath></defs>
              <g clip-path={`url(#hx-${c.w})`}>
                <For each={bins()}>
                  {(h) => (
                    <Tip tip={`${t("{n}개|points", { n: h.n })}\n${t("{v} 부근", { v: `${fix(c.X.invert(h.x + c.x0))}, ${fix(c.Y.invert(h.y + c.y0))}` })}`}>
                      <path transform={`translate(${h.x + c.x0},${h.y + c.y0})`} d={`M${hex()}Z`} style={{ fill: seq(Math.sqrt(h.n / mx())) }} />
                    </Tip>
                  )}
                </For>
              </g>
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<HexB>({
  type: "hexbin",
  family: "stat",
  title: "육각 빈도 그림 (헥스빈)",
  when: "점이 수천 개라 겹칠 때 어디에 몰려 있나",
  render: Hexbin,
  examples: [
    (() => {
      const n = 3000;
      const a = rnorm(n, 0, 1, 121, 3), e = rnorm(n, 0, 1, 122, 3);
      return { label: "택시 이동 거리와 요금", x: "거리 (km)", y: "요금 (천 원)", points: a.map((v, i) => { const d = Math.exp(1.6 + 0.55 * v); return [+d.toFixed(2), +(4.8 + 1.1 * d + e[i] * (0.6 + d * 0.08)).toFixed(2)]; }) };
    })(),
  ],
});

// ───────────── 2D density contours

interface D2B { label?: string; x?: string; y?: string; points?: unknown[]; series?: { label: string; points: unknown[] }[]; dots?: boolean }
function Density2d(b: D2B) {
  const S = () => seriesOf(b, 3);
  const all = () => S().flatMap((s) => s.pts);
  return (
    <Show when={all().length > 2}>
      <Plot label={b.label} legend={S().length > 1 ? S().map((s, i) => ({ label: s.label, color: col(i) })) : undefined} x={{ domain: extent(all().map((p) => p.x), 0.08), title: xTitle(b) }} y={{ domain: extent(all().map((p) => p.y), 0.08), title: yTitle(b) }}>
        {(c) => {
          const layers = createMemo(() => S().map((s) => {
            const cs = contourDensity<P>().x((p) => c.X(p.x) - c.x0).y((p) => c.Y(p.y) - c.y0).size([c.iw, c.ih]).bandwidth(clamp(c.iw / 28, 8, 22)).thresholds(8)(s.pts);
            return cs;
          }));
          const path = geoPath();
          const one = () => S().length === 1;
          return (
            <g transform={`translate(${c.x0},${c.y0})`}>
              <defs><clipPath id={`d2-${c.w}`}><rect width={c.iw} height={c.ih} /></clipPath></defs>
              <g clip-path={`url(#d2-${c.w})`}>
                <For each={layers()}>
                  {(cs, k) => (
                    <For each={cs}>
                      {(ct, i) => (
                        <path d={path(ct) ?? ""} style={one() ? { fill: seq((i() + 1) / cs.length), "fill-opacity": 0.85, stroke: "var(--viz-gap)", "stroke-width": 0.5 } : { fill: col(k()), "fill-opacity": 0.05, stroke: col(k()), "stroke-width": 1.2 }} />
                      )}
                    </For>
                  )}
                </For>
                <Show when={b.dots ?? all().length <= 600}>
                  <For each={S()}>{(s, k) => <For each={s.pts}>{(p) => <circle cx={c.X(p.x) - c.x0} cy={c.Y(p.y) - c.y0} r={1.6} style={{ fill: one() ? "var(--ink-2)" : col(k()), "fill-opacity": 0.45 }} />}</For>}</For>
                </Show>
              </g>
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<D2B>({
  type: "density2d",
  family: "stat",
  title: "2차원 밀도 등고선",
  when: "두 변수의 결합 분포에서 봉우리가 어디에 몇 개 있나",
  render: Density2d,
  examples: [
    (() => {
      const a1 = rnorm(220, 2.1, 0.35, 131, 2), b1 = rnorm(220, 55, 6, 132, 1), a2 = rnorm(160, 4.3, 0.4, 133, 2), b2 = rnorm(160, 80, 5, 134, 1);
      return { label: "분출 지속 시간과 대기 시간", x: "분출 시간 (분)", y: "다음 분출까지 (분)", points: [...a1.map((v, i) => [v, b1[i]]), ...a2.map((v, i) => [v, b2[i]])] };
    })(),
  ],
});

// ───────────── residual plot

interface ResB { label?: string; x?: string; y?: string; points?: unknown[]; xy?: unknown[] }
function Residual(b: ResB) {
  const pts = createMemo((): P[] => {
    const raw = pointsOf(b.xy);
    if (raw.length > 2) {
      const f = linreg(raw.map((p) => [p.x, p.y]));
      if (f) return raw.map((p) => ({ x: f.icpt + f.slope * p.x, y: p.y - (f.icpt + f.slope * p.x), label: p.label }));
    }
    return pointsOf(b.points);
  });
  const s = () => sd(pts().map((p) => p.y)) || 1;
  const m = () => mean(pts().map((p) => p.y));
  return (
    <Show when={pts().length}>
      <Plot label={b.label} legend={[{ label: t("잔차"), color: col(0) }, { label: t("|표준화 잔차| > 2"), color: "var(--viz-bad)" }, { label: t("LOESS 평활"), color: "var(--ink-2)" }]} x={{ domain: extent(pts().map((p) => p.x), 0.04), title: str(b.x) || t("적합값"), grid: true }} y={{ domain: extent([...pts().map((p) => p.y), 0], 0.08), title: str(b.y) || t("잔차") }}>
        {(c) => {
          const smooth = createMemo(() => loess(pts().map((p) => [p.x, p.y]), 0.6));
          const D = () => pts().map((p) => ({ x: c.X(p.x), y: c.Y(p.y), r: 3.5, out: Math.abs((p.y - m()) / s()) > 2, color: Math.abs((p.y - m()) / s()) > 2 ? "var(--viz-bad)" : col(0), tip: `${t("잔차")} ${fix(p.y)}\n${t("적합값")} ${fix(p.x)}${p.label ? `\n${p.label}` : ""}` }));
          return (
            <g>
              <line class="st-ref-solid" style={{ stroke: "var(--ink-3)" }} x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(0)} y2={c.Y(0)} />
              <For each={D()}>{(p) => <circle cx={p.x} cy={p.y} r={p.r} style={{ fill: p.color, "fill-opacity": p.out ? 1 : 0.6, stroke: "var(--viz-gap)", "stroke-width": 1 }} />}</For>
              <path class="st-line" style={{ stroke: "var(--ink-2)" }} d={line<Pt>().x((p) => c.X(p[0])).y((p) => c.Y(p[1]))(smooth()) ?? ""} />
              <Nearest pts={D()} box={c} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<ResB>({
  type: "residual",
  family: "stat",
  title: "잔차 그림",
  when: "회귀 모형이 놓친 패턴(곡선, 이분산, 이상치)이 있나",
  render: Residual,
  examples: [
    (() => {
      const x = Array.from({ length: 90 }, (_, i) => 10 + i * 0.9);
      const e = rnorm(90, 0, 1, 141, 3);
      return { label: "집값 모형의 잔차 (이분산)", x: "예측 가격 (억 원)", y: "잔차 (억 원)", points: x.map((v, i) => [+(v / 10).toFixed(2), +(e[i] * (0.15 + v / 160)).toFixed(3)]) };
    })(),
  ],
});

// ───────────── Bland–Altman

interface BaB { label?: string; a?: string; b?: string; unit?: string; pairs?: number[][]; points?: unknown[]; percent?: boolean }
function BlandAltman(b: BaB) {
  const pts = createMemo((): P[] => {
    const pr = arr<any>(b.pairs).filter((p) => Array.isArray(p) && Number.isFinite(toNum(p[0])) && Number.isFinite(toNum(p[1])));
    if (pr.length) return pr.map((p) => { const a = toNum(p[0]), c = toNum(p[1]), m = (a + c) / 2; return { x: m, y: b.percent ? ((a - c) / (m || 1)) * 100 : a - c }; });
    return pointsOf(b.points);
  });
  const md = () => mean(pts().map((p) => p.y));
  const s = () => sd(pts().map((p) => p.y));
  const hi = () => md() + 1.96 * s(), lo = () => md() - 1.96 * s();
  const u = () => (b.percent ? "%" : b.unit);
  return (
    <Show when={pts().length > 1}>
      <Plot label={b.label} x={{ domain: extent(pts().map((p) => p.x), 0.05), title: `${t("평균")} (${str(b.a) || "A"} + ${str(b.b) || "B"}) / 2${b.unit ? ` (${b.unit})` : ""}` }} y={{ domain: extent([...pts().map((p) => p.y), hi(), lo(), 0], 0.12), title: `${t("차이")} ${str(b.a) || "A"} − ${str(b.b) || "B"}${u() ? ` (${u()})` : ""}` }} pad={(w) => ({ r: w > 460 ? 74 : 0 })}>
        {(c) => {
          const D = () => pts().map((p) => ({ x: c.X(p.x), y: c.Y(p.y), r: 3.5, color: col(0), tip: `${t("차이")} ${withU(fix(p.y), u())}\n${t("평균")} ${withU(fix(p.x), b.unit)}` }));
          const lines = () => [
            { v: hi(), name: "+1.96 SD", dash: true },
            { v: md(), name: t("평균 차이"), dash: false },
            { v: lo(), name: "−1.96 SD", dash: true },
          ];
          const wide = () => c.w > 460;
          return (
            <g>
              <line class="st-ref-solid" x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(0)} y2={c.Y(0)} />
              <For each={D()}>{(p) => <circle cx={p.x} cy={p.y} r={p.r} style={{ fill: p.color, "fill-opacity": 0.7, stroke: "var(--viz-gap)", "stroke-width": 1 }} />}</For>
              <For each={lines()}>
                {(l) => (
                  <g>
                    <line class={l.dash ? "st-ref" : "st-ref-solid"} style={l.dash ? {} : { stroke: "var(--ink-2)", "stroke-width": 1.5 }} x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(l.v)} y2={c.Y(l.v)} />
                    <Show when={wide()} fallback={<text class="st-dl" x={c.x0 + c.iw - 2} y={c.Y(l.v) - 4} text-anchor="end">{`${l.name} ${fix(l.v)}`}</text>}>
                      <text class="st-dl" x={c.x0 + c.iw + 6} y={c.Y(l.v) - 3}>{l.name}</text>
                      <text class="st-mute" x={c.x0 + c.iw + 6} y={c.Y(l.v) + 11}>{withU(fix(l.v), u())}</text>
                    </Show>
                  </g>
                )}
              </For>
              <Nearest pts={D()} box={c} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<BaB>({
  type: "blandAltman",
  family: "stat",
  title: "블랜드-앨트먼 그림",
  when: "두 측정 방법이 얼마나 일치하나 (평균 차이와 일치 한계)",
  render: BlandAltman,
  examples: [
    (() => {
      const t = rnorm(60, 128, 16, 151, 0), e = rnorm(60, 1.8, 4.2, 152, 1);
      return { label: "손목형 vs 수은 혈압계", a: "손목형", b: "수은", unit: "mmHg", pairs: t.map((v, i) => [+(v + e[i]).toFixed(0), v]) };
    })(),
  ],
});
