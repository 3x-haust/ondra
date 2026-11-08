// Part of a whole in blocks: marimekko, one 100% segmented bar and
// proportional areas.
import { For, Show } from "solid-js";
import { defineViz } from "../registry";
import { series, useTip } from "../kit";
import { arr, clamp, foldParts, marimekko, normSeries, parts, sharePct, str } from "./math";
import { AX, ChFrame, cut, fmtC, fmtV, hover, inkOn, MUTED, pct, TipBody, tw } from "./common";
import { t } from "../../../i18n";

const unitOf = (b: any) => str(b.unit) || undefined;

defineViz({
  type: "marimekko",
  family: "chart",
  title: "마리메코 (모자이크)",
  when: "범주별 크기(폭)와 그 안의 구성 비율(높이)을 한 그림에서",
  render: (b: any) => {
    const d = normSeries(b);
    const ss = d.series.slice(0, 8);
    const cats = d.x.map(String);
    const unit = unitOf(b);
    const tip = useTip();
    const grand = cats.reduce((n, _, c) => n + ss.reduce((m, s) => m + Math.max(0, s.values[c] ?? 0), 0), 0) || 1;
    return (
      <ChFrame label={str(b.label)} height={(w) => clamp(w * 0.5, 220, 320)} legend={ss.map((s, k) => ({ label: s.label, color: series(k) }))}>
        {(w, h) => {
          const x0 = tw("100%", AX) + 10, x1 = w - 2, top = 20, bottom = 22;
          const iw = x1 - x0, ih = h - top - bottom;
          const m = marimekko(ss.map((s) => s.values), 2 / Math.max(1, iw));
          return (
            <>
              <g class="viz-axis">
                <For each={[0, 25, 50, 75, 100]}>{(t) => <text x={x0 - 6} y={top + ih - (t / 100) * ih} dy="0.32em" text-anchor="end">{t}%</text>}</For>
              </g>
              <For each={m.rects}>
                {(r) => {
                  const x = x0 + r.x * iw, wd = r.w * iw;
                  const y = top + ih - r.y1 * ih, hh = (r.y1 - r.y0) * ih;
                  const sh = pct(r.share * 100);
                  return (
                    <g class="viz-mark" {...hover(tip, () => <TipBody title={`${cats[r.col]} · ${ss[r.row].label}`} rows={[{ color: series(r.row), key: "box", label: "", value: `${fmtV(r.value, unit)} · ${sh}` }]} foot={t("{c} 비중 {p}", { c: cats[r.col], p: pct((m.cols[r.col].total / grand) * 100) })} />)}>
                      <rect x={x} y={y} width={Math.max(0, wd)} height={Math.max(0, hh - 2)} fill={series(r.row)} rx={1.5} />
                      <Show when={wd > tw(sh) + 8 && hh > 18}><text class={inkOn(series(r.row))} x={x + wd / 2} y={y + (hh - 2) / 2} dy="0.32em" text-anchor="middle">{sh}</text></Show>
                    </g>
                  );
                }}
              </For>
              <For each={m.cols}>
                {(c, i) => (
                  <Show when={c.w * iw > 26}>
                    <text class="ch-cat" x={x0 + (c.x + c.w / 2) * iw} y={h - 6} text-anchor="middle">{cut(cats[i()], c.w * iw - 4, AX)}</text>
                    <text class="ch-note" x={x0 + (c.x + c.w / 2) * iw} y={12} text-anchor="middle">{cut(pct((c.total / grand) * 100), c.w * iw - 4, 11.5)}</text>
                  </Show>
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
      label: "지역·제품군별 매출 구성",
      unit: "억 원",
      x: ["수도권", "영남", "호남", "충청", "강원·제주"],
      series: [
        { label: "가전", values: [182, 74, 31, 38, 12] },
        { label: "모바일", values: [241, 92, 44, 51, 18] },
        { label: "생활", values: [96, 61, 38, 29, 14] },
      ],
    },
  ],
});

defineViz({
  type: "shareBar",
  family: "chart",
  title: "100% 막대 하나",
  when: "전체 하나가 몇 부분으로 나뉘는지 한 줄로 (6개 이하, 나머지는 기타)",
  render: (b: any) => {
    const ps = foldParts(parts(b.items), 6);
    const shares = sharePct(ps.map((p) => p.value));
    const total = ps.reduce((n, p) => n + p.value, 0) || 1;
    const unit = unitOf(b);
    const tip = useTip();
    const color = (i: number) => (ps[i].other ? MUTED : series(i));
    return (
      <ChFrame label={str(b.label)} height={() => 30} legend={ps.length > 1 ? ps.map((p, i) => ({ label: p.label, color: color(i) })) : undefined}>
        {(w) => {
          const room = w - 2 * (ps.length - 1);
          let x = 0;
          return (
            <For each={ps}>
              {(p, i) => {
                const wd = Math.max(1, (p.value / total) * room);
                const at = x;
                x += wd + 2;
                const lab = b.show === "value" ? fmtC(p.value) : `${shares[i()]}%`;
                return (
                  <g class="viz-mark" {...hover(tip, () => <TipBody title={p.label} rows={[{ color: color(i()), key: "box", label: "", value: `${shares[i()]}% · ${fmtV(p.value, unit)}` }]} />)}>
                    <rect x={at} y={1} width={wd} height={28} rx={4} fill={color(i())} />
                    <Show when={tw(lab) + 14 < wd}><text class={inkOn(color(i()))} x={at + 8} y={15} dy="0.32em">{lab}</text></Show>
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
      label: "저장 공간 사용",
      unit: "GB",
      items: [
        { label: "사진·영상", value: 142 },
        { label: "앱", value: 61 },
        { label: "문서", value: 18 },
        { label: "시스템", value: 24 },
        { label: "여유 공간", value: 11 },
      ],
    },
  ],
});

defineViz({
  type: "areaCompare",
  family: "chart",
  title: "면적 비교 (원 크기)",
  when: "몇 배 차이 나는 큰 값들을 원의 넓이로 실감나게 비교",
  render: (b: any) => {
    const ps = parts(b.items).slice(0, 12);
    const unit = unitOf(b);
    const max = Math.max(1, ...ps.map((p) => p.value));
    const square = b.shape === "square";
    const anyEm = arr<any>(b.items).some((i) => i?.em || i?.highlight);
    const isEm = (label: string) => arr<any>(b.items).some((i) => (i?.em || i?.highlight) && str(i.label) === label);
    const tip = useTip();
    const colsOf = (w: number) => clamp(Math.min(ps.length, Math.floor(w / 96)), 1, 6);
    const dMax = (w: number) => Math.min(w / colsOf(w) - 12, 150);
    const dOf = (w: number, i: number) => Math.max(3, Math.sqrt(ps[i].value / max) * dMax(w));
    // each row as tall as its biggest shape
    const rowTops = (w: number) => {
      const c = colsOf(w);
      const tops = [0];
      for (let r = 0; r * c < ps.length; r++) tops.push(tops[r] + Math.max(...ps.slice(r * c, r * c + c).map((_, k) => dOf(w, r * c + k))) + 48);
      return tops;
    };
    return (
      <ChFrame label={str(b.label)} height={(w) => rowTops(w)[rowTops(w).length - 1]}>
        {(w) => {
          const cols = colsOf(w), cw = w / cols;
          const tops = rowTops(w);
          return (
            <For each={ps}>
              {(p, i) => {
                const col = i() % cols, row = Math.floor(i() / cols);
                const d = dOf(w, i());
                const base = tops[row + 1] - 48;
                const cx = col * cw + cw / 2;
                const color = anyEm && !isEm(p.label) ? MUTED : series(0);
                return (
                  <g class="viz-mark" {...hover(tip, () => <TipBody title={p.label} rows={[{ label: "", value: fmtV(p.value, unit) }]} foot={p.value !== max ? t("가장 큰 값의 {p}", { p: pct((p.value / max) * 100) }) : undefined} />)}>
                    <rect class="ch-hit" x={col * cw} y={tops[row]} width={cw} height={tops[row + 1] - tops[row]} />
                    <Show when={square} fallback={<circle cx={cx} cy={base - d / 2} r={d / 2} fill={color} />}>
                      <rect x={cx - d / 2} y={base - d} width={d} height={d} rx={3} fill={color} />
                    </Show>
                    <text class="ch-cat" x={cx} y={base + 15} text-anchor="middle">{cut(p.label, cw - 8)}</text>
                    <text class="ch-val strong" x={cx} y={base + 32} text-anchor="middle">{cut(fmtV(p.value, unit), cw - 8)}</text>
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
      label: "서비스별 연간 클라우드 비용",
      unit: "억 원",
      items: [
        { label: "검색", value: 18.3 },
        { label: "추천", value: 10.4 },
        { label: "광고", value: 9.8 },
        { label: "결제", value: 1.9 },
        { label: "사내 도구", value: 0.9, em: true },
      ],
    },
  ],
});
