// Finance and KPIs: candlestick / OHLC with a volume pane, KPI tiles, a set of
// goals, one big number with its comparison, and a sparkline table.
import { For, Show } from "solid-js";
import { line } from "d3-shape";
import { scaleLinear } from "d3-scale";
import { defineViz } from "../registry";
import { num, series } from "../kit";
import { t } from "../../../i18n";
import { arr, clamp, deltaNum, deltaTone, extent, isNum, str, toNum } from "./math";
import { Arrow, ChFrame, Crosshair, fmtC, fmtV, makeX, makeY, pct, Spark, TipBody, tw, XTicks, YGrid, box } from "./common";

const unitOf = (b: any) => str(b.unit) || undefined;
const UP = "var(--viz-div-p2)";
const DOWN = "var(--viz-div-n2)";

// ───────────── candlestick

defineViz({
  type: "candle",
  family: "chart",
  title: "캔들스틱 (OHLC + 거래량)",
  when: "가격이 기간마다 어디서 시작해 어디까지 오르내리고 끝났나, 거래량과 함께",
  render: (b: any) => {
    const rows = arr<any>(b.items)
      .filter((i) => i && typeof i === "object")
      .map((i, k) => ({ x: str(i.x ?? i.date ?? i.label, `${k + 1}`), o: toNum(i.o ?? i.open), h: toNum(i.h ?? i.high), l: toNum(i.l ?? i.low), c: toNum(i.c ?? i.close), v: toNum(i.v ?? i.volume) }))
      .filter((r): r is { x: string; o: number; h: number; l: number; c: number; v: number | null } => [r.o, r.h, r.l, r.c].every(isNum));
    const unit = unitOf(b);
    const ohlc = b.style === "ohlc";
    const hasVol = rows.some((r) => r.v !== null);
    const mas = arr<any>(b.ma).map(toNum).filter((n): n is number => n !== null && n > 1).slice(0, 2);
    const maVals = mas.map((n) => rows.map((_, i) => (i + 1 >= n ? rows.slice(i + 1 - n, i + 1).reduce((a, r) => a + r.c, 0) / n : null)));
    const maColor = (k: number) => series(k === 0 ? 2 : 6);
    const legend = () => [{ label: t("상승"), color: UP }, { label: t("하락"), color: DOWN }, ...mas.map((n, k) => ({ label: t("{n}일 이동평균", { n }), color: maColor(k), dash: true }))];
    return (
      <ChFrame label={str(b.label)} height={(w) => clamp(w * 0.55, 240, 340) + (hasVol ? 70 : 0)} legend={legend()}>
        {(w, h) => {
          const volH = hasVol ? 56 : 0;
          const top = 8, bottom = 24;
          const priceBottom = h - bottom - (hasVol ? volH + 12 : 0);
          const ext = extent(rows.flatMap((r) => [r.h, r.l, ...maVals.map(() => null)])) ?? [0, 1];
          const pad = (ext[1] - ext[0]) * 0.06 || 1;
          const y = makeY([ext[0] - pad, ext[1] + pad], top, priceBottom, { fmt: (v) => (Math.abs(v) < 1e6 ? num(v) : fmtC(v)) });
          const lastC = rows.length ? rows[rows.length - 1].c : 0;
          const tagW = tw(num(lastC), 12.5, 600) + 10;
          const x0 = Math.ceil(y.width) + 10, x1 = w - tagW - 4;
          const n = rows.length;
          const step = (x1 - x0) / Math.max(1, n);
          const X = makeX(rows.map((r) => r.x), x0 + step / 2, x1 - step / 2);
          const bw = clamp(step * 0.62, 1, 12);
          const vmax = Math.max(1, ...rows.map((r) => r.v ?? 0));
          const vy = scaleLinear().domain([0, vmax]).range([h - bottom, h - bottom - volH]);
          const b0 = box(x0, top, x1 - x0, h - bottom - top, w, h);
          const col = (r: (typeof rows)[number], i: number) => (r.c > r.o || (r.c === r.o && i > 0 && r.c >= rows[i - 1].c) ? UP : DOWN);
          return (
            <>
              <YGrid y={y} x0={x0} x1={x1} zero={false} />
              <Show when={hasVol}>
                <line class="viz-base" x1={x0} x2={x1} y1={h - bottom + 0.5} y2={h - bottom + 0.5} />
              </Show>
              <XTicks ticks={X.ticks} y={h - 6} w={w} />
              <For each={rows}>
                {(r, i) => {
                  const x = X.pos(i());
                  const c = col(r, i());
                  return (
                    <g>
                      <Show
                        when={!ohlc}
                        fallback={
                          <path d={`M${x},${y.s(r.h)}V${y.s(r.l)}M${x - bw / 2},${y.s(r.o)}H${x}M${x},${y.s(r.c)}H${x + bw / 2}`} stroke={c} stroke-width="1.5" fill="none" />
                        }
                      >
                        <line x1={x} x2={x} y1={y.s(r.h)} y2={y.s(r.l)} stroke={c} stroke-width="1" />
                        <rect x={x - bw / 2} y={Math.min(y.s(r.o), y.s(r.c))} width={bw} height={Math.max(1, Math.abs(y.s(r.o) - y.s(r.c)))} fill={c} rx={Math.min(1.5, bw / 4)} />
                      </Show>
                      <Show when={r.v !== null}>
                        <rect x={x - bw / 2} y={vy(r.v!)} width={bw} height={Math.max(0, h - bottom - vy(r.v!))} fill={c} opacity="0.45" />
                      </Show>
                    </g>
                  );
                }}
              </For>
              <For each={maVals}>
                {(vals, k) => <path class="ch-line dash" d={line<number>().defined((i) => vals[i] !== null).x((i) => X.pos(i)).y((i) => y.s(vals[i]!))(vals.map((_, i) => i)) ?? ""} stroke={maColor(k())} style={{ "stroke-width": "1.5px" }} />}
              </For>
              <Show when={n}>
                <line class="ch-target" x1={X.pos(n - 1)} x2={x1 + 2} y1={y.s(lastC)} y2={y.s(lastC)} />
                <text class="ch-val strong" x={x1 + 6} y={y.s(lastC)} dy="0.32em">{num(lastC)}</text>
              </Show>
              <Crosshair
                b={b0}
                n={n}
                pos={X.pos}
                points={() => []}
                tip={(i) => {
                  const r = rows[i];
                  const prev = i > 0 ? rows[i - 1].c : r.o;
                  const ch = ((r.c - prev) / (prev || 1)) * 100;
                  return (
                    <TipBody
                      title={r.x}
                      rows={[
                        { label: t("시가"), value: fmtV(r.o, unit) },
                        { label: t("고가"), value: fmtV(r.h, unit) },
                        { label: t("저가"), value: fmtV(r.l, unit) },
                        { color: col(r, i), key: "box", label: t("종가 ({p})", { p: `${ch > 0 ? "+" : ""}${ch.toFixed(2)}%` }), value: fmtV(r.c, unit) },
                        ...(r.v !== null ? [{ label: t("거래량"), value: fmtC(r.v) }] : []),
                      ]}
                    />
                  );
                }}
              />
            </>
          );
        }}
      </ChFrame>
    );
  },
  examples: [
    {
      label: "주가 (일봉)",
      unit: "원",
      ma: [5],
      items: (() => {
        const out: { x: string; o: number; h: number; l: number; c: number; v: number }[] = [];
        let p = 71200;
        const moves = [1.2, -0.8, 2.1, 0.4, -1.6, -2.3, 0.9, 1.8, 3.2, -0.5, -1.1, 0.6, 2.4, 1.1, -0.9, -3.1, -1.4, 0.8, 1.9, 0.3, -0.7, 1.5, 2.2, -0.4, 0.9];
        moves.forEach((m, i) => {
          const o = p;
          const c = Math.round((p * (1 + m / 100)) / 100) * 100;
          const h = Math.max(o, c) + 100 * (2 + ((i * 7) % 5));
          const l = Math.min(o, c) - 100 * (1 + ((i * 3) % 6));
          const d = new Date(Date.UTC(2026, 9, 1) + i * 864e5 * 1.4);
          out.push({ x: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, o, h, l, c, v: Math.round(820000 + Math.abs(m) * 410000 + ((i * 7919) % 9) * 40000) });
          p = c;
        });
        return out;
      })(),
    },
  ],
});

// ───────────── KPI tiles

function Delta(props: { delta: unknown; better?: unknown; unit?: string; vs?: string }) {
  const n = () => deltaNum(props.delta);
  const t = () => deltaTone(n(), props.better);
  const text = () => (typeof props.delta === "string" ? props.delta : n() === null ? "" : `${n()! > 0 ? "+" : ""}${fmtC(n()!)}${props.unit ?? "%"}`);
  return (
    <Show when={text()}>
      <span class={`ch-delta ch-${t().tone}`}>
        <Arrow dir={t().dir} />
        <b>{text()}</b>
        <Show when={props.vs}><span class="ch-vs">{props.vs}</span></Show>
      </span>
    </Show>
  );
}

defineViz({
  type: "kpiTiles",
  family: "chart",
  title: "KPI 타일",
  when: "핵심 지표 여러 개의 현재값·변화·추이·목표를 한 줄에",
  render: (b: any) => {
    const items = arr<any>(b.items).filter((i) => i && typeof i === "object").slice(0, 12);
    return (
      <div class="blk viz ch ch-kpis">
        <Show when={str(b.label)}><div class="blk-label">{str(b.label)}</div></Show>
        <div class="ch-kpi-grid">
          <For each={items}>
            {(it) => {
              const v = toNum(it.value);
              const unit = str(it.unit) || undefined;
              const tgt = toNum(it.target);
              const trend = arr(it.trend).map(toNum);
              const vText = () => (v !== null ? fmtC(v) : str(it.value, "–"));
              const prog = v !== null && tgt ? v / tgt : null;
              const lower = it.better === "down";
              return (
                <div class="ch-kpi">
                  <div class="ch-kpi-label" title={str(it.label)}>{str(it.label)}</div>
                  <div class="ch-kpi-value">
                    {vText()}
                    <Show when={unit}><small>{unit}</small></Show>
                  </div>
                  <Delta delta={it.delta} better={it.better} unit={str(it.deltaUnit) || undefined} vs={str(it.vs ?? b.vs) || undefined} />
                  <Show when={trend.filter(isNum).length > 1}>
                    <Spark values={trend} w={120} h={28} color="var(--viz-muted)" dot={series(0)} />
                  </Show>
                  <Show when={tgt !== null}>
                    <div class="ch-kpi-target">
                      <Show when={!lower}><span class="ch-meter"><i style={{ width: `${clamp((prog ?? 0) * 100, 0, 100)}%` }} /></span></Show>
                      <span>{t("목표")} {lower ? "≤ " : ""}{fmtC(tgt!, unit)}{lower ? ` · ${v !== null && v <= tgt! ? t("달성") : t("미달")}` : ` · ${prog !== null ? pct(prog * 100) : "–"}`}</span>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    );
  },
  examples: [
    {
      label: "10월 핵심 지표",
      vs: "전월 대비",
      items: [
        { label: "월 매출", value: 1824000000, unit: "원", delta: 8.4, better: "up", trend: [1.41, 1.48, 1.52, 1.5, 1.61, 1.66, 1.63, 1.71, 1.68, 1.75, 1.69, 1.82], target: 2000000000 },
        { label: "활성 사용자", value: 63500, unit: "명", delta: 5.6, better: "up", trend: [41, 43, 45, 44, 47, 51, 53, 52, 55, 58, 60, 63] },
        { label: "이탈률", value: 3.8, unit: "%", delta: 0.4, deltaUnit: "%p", better: "down", trend: [4.6, 4.4, 4.1, 4.2, 3.9, 3.7, 3.6, 3.5, 3.4, 3.5, 3.4, 3.8], target: 3 },
        { label: "평균 응답 시간", value: 182, unit: "ms", delta: -12, deltaUnit: "ms", better: "down", trend: [240, 232, 228, 219, 214, 208, 201, 199, 196, 194, 194, 182] },
      ],
    },
  ],
});

// ───────────── goals

defineViz({
  type: "goals",
  family: "chart",
  title: "목표 진행 묶음",
  when: "여러 목표가 각각 얼마나 달성됐나 (값 / 목표)",
  render: (b: any) => {
    const items = arr<any>(b.items)
      .filter((i) => i && typeof i === "object")
      .map((i, k) => ({ label: str(i.label, t("목표 {n}", { n: k + 1 })), v: toNum(i.value) ?? 0, t: toNum(i.target ?? i.total) ?? 100, unit: str(i.unit) || unitOf(b), note: str(i.note ?? i.due) }));
    return (
      <div class="blk viz ch ch-goals">
        <Show when={str(b.label)}><div class="blk-label">{str(b.label)}</div></Show>
        <For each={items}>
          {(it) => {
            const p = it.t ? it.v / it.t : 0;
            return (
              <div class="ch-goal" classList={{ done: p >= 1 }}>
                <div class="ch-goal-top">
                  <span class="ch-goal-label" title={it.label}>{it.label}</span>
                  <Show when={it.note}><span class="ch-goal-note">{it.note}</span></Show>
                  <span class="ch-goal-v">{fmtV(it.v, it.unit)} <span>/ {fmtV(it.t, it.unit)}</span></span>
                  <b>{pct(p * 100)}</b>
                </div>
                <span class="ch-meter lg"><i style={{ width: `${clamp(p * 100, 0, 100)}%` }} /></span>
              </div>
            );
          }}
        </For>
      </div>
    );
  },
  examples: [
    {
      label: "4분기 OKR",
      items: [
        { label: "유료 전환 고객", value: 1240, target: 1500, unit: "명", note: "12/31" },
        { label: "결제 실패율 1% 이하로", value: 100, target: 100, unit: "%", note: "달성" },
        { label: "온보딩 완료율", value: 61, target: 80, unit: "%" },
        { label: "고객 인터뷰", value: 9, target: 20, unit: "회", note: "12/15" },
      ],
    },
  ],
});

// ───────────── big number

defineViz({
  type: "bigNumber",
  family: "chart",
  title: "큰 숫자 + 비교",
  when: "이번에 가장 중요한 숫자 하나와, 무엇에 비해 얼마나 변했나",
  render: (b: any) => {
    const v = toNum(b.value);
    const unit = unitOf(b);
    const cmp = b.compare && typeof b.compare === "object" ? { label: str(b.compare.label, t("이전")), value: toNum(b.compare.value) } : null;
    const delta = b.delta ?? (v !== null && cmp?.value ? +(((v - cmp.value) / Math.abs(cmp.value)) * 100).toFixed(1) : null);
    const trend = arr(b.trend).map(toNum);
    return (
      <div class="blk viz ch ch-big">
        <Show when={str(b.label)}><div class="blk-label">{str(b.label)}</div></Show>
        <div class="ch-hero">
          {v !== null ? fmtC(v) : str(b.value, "–")}
          <Show when={unit}><small>{unit}</small></Show>
        </div>
        <div class="ch-big-row">
          <Delta delta={delta} better={b.better} unit={str(b.deltaUnit) || undefined} vs={cmp ? undefined : str(b.vs) || undefined} />
          <Show when={cmp}><span class="ch-vs">{t("{c} 대비", { c: `${cmp!.label}${cmp!.value !== null ? ` ${fmtV(cmp!.value, unit)}` : ""}` })}</span></Show>
        </div>
        <Show when={trend.filter(isNum).length > 1}>
          <Spark values={trend} w={240} h={44} color="var(--viz-muted)" dot={series(0)} />
        </Show>
        <Show when={str(b.note)}><div class="ch-big-note">{str(b.note)}</div></Show>
      </div>
    );
  },
  examples: [
    { label: "3분기 거래액", value: 1284, unit: "억 원", compare: { label: "작년 3분기", value: 1046 }, better: "up", trend: [812, 864, 901, 958, 1003, 1046, 1088, 1142, 1197, 1284] },
    { label: "평균 배송 시간", value: 26.4, unit: "시간", delta: -3.1, deltaUnit: "시간", better: "down", vs: "지난달 대비" },
  ],
});

// ───────────── sparkline table

defineViz({
  type: "sparkTable",
  family: "chart",
  title: "스파크라인 표",
  when: "여러 항목의 최근 값·변화와 추이를 표 한 장에서",
  render: (b: any) => {
    const items = arr<any>(b.items)
      .filter((i) => i && typeof i === "object")
      .slice(0, 30)
      .map((i, k) => {
        const values = arr(i.values).map(toNum);
        const nums = values.filter(isNum);
        const last = toNum(i.value) ?? (nums.length ? nums[nums.length - 1] : null);
        const first = nums.length ? nums[0] : null;
        const change = i.change !== undefined ? i.change : last !== null && first ? +(((last - first) / Math.abs(first)) * 100).toFixed(1) : null;
        return { label: str(i.label, t("항목 {n}", { n: k + 1 })), values, last, change, unit: str(i.unit) || unitOf(b), better: i.better ?? b.better };
      });
    const all = extent(items.flatMap((i) => i.values));
    const shared = b.shared === true && all ? all : undefined;
    return (
      <div class="blk viz ch ch-sparks">
        <Show when={str(b.label)}><div class="blk-label">{str(b.label)}</div></Show>
        <table>
          <thead>
            <tr>
              <th />
              <th>{str(b.trendLabel, t("추이"))}</th>
              <th>{str(b.valueLabel, t("최근"))}</th>
              <th class="chg">{str(b.changeLabel, t("변화"))}</th>
            </tr>
          </thead>
          <tbody>
            <For each={items}>
              {(it) => (
                <tr>
                  <th title={it.label}>{it.label}</th>
                  <td class="spark"><Spark values={it.values} w={96} h={24} color={series(0)} band={shared} /></td>
                  <td class="val">
                    {fmtV(it.last, it.unit)}
                    <span class="ch-narrow"><Delta delta={it.change} better={it.better} unit={str(b.changeUnit) || undefined} /></span>
                  </td>
                  <td class="chg"><Delta delta={it.change} better={it.better} unit={str(b.changeUnit) || undefined} /></td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    );
  },
  examples: [
    {
      label: "서비스별 주간 오류율",
      unit: "%",
      better: "down",
      changeUnit: "%",
      items: [
        { label: "로그인", values: [0.42, 0.39, 0.41, 0.37, 0.35, 0.33, 0.31, 0.3] },
        { label: "결제", values: [0.81, 0.79, 0.92, 1.12, 1.35, 1.28, 1.41, 1.52] },
        { label: "검색", values: [0.22, 0.24, 0.21, 0.23, 0.22, 0.2, 0.21, 0.21] },
        { label: "알림 발송", values: [1.9, 1.7, 1.6, 1.2, 1.1, 0.9, 0.8, 0.7] },
        { label: "파일 업로드 및 변환", values: [0.55, 0.61, 0.58, 0.64, 0.6, 0.66, 0.71, 0.69] },
      ],
    },
  ],
});
