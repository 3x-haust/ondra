// Structure: pyramid (and inverted), onion layers, a layer stack, hub and
// spoke, an issue tree (MECE), a decision tree with expected values, and the
// strategy house (roof, pillars, foundation).
import { For, Show } from "solid-js";
import { Frame, num, seq, series, useTip, withUnit } from "../kit";
import { defineViz } from "../registry";
import { Card, measure } from "./common";
import { arr, around, clip, item, items, layTree, readDecision, readTree, rollback, str, texts, wrapPx, type Checked, type DNode, type Item, type TNode } from "./util";

const FS = 13, FN = 12;

/* ───────────── pyramid ───────────── */

interface PyrB { label?: string; invert?: boolean; unit?: string; items?: unknown[] }
defineViz<PyrB>({
  type: "pyramid",
  family: "slide",
  title: "피라미드",
  when: "위로 갈수록 좁아지는(또는 거꾸로) 단계·위계는 어떻게 쌓여 있나",
  render: (b) => {
    const list = () => items(b.items).slice(0, 8);
    return (
      <Frame label={b.label} class="sl sl-pyr" margin={{ t: 4, r: 4, b: 4, l: 4 }}
        height={(w) => {
          const tw = w - 8 - Math.min((w - 8) * (w < 480 ? 0.42 : 0.46), 320) - 20;
          const lines = Math.max(1, ...list().map((i) => 1 + (i.note ? wrapPx(i.note, tw, FN, 2, measure, 400).length : 0)));
          return list().length * Math.max(48, lines * 17 + 14) + 8;
        }}>
        {(bx) => {
          const t = useTip();
          const n = list().length;
          const pw = Math.min(bx.iw * (bx.iw < 480 ? 0.42 : 0.46), 320);
          const rh = bx.ih / Math.max(1, n);
          const tx = bx.x0 + pw + 20, tw = bx.iw - pw - 20;
          const half = (y: number) => ((b.invert ? bx.ih - y : y) / bx.ih) * (pw / 2);
          const cx = bx.x0 + pw / 2;
          return (
            <g>
              <For each={list()}>
                {(it, i) => {
                  const y0 = i() * rh, y1 = (i() + 1) * rh - 3;
                  const lv = b.invert ? i() / Math.max(1, n - 1) : 1 - i() / Math.max(1, n - 1);
                  const pts = `${cx - half(y0)},${bx.y0 + y0} ${cx + half(y0)},${bx.y0 + y0} ${cx + half(y1)},${bx.y0 + y1} ${cx - half(y1)},${bx.y0 + y1}`;
                  const mid = bx.y0 + (y0 + y1) / 2;
                  const edge = cx + half((y0 + y1) / 2);
                  const note = it.note ? wrapPx(it.note, tw, FN, 2, measure, 400) : [];
                  const top = mid - ((note.length + 1) * 16) / 2 + 12;
                  const val = it.value !== undefined ? withUnit(num(it.value), it.unit ?? b.unit) : "";
                  const fits = val && measure(val, 12, 600) + 12 < half(y0) * 2 && rh > 20;
                  return (
                    <g class="viz-mark" onMouseMove={(e) => t.show(e, `${it.label}${val ? ` · ${val}` : ""}${it.note ? `\n${it.note}` : ""}`)} onMouseLeave={t.hide}>
                      <polygon points={pts} fill={it.em || !list().some((x) => x.em) ? seq(0.2 + lv * 0.8) : "var(--viz-other)"} class="sl-band" />
                      <Show when={fits}><text class={lv > 0.45 ? "sl-in-dark" : "sl-in-light"} x={cx} y={mid + 4} text-anchor="middle">{val}</text></Show>
                      <line class="sl-leader" x1={edge + 4} x2={tx - 6} y1={mid} y2={mid} />
                      <text class="sl-tl" classList={{ em: !!it.em }} x={tx} y={top}>{clip(it.label + (val && !fits ? ` · ${val}` : ""), tw, FS, measure, 600)}</text>
                      <For each={note}>{(l, k) => <text class="sl-tn" x={tx} y={top + 16 * (k() + 1)}>{l}</text>}</For>
                    </g>
                  );
                }}
              </For>
            </g>
          );
        }}
      </Frame>
    );
  },
  examples: [
    {
      label: "테스트 피라미드",
      items: [
        { label: "E2E 테스트", note: "핵심 흐름 12개만, 배포 전", value: 12 },
        { label: "통합 테스트", note: "API·DB 경계", value: 180 },
        { label: "단위 테스트", note: "로직마다, 커밋마다 실행", value: 1420, em: true },
      ],
      unit: "개",
    },
    {
      label: "기사 구성 (역피라미드)",
      invert: true,
      items: [
        { label: "핵심 결론", note: "누가 무엇을 언제 했나" },
        { label: "중요한 근거", note: "수치와 인용" },
        { label: "배경 설명" },
        { label: "부가 정보", note: "관련 기사, 이전 경과" },
      ],
    },
  ],
});

/* ───────────── onion / concentric layers ───────────── */

interface OnionB { label?: string; items?: unknown[] }
defineViz<OnionB>({
  type: "onion",
  family: "slide",
  title: "양파형 동심원",
  when: "가운데 핵심을 어떤 층들이 바깥으로 감싸고 있나",
  render: (b) => {
    const list = () => items(b.items).slice(0, 7);
    const narrow = (w: number) => w < 500;
    const notesH = (w: number) => list().reduce((h, i) => h + 18 + (i.note ? wrapPx(i.note, w - 30, FN, 2, measure, 400).length * 16 : 0) + 6, 0);
    return (
      <Frame label={b.label} class="sl sl-onion" margin={{ t: 4, r: 4, b: 4, l: 4 }}
        height={(w) => (narrow(w) ? Math.min(w - 8, 300) + 16 + notesH(w) : Math.max(Math.min((w - 8) * 0.5, 340), notesH((w - 8) * 0.5)) + 8)}>
        {(bx) => {
          const tip = useTip();
          const n = list().length;
          const nw = narrow(bx.w);
          const D = nw ? Math.min(bx.iw, 300) : Math.min(bx.iw * 0.5, 340);
          const R = D / 2, cx = nw ? bx.x0 + bx.iw / 2 : bx.x0 + R, cy = bx.y0 + R;
          const step = R / Math.max(1, n);
          const lx = nw ? bx.x0 + 22 : bx.x0 + D + 28, lw = nw ? bx.iw - 26 : bx.iw - D - 32;
          let ly = nw ? bx.y0 + D + 24 : bx.y0 + Math.max(14, R - notesH(lw + 30) / 2 + 12);
          const rows = list().map((it) => {
            const note = it.note ? wrapPx(it.note, lw, FN, 2, measure, 400) : [];
            const y = ly;
            ly += 18 + note.length * 16 + 6;
            return { it, note, y };
          });
          return (
            <g>
              {/* outermost first so inner rings sit on top */}
              <For each={[...list()].map((it, i) => ({ it, i })).reverse()}>
                {({ it, i }) => {
                  const r = step * (i + 1);
                  const ty = i === 0 ? cy + 4 : cy - r + step / 2 + 4;
                  const room = i === 0 ? r * 1.6 : 2 * Math.sqrt(Math.max(0, r * r - (r - step / 2) ** 2)) - 8;
                  return (
                    <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${it.label}${it.note ? `\n${it.note}` : ""}`)} onMouseLeave={tip.hide}>
                      <circle cx={cx} cy={cy} r={r - 1} class="sl-ring" style={{ "fill-opacity": 0.1 + (1 - i / Math.max(1, n - 1)) * 0.32 }} classList={{ em: !!it.em }} />
                      <Show when={step >= 18}><text class="sl-ringl" x={cx} y={ty} text-anchor="middle">{clip(it.label, room, 12.5, measure, 600)}</text></Show>
                    </g>
                  );
                }}
              </For>
              <For each={rows}>
                {(r, i) => (
                  <g>
                    <circle cx={lx - 12} cy={r.y - 4} r="4.5" class="sl-ring" style={{ "fill-opacity": 0.1 + (1 - i() / Math.max(1, n - 1)) * 0.32 }} />
                    <text class="sl-tl" classList={{ em: !!r.it.em }} x={lx} y={r.y}>{clip(r.it.label, lw, FS, measure, 600)}</text>
                    <For each={r.note}>{(l, k) => <text class="sl-tn" x={lx} y={r.y + 16 * (k() + 1)}>{l}</text>}</For>
                  </g>
                )}
              </For>
            </g>
          );
        }}
      </Frame>
    );
  },
  examples: [
    {
      label: "골든 서클",
      items: [
        { label: "왜", note: "누구나 자기 일을 기록으로 남기게", em: true },
        { label: "어떻게", note: "작업 로그를 자동으로 요약" },
        { label: "무엇을", note: "개발자용 업무 일지 앱" },
      ],
    },
    {
      label: "데이터 접근 권한 계층",
      items: [{ label: "원본", note: "보안팀 2명" }, { label: "가명 처리", note: "분석가" }, { label: "집계 지표", note: "전 직원" }, { label: "공개 리포트", note: "외부 파트너" }],
    },
  ],
});

/* ───────────── stack (tech stack, layered architecture) ───────────── */

interface StackB { label?: string; items?: unknown[]; side?: unknown[] }
defineViz<StackB>({
  type: "stack",
  family: "slide",
  title: "계층 스택",
  when: "어떤 층들이 위아래로 쌓여 있고, 각 층에 무엇이 있나 (기술 스택)",
  render: (b) => {
    const rows = () => arr(b.items).map((x) => {
      const it = item(x);
      const o = (x ?? {}) as Record<string, unknown>;
      return it ? { ...it, parts: texts(o.parts ?? o.items) } : undefined;
    }).filter((x): x is Item & { parts: string[] } => !!x);
    const side = () => items(b.side).slice(0, 3);
    return (
      <Card label={b.label} class="sl-stack">
        <div class="sl-stack-grid" style={{ "--rows": rows().length, "--side": side().length }}>
          <For each={rows()}>
            {(r, i) => (
              <div class="sl-stack-row" classList={{ em: !!r.em }} style={{ "grid-row": i() + 1 }}>
                <div class="sl-stack-name"><b>{r.label}</b><Show when={r.note}><span class="sl-note">{r.note}</span></Show></div>
                <div class="sl-chips"><For each={r.parts}>{(p) => <span class="sl-chip">{p}</span>}</For></div>
              </div>
            )}
          </For>
          <For each={side()}>{(s, i) => <div class="sl-stack-side" style={{ "grid-column": i() + 2, "grid-row": `1 / span ${Math.max(1, rows().length)}` }} title={s.note}><span>{s.label}</span></div>}</For>
        </div>
      </Card>
    );
  },
  examples: [
    {
      label: "서비스 기술 스택",
      items: [
        { label: "화면", parts: ["SolidJS", "Vite", "Tauri 웹뷰"] },
        { label: "API", parts: ["Rust axum", "GraphQL"], em: true, note: "이번에 바뀜" },
        { label: "데이터", parts: ["PostgreSQL 16", "Redis", "S3"] },
        { label: "인프라", parts: ["EKS", "Terraform", "CloudFront"] },
      ],
      side: [{ label: "모니터링" }, { label: "보안" }],
    },
  ],
});

/* ───────────── hub and spoke ───────────── */

interface HubB { label?: string; center?: unknown; items?: unknown[] }
defineViz<HubB>({
  type: "hub",
  family: "slide",
  title: "허브 앤 스포크",
  when: "하나의 중심이 둘레의 무엇들과 연결되어 있나",
  render: (b) => {
    const list = () => items(b.items).slice(0, 10);
    const center = () => item(b.center)?.label ?? "";
    return (
      <Frame label={b.label} class="sl sl-hub" margin={{ t: 4, r: 4, b: 4, l: 4 }} height={(w) => Math.round(Math.max(260, Math.min(w * 0.62, 120 + list().length * 34)))}>
        {(bx) => {
          const tip = useTip();
          const n = list().length;
          const nodeW = Math.min(150, Math.max(92, bx.iw / (n > 6 ? 3.4 : 3))), nodeH = 40;
          const cx = bx.x0 + bx.iw / 2, cy = bx.y0 + bx.ih / 2;
          const cr = Math.min(56, Math.max(38, measure(center(), 13.5, 600) / 2 + 12));
          const ps = around(n, cx, cy, 1).map((p) => ({ x: cx + (p.x - cx) * (bx.iw / 2 - nodeW / 2), y: cy + (p.y - cy) * (bx.ih / 2 - nodeH / 2), a: p.a }));
          const cl = wrapPx(center(), cr * 1.6, 13.5, 2, measure, 600);
          return (
            <g>
              <For each={ps}>{(p) => <line class="sl-spoke" x1={cx + Math.cos(p.a) * cr} y1={cy + Math.sin(p.a) * cr} x2={p.x} y2={p.y} />}</For>
              <circle cx={cx} cy={cy} r={cr} class="sl-hubc" />
              <For each={cl}>{(l, i) => <text class="sl-in-dark sl-hubt" x={cx} y={cy + 5 + (i() - (cl.length - 1) / 2) * 16} text-anchor="middle">{l}</text>}</For>
              <For each={list()}>
                {(it, i) => {
                  const p = ps[i()];
                  return (
                    <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${it.label}${it.note ? `\n${it.note}` : ""}`)} onMouseLeave={tip.hide}>
                      <rect x={p.x - nodeW / 2} y={p.y - nodeH / 2} width={nodeW} height={nodeH} rx="8" class="sl-node" classList={{ em: !!it.em }} />
                      <text class="sl-tl" x={p.x} y={it.note ? p.y - 3 : p.y + 4.5} text-anchor="middle">{clip(it.label, nodeW - 14, 12.5, measure, 600)}</text>
                      <Show when={it.note}><text class="sl-tn" x={p.x} y={p.y + 12} text-anchor="middle">{clip(it.note!, nodeW - 14, 11.5, measure, 400)}</text></Show>
                    </g>
                  );
                }}
              </For>
            </g>
          );
        }}
      </Frame>
    );
  },
  examples: [
    {
      label: "고객 데이터 플랫폼 연동",
      center: "CDP",
      items: [
        { label: "자사몰", note: "주문·장바구니" }, { label: "앱", note: "행동 로그" }, { label: "CRM", note: "상담 이력" }, { label: "광고 매체", note: "전환 신호" },
        { label: "POS", note: "오프라인 매출" }, { label: "메시지 발송", note: "푸시·알림톡", em: true },
      ],
    },
  ],
});

/* ───────────── issue tree / logic tree ───────────── */

interface Node1 { label: string; note?: string; em?: boolean }
interface IssueB { label?: string; root?: unknown; items?: unknown[] }
function checkIssue(b: IssueB): Checked<IssueB & { _t?: TNode<Node1> }> {
  const dropped: string[] = [];
  const rd = (o: unknown) => item(o);
  const raw = b.root && typeof b.root === "object" ? b.root : { label: str(b.root) || "", items: b.items };
  const t = readTree<Node1>(raw, (o) => rd(o) ?? (o === raw ? { label: "" } : (dropped.push("label 없는 가지"), undefined)));
  return { block: { ...b, _t: t }, dropped };
}
defineViz<IssueB>({
  type: "issueTree",
  family: "slide",
  title: "이슈 트리 (로직 트리)",
  when: "큰 질문을 빠짐없이 겹침 없이(MECE) 쪼개면 무엇이 되나",
  check: checkIssue,
  render: (raw) => {
    const b = raw as ReturnType<typeof checkIssue>["block"];
    if (!b._t) return null;
    const t = b._t;
    const lay = layTree(t);
    const hasRoot = !!t.data.label;
    const cols = lay.depth + (hasRoot ? 1 : 0);
    const all = lay.all.filter((n) => hasRoot || n !== t);
    const RH = 44;
    return (
      <Frame label={b.label} class="sl sl-issue" margin={{ t: 4, r: 4, b: 4, l: 4 }} height={(w) => ((w - 8) / Math.max(1, cols) < 112 ? all.length * 30 + 8 : lay.rows * RH + 8)}>
        {(bx) => {
          const tip = useTip();
          const colW = bx.iw / Math.max(1, cols);
          const d = (n: TNode<Node1>) => n.depth - (hasRoot ? 0 : 1);
          // too narrow for columns: an indented outline with guide lines
          if (colW < 112) {
            const order = all;
            return (
              <g>
                <For each={order}>
                  {(n, i) => {
                    const x = bx.x0 + d(n) * 18, y = bx.y0 + i() * 30 + 18;
                    const parent = order.findIndex((p) => p.kids.includes(n));
                    return (
                      <g class="viz-mark" onMouseMove={(e) => n.data.note && tip.show(e, n.data.note)} onMouseLeave={tip.hide}>
                        <Show when={parent >= 0}><path class="sl-link" d={`M${x - 11} ${bx.y0 + parent * 30 + 24}V${y - 4}H${x - 3}`} /></Show>
                        <circle cx={x + 2} cy={y - 4} r="3" class="sl-bullet" classList={{ em: !!n.data.em }} />
                        <text class="sl-tl" classList={{ em: !!n.data.em, root: n === t }} x={x + 10} y={y}>{clip(n.data.label + (n.data.note ? ` · ${n.data.note}` : ""), bx.iw - (x - bx.x0) - 12, 12.5, measure, n.kids.length ? 600 : 500)}</text>
                      </g>
                    );
                  }}
                </For>
              </g>
            );
          }
          const bw = Math.min(220, colW - 22);
          const X = (n: TNode<Node1>) => bx.x0 + d(n) * colW, Y = (n: TNode<Node1>) => bx.y0 + n.y * RH + RH / 2;
          return (
            <g>
              <For each={all.filter((n) => n.kids.length)}>
                {(p) => (
                  <For each={p.kids}>
                    {(k) => {
                      const mx = X(p) + bw + (colW - bw) / 2;
                      return <path class="sl-link" classList={{ em: !!k.data.em }} d={`M${X(p) + bw} ${Y(p)}H${mx}V${Y(k)}H${X(k)}`} />;
                    }}
                  </For>
                )}
              </For>
              <For each={all}>
                {(n) => {
                  const lines = wrapPx(n.data.label, bw - 16, 12.5, n.data.note ? 1 : 2, measure, 600);
                  return (
                    <g class="viz-mark" onMouseMove={(e) => tip.show(e, `${n.data.label}${n.data.note ? `\n${n.data.note}` : ""}`)} onMouseLeave={tip.hide}>
                      <rect x={X(n)} y={Y(n) - 17} width={bw} height={34} rx="7" class="sl-node" classList={{ em: !!n.data.em, root: n === t, leaf: !n.kids.length }} />
                      <For each={lines}>{(l, i) => <text class="sl-tl" x={X(n) + 8} y={Y(n) + 4.5 + (i() - (lines.length - 1) / 2) * 15 - (n.data.note ? 6 : 0)}>{l}</text>}</For>
                      <Show when={n.data.note}><text class="sl-tn" x={X(n) + 8} y={Y(n) + 11}>{clip(n.data.note!, bw - 16, 11.5, measure, 400)}</text></Show>
                    </g>
                  );
                }}
              </For>
            </g>
          );
        }}
      </Frame>
    );
  },
  examples: [
    {
      label: "영업이익 감소 원인",
      root: {
        label: "영업이익 18% 감소",
        items: [
          { label: "매출 감소", items: [{ label: "고객 수 감소", note: "신규 -22%", em: true }, { label: "객단가 하락", note: "-4%" }] },
          { label: "비용 증가", items: [{ label: "원가 상승", items: [{ label: "원두 단가", note: "+31%", em: true }, { label: "포장재" }] }, { label: "판관비 증가", note: "인건비 +6%" }] },
        ],
      },
    },
  ],
});

/* ───────────── decision tree ───────────── */

interface DecB { label?: string; unit?: string; root?: unknown }
function checkDec(b: DecB): Checked<DecB & { _t?: TNode<DNode> }> {
  const dropped: string[] = [];
  const t = readTree<DNode>(b.root, (o) => readDecision(o) ?? (dropped.push("label 없는 가지"), undefined));
  if (t) rollback(t);
  return { block: { ...b, _t: t }, dropped };
}
defineViz<DecB>({
  type: "decisionTree",
  family: "slide",
  title: "의사결정 나무",
  when: "선택지마다 확률과 결과를 곱하면 어느 쪽 기대값이 큰가",
  check: checkDec,
  render: (raw) => {
    const b = raw as ReturnType<typeof checkDec>["block"];
    if (!b._t) return null;
    const t = b._t;
    const lay = layTree(t);
    const RH = 52;
    const f = (v?: number) => (v === undefined ? "–" : withUnit(num(Math.round(v * 100) / 100), b.unit));
    return (
      <Frame label={b.label} class="sl sl-dec" margin={{ t: 22, r: 4, b: 4, l: 6 }} height={lay.rows * RH + 26}
        legend={[{ label: "결정", color: "var(--ink-2)" }, { label: "확률", color: "var(--viz-1)" }]}>
        {(bx) => {
          const tip = useTip();
          const valW = Math.max(...lay.all.filter((n) => !n.kids.length).map((n) => measure(f(n.data.ev), 12.5, 600)), 30) + 14;
          const colW = (bx.iw - valW - 14) / Math.max(1, lay.depth);
          const X = (n: TNode<DNode>) => bx.x0 + 10 + n.depth * colW, Y = (n: TNode<DNode>) => bx.y0 + n.y * RH + RH / 2;
          // a branch not chosen at some decision above it is drawn faint, with everything under it
          const off = new Set<TNode<DNode>>();
          const walk = (n: TNode<DNode>, o: boolean) => (o && off.add(n), n.kids.forEach((k) => walk(k, o || (n.data.kind === "decide" && !k.data.best))));
          walk(t, false);
          const onPath = (n: TNode<DNode>, _p?: TNode<DNode>) => !off.has(n);
          const parent = new Map<TNode<DNode>, TNode<DNode>>();
          lay.all.forEach((p) => p.kids.forEach((k) => parent.set(k, p)));
          return (
            <g>
              <For each={lay.all.filter((n) => n !== t)}>
                {(n) => {
                  const p = parent.get(n)!;
                  const x0 = X(p) + 9, x1 = X(n) - 9;
                  const lab = clip(n.data.label, x1 - x0 - 16, 12, measure, 500);
                  const sub = [n.data.p !== undefined ? `${Math.round(n.data.p * 100)}%` : "", n.data.cost ? `비용 ${f(n.data.cost)}` : ""].filter(Boolean).join(" · ");
                  return (
                    <g class="viz-mark" classList={{ off: !onPath(n, p) }} onMouseMove={(e) => tip.show(e, `${n.data.label}${sub ? ` · ${sub}` : ""}\n기대값 ${f(n.data.ev)}`)} onMouseLeave={tip.hide}>
                      <path class="sl-link" classList={{ em: !!n.data.best }} d={`M${x0} ${Y(p)}H${x0 + 8}V${Y(n)}H${x1}`} />
                      <text class="sl-el" x={x0 + 14} y={Y(n) - 6}>{lab}</text>
                      <Show when={sub}><text class="sl-tn" x={x0 + 14} y={Y(n) + 15}>{clip(sub, x1 - x0 - 16, 11.5, measure, 400)}</text></Show>
                    </g>
                  );
                }}
              </For>
              <For each={lay.all}>
                {(n) => {
                  const x = X(n), y = Y(n);
                  const k = n.data.kind;
                  return (
                    <g class="sl-dnode" classList={{ off: !onPath(n, parent.get(n)) }}>
                      <Show when={k === "decide"}><rect x={x - 8} y={y - 8} width="16" height="16" rx="2" class="d-decide" /></Show>
                      <Show when={k === "chance"}><circle cx={x} cy={y} r="8.5" class="d-chance" /></Show>
                      <Show when={k === "end"}><path d={`M${x - 7} ${y}l12 -7v14z`} class="d-end" /></Show>
                      <Show when={k === "end"} fallback={<Show when={n.data.ev !== undefined}><text class="sl-ev" x={n === t ? x - 8 : x} y={y - 13} text-anchor={n === t ? "start" : "middle"}>{f(n.data.ev)}</text></Show>}>
                        <text class="sl-tl" x={x + 10} y={y + 4.5}>{f(n.data.ev)}</text>
                      </Show>
                    </g>
                  );
                }}
              </For>
            </g>
          );
        }}
      </Frame>
    );
  },
  examples: [
    {
      label: "신제품 출시 여부",
      unit: "억",
      root: {
        label: "출시 결정",
        items: [
          {
            label: "올해 출시", cost: 12,
            items: [{ label: "수요 높음", p: 0.4, value: 60 }, { label: "수요 보통", p: 0.45, value: 25 }, { label: "수요 낮음", p: 0.15, value: -10 }],
          },
          {
            label: "1년 뒤 출시", cost: 8,
            items: [{ label: "경쟁사 선점", p: 0.6, value: 15 }, { label: "시장 공백", p: 0.4, value: 45 }],
          },
          { label: "출시 안 함", value: 0 },
        ],
      },
    },
  ],
});

/* ───────────── strategy house: roof, pillars, foundation ───────────── */

interface HouseB { label?: string; roof?: string; items?: unknown[]; base?: unknown }
defineViz<HouseB>({
  type: "pillars",
  family: "slide",
  title: "전략 하우스",
  when: "목표(지붕)를 어떤 기둥들이 받치고, 무엇이 바탕인가",
  render: (b) => {
    const cols = () => arr(b.items).map((x) => {
      const it = item(x);
      const o = (x ?? {}) as Record<string, unknown>;
      return it ? { ...it, points: texts(o.points ?? o.items) } : undefined;
    }).filter((x): x is Item & { points: string[] } => !!x).slice(0, 6);
    const base = () => texts(b.base);
    return (
      <Card label={b.label} class="sl-house">
        <Show when={b.roof}><div class="sl-roof"><span>{b.roof}</span></div></Show>
        <div class="sl-pillars" style={{ "--n": cols().length }}>
          <For each={cols()}>
            {(c, i) => (
              <div class="sl-pillar" classList={{ em: !!c.em }} style={{ "--c": series(i()) }}>
                <b>{c.label}</b>
                <Show when={c.note}><p class="sl-note">{c.note}</p></Show>
                <ul class="sl-points"><For each={c.points}>{(p) => <li>{p}</li>}</For></ul>
              </div>
            )}
          </For>
        </div>
        <For each={base()}>{(x) => <div class="sl-base">{x}</div>}</For>
      </Card>
    );
  },
  examples: [
    {
      label: "2027 고객 경험 전략",
      roof: "재구매율 45% 달성",
      items: [
        { label: "빠른 배송", points: ["수도권 새벽배송", "출고 리드타임 6시간"] },
        { label: "쉬운 반품", points: ["문앞 회수", "자동 환불"], em: true },
        { label: "개인화", points: ["구매 주기 알림", "취향 추천"] },
      ],
      base: ["고객 데이터 통합", "상담 인력 교육"],
    },
  ],
});

