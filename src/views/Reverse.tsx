// 리버싱: what a job's reverse engineering has actually read, drawn from the trace
// ondra-binary keeps. The binary's code as a map that fills in as functions are
// listed, found, disassembled and decompiled; the trail of operations; and the
// function in focus as assembly (with its jumps) beside its pseudocode, linked
// line to instruction. Nothing moves unless the analysis does.
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js";
import { arrows, calls, cellDepths, depth, emptyTrace, fnAt, hex, readTrace, shortName, span, type RBinary, type ROp, type RStep, type RTrace } from "../engine/reverse";
import { reverseTrace } from "../lib/native";
import { state } from "../state/store";
import type { Task } from "../state/types";
import { tokenize, type Tok } from "../ui/highlight";
import { now } from "../ui/bits";

const COLS = 64;
const ROWS = 16;
const CELLS = COLS * ROWS;
const ROW_H = 20;

/** the file's kind in plain words (radare2 says MACH064, ELF64, PE32+) */
const kind = (t: Record<string, unknown>) => {
  const c = String(t.class ?? "").toUpperCase();
  const bin = String(t.bintype ?? "").toLowerCase();
  if (c.startsWith("MACH") || bin === "mach0") return "맥 실행 파일";
  if (c.startsWith("ELF") || bin === "elf") return "리눅스 실행 파일";
  if (c.startsWith("PE") || bin === "pe") return "윈도우 실행 파일";
  return c || undefined;
};
/** the source language radare2 guessed ("c with blocks" is C with Apple's blocks) */
const lang = (v: unknown) => {
  const l = String(v ?? "").toLowerCase();
  if (!l) return undefined;
  if (l.startsWith("c with blocks") || l === "c") return "C";
  if (l === "cxx" || l === "c++") return "C++";
  if (l === "objc") return "Objective-C";
  if (l === "swift") return "Swift";
  if (l === "rust") return "Rust";
  if (l === "go") return "Go";
  return l;
};
const OP: Record<RStep["op"], string> = { inspect: "구조", functions: "함수 목록", disassemble: "어셈블리", decompile: "의사코드" };
const DOING: Record<RStep["op"], string> = { inspect: "구조 읽는 중", functions: "함수 찾는 중", disassemble: "디스어셈블 중", decompile: "디컴파일 중" };

const bytes = (n?: number) => (n === undefined ? "" : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const secs = (ms?: number) => (ms === undefined ? "" : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}초`);
const n = (x: number) => x.toLocaleString("ko-KR");

/** Read the trace of a job and its subagents, only what is new each time. */
function useTrace(t: () => Task) {
  const [trace, setTrace] = createSignal<RTrace>(emptyTrace());
  const offsets = new Map<string, number>();
  const ids = () => [t().id, ...state.tasks.filter((k) => k.parentId === t().id).map((k) => k.id)];
  let busy = false;
  const load = async () => {
    if (busy) return;
    busy = true;
    try {
      let text = "";
      for (const id of ids()) {
        const r = await reverseTrace(id, offsets.get(id) ?? 0);
        if (r.end < (offsets.get(id) ?? 0)) setTrace(emptyTrace()), offsets.clear();
        offsets.set(id, r.end);
        text += r.text;
      }
      if (text) setTrace((prev) => readTrace(prev, text));
    } finally {
      busy = false;
    }
  };
  createEffect(on(() => t().id, () => (offsets.clear(), setTrace(emptyTrace()), void load())));
  const live = () => [t(), ...state.tasks.filter((k) => k.parentId === t().id)].some((x) => x.status === "running");
  const timer = setInterval(() => live() && void load(), 1500);
  onCleanup(() => clearInterval(timer));
  return { trace, live };
}

export function ReversePane(props: { t: Task }) {
  const { trace, live } = useTrace(() => props.t);
  const [pick, setPick] = createSignal<string>();
  const bin = createMemo(() => {
    const bins = trace().bins;
    return bins.find((b) => b.file === pick()) ?? [...bins].sort((x, y) => y.last - x.last)[0];
  });
  const steps = createMemo(() => trace().steps.filter((s) => !bin() || s.file === bin()!.file));
  // a step can be left "live" by a killed process: only a running job's recent one counts
  const running = () => {
    const s = trace().steps.filter((x) => x.state === "live");
    const last = s[s.length - 1];
    return live() && last && now() - last.at < 5 * 60_000 ? last : undefined;
  };

  // the function in focus: the one picked, else the latest one read
  const [chosen, setChosen] = createSignal<number>();
  const latest = createMemo(() => {
    const b = bin();
    if (!b) return undefined;
    const read = [...b.asm.values(), ...[...b.code.entries()].map(([addr, c]) => ({ addr, at: c.at }))];
    return read.sort((x, y) => y.at - x.at)[0]?.addr;
  });
  // a new function read moves the focus to it
  createEffect(on(latest, () => setChosen(undefined), { defer: true }));
  const focus = () => chosen() ?? latest();
  const choose = (addr: number) => {
    const b = bin();
    if (b && (b.asm.has(addr) || b.code.has(addr))) setChosen(addr);
  };

  return (
    <div class="rv">
      <Show when={bin()} fallback={<div class="pane-empty">{running() ? DOING[running()!.op] : "리버싱 기록 없음"}</div>}>
        {(b) => (
          <>
            <Head b={b()} running={running()} bins={trace().bins} pick={(f) => (setPick(f), setChosen(undefined))} />
            <BinaryMap b={b()} focus={focus()} live={running()?.address} onPick={choose} />
            <Trail steps={steps()} focus={focus()} onPick={choose} />
            <Show when={focus()} keyed fallback={<div class="rv-none">아직 읽은 함수 없음</div>}>
              {(addr) => <FnView b={b()} addr={addr} onPick={choose} />}
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

function Head(props: { b: RBinary; running?: RStep; bins: RBinary[]; pick: (file: string) => void }) {
  const meta = () => {
    const t = props.b.target;
    return [kind(t), t.arch === "arm" ? "arm64" : t.arch === "x86" ? "x86_64" : t.arch, lang(t.lang), bytes(props.b.size)].filter(Boolean).join(" · ");
  };
  return (
    <div class="rv-head">
      <div class="rv-file">
        <b title={props.b.sha256 ? `SHA-256 ${props.b.sha256}` : undefined}>{props.b.file}</b>
        <span class="rv-meta">{meta()}</span>
        <Show when={props.bins.length > 1}>
          <span class="rv-bins">
            <For each={props.bins}>{(x) => <button classList={{ on: x.file === props.b.file }} onClick={() => props.pick(x.file)}>{x.file}</button>}</For>
          </span>
        </Show>
      </div>
      <Show when={props.running}>
        {(s) => (
          <div class="rv-live">
            <span class="spin xs" />
            {DOING[s().op]}
            <Show when={s().address !== undefined}>
              <span class="rv-live-at">{((f) => (f ? shortName(f.name) : hex(s().address!)))(fnAt(props.b, s().address!))}</span>
            </Show>
            <Show when={s().filter}><span class="rv-live-at">"{s().filter}"</span></Show>
            <span class="rv-live-t">{Math.max(0, Math.floor((now() - s().at) / 1000))}초</span>
          </div>
        )}
      </Show>
    </div>
  );
}

/** The executable code as a grid of cells by address; each cell shows how far its functions were read. */
function BinaryMap(props: { b: RBinary; focus?: number; live?: number; onPick: (addr: number) => void }) {
  const range = createMemo(() => span(props.b));
  const cells = createMemo(() => cellDepths(props.b, CELLS));
  const per = () => (range().hi - range().lo) / CELLS;
  const cellOf = (addr: number) => Math.floor((addr - range().lo) / per());
  const cellsOf = (addr?: number) => {
    if (addr === undefined || range().hi <= range().lo) return [];
    const f = fnAt(props.b, addr);
    const a = cellOf(f?.addr ?? addr);
    const z = Math.max(a, cellOf((f?.addr ?? addr) + Math.max(1, f?.size ?? 1) - 1));
    return Array.from({ length: Math.min(CELLS, z + 1) - Math.max(0, a) }, (_, i) => Math.max(0, a) + i);
  };
  const counts = createMemo(() => {
    let found = 0;
    let asm = 0;
    let code = 0;
    for (const f of props.b.fns) {
      const d = depth(props.b, f.addr);
      if (d >= 2) found++;
      if (d === 3) asm++;
      if (d === 4) code++;
    }
    return { all: props.b.fns.length, found, asm, code };
  });
  const [hover, setHover] = createSignal<number>();
  /** the functions in a cell, deepest read first */
  const inCell = (c: number) => {
    const lo = range().lo + c * per();
    const hi = lo + per();
    return props.b.fns.filter((f) => f.addr < hi && f.addr + Math.max(1, f.size) > lo).sort((x, y) => depth(props.b, y.addr) - depth(props.b, x.addr));
  };
  const hovered = createMemo(() => (hover() === undefined ? [] : inCell(hover()!)));
  const at = (e: MouseEvent) => {
    const r = (e.currentTarget as SVGElement).getBoundingClientRect();
    const x = Math.floor(((e.clientX - r.left) / r.width) * COLS);
    const y = Math.floor(((e.clientY - r.top) / r.height) * ROWS);
    return x >= 0 && x < COLS && y >= 0 && y < ROWS ? y * COLS + x : undefined;
  };
  const sectionName = (s: string) => s.replace(/^\d+\./, "").replace(/^[A-Z_]+\./, "");
  /** the sections as bands over the map; slivers under 3% run together as one */
  const bands = createMemo(() => {
    const { lo, hi, sections } = range();
    const out: { w: number; names: string[] }[] = [];
    let start = lo;
    for (const sec of sections) {
      const w = ((Math.min(sec.vaddr + sec.vsize, hi) - Math.max(sec.vaddr, start)) / (hi - lo)) * 100;
      if (w <= 0) continue;
      const label = `${sec.name} · ${hex(sec.vaddr)} · ${bytes(sec.vsize)}`;
      const prev = out[out.length - 1];
      const sliver = (x: { w: number; names: string[] }) => x.names.length > 1 || x.w < 3;
      if (w < 3 && prev && sliver(prev)) (prev.w += w), prev.names.push(label);
      else out.push({ w, names: [label] });
      start = Math.max(start, sec.vaddr + sec.vsize);
    }
    return out;
  });
  return (
    <div class="rv-map">
      <Show when={bands().length}>
        <div class="rv-secs">
          <For each={bands()}>
            {(x) => (
              <span class="rv-sec" classList={{ few: x.names.length > 1 }} style={{ width: `${x.w}%` }} title={x.names.join("\n")}>
                <Show when={x.w > 14 && x.names.length === 1}>{sectionName(x.names[0])}</Show>
              </span>
            )}
          </For>
        </div>
      </Show>
      <svg
        class="rv-grid"
        viewBox={`0 0 ${COLS} ${ROWS}`}
        onMouseMove={(e) => setHover(at(e))}
        onMouseLeave={() => setHover(undefined)}
        onClick={(e) => {
          const c = at(e);
          const f = c === undefined ? undefined : inCell(c)[0];
          if (f) props.onPick(f.addr);
        }}
        role="img"
        aria-label={`함수 ${counts().all}개 중 어셈블리 ${counts().asm + counts().code}개, 의사코드 ${counts().code}개`}
      >
        <For each={Array.from({ length: CELLS }, (_, i) => i)}>
          {(i) => <rect class={`rv-cell d${cells()[i]}`} x={(i % COLS) + 0.08} y={Math.floor(i / COLS) + 0.08} width={0.84} height={0.84} rx={0.14} />}
        </For>
        <For each={cellsOf(props.focus)}>
          {(i) => <rect class="rv-cell-ring" x={(i % COLS) + 0.08} y={Math.floor(i / COLS) + 0.08} width={0.84} height={0.84} rx={0.14} />}
        </For>
        <For each={cellsOf(props.live)}>
          {(i) => <rect class="rv-cell-live" x={(i % COLS) + 0.08} y={Math.floor(i / COLS) + 0.08} width={0.84} height={0.84} rx={0.14} />}
        </For>
        <Show when={hover() !== undefined}>
          <rect class="rv-cell-hover" x={(hover()! % COLS) + 0.02} y={Math.floor(hover()! / COLS) + 0.02} width={0.96} height={0.96} rx={0.18} />
        </Show>
      </svg>
      <div class="rv-legend">
        <Show
          when={hover() !== undefined}
          fallback={
            <>
              <span><i class="rv-sw d1" />함수 {n(counts().all)}</span>
              <Show when={counts().found}><span><i class="rv-sw d2" />찾음 {n(counts().found)}</span></Show>
              <span><i class="rv-sw d3" />어셈블리 {n(counts().asm + counts().code)}</span>
              <span><i class="rv-sw d4" />의사코드 {n(counts().code)}</span>
            </>
          }
        >
          <span class="rv-addr">{hex(Math.floor(range().lo + hover()! * per()))}</span>
          <span class="rv-hover-fn">
            {hovered()[0] ? shortName(hovered()[0].name) : "함수 없음"}
            <Show when={hovered().length > 1}><span class="faint"> 외 {hovered().length - 1}개</span></Show>
          </span>
        </Show>
      </div>
    </div>
  );
}

function Trail(props: { steps: RStep[]; focus?: number; onPick: (addr: number) => void }) {
  let box!: HTMLDivElement;
  // a new step comes into view at the end
  createEffect(on(() => props.steps.length, () => queueMicrotask(() => box && (box.scrollLeft = box.scrollWidth))));
  const t0 = () => props.steps[0]?.at ?? 0;
  const detail = (s: RStep) =>
    s.filter ? `"${s.filter}" ${s.count ?? ""}` : s.op === "functions" && s.count !== undefined ? n(s.count) : s.address !== undefined ? hex(s.address).slice(-5) : "";
  return (
    <div class="rv-trail" ref={box}>
      <For each={props.steps}>
        {(s, i) => (
          <>
            <Show when={i() > 0}><span class="rv-trail-sep" /></Show>
            <button
              class={`rv-step ${s.state}`}
              classList={{ on: s.address !== undefined && s.address === props.focus }}
              disabled={s.address === undefined}
              title={[OP[s.op], s.filter ? `"${s.filter}"` : "", s.address !== undefined ? hex(s.address) : "", s.ms !== undefined ? secs(s.ms) : "", s.error ?? ""].filter(Boolean).join(" · ")}
              onClick={() => s.address !== undefined && props.onPick(s.address)}
            >
              <span class="rv-step-t">+{secs(s.at - t0()) || "0ms"}</span>
              <span class="rv-step-op">{OP[s.op]}</span>
              <Show when={detail(s)}><span class="rv-step-d">{detail(s)}</span></Show>
            </button>
          </>
        )}
      </For>
    </div>
  );
}

/** One instruction's text in parts: mnemonic, registers, numbers, symbols. */
function asmParts(d: string): { k: string; s: string }[] {
  const m = /^(\S+)(\s*)(.*)$/.exec(d);
  if (!m) return [{ k: "", s: d }];
  const out = [{ k: "mn", s: m[1] }, { k: "", s: m[2] }];
  const re = /((?:sym|fcn|method|sub|str|obj|reloc|section|loc)\.[\w.$@:<>?-]+)|(\b(?:[xwqdsbhv]\d{1,2}|[xw]zr|sp|lr|fp|pc|[re]?[abcd]x|[re]?[sd]i|[re]?[sb]p|r\d{1,2}[dwb]?|[re]ip|[xy]mm\d+)\b)|(-?\b0x[0-9a-f]+\b|-?\b\d+\b)/gi;
  let last = 0;
  for (const x of m[3].matchAll(re)) {
    if (x.index! > last) out.push({ k: "", s: m[3].slice(last, x.index) });
    out.push({ k: x[1] ? "sym" : x[2] ? "reg" : "num", s: x[0] });
    last = x.index! + x[0].length;
  }
  if (last < m[3].length) out.push({ k: "", s: m[3].slice(last) });
  return out;
}

function FnView(props: { b: RBinary; addr: number; onPick: (addr: number) => void }) {
  const asm = () => props.b.asm.get(props.addr);
  const code = () => props.b.code.get(props.addr);
  const fn = () => props.b.fns.find((f) => f.addr === props.addr) ?? (asm() ? { name: asm()!.name, addr: props.addr, size: asm()!.size } : undefined);
  const name = () => fn()?.name ?? hex(props.addr);
  const linked = createMemo(() => calls(props.b, props.addr));
  const known = (a: number) => props.b.asm.has(a) || props.b.code.has(a);

  // hover links instructions and pseudocode lines both ways
  const [hoverOp, setHoverOp] = createSignal<number>();
  const [hoverLine, setHoverLine] = createSignal<number>();
  const lineAddrs = createMemo(() => new Set(hoverLine() === undefined ? [] : code()?.lines[hoverLine()!] ?? []));
  const opLines = createMemo(() => {
    const a = hoverOp();
    const out = new Set<number>();
    if (a !== undefined) code()?.lines.forEach((l, i) => l.includes(a) && out.add(i));
    return out;
  });

  let asmBox!: HTMLDivElement;
  let codeBox!: HTMLDivElement;
  const toOp = (a?: number) => asmBox?.querySelector(`[data-a="${a}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  const toLine = (i?: number) => i !== undefined && codeBox?.querySelector(`[data-l="${i}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });

  return (
    <div class="rv-fn">
      <div class="rv-fn-head">
        <b title={name()}>{shortName(name())}</b>
        <span class="rv-addr">{hex(props.addr)}</span>
        <Show when={fn()?.size}><span class="faint">{bytes(fn()!.size)}</span></Show>
      </div>
      <Show when={linked().out.length || linked().in.length}>
        <div class="rv-calls">
          <Show when={linked().in.length}>
            <span class="rv-calls-k">호출됨</span>
            <For each={linked().in}>{(f) => <button class="rv-chip on" title={f.name} onClick={() => props.onPick(f.addr)}>{shortName(f.name)}</button>}</For>
          </Show>
          <Show when={linked().out.length}>
            <span class="rv-calls-k">호출</span>
            <For each={linked().out.slice(0, 24)}>
              {(c) => (
                <button class="rv-chip" classList={{ on: known(c.addr) }} disabled={!known(c.addr)} title={`${c.name} · ${hex(c.addr)}`} onClick={() => props.onPick(c.addr)}>
                  {shortName(c.name)}
                </button>
              )}
            </For>
            <Show when={linked().out.length > 24}><span class="faint">+{linked().out.length - 24}</span></Show>
          </Show>
        </div>
      </Show>
      <div class="rv-split" classList={{ both: !!asm() && !!code() }}>
        <Show when={asm()}>
          {(a) => <Listing ops={a().ops} total={a().totalOps} box={(el) => (asmBox = el)} lit={lineAddrs()} hover={hoverOp()} setHover={setHoverOp} known={known} onPick={props.onPick} onOp={(op) => toLine([...(code()?.lines.entries() ?? [])].find(([, l]) => l.includes(op.a))?.[0])} />}
        </Show>
        <Show when={code()}>
          {(c) => <Pseudo code={c().code} total={c().totalLines} box={(el) => (codeBox = el)} lit={opLines()} setHover={setHoverLine} onLine={(i) => toOp(c().lines[i]?.slice().sort((x, y) => x - y)[0])} />}
        </Show>
      </div>
    </div>
  );
}

function Listing(props: {
  ops: ROp[];
  total: number;
  box: (el: HTMLDivElement) => void;
  lit: Set<number>;
  hover?: number;
  setHover: (a?: number) => void;
  known: (a: number) => boolean;
  onPick: (a: number) => void;
  onOp: (op: ROp) => void;
}) {
  const jumps = createMemo(() => arrows(props.ops));
  const gutter = () => 8 + jumps().lanes * 7;
  const y = (i: number) => i * ROW_H + ROW_H / 2;
  const hoverRow = () => props.ops.findIndex((o) => o.a === props.hover);
  return (
    <div class="rv-asm" ref={props.box}>
      <div class="rv-asm-body" style={{ "--g": `${gutter()}px`, height: `${props.ops.length * ROW_H}px` }}>
        <svg class="rv-jumps" width={gutter()} height={props.ops.length * ROW_H} aria-hidden="true">
          <For each={jumps().list}>
            {(j) => {
              const x = () => gutter() - 6 - j.lane * 7;
              const hot = () => hoverRow() === j.from || hoverRow() === j.to;
              return (
                <path
                  class="rv-jump"
                  classList={{ cond: j.cond, back: j.to < j.from, hot: hot(), dim: hoverRow() >= 0 && !hot() }}
                  d={`M${gutter()} ${y(j.from)} H${x()} V${y(j.to)} H${gutter() - 2} m-3 -3 l3 3 l-3 3`}
                />
              );
            }}
          </For>
        </svg>
        <For each={props.ops}>
          {(o) => (
            <div
              class={`rv-op t-${o.t}`}
              classList={{ lit: props.lit.has(o.a), hov: props.hover === o.a }}
              data-a={o.a}
              onMouseEnter={() => props.setHover(o.a)}
              onMouseLeave={() => props.setHover(undefined)}
              onClick={() => props.onOp(o)}
            >
              <span class="rv-op-a" title={hex(o.a)}>{o.a.toString(16).slice(-6)}</span>
              <span class="rv-op-b">{o.b}</span>
              <span class="rv-op-d">
                <For each={asmParts(o.d)}>
                  {(p) =>
                    p.k === "sym" && /call/.test(o.t) && o.j !== undefined && props.known(o.j) ? (
                      <button
                        class="rv-tk sym go"
                        onClick={(e) => {
                          e.stopPropagation();
                          props.onPick(o.j!);
                        }}
                      >
                        {p.s}
                      </button>
                    ) : (
                      <span class={p.k ? `rv-tk ${p.k}` : undefined}>{p.s}</span>
                    )
                  }
                </For>
              </span>
            </div>
          )}
        </For>
      </div>
      <Show when={props.total > props.ops.length}><div class="rv-more">{n(props.ops.length)} / {n(props.total)}</div></Show>
    </div>
  );
}

function Pseudo(props: { code: string; total: number; box: (el: HTMLDivElement) => void; lit: Set<number>; setHover: (i?: number) => void; onLine: (i: number) => void }) {
  const lines = () => props.code.replace(/\n$/, "").split("\n");
  const [toks, setToks] = createSignal<Tok[][] | null>(null);
  createEffect(on(() => props.code, (c) => (setToks(null), void tokenize(c.replace(/\n$/, ""), "c").then(setToks))));
  const tok = (t: Tok) => (t.c ? <span class="tk" style={{ color: t.c, "--d": t.d ?? t.c }}>{t.text}</span> : t.text);
  return (
    <div class="rv-code" ref={props.box}>
      <For each={lines()}>
        {(l, i) => (
          <div class="rv-line" classList={{ lit: props.lit.has(i()) }} data-l={i()} onMouseEnter={() => props.setHover(i())} onMouseLeave={() => props.setHover(undefined)} onClick={() => props.onLine(i())}>
            <span class="rv-ln">{i() + 1}</span>
            <span class="rv-lt">{toks()?.[i()] ? <For each={toks()![i()]}>{tok}</For> : l}</span>
          </div>
        )}
      </For>
      <Show when={props.total > lines().length}><div class="rv-more">{n(lines().length)} / {n(props.total)}</div></Show>
    </div>
  );
}
