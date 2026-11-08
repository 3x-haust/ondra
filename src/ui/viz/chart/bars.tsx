// Comparison with bars: grouped, stacked, 100%, diverging, Likert, bar + line,
// population pyramid, waterfall and Pareto.
import { For } from "solid-js";
import { scaleLinear } from "d3-scale";
import { defineViz } from "../registry";
import { series, useTip } from "../kit";
import { t } from "../../../i18n";
import { arr, barPath, clamp, isNum, normSeries, pareto, sharePct, stackSeries, str, toNum, waterfall } from "./math";
import { AX, ChFrame, colorOf, cut, fmtC, fmtV, hover, MUTED, pct, TipBody, tw } from "./common";
import { autoOrient, BandPlot, type Seg } from "./band";

const unitOf = (b: any) => str(b.unit) || undefined;

function Grouped(props: { b: any; mode: "group" | "stack" | "percent" }) {
  const b = props.b;
  const d = normSeries(b);
  const unit = unitOf(b);
  const ss = d.series.slice(0, 9);
  const cats = d.x.map(String);
  const mode = props.mode;
  const slots = mode === "group" ? ss.length : 1;
  const orient = autoOrient(b.dir, cats, slots);
  const single = ss.length === 1;
  // one series: emphasis by item (items[].highlight) or the series colour
  const emItems = new Set(arr<any>(b.items).map((it, i) => (it?.highlight || it?.em ? i : -1)).filter((i) => i >= 0));
  const anyEm = ss.some((s) => s.em);
  const segs: Seg[] = [];
  const ends: { cat: number; slot: number; text: string; at: number }[] = [];
  const totals = cats.map((_, c) => ss.reduce((n, s) => n + (s.values[c] ?? 0), 0));
  if (mode === "group") {
    ss.forEach((s, k) =>
      s.values.forEach((v, c) => {
        if (v === null) return;
        const color = single ? (emItems.size && !emItems.has(c) ? MUTED : series(0)) : colorOf(k, s.em, anyEm);
        segs.push({ cat: c, slot: k, v0: 0, v1: v, color, end: true });
        if (single) ends.push({ cat: c, slot: 0, text: fmtC(v, unit === "%" ? "%" : undefined), at: v });
      }),
    );
  } else {
    const st = stackSeries(ss.map((s) => s.values), mode === "percent" ? "percent" : "diverging");
    cats.forEach((_, c) => {
      const pos = ss.map((s, k) => ({ k, v: s.values[c] ?? 0 })).filter((r) => r.v > 0);
      const neg = ss.map((s, k) => ({ k, v: s.values[c] ?? 0 })).filter((r) => r.v < 0);
      const shares = sharePct(ss.map((s) => Math.max(0, s.values[c] ?? 0)));
      ss.forEach((s, k) => {
        const v = s.values[c] ?? 0;
        if (!v) return;
        const [lo, hi] = st[k][c];
        const isEnd = v > 0 ? pos[pos.length - 1]?.k === k : neg[neg.length - 1]?.k === k;
        const v0 = v > 0 ? lo : hi, v1 = v > 0 ? hi : lo;
        segs.push({ cat: c, slot: 0, v0: mode === "percent" ? v0 * 100 : v0, v1: mode === "percent" ? v1 * 100 : v1, color: colorOf(k, s.em, anyEm), end: isEnd, inside: mode === "percent" ? `${shares[k]}%` : undefined });
      });
      if (mode === "stack" && pos.length) ends.push({ cat: c, slot: 0, text: fmtC(totals[c]), at: Math.max(...st.map((l) => l[c][1])) });
    });
  }
  return (
    <BandPlot
      label={str(b.label)}
      cats={cats}
      segs={segs}
      slots={slots}
      orient={orient}
      unit={mode === "percent" ? "%" : unit}
      domain={mode === "percent" ? [0, 100] : undefined}
      fmt={mode === "percent" ? (v) => `${Math.round(v)}%` : undefined}
      legend={ss.length > 1 ? ss.map((s, k) => ({ label: s.label, color: colorOf(k, s.em, anyEm) })) : undefined}
      ends={ends}
      rule={toNum(b.target) !== null ? { value: toNum(b.target)!, label: t("목표") } : undefined}
      tip={(c) => ({
        title: cats[c],
        rows: ss
          .map((s, k) => ({ s, k }))
          .filter(({ s }) => s.values[c] !== null)
          .reverse()
          .map(({ s, k }) => ({
            color: single ? undefined : colorOf(k, s.em, anyEm),
            key: "box" as const,
            label: single ? "" : s.label,
            value: mode === "percent" ? `${pct(((s.values[c] ?? 0) / (totals[c] || 1)) * 100)} · ${fmtV(s.values[c], unit)}` : fmtV(s.values[c], unit),
          })),
        foot: mode !== "group" && ss.length > 1 ? t("합계 {v}", { v: fmtV(totals[c], unit) }) : undefined,
      })}
    />
  );
}

const QUARTERS = ["1분기", "2분기", "3분기", "4분기"];
defineViz({
  type: "groupedBars",
  family: "chart",
  title: "묶은 막대",
  when: "범주마다 여러 계열의 크기를 나란히 비교 (계열 1개면 단순 막대)",
  render: (b: any) => <Grouped b={b} mode="group" />,
  examples: [
    {
      label: "분기별 매출",
      unit: "억 원",
      x: QUARTERS,
      series: [
        { label: "2024년", values: [182, 195, 201, 228] },
        { label: "2025년", values: [214, 231, 240, 262] },
        { label: "2026년", values: [251, 268, 279, null] },
      ],
    },
    {
      label: "부서별 미해결 티켓",
      unit: "건",
      dir: "h",
      items: [
        { label: "고객지원", value: 142 },
        { label: "결제·정산 플랫폼", value: 96, highlight: true },
        { label: "모바일 앱", value: 71 },
        { label: "데이터 엔지니어링", value: 48 },
        { label: "인프라", value: 33 },
        { label: "보안", value: 12 },
      ],
    },
  ],
});
defineViz({
  type: "stackedBars",
  family: "chart",
  title: "누적 막대",
  when: "범주마다 전체 크기와 그 구성을 함께 비교",
  render: (b: any) => <Grouped b={b} mode="stack" />,
  examples: [
    {
      label: "월별 클라우드 비용",
      unit: "만 원",
      x: ["5월", "6월", "7월", "8월", "9월", "10월"],
      series: [
        { label: "컴퓨팅", values: [820, 860, 910, 1040, 980, 1010] },
        { label: "스토리지", values: [310, 320, 335, 350, 362, 371] },
        { label: "네트워크", values: [140, 152, 149, 188, 171, 166] },
        { label: "기타", values: [60, 58, 71, 66, 69, 72] },
      ],
    },
  ],
});
defineViz({
  type: "percentBars",
  family: "chart",
  title: "100% 누적 막대",
  when: "범주마다 구성 비율이 어떻게 다른가 (크기는 무시)",
  render: (b: any) => <Grouped b={b} mode="percent" />,
  examples: [
    {
      label: "연령대별 결제 수단",
      unit: "건",
      dir: "h",
      x: ["20대", "30대", "40대", "50대", "60대 이상"],
      series: [
        { label: "간편결제", values: [612, 540, 402, 288, 141] },
        { label: "신용카드", values: [281, 362, 451, 498, 402] },
        { label: "계좌이체", values: [72, 81, 118, 162, 236] },
      ],
    },
  ],
});

// ───────────── diverging

defineViz({
  type: "diverging",
  family: "chart",
  title: "양·음 막대",
  when: "항목마다 기준(0)보다 얼마나 높고 낮은가 (증감, 손익, 편차)",
  render: (b: any) => {
    const items = arr<any>(b.items).filter((i) => i && isNum(toNum(i.value)));
    const ps = items.map((i, k) => ({ label: str(i.label, t("항목 {n}", { n: k + 1 })), value: toNum(i.value)! }));
    if (b.sort !== false) ps.sort((a, c) => c.value - a.value);
    const unit = unitOf(b);
    const sign = (v: number) => `${v > 0 ? "+" : ""}${fmtC(v, unit === "%" || unit === "%p" ? unit : undefined)}`;
    return (
      <BandPlot
        label={str(b.label)}
        cats={ps.map((p) => p.label)}
        segs={ps.map((p, c) => ({ cat: c, slot: 0, v0: 0, v1: p.value, color: p.value >= 0 ? "var(--viz-div-p2)" : "var(--viz-div-n2)", end: true }))}
        slots={1}
        orient="h"
        unit={unit}
        ends={ps.map((p, c) => ({ cat: c, slot: 0, text: sign(p.value), at: p.value }))}
        tip={(c) => ({ title: ps[c].label, rows: [{ label: unit ?? "", value: sign(ps[c].value) }] })}
      />
    );
  },
  examples: [
    {
      label: "전년 대비 매출 증감률",
      unit: "%",
      items: [
        { label: "화장품", value: 18.4 },
        { label: "식품", value: 7.2 },
        { label: "생활용품", value: 3.1 },
        { label: "가전", value: -2.6 },
        { label: "의류·잡화", value: -8.9 },
        { label: "도서", value: -12.3 },
      ],
    },
  ],
});

defineViz({
  type: "barLine",
  family: "chart",
  title: "막대 + 선 (같은 축)",
  when: "같은 단위의 두 값을 함께: 실적(막대)과 계획·평균(선)",
  render: (b: any) => {
    const d = normSeries(b);
    const unit = unitOf(b);
    const bars = d.series.filter((s) => s.as !== "line");
    const lines = d.series.filter((s) => s.as === "line");
    const cats = d.x.map(String);
    const segs: Seg[] = [];
    bars.forEach((s, k) => s.values.forEach((v, c) => v !== null && segs.push({ cat: c, slot: k, v0: 0, v1: v, color: series(k), end: true })));
    const lc = (k: number) => series(bars.length + k);
    return (
      <BandPlot
        label={str(b.label)}
        cats={cats}
        segs={segs}
        slots={Math.max(1, bars.length)}
        orient="v"
        unit={unit}
        lines={lines.map((l, k) => ({ label: l.label, values: l.values, color: lc(k), dash: l.dash }))}
        legend={[...bars.map((s, k) => ({ label: s.label, color: series(k) })), ...lines.map((l, k) => ({ label: l.label, color: lc(k), dash: true }))]}
        tip={(c) => ({
          title: cats[c],
          rows: [...bars.map((s, k) => ({ color: series(k), key: "box" as const, label: s.label, value: fmtV(s.values[c], unit) })), ...lines.map((l, k) => ({ color: lc(k), label: l.label, value: fmtV(l.values[c], unit) }))],
        })}
      />
    );
  },
  examples: [
    {
      label: "월별 생산량과 계획",
      unit: "톤",
      x: ["4월", "5월", "6월", "7월", "8월", "9월", "10월"],
      series: [
        { label: "실적", values: [412, 438, 401, 455, 470, 462, 488] },
        { label: "계획", values: [420, 420, 430, 440, 450, 460, 470], as: "line" },
      ],
    },
  ],
});

// ───────────── population pyramid

defineViz({
  type: "popPyramid",
  family: "chart",
  title: "인구 피라미드",
  when: "두 집단(남·여 등)의 구간별 분포를 좌우로 맞대어 비교",
  render: (b: any) => {
    const d = normSeries(b);
    const [L, R] = [d.series[0], d.series[1]];
    const unit = unitOf(b);
    const cats = d.x.map(String);
    const n = cats.length;
    const tip = useTip();
    const max = Math.max(1, ...[...(L?.values ?? []), ...(R?.values ?? [])].map((v) => Math.abs(v ?? 0)));
    const rh = clamp(Math.floor(260 / Math.max(1, n)), 14, 24);
    const legend = [L, R].filter(Boolean).map((s, k) => ({ label: s!.label, color: series(k) }));
    return (
      <ChFrame label={str(b.label)} height={() => n * rh + 30} legend={legend}>
        {(w, h) => {
          const cw = Math.min(Math.max(0, ...cats.map((c) => tw(c, AX))) + 16, w * 0.22);
          const mid = w / 2;
          const half = mid - cw / 2 - 6;
          const xs = scaleLinear().domain([0, max]).range([0, half]).nice(3);
          const ticks = xs.ticks(w < 460 ? 2 : 4).filter((t) => t > 0);
          const bt = rh - 4;
          const y = (c: number) => (n - 1 - c) * rh + 4; // first item at the bottom
          return (
            <>
              <g class="viz-axis">
                <For each={ticks}>
                  {(t) => (
                    <>
                      <line class="viz-grid" x1={mid - cw / 2 - xs(t)} x2={mid - cw / 2 - xs(t)} y1={0} y2={h - 22} />
                      <line class="viz-grid" x1={mid + cw / 2 + xs(t)} x2={mid + cw / 2 + xs(t)} y1={0} y2={h - 22} />
                      <text x={clamp(mid - cw / 2 - xs(t), tw(fmtC(t), AX) / 2 + 2, w)} y={h - 6} text-anchor="middle">{fmtC(t)}</text>
                      <text x={clamp(mid + cw / 2 + xs(t), 0, w - tw(fmtC(t), AX) / 2 - 2)} y={h - 6} text-anchor="middle">{fmtC(t)}</text>
                    </>
                  )}
                </For>
                <text x={mid} y={h - 6} text-anchor="middle">0</text>
              </g>
              <For each={cats}>
                {(c, i) => {
                  const lv = Math.abs(L?.values[i()] ?? 0), rv = Math.abs(R?.values[i()] ?? 0);
                  return (
                    <g class="viz-mark" {...hover(tip, () => <TipBody title={c} rows={[...(L ? [{ color: series(0), key: "box" as const, label: L.label, value: fmtV(lv, unit) }] : []), ...(R ? [{ color: series(1), key: "box" as const, label: R.label, value: fmtV(rv, unit) }] : [])]} />)}>
                      <rect class="ch-hit" x={0} y={y(i()) - 2} width={w} height={rh} />
                      <path d={barPath(mid - cw / 2 - xs(lv), y(i()), xs(lv), bt, "l", 3)} fill={series(0)} />
                      <path d={barPath(mid + cw / 2, y(i()), xs(rv), bt, "r", 3)} fill={series(1)} />
                      <text class="ch-cat" x={mid} y={y(i()) + bt / 2} dy="0.32em" text-anchor="middle">{cut(c, cw - 8, AX)}</text>
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
      label: "회원 연령 분포",
      unit: "명",
      x: ["10대", "20대", "30대", "40대", "50대", "60대", "70대 이상"],
      series: [
        { label: "남성", values: [1240, 5820, 7310, 6120, 3980, 1870, 620] },
        { label: "여성", values: [1610, 7240, 8020, 5480, 3410, 1520, 710] },
      ],
    },
  ],
});

// ───────────── waterfall, pareto

defineViz({
  type: "waterfall",
  family: "chart",
  title: "워터폴",
  when: "시작값이 어떤 증가·감소를 거쳐 최종값이 되었나 (중간 소계 포함)",
  render: (b: any) => {
    const steps = waterfall(b.items);
    const unit = unitOf(b);
    const cats = steps.map((s) => s.label);
    const colorOf = (k: string) => (k === "total" ? "var(--viz-muted)" : k === "up" ? "var(--viz-div-n2)" : "var(--viz-div-p2)");
    const label = (s: (typeof steps)[number]) => (s.kind === "total" ? fmtC(s.value) : `${s.value > 0 ? "+" : ""}${fmtC(s.value)}`);
    const orient = autoOrient(b.dir, cats, 1);
    return (
      <BandPlot
        label={str(b.label)}
        cats={cats}
        segs={steps.map((s, c) => ({ cat: c, slot: 0, v0: s.start, v1: s.end, color: colorOf(s.kind), end: true }))}
        slots={1}
        orient={orient}
        unit={unit}
        connectors
        legend={[{ label: str(b.upLabel, t("증가")), color: colorOf("up") }, { label: str(b.downLabel, t("감소")), color: colorOf("down") }, { label: t("합계"), color: colorOf("total") }]}
        ends={steps.map((s, c) => ({ cat: c, slot: 0, text: label(s), at: s.kind === "down" ? s.end : Math.max(s.start, s.end), below: s.kind === "down" }))}
        tip={(c) => ({ title: steps[c].label, rows: [{ label: steps[c].kind === "total" ? t("합계") : t("변화"), value: steps[c].kind === "total" ? fmtV(steps[c].value, unit) : `${steps[c].value > 0 ? "+" : ""}${fmtV(steps[c].value, unit)}` }], foot: steps[c].kind !== "total" ? t("누적 {v}", { v: fmtV(steps[c].end, unit) }) : undefined })}
      />
    );
  },
  examples: [
    {
      label: "영업이익 변동 (전년 → 올해)",
      unit: "억 원",
      items: [
        { label: "전년 이익", value: 120, total: true },
        { label: "매출 증가", value: 64 },
        { label: "원가 상승", value: -38 },
        { label: "인건비", value: -21 },
        { label: "소계", total: true },
        { label: "환율 효과", value: 12 },
        { label: "일회성 비용", value: -9 },
        { label: "올해 이익", total: true },
      ],
    },
  ],
});

defineViz({
  type: "pareto",
  family: "chart",
  title: "파레토",
  when: "어떤 소수의 원인이 전체의 대부분(80%)을 차지하나",
  render: (b: any) => {
    const ps = pareto(b.items);
    const unit = unitOf(b);
    const cats = ps.map((p) => p.label);
    return (
      <BandPlot
        label={str(b.label)}
        cats={cats}
        segs={ps.map((p, c) => ({ cat: c, slot: 0, v0: 0, v1: p.value, color: series(0), end: true }))}
        slots={1}
        orient="v"
        unit={unit}
        right={{ values: ps.map((p) => p.cum), color: series(1), label: t("누적 비율"), rule: toNum(b.rule) ?? 80 }}
        legend={[{ label: str(b.valueLabel, t("건수")), color: series(0) }, { label: t("누적 비율 (오른쪽 축)"), color: series(1), dash: true }]}
        tip={(c) => ({ title: ps[c].label, rows: [{ color: series(0), key: "box" as const, label: str(b.valueLabel, t("건수")), value: fmtV(ps[c].value, unit) }, { color: series(1), label: t("누적 비율"), value: pct(ps[c].cum, 1) }] })}
      />
    );
  },
  examples: [
    {
      label: "장애 원인별 건수 (최근 90일)",
      unit: "건",
      items: [
        { label: "설정 오류", value: 41 },
        { label: "외부 API", value: 27 },
        { label: "배포 실패", value: 18 },
        { label: "용량 부족", value: 9 },
        { label: "인증서 만료", value: 5 },
        { label: "네트워크", value: 4 },
        { label: "기타", value: 3 },
      ],
    },
  ],
});
