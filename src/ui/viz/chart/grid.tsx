// Cells: calendar heatmap, time × category heatmap, table heatmap, waffle and
// pictogram (icon array).
import { For, Show } from "solid-js";
import { defineViz } from "../registry";
import { div, seq, series, useTip } from "../kit";
import { arr, binOf, calendarCells, clamp, extent, foldParts, isNum, largestRemainder, parts, sharePct, str, thin, toNum, type Part } from "./math";
import { AX, ChFrame, cut, fmtC, fmtV, hover, inkOn, MUTED, TipBody, tw } from "./common";

const unitOf = (b: any) => str(b.unit) || undefined;
const DOW = ["월", "화", "수", "목", "금", "토", "일"];

// ───────────── calendar

defineViz({
  type: "calendar",
  family: "chart",
  title: "달력 히트맵",
  when: "날마다 얼마나 했나, 어느 요일·시기에 몰렸나 (깃허브 잔디처럼)",
  render: (b: any) => {
    let days: { date: string; value: number | null }[] = arr<any>(b.days).filter((d) => d && typeof d === "object").map((d) => ({ date: str(d.date), value: toNum(d.value) }));
    if (!days.length && b.values && typeof b.values === "object" && !Array.isArray(b.values)) days = Object.entries(b.values).map(([date, v]) => ({ date, value: toNum(v) }));
    const cal = calendarCells(days);
    const max = Math.max(0, ...cal.cells.map((c) => c.value ?? 0));
    const unit = unitOf(b);
    const tip = useTip();
    const STEPS = 5;
    const lay = (w: number) => {
      const avail = w - 24;
      let bands = 1;
      while (bands < 6 && avail / Math.ceil(cal.weeks / bands) < 11) bands++;
      const per = Math.ceil(cal.weeks / bands);
      const cell = clamp(Math.floor(avail / Math.max(1, per)), 8, 17);
      return { bands, per, cell };
    };
    const height = (w: number) => {
      const l = lay(w);
      return l.bands * (7 * l.cell + 20) + 22;
    };
    const fillOf = (v: number | null) => (v === null || v <= 0 ? "var(--viz-grid)" : seq((binOf(v, max, STEPS) - 1) / (STEPS - 1) * 0.84 + 0.16));
    return (
      <ChFrame label={str(b.label)} height={height}>
        {(w, h) => {
          const l = lay(w);
          const bandH = 7 * l.cell + 20;
          return (
            <>
              <For each={Array.from({ length: l.bands }, (_, i) => i)}>
                {(band) => {
                  const oy = band * bandH + 16;
                  const months = cal.months.filter((m) => m.week >= band * l.per && m.week < (band + 1) * l.per);
                  const mx = months.map((m) => 24 + (m.week - band * l.per) * l.cell);
                  const mlab = months.map((m) => (m.month === 1 || (band === 0 && m === months[0]) ? `${m.year}.${m.month}` : `${m.month}월`));
                  const keep = new Set(thin(mx.map((x, i) => x + tw(mlab[i], AX) / 2), mlab.map((s) => tw(s, AX)), 6));
                  return (
                    <>
                      <g class="viz-axis">
                        <For each={months}>{(_, i) => <Show when={keep.has(i())}><text x={mx[i()]} y={oy - 5}>{mlab[i()]}</text></Show>}</For>
                        <For each={[0, 2, 4]}>{(d) => <text x={0} y={oy + d * l.cell + l.cell / 2} dy="0.32em">{DOW[d]}</text>}</For>
                      </g>
                      <For each={cal.cells.filter((c) => c.week >= band * l.per && c.week < (band + 1) * l.per)}>
                        {(c) => (
                          <g class="viz-mark" {...hover(tip, () => <TipBody title={`${c.date} (${DOW[c.dow]})`} rows={[{ label: "", value: c.value === null ? "기록 없음" : fmtV(c.value, unit) }]} />)}>
                            <rect x={24 + (c.week - band * l.per) * l.cell} y={oy + c.dow * l.cell} width={l.cell - 2} height={l.cell - 2} rx={2} fill={fillOf(c.value)} />
                          </g>
                        )}
                      </For>
                    </>
                  );
                }}
              </For>
              <g transform={`translate(${w - (STEPS + 1) * 14 - 50},${h - 14})`}>
                <text class="ch-note" x={-6} y={5} dy="0.32em" text-anchor="end">적음</text>
                <For each={Array.from({ length: STEPS + 1 }, (_, i) => i)}>{(i) => <rect x={i * 14} y={0} width={11} height={11} rx={2} fill={i === 0 ? "var(--viz-grid)" : fillOf((i / STEPS) * max)} />}</For>
                <text class="ch-note" x={(STEPS + 1) * 14 + 4} y={5} dy="0.32em">많음</text>
              </g>
            </>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "하루 커밋 수 (최근 6개월)",
      unit: "회",
      days: (() => {
        const out: { date: string; value: number }[] = [];
        const start = Date.UTC(2026, 4, 11);
        for (let i = 0; i < 182; i++) {
          const d = new Date(start + i * 864e5);
          const dow = (d.getUTCDay() + 6) % 7;
          const wave = Math.sin(i / 9) + Math.sin(i / 23);
          const v = dow >= 5 ? (i % 5 === 0 ? 2 : 0) : Math.max(0, Math.round(4 + wave * 3 + ((i * 7919) % 5) - 2));
          out.push({ date: d.toISOString().slice(0, 10), value: v });
        }
        return out;
      })(),
    },
  ],
});

// ───────────── heatmap

defineViz({
  type: "heatmap",
  family: "chart",
  title: "히트맵 (시간 × 범주)",
  when: "두 기준(시간대 × 요일, 월 × 제품)이 만나는 곳마다 값이 얼마나 큰가",
  render: (b: any) => {
    const cols = arr<any>(b.x).map((v) => str(v));
    const rows = arr<any>(b.y).map((v) => str(v));
    const vals = rows.map((_, r) => cols.map((_, c) => toNum(arr(arr(b.values)[r])[c])));
    const ext = extent(vals.flat()) ?? [0, 1];
    const diverging = !!b.diverging;
    const mid = toNum(b.mid) ?? 0;
    const unit = unitOf(b);
    const tip = useTip();
    const span = Math.max(Math.abs(ext[1] - mid), Math.abs(ext[0] - mid)) || 1;
    const fillOf = (v: number | null) => (v === null ? "var(--viz-grid)" : diverging ? div((v - mid) / span) : seq((v - ext[0]) / (ext[1] - ext[0] || 1)));
    const lay = (w: number) => {
      const lw = Math.min(Math.max(0, ...rows.map((r) => tw(r))), w * 0.28) + 10;
      const cw = (w - lw) / Math.max(1, cols.length);
      const ch = clamp(cw * 0.75, 18, 30);
      return { lw, cw, ch };
    };
    return (
      <ChFrame label={str(b.label)} height={(w) => rows.length * lay(w).ch + 46}>
        {(w, h) => {
          const { lw, cw, ch } = lay(w);
          const keep = new Set(thin(cols.map((_, c) => lw + c * cw + cw / 2), cols.map((s) => tw(s, AX)), 6));
          const showVals = b.labels !== false && ch >= 18;
          return (
            <>
              <g class="viz-axis">
                <For each={cols}>{(c, i) => <Show when={keep.has(i())}><text x={lw + i() * cw + cw / 2} y={12} text-anchor="middle">{c}</text></Show>}</For>
              </g>
              <For each={rows}>
                {(r, ri) => (
                  <>
                    <text class="ch-cat" x={lw - 8} y={22 + ri() * ch + ch / 2} dy="0.32em" text-anchor="end">{cut(r, lw - 10)}</text>
                    <For each={cols}>
                      {(c, ci) => {
                        const v = vals[ri()][ci()];
                        const t = v === null ? "" : fmtC(v);
                        return (
                          <g class="viz-mark" {...hover(tip, () => <TipBody title={`${r} · ${c}`} rows={[{ label: "", value: fmtV(v, unit) }]} />)}>
                            <rect x={lw + ci() * cw + 1} y={22 + ri() * ch + 1} width={Math.max(1, cw - 2)} height={ch - 2} rx={3} fill={fillOf(v)} />
                            <Show when={showVals && t && tw(t, 11.5) + 6 < cw}>
                              <text class={inkOn(fillOf(v))} x={lw + ci() * cw + cw / 2} y={22 + ri() * ch + ch / 2} dy="0.32em" text-anchor="middle" style={{ "font-size": "11.5px", "font-weight": 400 }}>{t}</text>
                            </Show>
                          </g>
                        );
                      }}
                    </For>
                  </>
                )}
              </For>
              <g transform={`translate(${w - 7 * 16 - 40},${h - 14})`}>
                <text class="ch-note" x={-6} y={5} dy="0.32em" text-anchor="end">{fmtC(diverging ? mid - span : ext[0])}</text>
                <For each={[0, 1, 2, 3, 4, 5, 6]}>{(i) => <rect x={i * 16} y={0} width={14} height={10} rx={2} fill={diverging ? div((i - 3) / 3) : seq(i / 6)} />}</For>
                <text class="ch-note" x={7 * 16 + 4} y={5} dy="0.32em">{fmtC(diverging ? mid + span : ext[1])}</text>
              </g>
            </>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "요일·시간대별 주문 수",
      unit: "건",
      x: ["0시", "3시", "6시", "9시", "12시", "15시", "18시", "21시"],
      y: ["월", "화", "수", "목", "금", "토", "일"],
      values: [
        [42, 11, 18, 96, 182, 141, 210, 168],
        [38, 9, 21, 102, 176, 138, 204, 171],
        [40, 12, 19, 99, 188, 144, 221, 180],
        [45, 10, 22, 104, 191, 150, 236, 192],
        [61, 14, 20, 98, 197, 162, 284, 251],
        [88, 31, 15, 54, 168, 210, 262, 238],
        [79, 28, 12, 48, 159, 196, 241, 204],
      ],
    },
  ],
});

// ───────────── table heatmap

defineViz({
  type: "heatTable",
  family: "chart",
  title: "조건부 색 표",
  when: "숫자 표에서 열마다 높고 낮은 칸을 색으로 바로 찾기",
  render: (b: any) => {
    const columns = arr<any>(b.columns).map((c) => str(c));
    const rows = arr<any>(b.rows)
      .filter((r) => r && typeof r === "object")
      .slice(0, 30)
      .map((r, k) => ({ label: str(r.label, `행 ${k + 1}`), values: columns.map((_, c) => toNum(arr(r.values)[c])) }));
    const better = arr<any>(b.better).map((x) => str(x));
    const units = arr<any>(b.units).map((x) => str(x));
    const scale = str(b.scale, "col");
    const diverging = !!b.diverging;
    const allExt = extent(rows.flatMap((r) => r.values));
    const colExt = columns.map((_, c) => extent(rows.map((r) => r.values[c])));
    const tint = (v: number | null, c: number) => {
      if (v === null) return undefined;
      const e = scale === "all" ? allExt : colExt[c];
      if (!e) return undefined;
      if (diverging) {
        const m = Math.max(Math.abs(e[0]), Math.abs(e[1])) || 1;
        const t = v / m;
        return `color-mix(in srgb, ${t >= 0 ? "var(--viz-div-p3)" : "var(--viz-div-n3)"} ${Math.round(Math.abs(t) * 42)}%, transparent)`;
      }
      let t = (v - e[0]) / (e[1] - e[0] || 1);
      if (better[c] === "down") t = 1 - t;
      return `color-mix(in srgb, var(--viz-1) ${Math.round(4 + t * 40)}%, transparent)`;
    };
    return (
      <div class="blk viz ch ch-htable">
        <Show when={str(b.label)}><div class="blk-label">{str(b.label)}</div></Show>
        <div class="ch-htable-scroll">
          <table>
            <thead>
              <tr>
                <th>{str(b.corner)}</th>
                <For each={columns}>{(c) => <th title={c}>{c}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={rows}>
                {(r) => (
                  <tr>
                    <th title={r.label}>{r.label}</th>
                    <For each={r.values}>{(v, c) => <td style={{ background: tint(v, c()) }}>{fmtV(v, units[c()] || unitOf(b))}</td>}</For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </div>
    );
  },
  examples: [
    {
      label: "지점별 월간 실적",
      corner: "지점",
      columns: ["매출(억)", "객단가(천 원)", "재구매율(%)", "반품률(%)"],
      better: ["up", "up", "up", "down"],
      rows: [
        { label: "강남점", values: [48.2, 61.4, 38.1, 2.1] },
        { label: "판교점", values: [36.9, 58.2, 41.7, 1.8] },
        { label: "부산 서면점", values: [29.4, 49.8, 33.2, 3.4] },
        { label: "대전점", values: [18.1, 46.3, 29.8, 2.9] },
        { label: "광주점", values: [16.7, 44.9, 35.6, 2.4] },
        { label: "온라인", values: [52.8, 39.2, 27.4, 5.6] },
      ],
    },
  ],
});

// ───────────── waffle

/** names, amounts and shares beside a part-to-whole figure */
function PartRows(props: { ps: Part[]; shares: number[]; x: number; y: number; w: number; row: number; color: (i: number) => string; tip: (i: number) => any }) {
  const tip = useTip();
  return (
    <For each={props.ps}>
      {(p, i) => (
        <g class="viz-mark" {...hover(tip, () => props.tip(i()))}>
          <rect class="ch-hit" x={props.x} y={props.y + i() * props.row - props.row / 2} width={props.w} height={props.row} />
          <rect x={props.x} y={props.y + i() * props.row - 5} width={10} height={10} rx={3} fill={props.color(i())} />
          <text class="ch-cat" x={props.x + 18} y={props.y + i() * props.row} dy="0.32em">{cut(p.label, props.w - 18 - 96)}</text>
          <text class="ch-val" x={props.x + props.w - 46} y={props.y + i() * props.row} dy="0.32em" text-anchor="end">{fmtC(p.value)}</text>
          <text class="ch-val strong" x={props.x + props.w} y={props.y + i() * props.row} dy="0.32em" text-anchor="end">{props.shares[i()]}%</text>
        </g>
      )}
    </For>
  );
}

defineViz({
  type: "waffle",
  family: "chart",
  title: "와플 (100칸)",
  when: "전체를 100칸으로 볼 때 각 부분이 몇 칸인가 (비율을 세어 읽기)",
  render: (b: any) => {
    const ps = foldParts(parts(b.items), 6);
    const cellsN = clamp(Math.round(toNum(b.cells) ?? 100), 10, 400);
    const counts = largestRemainder(ps.map((p) => p.value), cellsN);
    const shares = sharePct(ps.map((p) => p.value));
    const unit = unitOf(b);
    const color = (i: number) => (ps[i].other ? MUTED : series(i));
    const owner: number[] = [];
    counts.forEach((c, k) => {
      for (let j = 0; j < c; j++) owner.push(k);
    });
    const cols = clamp(Math.round(toNum(b.cols) ?? Math.sqrt(cellsN)), 5, 40);
    const rowsN = Math.ceil(cellsN / cols);
    const tipOf = (i: number) => <TipBody title={ps[i].label} rows={[{ color: color(i), key: "box", label: `${counts[i]}칸`, value: `${shares[i]}% · ${fmtV(ps[i].value, unit)}` }]} />;
    const tip = useTip();
    const side = (w: number) => w >= 440;
    const cell = (w: number) => clamp(Math.floor((side(w) ? w * 0.42 : w) / cols), 8, 22);
    const ROW = 24;
    return (
      <ChFrame label={str(b.label)} height={(w) => (side(w) ? Math.max(cell(w) * rowsN, ps.length * ROW) + 4 : cell(w) * rowsN + 14 + ps.length * ROW)}>
        {(w, h) => {
          const c = cell(w);
          const gw = c * cols;
          const ox = side(w) ? 0 : (w - gw) / 2;
          const lx = side(w) ? gw + 28 : 4;
          const ly = side(w) ? h / 2 - (ps.length * ROW) / 2 + ROW / 2 : c * rowsN + 14 + ROW / 2;
          return (
            <>
              <For each={Array.from({ length: cellsN }, (_, i) => i)}>
                {(i) => {
                  const k = owner[i];
                  // filled row by row from the top left, part by part
                  const col = i % cols, row = Math.floor(i / cols);
                  return (
                    <g class="viz-mark" {...hover(tip, () => tipOf(k))}>
                      <rect x={ox + col * c} y={row * c} width={c - 2} height={c - 2} rx={Math.min(3, c / 4)} fill={k === undefined ? "var(--viz-grid)" : color(k)} />
                    </g>
                  );
                }}
              </For>
              <PartRows ps={ps} shares={shares} x={lx} y={ly} w={Math.min(w - lx - 4, 320)} row={ROW} color={color} tip={tipOf} />
            </>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "가구 소득 지출 구성",
      unit: "만 원",
      items: [
        { label: "주거·관리비", value: 92 },
        { label: "식비", value: 81 },
        { label: "교통·통신", value: 46 },
        { label: "교육", value: 38 },
        { label: "여가·문화", value: 27 },
        { label: "의료", value: 18 },
        { label: "기타 소비", value: 23 },
      ],
    },
  ],
});

// ───────────── pictogram

/** a plain person shape in a 20 × 26 box */
const PERSON = "M10 0.8a4.6 4.6 0 1 1 0 9.2a4.6 4.6 0 1 1 0-9.2ZM3.2 25.2V17.4C3.2 13.6 6 11.6 10 11.6S16.8 13.6 16.8 17.4V25.2Z";

defineViz({
  type: "pictogram",
  family: "chart",
  title: "아이콘 배열 (픽토그램)",
  when: "열 명 중 몇 명처럼, 비율을 사람 수로 직관적으로",
  render: (b: any) => {
    const total0 = toNum(b.total);
    let groups: { label: string; value: number }[] = parts(b.items).slice(0, 5);
    if (!groups.length && isNum(toNum(b.value))) groups = [{ label: str(b.valueLabel, str(b.label, "해당")), value: toNum(b.value)! }];
    const sum = groups.reduce((n, g) => n + g.value, 0);
    const total = Math.max(total0 ?? sum, sum, 1);
    // at most 100 icons; past that one icon stands for several
    const per = total > 100 ? Math.ceil(total / 100) : 1;
    const icons = Math.ceil(total / per);
    const counts = per === 1 ? groups.map((g) => Math.round(g.value)) : largestRemainder([...groups.map((g) => g.value), total - sum], icons).slice(0, groups.length);
    const unit = str(b.unit, "명");
    const owner: number[] = [];
    counts.forEach((c, k) => {
      for (let j = 0; j < c; j++) owner.push(k);
    });
    const tip = useTip();
    const IW = 20, IH = 26, GX = 6, GY = 8;
    const perRow = (w: number) => {
      const fit = Math.max(1, Math.floor((w - 8 + GX) / (IW + GX)));
      if (icons <= 12 && icons <= fit) return icons;
      // rows of 20, 10 or 5 so the count reads at a glance
      return [25, 20, 10, 5].find((k) => k <= fit && (icons > 25 || k <= icons) && !(k === 25 && icons % 25)) ?? fit;
    };
    const scale = (w: number) => (icons <= 20 && w >= 420 ? 1.3 : 1);
    const legend = groups.length > 1 ? groups.map((g, k) => ({ label: `${g.label} ${fmtC(g.value)}${unit}`, color: series(k) })) : undefined;
    const lead = groups.length === 1 ? `${fmtC(groups[0].value)}${unit} / ${fmtC(total)}${unit}` : "";
    return (
      <ChFrame
        label={str(b.label)}
        legend={legend}
        height={(w) => {
          const s = scale(w);
          return Math.ceil(icons / perRow(w)) * (IH + GY) * s + (lead ? 34 : 0) + (per > 1 ? 20 : 0);
        }}
      >
        {(w, h) => {
          const s = scale(w);
          const pr = perRow(w / s);
          const top = lead ? 34 : 0;
          return (
            <>
              <Show when={lead}><text class="ch-big" x={0} y={20} style={{ "font-size": "22px" }}>{lead}</text></Show>
              <g transform={`translate(0,${top}) scale(${s})`}>
                <For each={Array.from({ length: icons }, (_, i) => i)}>
                  {(i) => {
                    const k = owner[i];
                    return (
                      <g class="viz-mark" transform={`translate(${(i % pr) * (IW + GX)},${Math.floor(i / pr) * (IH + GY)})`} {...hover(tip, () => <TipBody title={k === undefined ? "나머지" : groups[k].label} rows={[{ label: "", value: k === undefined ? `${fmtC(total - sum)}${unit}` : `${fmtC(groups[k].value)}${unit} / ${fmtC(total)}${unit}` }]} />)}>
                        <rect class="ch-hit" x={-2} y={-2} width={IW + 4} height={IH + 4} />
                        <path d={PERSON} fill={k === undefined ? "var(--viz-grid)" : series(k)} />
                      </g>
                    );
                  }}
                </For>
              </g>
              <Show when={per > 1}><text class="ch-note" x={0} y={h - 4}>{`아이콘 1개 = ${fmtC(per)}${unit}`}</text></Show>
            </>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    { label: "사용자 10명 중 정기 결제 이용", unit: "명", value: 7, total: 10, valueLabel: "정기 결제" },
    {
      label: "설문 응답자 100명의 주 사용 기기",
      unit: "명",
      total: 100,
      items: [
        { label: "스마트폰", value: 64 },
        { label: "노트북", value: 23 },
        { label: "태블릿", value: 9 },
      ],
    },
  ],
});
