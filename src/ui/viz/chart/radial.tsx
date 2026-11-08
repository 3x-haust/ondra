// Round forms: pie and donut (6 slices at most, the rest folds into 기타),
// radar, polar area (Nightingale rose), radial bars, gauge and parliament.
import { For, Show } from "solid-js";
import { arc, pie as d3pie } from "d3-shape";
import { defineViz } from "../registry";
import { series, status, useTip } from "../kit";
import { arr, clamp, foldParts, isNum, largestRemainder, normSeries, parliamentSeats, parts, sharePct, stackSeries, str, toNum, type Part } from "./math";
import { ChFrame, cut, fmtC, fmtV, hover, inkOn, MUTED, pct, TipBody, tw } from "./common";
import { t } from "../../../i18n";

const unitOf = (b: any) => str(b.unit) || undefined;
const TAU = Math.PI * 2;
const partColor = (p: Part, i: number) => (p.other ? MUTED : series(i));

// ───────────── pie and donut

function PieChart(props: { b: any; hole: boolean }) {
  const b = props.b;
  const ps = foldParts(parts(b.items), 6);
  const unit = unitOf(b);
  const total = ps.reduce((n, p) => n + p.value, 0);
  const shares = sharePct(ps.map((p) => p.value));
  const tip = useTip();
  const side = (w: number) => w >= 440;
  const D = (w: number) => (side(w) ? clamp(w * 0.4, 150, 220) : clamp(w * 0.62, 150, 220));
  const ROW = 24;
  const height = (w: number) => (side(w) ? Math.max(D(w), ps.length * ROW) + 8 : D(w) + 14 + ps.length * ROW);
  const tipOf = (i: number) => <TipBody title={ps[i].label} rows={[{ color: partColor(ps[i], i), key: "box", label: "", value: `${shares[i]}% · ${fmtV(ps[i].value, unit)}` }]} />;
  return (
    <ChFrame label={str(b.label)} height={height}>
      {(w, h) => {
        const d = D(w);
        const r = d / 2;
        const cx = side(w) ? r + 4 : w / 2;
        const cy = side(w) ? h / 2 : r + 4;
        const inner = props.hole ? r - clamp(r * 0.36, 22, 34) : 0;
        const arcs = d3pie<Part>().sort(null).value((p) => p.value)(ps);
        const ar = arc<any>().innerRadius(inner).outerRadius(r).cornerRadius(props.hole ? 2 : 0);
        const lx = side(w) ? d + 28 : 4;
        const ly = side(w) ? h / 2 - (ps.length * ROW) / 2 + ROW / 2 : d + 14 + ROW / 2;
        const lw = Math.min(w - lx - 4, 320);
        const valW = Math.max(0, ...ps.map((p) => tw(fmtC(p.value))));
        return (
          <>
            <For each={arcs}>
              {(a, i) => {
                const [mx, my] = arc<any>().innerRadius(inner || r * 0.55).outerRadius(r).centroid(a);
                const t = `${shares[i()]}%`;
                const room = (a.endAngle - a.startAngle) * (inner ? (inner + r) / 2 : r * 0.62);
                return (
                  <g class="viz-mark" {...hover(tip, () => tipOf(i()))}>
                    <path class="ch-seg" d={ar(a) ?? ""} transform={`translate(${cx},${cy})`} fill={partColor(ps[i()], i())} />
                    <Show when={room > tw(t) + 10 && (inner ? r - inner >= 20 : true)}>
                      <text class={inkOn(partColor(ps[i()], i()))} x={cx + mx} y={cy + my} dy="0.32em" text-anchor="middle">{t}</text>
                    </Show>
                  </g>
                );
              }}
            </For>
            <Show when={props.hole}>
              <text class="ch-big" x={cx} y={cy - 2} text-anchor="middle" style={{ "font-size": `${clamp(r * 0.24, 16, 24)}px` }}>{fmtC(total)}</text>
              <text class="ch-muted" x={cx} y={cy + 16} text-anchor="middle">{cut(str(b.center, unit ? t("합계 · {u}", { u: unit }) : t("합계")), inner * 1.7)}</text>
            </Show>
            <For each={ps}>
              {(p, i) => (
                <g class="viz-mark" {...hover(tip, () => tipOf(i()))}>
                  <rect class="ch-hit" x={lx} y={ly + i() * ROW - ROW / 2} width={lw} height={ROW} />
                  <rect x={lx} y={ly + i() * ROW - 5} width={10} height={10} rx={3} fill={partColor(p, i())} />
                  <text class="ch-cat" x={lx + 18} y={ly + i() * ROW} dy="0.32em">{cut(p.label, lw - 18 - valW - 52)}</text>
                  <text class="ch-val" x={lx + lw - 46} y={ly + i() * ROW} dy="0.32em" text-anchor="end">{fmtC(p.value)}</text>
                  <text class="ch-val strong" x={lx + lw} y={ly + i() * ROW} dy="0.32em" text-anchor="end">{shares[i()]}%</text>
                </g>
              )}
            </For>
          </>
        );
      }}
    </ChFrame>
  );
}
const BROWSERS = [
  { label: "Chrome", value: 6120 },
  { label: "Safari", value: 2870 },
  { label: "Edge", value: 1040 },
  { label: "삼성 인터넷", value: 820 },
  { label: "Whale", value: 410 },
  { label: "Firefox", value: 260 },
  { label: "Opera", value: 90 },
  { label: "기타", value: 70 },
];
defineViz({
  type: "pie",
  family: "chart",
  title: "파이",
  when: "하나의 전체가 몇 개(6개 이하)의 부분으로 어떻게 나뉘나",
  render: (b: any) => <PieChart b={b} hole={false} />,
  examples: [
    {
      label: "결제 수단 비중",
      unit: "건",
      items: [
        { label: "간편결제", value: 5320 },
        { label: "신용카드", value: 3910 },
        { label: "계좌이체", value: 1180 },
        { label: "휴대폰 결제", value: 640 },
      ],
    },
  ],
});
defineViz({
  type: "donut",
  family: "chart",
  title: "도넛",
  when: "전체 합계와 그 구성 비율을 함께 (6개 초과는 기타로 묶임)",
  render: (b: any) => <PieChart b={b} hole />,
  examples: [{ label: "브라우저별 방문", unit: "명", items: BROWSERS }],
});

// ───────────── radar

defineViz({
  type: "radar",
  family: "chart",
  title: "레이더 (스파이더)",
  when: "여러 기준에서 대상 1~3개의 강약 모양을 한눈에 비교",
  render: (b: any) => {
    const axes = arr<any>(b.axes).map((a) => str(a)).filter(Boolean);
    const ss = arr<any>(b.series)
      .filter((s) => s && typeof s === "object")
      .slice(0, 4)
      .map((s, k) => ({ label: str(s.label, t("계열 {n}", { n: k + 1 })), values: axes.map((_, i) => toNum(arr(s.values)[i])) }));
    const max = (toNum(b.max) ?? 0) > 0 ? toNum(b.max)! : Math.max(1, ...ss.flatMap((s) => s.values.filter(isNum)));
    const unit = unitOf(b);
    const tip = useTip();
    const n = axes.length;
    return (
      <ChFrame label={str(b.label)} height={(w) => clamp(w * 0.62, 240, 360)} legend={ss.length > 1 ? ss.map((s, k) => ({ label: s.label, color: series(k) })) : undefined}>
        {(w, h) => {
          const R = Math.min(h / 2 - 26, w / 2 - (w < 460 ? 64 : 96));
          const cx = w / 2, cy = h / 2;
          const ang = (i: number) => -Math.PI / 2 + (i / n) * TAU;
          const pt = (i: number, v: number) => [cx + Math.cos(ang(i)) * R * clamp(v / max, 0, 1.05), cy + Math.sin(ang(i)) * R * clamp(v / max, 0, 1.05)] as const;
          const ring = (f: number) => axes.map((_, i) => pt(i, max * f).join(",")).join(" ");
          const sideRoom = w / 2 - R - 14;
          return (
            <Show when={n >= 3}>
              <For each={[0.25, 0.5, 0.75, 1]}>{(f) => <polygon points={ring(f)} class="viz-grid" fill="none" />}</For>
              <For each={axes}>
                {(a, i) => {
                  const [x, y] = pt(i(), max * 1.0);
                  const c = Math.cos(ang(i())), s = Math.sin(ang(i()));
                  const anchor = Math.abs(c) < 0.2 ? "middle" : c > 0 ? "start" : "end";
                  const room = anchor === "middle" ? R * 1.2 : sideRoom;
                  return (
                    <>
                      <line class="viz-grid" x1={cx} y1={cy} x2={x} y2={y} />
                      <text class="ch-cat" x={x + c * 10} y={y + s * 12} dy="0.32em" text-anchor={anchor}>{cut(a, room)}</text>
                    </>
                  );
                }}
              </For>
              <g class="viz-axis">
                <For each={[0.5, 1]}>{(f) => <text x={cx + 4} y={cy - R * f + 10} style={{ "font-size": "11px" }}>{fmtC(max * f)}</text>}</For>
              </g>
              <For each={ss}>
                {(s, k) => {
                  const pts = s.values.map((v, i) => pt(i, v ?? 0));
                  return (
                    <g>
                      <polygon points={pts.map((p) => p.join(",")).join(" ")} fill={series(k())} fill-opacity="0.12" stroke={series(k())} stroke-width="2" stroke-linejoin="round" />
                      <For each={pts}>
                        {(p, i) => (
                          <g class="viz-mark" {...hover(tip, () => <TipBody title={axes[i()]} rows={ss.map((t, j) => ({ color: series(j), label: t.label, value: fmtV(t.values[i()], unit) }))} />)}>
                            <circle cx={p[0]} cy={p[1]} r={11} class="ch-hit" />
                            <circle class="ch-dot" cx={p[0]} cy={p[1]} r={3.5} fill={series(k())} />
                          </g>
                        )}
                      </For>
                    </g>
                  );
                }}
              </For>
            </Show>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "후보 프레임워크 평가 (10점)",
      max: 10,
      axes: ["성능", "학습 난이도", "생태계", "타입 지원", "번들 크기", "문서"],
      series: [
        { label: "SolidJS", values: [9, 7, 6, 9, 9, 7] },
        { label: "React", values: [7, 8, 10, 9, 6, 9] },
      ],
    },
  ],
});

// ───────────── rose

defineViz({
  type: "rose",
  family: "chart",
  title: "나이팅게일 로즈 (극좌표 영역)",
  when: "주기(월·요일·방위)마다 양이 어떻게 다른가, 계열을 쌓아서도",
  render: (b: any) => {
    const d = normSeries(b);
    const ss = d.series.slice(0, 6);
    const cats = d.x.map(String);
    const st = stackSeries(ss.map((s) => s.values.map((v) => (v === null ? null : Math.max(0, v)))), "stack");
    const max = Math.max(1, ...st.flat().map((p) => p[1]));
    const unit = unitOf(b);
    const tip = useTip();
    const n = cats.length;
    return (
      <ChFrame label={str(b.label)} height={(w) => clamp(w * 0.7, 260, 380)} legend={ss.length > 1 ? ss.map((s, k) => ({ label: s.label, color: series(k) })) : undefined}>
        {(w, h) => {
          const R = Math.min(h / 2 - 24, w / 2 - 40);
          const cx = w / 2, cy = h / 2;
          const rr = (v: number) => Math.sqrt(v / max) * R; // area, not radius, carries the value
          const a0 = (i: number) => (i / n) * TAU;
          const lab = Math.max(0, ...cats.map((c) => tw(c)));
          const keep = (i: number) => lab < (TAU * (R + 14)) / n - 6 || i % Math.ceil((lab + 6) / ((TAU * (R + 14)) / n)) === 0;
          return (
            <>
              <For each={[0.25, 0.5, 1]}>{(f) => <circle cx={cx} cy={cy} r={rr(max * f)} class="viz-grid" fill="none" />}</For>
              <For each={cats}>
                {(c, i) => {
                  const mid = a0(i()) + Math.PI / n - Math.PI / 2;
                  return (
                    <g class="viz-mark" {...hover(tip, () => <TipBody title={c} rows={ss.map((s, k) => ({ color: series(k), key: "box" as const, label: s.label, value: fmtV(s.values[i()], unit) })).reverse()} />)}>
                      <For each={ss}>
                        {(_, k) => {
                          const [lo, hi] = st[k()][i()];
                          const p = arc<any>()({ innerRadius: rr(lo), outerRadius: rr(hi), startAngle: a0(i()), endAngle: a0(i() + 1), padAngle: 0.015 }) ?? "";
                          return <Show when={hi > lo}><path class="ch-seg" d={p} transform={`translate(${cx},${cy})`} fill={series(k())} style={{ "stroke-width": "1px" }} /></Show>;
                        }}
                      </For>
                      <Show when={keep(i())}>
                        <text class="ch-cat" x={cx + Math.cos(mid) * (R + 14)} y={cy + Math.sin(mid) * (R + 14)} dy="0.32em" text-anchor={Math.abs(Math.cos(mid)) < 0.25 ? "middle" : Math.cos(mid) > 0 ? "start" : "end"}>{c}</text>
                      </Show>
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
      label: "월별 장애 건수 (원인별)",
      unit: "건",
      x: ["1월", "2월", "3월", "4월", "5월", "6월", "7월", "8월", "9월", "10월", "11월", "12월"],
      series: [
        { label: "배포", values: [4, 3, 6, 5, 7, 4, 3, 5, 8, 6, 4, 2] },
        { label: "설정", values: [2, 2, 3, 1, 2, 4, 5, 3, 2, 3, 2, 1] },
        { label: "외부 요인", values: [1, 0, 1, 2, 1, 3, 4, 6, 2, 1, 1, 3] },
      ],
    },
  ],
});

// ───────────── radial bars

defineViz({
  type: "radialBars",
  family: "chart",
  title: "원형 막대",
  when: "몇 개 항목의 달성률·크기를 원형 트랙 위에서 비교 (목표 대비 %)",
  render: (b: any) => {
    const ps = arr<any>(b.items)
      .filter((i) => i && isNum(toNum(i.value)))
      .slice(0, 8)
      .map((i, k) => ({ label: str(i.label, t("항목 {n}", { n: k + 1 })), value: toNum(i.value)! }));
    const max = (toNum(b.max) ?? 0) > 0 ? toNum(b.max)! : Math.max(1, ...ps.map((p) => p.value));
    const unit = unitOf(b);
    const tip = useTip();
    const RING = 12, GAP = 6;
    const R = 34 + ps.length * (RING + GAP);
    return (
      <ChFrame label={str(b.label)} height={() => R * 2 + 12}>
        {(w, h) => {
          const cx = w / 2, cy = h / 2;
          const sweep = 1.5 * Math.PI;
          return (
            <For each={ps}>
              {(p, k) => {
                const ro = R - k() * (RING + GAP), ri = ro - RING;
                const track = arc<any>()({ innerRadius: ri, outerRadius: ro, startAngle: 0, endAngle: sweep, cornerRadius: RING / 2 }) ?? "";
                const val = arc<any>()({ innerRadius: ri, outerRadius: ro, startAngle: 0, endAngle: sweep * clamp(p.value / max, 0, 1), cornerRadius: RING / 2 }) ?? "";
                const text = `${p.label} ${unit === "%" ? pct(p.value) : fmtC(p.value)}`;
                return (
                  <g class="viz-mark" {...hover(tip, () => <TipBody title={p.label} rows={[{ label: "", value: fmtV(p.value, unit) }]} foot={b.max ? t("최대 {v}", { v: fmtV(max, unit) }) : undefined} />)}>
                    <path d={track} transform={`translate(${cx},${cy})`} class="ch-track" />
                    <Show when={p.value > 0}><path d={val} transform={`translate(${cx},${cy})`} fill={series(0)} opacity={1 - k() * 0.08} /></Show>
                    <text class="ch-cat" x={cx - 8} y={cy - ro + RING / 2} dy="0.32em" text-anchor="end">{cut(text, cx - 10)}</text>
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
      label: "분기 목표 달성률",
      unit: "%",
      max: 100,
      items: [
        { label: "매출", value: 92 },
        { label: "신규 고객", value: 78 },
        { label: "재구매율", value: 64 },
        { label: "NPS", value: 51 },
      ],
    },
  ],
});

// ───────────── gauge

defineViz({
  type: "gauge",
  family: "chart",
  title: "게이지",
  when: "값 하나가 정해진 범위와 나쁨·주의·좋음 구간 중 어디에 있나",
  render: (b: any) => {
    const min = toNum(b.min) ?? 0;
    const max = toNum(b.max) ?? 100;
    const v = toNum(b.value) ?? min;
    const unit = unitOf(b);
    const tgt = toNum(b.target);
    const bands = arr<any>(b.bands)
      .map((x) => ({ to: toNum(x?.to), status: str(x?.status), label: str(x?.label) }))
      .filter((x): x is { to: number; status: string; label: string } => x.to !== null)
      .sort((p, q) => p.to - q.to);
    const colorFor = (s: string) => (s === "good" ? status.good : s === "warn" ? status.warn : s === "serious" ? status.serious : s === "bad" ? status.bad : MUTED);
    const band = bands.find((x) => v <= x.to) ?? bands[bands.length - 1];
    const fill = band ? colorFor(band.status) : series(0);
    const f = (x: number) => clamp((x - min) / (max - min || 1), 0, 1);
    const A = (x: number) => -Math.PI / 2 + f(x) * Math.PI;
    const tip = useTip();
    return (
      <ChFrame label={str(b.label)} height={(w) => clamp(w * 0.42, 150, 220) + 30}>
        {(w, h) => {
          const R = Math.min(w / 2 - 24, h - 40);
          const cx = w / 2, cy = R + 12;
          const T = clamp(R * 0.16, 12, 22);
          const track = arc<any>()({ innerRadius: R - T, outerRadius: R, startAngle: -Math.PI / 2, endAngle: Math.PI / 2, cornerRadius: 3 }) ?? "";
          const val = arc<any>()({ innerRadius: R - T, outerRadius: R, startAngle: -Math.PI / 2, endAngle: A(v), cornerRadius: 3 }) ?? "";
          let prev = min;
          const segs = bands.map((x) => {
            const s = { from: prev, to: Math.min(x.to, max), color: colorFor(x.status), label: x.label };
            prev = x.to;
            return s;
          });
          const tx = (x: number, r: number) => cx + Math.sin(A(x)) * r;
          const ty = (x: number, r: number) => cy - Math.cos(A(x)) * r;
          const fs = clamp(R * 0.34, 22, 40);
          return (
            <g class="viz-mark" {...hover(tip, () => <TipBody title={str(b.label) || undefined} rows={[{ label: band?.label || "", value: fmtV(v, unit) }, ...(tgt !== null ? [{ label: t("목표"), value: fmtV(tgt, unit) }] : []), ...segs.map((s) => ({ color: s.color, key: "box" as const, label: s.label, value: `${fmtC(s.from)}~${fmtC(s.to)}` }))]} />)}>
              <path d={track} transform={`translate(${cx},${cy})`} class="ch-track" />
              <path d={val} transform={`translate(${cx},${cy})`} fill={fill} />
              <For each={segs}>
                {(s) => <path d={arc<any>()({ innerRadius: R + 4, outerRadius: R + 8, startAngle: A(s.from) + 0.01, endAngle: A(s.to) - 0.01 }) ?? ""} transform={`translate(${cx},${cy})`} fill={s.color} />}
              </For>
              <Show when={tgt !== null}>
                <line x1={tx(tgt!, R - T - 4)} y1={ty(tgt!, R - T - 4)} x2={tx(tgt!, R + 10)} y2={ty(tgt!, R + 10)} stroke="var(--ink)" stroke-width="2.5" stroke-linecap="round" />
              </Show>
              <text class="ch-big" x={cx} y={cy - 6} text-anchor="middle" style={{ "font-size": `${fs}px` }}>{fmtC(v)}</text>
              <text class="ch-muted" x={cx} y={cy + 14} text-anchor="middle">{cut([unit, band?.label].filter(Boolean).join(" · "), R * 1.4)}</text>
              <g class="viz-axis">
                <text x={cx - R + T / 2} y={cy + 16} text-anchor="middle">{fmtC(min)}</text>
                <text x={cx + R - T / 2} y={cy + 16} text-anchor="middle">{fmtC(max)}</text>
              </g>
            </g>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "서버 CPU 사용률",
      unit: "%",
      value: 72,
      min: 0,
      max: 100,
      target: 60,
      bands: [{ to: 60, status: "good", label: "정상" }, { to: 85, status: "warn", label: "주의" }, { to: 100, status: "bad", label: "위험" }],
    },
  ],
});

// ───────────── parliament

defineViz({
  type: "parliament",
  family: "chart",
  title: "의석 (반원 점)",
  when: "정해진 자리(의석·인원·좌석)가 집단별로 몇 개씩 나뉘었나, 과반은 누구인가",
  render: (b: any) => {
    const ps = parts(b.items).slice(0, 8);
    const total = toNum(b.total) ?? ps.reduce((n, p) => n + p.value, 0);
    const counts = ps.reduce((n, p) => n + p.value, 0) > total ? largestRemainder(ps.map((p) => p.value), total) : ps.map((p) => Math.round(p.value));
    const majority = b.majority === false ? null : toNum(b.majority) ?? Math.floor(total / 2) + 1;
    const tip = useTip();
    return (
      <ChFrame label={str(b.label)} height={(w) => clamp(w * 0.42, 150, 260) + 12} legend={ps.map((p, k) => ({ label: `${p.label} ${counts[k]}`, color: series(k) }))}>
        {(w, h) => {
          const R = Math.min(w / 2 - 8, h - 14);
          const seats = parliamentSeats(total, R);
          const cx = w / 2, cy = R + 4;
          const owner: number[] = [];
          counts.forEach((c, k) => {
            for (let j = 0; j < c; j++) owner.push(k);
          });
          return (
            <>
              <For each={seats}>
                {(s, i) => {
                  const k = owner[i()];
                  const color = k === undefined ? "var(--viz-grid)" : series(k);
                  return (
                    <g class="viz-mark" {...(k !== undefined ? hover(tip, () => <TipBody title={ps[k].label} rows={[{ color: series(k), key: "box", label: "", value: `${t("{n}석", { n: counts[k] })} · ${pct((counts[k] / (total || 1)) * 100, 1)}` }]} />) : {})}>
                      <circle cx={cx + s.x} cy={cy + s.y} r={Math.max(1.5, s.r)} fill={color} />
                    </g>
                  );
                }}
              </For>
              <text class="ch-big" x={cx} y={cy - 8} text-anchor="middle" style={{ "font-size": `${clamp(R * 0.18, 16, 26)}px` }}>{total}</text>
              <Show when={majority}><text class="ch-muted" x={cx} y={cy + 8} text-anchor="middle">{t("과반 {n}", { n: majority! })}</text></Show>
            </>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "대의원회 의석",
      unit: "석",
      items: [
        { label: "미래연합", value: 58 },
        { label: "새물결", value: 21 },
        { label: "청년회의", value: 34 },
        { label: "무소속", value: 17 },
      ],
    },
  ],
});
