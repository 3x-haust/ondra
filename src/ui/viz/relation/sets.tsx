// Sets: Venn (2–3 sets, area-proportional when sizes are given), Euler (subsets and
// disjoint sets drawn as they are) and UpSet (4+ sets, exact combination counts).
import { createMemo, For, Show } from "solid-js";
import { defineViz } from "../registry";
import { Frame, series, useTip } from "../kit";
import { t } from "../../../i18n";
import { bits, bounds, cleanSets, exclusive, layoutCircles, regions, upset } from "./layout/sets";
import { declutter } from "./layout/text";
import { Empty, FS, FS_SM, Safe, fit, tw, val } from "./ui";

interface SetsB { label?: string; unit?: string; items?: unknown; sets?: unknown }

function Circles(b: SetsB & { euler: boolean }) {
  const data = createMemo(() => {
    const d = cleanSets(b.items);
    const names = d.names.slice(0, b.euler ? 5 : 3);
    const items = d.items.filter((i) => i.sets.every((s) => names.includes(s)));
    return { names, items, circles: layoutCircles(names, items, { disjointUnknown: b.euler }), excl: exclusive(names, items) };
  });
  const tip = useTip();
  const emMask = () => {
    const it = data().items.find((i) => i.em);
    return it ? it.sets.reduce((m, s) => m | (1 << data().names.indexOf(s)), 0) : 0;
  };
  return (
    <Show when={data().circles.length} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={(w) => Math.round(Math.max(220, Math.min(380, w * 0.66)))} margin={{ t: 0, r: 0, b: 0, l: 0 }} legend={b.euler && data().names.length > 2 ? data().names.map((n, i) => ({ label: n, color: series(i) })) : undefined} alt={b.label}>
        {(box) => {
          const { names, circles } = data();
          const bd = bounds(circles);
          const lw = Math.min(110, Math.max(...names.map((n) => tw(n, FS, 500))) + 12);
          const s = Math.min((box.w - 2 * lw) / bd.w, (box.h - 44) / bd.h);
          const cx0 = (box.w - bd.w * s) / 2 - bd.x0 * s;
          const cy0 = (box.h - bd.h * s) / 2 - bd.y0 * s;
          const C = circles.map((c) => ({ x: cx0 + c.x * s, y: cy0 + c.y * s, r: c.r * s }));
          const gx = C.reduce((a, c) => a + c.x, 0) / C.length;
          const gy = C.reduce((a, c) => a + c.y, 0) / C.length;
          const regs = regions(circles);
          // set names outside each circle, away from the middle
          const setLabels = names.map((n, i) => {
            const c = C[i];
            let dx = c.x - gx;
            let dy = c.y - gy;
            const d = Math.hypot(dx, dy);
            if (d < 1) (dx = 0), (dy = -1);
            else (dx /= d), (dy /= d);
            // a circle inside another: put its name inside, at its top
            const inside = C.some((o, j) => j !== i && Math.hypot(o.x - c.x, o.y - c.y) + c.r <= o.r + 1);
            // with a legend (Euler, 3+ sets), circles inside others go unnamed on the figure
            const skip = inside && b.euler && names.length > 2;
            const x = inside ? c.x : c.x + dx * (c.r + 8);
            const y = inside ? c.y - c.r + 14 : c.y + dy * (c.r + 10);
            const anchor: "start" | "end" | "middle" = inside || Math.abs(dx) < 0.35 ? "middle" : dx > 0 ? "start" : "end";
            const t = fit(n, lw - 4, FS, 500);
            const w = tw(t, FS, 500);
            const v = data().items.find((it) => it.sets.length === 1 && it.sets[0] === n)?.value;
            return { i, t: skip ? "" : t, x, y, anchor, v, rect: skip ? { x: -1e4, y: -1e4, w: 0, h: 0, rank: 0 } : { x: anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2, y: y - 8, w, h: 16, rank: 1e9 } };
          });
          const regionLabels = [...regs.entries()].map(([mask, r]) => {
            const v = data().excl.get(mask);
            const x = cx0 + r.x * s;
            const y = cy0 + r.y * s;
            const t = v === undefined ? "" : val(v, b.unit);
            const w = tw(t, FS_SM);
            return { mask, v, t, x, y, ok: !!t && r.clear * s >= 7 && w <= r.clear * s * 2.4 + 6, rect: { x: x - w / 2, y: y - 7, w, h: 14, rank: bits(mask) * 1e6 + (v ?? 0) } };
          }).filter((r) => r.ok);
          const all = [...setLabels.map((l) => l.rect), ...regionLabels.map((l) => l.rect)];
          const keep = declutter(all, 1);
          const tipFor = (mask: number) => {
            const inSets = names.filter((_, i) => mask & (1 << i));
            const v = data().excl.get(mask);
            return `${v === undefined ? "–" : val(v, b.unit)}\n${inSets.length === 1 ? t("{s}만", { s: inSets[0] }) : inSets.length < names.length ? t("{s} (나머지 제외)", { s: inSets.join(" ∩ ") }) : inSets.join(" ∩ ")}`;
          };
          return (
            <g>
              <For each={C}>
                {(c, i) => (
                  <circle
                    class="rl-set"
                    cx={c.x} cy={c.y} r={c.r}
                    fill={series(i())}
                    stroke={series(i())}
                    onMouseMove={(e) => {
                      // the region under the pointer
                      const host = (e.currentTarget as SVGCircleElement).ownerSVGElement!.getBoundingClientRect();
                      const px = e.clientX - host.left;
                      const py = e.clientY - host.top;
                      const mask = C.reduce((m, o, k) => (Math.hypot(px - o.x, py - o.y) < o.r ? m | (1 << k) : m), 0);
                      tip.show(e, tipFor(mask));
                    }}
                    onMouseLeave={tip.hide}
                  />
                )}
              </For>
              <For each={setLabels.filter((l, k) => keep.has(k) && l.t)}>
                {(l) => (
                  <text class="rl-strong" x={l.x} y={l.y} dy="0.35em" text-anchor={l.anchor}>{l.t}</text>
                )}
              </For>
              <For each={regionLabels.filter((_, k) => keep.has(k + setLabels.length))}>
                {(l) => <text class="rl-num-in" classList={{ "rl-strong": l.mask === emMask() }} x={l.x} y={l.y} dy="0.35em" text-anchor="middle">{l.t}</text>}
              </For>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

defineViz<SetsB>({
  type: "venn",
  family: "relation",
  title: "벤 다이어그램",
  when: "두세 집합이 얼마나 겹치나 (크기를 주면 면적 비례)",
  render: (b) => <Safe label={b.label}><Circles {...b} euler={false} /></Safe>,
  examples: [
    {
      label: "기능별 사용자 겹침 (월간)",
      unit: "명",
      items: [
        { sets: ["검색"], value: 18400 },
        { sets: ["추천"], value: 12100 },
        { sets: ["장바구니"], value: 9600 },
        { sets: ["검색", "추천"], value: 6200 },
        { sets: ["검색", "장바구니"], value: 5100 },
        { sets: ["추천", "장바구니"], value: 3900 },
        { sets: ["검색", "추천", "장바구니"], value: 2400, em: true },
      ],
    },
    {
      label: "보유 자격증",
      unit: "명",
      items: [{ sets: ["정보처리기사"], value: 42 }, { sets: ["AWS 자격증"], value: 27 }, { sets: ["정보처리기사", "AWS 자격증"], value: 11 }],
    },
  ],
});

defineViz<SetsB>({
  type: "euler",
  family: "relation",
  title: "오일러 다이어그램",
  when: "집합이 서로 포함되거나 아예 떨어진 관계까지 그대로 보려면",
  render: (b) => <Safe label={b.label}><Circles {...b} euler={true} /></Safe>,
  examples: [
    {
      label: "가입자 구성",
      unit: "명",
      items: [
        { sets: ["전체 가입자"], value: 52000 },
        { sets: ["유료 구독"], value: 9800 },
        { sets: ["연간 결제"], value: 3100 },
        { sets: ["기업 계정"], value: 4200 },
        { sets: ["전체 가입자", "유료 구독"], value: 9800 },
        { sets: ["전체 가입자", "연간 결제"], value: 3100 },
        { sets: ["유료 구독", "연간 결제"], value: 3100 },
        { sets: ["전체 가입자", "기업 계정"], value: 4200 },
        { sets: ["유료 구독", "기업 계정"], value: 1300 },
        { sets: ["연간 결제", "기업 계정"], value: 0 },
      ],
    },
  ],
});

// ───────────── UpSet
function UpSet(b: SetsB) {
  const tip = useTip();
  const base = createMemo(() => upset(b, 40));
  return (
    <Show when={base().combos.length} fallback={<Empty label={b.label} />}>
      <Frame label={b.label} class="rl" height={Math.round(base().names.slice(0, 10).length * 22 + 132)} margin={{ t: 0, r: 0, b: 0, l: 0 }} alt={b.label}>
        {(box) => {
          const ROW = 22;
          const names = base().names.slice(0, 10);
          const nameW = Math.min(96, Math.max(...names.map((n) => tw(n, FS_SM, 500))) + 8);
          const barW = Math.min(72, box.w * 0.16);
          const mx = barW + nameW + 6;
          const col = Math.max(16, Math.min(30, (box.w - mx) / Math.max(1, base().combos.length)));
          const maxC = Math.max(1, Math.floor((box.w - mx) / col));
          const u = upset(b, maxC);
          const combos = u.combos.filter((c) => c.sets.every((s) => names.includes(s)));
          const top = 110;
          const vmax = Math.max(1e-9, ...combos.map((c) => c.value));
          const tmax = Math.max(1e-9, ...u.totals);
          const emAny = combos.some((c) => c.em);
          const bw = Math.min(16, col - 4);
          const cx = (k: number) => mx + k * col + col / 2;
          const ry = (i: number) => top + 10 + i * ROW + ROW / 2;
          const valueLabels = combos.map((c, k) => {
            const t = val(c.value, b.unit);
            const w = tw(t, 10.5);
            const h = (c.value / vmax) * (top - 24);
            return { k, t, x: cx(k), y: top - h - 5, rect: { x: cx(k) - w / 2, y: top - h - 16, w, h: 12, rank: c.value } };
          });
          // bars are obstacles too: a value label never sits on a neighbouring bar
          const bars = combos.map((c, k) => ({ x: cx(k) - bw / 2, y: top - (c.value / vmax) * (top - 24), w: bw, h: (c.value / vmax) * (top - 24), rank: 1e15 }));
          const keep = declutter([...valueLabels.map((l) => l.rect), ...bars], 2);
          return (
            <g>
              <For each={names}>{(_, i) => (i() % 2 === 0 ? <rect class="rl-band" x={barW + 2} y={ry(i()) - ROW / 2} width={box.w - barW - 2} height={ROW} rx={3} /> : null)}</For>
              <For each={combos}>
                {(c, k) => {
                  const h = (c.value / vmax) * (top - 24);
                  const members = names.map((_, i) => i).filter((i) => c.mask & (1 << i));
                  return (
                    <g onMouseMove={(e) => tip.show(e, `${val(c.value, b.unit)}\n${c.sets.length < names.length ? t("{s}만", { s: c.sets.join(" ∩ ") }) : c.sets.join(" ∩ ")}`)} onMouseLeave={tip.hide}>
                      <rect x={cx(k()) - col / 2} y={0} width={col} height={top + 10 + names.length * ROW} fill="transparent" />
                      <path class="viz-mark" d={`M${cx(k()) - bw / 2},${top}V${top - h + Math.min(3, h)}q0,-${Math.min(3, h)} ${Math.min(3, h)},-${Math.min(3, h)}H${cx(k()) + bw / 2 - Math.min(3, h)}q${Math.min(3, h)},0 ${Math.min(3, h)},${Math.min(3, h)}V${top}Z`} fill={emAny && !c.em ? "var(--viz-muted)" : series(0)} />
                      <Show when={members.length > 1}>
                        <line x1={cx(k())} x2={cx(k())} y1={ry(members[0])} y2={ry(members[members.length - 1])} stroke="var(--ink-2)" stroke-width={2} />
                      </Show>
                      <For each={names}>{(_, i) => <circle cx={cx(k())} cy={ry(i())} r={Math.min(5, col / 3.2)} class={c.mask & (1 << i()) ? "rl-dot-on" : "rl-dot-off"} />}</For>
                    </g>
                  );
                }}
              </For>
              <line class="viz-base" x1={mx} x2={mx + combos.length * col} y1={top} y2={top} />
              <For each={valueLabels.filter((_, k) => keep.has(k))}>{(l) => <text class="rl-muted rl-tiny rl-halo" x={l.x} y={l.y} text-anchor="middle">{l.t}</text>}</For>
              <For each={names}>
                {(n, i) => {
                  const w = (u.totals[i()] / tmax) * (barW - 6);
                  return (
                    <g onMouseMove={(e) => tip.show(e, `${val(u.totals[i()], b.unit)}\n${t("{s} 전체", { s: n })}`)} onMouseLeave={tip.hide}>
                      <rect class="rl-bar-set" x={barW - w} y={ry(i()) - 5} width={w} height={10} rx={2} />
                      <text class="rl-strong rl-sm" x={barW + nameW} y={ry(i())} dy="0.35em" text-anchor="end">{fit(n, nameW - 8, FS_SM, 500)}</text>
                    </g>
                  );
                }}
              </For>
              <Show when={u.more > 0}>
                <text class="rl-muted" x={box.w - 2} y={10} text-anchor="end">+{u.more}</text>
              </Show>
            </g>
          );
        }}
      </Frame>
    </Show>
  );
}

defineViz<SetsB>({
  type: "upset",
  family: "relation",
  title: "업셋 플롯",
  when: "네 개 이상 집합의 조합마다 몇 개씩인가",
  render: (b) => <Safe label={b.label}><UpSet {...b} /></Safe>,
  examples: [
    {
      label: "사용 중인 연동 서비스 조합 (워크스페이스)",
      unit: "곳",
      items: [
        { sets: ["슬랙"], value: 1840 },
        { sets: ["슬랙", "깃허브"], value: 1220 },
        { sets: ["깃허브"], value: 960 },
        { sets: ["슬랙", "깃허브", "지라"], value: 740, em: true },
        { sets: ["노션"], value: 610 },
        { sets: ["슬랙", "노션"], value: 530 },
        { sets: ["깃허브", "지라"], value: 410 },
        { sets: ["슬랙", "깃허브", "노션"], value: 380 },
        { sets: ["지라"], value: 260 },
        { sets: ["슬랙", "구글 드라이브"], value: 240 },
        { sets: ["슬랙", "깃허브", "지라", "노션"], value: 190 },
        { sets: ["구글 드라이브"], value: 150 },
        { sets: ["노션", "구글 드라이브"], value: 90 },
      ],
    },
  ],
});
