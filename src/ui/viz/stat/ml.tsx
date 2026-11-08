// Machine learning and model evaluation.
//   roc · pr · calibration · training · confusion · importance · shap · pdp · embedding · scree · biplot
import { area, line } from "d3-shape";
import { createMemo, For, Show } from "solid-js";
import { compact, div, Frame, seq, useTip } from "../kit";
import { t } from "../../../i18n";
import { defineViz } from "../registry";
import { arr, col, onSeq, Crosshair, DIV_STOPS, ell, fix, Nearest, nums, Plot, RefLines, refsOf, RowPlot, ScaleKey, SEQ_STOPS, SM, str, Tip, tw } from "./common";
import { barPath } from "./effect";
import { auc, avgPrecision, calibrationFrom, clamp, extent, hull, isNum, mean, placeLabels, prFrom, rocFrom, swarm, toNum, type Pt } from "./math";
import { pointsOf, seriesOf } from "./rel";
import { rnorm } from "./sample";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const unitTicks = [0, 0.25, 0.5, 0.75, 1];
const squareH = (w: number) => clamp(Math.round(w * 0.72), 260, 440);

/** a model's predictions: scores and 0/1 truth, generated so the AUC lands near `sep` */
function fakeScores(n: number, sep: number, seed: number) {
  const truth = Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 1 : 0));
  const z = rnorm(n, 0, 1, seed, 4);
  return { truth, scores: truth.map((t, i) => +(1 / (1 + Math.exp(-(z[i] + (t ? sep : -sep) * 0.9)))).toFixed(4)) };
}

// ───────────── ROC and PR

interface CurveS { label: string; points?: unknown[]; scores?: number[]; truth?: number[]; auc?: number; ap?: number; at?: [number, number] }
interface CurveB { label?: string; series?: CurveS[]; base?: number }
function curves(b: CurveB, kind: "roc" | "pr") {
  return arr<any>(b.series).filter((s) => s && typeof s === "object").slice(0, 8).map((s, i) => {
    const sc = nums(s.scores), tr = arr<any>(s.truth);
    let pts: Pt[] = sc.length && tr.length ? (kind === "roc" ? rocFrom(sc, tr) : prFrom(sc, tr)) : pointsOf(s.points).map((p) => [p.x, p.y] as Pt);
    pts = pts.filter((p) => p[0] >= 0 && p[0] <= 1 && p[1] >= 0 && p[1] <= 1).sort((a, c) => a[0] - c[0] || (kind === "roc" ? a[1] - c[1] : c[1] - a[1]));
    if (kind === "roc" && pts.length && (pts[0][0] > 0 || pts[0][1] > 0)) pts.unshift([0, 0]);
    if (kind === "roc" && pts.length && pts[pts.length - 1][0] < 1) pts.push([1, 1]);
    const score = kind === "roc" ? (isNum(s.auc) ? s.auc : auc(pts)) : isNum(s.ap) ? s.ap : avgPrecision(pts);
    const prev = sc.length && tr.length ? tr.filter(Boolean).length / tr.length : NaN;
    const at = Array.isArray(s.at) && isNum(toNum(s.at[0])) && isNum(toNum(s.at[1])) ? ([toNum(s.at[0]), toNum(s.at[1])] as Pt) : null;
    return { label: str(s.label) || t("모델 {n}", { n: i + 1 }), pts, score, prev, at, em: !!s.em };
  }).filter((s) => s.pts.length > 1);
}
function Curves(b: CurveB & { kind: "roc" | "pr" }) {
  const S = createMemo(() => curves(b, b.kind));
  const name = b.kind === "roc" ? "AUC" : "AP";
  const base = () => (isNum(b.base) ? b.base : S().find((s) => isNum(s.prev))?.prev);
  return (
    <Show when={S().length}>
      <Plot
        label={b.label} height={squareH} legend={S().map((s, i) => ({ label: `${s.label} · ${name} ${fix(s.score, 3)}`, color: col(i) }))}
        x={{ domain: [0, 1], nice: false, ticks: unitTicks, fmt: (v) => fix(v), title: b.kind === "roc" ? t("거짓 양성률 (1 − 특이도)") : t("재현율"), grid: true }}
        y={{ domain: [0, 1], nice: false, ticks: unitTicks, fmt: (v) => fix(v), title: b.kind === "roc" ? t("참 양성률 (민감도)") : t("정밀도") }}
      >
        {(c) => {
          const pts = () => S().flatMap((s, k) => thinPts(s.pts, 120).map((p) => ({ x: c.X(p[0]), y: c.Y(p[1]), r: 2, color: col(k), tip: `${s.label}\n${b.kind === "roc" ? `FPR ${fix(p[0], 3)} · TPR ${fix(p[1], 3)}` : `${t("재현율")} ${fix(p[0], 3)} · ${t("정밀도")} ${fix(p[1], 3)}`}` })));
          return (
            <g>
              <Show when={b.kind === "roc"}><line class="st-ref" x1={c.X(0)} y1={c.Y(0)} x2={c.X(1)} y2={c.Y(1)} /></Show>
              <Show when={b.kind === "pr" && isNum(base())}><line class="st-ref" x1={c.X(0)} x2={c.X(1)} y1={c.Y(base()!)} y2={c.Y(base()!)} /></Show>
              <Show when={S().length === 1}>
                <path class="st-area" style={{ fill: col(0) }} d={area<Pt>().x((p) => c.X(p[0])).y0(c.Y(0)).y1((p) => c.Y(p[1]))(S()[0].pts) ?? ""} />
              </Show>
              <For each={S()}>{(s, k) => <path class="st-line" style={{ stroke: col(k()) }} d={line<Pt>().x((p) => c.X(p[0])).y((p) => c.Y(p[1]))(s.pts) ?? ""} />}</For>
              <For each={S()}>{(s, k) => <Show when={s.at}><circle cx={c.X(s.at![0])} cy={c.Y(s.at![1])} r={5} style={{ fill: col(k()), stroke: "var(--viz-gap)", "stroke-width": 2 }} /></Show>}</For>
              <Nearest pts={pts()} box={c} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
/** at most n points (for hover), keeping the ends */
const thinPts = (p: Pt[], n: number) => (p.length <= n ? p : p.filter((_, i) => i % Math.ceil(p.length / n) === 0 || i === p.length - 1));

const m1 = fakeScores(600, 1.6, 301), m2 = fakeScores(600, 1.15, 302), m3 = fakeScores(600, 0.7, 303);
defineViz<CurveB>({
  type: "roc",
  family: "stat",
  title: "ROC 곡선",
  when: "분류 모델이 양성과 음성을 얼마나 잘 가르나 (AUC 비교)",
  render: (b) => Curves({ ...b, kind: "roc" }),
  examples: [{ label: "이탈 예측 모델 비교", series: [{ label: "XGBoost", ...m1 }, { label: "로지스틱 회귀", ...m2 }, { label: "규칙 기반", ...m3 }] }],
});
defineViz<CurveB>({
  type: "pr",
  family: "stat",
  title: "정밀도-재현율 곡선",
  when: "양성이 드문 문제에서 정밀도와 재현율의 균형 (AP 비교)",
  render: (b) => Curves({ ...b, kind: "pr" }),
  examples: [{ label: "사기 거래 탐지", series: [{ label: "XGBoost", ...m1 }, { label: "로지스틱 회귀", ...m2 }] }],
});

// ───────────── calibration

interface CalB { label?: string; bins?: number; series?: { label: string; points?: unknown[]; scores?: number[]; truth?: number[]; ece?: number }[] }
function Calibration(b: CalB) {
  const S = createMemo(() => arr<any>(b.series).filter((s) => s && typeof s === "object").slice(0, 4).map((s, i) => {
    const sc = nums(s.scores), tr = arr<any>(s.truth);
    if (sc.length && tr.length) {
      const r = calibrationFrom(sc, tr, clamp(Math.round(b.bins ?? 10), 4, 20));
      return { label: str(s.label) || t("모델 {n}", { n: i + 1 }), pts: r.pts, ece: isNum(s.ece) ? s.ece : r.ece };
    }
    const pts = arr<any>(s.points).map((p) => (Array.isArray(p) ? [toNum(p[0]), toNum(p[1]), toNum(p[2])] : [toNum(p?.x), toNum(p?.y), toNum(p?.n)])).filter((p) => isNum(p[0]) && isNum(p[1])) as [number, number, number][];
    return { label: str(s.label) || t("모델 {n}", { n: i + 1 }), pts, ece: isNum(s.ece) ? s.ece : NaN };
  }).filter((s) => s.pts.length));
  const counts = () => (S().length === 1 && S()[0].pts.every((p) => isNum(p[2])) ? S()[0].pts : null);
  return (
    <Show when={S().length}>
      <Plot
        label={b.label} height={squareH}
        legend={S().map((s, i) => ({ label: `${s.label}${isNum(s.ece) ? ` · ECE ${fix(s.ece, 3)}` : ""}`, color: col(i) }))}
        x={{ domain: [0, 1], nice: false, ticks: unitTicks, fmt: (v) => fix(v), title: t("예측 확률"), grid: true }}
        y={{ domain: [0, 1], nice: false, ticks: unitTicks, fmt: (v) => fix(v), title: t("실제 양성 비율") }}
      >
        {(c) => {
          const mx = () => Math.max(1, ...(counts() ?? []).map((p) => p[2]));
          const pts = () => S().flatMap((s, k) => s.pts.map((p) => ({ x: c.X(p[0]), y: c.Y(p[1]), r: 4, color: col(k), tip: `${t("실제 {v}", { v: pct(p[1]) })} · ${t("예측 {v}", { v: pct(p[0]) })}${isNum(p[2]) ? `\nn = ${p[2]}` : ""}\n${s.label}` })));
          return (
            <g>
              <Show when={counts()}>
                <For each={counts()!}>{(p) => <rect x={c.X(p[0]) - 5} y={c.Y(0) - (p[2] / mx()) * c.ih * 0.18} width={10} height={(p[2] / mx()) * c.ih * 0.18} rx={1} style={{ fill: "var(--viz-other)", "fill-opacity": 0.7 }} />}</For>
              </Show>
              <line class="st-ref" x1={c.X(0)} y1={c.Y(0)} x2={c.X(1)} y2={c.Y(1)} />
              <For each={S()}>
                {(s, k) => (
                  <g>
                    <path class="st-line" style={{ stroke: col(k()) }} d={line<[number, number, number]>().x((p) => c.X(p[0])).y((p) => c.Y(p[1]))(s.pts) ?? ""} />
                    <For each={s.pts}>{(p) => <circle cx={c.X(p[0])} cy={c.Y(p[1])} r={3.5} style={{ fill: col(k()), stroke: "var(--viz-gap)", "stroke-width": 1.5 }} />}</For>
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
defineViz<CalB>({
  type: "calibration",
  family: "stat",
  title: "보정 곡선 (신뢰도 그림)",
  when: "모델이 말한 확률이 실제 빈도와 맞나 (과신·과소신)",
  render: Calibration,
  examples: [
    { label: "재입원 위험 모델 보정", series: [{ label: "보정 전", points: [[0.05, 0.02, 812], [0.15, 0.08, 604], [0.25, 0.14, 455], [0.35, 0.22, 371], [0.45, 0.31, 290], [0.55, 0.42, 214], [0.65, 0.55, 160], [0.75, 0.66, 118], [0.85, 0.79, 74], [0.95, 0.9, 41]] }, { label: "등위 회귀 보정 후", points: [[0.05, 0.05], [0.15, 0.14], [0.25, 0.26], [0.35, 0.34], [0.45, 0.46], [0.55, 0.54], [0.65, 0.66], [0.75, 0.73], [0.85, 0.86], [0.95, 0.93]] }] },
  ],
});

// ───────────── training curves

interface TrainB { label?: string; x?: string; y?: string; steps?: number[]; log?: boolean; logx?: boolean; best?: "min" | "max"; on?: string; series?: { label: string; values: number[]; steps?: number[] }[]; refs?: { x?: number; y?: number; label?: string }[] }
function Training(b: TrainB) {
  const S = createMemo(() => arr<any>(b.series).filter((s) => s && typeof s === "object").slice(0, 6).map((s, i) => {
    const vals = arr<any>(s.values).map(toNum);
    const st = nums(s.steps).length === vals.length ? nums(s.steps) : nums(b.steps).length >= vals.length ? nums(b.steps) : vals.map((_, k) => k + 1);
    const pts = vals.map((v, k) => [st[k], v] as Pt).filter((p) => isNum(p[0]) && isNum(p[1]) && (!b.log || p[1] > 0) && (!b.logx || p[0] > 0));
    return { label: str(s.label) || `${i + 1}`, pts };
  }).filter((s) => s.pts.length));
  // the series the best marker is about: `on`, else the one named 검증/val, else the last
  const target = () => {
    const i = S().findIndex((s) => (b.on ? s.label === b.on : /검증|val|dev|test/i.test(s.label)));
    return i >= 0 ? i : S().length - 1;
  };
  const best = createMemo(() => {
    const t = S()[target()];
    if (!t) return null;
    const dir = b.best ?? (/acc|정확|f1|auc|bleu|score|점수|map/i.test(`${b.y ?? ""} ${b.label ?? ""}`) ? "max" : "min");
    let k = 0;
    t.pts.forEach((p, i) => { if (dir === "min" ? p[1] < t.pts[k][1] : p[1] > t.pts[k][1]) k = i; });
    return { p: t.pts[k], dir };
  });
  const xs = () => [...new Set(S().flatMap((s) => s.pts.map((p) => p[0])))].sort((a, c) => a - c);
  return (
    <Show when={S().length}>
      <Plot label={b.label} legend={S().map((s, i) => ({ label: s.label, color: col(i) }))} x={{ domain: b.logx ? [Math.min(...xs()), Math.max(...xs())] : extent(xs()), log: b.logx, nice: false, title: str(b.x) || t("에폭") }} y={{ domain: b.log ? [Math.min(...S().flatMap((s) => s.pts.map((p) => p[1]))), Math.max(...S().flatMap((s) => s.pts.map((p) => p[1])))] : extent(S().flatMap((s) => s.pts.map((p) => p[1])), 0.05), log: b.log, title: str(b.y) || t("손실") }}>
        {(c) => {
          const at = (s: { pts: Pt[] }, x: number) => s.pts.find((p) => p[0] === x)?.[1];
          return (
            <g>
              <For each={S()}>{(s, k) => <path class="st-line" style={{ stroke: col(k()) }} d={line<Pt>().x((p) => c.X(p[0])).y((p) => c.Y(p[1]))(s.pts) ?? ""} />}</For>
              <Show when={best()}>
                {(bp) => {
                  const x = () => c.X(bp().p[0]), y = () => c.Y(bp().p[1]);
                  const right = () => x() < c.x0 + c.iw * 0.6;
                  const txt = () => `${bp().dir === "min" ? t("최저") : t("최고")} ${fix(bp().p[1])} · ${fix(bp().p[0])}`;
                  return (
                    <g>
                      <line class="st-ref" x1={x()} x2={x()} y1={c.y0} y2={c.y0 + c.ih} />
                      <circle cx={x()} cy={y()} r={5} style={{ fill: col(target()), stroke: "var(--viz-gap)", "stroke-width": 2 }} />
                      <text class="st-dl" x={x() + (right() ? 6 : -6)} y={c.y0 + 12} text-anchor={right() ? "start" : "end"}>{ell(txt(), c.iw * 0.5, SM)}</text>
                    </g>
                  );
                }}
              </Show>
              <RefLines refs={refsOf(b.refs)} c={c} />
              <Crosshair box={c} xs={xs().map((x) => c.X(x))} read={(i) => `${str(b.x) || t("에폭")} ${fix(xs()[i])}\n${S().map((s) => `${s.label} ${fix(at(s, xs()[i]) ?? NaN)}`).join("\n")}`} dots={(i) => S().flatMap((s, k) => { const v = at(s, xs()[i]); return v === undefined ? [] : [{ y: c.Y(v), color: col(k) }]; })} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
const ep = Array.from({ length: 40 }, (_, i) => i + 1);
const noise = rnorm(40, 0, 1, 311, 3), noise2 = rnorm(40, 0, 1, 312, 3);
defineViz<TrainB>({
  type: "training",
  family: "stat",
  title: "학습 곡선 (손실·지표)",
  when: "학습이 수렴했나, 언제부터 과적합인가 (최적 에폭)",
  render: Training,
  examples: [
    { label: "ResNet-50 학습 손실", x: "에폭", y: "교차 엔트로피 손실", series: [{ label: "학습", values: ep.map((e, i) => +(2.3 * Math.exp(-e / 7) + 0.08 + noise[i] * 0.012).toFixed(3)) }, { label: "검증", values: ep.map((e, i) => +(2.2 * Math.exp(-e / 7) + 0.32 + Math.max(0, e - 18) * 0.012 + noise2[i] * 0.02).toFixed(3)) }] },
    { label: "학습 데이터 양에 따른 정확도 (학습 곡선)", x: "학습 샘플 수", y: "정확도", best: "max", logx: true, steps: [500, 1000, 2000, 4000, 8000, 16000, 32000], series: [{ label: "학습", values: [0.99, 0.97, 0.955, 0.94, 0.93, 0.925, 0.92] }, { label: "교차 검증", values: [0.71, 0.77, 0.82, 0.855, 0.875, 0.888, 0.894] }] },
  ],
});

// ───────────── confusion matrix

interface ConfB { label?: string; labels?: string[]; matrix?: number[][]; norm?: "row" | "none" }
function Confusion(b: ConfB) {
  const labs = () => arr<any>(b.labels).map(str).slice(0, 20);
  const M = () => labs().map((_, i) => labs().map((_, j) => Math.max(0, toNum(arr<any>(arr<any>(b.matrix)[i])[j]) || 0)));
  const rowSum = () => M().map((r) => r.reduce((s, v) => s + v, 0));
  const total = () => rowSum().reduce((s, v) => s + v, 0);
  const share = (i: number, j: number) => (b.norm === "none" ? M()[i][j] / Math.max(1, ...M().flat()) : M()[i][j] / (rowSum()[i] || 1));
  const acc = () => labs().reduce((s, _, i) => s + M()[i][i], 0) / (total() || 1);
  return (
    <Show when={labs().length >= 2}>
      <Frame label={b.label} class="st" height={(w) => confLayout(labs(), w).h} margin={{ t: 0, r: 0, b: 0, l: 0 }} below={<ScaleKey stops={SEQ_STOPS} lo="0%" hi={b.norm === "none" ? t("최대") : "100%"} title={b.norm === "none" ? t("개수") : t("행 비율")} after={t("정확도 {v}", { v: pct(acc()) })} />}>
        {(box) => {
          const L = () => confLayout(labs(), box.w);
          const tip = useTip();
          return (
            <g>
              <text class="viz-axis-title" x={L().x0} y={11} text-anchor="start">{t("예측 →")}</text>
              <text class="viz-axis-title" x={L().x0 - 8} y={L().y0 - 8} text-anchor="end">{t("실제 ↓")}</text>
              <For each={labs()}>
                {(l, j) => (
                  <Show when={L().tilt} fallback={<text class="st-mute" x={L().x0 + (j() + 0.5) * L().cell} y={L().y0 - 8} text-anchor="middle">{ell(l, L().cell - 4, SM)}</text>}>
                    <text class="st-mute" transform={`translate(${L().x0 + (j() + 0.5) * L().cell},${L().y0 - 6}) rotate(-40)`} text-anchor="start">{ell(l, 70, SM)}</text>
                  </Show>
                )}
              </For>
              <For each={labs()}>
                {(l, i) => (
                  <g>
                    <text x={L().x0 - 8} y={L().y0 + (i() + 0.5) * L().cell} dy="0.32em" text-anchor="end" style={{ "font-size": "12.5px" }}><title>{l}</title>{ell(l, L().lw, 12.5)}</text>
                    <For each={labs()}>
                      {(_, j) => {
                        const sh = () => share(i(), j());
                        return (
                          <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${t("{v}건", { v: M()[i()][j()].toLocaleString("ko-KR"), n: M()[i()][j()] })} · ${pct(M()[i()][j()] / (rowSum()[i()] || 1))}\n${t("실제 {a} → 예측 {b}", { a: l, b: labs()[j()] })}`)} onMouseLeave={tip.hide}>
                            <rect x={L().x0 + j() * L().cell + 1} y={L().y0 + i() * L().cell + 1} width={L().cell - 2} height={L().cell - 2} rx={3} style={{ fill: M()[i()][j()] ? seq(sh()) : "var(--viz-grid)", "fill-opacity": M()[i()][j()] ? 1 : 0.5 }} />
                            <Show when={L().cell >= 30}>
                              <text class={`st-cell-v ${onSeq(sh())}`} x={L().x0 + (j() + 0.5) * L().cell} y={L().y0 + (i() + 0.5) * L().cell + (L().cell >= 52 ? -6 : 0)} dy="0.35em" text-anchor="middle" style={{ "font-weight": i() === j() ? 600 : 400 }}>{compactN(M()[i()][j()])}</text>
                              <Show when={L().cell >= 52}><text class={`st-cell-v ${onSeq(sh())}`} x={L().x0 + (j() + 0.5) * L().cell} y={L().y0 + (i() + 0.5) * L().cell + 10} dy="0.35em" text-anchor="middle" style={{ "font-size": "11px", opacity: 0.8 }}>{pct(M()[i()][j()] / (rowSum()[i()] || 1))}</text></Show>
                            </Show>
                          </g>
                        );
                      }}
                    </For>
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
const compactN = (n: number) => compact(n);
function confLayout(labs: string[], w: number) {
  const n = Math.max(1, labs.length);
  const lw = Math.min(w * 0.3, Math.max(...labs.map((l) => tw(l, 12.5))) + 4);
  const cell = clamp(Math.floor((w - lw - 20) / n), 14, 76);
  const tilt = labs.some((l) => tw(l, SM) > cell - 4);
  const y0 = 26 + (tilt ? 46 : 14);
  return { lw, cell, x0: lw + 14, y0, tilt, h: y0 + cell * n + 6 };
}
defineViz<ConfB>({
  type: "confusion",
  family: "stat",
  title: "혼동 행렬",
  when: "분류 모델이 어떤 클래스를 무엇으로 헷갈리나",
  render: Confusion,
  examples: [
    { label: "고객 문의 분류기 (테스트셋)", labels: ["결제", "배송", "환불", "계정", "기타"], matrix: [[412, 8, 21, 3, 6], [11, 538, 14, 2, 15], [27, 12, 301, 1, 9], [4, 1, 2, 266, 12], [9, 22, 13, 18, 147]] },
  ],
});

// ───────────── feature importance

interface ImpB { label?: string; x?: string; top?: number; items?: { label: string; value: number; lo?: number; hi?: number; sd?: number; em?: boolean }[] }
function Importance(b: ImpB) {
  const items = () => arr<any>(b.items).filter((i) => i && isNum(toNum(i.value))).map((i) => {
    const v = toNum(i.value), e = toNum(i.sd);
    return { label: str(i.label), value: v, lo: isNum(toNum(i.lo)) ? toNum(i.lo) : isNum(e) ? v - e : NaN, hi: isNum(toNum(i.hi)) ? toNum(i.hi) : isNum(e) ? v + e : NaN, em: !!(i.em ?? i.highlight) };
  }).sort((a, c) => Math.abs(c.value) - Math.abs(a.value)).slice(0, clamp(b.top ?? 15, 1, 40));
  const anyEm = () => items().some((i) => i.em);
  const dom = (): [number, number] => { const [lo, hi] = extent(items().flatMap((i) => [i.value, i.lo, i.hi].filter(isNum)), 0.04); return [Math.min(0, lo), Math.max(0, hi)]; };
  return (
    <Show when={items().length}>
      <RowPlot label={b.label} rows={items().map((i) => i.label)} rowH={(w) => (w < 480 ? 24 : 28)} x={{ domain: dom(), title: str(b.x) || undefined }} pad={(w) => ({ r: w > 400 ? 40 : 30 })}>
        {(c) => (
          <g>
            <line class="st-ref-solid" x1={c.X(0)} x2={c.X(0)} y1={c.y0} y2={c.y0 + c.ih} />
            <For each={items()}>
              {(i, k) => {
                const h = () => Math.min(16, c.band * 0.62);
                const y = () => c.rowY(k());
                const neg = () => i.value < 0;
                return (
                  <Tip tip={`${fix(i.value)}${isNum(i.lo) ? `\n${t("구간 {v}", { v: `${fix(i.lo)} – ${fix(i.hi)}` })}` : ""}\n${i.label}`}>
                    <rect x={c.x0} y={y() - c.band / 2} width={c.iw} height={c.band} fill="transparent" />
                    <path transform={`translate(0,${y() + h() / 2}) rotate(-90)`} d={barPath(0, c.X(0), c.X(i.value), h())} style={{ fill: anyEm() && !i.em ? "var(--viz-other)" : col(0) }} />
                    <Show when={isNum(i.lo) && isNum(i.hi)}><line class="st-whisker" style={{ stroke: "var(--ink-2)" }} x1={c.X(i.lo)} x2={c.X(i.hi)} y1={y()} y2={y()} /></Show>
                    <text class="st-dl" x={c.X(neg() ? Math.min(i.value, isNum(i.lo) ? i.lo : i.value) : Math.max(i.value, isNum(i.hi) ? i.hi : i.value)) + (neg() ? -5 : 5)} y={y()} dy="0.32em" text-anchor={neg() ? "end" : "start"}>{fix(i.value, i.value !== 0 && Math.abs(i.value) < 0.1 ? 3 : 2)}</text>
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
defineViz<ImpB>({
  type: "importance",
  family: "stat",
  title: "특성 중요도",
  when: "모델 예측에 어떤 특성이 가장 크게 기여하나",
  render: Importance,
  examples: [
    { label: "이탈 모델 특성 중요도 (순열, 10회)", x: "AUC 감소량", items: [{ label: "최근 30일 접속 횟수", value: 0.142, sd: 0.011 }, { label: "요금제 변경 이력", value: 0.087, sd: 0.009 }, { label: "고객센터 문의 수", value: 0.064, sd: 0.007 }, { label: "가입 기간 (개월)", value: 0.051, sd: 0.006 }, { label: "월 결제액", value: 0.033, sd: 0.005 }, { label: "앱 푸시 수신 동의", value: 0.012, sd: 0.004 }, { label: "연령대", value: 0.006, sd: 0.003 }, { label: "가입 경로", value: -0.002, sd: 0.003 }] },
  ],
});

// ───────────── SHAP beeswarm

interface ShapB { label?: string; x?: string; top?: number; items?: { label: string; values: number[]; features?: number[] }[] }
function Shap(b: ShapB) {
  const items = () => arr<any>(b.items).filter((i) => i && Array.isArray(i.values)).map((i) => {
    const v = arr<any>(i.values).map(toNum), f = arr<any>(i.features).map(toNum);
    const ok = v.map((x, k) => [x, f[k]] as const).filter(([x]) => isNum(x));
    const fs = ok.map(([, y]) => y).filter(isNum);
    const [lo, hi] = fs.length ? extent(fs) : [0, 1];
    return { label: str(i.label), vals: ok.map(([x]) => x), feat: ok.map(([, y]) => (isNum(y) ? (y - lo) / (hi - lo || 1) : NaN)), imp: mean(ok.map(([x]) => Math.abs(x))) };
  }).filter((i) => i.vals.length).sort((a, c) => c.imp - a.imp).slice(0, clamp(b.top ?? 12, 1, 30));
  return (
    <Show when={items().length}>
      <RowPlot label={b.label} rows={items().map((i) => i.label)} rowH={(w) => (w < 480 ? 30 : 34)} x={{ domain: extent(items().flatMap((i) => i.vals), 0.05), title: str(b.x) || t("SHAP 값 (예측에 미친 영향)") }} below={<ScaleKey stops={DIV_STOPS} lo={t("낮음")} hi={t("높음")} title={t("특성값")} />}>
        {(c) => {
          const pts = createMemo(() => items().flatMap((it, k) => {
            const pos = it.vals.map((v) => c.X(v));
            let r = 2.4;
            let off = swarm(pos, r);
            const room = c.band * 0.46, m = Math.max(0, ...off.map(Math.abs));
            if (m > room) off = off.map((o) => (o * room) / m);
            if (it.vals.length > 400) r = 1.8;
            return it.vals.map((v, i) => ({ x: pos[i], y: c.rowY(k) + off[i], r, color: isNum(it.feat[i]) ? div(it.feat[i] * 2 - 1) : "var(--viz-other)", tip: `SHAP ${fix(v)}\n${it.label}` }));
          }));
          return (
            <g>
              <line class="st-ref-solid" style={{ stroke: "var(--ink-3)" }} x1={c.X(0)} x2={c.X(0)} y1={c.y0} y2={c.y0 + c.ih} />
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={p.r} style={{ fill: p.color }} />}</For>
              <Nearest pts={pts()} box={c} reach={14} />
            </g>
          );
        }}
      </RowPlot>
    </Show>
  );
}
defineViz<ShapB>({
  type: "shap",
  family: "stat",
  title: "SHAP 요약 (비스웜)",
  when: "각 특성이 개별 예측을 어느 방향으로 얼마나 밀었나",
  render: Shap,
  examples: [
    (() => {
      const n = 160;
      const mk = (w: number, seed: number, skew = 0) => {
        const f = rnorm(n, 0, 1, seed, 3), e = rnorm(n, 0, 1, seed + 50, 3);
        return { features: f, values: f.map((x, i) => +(w * x + skew * x * x + e[i] * w * 0.25).toFixed(3)) };
      };
      return { label: "대출 연체 모델 SHAP", items: [{ label: "신용점수", ...mk(-0.9, 401) }, { label: "부채 비율", ...mk(0.65, 402, 0.1) }, { label: "연소득", ...mk(-0.42, 403) }, { label: "최근 연체 횟수", ...mk(0.38, 404, 0.15) }, { label: "근속 연수", ...mk(-0.21, 405) }, { label: "대출 기간", ...mk(0.12, 406) }] };
    })(),
  ],
});

// ───────────── partial dependence

interface PdpB { label?: string; x?: string; y?: string; series?: { label: string; points: unknown[] }[]; points?: unknown[]; ice?: unknown[][]; rug?: number[] }
function Pdp(b: PdpB) {
  const S = () => seriesOf(b, 4).map((s) => ({ ...s, pts: [...s.pts].sort((a, c) => a.x - c.x) }));
  const ice = () => arr<any>(b.ice).map((l) => pointsOf(l).sort((a, c) => a.x - c.x)).filter((l) => l.length > 1).slice(0, 200);
  const rug = () => nums(b.rug);
  const allX = () => [...S().flatMap((s) => s.pts.map((p) => p.x)), ...ice().flatMap((l) => l.map((p) => p.x))];
  const allY = () => [...S().flatMap((s) => s.pts.map((p) => p.y)), ...ice().flatMap((l) => l.map((p) => p.y))];
  return (
    <Show when={S().length}>
      <Plot label={b.label} legend={S().length > 1 ? S().map((s, i) => ({ label: s.label, color: col(i) })) : ice().length ? [{ label: t("평균 (PDP)"), color: col(0) }, { label: t("개별 (ICE)"), color: "var(--viz-other)" }] : undefined} x={{ domain: extent(allX(), 0.02), title: str(b.x) || undefined }} y={{ domain: extent(allY(), 0.06), title: str(b.y) || t("예측값") }}>
        {(c) => {
          const xs = () => S()[0].pts.map((p) => c.X(p.x));
          return (
            <g>
              <For each={ice()}>{(l) => <path class="st-thin" style={{ stroke: "var(--viz-other)", "stroke-width": 1, opacity: 0.6 }} d={line<{ x: number; y: number }>().x((p) => c.X(p.x)).y((p) => c.Y(p.y))(l) ?? ""} />}</For>
              <For each={S()}>{(s, k) => <path class="st-line" style={{ stroke: col(k()), "stroke-width": ice().length ? 3 : 2 }} d={line<{ x: number; y: number }>().x((p) => c.X(p.x)).y((p) => c.Y(p.y))(s.pts) ?? ""} />}</For>
              <For each={rug()}>{(v) => <line class="st-ref-solid" style={{ stroke: "var(--ink-3)", opacity: 0.6 }} x1={c.X(v)} x2={c.X(v)} y1={c.y0 + c.ih} y2={c.y0 + c.ih - 6} />}</For>
              <Crosshair box={c} xs={xs()} read={(i) => `${str(b.x) || "x"} ${fix(S()[0].pts[i].x)}\n${S().map((s) => `${S().length > 1 ? s.label + " " : t("예측") + " "}${fix(s.pts[i]?.y ?? NaN)}`).join("\n")}`} dots={(i) => S().flatMap((s, k) => (s.pts[i] ? [{ y: c.Y(s.pts[i].y), color: col(k) }] : []))} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<PdpB>({
  type: "pdp",
  family: "stat",
  title: "부분 의존도 (PDP·ICE)",
  when: "특성 하나를 바꾸면 예측이 평균적으로(그리고 개별로) 어떻게 변하나",
  render: Pdp,
  examples: [
    (() => {
      const xs = Array.from({ length: 25 }, (_, i) => 20 + i * 2.5);
      const f = (x: number) => 0.12 + 0.5 / (1 + Math.exp(-(x - 48) / 5));
      const shifts = rnorm(30, 0, 0.06, 411, 3), slopes = rnorm(30, 1, 0.25, 412, 3);
      return { label: "나이에 따른 가입 확률", x: "나이", y: "예측 가입 확률", points: xs.map((x) => [x, +f(x).toFixed(3)]), ice: shifts.map((s, k) => xs.map((x) => [x, +(0.12 + s + (f(x) - 0.12) * slopes[k]).toFixed(3)])), rug: rnorm(60, 44, 11, 413, 0) };
    })(),
  ],
});

// ───────────── embedding scatter

interface EmbB { label?: string; method?: string; hull?: boolean; series?: { label: string; points: unknown[] }[]; points?: unknown[] }
function Embedding(b: EmbB) {
  const S = () => seriesOf(b, 8);
  const all = () => S().flatMap((s) => s.pts);
  const m = () => str(b.method) || t("차원");
  return (
    <Show when={all().length}>
      <Plot label={b.label} legend={S().length > 1 ? S().map((s, i) => ({ label: s.label, color: col(i) })) : undefined} height={(w) => clamp(Math.round(w * 0.7), 260, 460)} x={{ domain: extent(all().map((p) => p.x), 0.06), hide: true, grid: false, title: `${m()} 1` }} y={{ domain: extent(all().map((p) => p.y), 0.06), hide: true, grid: false, title: `${m()} 2` }}>
        {(c) => {
          const pts = () => S().flatMap((s, k) => s.pts.map((p) => ({ x: c.X(p.x), y: c.Y(p.y), r: 3, color: col(k), label: p.label, em: p.em, tip: `${p.label ? p.label + "\n" : ""}${s.label}` })));
          const n = () => all().length;
          const centroids = () => S().map((s) => ({ x: c.X(mean(s.pts.map((p) => p.x))), y: c.Y(mean(s.pts.map((p) => p.y))), label: s.label }));
          return (
            <g>
              <Show when={(b.hull ?? true) && S().length > 1}>
                <For each={S()}>
                  {(s, k) => {
                    const h = () => hull(s.pts.map((p) => [c.X(p.x), c.Y(p.y)] as Pt));
                    return <Show when={h().length > 2}><path d={`M${h().map((p) => p.join(",")).join("L")}Z`} style={{ fill: col(k()), "fill-opacity": 0.06, stroke: col(k()), "stroke-opacity": 0.5, "stroke-width": 1, "stroke-linejoin": "round" }} /></Show>;
                  }}
                </For>
              </Show>
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={n() > 800 ? 1.8 : p.r} style={{ fill: p.color, "fill-opacity": n() > 400 ? 0.55 : 0.8 }} />}</For>
              <Show when={S().length > 1}>
                <For each={centroids()}>{(ct) => <text class="st-dl st-strong" x={ct.x} y={ct.y} dy="0.32em" text-anchor="middle" style={{ "font-size": "12.5px" }}>{ell(ct.label, 110, 12.5)}</text>}</For>
              </Show>
              <Nearest pts={pts()} box={c} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<EmbB>({
  type: "embedding",
  family: "stat",
  title: "임베딩 산점도 (PCA·t-SNE·UMAP)",
  when: "고차원 데이터가 몇 개의 군집으로 나뉘나, 어떤 점이 어디에 속하나",
  render: Embedding,
  examples: [
    (() => {
      const cl = [["스포츠", -6, 4], ["정치", 5, 6], ["경제", 6, -3], ["IT·과학", -2, -6], ["연예", -8, -2]] as const;
      return { label: "뉴스 기사 임베딩 (UMAP)", method: "UMAP", series: cl.map(([l, x, y], i) => { const a = rnorm(70, x, 1.6, 421 + i, 2), c2 = rnorm(70, y, 1.4, 431 + i, 2); return { label: l, points: a.map((v, k) => [v, c2[k]]) }; }) };
    })(),
  ],
});

// ───────────── scree plot

interface ScreeB { label?: string; values?: number[]; labels?: string[]; eigen?: boolean; refs?: { y: number; label?: string }[] }
function Scree(b: ScreeB) {
  const v = () => nums(b.values).filter((x) => x >= 0).slice(0, 30);
  const tot = () => v().reduce((s, x) => s + x, 0) || 1;
  // ratios ≤ 1 that sum to ≤ 1 are already shares; otherwise they are eigenvalues or percents
  const share = () => (b.eigen ? v() : tot() <= 1.0001 ? v().map((x) => x * 100) : tot() <= 100.5 && !b.eigen && v().every((x) => x <= 100) && tot() > 99 ? v() : v().map((x) => (x / tot()) * 100));
  const cum = () => share().reduce<number[]>((a, x) => [...a, (a[a.length - 1] ?? 0) + x], []);
  const names = () => v().map((_, i) => str(arr<any>(b.labels)[i]) || `PC${i + 1}`);
  return (
    <Show when={v().length}>
      <Plot
        label={b.label} legend={b.eigen ? undefined : [{ label: t("설명 분산"), color: col(0) }, { label: t("누적"), color: col(1) }]}
        x={{ domain: [0.4, v().length + 0.6], nice: false, ticks: v().map((_, i) => i + 1), fmt: (x) => names()[Math.round(x) - 1] ?? "" }}
        y={b.eigen ? { domain: [0, Math.max(...v(), 1) * 1.1], title: t("고윳값") } : { domain: [0, 100], nice: false, ticks: [0, 25, 50, 75, 100], fmt: (x) => `${x}%`, title: t("설명 분산 비율") }}
      >
        {(c) => {
          const bw = () => Math.min(24, (c.iw / v().length) * 0.6);
          return (
            <g>
              <Show when={b.eigen}><line class="st-ref" x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(1)} y2={c.Y(1)} /><text class="st-dl" x={c.x0 + c.iw - 2} y={c.Y(1) - 5} text-anchor="end">{t("고윳값 1 (카이저 기준)")}</text></Show>
              <For each={share()}>
                {(s, i) => (
                  <Tip tip={`${names()[i()]}\n${b.eigen ? `${t("고윳값")} ${fix(s)}` : `${fix(s, 1)}% · ${t("누적 {v}", { v: `${fix(cum()[i()], 1)}%` })}`}`}>
                    <rect x={c.X(i() + 1) - c.iw / v().length / 2} y={c.y0} width={c.iw / v().length} height={c.ih} fill="transparent" />
                    <path d={barPath(c.X(i() + 1) - bw() / 2, c.Y(0), c.Y(s), bw())} style={{ fill: col(0) }} />
                  </Tip>
                )}
              </For>
              <Show when={!b.eigen}>
                <path class="st-line" style={{ stroke: col(1) }} d={line<number>().x((_, i) => c.X(i + 1)).y((x) => c.Y(x))(cum()) ?? ""} />
                <For each={cum()}>{(x, i) => <circle cx={c.X(i() + 1)} cy={c.Y(x)} r={3.5} style={{ fill: col(1), stroke: "var(--viz-gap)", "stroke-width": 1.5, "pointer-events": "none" }} />}</For>
              </Show>
              <RefLines refs={refsOf(b.refs)} c={c} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<ScreeB>({
  type: "scree",
  family: "stat",
  title: "스크리 플롯",
  when: "주성분을 몇 개까지 쓰면 충분한가 (설명 분산과 누적)",
  render: Scree,
  examples: [{ label: "설문 문항 PCA", values: [0.382, 0.214, 0.121, 0.074, 0.052, 0.041, 0.033, 0.028, 0.025, 0.017], refs: [{ y: 80, label: "80%" }] }],
});

// ───────────── PCA biplot

interface BiB { label?: string; x?: string; y?: string; series?: { label: string; points: unknown[] }[]; points?: unknown[]; loadings?: { label: string; x: number; y: number }[] }
function Biplot(b: BiB) {
  const S = () => seriesOf(b, 4);
  const all = () => S().flatMap((s) => s.pts);
  const loads = () => arr<any>(b.loadings).filter((l) => l && isNum(toNum(l.x)) && isNum(toNum(l.y))).map((l) => ({ label: str(l.label), x: toNum(l.x), y: toNum(l.y) })).slice(0, 16);
  const dom = (k: "x" | "y"): [number, number] => { const m = Math.max(...all().map((p) => Math.abs(p[k])), 1e-9) * 1.12; return [-m, m]; };
  return (
    <Show when={all().length}>
      <Plot label={b.label} legend={S().length > 1 ? S().map((s, i) => ({ label: s.label, color: col(i) })) : undefined} height={(w) => clamp(Math.round(w * 0.75), 280, 480)} x={{ domain: dom("x"), title: str(b.x) || "PC1" }} y={{ domain: dom("y"), title: str(b.y) || "PC2" }}>
        {(c) => {
          // loadings are scaled so the longest arrow reaches 85% of the nearer axis end
          const k = () => {
            const ml = Math.max(...loads().map((l) => Math.hypot(l.x, l.y)), 1e-9);
            return (0.85 * Math.min(dom("x")[1], dom("y")[1])) / ml;
          };
          const pts = () => S().flatMap((s, i) => s.pts.map((p) => ({ x: c.X(p.x), y: c.Y(p.y), r: 3, color: col(i), tip: `${p.label ? p.label + "\n" : ""}${fix(p.x)}, ${fix(p.y)}${S().length > 1 ? `\n${s.label}` : ""}` })));
          // labels sit just past each arrow tip, nudged so they never cover one another
          const labSpots = createMemo(() => placeLabels(
            loads().map((l) => { const ux = l.x / (Math.hypot(l.x, l.y) || 1), uy = -l.y / (Math.hypot(l.x, l.y) || 1); const w = Math.min(tw(l.label, SM), c.iw * 0.3) + 2; return { x: c.X(l.x * k()) + ux * (8 + w / 2), y: c.Y(l.y * k()) + uy * 10, w, h: 14 }; }).map((r) => ({ ...r, x: r.x - r.w / 2 - 6 })),
            { x: c.x0, y: c.y0, w: c.iw, h: c.ih }, [], 6,
          ));
          return (
            <g>
              <line class="st-ref-solid" x1={c.X(0)} x2={c.X(0)} y1={c.y0} y2={c.y0 + c.ih} />
              <line class="st-ref-solid" x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(0)} y2={c.Y(0)} />
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={p.r} style={{ fill: p.color, "fill-opacity": 0.55 }} />}</For>
              <Nearest pts={pts()} box={c} />
              <For each={loads()}>
                {(l, li) => {
                  const x2 = () => c.X(l.x * k()), y2 = () => c.Y(l.y * k());
                  const a = () => Math.atan2(y2() - c.Y(0), x2() - c.X(0));
                  const head = () => `M${x2()},${y2()}L${x2() - 7 * Math.cos(a() - 0.4)},${y2() - 7 * Math.sin(a() - 0.4)}L${x2() - 7 * Math.cos(a() + 0.4)},${y2() - 7 * Math.sin(a() + 0.4)}Z`;
                  const spot = () => labSpots()[li()];
                  return (
                    <Tip tip={`${l.label}\n${t("적재량 {v}", { v: `${fix(l.x, 2)}, ${fix(l.y, 2)}` })}`}>
                      <line style={{ stroke: "var(--ink-2)", "stroke-width": 1.5 }} x1={c.X(0)} y1={c.Y(0)} x2={x2()} y2={y2()} />
                      <path d={head()} style={{ fill: "var(--ink-2)" }} />
                      <Show when={spot()}>{(r) => <text class="st-dl" x={r().x + 1} y={r().y + 11}>{ell(l.label, c.iw * 0.3, SM)}</text>}</Show>
                    </Tip>
                  );
                }}
              </For>
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<BiB>({
  type: "biplot",
  family: "stat",
  title: "PCA 바이플롯",
  when: "관측치가 주성분 공간에서 어디 있고, 어떤 변수가 그 방향을 만드나",
  render: Biplot,
  examples: [
    (() => {
      const sp = [["세토사", -2.7, 0.3], ["버시컬러", 0.3, -0.5], ["버지니카", 1.9, 0.25]] as const;
      return {
        label: "붓꽃 측정값 PCA", x: "PC1 (73.0%)", y: "PC2 (22.9%)",
        series: sp.map(([l, x, y], i) => { const a = rnorm(50, x, 0.45, 441 + i, 2), c2 = rnorm(50, y, 0.42, 451 + i, 2); return { label: l, points: a.map((v, k) => [v, c2[k]]) }; }),
        loadings: [{ label: "꽃받침 길이", x: 0.52, y: 0.38 }, { label: "꽃받침 너비", x: -0.27, y: 0.92 }, { label: "꽃잎 길이", x: 0.58, y: 0.02 }, { label: "꽃잎 너비", x: 0.56, y: 0.07 }],
      };
    })(),
  ],
});
