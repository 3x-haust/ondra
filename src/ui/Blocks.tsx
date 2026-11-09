// Result blocks the agents send (see skills/visual-report): drawn, not read.
import { createSignal, ErrorBoundary, For, Match, Show, Switch } from "solid-js";
import type { Block, Evidence, Task } from "../state/types";
import { homeDir } from "../state/store";
import { expand, tilde } from "../engine/rpc";
import { mainCommand } from "../engine/describe";
import { fileSrc, pageSrc } from "../lib/native";
import { linkMenu, openLink } from "./links";
import { previewFile } from "../state/ui";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { Arch, Classes, Deps, Er, Flow, States } from "./Charts";
import { Diff, Git, Options, Tests, Trace } from "./Work";
import { Bars, Groups, Scope, Sequence, Steps, Tree } from "./Visuals";
import { openImage } from "./Lightbox";
import { vizOf } from "./viz";
import { t } from "../i18n";

type Of<T extends Block["type"]> = Extract<Block, { type: T }>;
/** an evidence block with the checklist the job ended with folded in (see Transcript) */
export type ProofBlock = Of<"evidence"> & { checks?: { label: string; done: boolean }[] };

function openRef(ref: string, e?: MouseEvent) {
  if (/^https?:\/\//.test(ref)) openLink(ref, { event: e });
  else if (ref.startsWith("/") || ref.startsWith("~")) previewFile(ref);
}

function Ring(props: { value: number; total: number }) {
  const size = 44;
  const r = size / 2 - 4;
  const c = 2 * Math.PI * r;
  const frac = () => (props.total ? Math.min(1, props.value / props.total) : 0);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${props.value}/${props.total}`}>
      <circle cx={size / 2} cy={size / 2} r={r} class="ring-track" />
      <circle cx={size / 2} cy={size / 2} r={r} class="ring-fill" stroke-dasharray={`${c * frac()} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" dominant-baseline="central" text-anchor="middle" class="ring-text">
        {Math.round(frac() * 100)}%
      </text>
    </svg>
  );
}

function Spark(props: { values: number[] }) {
  const w = 120;
  const h = 28;
  const pts = () => {
    const v = props.values;
    const min = Math.min(...v);
    const span = Math.max(...v) - min || 1;
    return v.map((y, i) => [(i / Math.max(1, v.length - 1)) * (w - 4) + 2, h - 3 - ((y - min) / span) * (h - 6)] as const);
  };
  const line = () => pts().map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const last = () => pts()[pts().length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <path d={`${line()} L${w - 2} ${h} L2 ${h} Z`} class="spark-area" />
      <path d={line()} class="spark-line" />
      <circle cx={last()[0]} cy={last()[1]} r="2.4" class="spark-end" />
    </svg>
  );
}

function Shot(props: { path?: string; caption: string }) {
  return (
    <figure class="shot">
      <Show when={props.path} fallback={<div class="ph">{t("이미지 없음")}</div>}>
        {(p) => (
          <button onClick={() => openImage(p())} title={t("크게 보기")}>
            <img src={fileSrc(p())} alt={props.caption} loading="lazy" />
          </button>
        )}
      </Show>
      <Show when={props.caption}><figcaption>{props.caption}</figcaption></Show>
    </figure>
  );
}

function Compare(props: { b: Of<"compare"> }) {
  const max = () => Math.max(props.b.before, props.b.after) || 1;
  const good = () => (props.b.better === "up" ? props.b.after >= props.b.before : props.b.after <= props.b.before);
  return (
    <div class="blk">
      <div class="blk-label">{props.b.label}</div>
      <div class="cmp">
        <div class="cmp-row">
          <span class="muted">{t("전")}</span>
          <span class="bar"><i style={{ width: `${(props.b.before / max()) * 100}%` }} /></span>
          <span class="v">{props.b.before}{props.b.unit ?? ""}</span>
        </div>
        <div class="cmp-row">
          <span class="muted">{t("후")}</span>
          <span class={`bar ${good() ? "good" : "bad"}`}><i style={{ width: `${(props.b.after / max()) * 100}%` }} /></span>
          <span class="v strong">{props.b.after}{props.b.unit ?? ""}</span>
        </div>
      </div>
    </div>
  );
}

const EVIDENCE_LABEL: Record<string, string> = { test: "테스트", build: "빌드", run: "실행", shot: "화면", file: "파일|proof", link: "링크" };
const RUNS = new Set(["test", "build", "run"]);
const MISMATCH = new Set(["no-run", "failed", "stale", "missing", "unread"]);
/** how much a row proves: checked against the session, a file that is there, the job's word, or only the record */
type Mark = "ok" | "exists" | "self" | "none" | "bad";
const markOf = (e: Evidence): Mark =>
  (e.check && MISMATCH.has(e.check)) || e.ok === false
    ? "bad"
    : e.check === "ran" || e.check === "read" || (e.check === "exists" && e.kind === "shot")
      ? "ok"
      : e.check === "exists"
        ? "exists"
        : e.check === "self"
          ? "self"
          : "none";
const MARK_LABEL: Record<Exclude<Mark, "bad">, string> = { ok: "확인됨", exists: "파일 있음", self: "작업이 한 말", none: "기록만 있음" };

/** words to match a to-do line against a proof ("스크린샷은" meets "스크린샷") */
const words = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2);
const near = (a: string, b: string) => {
  const B = words(b);
  return words(a).some((x) => B.some((y) => x.startsWith(y) || y.startsWith(x)));
};
const sameLine = (s: string) => s.trim().replace(/[.。!]+$/, "").replace(/\s+/g, " ").toLowerCase();

/** "/Users/me/ondra-wt/src/a.ts" → "src/a.ts": inside the project, else "~/…" */
export function relPath(ref: string, task?: Task): string {
  const clean = ref.replace(/\/+$/, "");
  if (!/^[/~]/.test(clean)) return clean;
  const abs = expand(clean);
  const home = expand("~");
  const roots = task ? [task.worktree?.path, homeDir(task), expand(task.cwd)].filter((r): r is string => !!r && r.length > 1 && r !== home) : [];
  // where the job worked: the folder all the files it touched share
  if (task) {
    const dirs = task.entries.flatMap((e) => (e.kind === "tool" && /^\//.test(e.tool.detail ?? "") && e.tool.kind !== "bash" ? [e.tool.detail!.split("\n")[0].split("/").slice(0, -1)] : []));
    if (dirs.length > 1) {
      const root = dirs
        .reduce((a, d) => {
          let i = 0;
          while (i < a.length && a[i] === d[i]) i++;
          return a.slice(0, i);
        })
        .join("/");
      if (root.length > 1 && root !== home) roots.push(root);
    }
  }
  for (const r of roots.map((x) => expand(x).replace(/\/+$/, ""))) if (abs.startsWith(`${r}/`)) return abs.slice(r.length + 1);
  return tilde(abs);
}

/** a command as one short line: the part doing the work */
const shortCmd = (ref: string) => {
  const c = mainCommand(ref).replace(/\s+/g, " ");
  return c.length > 60 ? `${c.slice(0, 59)}…` : c;
};

type Row = { e: Evidence; title?: string };

/**
 * What the job proved, one list right under its answer: what doesn't hold first (in the attention colour,
 * with why), the screenshots as pictures, each run with its command and its real result line, then what
 * it could not check, once each. A to-do checklist the job ended with folds in: a done line takes the
 * proof that backs it (or reads as the job's word), an open line joins what wasn't checked.
 */
export function ProofView(props: { items: Evidence[]; unverified?: string[]; checks?: { label: string; done: boolean }[]; task?: Task }) {
  const [allShots, setAllShots] = createSignal(false);
  const built = () => {
    const items = props.items.filter((e) => e && typeof e.ref === "string");
    const titles = new Map<Evidence, string>();
    const extra: Row[] = [];
    const open: string[] = [];
    for (const c of props.checks ?? []) {
      if (!c.done) {
        open.push(c.label);
        continue;
      }
      const e = items.find((x) => !titles.has(x) && x.kind !== "shot" && near(c.label, `${x.note ?? ""} ${x.out ?? ""} ${x.ref} ${EVIDENCE_LABEL[x.kind] ?? ""} ${t(EVIDENCE_LABEL[x.kind] ?? x.kind)}`));
      if (e) titles.set(e, c.label);
      else extra.push({ e: { kind: "", ref: "", check: "self" }, title: c.label });
    }
    const rows = items.map((e): Row => ({ e, title: titles.get(e) }));
    const bad = rows.filter((r) => markOf(r.e) === "bad");
    const shots = rows.filter((r) => r.e.kind === "shot" && markOf(r.e) !== "bad");
    const rest = [...rows.filter((r) => r.e.kind !== "shot" && markOf(r.e) !== "bad"), ...extra];
    // what it couldn't check, each once: an open to-do line that the job's own reason covers goes
    const why = props.unverified ?? [];
    const left = [...open.filter((o) => !why.some((u) => near(o, u))), ...why];
    const seen = new Set<string>();
    const unchecked = left.filter((u) => u.trim() && !seen.has(sameLine(u)) && (seen.add(sameLine(u)), true));
    return { bad, shots, rest, unchecked };
  };
  const SHOWN = 4;
  const shots = () => {
    const s = built().shots;
    return allShots() || s.length <= SHOWN ? s : s.slice(-SHOWN);
  };
  const open = (e: Evidence, ev?: MouseEvent) => {
    if (e.kind === "shot" || /\.(png|jpe?g|gif|webp)$/i.test(e.ref)) openImage(e.ref, built().shots.map((r) => r.e.ref));
    else openRef(e.ref, ev);
  };
  const clickable = (e: Evidence) => /^(https?:\/\/|\/|~)/.test(e.ref);
  const where = (e: Evidence) => (/^https?:\/\//.test(e.ref) ? e.ref.replace(/^https?:\/\/(www\.)?/, "") : relPath(e.ref, props.task));
  const row = (r: Row) => {
    const e = r.e;
    const m = markOf(e);
    const runs = RUNS.has(e.kind);
    // a claim in words (not a command, path or link) is its own title
    const prose = !runs && !clickable(e) && !EVIDENCE_LABEL[e.kind];
    const title = r.title ?? (runs ? undefined : e.note) ?? (prose ? e.ref : EVIDENCE_LABEL[e.kind] ? t(EVIDENCE_LABEL[e.kind]) : e.kind);
    return (
      <div class={`pf-row ${m}`}>
        <span class="pf-mark" aria-hidden="true">
          <Switch fallback={<i />}>
            <Match when={m === "ok"}><Icon name="check" size={10} stroke={3} /></Match>
            <Match when={m === "bad"}><Icon name="x" size={10} stroke={3} /></Match>
          </Switch>
        </span>
        <span class="pf-title">{title}</span>
        <Show when={e.ref && !(prose && title === e.ref)}>
          <Show
            when={runs}
            fallback={
              <Show when={clickable(e)} fallback={<code class="pf-ref" title={e.ref}>{e.ref}</code>}>
                <button class="pf-ref link" title={e.ref} onClick={(ev) => open(e, ev)} onContextMenu={linkMenu(e.ref)}>{where(e)}</button>
              </Show>
            }
          >
            <code class="pf-ref" title={e.ref}>{shortCmd(e.ref)}</code>
            <Show when={e.out}><span class="pf-out">{e.out}</span></Show>
          </Show>
        </Show>
        <Show when={runs && !e.out && r.title && e.note}><span class="pf-note">{e.note}</span></Show>
        <span class="pf-badge">{m === "bad" ? (e.why ? t(e.why) : t("불일치")) : t(MARK_LABEL[m])}</span>
      </div>
    );
  };
  return (
    <div class="blk blk-proof">
      <Show when={built().bad.length || built().shots.length || built().rest.length}>
        <div class="blk-label">{t("확인|proof")}</div>
        <For each={built().bad}>{row}</For>
        <Show when={built().shots.length}>
          <div class="pf-shots">
            <Show when={!allShots() && built().shots.length > SHOWN}>
              <button class="pf-more" onClick={() => setAllShots(true)}>{t("+{n}장", { n: built().shots.length - SHOWN })}</button>
            </Show>
            <For each={shots()}>
              {(r) => (
                <figure class="pf-shot">
                  <button onClick={() => open(r.e)} title={r.e.note ?? t("크게 보기")}>
                    <img src={fileSrc(r.e.ref)} alt={r.e.note ?? ""} loading="lazy" />
                  </button>
                  <figcaption>
                    <Show when={markOf(r.e) === "ok"} fallback={<span class="pf-badge">{t(MARK_LABEL[markOf(r.e) as Exclude<Mark, "bad">])}</span>}>
                      <Icon name="check" size={10} stroke={3} />
                    </Show>
                    <span>{r.title ?? r.e.note ?? t("화면")}</span>
                  </figcaption>
                </figure>
              )}
            </For>
          </div>
        </Show>
        <For each={built().rest}>{row}</For>
      </Show>
      <Show when={built().unchecked.length}>
        <div class="blk-label pf-left-label">{t("확인 못 한 것")}</div>
        <ul class="pf-left">
          <For each={built().unchecked}>{(u) => <li>{u}</li>}</For>
        </ul>
      </Show>
    </div>
  );
}

/** A block, and under it the one line the agent wrote to say what it shows. */
export function BlockView(props: { block: Block; task?: Task }) {
  // the takeaway goes under the picture as plain text; older diff / options
  // blocks carried it as note / why
  const say = () => {
    const b = props.block as Block & { say?: unknown; note?: unknown; why?: unknown };
    const t = typeof b.say === "string" ? b.say : b.type === "diff" ? b.note : b.type === "options" ? b.why : "";
    return typeof t === "string" ? t.trim() : "";
  };
  // a block an agent got wrong is left out; it never takes the rest of the app down with it
  return (
    <ErrorBoundary fallback={() => null}>
      <Show when={say()} fallback={<BlockBody block={props.block} task={props.task} />}>
        <figure class="blk-fig">
          <BlockBody block={props.block} task={props.task} />
          <p class="blk-say">{say()}</p>
        </figure>
      </Show>
    </ErrorBoundary>
  );
}

function BlockBody(props: { block: Block; task?: Task }) {
  const b = () => props.block;
  const as = <T extends Block["type"]>(t: T) => (b().type === t ? (b() as Of<T>) : false);
  return (
    <Switch>
      <Match when={as("progress")}>
        {(p) => (
          <div class="blk blk-progress">
            <Ring value={p().value} total={p().total} />
            <div>
              <div>{p().label}</div>
              <div class="muted">{p().value} / {p().total}</div>
            </div>
          </div>
        )}
      </Match>
      <Match when={as("compare")}>{(c) => <Compare b={c()} />}</Match>
      <Match when={as("timeline")}>
        {(tl) => (
          <div class="blk">
            <Show when={tl().label}><div class="blk-label">{tl().label}</div></Show>
            <ol class="vz-tl">
              <For each={tl().items}>
                {(it) => (
                  <li class={`vz-tl-item ${it.state}`}>
                    <span class="vz-tl-dot"><Show when={it.state === "done"}><Icon name="check" size={9} stroke={3.5} /></Show></span>
                    <span class="vz-tl-label">{it.label}</span>
                    <Show when={it.at}><span class="vz-tl-at">{it.at}</span></Show>
                  </li>
                )}
              </For>
            </ol>
          </div>
        )}
      </Match>
      <Match when={as("checklist")}>
        {(c) => (
          <div class="blk">
            <Show when={c().label}><div class="blk-label">{c().label}</div></Show>
            <For each={c().items}>
              {(it) => (
                <div class="chk" classList={{ done: it.done }}>
                  <span class="box"><Show when={it.done}><Icon name="check" size={10} stroke={3} /></Show></span>
                  <span>{it.label}</span>
                </div>
              )}
            </For>
          </div>
        )}
      </Match>
      <Match when={as("beforeAfter")}>
        {(c) => (
          <div class="blk">
            <div class="blk-label">{c().label}</div>
            <Show
              when={c().beforeImage || c().afterImage}
              fallback={
                <div class="ba-text">
                  <div class="ba-side before"><span class="ba-tag">{t("전")}</span>{c().before}</div>
                  <Icon name="arrow" size={14} class="ba-arrow" />
                  <div class="ba-side after"><span class="ba-tag">{t("후")}</span>{c().after}</div>
                </div>
              }
            >
              <div class="ba-pair">
                <Shot path={c().beforeImage} caption={`${t("전")} · ${c().before}`} />
                <Shot path={c().afterImage} caption={`${t("후")} · ${c().after}`} />
              </div>
            </Show>
          </div>
        )}
      </Match>
      <Match when={as("files")}>
        {(f) => {
          // agents also send { items: [{ path, note }] } instead of counted lines
          const list = () => {
            const b = f() as Of<"files"> & { items?: { path?: string; note?: string; add?: number; del?: number }[] };
            const raw = Array.isArray(b.files) ? b.files : Array.isArray(b.items) ? b.items : [];
            return raw.filter((x) => x && typeof x.path === "string").map((x) => ({ path: x.path as string, add: Number(x.add) || 0, del: Number(x.del) || 0, note: (x as { note?: string }).note }));
          };
          const max = () => Math.max(...list().map((x) => x.add + x.del), 1);
          return (
            <div class="blk">
              <div class="blk-label">{t("변경한 파일 {n}개", { n: list().length })}</div>
              <For each={list()}>
                {(x) => (
                  <div class="file-row">
                    <span class="name" title={x.path}>{x.path}</span>
                    <Show
                      when={x.add || x.del}
                      fallback={<Show when={x.note}><span class="file-note">{x.note}</span></Show>}
                    >
                      <span class="file-bar">
                        <i class="a" style={{ width: `${(x.add / max()) * 100}%` }} />
                        <i class="d" style={{ width: `${(x.del / max()) * 100}%` }} />
                      </span>
                      <span class="file-num"><span class="add">+{x.add}</span><Show when={x.del}> <span class="del">−{x.del}</span></Show></span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          );
        }}
      </Match>
      <Match when={as("metric")}>
        {(m) => (
          <div class="blk">
            <div class="blk-label">{m().label}</div>
            <div class="metric-row">
              <span class="metric-v">{m().value}</span>
              <Show when={m().delta}><span class="metric-d">{m().delta}</span></Show>
              <span class="spacer" />
              <Show when={m().trend && m().trend!.length > 1}><Spark values={m().trend!} /></Show>
            </div>
          </div>
        )}
      </Match>
      <Match when={as("table")}>
        {(t) => (
          <div class="blk blk-table">
            <table>
              <thead><tr><For each={t().columns}>{(c) => <th>{c}</th>}</For></tr></thead>
              <tbody><For each={t().rows}>{(r) => <tr><For each={r}>{(c) => <td>{c}</td>}</For></tr>}</For></tbody>
            </table>
          </div>
        )}
      </Match>
      <Match when={as("link")}>
        {(l) => (
          <button class="blk blk-link" onClick={(e) => openRef(l().ref, e)} onContextMenu={linkMenu(l().ref)}>
            <Icon name={l().kind === "pr" ? "pr" : l().kind === "video" ? "video" : l().kind === "file" || l().kind === "doc" ? "file" : "link"} size={15} />
            <span>{l().title}</span>
            <span class="ref" title={l().ref}>{/^[/~]/.test(l().ref) ? l().ref.split("/").slice(-2).join("/") : l().ref.replace(/^https?:\/\/(www\.)?/, "")}</span>
          </button>
        )}
      </Match>
      <Match when={as("page")}>
        {(p) => (
          <div class="blk blk-page">
            <div class="blk-page-head">
              <span class="blk-label">{p().label ?? p().path.split("/").pop()}</span>
              <span class="spacer" />
              <button class="link-btn" onClick={() => previewFile(p().path)}>{t("크게 보기")}</button>
            </div>
            <iframe class="blk-page-frame" sandbox="allow-scripts" src={pageSrc(p().path)} style={{ height: `${Math.min(Math.max(p().height ?? 420, 200), 900)}px` }} />
          </div>
        )}
      </Match>
      <Match when={as("shot")}>
        {(x) => (
          <div class="blk">
            <Shot path={x().path} caption={x().caption} />
          </div>
        )}
      </Match>
      <Match when={as("text")}>{(x) => <div class="blk"><Markdown text={x().text} /></div>}</Match>
      <Match when={as("flow")}>{(x) => <Flow label={x().label} dir={x().dir} nodes={x().nodes ?? []} edges={x().edges} />}</Match>
      <Match when={as("deps")}>{(x) => <Deps label={x().label} dir={x().dir} nodes={x().nodes ?? []} edges={x().edges} />}</Match>
      <Match when={as("classes")}>{(x) => <Classes label={x().label} dir={x().dir} classes={x().classes ?? []} relations={x().relations} />}</Match>
      <Match when={as("er")}>{(x) => <Er label={x().label} dir={x().dir} tables={x().tables ?? []} relations={x().relations} />}</Match>
      <Match when={as("states")}>{(x) => <States label={x().label} dir={x().dir} initial={x().initial} states={x().states ?? []} transitions={x().transitions} />}</Match>
      <Match when={as("diff")}>{(x) => <Diff label={x().label} path={x().path ?? ""} ref={x().ref} note={x().note} hunks={x().hunks ?? []} />}</Match>
      <Match when={as("tests")}>{(x) => <Tests label={x().label} suites={x().suites ?? []} failures={x().failures} />}</Match>
      <Match when={as("options")}>{(x) => <Options label={x().label} criteria={x().criteria ?? []} options={x().options ?? []} why={x().why} />}</Match>
      <Match when={as("trace")}>{(x) => <Trace label={x().label} unit={x().unit} spans={x().spans ?? []} />}</Match>
      <Match when={as("git")}>{(x) => <Git label={x().label} commits={x().commits ?? []} />}</Match>
      <Match when={as("arch")}>{(x) => <Arch label={x().label} dir={x().dir} zones={x().zones} nodes={x().nodes ?? []} edges={x().edges} />}</Match>
      {/* the older "diagram" block draws with the flow layout: lines routed around boxes, labels kept apart */}
      <Match when={as("diagram")}>{(x) => <Flow label={x().label} nodes={(x().nodes ?? []).map((n, _, all) => ({ id: n.id, label: n.label, note: n.note, ref: n.ref, kind: "step" as const, state: all.every((m) => m.state === n.state) ? undefined : n.state }))} edges={x().edges} />}</Match>
      <Match when={as("scope")}>{(x) => <Scope label={x().label} in={x().in} out={x().out} />}</Match>
      <Match when={as("bars")}>{(x) => <Bars label={x().label} unit={x().unit} total={x().total} items={x().items ?? []} />}</Match>
      <Match when={as("tree")}>{(x) => <Tree label={x().label} unit={x().unit} items={x().items ?? []} />}</Match>
      <Match when={as("groups")}>{(x) => <Groups label={x().label} groups={x().groups ?? []} links={x().links} />}</Match>
      <Match when={as("sequence")}>{(x) => <Sequence label={x().label} actors={x().actors ?? []} steps={x().steps ?? []} />}</Match>
      <Match when={as("steps")}>{(x) => <Steps label={x().label} items={x().items ?? []} />}</Match>
      <Match when={as("evidence")}>{(x) => <ProofView items={x().items ?? []} unverified={x().unverified} checks={(x() as ProofBlock).checks} task={props.task} />}</Match>
      <Match when={vizOf(b().type)}>{(s) => s().render(b())}</Match>
    </Switch>
  );
}
