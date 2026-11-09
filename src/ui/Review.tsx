// Review: what a fork changed (Changes) and everything in its folder (Files).
// Diffs are parsed into files → hunks → lines with old/new line numbers, shown
// as collapsible cards with sticky headers. Files is a searchable tree; a file
// opens in a numbered viewer and can flip to its diff.
import { confirmDiscard } from "./taskMenu";
import { createEffect, createMemo, createResource, createSignal, For, type JSX, lazy, Match, on, Show, Suspense, Switch } from "solid-js";
import type { Task } from "../state/types";
import { openChanges, panelFile, previewFile, previewPath, setPanelFile, setPanelTab, setPreviewPath, toast } from "../state/ui";
import { Markdown } from "./Markdown";
import { expand } from "../engine/rpc";
import { fileSrc, fsFiles, fsGrep, fsRead, fsWrite, gitChanges, openInEditor, pageSrc, pdfSrc, revealPath, type GitChanges } from "../lib/native";
import { Fold } from "./Fold";
import { Icon } from "./Icon";
import { GlyphMark } from "../views/Sidebar";
import { langOf, tokenize, type Tok } from "./highlight";
import { t as tr } from "../i18n";
import { withHint } from "../lib/shortcuts";
import { discarded, rememberDiff } from "../state/progress";

// ───────────── diff model (diffModel.ts) ─────────────
import { parsePatch, type DiffFile, type Hunk, type Line } from "./diffModel";
export { parsePatch, type DiffFile, type Line };

const split = (p: string) => {
  const i = p.lastIndexOf("/");
  return i < 0 ? ["", p] : [p.slice(0, i + 1), p.slice(i + 1)];
};
const STATUS: Record<DiffFile["status"], string> = { A: "새 파일", M: "수정", D: "삭제", R: "이름 바뀜" };

/** Changes of a task, refreshed when its tools finish (only while `enabled` says so). */
export function useChanges(t: () => Task, enabled: () => boolean = () => true) {
  const [data, { refetch }] = createResource(
    () => enabled() && ([expand(t().cwd), t().worktree?.state === "open" ? t().worktree!.base : undefined] as const),
    ([cwd, base]) => gitChanges(cwd, base),
  );
  createEffect(on(() => t().entries.filter((e) => e.kind === "tool" && e.tool.endedAt).length, () => refetch(), { defer: true }));
  // what's shown here is what the sidebar, canvas and review bar count
  createEffect(() => {
    const d = data();
    if (d?.isRepo) rememberDiff(t(), d.files);
  });
  return [data, refetch] as const;
}

/** Split tokens at a changed span so it can be marked (word-level diff). */
function withMark(toks: Tok[], mark?: [number, number]): (Tok & { em?: boolean })[] {
  if (!mark) return toks;
  const out: (Tok & { em?: boolean })[] = [];
  let at = 0;
  for (const t of toks) {
    const a = at;
    const b = at + t.text.length;
    at = b;
    const cuts = [a, Math.min(Math.max(mark[0], a), b), Math.min(Math.max(mark[1], a), b), b];
    for (let i = 0; i < 3; i++) if (cuts[i + 1] > cuts[i]) out.push({ ...t, text: t.text.slice(cuts[i] - a, cuts[i + 1] - a), em: i === 1 });
  }
  return out;
}

/** one line of code, coloured when tokens are ready, with the changed part marked */
/** how far a line's code is indented, in characters (a tab is two, as the diff draws it) */
const indent = (text: string) => {
  const lead = /^[ \t]*/.exec(text)?.[0] ?? "";
  return Math.min(40, [...lead].reduce((n, c) => n + (c === "\t" ? 2 : 1), 0));
};

export function CodeText(props: { text: string; toks?: Tok[]; mark?: [number, number] }) {
  // runs: consecutive parts with the same em flag, so a marked change is one block
  const runs = () => {
    const out: { em: boolean; parts: Tok[] }[] = [];
    for (const t of withMark(props.toks ?? [{ text: props.text }], props.mark)) {
      const em = !!t.em;
      if (out.length && out[out.length - 1].em === em) out[out.length - 1].parts.push(t);
      else out.push({ em, parts: [t] });
    }
    return out;
  };
  const tok = (t: Tok) => (t.c ? <span class="tk" style={{ color: t.c, "--d": t.d ?? t.c }}>{t.text}</span> : t.text);
  return (
    <span class="dv-code" style={{ "--ind": `${indent(props.text)}ch` }}>
      <For each={runs()}>{(r) => (r.em ? <span class="em">{r.parts.map(tok)}</span> : r.parts.map(tok))}</For>
      <Show when={!props.text}>{" "}</Show>
    </span>
  );
}

/** For a run of removed lines followed by as many added ones: what changed inside each pair. */
function marks(lines: Hunk["lines"]): ([number, number] | undefined)[] {
  const out: ([number, number] | undefined)[] = lines.map(() => undefined);
  let i = 0;
  while (i < lines.length) {
    if (lines[i].kind !== "del") {
      i++;
      continue;
    }
    let d = i;
    while (d < lines.length && lines[d].kind === "del") d++;
    let a = d;
    while (a < lines.length && lines[a].kind === "add") a++;
    const n = Math.min(d - i, a - d);
    for (let k = 0; k < n; k++) {
      const x = lines[i + k].text;
      const y = lines[d + k].text;
      let p = 0;
      while (p < x.length && p < y.length && x[p] === y[p]) p++;
      let q = 0;
      while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
      // only when most of the line stayed: otherwise the whole line is the change
      if (p + q >= Math.min(x.length, y.length) * 0.4) {
        const trim = (t: string, a: number, b: number): [number, number] | undefined => {
          while (a < b && /\s/.test(t[a])) a++;
          while (b > a && /\s/.test(t[b - 1])) b--;
          return b > a ? [a, b] : undefined;
        };
        out[i + k] = trim(x, p, x.length - q);
        out[d + k] = trim(y, p, y.length - q);
      }
    }
    i = a;
  }
  return out;
}

function HunkView(props: { h: Hunk; toks?: (Tok[] | undefined)[]; annot?: (l: Line) => JSX.Element | undefined }) {
  const m = createMemo(() => marks(props.h.lines));
  return (
    <>
      <div class="dv-hunk">
        <span class="dv-hunk-at">{props.h.head.match(/^@@[^@]*@@/)?.[0] ?? props.h.head}</span>
        <Show when={props.h.where}><span class="dv-hunk-where">{props.h.where}</span></Show>
      </div>
      <For each={props.h.lines}>
        {(l, i) => (
          <>
          <div class={`dv-row ${l.kind}`}>
            <span class="dv-num">{l.old ?? ""}</span>
            <span class="dv-num">{l.new ?? ""}</span>
            <span class="dv-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
            <CodeText text={l.text} toks={props.toks?.[i()]} mark={m()[i()]} />
          </div>
          {props.annot?.(l)}
          </>
        )}
      </For>
    </>
  );
}

/** `annot`: something to show under a line (a PR's line comments); `remote`: the file isn't in a local folder */
/** `big`: opens the file in the full-size changes editor */
export function DiffCard(props: { f: DiffFile; root: string; open: boolean; toggle: () => void; ref?: (el: HTMLElement) => void; annot?: (l: Line) => JSX.Element | undefined; remote?: boolean; badge?: JSX.Element; big?: () => void }) {
  const [dir, name] = split(props.f.path);
  const big = () => props.f.add + props.f.del > 600;
  const [force, setForce] = createSignal(false);
  // colour the whole file's visible lines in one go, then hand each hunk its slice
  const [toks] = createResource(
    () => (props.open && !props.f.binary ? props.f : false),
    async (f) => {
      const all = (f as DiffFile).hunks.flatMap((h) => h.lines.map((l) => l.text));
      const t = await tokenize(all.join("\n"), langOf(f.path));
      if (!t) return null;
      let k = 0;
      return (f as DiffFile).hunks.map((h) => h.lines.map(() => t[k++]));
    },
  );
  return (
    <section class="dv-file" classList={{ open: props.open }} ref={props.ref}>
      <header class="dv-head" onClick={props.toggle}>
        <Icon name="chevron" size={12} class="chev" />
        <span class={`dv-st ${props.f.status}`} title={tr(STATUS[props.f.status])}>{props.f.status}</span>
        <span class="dv-path" title={props.f.path}>
          <span class="dv-dir">{dir}</span>
          <span class="dv-name">{name}</span>
        </span>
        <span class="dv-count">
          <Show when={props.f.add}><span class="add">+{props.f.add}</span></Show>
          <Show when={props.f.del}><span class="del">−{props.f.del}</span></Show>
        </span>
        <Show when={props.f.add + props.f.del}>
          <span class="dv-bar" aria-hidden="true">
            <Show when={props.f.add}><i class="a" style={{ flex: props.f.add }} /></Show>
            <Show when={props.f.del}><i class="d" style={{ flex: props.f.del }} /></Show>
          </span>
        </Show>
        {props.badge}
        <Show when={props.big}>
          {(open) => (
            <button
              class="dv-open"
              title={tr("크게 보기|diff")}
              aria-label={tr("크게 보기|diff")}
              onClick={(e) => {
                e.stopPropagation();
                open()();
              }}
            >
              <Icon name="zoom" size={13} />
            </button>
          )}
        </Show>
        <Show when={!props.remote}>
        <button
          class="dv-open"
          title={tr("파일 보기")}
          onClick={(e) => {
            e.stopPropagation();
            setPanelTab("files");
            setPanelFile({ path: props.f.path, mode: "file", n: Date.now() });
          }}
        >
          <Icon name="file" size={14} />
        </button>
        </Show>
      </header>
      <Fold open={props.open}>
        <div class="dv-body">
          <Show
            when={!props.f.binary}
            fallback={<div class="dv-note">{tr("바이너리 파일")}</div>}
          >
            <Show
              when={!big() || force()}
              fallback={
                <button class="dv-note link-btn" onClick={() => setForce(true)}>
                  {tr("{n}줄 변경 · 펼치기", { n: props.f.add + props.f.del })}
                </button>
              }
            >
              <For each={props.f.hunks}>{(h, i) => <HunkView h={h} toks={toks()?.[i()]} annot={props.annot} />}</For>
            </Show>
          </Show>
        </div>
      </Fold>
    </section>
  );
}

// ───────────── Changes pane ─────────────
export function ChangesPane(props: { t: Task; top?: any }) {
  const [data, refetch] = useChanges(() => props.t);
  const files = createMemo(() => parsePatch(data()?.patch ?? ""));
  const [closed, setClosed] = createSignal<Set<string>>(new Set());
  const isOpen = (p: string) => !closed().has(p);
  const toggle = (p: string) =>
    setClosed((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });
  const allOpen = () => files().every((f) => isOpen(f.path));
  const refs = new Map<string, HTMLElement>();
  // jump to a file asked for from elsewhere (a file chip in the thread)
  createEffect(
    on([panelFile, files], ([pf]) => {
      if (!pf || pf.mode !== "diff") return;
      const f = files().find((x) => x.path === pf.path || pf.path.endsWith(`/${x.path}`) || x.path.endsWith(pf.path));
      if (!f) return;
      setClosed((s) => {
        const n = new Set(s);
        n.delete(f.path);
        return n;
      });
      queueMicrotask(() => refs.get(f.path)?.scrollIntoView({ block: "start", behavior: "smooth" }));
    }),
  );
  const totals = () => (data()?.files ?? []).reduce((a, f) => [a[0] + f.add, a[1] + f.del], [0, 0]);
  return (
    <div class="review">
      {props.top}
      {/* thrown away: its folder is the person's own checkout now, whose changes aren't the task's */}
      <Show when={!discarded(props.t)}>
      <Show when={data()} fallback={<div class="pane-empty" />}>
        {(d) => (
          <Show when={d().isRepo} fallback={<WrittenFiles t={props.t} />}>
            <div class="rv-bar">
              <span class="rv-count">{tr("파일 {n}개", { n: d().files.length })}</span>
              <span class="add">+{totals()[0]}</span>
              <span class="del">−{totals()[1]}</span>
              <span class="spacer" />
              <Show when={files().length}>
                <button class="link-btn" onClick={() => setClosed(allOpen() ? new Set(files().map((f) => f.path)) : new Set())}>
                  {allOpen() ? tr("모두 접기") : tr("모두 펼치기")}
                </button>
              </Show>
              <button class="icon-btn sm" title={tr("새로고침")} onClick={() => refetch()}>
                <Icon name="refresh" size={14} />
              </button>
              <Show when={files().length}>
                <button class="btn sm ghost rv-big" title={withHint(tr("에디터로 열기"), "changesEditor")} onClick={() => openChanges(props.t.id)}>
                  <Icon name="zoom" size={13} />
                  {tr("에디터로 열기")}
                </button>
              </Show>
            </div>
            <Show when={files().length} fallback={<div class="pane-empty">{tr("변경 없음")}</div>}>
              <div class="rv-files">
                <For each={files()}>
                  {(f) => <DiffCard f={f} root={expand(props.t.cwd)} open={isOpen(f.path)} toggle={() => toggle(f.path)} ref={(el) => refs.set(f.path, el)} big={() => openChanges(props.t.id, f.path)} />}
                </For>
              </div>
            </Show>
          </Show>
        )}
      </Show>
      </Show>
    </div>
  );
}

/** Not a git folder: list what the job wrote, from its own tool calls. */
function WrittenFiles(props: { t: Task }) {
  const files = createMemo(() => {
    const m = new Map<string, { path: string; add: number; del: number; note?: boolean }>();
    for (const e of props.t.entries) {
      // notes (now.md, memory) aren't changes: counted the same as everywhere else
      if (e.kind !== "tool" || (e.tool.kind !== "edit" && e.tool.kind !== "write") || e.tool.ok === false || e.tool.note) continue;
      const path = (e.tool.detail ?? "").split("\n")[0];
      const cur = m.get(path) ?? { path, add: 0, del: 0, note: e.tool.note };
      cur.add += e.tool.add ?? 0;
      cur.del += e.tool.del ?? 0;
      m.set(path, cur);
    }
    return [...m.values()];
  });
  return (
    <Show when={files().length} fallback={<div class="pane-empty">{tr("변경 없음")}</div>}>
      <div class="rv-bar"><span class="rv-count">{tr("작업이 쓴 파일 {n}개", { n: files().length })}</span></div>
      <div class="written">
        <For each={files()}>
          {(f) => (
            <button class="written-row" onClick={() => previewFile(f.path)} title={f.path}>
              <Icon name={f.note ? "memory" : "file"} size={14} class="muted" />
              <span class="written-name">{f.path.split("/").pop()}</span>
              <span class="written-dir">{f.path.split("/").slice(-3, -1).join("/")}</span>
              <span class="spacer" />
              <span class="add">+{f.add}</span>
              <Show when={f.del}><span class="del">−{f.del}</span></Show>
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

/** Any file inside the app: pages and PDFs run, pictures show, markdown renders, code is highlighted. */
export function PreviewPane() {
  const path = () => previewPath();
  const full = () => expand(path() ?? "");
  const kind = () => {
    const p = full().toLowerCase();
    return /\.(html?|pdf)$/.test(p) ? "page" : IMG.test(p) ? "image" : /\.(mp4|mov|webm)$/.test(p) ? "video" : /\.(md|markdown)$/.test(p) ? "md" : "code";
  };
  const [md] = createResource(() => (kind() === "md" ? full() : false), (p) => fsRead(p).then((r) => r.text ?? "").catch(() => ""));
  const dir = () => full().split("/").slice(0, -1).join("/");
  const name = () => full().split("/").pop() ?? "";
  return (
    <Show when={path()} fallback={<div class="pane-empty">{tr("미리 볼 파일 없음")}</div>}>
      <div class="pv">
        <Show when={kind() !== "code"}>
          <div class="fv-head">
            <span class="dv-path" title={full()}><span class="dv-dir">{dir().replace(/^\/Users\/[^/]+/, "~")}/</span><span class="dv-name">{name()}</span></span>
            <span class="spacer" />
            <button class="btn sm ghost" title={tr("편집기에서 열기")} onClick={() => openInEditor(full())}><Icon name="external" size={14} />{tr("편집기")}</button>
            <button class="btn sm ghost" title={tr("Finder에서 보기")} onClick={() => revealPath(full())}><Icon name="folder" size={14} />Finder</button>
          </div>
        </Show>
        <div class="pv-body">
          <Switch>
            <Match when={kind() === "page"}>
              <Show when={/\.pdf$/i.test(full())} fallback={<iframe class="aframe" sandbox="allow-scripts allow-popups allow-forms" src={pageSrc(full())} />}>
                <iframe class="aframe" src={pdfSrc(full())} title={name()} />
              </Show>
            </Match>
            <Match when={kind() === "image"}><div class="fv-img"><img src={fileSrc(full())} alt={name()} /></div></Match>
            <Match when={kind() === "video"}><video class="pv-video" src={fileSrc(full())} controls /></Match>
            <Match when={kind() === "md"}><div class="pv-md"><Markdown text={md() ?? ""} /></div></Match>
            <Match when={kind() === "code"}><Viewer root={dir()} path={name()} startDiff={false} back={() => setPreviewPath(null)} /></Match>
          </Switch>
        </div>
      </div>
    </Show>
  );
}

// ───────────── Files pane ─────────────
type Node = { name: string; path: string; dir: boolean; kids: Node[] };
function tree(paths: string[]): Node {
  const root: Node = { name: "", path: "", dir: true, kids: [] };
  for (const p of paths) {
    let cur = root;
    const parts = p.split("/");
    parts.forEach((part, i) => {
      const leaf = i === parts.length - 1;
      let k = cur.kids.find((x) => x.name === part && x.dir === !leaf);
      if (!k) {
        k = { name: part, path: parts.slice(0, i + 1).join("/"), dir: !leaf, kids: [] };
        cur.kids.push(k);
      }
      cur = k;
    });
  }
  const sort = (n: Node) => {
    n.kids.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    n.kids.forEach(sort);
  };
  sort(root);
  return root;
}

const IMG = /\.(png|jpe?g|gif|webp|svg|avif|ico)$/i;
const Editor = lazy(() => import("./Editor").then((m) => ({ default: m.Editor })));

function Viewer(props: { root: string; path: string; changed?: DiffFile; startDiff: boolean; back: () => void; line?: number }) {
  const full = () => `${props.root}/${props.path}`;
  const [mode, setMode] = createSignal<"file" | "diff" | "edit">(props.startDiff && props.changed ? "diff" : "file");
  const [dirty, setDirty] = createSignal(false);
  let editor: { save: () => void } | undefined;
  const [text, { refetch }] = createResource(
    () => (IMG.test(props.path) ? null : full()),
    async (p) => {
      try {
        return await fsRead(p);
      } catch (e) {
        return { text: null, size: 0, binary: false, error: String(e) };
      }
    },
  );
  const lines = () => (text()?.text ?? "").replace(/\n$/, "").split("\n");
  const [fileToks] = createResource(
    () => (text()?.text ? [text()!.text!.replace(/\n$/, ""), props.path] as const : false),
    ([code, path]) => tokenize(code, langOf(path)),
  );
  const [dir, name] = split(props.path);
  /** what the file looked like on disk when opened: a save over someone else's change asks first */
  let seen = 0;
  createEffect(() => {
    const m = (text() as { modified?: number } | undefined)?.modified;
    if (m && mode() !== "edit") seen = m;
  });
  const write = async (body: string, force = false): Promise<boolean> => {
    try {
      seen = await fsWrite(full(), body, force ? undefined : seen);
      toast(tr("저장했어요"));
      return true;
    } catch (e) {
      if (String(e).includes("CHANGED")) {
        toast(tr("그사이 파일이 바뀌었어요"), "bad", { label: tr("덮어쓰기"), run: () => void write(body, true).then((ok) => ok && setDirty(false)) });
      } else toast(tr("저장하지 못했어요 · {err}", { err: String(e) }), "bad");
      return false;
    }
  };
  const close = () => {
    setDirty(false);
    setMode("file");
    void refetch();
  };
  const leave = () => (dirty() ? toast(tr("저장하지 않은 변경이 있어요"), "info", { label: tr("버리고 닫기"), run: close }) : close());
  return (
    <div class="fv">
      <div class="fv-head">
        <button class="icon-btn sm" title={tr("목록")} onClick={props.back}><Icon name="back" size={14} /></button>
        <span class="dv-path" title={props.path}>
          <span class="dv-dir">{dir}</span>
          <span class="dv-name">{name}</span>
        </span>
        <Show when={dirty()}><i class="fv-dirty" title={tr("저장 안 됨")} /></Show>
        <span class="spacer" />
        <Show
          when={mode() === "edit"}
          fallback={
            <>
              <Show when={props.changed}>
                <div class="seg sm">
                  <button classList={{ on: mode() === "file" }} onClick={() => setMode("file")}>{tr("파일")}</button>
                  <button classList={{ on: mode() === "diff" }} onClick={() => setMode("diff")}>{tr("변경|diff")}</button>
                </div>
              </Show>
              <Show when={text()?.text != null}>
                <button class="icon-btn sm" title={tr("편집")} onClick={() => setMode("edit")}><Icon name="pencil" size={14} /></button>
              </Show>
            </>
          }
        >
          <button class="btn sm primary" disabled={!dirty()} title="⌘S" onClick={() => editor?.save()}>{tr("저장")}</button>
          <button class="btn sm ghost" onClick={leave}>{tr("닫기")}</button>
        </Show>
        <button class="icon-btn sm" title={tr("편집기에서 열기")} onClick={() => openInEditor(full())}><Icon name="external" size={14} /></button>
        <button class="icon-btn sm" title={tr("Finder에서 보기")} onClick={() => revealPath(full())}><Icon name="folder" size={14} /></button>
      </div>
      <div class="fv-body" classList={{ editing: mode() === "edit" }}>
        <Show when={mode() !== "edit"} fallback={
          <Suspense fallback={<div class="pane-empty" />}>
            <Editor path={props.path} text={text()?.text ?? ""} onSave={(b) => write(b)} onDirty={setDirty} ref={(api) => (editor = api)} />
          </Suspense>
        }>
        <Show
          when={mode() === "file"}
          fallback={<DiffCard f={props.changed!} root={props.root} open toggle={() => setMode("file")} />}
        >
          <Show when={!IMG.test(props.path)} fallback={<div class="fv-img"><img src={fileSrc(full())} alt={name} /></div>}>
            <Show when={text()} fallback={<div class="pane-empty" />}>
              {(t) => (
                <Show
                  when={t().text !== null}
                  fallback={<div class="pane-empty">{(t() as any).error ?? (t().binary ? tr("바이너리 파일") : tr("파일이 너무 커요"))}</div>}
                >
                  <div class="code" ref={(el) => props.line && queueMicrotask(() => el.querySelector(".code-row.hit")?.scrollIntoView({ block: "center" }))}>
                    <For each={lines()}>
                      {(l, i) => (
                        <div class="code-row" classList={{ hit: props.line === i() + 1 }}>
                          <span class="dv-num">{i() + 1}</span>
                          <CodeText text={l} toks={fileToks()?.[i()]} />
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              )}
            </Show>
          </Show>
        </Show>
        </Show>
      </div>
    </div>
  );
}

/** the found text with each match marked */
function mark(text: string, needle: string): JSX.Element {
  const low = text.toLowerCase();
  const n = needle.toLowerCase();
  const out: JSX.Element[] = [];
  let at = 0;
  for (let i = low.indexOf(n); i >= 0 && n; i = low.indexOf(n, i + n.length)) {
    out.push(text.slice(at, i), <mark>{text.slice(i, i + n.length)}</mark>);
    at = i + n.length;
  }
  out.push(text.slice(at));
  return <>{out}</>;
}

export function FilesPane(props: { t: Task }) {
  const root = () => expand(props.t.cwd);
  const [list, { refetch }] = createResource(root, (r) => fsFiles(r));
  const [changes] = useChanges(() => props.t);
  const changed = createMemo(() => new Map(parsePatch(changes()?.patch ?? "").map((f) => [f.path, f])));
  const [q, setQ] = createSignal("");
  const [open, setOpen] = createSignal<Set<string>>(new Set());
  const [sel, setSel] = createSignal<{ path: string; diff: boolean; line?: number } | null>(null);
  /** search file names, or what's inside the files (find in files) */
  const [inside, setInside] = createSignal(false);
  const [needle, setNeedle] = createSignal("");
  let wait: ReturnType<typeof setTimeout> | undefined;
  const [found] = createResource(
    () => (inside() && needle().trim().length >= 2 ? [root(), needle().trim()] as const : false),
    ([r, n]) => fsGrep(r, n),
  );
  const foundByFile = createMemo(() => {
    const m = new Map<string, { line: number; text: string }[]>();
    for (const h of found() ?? []) m.set(h.path, [...(m.get(h.path) ?? []), h]);
    return [...m];
  });
  createEffect(
    on(panelFile, (pf) => {
      if (!pf || pf.mode !== "file") return;
      const all = list() ?? [];
      const path = all.find((p) => p === pf.path || pf.path.endsWith(`/${p}`)) ?? pf.path.replace(`${root()}/`, "");
      setSel({ path, diff: false });
    }),
  );
  const t = createMemo(() => tree(list() ?? []));
  const hits = createMemo(() => {
    const s = q().trim().toLowerCase();
    if (!s) return [];
    return (list() ?? []).filter((p) => p.toLowerCase().includes(s)).slice(0, 300);
  });
  // a changed file's folders count as changed too
  const touched = createMemo(() => {
    const set = new Set<string>();
    for (const p of changed().keys()) {
      const parts = p.split("/");
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join("/"));
    }
    return set;
  });
  const toggle = (p: string) =>
    setOpen((s) => {
      const n = new Set(s);
      n.has(p) ? n.delete(p) : n.add(p);
      return n;
    });

  const Row = (rp: { n: Node; depth: number }) => (
    <>
      <button
        class="ft-row"
        classList={{ dir: rp.n.dir, touched: touched().has(rp.n.path) }}
        style={{ "padding-left": `calc(var(--s-8) + ${rp.depth} * var(--s-14))` }}
        onClick={() => (rp.n.dir ? toggle(rp.n.path) : setSel({ path: rp.n.path, diff: false }))}
        title={rp.n.path}
      >
        <Show when={rp.n.dir} fallback={<Icon name="file" size={14} class="ft-ic" />}>
          <Icon name="chevron" size={12} class={`ft-ic chev ${open().has(rp.n.path) ? "on" : ""}`} />
        </Show>
        <span class="ft-name">{rp.n.name}</span>
        <Show when={changed().get(rp.n.path)}>{(f) => <span class={`ft-st ${f().status}`}>{f().status}</span>}</Show>
      </button>
      <Show when={rp.n.dir && open().has(rp.n.path)}>
        <For each={rp.n.kids}>{(k) => <Row n={k} depth={rp.depth + 1} />}</For>
      </Show>
    </>
  );

  return (
    <div class="files">
      <Show
        when={sel()}
        keyed
        fallback={
          <>
            <div class="ft-search">
              <Icon name="search" size={14} />
              <input
                placeholder={inside() ? tr("내용 검색") : tr("파일 검색")}
                value={inside() ? needle() : q()}
                onInput={(e) => {
                  const v = e.currentTarget.value;
                  if (!inside()) return setQ(v);
                  clearTimeout(wait);
                  wait = setTimeout(() => setNeedle(v), 250);
                }}
                onKeyDown={(e) => inside() && e.key === "Enter" && (clearTimeout(wait), setNeedle(e.currentTarget.value))}
              />
              <div class="seg sm ft-mode">
                <button classList={{ on: !inside() }} onClick={() => setInside(false)}>{tr("이름")}</button>
                <button classList={{ on: inside() }} onClick={() => setInside(true)}>{tr("내용")}</button>
              </div>
              <button class="icon-btn sm" title={tr("새로고침")} onClick={() => refetch()}><Icon name="refresh" size={14} /></button>
            </div>
            <Show when={inside()}>
              <div class="ft grep">
                <Show when={needle().trim().length >= 2} fallback={<div class="pane-empty">{tr("두 글자 이상")}</div>}>
                  <Show when={!found.loading} fallback={<div class="pane-empty" />}>
                    <Show when={foundByFile().length} fallback={<div class="pane-empty">{tr("결과 없음")}</div>}>
                      <div class="grep-count">{(found() ?? []).length >= 500 ? tr("500곳 이상") : tr("{n}곳", { n: (found() ?? []).length })} · {tr("파일 {n}개", { n: foundByFile().length })}</div>
                      <For each={foundByFile()}>
                        {([path, hits]) => {
                          const [dir, name] = split(path);
                          return (
                            <div class="grep-file">
                              <div class="grep-head" title={path}>
                                <Icon name="file" size={14} class="ft-ic" />
                                <span class="ft-name">{name}</span>
                                <span class="ft-dir">{dir}</span>
                                <span class="grep-n">{hits.length}</span>
                              </div>
                              <For each={hits}>
                                {(h) => (
                                  <button class="grep-row" onClick={() => setSel({ path, diff: false, line: h.line })}>
                                    <span class="dv-num">{h.line}</span>
                                    <span class="grep-text">{mark(h.text, needle().trim())}</span>
                                  </button>
                                )}
                              </For>
                            </div>
                          );
                        }}
                      </For>
                    </Show>
                  </Show>
                </Show>
              </div>
            </Show>
            <Show when={!inside() && list()} fallback={<Show when={!inside()}><div class="pane-empty" /></Show>}>
              <div class="ft">
                <Show
                  when={q().trim()}
                  fallback={
                    <Show when={t().kids.length} fallback={<div class="pane-empty">{tr("파일 없음")}</div>}>
                      <For each={t().kids}>{(k) => <Row n={k} depth={0} />}</For>
                    </Show>
                  }
                >
                  <Show when={hits().length} fallback={<div class="pane-empty">{tr("결과 없음")}</div>}>
                    <For each={hits()}>
                      {(p) => {
                        const [dir, name] = split(p);
                        return (
                          <button class="ft-row" onClick={() => setSel({ path: p, diff: false })} title={p}>
                            <Icon name="file" size={14} class="ft-ic" />
                            <span class="ft-name">{name}</span>
                            <span class="ft-dir">{dir}</span>
                            <Show when={changed().get(p)}>{(f) => <span class={`ft-st ${f().status}`}>{f().status}</span>}</Show>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </Show>
              </div>
            </Show>
          </>
        }
      >
        {(s) => <Viewer root={root()} path={s.path} changed={changed().get(s.path)} startDiff={s.diff} line={s.line} back={() => setSel(null)} />}
      </Show>
    </div>
  );
}

export type { GitChanges };

// ───────────── throwing a task's changes away ─────────────
/** 버리기 asks once, with the same words everywhere (review bar, changes tab, ⋯ menu, /discard). */
export const askDiscard = (t: Pick<Task, "id" | "title">) => confirmDiscard(t.id);

/** A discarded task's mark: the shared glyph's muted trash (Sidebar.tsx). */
export function DiscardGlyph(props: { class?: string }) {
  return <GlyphMark g="discarded" class={props.class} />;
}
