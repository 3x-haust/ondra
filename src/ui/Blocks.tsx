// Result blocks the agents send (see skills/visual-report): drawn, not read.
import { For, Match, Show, Switch } from "solid-js";
import type { Block, Evidence } from "../state/types";
import { fileSrc, openUrl } from "../lib/native";
import { previewFile } from "../state/ui";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";
import { Arch, Classes, Deps, Er, Flow, States } from "./Charts";
import { Diff, Git, Options, Tests, Trace } from "./Work";
import { Bars, Groups, Scope, Sequence, Steps, Tree } from "./Visuals";
import { openImage } from "./Lightbox";

type Of<T extends Block["type"]> = Extract<Block, { type: T }>;

function openRef(ref: string) {
  if (/^https?:\/\//.test(ref)) openUrl(ref);
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
      <Show when={props.path} fallback={<div class="ph">이미지 없음</div>}>
        {(p) => (
          <button onClick={() => openImage(p())} title="크게 보기">
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
      <div class="cmp-row">
        <span class="muted">전</span>
        <span class="bar"><i style={{ width: `${(props.b.before / max()) * 100}%` }} /></span>
        <span class="v">{props.b.before}{props.b.unit ?? ""}</span>
      </div>
      <div class="cmp-row">
        <span class="muted">후</span>
        <span class={`bar ${good() ? "good" : "bad"}`}><i style={{ width: `${(props.b.after / max()) * 100}%` }} /></span>
        <span class="v strong">{props.b.after}{props.b.unit ?? ""}</span>
      </div>
    </div>
  );
}

const EVIDENCE_LABEL: Record<string, string> = { test: "테스트", build: "빌드", run: "실행", shot: "화면", file: "파일", link: "링크" };

/** What the job actually ran or produced, and what it could not check. */
function EvidenceView(props: { items: Evidence[]; unverified?: string[] }) {
  const open = (e: Evidence) => {
    if (e.kind === "shot" || /\.(png|jpe?g|gif|webp)$/i.test(e.ref)) openImage(e.ref);
    else openRef(e.ref);
  };
  const clickable = (e: Evidence) => /^(https?:\/\/|\/|~)/.test(e.ref);
  return (
    <div class="blk blk-evidence">
      <div class="blk-label">증거 {props.items.length}개{props.unverified?.length ? ` · 확인 못 한 것 ${props.unverified.length}개` : ""}</div>
      <For each={props.items}>
        {(e) => (
          <div class="ev-row" classList={{ bad: e.ok === false }}>
            <span class="ev-mark"><Icon name={e.ok === false ? "x" : "check"} size={11} stroke={3} /></span>
            <span class="ev-kind">{EVIDENCE_LABEL[e.kind] ?? e.kind}</span>
            <Show when={clickable(e)} fallback={<code class="ev-ref" title={e.ref}>{e.ref}</code>}>
              <button class="ev-ref link" title={e.ref} onClick={() => open(e)}>{e.ref.replace(/^https?:\/\/(www\.)?/, "").split("/").slice(-2).join("/")}</button>
            </Show>
            <Show when={e.why ?? e.note}><span class="ev-note">{e.why ?? e.note}</span></Show>
            <Show when={e.check}>
              <span class={`ev-check ${e.check}`} title={e.check === "ran" ? "이 일에서 실제로 돌린 기록과 맞아요" : e.check === "exists" ? "파일이 실제로 있어요" : e.check === "self" ? "앱이 확인할 수 없어 일의 말을 그대로 적었어요" : "앱이 확인해 보니 맞지 않아요"}>
                {e.check === "ran" || e.check === "exists" ? "앱이 확인" : e.check === "self" ? "자가 신고" : "안 맞음"}
              </span>
            </Show>
          </div>
        )}
      </For>
      <For each={props.unverified ?? []}>
        {(u) => (
          <div class="ev-row todo">
            <span class="ev-mark">?</span>
            <span class="ev-kind">확인 못 함</span>
            <span class="ev-note">{u}</span>
          </div>
        )}
      </For>
    </div>
  );
}

/** A block, and under it the one line the agent wrote to say what it shows. */
export function BlockView(props: { block: Block }) {
  // the takeaway goes under the picture as plain text; older diff / options
  // blocks carried it as note / why
  const say = () => {
    const b = props.block as Block & { say?: unknown; note?: unknown; why?: unknown };
    const t = typeof b.say === "string" ? b.say : b.type === "diff" ? b.note : b.type === "options" ? b.why : "";
    return typeof t === "string" ? t.trim() : "";
  };
  return (
    <Show when={say()} fallback={<BlockBody block={props.block} />}>
      <figure class="blk-fig">
        <BlockBody block={props.block} />
        <p class="blk-say">{say()}</p>
      </figure>
    </Show>
  );
}

function BlockBody(props: { block: Block }) {
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
            <ol class="tl">
              <For each={tl().items}>
                {(it) => (
                  <li class={`tl-item ${it.state}`}>
                    <span class="tl-dot"><Show when={it.state === "done"}><Icon name="check" size={9} stroke={3.5} /></Show></span>
                    <span class="tl-label">{it.label}</span>
                    <Show when={it.at}><span class="tl-at">{it.at}</span></Show>
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
                  <div class="ba-side before"><span class="ba-tag">전</span>{c().before}</div>
                  <Icon name="arrow" size={14} class="ba-arrow" />
                  <div class="ba-side after"><span class="ba-tag">후</span>{c().after}</div>
                </div>
              }
            >
              <div class="ba-pair">
                <Shot path={c().beforeImage} caption={`전 · ${c().before}`} />
                <Shot path={c().afterImage} caption={`후 · ${c().after}`} />
              </div>
            </Show>
          </div>
        )}
      </Match>
      <Match when={as("files")}>
        {(f) => {
          const max = () => Math.max(...f().files.map((x) => x.add + x.del), 1);
          return (
            <div class="blk">
              <div class="blk-label">변경한 파일 {f().files.length}개</div>
              <For each={f().files}>
                {(x) => (
                  <div class="file-row">
                    <span class="name" title={x.path}>{x.path}</span>
                    <span class="file-bar">
                      <i class="a" style={{ width: `${(x.add / max()) * 100}%` }} />
                      <i class="d" style={{ width: `${(x.del / max()) * 100}%` }} />
                    </span>
                    <span class="file-num"><span class="add">+{x.add}</span><Show when={x.del}> <span class="del">−{x.del}</span></Show></span>
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
          <button class="blk blk-link" onClick={() => openRef(l().ref)}>
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
              <button class="link-btn" onClick={() => previewFile(p().path)}>크게 보기</button>
            </div>
            <iframe class="blk-page-frame" sandbox="allow-scripts" src={fileSrc(p().path)} style={{ height: `${Math.min(Math.max(p().height ?? 420, 200), 900)}px` }} />
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
      <Match when={as("evidence")}>{(x) => <EvidenceView items={x().items ?? []} unverified={x().unverified} />}</Match>
    </Switch>
  );
}
