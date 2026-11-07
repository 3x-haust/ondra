// More figures people expect in statistics and papers.
//   testdist · paired · acf · mosaic · frontier
import { area, line } from "d3-shape";
import { createMemo, For, Show } from "solid-js";
import { Frame, useTip } from "../kit";
import { defineViz } from "../registry";
import { arr, col, ColPlot, ell, fix, Nearest, nums, Plot, SM, str, Tip, tw, withU } from "./common";
import { acf, cdfAt, cdfTable, clamp, distPdf, distRange, distSupport, extent, frontier, isNum, mean, mosaic, placeLabels, pText, sd, tInv, toNum, type Dist, type Pt } from "./math";
import { rnorm } from "./sample";

// ───────────── null distribution of a test statistic

interface TestB { label?: string; dist?: Dist; df?: number; df2?: number; stat?: number; tail?: "two" | "right" | "left"; alpha?: number; name?: string }
function TestDist(b: TestB) {
  const d = (): Dist => (b.dist === "t" || b.dist === "chi2" || b.dist === "f" ? b.dist : "normal");
  const df = () => (isNum(b.df) ? b.df : 10), df2 = () => (isNum(b.df2) ? b.df2 : 20);
  const tail = () => (b.tail ?? (d() === "chi2" || d() === "f" ? "right" : "two"));
  const alpha = () => (isNum(b.alpha) ? clamp(b.alpha, 1e-4, 0.5) : 0.05);
  const name = () => str(b.name) || { normal: "z", t: "t", chi2: "χ²", f: "F" }[d()];
  const D = createMemo(() => {
    const pdf = distPdf(d(), df(), df2());
    const tab = cdfTable(pdf, ...distSupport(d(), df(), df2()), 4000);
    const [lo, hi] = distRange(d(), df(), df2(), b.stat);
    const xs = Array.from({ length: 241 }, (_, i) => lo + ((hi - lo) * i) / 240);
    const q = (p: number) => { const i = tab.F.findIndex((v) => v >= p); return i <= 0 ? tab.xs[0] : tab.xs[i - 1] + ((p - tab.F[i - 1]) / (tab.F[i] - tab.F[i - 1] || 1)) * (tab.xs[i] - tab.xs[i - 1]); };
    const crit = tail() === "two" ? [q(alpha() / 2), q(1 - alpha() / 2)] : tail() === "right" ? [q(1 - alpha())] : [q(alpha())];
    const s = b.stat;
    const p = isNum(s) ? (tail() === "two" ? 2 * Math.min(cdfAt(tab, s), 1 - cdfAt(tab, s)) : tail() === "right" ? 1 - cdfAt(tab, s) : cdfAt(tab, s)) : NaN;
    return { pdf, xs, lo, hi, crit, p: Math.min(1, Math.max(0, p)), ymax: Math.max(...xs.map(pdf).filter(Number.isFinite)) };
  });
  const reject = (x: number) => (tail() === "two" ? x <= D().crit[0] || x >= D().crit[1] : tail() === "right" ? x >= D().crit[0] : x <= D().crit[0]);
  const title = () => ({ normal: "표준정규분포", t: `t 분포 (자유도 ${fix(df())})`, chi2: `χ² 분포 (자유도 ${fix(df())})`, f: `F 분포 (자유도 ${fix(df())}, ${fix(df2())})` }[d()]);
  return (
    <Plot label={b.label} legend={[{ label: `기각역 (α = ${fix(alpha())})`, color: "var(--viz-div-p2)" }, ...(isNum(b.stat) ? [{ label: `관측 ${name()} = ${fix(b.stat!, 2)} · ${pText(D().p)}`, color: "var(--ink)" }] : [])]} x={{ domain: [D().lo, D().hi], nice: false, title: title() }} y={{ domain: [0, D().ymax * 1.12], hide: true, grid: false }} height={(w) => clamp(Math.round(w * 0.45), 200, 300)}>
      {(c) => {
        const seg = (f: (x: number) => boolean) => {
          const out: Pt[][] = [];
          let cur: Pt[] = [];
          for (const x of D().xs) {
            if (f(x)) cur.push([x, D().pdf(x)]);
            else if (cur.length) (out.push(cur), (cur = []));
          }
          if (cur.length) out.push(cur);
          return out;
        };
        // shade exactly to the critical value
        const regions = () => seg(reject).map((r) => {
          const xs = r.map((p) => p[0]);
          const edge = D().crit.filter((v) => v >= xs[0] - (D().hi - D().lo) / 240 && v <= xs[xs.length - 1] + (D().hi - D().lo) / 240);
          return [...edge.filter((v) => v < xs[0]).map((v) => [v, D().pdf(v)] as Pt), ...r, ...edge.filter((v) => v > xs[xs.length - 1]).map((v) => [v, D().pdf(v)] as Pt)];
        });
        const pRegion = () => (isNum(b.stat) ? seg((x) => (tail() === "two" ? Math.abs(x) >= Math.abs(b.stat!) : tail() === "right" ? x >= b.stat! : x <= b.stat!)) : []);
        return (
          <g>
            <For each={regions()}>{(r) => <path style={{ fill: "var(--viz-div-p2)", "fill-opacity": 0.28 }} d={area<Pt>().x((p) => c.X(p[0])).y0(c.Y(0)).y1((p) => c.Y(p[1]))(r) ?? ""} />}</For>
            <Show when={d() === "normal" || d() === "t"}>
              <For each={pRegion()}>{(r) => <path style={{ fill: "var(--ink-3)", "fill-opacity": 0.18 }} d={area<Pt>().x((p) => c.X(p[0])).y0(c.Y(0)).y1((p) => c.Y(p[1]))(r) ?? ""} />}</For>
            </Show>
            <path class="st-line" style={{ stroke: col(0) }} d={line<number>().x((x) => c.X(x)).y((x) => c.Y(Math.min(D().pdf(x), D().ymax * 1.1)))(D().xs) ?? ""} />
            <For each={D().crit}>
              {(v) => (
                <g>
                  <line class="st-ref" x1={c.X(v)} x2={c.X(v)} y1={c.Y(0)} y2={c.Y(D().ymax * 0.55)} />
                  <text class="st-mute" x={c.X(v)} y={c.Y(D().ymax * 0.55) - 5} text-anchor="middle">{fix(v, 2)}</text>
                </g>
              )}
            </For>
            <Show when={isNum(b.stat)}>
              <Tip tip={`관측 ${name()} = ${fix(b.stat!, 3)}\n${pText(D().p)}`}>
                <line style={{ stroke: "var(--ink)", "stroke-width": 2 }} x1={c.X(b.stat!)} x2={c.X(b.stat!)} y1={c.Y(0)} y2={c.y0 + 14} />
                <text class="st-dl st-strong" x={c.X(b.stat!)} y={c.y0 + 8} text-anchor={c.X(b.stat!) > c.x0 + c.iw * 0.8 ? "end" : c.X(b.stat!) < c.x0 + c.iw * 0.2 ? "start" : "middle"}>{`${name()} = ${fix(b.stat!, 2)}`}</text>
              </Tip>
            </Show>
          </g>
        );
      }}
    </Plot>
  );
}
defineViz<TestB>({
  type: "testdist",
  family: "stat",
  title: "검정 통계량과 기각역",
  when: "관측한 검정 통계량이 귀무분포에서 얼마나 극단적인가 (p값의 의미)",
  render: TestDist,
  examples: [
    { label: "두 집단 평균 비교 (독립 t-검정)", dist: "t", df: 38, stat: 2.47, tail: "two", alpha: 0.05 },
    { label: "성별 × 선호 채널 독립성 검정", dist: "chi2", df: 4, stat: 11.8, alpha: 0.05 },
  ],
});

// ───────────── paired (before/after per subject)

interface PairedB { label?: string; unit?: string; y?: string; a?: string; b?: string; items?: { label?: string; before: number; after: number }[]; pairs?: number[][] }
function Paired(b: PairedB) {
  const items = () => {
    const it = arr<any>(b.items).length ? arr<any>(b.items).map((i) => ({ label: str(i?.label), a: toNum(i?.before ?? i?.a), z: toNum(i?.after ?? i?.b) })) : arr<any>(b.pairs).map((p) => ({ label: "", a: toNum(p?.[0]), z: toNum(p?.[1]) }));
    return it.filter((i) => isNum(i.a) && isNum(i.z)).slice(0, 300);
  };
  const names = () => [str(b.a) || "전", str(b.b) || "후"];
  const diffs = () => items().map((i) => i.z - i.a);
  const md = () => mean(diffs());
  const ci = () => { const n = diffs().length; const h = n > 1 ? tInv(0.975, n - 1) * (sd(diffs()) / Math.sqrt(n)) : 0; return [md() - h, md() + h]; };
  return (
    <Show when={items().length}>
      <ColPlot label={b.label} legend={[{ label: `증가 ${diffs().filter((x) => x > 0).length}`, color: col(0) }, { label: `감소 ${diffs().filter((x) => x < 0).length}`, color: col(1) }]} cats={names()} y={{ domain: extent(items().flatMap((i) => [i.a, i.z]), 0.06), title: str(b.y) || (b.unit ? `(${b.unit})` : undefined) }} bandPad={0.5} height={(w) => clamp(Math.round(w * 0.6), 240, 380)}>
        {(c) => {
          const xa = () => c.colX(0), xz = () => c.colX(1);
          const pts = () => items().flatMap((i) => [
            { x: xa(), y: c.Y(i.a), r: 3, color: i.z >= i.a ? col(0) : col(1), tip: `${i.label ? i.label + "\n" : ""}${names()[0]} ${withU(fix(i.a), b.unit)} → ${names()[1]} ${withU(fix(i.z), b.unit)}` },
            { x: xz(), y: c.Y(i.z), r: 3, color: i.z >= i.a ? col(0) : col(1), tip: `${i.label ? i.label + "\n" : ""}${names()[0]} ${withU(fix(i.a), b.unit)} → ${names()[1]} ${withU(fix(i.z), b.unit)}` },
          ]);
          const ma = () => mean(items().map((i) => i.a)), mz = () => mean(items().map((i) => i.z));
          return (
            <g>
              <For each={items()}>{(i) => <line style={{ stroke: i.z >= i.a ? col(0) : col(1), "stroke-width": 1.2, "stroke-opacity": items().length > 40 ? 0.35 : 0.6 }} x1={xa()} x2={xz()} y1={c.Y(i.a)} y2={c.Y(i.z)} />}</For>
              <For each={pts()}>{(p) => <circle cx={p.x} cy={p.y} r={p.r} style={{ fill: p.color, "fill-opacity": 0.8 }} />}</For>
              <Tip tip={`평균 변화 ${withU(fix(md()), b.unit)}\n95% CI ${fix(ci()[0])} – ${fix(ci()[1])}\nn = ${items().length}`}>
                <line style={{ stroke: "var(--ink)", "stroke-width": 3, "stroke-linecap": "round" }} x1={xa()} x2={xz()} y1={c.Y(ma())} y2={c.Y(mz())} />
                <circle cx={xa()} cy={c.Y(ma())} r={5} style={{ fill: "var(--ink)", stroke: "var(--viz-gap)", "stroke-width": 2 }} />
                <circle cx={xz()} cy={c.Y(mz())} r={5} style={{ fill: "var(--ink)", stroke: "var(--viz-gap)", "stroke-width": 2 }} />
              </Tip>
              <text class="st-dl" x={xz() + 10} y={c.Y(mz())} dy="0.32em">{`평균 ${md() >= 0 ? "+" : ""}${fix(md())}`}</text>
              <Nearest pts={pts()} box={c} />
            </g>
          );
        }}
      </ColPlot>
    </Show>
  );
}
defineViz<PairedB>({
  type: "paired",
  family: "stat",
  title: "대응 표본 그림 (전후 비교)",
  when: "같은 대상의 전후 값이 각각 어떻게 바뀌었나, 평균 변화는",
  render: Paired,
  examples: [
    (() => {
      const a = rnorm(24, 142, 12, 701, 0), d = rnorm(24, -8, 7, 702, 0);
      return { label: "8주 운동 프로그램 전후 수축기 혈압", unit: "mmHg", y: "수축기 혈압 (mmHg)", a: "시작", b: "8주 후", items: a.map((v, i) => ({ label: `참가자 ${i + 1}`, before: v, after: v + d[i] })) };
    })(),
  ],
});

// ───────────── ACF / PACF

interface AcfB { label?: string; values?: number[]; r?: number[]; n?: number; lags?: number; partial?: boolean }
function Acf(b: AcfB) {
  const D = createMemo(() => {
    const given = nums(b.r);
    if (given.length) {
      const n = isNum(b.n) ? b.n : NaN;
      return { lags: given.map((_, i) => i + 1), r: given, band: isNum(n) ? 1.96 / Math.sqrt(n) : NaN };
    }
    return acf(nums(b.values), clamp(b.lags ?? 24, 1, 200));
  });
  return (
    <Show when={D().r.length}>
      <Plot label={b.label} x={{ domain: [0, D().lags.length + 0.5], nice: false, title: "시차 (lag)" }} y={{ domain: [Math.min(-0.25, ...D().r) * 1.1, Math.max(0.25, ...D().r) * 1.1], title: b.partial ? "편자기상관 (PACF)" : "자기상관 (ACF)", fmt: (v) => fix(v, 1) }} height={(w) => clamp(Math.round(w * 0.45), 200, 300)}>
        {(c) => (
          <g>
            <Show when={isNum(D().band)}>
              <rect x={c.x0} y={c.Y(D().band)} width={c.iw} height={Math.max(0, c.Y(-D().band) - c.Y(D().band))} style={{ fill: col(0), "fill-opacity": 0.08 }} />
              <line class="st-ref" x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(D().band)} y2={c.Y(D().band)} />
              <line class="st-ref" x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(-D().band)} y2={c.Y(-D().band)} />
            </Show>
            <line class="st-ref-solid" style={{ stroke: "var(--ink-3)" }} x1={c.x0} x2={c.x0 + c.iw} y1={c.Y(0)} y2={c.Y(0)} />
            <For each={D().r}>
              {(r, i) => {
                const out = () => isNum(D().band) && Math.abs(r) > D().band;
                return (
                  <Tip tip={`시차 ${D().lags[i()]}\nr = ${fix(r, 3)}${out() ? "\n신뢰대 밖" : ""}`}>
                    <rect x={c.X(D().lags[i()]) - 6} y={c.y0} width={12} height={c.ih} fill="transparent" />
                    <line style={{ stroke: out() ? col(0) : "var(--viz-other)", "stroke-width": 2 }} x1={c.X(D().lags[i()])} x2={c.X(D().lags[i()])} y1={c.Y(0)} y2={c.Y(r)} />
                    <circle cx={c.X(D().lags[i()])} cy={c.Y(r)} r={3.5} style={{ fill: out() ? col(0) : "var(--viz-other)" }} />
                  </Tip>
                );
              }}
            </For>
          </g>
        )}
      </Plot>
    </Show>
  );
}
defineViz<AcfB>({
  type: "acf",
  family: "stat",
  title: "자기상관 그림 (ACF·PACF)",
  when: "시계열에 주기(계절성)나 남은 자기상관이 있나",
  render: Acf,
  examples: [
    (() => {
      const e = rnorm(120, 0, 1, 711, 3);
      return { label: "월별 전력 사용량의 자기상관", lags: 30, values: e.map((v, i) => +(100 + 12 * Math.sin((2 * Math.PI * i) / 12) + i * 0.1 + v * 4).toFixed(2)) };
    })(),
  ],
});

// ───────────── mosaic (two categorical variables)

interface MosB { label?: string; rows?: string[]; cols?: string[]; matrix?: number[][]; x?: string }
function Mosaic(b: MosB) {
  const rows = () => arr<any>(b.rows).map(str).slice(0, 8);
  const cols = () => arr<any>(b.cols).map(str).slice(0, 12);
  // matrix is rows × cols; the layout wants columns of cells
  const M = createMemo(() => mosaic(cols().map((_, j) => rows().map((_, i) => toNum(arr<any>(arr<any>(b.matrix)[i])[j])))));
  const total = () => M().flat().reduce((s, c) => s + c.v, 0);
  return (
    <Show when={rows().length && cols().length && total() > 0}>
      <Frame label={b.label} class="st" legend={rows().map((r, i) => ({ label: r, color: col(i) }))} height={(w) => clamp(Math.round(w * 0.55), 220, 360) + 26} margin={{ t: 0, r: 0, b: 0, l: 0 }}>
        {(box) => {
          const tip = useTip();
          const W = () => box.w - 2, H = () => box.h - 30;
          return (
            <g>
              <For each={M()}>
                {(column, j) => (
                  <g>
                    <For each={column}>
                      {(cell, i) => {
                        const x = () => 1 + cell.x0 * W(), y = () => (1 - cell.y1) * H(), w = () => Math.max(0, (cell.x1 - cell.x0) * W() - 2), h = () => Math.max(0, (cell.y1 - cell.y0) * H() - 2);
                        const label = () => `${Math.round(cell.rowShare * 100)}%`;
                        return (
                          <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${cell.v.toLocaleString("ko-KR")} (${cols()[j()]} 중 ${label()})\n${cols()[j()]} · ${rows()[i()]}`)} onMouseLeave={tip.hide}>
                            <rect x={x()} y={y()} width={w()} height={h()} rx={2} style={{ fill: col(i()) }} />
                            <Show when={w() > tw(label(), SM) + 8 && h() > 18}>
                              <text class={`st-cell-v ${[3, 4].includes(i()) ? "st-on-light" : "st-on-dark"}`} x={x() + w() / 2} y={y() + h() / 2} dy="0.35em" text-anchor="middle">{label()}</text>
                            </Show>
                          </g>
                        );
                      }}
                    </For>
                    <text class="st-mute" x={1 + ((column[0]?.x0 ?? 0) + (column[0]?.x1 ?? 0)) / 2 * W()} y={H() + 18} text-anchor="middle">
                      <title>{cols()[j()]}</title>
                      {ell(cols()[j()], Math.max(0, ((column[0]?.x1 ?? 0) - (column[0]?.x0 ?? 0)) * W() - 4), SM)}
                    </text>
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
defineViz<MosB>({
  type: "mosaic",
  family: "stat",
  title: "모자이크 그림 (교차표)",
  when: "두 범주형 변수의 관계: 그룹마다 구성비가 어떻게 다르고 그룹 크기는 얼마인가",
  render: Mosaic,
  examples: [
    { label: "연령대별 주 결제 수단", rows: ["카드", "간편결제", "계좌이체", "현금"], cols: ["20대", "30대", "40대", "50대", "60대 이상"], matrix: [[182, 310, 352, 298, 160], [341, 402, 255, 118, 41], [44, 70, 88, 95, 72], [12, 18, 31, 64, 118]] },
  ],
});

// ───────────── Pareto frontier (trade-off)

interface FrontB { label?: string; x?: string; y?: string; logx?: boolean; better?: { x?: "up" | "down"; y?: "up" | "down" }; points?: { label?: string; x: number; y: number; group?: string }[] }
function Frontier(b: FrontB) {
  const pts = () => arr<any>(b.points).map((p) => ({ label: str(p?.label), x: toNum(p?.x ?? p?.[0]), y: toNum(p?.y ?? p?.[1]), group: str(p?.group) })).filter((p) => isNum(p.x) && isNum(p.y) && (!b.logx || p.x > 0));
  const groups = () => [...new Set(pts().map((p) => p.group).filter(Boolean))].slice(0, 6);
  const bx = () => (b.better?.x === "up" ? "up" : "down"), by = () => (b.better?.y === "down" ? "down" : "up");
  const front = createMemo(() => new Set(frontier(pts().map((p) => [p.x, p.y] as Pt), bx(), by())));
  return (
    <Show when={pts().length}>
      <Plot label={b.label} legend={[...(groups().length > 1 ? groups().map((g, i) => ({ label: g, color: col(i) })) : []), { label: "파레토 경계", color: "var(--ink-2)" }]} x={{ domain: b.logx ? [Math.min(...pts().map((p) => p.x)) / 1.3, Math.max(...pts().map((p) => p.x)) * 1.3] : extent(pts().map((p) => p.x), 0.06), log: b.logx, title: str(b.x) || undefined, grid: true }} y={{ domain: extent(pts().map((p) => p.y), 0.08), title: str(b.y) || undefined }}>
        {(c) => {
          const P = () => pts().map((p, i) => ({ x: c.X(p.x), y: c.Y(p.y), r: front().has(i) ? 5 : 3.5, on: front().has(i), label: p.label, color: groups().length > 1 ? col(Math.max(0, groups().indexOf(p.group))) : col(0), tip: `${p.label ? p.label + "\n" : ""}${fix(p.x)}, ${fix(p.y)}${front().has(i) ? "\n파레토 경계" : ""}` }));
          const fl = () => [...front()].map((i) => P()[i]).sort((a, z) => a.x - z.x);
          // the frontier as a staircase: each step holds until the next better point
          const stair = () => fl().flatMap((p, i) => (i ? [{ x: p.x, y: fl()[i - 1].y }, p] : [p]));
          const labs = createMemo(() => {
            const it = P().filter((p) => p.label && (p.on || P().filter((q) => q.label).length <= 10));
            const spots = placeLabels(it.map((p) => ({ x: p.x, y: p.y, w: tw(p.label, SM) + 2, h: 14 })), { x: c.x0, y: c.y0, w: c.iw, h: c.ih }, P().map((p) => ({ x: p.x - 4, y: p.y - 4, w: 8, h: 8 })), 5);
            return it.map((p, i) => ({ p, r: spots[i] }));
          });
          return (
            <g>
              <path class="st-line" style={{ stroke: "var(--ink-2)", "stroke-width": 1.5 }} d={line<{ x: number; y: number }>().x((p) => p.x).y((p) => p.y)(stair()) ?? ""} />
              <For each={P()}>{(p) => <circle cx={p.x} cy={p.y} r={p.r} style={{ fill: p.on ? p.color : "var(--viz-gap)", stroke: p.color, "stroke-width": p.on ? 2 : 1.5 }} />}</For>
              <For each={labs()}>{(l) => <Show when={l.r}><text class="st-dl" x={l.r!.x + 1} y={l.r!.y + 11}>{l.p.label}</text></Show>}</For>
              <Nearest pts={P()} box={c} />
            </g>
          );
        }}
      </Plot>
    </Show>
  );
}
defineViz<FrontB>({
  type: "frontier",
  family: "stat",
  title: "파레토 경계 (트레이드오프)",
  when: "비용(지연·크기)과 성능 사이에서 어떤 선택지가 손해 없는 최선인가",
  render: Frontier,
  examples: [
    {
      label: "모델별 지연 시간과 정확도", x: "지연 시간 (ms, 로그)", y: "Top-1 정확도 (%)", logx: true,
      points: [{ label: "MobileNet-S", x: 3.1, y: 71.2 }, { label: "EffNet-B0", x: 6.4, y: 77.1 }, { label: "ResNet-50", x: 11.8, y: 76.4 }, { label: "EffNet-B3", x: 18.2, y: 81.6 }, { label: "ViT-S", x: 14.5, y: 79.9 }, { label: "ConvNeXt-T", x: 21.4, y: 82.1 }, { label: "ResNet-152", x: 33.9, y: 78.6 }, { label: "ViT-B", x: 42.0, y: 81.8 }, { label: "ConvNeXt-B", x: 61.3, y: 83.8 }, { label: "ViT-L", x: 148, y: 85.2 }],
    },
  ],
});
