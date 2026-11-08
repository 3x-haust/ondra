// Two measures on x and y: bubble chart (with size and colour) and connected
// scatter (how two measures moved together over time).
import { For, Show } from "solid-js";
import { scaleLinear, scaleSqrt } from "d3-scale";
import { line } from "d3-shape";
import { defineViz } from "../registry";
import { series, useTip } from "../kit";
import { arr, clamp, extent, placeBoxes, str, toNum, valueDomain } from "./math";
import { ChFrame, cut, fmtC, fmtV, hover, makeY, MUTED, TipBody, tw, YGrid } from "./common";
import { t } from "../../../i18n";

/** x axis ticks under a plot with an axis title at the right end */
function XAxis(props: { s: (v: number) => number; ticks: number[]; y: number; x0: number; x1: number; title?: string; fmt?: (v: number) => string }) {
  return (
    <g class="viz-axis">
      <For each={props.ticks}>
        {(t) => (
          <>
            <line class="viz-grid" x1={Math.round(props.s(t)) + 0.5} x2={Math.round(props.s(t)) + 0.5} y1={0} y2={props.y - (props.title ? 32 : 18)} />
            <text x={props.s(t)} y={props.y - (props.title ? 14 : 0)} text-anchor="middle">{(props.fmt ?? fmtC)(t)}</text>
          </>
        )}
      </For>
      <Show when={props.title}><text class="viz-axis-title" x={props.x1} y={props.y} text-anchor="end">{props.title}</text></Show>
    </g>
  );
}

defineViz({
  type: "bubble",
  family: "chart",
  title: "버블 차트",
  when: "항목마다 세 값(x, y, 크기)과 집단을 한 번에: 어디에 몰려 있고 무엇이 큰가",
  render: (b: any) => {
    const groups = [...new Set(arr<any>(b.items).map((i) => str(i?.group)).filter(Boolean))];
    const pts = arr<any>(b.items)
      .filter((i) => i && typeof i === "object")
      .map((i, k) => ({ label: str(i.label, t("항목 {n}", { n: k + 1 })), x: toNum(i.x), y: toNum(i.y), size: toNum(i.size) ?? 1, g: groups.indexOf(str(i.group)) }))
      .filter((p): p is { label: string; x: number; y: number; size: number; g: number } => p.x !== null && p.y !== null)
      .sort((p, q) => q.size - p.size);
    // past three groups colour stops telling them apart: the rest go grey
    const colorOf = (g: number) => (g < 0 ? series(0) : g < 3 ? series(g) : MUTED);
    const tip = useTip();
    const xl = str(b.xLabel), yl = str(b.yLabel), sl = str(b.sizeLabel, t("크기"));
    return (
      <ChFrame
        label={str(b.label)}
        height={(w) => clamp(w * 0.62, 240, 380)}
        legend={groups.length > 1 ? [...groups.slice(0, 3).map((g, k) => ({ label: g, color: series(k) })), ...(groups.length > 3 ? [{ label: t("기타"), color: MUTED }] : [])] : undefined}
      >
        {(w, h) => {
          const rMax = clamp(w * 0.055, 14, 32);
          const r = scaleSqrt().domain([0, Math.max(1, ...pts.map((p) => p.size))]).range([0, rMax]);
          const top = yl ? 22 : 10;
          const y = makeY(valueDomain(extent(pts.map((p) => p.y)), "auto"), top + rMax * 0.6, h - (xl ? 40 : 26) - rMax * 0.6, { unit: str(b.yUnit) || undefined });
          const x0 = Math.ceil(y.width) + 10, x1 = w - rMax * 0.7 - 4;
          const xs = scaleLinear().domain(valueDomain(extent(pts.map((p) => p.x)), "auto")).range([x0 + rMax * 0.7, x1]).nice();
          const xt = xs.ticks(Math.max(2, Math.floor((x1 - x0) / 80)));
          // labels beside the bubbles that have room, biggest first
          const boxes = placeBoxes(
            pts.map((p, k) => {
              const t = cut(p.label, 110);
              const tw0 = tw(t);
              const cx = xs(p.x), cy = y.s(p.y), rr = r(p.size);
              const left = cx + rr + 4 + tw0 > w;
              return { k, t, x: left ? cx - rr - 4 - tw0 : cx + rr + 4, y: cy - 8, w: tw0, h: 16, left };
            }),
            2,
          ).filter((bx) => pts.every((p) => {
            const cx = xs(p.x), cy = y.s(p.y), rr = r(p.size);
            const nx = clamp(cx, bx.x, bx.x + bx.w), ny = clamp(cy, bx.y, bx.y + bx.h);
            return Math.hypot(nx - cx, ny - cy) >= rr - 1 || pts[bx.k] === p;
          }));
          return (
            <>
              <YGrid y={y} x0={x0} x1={w - 4} zero={false} />
              <XAxis s={(v) => xs(v)} ticks={xt} y={h - 6} x0={x0} x1={w - 4} title={xl} />
              <Show when={yl}><text class="viz-axis-title" x={x0} y={11}>{cut(yl, w / 2)}</text></Show>
              <For each={pts}>
                {(p) => (
                  <g class="viz-mark" {...hover(tip, () => <TipBody title={p.label} rows={[...(groups.length ? [{ color: colorOf(p.g), label: groups[p.g] ?? "", value: "" }] : []), { label: xl || "x", value: fmtV(p.x, str(b.xUnit) || undefined) }, { label: yl || "y", value: fmtV(p.y, str(b.yUnit) || undefined) }, { label: sl, value: fmtV(p.size, str(b.sizeUnit) || undefined) }]} />)}>
                    <circle cx={xs(p.x)} cy={y.s(p.y)} r={Math.max(12, r(p.size))} class="ch-hit" />
                    <circle cx={xs(p.x)} cy={y.s(p.y)} r={Math.max(3, r(p.size))} fill={colorOf(p.g)} fill-opacity="0.75" stroke="var(--card)" stroke-width="1.5" />
                  </g>
                )}
              </For>
              <For each={boxes}>{(bx) => <text class="ch-end" x={bx.x} y={bx.y + 8} dy="0.32em">{bx.t}</text>}</For>
            </>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "제품군별 성장률과 이익률",
      xLabel: "매출 성장률",
      xUnit: "%",
      yLabel: "영업이익률",
      yUnit: "%",
      sizeLabel: "매출",
      sizeUnit: "억 원",
      items: [
        { label: "구독 서비스", x: 34, y: 18, size: 420, group: "디지털" },
        { label: "광고", x: 12, y: 24, size: 610, group: "디지털" },
        { label: "커머스", x: 21, y: 6, size: 880, group: "커머스" },
        { label: "물류", x: 8, y: 3, size: 350, group: "커머스" },
        { label: "하드웨어", x: -4, y: 9, size: 270, group: "기기" },
        { label: "액세서리", x: 2, y: 14, size: 90, group: "기기" },
        { label: "B2B 솔루션", x: 27, y: 21, size: 190, group: "디지털" },
      ],
    },
  ],
});

defineViz({
  type: "connected",
  family: "chart",
  title: "연결 산점도",
  when: "두 지표가 시간에 따라 함께 어떻게 움직였나 (예: 실업률과 물가)",
  render: (b: any) => {
    const pts = arr<any>(b.items)
      .filter((i) => i && typeof i === "object")
      .map((i, k) => ({ label: str(i.label, `${k + 1}`), x: toNum(i.x), y: toNum(i.y) }))
      .filter((p): p is { label: string; x: number; y: number } => p.x !== null && p.y !== null);
    const tip = useTip();
    const xl = str(b.xLabel), yl = str(b.yLabel);
    const xu = str(b.xUnit) || undefined, yu = str(b.yUnit) || undefined;
    return (
      <ChFrame label={str(b.label)} height={(w) => clamp(w * 0.62, 240, 360)}>
        {(w, h) => {
          const top = yl ? 24 : 12;
          const y = makeY(valueDomain(extent(pts.map((p) => p.y)), "auto"), top, h - (xl ? 44 : 30), { unit: yu });
          const x0 = Math.ceil(y.width) + 10, x1 = w - 10;
          const xs = scaleLinear().domain(valueDomain(extent(pts.map((p) => p.x)), "auto")).range([x0 + 8, x1 - 8]).nice();
          const xt = xs.ticks(Math.max(2, Math.floor((x1 - x0) / 80)));
          const d = line<(typeof pts)[number]>().x((p) => xs(p.x)).y((p) => y.s(p.y))(pts) ?? "";
          const n = pts.length;
          // label the first and last point, then any others that fit
          const order = [0, n - 1, ...pts.map((_, i) => i).slice(1, -1)];
          const boxes = placeBoxes(
            order.filter((i, k) => i >= 0 && i < n && order.indexOf(i) === k).map((i) => {
              const t = pts[i].label;
              const tw0 = tw(t, 11.5);
              const px = xs(pts[i].x), py = y.s(pts[i].y);
              const right = px + 8 + tw0 < w;
              return { i, t, x: right ? px + 8 : px - 8 - tw0, y: py - 15, w: tw0, h: 13 };
            }),
            3,
          );
          return (
            <>
              <YGrid y={y} x0={x0} x1={x1} zero={false} />
              <XAxis s={(v) => xs(v)} ticks={xt} y={h - 6} x0={x0} x1={x1} title={xl} fmt={(v) => (xu === "%" ? `${fmtC(v)}%` : fmtC(v))} />
              <Show when={yl}><text class="viz-axis-title" x={x0} y={11}>{cut(yl, w / 2)}</text></Show>
              <path d={d} class="ch-line" stroke={series(0)} style={{ "stroke-width": "1.75px" }} />
              <For each={pts}>
                {(p, i) => (
                  <g class="viz-mark" {...hover(tip, () => <TipBody title={p.label} rows={[{ label: xl || "x", value: fmtV(p.x, xu) }, { label: yl || "y", value: fmtV(p.y, yu) }]} />)}>
                    <circle cx={xs(p.x)} cy={y.s(p.y)} r={12} class="ch-hit" />
                    <circle class="ch-dot" cx={xs(p.x)} cy={y.s(p.y)} r={i() === n - 1 ? 5 : i() === 0 ? 4 : 3} fill={i() === 0 ? "var(--card)" : series(0)} stroke={i() === 0 ? series(0) : undefined} style={i() === 0 ? { "stroke-width": "2px" } : undefined} />
                  </g>
                )}
              </For>
              <For each={boxes}>{(bx) => <text class="ch-note" classList={{ "ch-end": bx.i === 0 || bx.i === n - 1 }} x={bx.x} y={bx.y + 7} dy="0.32em">{bx.t}</text>}</For>
            </>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "실업률과 물가 상승률",
      xLabel: "실업률",
      xUnit: "%",
      yLabel: "물가 상승률",
      yUnit: "%",
      items: [
        { label: "2016", x: 3.7, y: 1.0 },
        { label: "2017", x: 3.7, y: 1.9 },
        { label: "2018", x: 3.8, y: 1.5 },
        { label: "2019", x: 3.8, y: 0.4 },
        { label: "2020", x: 4.0, y: 0.5 },
        { label: "2021", x: 3.7, y: 2.5 },
        { label: "2022", x: 2.9, y: 5.1 },
        { label: "2023", x: 2.7, y: 3.6 },
        { label: "2024", x: 2.8, y: 2.3 },
        { label: "2025", x: 2.9, y: 2.0 },
      ],
    },
  ],
});
