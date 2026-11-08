// Pictures from everyday engineering work, the way they look in review tools:
//   diff     → the few hunks that matter (red/green lines), not a paragraph about them
//   tests    → suites as pass/fail bars, failures listed with where they broke
//   options  → the approaches that were weighed, the chosen one marked, and why (ADR)
//   trace    → a request as a waterfall of spans on one time axis (where the time goes)
//   git      → branches as lanes with their commits and merges
import { createMemo, For, Show } from "solid-js";
import { previewFile } from "../state/ui";
import { t } from "../i18n";

const openRef = (ref?: string) => {
  if (!ref) return;
  const p = ref.replace(/:\d+(:\d+)?$/, "");
  if (p.startsWith("/") || p.startsWith("~")) previewFile(ref);
};
const Label = (p: { text?: string }) => <Show when={p.text}><div class="blk-label">{p.text}</div></Show>;
const ms = (v: number, unit = "ms") => (unit === "ms" && v >= 1000 ? `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}s` : `${Math.round(v * 10) / 10}${unit}`);

// ───────────── diff
export type Hunk = { at?: number; lines: string[] };
export function Diff(props: { label?: string; path: string; ref?: string; note?: string; hunks: Hunk[] }) {
  const MAX = 24;
  const rows = createMemo(() => {
    const out: { kind: "add" | "del" | "ctx" | "gap"; text: string; n?: number }[] = [];
    for (const [i, h] of props.hunks.entries()) {
      if (i) out.push({ kind: "gap", text: "" });
      let n = h.at;
      for (const l of h.lines) {
        const kind = l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx";
        out.push({ kind, text: l.slice(kind === "ctx" && !l.startsWith(" ") ? 0 : 1), n: kind === "del" ? undefined : n });
        if (n !== undefined && kind !== "del") n++;
      }
    }
    return out;
  });
  const counts = () => ({ add: rows().filter((r) => r.kind === "add").length, del: rows().filter((r) => r.kind === "del").length });
  return (
    <div class="blk wk-diff">
      <Label text={props.label} />
      <div class="wk-diff-head">
        <button class="wk-path" classList={{ link: !!props.ref }} onClick={() => openRef(props.ref ?? props.path)} title={props.ref ?? props.path}>{props.path}</button>
        <span class="wk-add">+{counts().add}</span>
        <span class="wk-del">−{counts().del}</span>
      </div>
      <div class="wk-code">
        <For each={rows().slice(0, MAX)}>
          {(r) => (
            <Show when={r.kind !== "gap"} fallback={<div class="wk-gap">⋯</div>}>
              <div class={`wk-line ${r.kind}`}>
                <span class="wk-n">{r.n ?? ""}</span>
                <span class="wk-sign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""}</span>
                <code>{r.text || " "}</code>
              </div>
            </Show>
          )}
        </For>
        <Show when={rows().length > MAX}><div class="wk-gap">{t("{n}줄 더", { n: rows().length - MAX })}</div></Show>
      </div>
    </div>
  );
}

// ───────────── tests
export function Tests(props: {
  label?: string;
  suites: { name: string; pass: number; fail?: number; skip?: number; ms?: number }[];
  failures?: { name: string; ref?: string; msg?: string }[];
}) {
  const total = createMemo(() => props.suites.reduce((a, s) => ({ pass: a.pass + s.pass, fail: a.fail + (s.fail ?? 0), skip: a.skip + (s.skip ?? 0) }), { pass: 0, fail: 0, skip: 0 }));
  const max = () => Math.max(1, ...props.suites.map((s) => s.pass + (s.fail ?? 0) + (s.skip ?? 0)));
  return (
    <div class="blk wk-tests">
      <Label text={props.label} />
      <div class="wk-tests-sum" classList={{ bad: total().fail > 0 }}>
        <b>{total().fail ? t("{n}개 실패", { n: total().fail }) : t("모두 통과")}</b>
        <span>{t("통과 {n}", { n: total().pass })}</span>
        <Show when={total().skip}><span>{t("건너뜀 {n}", { n: total().skip })}</span></Show>
      </div>
      <div class="wk-suites">
        <For each={props.suites}>
          {(s) => {
            const n = s.pass + (s.fail ?? 0) + (s.skip ?? 0);
            return (
              <div class="wk-suite">
                <span class="wk-suite-name" title={s.name}>{s.name}</span>
                <span class="wk-suite-bar" style={{ width: `${(n / max()) * 100}%` }}>
                  <i class="p" style={{ flex: s.pass }} />
                  <Show when={s.fail}><i class="f" style={{ flex: s.fail }} /></Show>
                  <Show when={s.skip}><i class="s" style={{ flex: s.skip }} /></Show>
                </span>
                <span class="wk-suite-n">
                  <Show when={s.fail}><b class="wk-del">{t("실패 {n}", { n: s.fail! })}</b></Show>
                  <span>{t("{n}개", { n })}</span>
                  <Show when={s.ms !== undefined}><span class="wk-ms">{ms(s.ms!)}</span></Show>
                </span>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={props.failures?.length}>
        <div class="wk-fails">
          <For each={props.failures}>
            {(f) => (
              <button class="wk-fail" classList={{ link: !!f.ref }} onClick={() => openRef(f.ref)}>
                <b>{f.name}</b>
                <Show when={f.msg}><span>{f.msg}</span></Show>
                <Show when={f.ref}><code>{f.ref!.split("/").slice(-1)[0]}</code></Show>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

// ───────────── options (considered options, the chosen one marked)
export function Options(props: { label?: string; criteria: string[]; options: { name: string; scores: string[]; chosen?: boolean; note?: string }[]; why?: string }) {
  const tone = (v: string) => (/^(좋음|빠름|낮음|쉬움|있음|예|good|fast|low|easy|yes|✓)/i.test(v) ? "good" : /^(나쁨|느림|높음|어려움|없음|아니오|bad|slow|high|hard|no|✗)/i.test(v) ? "bad" : "");
  return (
    <div class="blk wk-opts">
      <Label text={props.label} />
      <div class="wk-opts-table" style={{ "grid-template-columns": `minmax(90px, max-content) repeat(${props.options.length}, minmax(0, 1fr))` }}>
        <span />
        <For each={props.options}>
          {(o) => (
            <div class="wk-opt-head" classList={{ chosen: !!o.chosen }}>
              <b>{o.name}</b>
              <Show when={o.chosen}><span class="wk-chosen">{t("선택")}</span></Show>
              <Show when={o.note}><span class="wk-opt-note">{o.note}</span></Show>
            </div>
          )}
        </For>
        <For each={props.criteria}>
          {(c, i) => (
            <>
              <span class="wk-crit">{c}</span>
              <For each={props.options}>{(o) => <span class={`wk-cell ${tone(o.scores[i()] ?? "")}`} classList={{ chosen: !!o.chosen }}>{o.scores[i()] ?? ""}</span>}</For>
            </>
          )}
        </For>
      </div>
    </div>
  );
}

// ───────────── trace (waterfall)
export function Trace(props: { label?: string; unit?: string; spans: { id: string; label: string; start: number; dur: number; parent?: string | null; service?: string; error?: boolean }[] }) {
  const unit = () => props.unit ?? "ms";
  const end = () => Math.max(1, ...props.spans.map((s) => s.start + s.dur));
  const rows = createMemo(() => {
    const kids = new Map<string, typeof props.spans>();
    for (const s of props.spans) kids.set(s.parent ?? "", [...(kids.get(s.parent ?? "") ?? []), s]);
    const out: { s: (typeof props.spans)[number]; depth: number }[] = [];
    const walk = (p: string, d: number) => {
      for (const s of (kids.get(p) ?? []).sort((a, b) => a.start - b.start)) out.push({ s, depth: d }), walk(s.id, d + 1);
    };
    walk("", 0);
    for (const s of props.spans) if (!out.some((r) => r.s === s)) out.push({ s, depth: 0 });
    return out;
  });
  const services = createMemo(() => [...new Set(props.spans.map((s) => s.service ?? ""))].filter(Boolean));
  // the slowest span that isn't just its children added up: where the time actually goes
  const slow = createMemo(() => {
    const own = (s: (typeof props.spans)[number]) => s.dur - props.spans.filter((k) => k.parent === s.id).reduce((a, k) => a + k.dur, 0);
    return [...props.spans].sort((a, b) => own(b) - own(a))[0]?.id;
  });
  const ticks = () => [0, 0.25, 0.5, 0.75, 1].map((f) => f * end());
  return (
    <div class="blk wk-trace">
      <Label text={props.label} />
      <div class="wk-trace-grid">
        <span />
        <div class="wk-axis">
          <For each={ticks()}>{(t) => <span style={{ left: `${(t / end()) * 100}%` }}>{ms(t, unit())}</span>}</For>
        </div>
        <For each={rows()}>
          {(r) => (
            <>
              <span class="wk-span-name" classList={{ slow: r.s.id === slow(), err: !!r.s.error }} style={{ "padding-left": `${r.depth * 14}px` }} title={r.s.label}>
                <span class="wk-span-label">{r.s.label}</span>
                <Show when={services().length > 1 && r.s.service}><span class="wk-svc">{r.s.service}</span></Show>
                <Show when={r.s.id === slow()}><span class="wk-tag-slow">{t("가장 느림")}</span></Show>
                <Show when={r.s.error}><span class="wk-tag-err">{t("오류")}</span></Show>
              </span>
              <div class="wk-lane">
                <i
                  class={`wk-span svc-${Math.max(0, services().indexOf(r.s.service ?? "")) % 6}`}
                  classList={{ err: !!r.s.error, slow: r.s.id === slow() }}
                  style={{ left: `${(r.s.start / end()) * 100}%`, width: `max(2px, ${(r.s.dur / end()) * 100}%)` }}
                  title={`${r.s.label}${r.s.service ? ` · ${r.s.service}` : ""} · ${ms(r.s.dur, unit())}`}
                />
                <span class="wk-dur" style={{ left: `calc(${((r.s.start + r.s.dur) / end()) * 100}% + 6px)` }}>{ms(r.s.dur, unit())}</span>
              </div>
            </>
          )}
        </For>
      </div>
    </div>
  );
}

// ───────────── git graph (lanes)
export function Git(props: { label?: string; commits: { id: string; branch: string; msg: string; parents?: string[]; tag?: string; state?: "new" }[] }) {
  const ROW = 30, LANE = 22, X0 = 14;
  const g = createMemo(() => {
    const branches: string[] = [];
    for (const c of props.commits) if (!branches.includes(c.branch)) branches.push(c.branch);
    // main-ish branch first
    branches.sort((a, b) => Number(/^(main|master|develop)$/.test(b)) - Number(/^(main|master|develop)$/.test(a)));
    const list = [...props.commits].reverse(); // newest on top
    const pos = new Map(list.map((c, i) => [c.id, { x: X0 + branches.indexOf(c.branch) * LANE, y: 14 + i * ROW }]));
    const lines: { d: string; lane: number }[] = [];
    for (const c of list) {
      const a = pos.get(c.id)!;
      for (const p of c.parents ?? []) {
        const b = pos.get(p);
        if (!b) continue;
        const lane = branches.indexOf(props.commits.find((x) => x.id === (a.x === b.x ? c.id : a.x > b.x ? c.id : p))?.branch ?? c.branch);
        const d = a.x === b.x ? `M${a.x},${a.y} L${b.x},${b.y}` : `M${a.x},${a.y} C${a.x},${a.y + ROW * 0.7} ${b.x},${b.y - ROW * 0.7} ${b.x},${b.y}`;
        lines.push({ d, lane });
      }
    }
    return { branches, list, pos, lines, w: X0 * 2 + (branches.length - 1) * LANE, h: list.length * ROW };
  });
  return (
    <div class="blk wk-git">
      <Show when={props.label}><div class="blk-label">{props.label}</div></Show>
      <div class="wk-git-body">
        <svg width={g().w} height={g().h} class="wk-git-svg">
          <For each={g().lines}>{(l) => <path d={l.d} class={`lane-${l.lane % 6}`} />}</For>
          <For each={g().list}>{(c) => {
            const p = g().pos.get(c.id)!;
            const lane = g().branches.indexOf(c.branch);
            return <circle cx={p.x} cy={p.y} r={(c.parents?.length ?? 0) > 1 ? 5.5 : 4.5} class={`lane-${lane % 6}`} classList={{ merge: (c.parents?.length ?? 0) > 1 }} />;
          }}</For>
        </svg>
        <div class="wk-git-rows">
          <For each={g().list}>
            {(c, i) => (
              <div class="wk-git-row" style={{ height: `${ROW}px` }} classList={{ fresh: c.state === "new" }}>
                <Show when={i() === 0 || g().list[i() - 1]?.branch !== c.branch}>
                  <span class={`wk-branch lane-${g().branches.indexOf(c.branch) % 6}`}>{c.branch}</span>
                </Show>
                <Show when={c.tag}><span class="wk-tag">{c.tag}</span></Show>
                <Show when={c.state === "new"}><span class="wk-new">{t("새 커밋")}</span></Show>
                <span class="wk-msg">{c.msg}</span>
                <code class="wk-sha">{c.id.slice(0, 7)}</code>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}
