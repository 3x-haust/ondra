// A job's changes laid out as VS Code's source control and diff editor: the Source Control view on
// the left (the changed files as a tree with compact folders, or a list), the editor group on the
// right (preview and kept tabs, breadcrumbs, the editor's actions and its … menu), the diff in
// CodeMirror, and a status bar. A view of its own, so it can sit in a pane beside the job's chat.
import { createEffect, createMemo, createResource, createSignal, For, lazy, on, onCleanup, onMount, Show, Suspense, type JSX } from "solid-js";
import { taskById } from "../state/store";
import type { Task } from "../state/types";
import { openTask, setPaneView, shownIn, toast } from "../state/ui";
import { usePane, usePaneFocused, useView } from "../state/panes";
import { discarded } from "../state/progress";
import { expand } from "../engine/rpc";
import type { FileAt } from "../lib/native";
import { editorOn, fileAtRev, mergedIn, revealOn } from "../engine/far";
import { ignoredKey, matchesShortcut, withHint } from "../lib/shortcuts";
import { useChanges } from "../ui/Review";
import {
  buildTree, capText, changedFiles, closeTab, cycleTab, fileOrder, folderKeys, foldersOf, listRows, MAX_LINES, openTab, pinTab, splitPath, stepAcross, stepFile,
  tabKey, treeRows, type ChangedFile, type FileStatus, type Row, type Tab,
} from "../ui/diffModel";
import type { DiffApi, DiffMode } from "../ui/DiffEditor";
import { Icon } from "../ui/Icon";
import { openMenuAt, type MenuEntry } from "../ui/taskMenu";
import { SidebarToggle } from "./Sidebar";
import { claimClose, closedHere, openInSplit, PaneControls } from "./PaneControls";
import { t } from "../i18n";

const DiffEditor = lazy(() => import("../ui/DiffEditor").then((m) => ({ default: m.DiffEditor })));

/** VS Code's words for each letter */
const STATUS: Record<FileStatus, string> = { A: "추가됨", M: "수정됨|status", D: "삭제됨", R: "이름 바뀜", U: "추적 안 됨" };

// ───────────── how it shows: the viewer's own, kept in this browser only

interface Prefs {
  /** the Source Control view as a tree or a list */
  view: "tree" | "list";
  inline: boolean;
  /** side by side turns inline in a narrow pane (diffEditor.useInlineViewWhenSpaceIsLimited) */
  autoInline: boolean;
  collapse: boolean;
  wrap: boolean;
  /** the applied file instead of the diff */
  result: boolean;
  /** the Source Control view shown, in a wide and a narrow pane */
  scm: { wide: boolean; narrow: boolean };
  scmWidth: number;
}
const PREFS = "ondra.changes";
const DEFAULTS: Prefs = { view: "tree", inline: false, autoInline: true, collapse: true, wrap: false, result: false, scm: { wide: true, narrow: false }, scmWidth: 260 };
function readPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) ?? "{}") ?? {};
    return { ...DEFAULTS, ...p, scm: { ...DEFAULTS.scm, ...p.scm } };
  } catch {
    return DEFAULTS;
  }
}
function keepPrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {
    /* private mode */
  }
}
/** narrower than this, side by side turns inline and the Source Control view starts hidden */
const NARROW = 720;

// ───────────── file icons, as small coloured glyphs (Seti's shapes, our colours)

const GLYPHS: [RegExp, string, string][] = [
  [/\.(c|m)?tsx?$/, "TS", "var(--accent)"],
  [/\.(c|m)?jsx?$/, "JS", "var(--warn)"],
  [/\.jsonc?$/, "{}", "var(--warn)"],
  [/\.mdx?$/, "M↓", "var(--live)"],
  [/\.(css|scss|sass|less)$/, "#", "var(--live)"],
  [/\.html?$/, "<>", "var(--hl-tag)"],
  [/\.vue$/, "V", "var(--ok)"],
  [/\.svelte$/, "S", "var(--hl-tag)"],
  [/\.rs$/, "R", "var(--hl-tag)"],
  [/\.py$/, "py", "var(--accent)"],
  [/\.go$/, "GO", "var(--live)"],
  [/\.swift$/, "S", "var(--hl-tag)"],
  [/\.(sh|zsh|bash|fish)$/, "$", "var(--ok)"],
  [/\.(ya?ml|toml|ini)$/, "!", "var(--hl-type)"],
  [/\.(png|jpe?g|gif|webp|ico|svg|avif|bmp)$/, "", "var(--hl-type)"],
];
function FileIcon(props: { name: string }) {
  const g = () => GLYPHS.find(([re]) => re.test(props.name.toLowerCase()));
  return (
    <span class="cg-fi" style={{ color: g()?.[2] ?? "var(--ink-4)" }} aria-hidden="true">
      <Show when={g()?.[1]} fallback={<Icon name={g() ? "image" : props.name.endsWith(".lock") ? "lock" : "file"} size={14} />}>
        {g()![1]}
      </Show>
    </span>
  );
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
type Sides = { key: string; path: string; binary: true } | { key: string; path: string; binary: false; a: string; b: string; cut: boolean; unread: boolean; utf8: boolean };
const readable = (s: Sides) => (s.binary ? undefined : s);
/** the Changes group's own row in the tree */
const GROUP = "#changes";

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
    () => (merged() && w() ? ([w()!.repo, w()!.branch, w()!.into, w()!.base, props.t.host] as const) : false),
    // a job of another Mac: from its repo there
    ([repo, branch, into, base, host]) => mergedIn(host, repo, branch, into, base).catch(() => null),
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
  const files = () => source()?.files ?? [];

  // ── how it shows
  const [prefs, setPrefs] = createSignal(readPrefs());
  const set = (p: Partial<Prefs>) => setPrefs({ ...prefs(), ...p });
  createEffect(() => keepPrefs(prefs()));
  let root!: HTMLDivElement;
  const [width, setWidth] = createSignal(1200);
  const narrow = () => width() < NARROW;
  onMount(() => {
    setWidth(root.clientWidth);
    const ro = new ResizeObserver(() => setWidth(root.clientWidth));
    ro.observe(root);
    onCleanup(() => ro.disconnect());
  });
  const scmShown = () => (narrow() ? prefs().scm.narrow : prefs().scm.wide);
  const toggleScm = () => set({ scm: { ...prefs().scm, [narrow() ? "narrow" : "wide"]: !scmShown() } });
  const scmWidth = () => Math.max(170, Math.min(prefs().scmWidth, Math.round(width() * 0.5)));

  // ── the Source Control view's rows
  const tree = createMemo(() => buildTree(files()));
  const [closed, setClosed] = createSignal<ReadonlySet<string>>(new Set());
  const rows = createMemo<Row[]>(() => {
    const group: Row = { key: GROUP, kind: "dir", depth: 0, name: t("변경 사항"), open: !closed().has(GROUP) };
    if (!group.open) return [group];
    return [group, ...(prefs().view === "tree" ? treeRows(tree(), closed(), 1, GROUP) : listRows(files(), 1, GROUP))];
  });
  const order = createMemo(() => fileOrder(files(), prefs().view));
  const toggleDir = (key: string, open?: boolean) => {
    const next = new Set(closed());
    if (open ?? next.has(key)) next.delete(key);
    else next.add(key);
    setClosed(next);
  };
  const collapseAll = () => setClosed(new Set(folderKeys(tree())));
  const [focusRow, setFocusRow] = createSignal<string>(GROUP);
  let treeEl: HTMLDivElement | undefined;

  // ── the editor group's tabs
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [active, setActive] = createSignal<string>();
  const tab = () => tabs().find((x) => tabKey(x) === active());
  /** a file the tabs know: from the list, or as it was when the list moved on (a refresh) */
  const fileOf = (path: string): ChangedFile => files().find((f) => f.path === path) ?? { path, status: "M", add: 0, del: 0, binary: false };
  const current = () => (tab() ? fileOf(tab()!.path) : undefined);
  const [start, setStart] = createSignal<"first" | "last">("first");
  let api: DiffApi | undefined;
  let groupEl: HTMLDivElement | undefined;

  function open(f: ChangedFile, o: { pin?: boolean; kind?: Tab["kind"]; focus?: boolean; at?: "first" | "last" } = {}) {
    const r = openTab(tabs(), active(), { kind: o.kind ?? "diff", path: f.path }, o.pin);
    setStart(o.at ?? "first");
    setTabs(r.tabs);
    setActive(r.active);
    reveal(f.path);
    if (pane) setPaneView(pane.id, { name: "changes", id: props.t.id, path: f.path });
    if (o.focus) queueMicrotask(() => (api && hasDiff() ? api.focus() : groupEl?.focus()));
  }
  function close(key = active()) {
    if (!key) return;
    const had = !!groupEl?.contains(document.activeElement);
    const r = closeTab(tabs(), active(), key);
    setTabs(r.tabs);
    setActive(r.active);
    // the keys stay in the editor (the next tab's, once it is read), or go back to the tree with none left
    if (!r.active) treeEl?.focus({ preventScroll: true });
    else if (had) queueMicrotask(() => (groupEl?.contains(document.activeElement) ? undefined : api && hasDiff() ? api.focus() : groupEl?.focus()));
  }
  const show = (key: string | undefined) => {
    if (!key) return;
    setStart("first");
    setActive(key);
    const p = tabs().find((x) => tabKey(x) === key)?.path;
    if (p) reveal(p);
  };

  /** the file's row in sight and focused (its folders opened), scrolling the tree only */
  function reveal(path: string) {
    const folders = prefs().view === "tree" ? foldersOf(tree(), path) : [];
    if (closed().has(GROUP) || folders.some((k) => closed().has(k))) {
      const next = new Set(closed());
      for (const k of [GROUP, ...folders]) next.delete(k);
      setClosed(next);
    }
    setFocusRow(path);
    inSight(path);
  }
  /** a row scrolled into the tree's view (the tree only: scrollIntoView would move the panes around it) */
  const inSight = (key: string) =>
    queueMicrotask(() => {
      const el = treeEl?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      if (!el || !treeEl) return;
      const top = el.offsetTop;
      if (top < treeEl.scrollTop) treeEl.scrollTop = top;
      else if (top + el.offsetHeight > treeEl.scrollTop + treeEl.clientHeight) treeEl.scrollTop = top + el.offsetHeight - treeEl.clientHeight;
    });

  // the file the view was opened on (kept with the pane), else the first one, in a preview tab
  const viewPath = () => {
    const x = v();
    return x.name === "changes" ? x.path : undefined;
  };
  createEffect(
    on([viewPath, () => files().length > 0], ([p, any]) => {
      if (!any) return;
      const f = (p && files().find((x) => x.path === p || p.endsWith(`/${x.path}`))) || (!tabs().length ? order()[0] : undefined);
      if (f && tab()?.path !== f.path) open(f);
    }),
  );

  // ── both sides of the shown file, read again whenever the changes are
  const [sides] = createResource(
    () => {
      const x = tab();
      const s = source();
      return x && s ? { x, f: fileOf(x.path), s } : false;
    },
    async ({ x, f, s }): Promise<Sides> => {
      const key = tabKey(x);
      if (f.binary) return { key, path: f.path, binary: true };
      const [a, b] = await Promise.all([
        f.status === "A" || f.status === "U" ? MISSING : fileAtRev(props.t.host, s.cwd, s.from, f.old ?? f.path).catch(() => MISSING),
        f.status === "D" ? MISSING : fileAtRev(props.t.host, s.cwd, s.to, f.path).catch(() => MISSING),
      ]);
      if (a.binary || b.binary) return { key, path: f.path, binary: true };
      const ca = capText(a.text ?? "", MAX_LINES, a.cut);
      const cb = capText(b.text ?? "", MAX_LINES, b.cut);
      const utf8 = !(a.text ?? "").includes("�") && !(b.text ?? "").includes("�");
      return { key, path: f.path, binary: false, a: ca.text, b: cb.text, cut: ca.cut || cb.cut, unread: a.missing && b.missing, utf8 };
    },
  );
  // the last file read stays up while the next one is read (the editor isn't torn down between files)
  const shown = () => sides.latest;
  const mode = (): DiffMode => (tab()?.kind === "file" || prefs().result ? "result" : prefs().inline || (prefs().autoInline && narrow()) ? "inline" : "split");
  const [count, setCount] = createSignal({ cur: -1, total: 0 });
  const [cursor, setCursor] = createSignal<{ line: number; col: number }>();
  const [language, setLanguage] = createSignal("");
  /** the editor is up (not a binary, unreadable or deleted file's note) */
  const hasDiff = () => {
    const s = shown();
    return !!s && !s.binary && !s.unread && !(mode() === "result" && current()?.status === "D");
  };
  const eol = () => {
    const s = shown();
    if (!s || s.binary) return "";
    const text = s.b || s.a;
    return text.includes("\r\n") ? "CRLF" : text.includes("\n") ? "LF" : "";
  };

  // ── moving through the changes: F7 / ⇧F7 on into the next file, ⌥F5 / ⇧⌥F5 file by file
  function change(dir: 1 | -1) {
    if (hasDiff() && api) return void (dir > 0 ? api.next() : api.prev());
    edge(dir);
  }
  function edge(dir: 1 | -1) {
    const to = stepAcross(order(), tab()?.path, null, dir);
    if (to && "file" in to) open(to.file, { at: to.at });
  }
  const fileStep = (dir: 1 | -1) => {
    const f = stepFile(order(), tab()?.path, dir);
    if (f) open(f);
  };
  function keys(e: KeyboardEvent) {
    if (ignoredKey(e)) return;
    const act = (f: () => void) => (e.preventDefault(), f());
    if (matchesShortcut(e, "nextChange")) act(() => change(1));
    else if (matchesShortcut(e, "previousChange")) act(() => change(-1));
    else if (matchesShortcut(e, "nextFileChange")) act(() => fileStep(1));
    else if (matchesShortcut(e, "previousFileChange")) act(() => fileStep(-1));
    else if (tabs().length > 1 && matchesShortcut(e, "nextTab")) act(() => show(cycleTab(tabs(), active(), 1)));
    else if (tabs().length > 1 && matchesShortcut(e, "previousTab")) act(() => show(cycleTab(tabs(), active(), -1)));
    // ⌘W closes the tab while the editor has the keys; from the tree it closes the pane, as before
    else if (active() && groupEl?.contains(e.target as Node) && matchesShortcut(e, "closePane")) act(() => (close(), closedHere()));
  }
  // the app menu's ⌘W, when the key itself doesn't reach the page
  claimClose(() => focused() && !!active() && !!groupEl?.contains(document.activeElement) && (close(), true));
  // the palette's commands for these keys
  onMount(() => {
    const run = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (id === "nextChange") change(1);
      else if (id === "previousChange") change(-1);
      else if (id === "nextFileChange") fileStep(1);
      else if (id === "previousFileChange") fileStep(-1);
    };
    root.addEventListener("cg-command", run);
    onCleanup(() => root.removeEventListener("cg-command", run));
  });

  // ── the tree's keys: ↑↓ move, ←→ fold and unfold, ↵ opens (and goes to the editor), Space opens in place
  let typed = "";
  let typedAt = 0;
  function treeKeys(e: KeyboardEvent) {
    if (ignoredKey(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const list = rows();
    const i = Math.max(0, list.findIndex((r) => r.key === focusRow()));
    const r = list[i];
    const move = (n: number) => {
      e.preventDefault();
      const to = list[Math.max(0, Math.min(list.length - 1, n))];
      if (to) setFocusRow(to.key), inSight(to.key);
    };
    const page = Math.max(1, Math.floor((treeEl?.clientHeight ?? 220) / 22) - 1);
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i - 1);
    else if (e.key === "PageDown") move(i + page);
    else if (e.key === "PageUp") move(i - page);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(list.length - 1);
    else if (e.key === "ArrowRight" && r?.kind === "dir") {
      e.preventDefault();
      if (!r.open) toggleDir(r.key, true);
      else move(i + 1);
    } else if (e.key === "ArrowLeft" && r) {
      e.preventDefault();
      if (r.kind === "dir" && r.open) toggleDir(r.key, false);
      else if (r.parent) move(list.findIndex((x) => x.key === r.parent));
    } else if ((e.key === "Enter" || e.key === " ") && r) {
      e.preventDefault();
      if (r.file) open(r.file, { focus: e.key === "Enter" });
      else toggleDir(r.key);
    } else if (e.key.length === 1 && !e.shiftKey && /\S/.test(e.key)) {
      // type to go to the next row whose name starts with it
      typed = Date.now() - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase();
      typedAt = Date.now();
      const from = typed.length > 1 ? i : i + 1;
      const n = list.length;
      for (let k = 0; k < n; k++) {
        const x = list[(from + k) % n];
        if (x.name.toLowerCase().startsWith(typed)) return move((from + k) % n);
      }
    }
  }
  // the tree takes the keys when it first shows (↑↓ right away), unless something else has them
  const takeKeys = (el: HTMLDivElement) => {
    treeEl = el;
    queueMicrotask(() => {
      const a = document.activeElement;
      if (focused() && (!a || a === document.body || !a.closest("input, textarea, [contenteditable], .palette, [role=dialog]"))) el.focus({ preventScroll: true });
    });
  };

  // ── what the actions do
  const full = (path: string) => (source() ? `${source()!.root}/${path}` : "");
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(t("경로를 복사했어요"));
    } catch {
      toast(t("복사하지 못했어요"), "bad");
    }
  };
  const fileItems = (f: ChangedFile): MenuEntry[] => [
    { id: "open", label: t("파일 열기|scm"), icon: "goto", run: () => open(f, { kind: "file" }) },
    { id: "changes", label: t("변경 사항 열기|scm"), icon: "diff", run: () => open(f) },
    "sep",
    { id: "copy", label: t("경로 복사"), icon: "copy", run: () => void copy(full(f.path)) },
    { id: "copyRel", label: t("상대 경로 복사"), icon: "copy", run: () => void copy(f.path) },
    ...(f.status === "D"
      ? []
      : [
          "sep" as const,
          // a job of another Mac: they open on that Mac's screen
          { id: "finder", label: props.t.host ? t("그 Mac의 Finder에서 보기") : t("Finder에서 보기"), icon: "folder", run: () => void revealOn(props.t.host, full(f.path)) },
          { id: "editor", label: props.t.host ? t("그 Mac의 편집기에서 열기") : t("편집기에서 열기"), icon: "external", run: () => void editorOn(props.t.host, full(f.path)) },
        ]),
  ];
  const moreItems = (): MenuEntry[] => {
    const p = prefs();
    const f = current();
    const diff = tab()?.kind === "diff";
    return [
      ...(diff
        ? [
            { id: "inline", label: t("인라인 보기"), icon: "", checked: p.inline, run: () => set({ inline: !p.inline, result: false }) },
            { id: "auto", label: t("공간이 좁으면 인라인 보기"), icon: "", checked: p.autoInline, run: () => set({ autoInline: !p.autoInline }) },
            { id: "collapse", label: t("변경 안 된 영역 접기"), icon: "", checked: p.collapse, run: () => set({ collapse: !p.collapse }) },
            { id: "result", label: t("적용된 결과 보기"), icon: "", checked: p.result, run: () => set({ result: !p.result }) },
          ]
        : []),
      { id: "wrap", label: t("자동 줄 바꿈"), icon: "", checked: p.wrap, run: () => set({ wrap: !p.wrap }) },
      ...(f ? (["sep", ...fileItems(f).filter((x) => x === "sep" || !["open", "changes"].includes(x.id))] as MenuEntry[]) : []),
    ].filter((x, i, all) => !(x === "sep" && (i === 0 || all[i - 1] === "sep")));
  };
  const tabItems = (x: Tab): MenuEntry[] => [
    { id: "close", label: t("닫기"), icon: "x", run: () => close(tabKey(x)) },
    { id: "others", label: t("다른 탭 닫기"), icon: "x", run: () => (setTabs([x]), setActive(tabKey(x))) },
    { id: "all", label: t("모두 닫기"), icon: "x", run: () => (setTabs([]), setActive(undefined)) },
    ...(x.pinned ? [] : [{ id: "keep", label: t("계속 열어 두기"), icon: "pin", run: () => setTabs(pinTab(tabs(), tabKey(x))) }]),
    "sep",
    ...fileItems(fileOf(x.path)).filter((i) => i === "sep" || i.id !== (x.kind === "file" ? "open" : "changes")),
  ];

  /** "router.ts (작업 트리)": which version the right side is, as VS Code's title says */
  const tabTitle = (x: Tab) => {
    const name = splitPath(x.path)[1];
    if (x.kind === "file") return name;
    const f = fileOf(x.path);
    const side = f.status === "D" ? t("삭제됨") : merged() && source()?.from && source()?.to ? `${short(source()!.from!)} ↔ ${short(source()!.to!)}` : t("작업 트리");
    return `${name} (${side})`;
  };
  const short = (rev: string) => (/^[0-9a-f]{12,}$/.test(rev) ? rev.slice(0, 7) : rev);

  /** the job's chat is already in another pane */
  const chatBeside = () => !!shownIn({ name: "task", id: props.t.id }, pane?.id ?? "");
  const where = () => (merged() ? (w()?.into ? t("{into}에 병합됨", { into: w()!.into! }) : t("병합됨")) : "");
  const branch = () => (w()?.state === "open" ? w()!.branch : merged() ? w()?.into : undefined);

  // ── the Source Control view's width, dragged at its edge
  function sashDown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    const left = root.getBoundingClientRect().left;
    const move = (m: PointerEvent) => set({ scmWidth: Math.round(Math.max(170, Math.min(m.clientX - left, width() * 0.5))) });
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const act = (icon: string, label: string, run: (e: MouseEvent) => void, extra: { pressed?: boolean; disabled?: boolean; hint?: Parameters<typeof withHint>[1] } = {}): JSX.Element => (
    <button
      class="cg-act"
      classList={{ on: !!extra.pressed }}
      aria-pressed={extra.pressed}
      disabled={extra.disabled}
      title={extra.hint ? withHint(label, extra.hint) : label}
      aria-label={label}
      onClick={run}
    >
      <Icon name={icon} size={16} />
    </button>
  );

  return (
    <div class="view cg-view" ref={root} classList={{ narrow: narrow() }} onKeyDown={keys}>
      <header class="head cg-head" data-tauri-drag-region>
        <SidebarToggle />
        <button class="icon-btn sm" title={withHint(t("작업 대화로"), "changesEditor")} aria-label={t("작업 대화로")} onClick={() => openTask(props.t.id)}>
          <Icon name="back" size={14} />
        </button>
        <h1 class="head-title">{t("변경 사항")}</h1>
        <span class="cg-job" title={props.t.title}>{props.t.title}</span>
        <Show when={where()}><span class="cg-pill">{where()}</span></Show>
        <span class="spacer" data-tauri-drag-region />
        <button class="icon-btn sm" classList={{ on: scmShown() }} aria-pressed={scmShown()} title={t("소스 제어 보기")} aria-label={t("소스 제어 보기")} onClick={toggleScm}>
          <Icon name="panelLeft" size={14} />
        </button>
        <Show when={!chatBeside()}>
          <button class="icon-btn sm" title={t("옆에 작업 대화 열기")} aria-label={t("옆에 작업 대화 열기")} onClick={() => openInSplit(props.t.id, "right")}>
            <Icon name="message" size={14} />
          </button>
        </Show>
        <PaneControls />
      </header>
      <Show when={source() !== undefined} fallback={<div class="pane-empty cg-empty" />}>
        <Show when={source()} fallback={<div class="pane-empty cg-empty">{why()}</div>}>
          <div class="cg-body">
            <Show when={scmShown()}>
              <aside class="scm" style={{ width: `${scmWidth()}px` }} aria-label={t("소스 제어")}>
                <div class="scm-title">
                  <span class="scm-title-text">{t("소스 제어")}</span>
                  <span class="scm-title-acts">
                    {act(prefs().view === "tree" ? "listFlat" : "listTree", prefs().view === "tree" ? t("목록으로 보기") : t("트리로 보기"), () => set({ view: prefs().view === "tree" ? "list" : "tree" }))}
                    <Show when={prefs().view === "tree"}>{act("collapseAll", t("모두 접기|scm"), collapseAll)}</Show>
                    <Show when={!merged() && !gone()}>{act("refresh", t("새로고침"), () => refetch())}</Show>
                  </span>
                </div>
                <div
                  class="scm-tree"
                  ref={takeKeys}
                  tabIndex={0}
                  role="tree"
                  aria-label={t("변경 사항")}
                  aria-activedescendant={`cg-row-${focusRow()}`}
                  onKeyDown={treeKeys}
                >
                  <For each={rows()}>
                    {(r) => {
                      const selected = () => !!r.file && r.file.path === tab()?.path;
                      const group = r.key === GROUP;
                      return (
                        <div
                          id={`cg-row-${r.key}`}
                          data-key={r.key}
                          class="scm-row"
                          classList={{ group, file: !!r.file, sel: selected(), focus: focusRow() === r.key, [`st-${r.file?.status}`]: !!r.file }}
                          role="treeitem"
                          aria-level={r.depth + 1}
                          aria-expanded={r.kind === "dir" ? !!r.open : undefined}
                          aria-selected={selected()}
                          title={r.file ? (r.file.old ? `${r.file.old} → ${r.file.path}` : r.file.path) + ` • ${t(STATUS[r.file.status])}` : undefined}
                          onMouseDown={(e) => e.button === 0 && e.detail === 1 && setFocusRow(r.key)}
                          onClick={(e) => {
                            treeEl?.focus({ preventScroll: true });
                            if (e.detail > 1) return;
                            if (r.file) open(r.file);
                            else toggleDir(r.key);
                          }}
                          onDblClick={() => r.file && open(r.file, { pin: true, focus: true })}
                          onContextMenu={(e) => {
                            if (!r.file) return;
                            e.preventDefault();
                            setFocusRow(r.key);
                            const f = r.file;
                            openMenuAt(`cg:${f.path}`, () => fileItems(f), e);
                          }}
                        >
                          <For each={Array.from({ length: r.depth })}>{(_, i) => <span class="scm-guide" classList={{ first: i() === 0 }} />}</For>
                          <span class="scm-twistie">
                            <Show when={r.kind === "dir"}>
                              <Icon name={r.open ? "down" : "chevron"} size={16} />
                            </Show>
                          </span>
                          <Show when={r.file}>{(f) => <FileIcon name={splitPath(f().path)[1]} />}</Show>
                          <span class="scm-name">{r.name}</span>
                          <Show when={r.dir}><span class="scm-dir">{r.dir}</span></Show>
                          <span class="scm-fill" />
                          <Show when={r.file}>
                            {(f) => (
                              <span class="scm-acts">
                                <button
                                  class="cg-act"
                                  title={t("파일 열기|scm")}
                                  aria-label={t("파일 열기|scm")}
                                  tabIndex={-1}
                                  onClick={(e) => (e.stopPropagation(), open(f(), { kind: "file" }))}
                                  onDblClick={(e) => e.stopPropagation()}
                                >
                                  <Icon name="goto" size={16} />
                                </button>
                              </span>
                            )}
                          </Show>
                          <Show when={group}><span class="scm-badge">{files().length}</span></Show>
                          <Show when={r.file}>{(f) => <span class="scm-st" title={t(STATUS[f().status])}>{f().status}</span>}</Show>
                        </div>
                      );
                    }}
                  </For>
                  <Show when={!files().length}><div class="scm-none">{t("변경 없음")}</div></Show>
                </div>
              </aside>
              <div class="cg-vsash" role="separator" aria-orientation="vertical" aria-label={t("소스 제어 너비")} onPointerDown={sashDown} onDblClick={() => set({ scmWidth: DEFAULTS.scmWidth })} />
            </Show>
            <section class="eg" ref={groupEl} tabIndex={-1} aria-label={t("편집기")}>
              <Show
                when={tab()}
                fallback={
                  <div class="eg-empty">
                    <dl>
                      <dt>{t("다음 변경")}</dt>
                      <dd>F7</dd>
                      <dt>{t("다음 파일")}</dt>
                      <dd>⌥F5</dd>
                    </dl>
                  </div>
                }
              >
                {(x) => (
                  <>
                    <div class="eg-bar">
                      <div class="eg-tabs" role="tablist">
                        <For each={tabs()}>
                          {(y) => (
                            <div
                              class="eg-tab"
                              classList={{ active: tabKey(y) === active(), preview: !y.pinned, [`st-${fileOf(y.path).status}`]: true }}
                              role="tab"
                              aria-selected={tabKey(y) === active()}
                              title={full(y.path)}
                              onClick={() => show(tabKey(y))}
                              onDblClick={() => setTabs(pinTab(tabs(), tabKey(y)))}
                              onAuxClick={(e) => e.button === 1 && close(tabKey(y))}
                              onContextMenu={(e) => (e.preventDefault(), openMenuAt(`cg-tab:${tabKey(y)}`, () => tabItems(y), e))}
                            >
                              <FileIcon name={splitPath(y.path)[1]} />
                              <span class="eg-tab-label">{tabTitle(y)}</span>
                              <button
                                class="eg-tab-x"
                                title={tabKey(y) === active() ? withHint(t("닫기"), "closePane") : t("닫기")}
                                aria-label={t("닫기")}
                                onClick={(e) => (e.stopPropagation(), close(tabKey(y)))}
                              >
                                <Icon name="x" size={14} />
                              </button>
                            </div>
                          )}
                        </For>
                      </div>
                      <div class="eg-acts">
                        <Show
                          when={x().kind === "diff"}
                          fallback={act("diff", t("변경 사항 열기|scm"), () => open(fileOf(x().path)))}
                        >
                          {act("goto", t("파일 열기|scm"), () => open(fileOf(x().path), { kind: "file" }), { disabled: current()?.status === "D" })}
                          {act("arrowUp", t("이전 변경"), () => change(-1), { hint: "previousChange" })}
                          {act("arrowDown", t("다음 변경"), () => change(1), { hint: "nextChange" })}
                          {act("fold", t("변경 안 된 영역 접기"), () => set({ collapse: !prefs().collapse }), { pressed: prefs().collapse, disabled: mode() === "result" })}
                        </Show>
                        {act("more", t("기타 작업"), (e) => openMenuAt("cg-more", moreItems, (e.currentTarget as HTMLElement).getBoundingClientRect(), e.detail === 0))}
                      </div>
                    </div>
                    <nav class="eg-crumbs" aria-label={t("경로|crumbs")}>
                      <For each={splitPath(x().path)[0] ? splitPath(x().path)[0].split("/") : []}>
                        {(part, i) => (
                          <>
                            <button
                              class="eg-crumb"
                              onClick={() => {
                                const dir = `${splitPath(x().path)[0].split("/").slice(0, i() + 1).join("/")}/`;
                                const row = rows().find((r) => r.kind === "dir" && (r.key === dir || dir.startsWith(r.key)) && r.key !== GROUP);
                                if (!scmShown()) toggleScm();
                                reveal(x().path);
                                if (row) setFocusRow(row.key);
                                queueMicrotask(() => treeEl?.focus({ preventScroll: true }));
                              }}
                            >
                              {part}
                            </button>
                            <Icon name="chevron" size={14} class="eg-sep" />
                          </>
                        )}
                      </For>
                      <span class="eg-crumb last">
                        <FileIcon name={splitPath(x().path)[1]} />
                        {splitPath(x().path)[1]}
                      </span>
                    </nav>
                    <Show when={shown() && readable(shown()!)?.cut}><div class="eg-note">{t("파일이 커서 일부만 보여요")}</div></Show>
                    <div class="eg-body">
                      <Show when={shown()} fallback={<div class="pane-empty" />}>
                        {(s) => (
                          <Show when={readable(s())} fallback={<div class="pane-empty cg-note">{t("바이너리 파일이라 편집기에 표시하지 않아요")}</div>}>
                            {(d) => (
                              <Show
                                when={!(mode() === "result" && current()?.status === "D") && !d().unread}
                                fallback={<div class="pane-empty cg-note">{d().unread ? t("내용을 읽지 못했어요") : t("삭제된 파일이에요")}</div>}
                              >
                                <Suspense fallback={<div class="pane-empty" />}>
                                  <DiffEditor
                                    path={d().key}
                                    a={d().a}
                                    b={d().b}
                                    mode={mode()}
                                    wrap={prefs().wrap}
                                    collapse={prefs().collapse}
                                    start={start()}
                                    onCount={(cur, total) => setCount({ cur, total })}
                                    onEdge={edge}
                                    onCursor={(line, col) => setCursor({ line, col })}
                                    onLanguage={setLanguage}
                                    onEscape={() => treeEl?.focus({ preventScroll: true })}
                                    ref={(x) => (api = x)}
                                  />
                                </Suspense>
                              </Show>
                            )}
                          </Show>
                        )}
                      </Show>
                    </div>
                  </>
                )}
              </Show>
            </section>
          </div>
          <footer class="cg-status" aria-label={t("상태 표시줄")}>
            <Show when={branch()}>
              <span class="cg-si" title={t("브랜치")}>
                <Icon name="branch" size={14} />
                {branch()}
              </span>
            </Show>
            <Show when={tab()?.kind === "diff" && hasDiff()}>
              <span class="cg-si">{count().cur >= 0 ? t("변경 {i}/{n}", { i: count().cur + 1, n: count().total }) : t("변경 {n}개", { n: count().total })}</span>
            </Show>
            <span class="spacer" />
            <Show when={hasDiff() && cursor()}>{(c) => <span class="cg-si">{t("줄 {line}, 열 {col}", { line: c().line, col: c().col })}</span>}</Show>
            <Show when={hasDiff()}>
              <span class="cg-si">{language() || t("일반 텍스트")}</span>
              <Show when={readable(shown()!)?.utf8}><span class="cg-si">UTF-8</span></Show>
              <Show when={eol()}><span class="cg-si">{eol()}</span></Show>
            </Show>
          </footer>
        </Show>
      </Show>
    </div>
  );
}
