// A job's changes in a full-size editor, like VS Code's source control diff: the
// changed files by folder on the left, the selected file's diff on the right in
// CodeMirror (side by side, inline, or the applied file whole). A view of its own,
// so it can sit in a pane beside the job's chat.
import { createEffect, createMemo, createResource, createSignal, For, lazy, on, onCleanup, onMount, Show, Suspense } from "solid-js";
import { taskById } from "../state/store";
import type { Task } from "../state/types";
import { openTask, setPaneView, shownIn, toast } from "../state/ui";
import { usePane, usePaneFocused, useView } from "../state/panes";
import { discarded } from "../state/progress";
import { expand } from "../engine/rpc";
import { gitFileAt, gitMerged, openInEditor, revealPath, type FileAt } from "../lib/native";
import { ignoredKey, withHint } from "../lib/shortcuts";
import { useChanges } from "../ui/Review";
import { capText, changedFiles, fileOrder, groupFiles, MAX_LINES, splitPath, stepFile, type ChangedFile } from "../ui/diffModel";
import type { DiffApi, DiffMode } from "../ui/DiffEditor";
import { Icon } from "../ui/Icon";
import { SidebarToggle } from "./Sidebar";
import { openInSplit, PaneControls } from "./PaneControls";
import { t } from "../i18n";

const DiffEditor = lazy(() => import("../ui/DiffEditor").then((m) => ({ default: m.DiffEditor })));

const STATUS: Record<ChangedFile["status"], string> = { A: "새 파일", M: "수정|status", D: "삭제|status", R: "이름 바뀜" };

// how the diff shows is the viewer's own: kept in this browser only
const PREFS = "ondra.changes";
function readPrefs(): { mode?: DiffMode; wrap?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(PREFS) ?? "{}") ?? {};
  } catch {
    return {};
  }
}
function keepPrefs(p: { mode: DiffMode; wrap: boolean }) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}

export function ChangesView() {
  const v = useView();
  const task = () => {
    const x = v();
    return x.name === "changes" ? taskById(x.id) : undefined;
  };
  return (
    <Show when={task()} keyed fallback={<div class="view cg-view"><div class="pane-empty">{t("작업이 없어요")}</div></div>}>
      {(x) => <Body t={x} />}
    </Show>
  );
}

/** Where both sides of a file are read: the job's folder against where it started, or the merge it went into. */
interface Source {
  cwd: string;
  /** the folder the paths are from (open in an editor, Finder) */
  root: string;
  from: string | null;
  to: string | null;
  files: ChangedFile[];
}
const MISSING: FileAt = { text: null, size: 0, binary: false, missing: true, cut: false };
type Sides = { path: string; binary: true } | { path: string; binary: false; a: string; b: string; cut: boolean; unread: boolean };
const readable = (s: Sides) => (s.binary ? undefined : s);

function Body(props: { t: Task }) {
  const pane = usePane();
  const focused = usePaneFocused();
  const v = useView();
  const w = () => props.t.worktree;
  const gone = () => discarded(props.t);
  const merged = () => w()?.state === "merged";

  // still working (or never had a worktree): its folder against where it started, refreshed as it edits
  const [live, refetch] = useChanges(() => props.t, () => !gone() && !merged());
  // merged: what the merge brought in, from the repo
  const [mergedData] = createResource(
    () => (merged() && w() ? ([w()!.repo, w()!.branch, w()!.into, w()!.base] as const) : false),
    ([repo, branch, into, base]) => gitMerged(repo, branch, into, base).catch(() => null),
  );
  const source = createMemo<Source | null | undefined>(() => {
    if (gone()) return null;
    if (merged()) {
      const m = mergedData();
      if (m === undefined) return undefined;
      return m && { cwd: w()!.repo, root: w()!.repo, from: m.from, to: m.to, files: changedFiles(m.changes.files, m.changes.patch) };
    }
    const d = live();
    if (!d) return undefined;
    if (!d.isRepo) return null;
    const open = w()?.state === "open";
    return { cwd: expand(props.t.cwd), root: open ? expand(w()!.path) : expand(props.t.cwd), from: open ? w()!.base : "HEAD", to: null, files: changedFiles(d.files, d.patch) };
  });
  const why = () =>
    gone() ? t("버린 작업이라 볼 변경 사항이 없어요") : merged() ? t("병합된 변경을 찾지 못했어요") : live()?.isRepo === false ? t("git 저장소가 아니라 비교할 수 없어요") : "";

  // the list
  const [q, setQ] = createSignal("");
  const files = () => source()?.files ?? [];
  const groups = createMemo(() => groupFiles(files(), q()));
  const order = createMemo(() => fileOrder(groups()));
  const totals = () => files().reduce((a, f) => [a[0] + f.add, a[1] + f.del], [0, 0]);

  // the file shown: the view's own (kept with the pane), else the first one
  const viewPath = () => {
    const x = v();
    return x.name === "changes" ? x.path : undefined;
  };
  const [sel, setSel] = createSignal<string | undefined>(viewPath());
  createEffect(on(viewPath, (p) => p && setSel(p), { defer: true }));
  const selected = createMemo(() => files().find((f) => f.path === sel() || (sel() && sel()!.endsWith(`/${f.path}`))) ?? order()[0]);
  const [start, setStart] = createSignal<"first" | "last">("first");
  let listEl: HTMLDivElement | undefined;
  let api: DiffApi | undefined;
  function choose(f: ChangedFile | undefined, from: "first" | "last" = "first") {
    if (!f) return;
    setStart(from);
    setSel(f.path);
    if (pane) setPaneView(pane.id, { name: "changes", id: props.t.id, path: f.path });
    queueMicrotask(reveal);
  }
  /** the chosen row in sight, scrolling the list only (scrollIntoView would also move the view around it) */
  function reveal() {
    const el = listEl?.querySelector<HTMLElement>(".cg-file.on");
    if (!el || !listEl) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < listEl.scrollTop + 8) listEl.scrollTop = top - 32;
    else if (bottom > listEl.scrollTop + listEl.clientHeight - 8) listEl.scrollTop = bottom - listEl.clientHeight + 8;
  }
  const step = (dir: 1 | -1, from?: "first" | "last") => choose(stepFile(order(), selected()?.path, dir), from ?? (dir > 0 ? "first" : "last"));

  // how it shows
  const prefs = readPrefs();
  const [mode, setMode] = createSignal<DiffMode>(prefs.mode ?? "split");
  const [wrap, setWrap] = createSignal(prefs.wrap ?? false);
  createEffect(() => keepPrefs({ mode: mode(), wrap: wrap() }));
  // a narrow pane (beside the chat): the list folds away behind a button, the diff gets the room
  let root!: HTMLDivElement;
  const [narrow, setNarrow] = createSignal(false);
  const [listOpen, setListOpen] = createSignal(false);
  // the list slides only when asked for: a pane growing or shrinking past the line just moves it
  const [snap, setSnap] = createSignal(true);
  let unsnap: ReturnType<typeof setTimeout> | undefined;
  const measure = () => {
    const n = root.clientWidth < 720;
    if (n === narrow()) return;
    setSnap(true);
    setNarrow(n);
    clearTimeout(unsnap);
    unsnap = setTimeout(() => setSnap(false), 60);
  };
  onMount(() => {
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    onCleanup(() => clearTimeout(unsnap));
    onCleanup(() => ro.disconnect());
  });
  // the list takes the keys when it first shows (↑↓ right away), unless something else has them
  const takeKeys = (el: HTMLDivElement) => {
    listEl = el;
    queueMicrotask(() => {
      const a = document.activeElement;
      if (focused() && (!a || a === document.body || !a.closest("input, textarea, [contenteditable], .palette, [role=dialog]"))) el.focus({ preventScroll: true });
    });
  };
  // side by side needs the room: a narrow pane shows it inline (and doesn't offer it)
  const shownMode = () => (narrow() && mode() === "split" ? "inline" : mode());
  /** the job's chat is already in another pane */
  const chatBeside = () => !!shownIn({ name: "task", id: props.t.id }, pane?.id ?? "");

  // both sides of the selected file, read again whenever the changes are
  const [sides] = createResource(
    () => {
      const f = selected();
      const s = source();
      return f && s ? { f, s } : false;
    },
    async ({ f, s }): Promise<Sides> => {
      if (f.binary) return { path: f.path, binary: true };
      const [a, b] = await Promise.all([
        f.status === "A" ? MISSING : gitFileAt(s.cwd, s.from, f.old ?? f.path).catch(() => MISSING),
        f.status === "D" ? MISSING : gitFileAt(s.cwd, s.to, f.path).catch(() => MISSING),
      ]);
      if (a.binary || b.binary) return { path: f.path, binary: true };
      const ca = capText(a.text ?? "", MAX_LINES, a.cut);
      const cb = capText(b.text ?? "", MAX_LINES, b.cut);
      return { path: f.path, binary: false, a: ca.text, b: cb.text, cut: ca.cut || cb.cut, unread: a.missing && b.missing };
    },
  );
  // the last file read stays up while the next one is read (the editor isn't torn down between files)
  const shown = () => sides.latest;
  const [count, setCount] = createSignal({ cur: -1, total: 0 });
  /** the editor is up (not a binary, unreadable or deleted file's note) */
  const hasDiff = () => {
    const s = shown();
    return !!s && !s.binary && !s.unread && !(shownMode() === "result" && selected()?.status === "D");
  };
  // the editor went away under the keys (F7 into a binary file): they carry on from the list
  createEffect(on(hasDiff, (up) => !up && (document.activeElement === document.body || !document.activeElement) && listEl?.focus({ preventScroll: true }), { defer: true }));

  const full = () => (selected() && source() ? `${source()!.root}/${selected()!.path}` : "");
  const copy = async () => {
    const f = selected();
    if (!f) return;
    try {
      await navigator.clipboard.writeText(f.path);
      toast(t("경로를 복사했어요"));
    } catch {
      toast(t("복사하지 못했어요"), "bad");
    }
  };

  // keys: ↑↓ in the list, ↵ into the diff, ⎋ back to the list, F7 / ⇧F7 through the changes
  function listKeys(e: KeyboardEvent) {
    if (ignoredKey(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      step(e.key === "ArrowDown" ? 1 : -1, "first");
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (narrow()) setListOpen(false);
      api?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      choose(e.key === "Home" ? order()[0] : order()[order().length - 1]);
    }
  }
  function viewKeys(e: KeyboardEvent) {
    if (ignoredKey(e) || (e.target as Element).closest?.(".cm-editor")) return;
    if (e.key === "F7") {
      e.preventDefault();
      if (!hasDiff()) step(e.shiftKey ? -1 : 1);
      else e.shiftKey ? api?.prev() : api?.next();
    } else if (e.key === "Escape" && narrow() && listOpen()) {
      e.preventDefault();
      setListOpen(false);
    }
  }
  const backToList = () => {
    if (narrow()) setListOpen(true);
    listEl?.focus({ preventScroll: true });
  };

  const where = () => (merged() ? (w()?.into ? t("{into}에 병합됨", { into: w()!.into! }) : t("병합됨")) : "");

  return (
    <div class="view cg-view" ref={root} classList={{ narrow: narrow(), "list-open": listOpen(), snap: snap() }} onKeyDown={viewKeys}>
      <header class="head cg-head" data-tauri-drag-region>
        <SidebarToggle />
        <button class="icon-btn sm" title={withHint(t("작업 대화로"), "changesEditor")} aria-label={t("작업 대화로")} onClick={() => openTask(props.t.id)}>
          <Icon name="back" size={14} />
        </button>
        <h1 class="head-title">{t("변경 사항")}</h1>
        <span class="cg-job" title={props.t.title}>{props.t.title}</span>
        <Show when={files().length}>
          <span class="cg-total">
            <span>{t("파일 {n}개", { n: files().length })}</span>
            <span class="add">+{totals()[0]}</span>
            <span class="del">−{totals()[1]}</span>
          </span>
        </Show>
        <Show when={where()}><span class="cg-pill">{where()}</span></Show>
        <span class="spacer" data-tauri-drag-region />
        <div class="seg sm cg-mode" role="group" aria-label={t("보기 방식")}>
          <Show when={!narrow()}>
            <button classList={{ on: shownMode() === "split" }} aria-pressed={shownMode() === "split"} onClick={() => setMode("split")}>{t("나란히")}</button>
          </Show>
          <button classList={{ on: shownMode() === "inline" }} aria-pressed={shownMode() === "inline"} onClick={() => setMode("inline")}>{t("인라인")}</button>
          <button classList={{ on: shownMode() === "result" }} aria-pressed={shownMode() === "result"} title={t("변경이 적용된 파일 전체")} onClick={() => setMode("result")}>{t("적용된 결과")}</button>
        </div>
        <button class="icon-btn sm" classList={{ on: wrap() }} aria-pressed={wrap()} title={t("줄 바꿈")} aria-label={t("줄 바꿈")} onClick={() => setWrap(!wrap())}>
          <Icon name="wrap" size={14} />
        </button>
        <Show when={!merged() && !gone()}>
          <button class="icon-btn sm" title={t("새로고침")} aria-label={t("새로고침")} onClick={() => refetch()}>
            <Icon name="refresh" size={14} />
          </button>
        </Show>
        <Show when={!chatBeside()}>
          <button class="icon-btn sm" title={t("옆에 작업 대화 열기")} aria-label={t("옆에 작업 대화 열기")} onClick={() => openInSplit(props.t.id, "right")}>
            <Icon name="message" size={14} />
          </button>
        </Show>
        <PaneControls />
      </header>
      <Show
        when={source()}
        fallback={<div class="pane-empty cg-empty">{source() === null ? why() : ""}</div>}
      >
        <Show when={files().length} fallback={<div class="pane-empty cg-empty">{t("변경 없음")}</div>}>
          <div class="cg-body">
            <aside class="cg-side">
              <div class="ft-search cg-filter">
                <Icon name="search" size={14} />
                <input
                  placeholder={t("파일 거르기")}
                  aria-label={t("파일 거르기")}
                  value={q()}
                  onInput={(e) => setQ(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.isComposing) return;
                    if (e.key === "ArrowDown" || e.key === "Enter") {
                      e.preventDefault();
                      if (e.key === "Enter" || !order().some((f) => f.path === selected()?.path)) choose(order()[0]);
                      listEl?.focus();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      if (q()) setQ("");
                      else listEl?.focus();
                    }
                  }}
                />
              </div>
              <div class="cg-list" ref={takeKeys} tabIndex={0} role="listbox" aria-label={t("바뀐 파일")} onKeyDown={listKeys}>
                <For each={groups()} fallback={<div class="cg-none">{t("결과 없음")}</div>}>
                  {(g) => (
                    <div class="cg-group">
                      <div class="cg-dir" title={g.dir || t("최상위 폴더")}>
                        <Icon name="folder" size={13} />
                        <span>{g.dir || t("최상위 폴더")}</span>
                      </div>
                      <For each={g.files}>
                        {(f) => (
                          <button
                            class="cg-file"
                            classList={{ on: f.path === selected()?.path }}
                            role="option"
                            aria-selected={f.path === selected()?.path}
                            tabIndex={-1}
                            title={f.old ? `${f.old} → ${f.path}` : f.path}
                            onClick={() => (choose(f), narrow() && setListOpen(false))}
                          >
                            <span class="cg-name" classList={{ gone: f.status === "D" }}>{splitPath(f.path)[1]}</span>
                            <span class="cg-n">
                              <Show when={f.add}><span class="add">+{f.add}</span></Show>
                              <Show when={f.del}><span class="del">−{f.del}</span></Show>
                            </span>
                            <span class={`cg-st ${f.status}`} title={t(STATUS[f.status])}>{f.status}</span>
                          </button>
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
            </aside>
            <section class="cg-main">
              <Show when={selected()}>
                {(f) => (
                  <div class="cg-bar">
                    <Show when={narrow()}>
                      <button class="icon-btn sm" classList={{ on: listOpen() }} aria-expanded={listOpen()} title={t("파일 목록")} aria-label={t("파일 목록")} onClick={() => setListOpen(!listOpen())}>
                        <Icon name="list" size={14} />
                      </button>
                    </Show>
                    <span class={`cg-st ${f().status}`} title={t(STATUS[f().status])}>{f().status}</span>
                    <span class="dv-path cg-path" title={f().path}>
                      <Show when={splitPath(f().path)[0]}><span class="dv-dir">{splitPath(f().path)[0]}/</span></Show>
                      <span class="dv-name">{splitPath(f().path)[1]}</span>
                    </span>
                    <Show when={f().old}><span class="cg-old" title={f().old}>{t("{old}에서", { old: f().old! })}</span></Show>
                    <span class="cg-n">
                      <Show when={f().add}><span class="add">+{f().add}</span></Show>
                      <Show when={f().del}><span class="del">−{f().del}</span></Show>
                    </span>
                    <span class="spacer" />
                    <Show when={shown() && !shown()!.binary}>
                      <span class="cg-nav">
                        <button class="icon-btn sm" title={`${t("이전 변경")} (⇧F7)`} aria-label={t("이전 변경")} onClick={() => api?.prev()}>
                          <Icon name="up" size={14} />
                        </button>
                        <span class="cg-at">{count().total ? (count().cur >= 0 ? `${count().cur + 1} / ${count().total}` : t("변경 {n}곳", { n: count().total })) : "0"}</span>
                        <button class="icon-btn sm" title={`${t("다음 변경")} (F7)`} aria-label={t("다음 변경")} onClick={() => api?.next()}>
                          <Icon name="down" size={14} />
                        </button>
                      </span>
                    </Show>
                    <span class="cg-nav">
                      <button class="icon-btn sm" title={t("이전 파일")} aria-label={t("이전 파일")} disabled={order()[0]?.path === f().path} onClick={() => step(-1, "first")}>
                        <Icon name="back" size={14} />
                      </button>
                      <button class="icon-btn sm" title={t("다음 파일")} aria-label={t("다음 파일")} disabled={order()[order().length - 1]?.path === f().path} onClick={() => step(1, "first")}>
                        <Icon name="arrow" size={14} />
                      </button>
                    </span>
                    <button class="icon-btn sm" title={t("경로 복사")} aria-label={t("경로 복사")} onClick={copy}>
                      <Icon name="copy" size={14} />
                    </button>
                    <button class="icon-btn sm" title={t("편집기에서 열기")} aria-label={t("편집기에서 열기")} disabled={f().status === "D"} onClick={() => openInEditor(full())}>
                      <Icon name="external" size={14} />
                    </button>
                    <button class="icon-btn sm" title={t("Finder에서 보기")} aria-label={t("Finder에서 보기")} disabled={f().status === "D"} onClick={() => revealPath(full())}>
                      <Icon name="folder" size={14} />
                    </button>
                  </div>
                )}
              </Show>
              <Show when={shown()} fallback={<div class="pane-empty" />}>
                {(s) => (
                  <Show when={readable(s())} fallback={<div class="pane-empty cg-note">{t("바이너리 파일")}</div>}>
                    {(d) => (
                      <>
                        <Show when={d().cut}><div class="cg-cut">{t("파일이 커서 일부만 보여요")}</div></Show>
                        <Show
                          when={!(shownMode() === "result" && selected()?.status === "D") && !d().unread}
                          fallback={<div class="pane-empty cg-note">{d().unread ? t("내용을 읽지 못했어요") : t("삭제된 파일이에요")}</div>}
                        >
                          <div class="cg-editor">
                            <Suspense fallback={<div class="pane-empty" />}>
                              <DiffEditor
                                path={d().path}
                                a={d().a}
                                b={d().b}
                                mode={shownMode()}
                                wrap={wrap()}
                                start={start()}
                                onCount={(cur, total) => setCount({ cur, total })}
                                onEdge={(dir) => step(dir)}
                                onEscape={backToList}
                                ref={(x) => (api = x)}
                              />
                            </Suspense>
                          </div>
                        </Show>
                      </>
                    )}
                  </Show>
                )}
              </Show>
            </section>
          </div>
        </Show>
      </Show>
    </div>
  );
}
