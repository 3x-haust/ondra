// The one input (a new request, or a follow-up to one task).
// Card with the text area; a bar below it: [+] and left chips, right chips,
// send ↔ stop. Strips (paused, plan, background…) dock on top, an optional
// row sits under the card. Files can be attached with + or dropped on the window.
// Enter sends (never mid-IME), Shift+Enter is a new line; while a task works, Enter puts the
// words in now and Cmd+Enter queues them for after (as Codex does).
import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { logInfo } from "../lib/log";
import { COMMANDS, pick, track } from "../lib/telemetry";
import { clipboardFiles, fileSrc, inTauri, pickFiles, savePaste } from "../lib/native";
import { setState, state } from "../state/store";
import { focusId } from "../state/ui";
import { usePane } from "../state/panes";
import { placePop, usePop } from "./ModelPicker";
import { withQuotes } from "./quote";
import { openImage } from "./Lightbox";
import { tilde } from "../engine/rpc";
import { Icon } from "./Icon";
import { ignoredKey, noModifiers, shortcutHint } from "../lib/shortcuts";
import { midTrim } from "./bits";
import { t } from "../i18n";

/** A /command that ran, for the log a feedback report carries: its name, not what followed (a skill's own name stays out). */
const ran = (name: string) => {
  const known = name.startsWith("skill:") ? "skill" : name;
  logInfo("command", `/${known}`);
  track("command_used", { name: pick(COMMANDS, known, "other") });
};

/** The composers on screen that take dropped files: the focused pane's gets them (the last one shown outside panes). */
const drops: { pane?: string; add: (paths: string[]) => void }[] = [];
const dropTarget = () => [...drops].reverse().find((d) => !d.pane || d.pane === focusId()) ?? drops[drops.length - 1];
const [dragging, setDragging] = createSignal(false);
let listening = false;
async function listenDrops() {
  if (listening || !inTauri) return;
  listening = true;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") setDragging(!!dropTarget());
    else if (p.type === "leave") setDragging(false);
    else if (p.type === "drop") {
      setDragging(false);
      if (p.paths.length) dropTarget()?.add(p.paths);
    }
  });
}

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
/** A message with its attachments listed the way jobs and main read them. */
export const withFiles = (text: string, files: string[]) => {
  const t = text.trim();
  if (!files.length) return t;
  const list = `첨부한 파일:\n${files.map((p) => `- ${p}`).join("\n")}`;
  return t ? `${t}\n\n${list}` : list;
};

/** The composers on screen, so a quote from a reply goes into the one beside it. */
export const composers = new Set<{ root: HTMLElement; quote: (text: string) => void }>();

export const isImage = (p: string) => /\.(png|jpe?g|gif|webp|heic|bmp|svg)$/i.test(p);

/** An entry of the + menu. */
export interface PlusItem {
  section?: string;
  icon: string;
  label: string;
  desc?: string;
  /** its shortcut, shown as a key chip */
  keys?: string;
  run: (api: { insert: (text: string) => void }) => void;
}

export interface Command {
  name: string;
  desc: string;
  icon?: string;
  /** its shortcut, shown as a key chip */
  keys?: string;
  /** keep the text after the command as an argument; `also`: more skills named in the same message; `files`: what was attached */
  run: (arg: string, also?: string[], files?: string[]) => void;
  /** takes the attached files and pictures along */
  files?: boolean;
  /** a skill: picking it writes "/skill:name" into the text (anywhere in it), sending runs it */
  skill?: boolean;
}

type Pick = { kind: "cmd"; items: Command[]; q: string; at: number } | { kind: "file"; items: string[]; q: string; at: number };

/** what was typed in each chat, so switching chats (company / personal, projects, jobs) keeps each its own */
const drafts = new Map<string, { text: string; files: string[] }>();
/** something unsent is kept for this input */
export const hasDraft = (key: string) => drafts.has(key);

export function Composer(props: {
  placeholder: string;
  onSend: (text: string) => void;
  /** Cmd+Enter: hold the words until the work in progress is done, instead of now */
  onQueue?: (text: string) => void;
  id?: string;
  /** chips after the + button */
  left?: JSX.Element;
  /** chips before the send button */
  right?: JSX.Element;
  /** a row under the card (where the work happens) */
  under?: JSX.Element;
  autofocus?: boolean;
  disabled?: boolean;
  /** the user started typing (warm the cache before they send) */
  onTyping?: () => void;
  big?: boolean;
  /** while the agent works and nothing is typed, the send button stops it */
  running?: boolean;
  onStop?: () => void;
  /** what that button does, said on it: a task's input pauses the task (it can be resumed), Main's stops its reply */
  stopKind?: "pause" | "stop";
  /** strips docked on top of the input (plan progress, background commands…) */
  top?: JSX.Element;
  /** "/" menu: things you can do from the input */
  commands?: Command[];
  /** "@" menu: files you can point at (relative paths) */
  files?: () => Promise<string[]>;
  /** quiet info inside the bar: account, plan windows, context */
  status?: JSX.Element;
  /** more entries for the + menu (after "파일 및 폴더") */
  plus?: PlusItem[];
  /** the chat this input belongs to: each keeps its own unsent text */
  draftKey?: string;
  /** its menus open below it when there is room (an input near the top of the screen) */
  popDown?: boolean;
}) {
  const [text, setText] = createSignal("");
  const [plusOpen, setPlusOpen] = usePop();
  const plusItems = (): PlusItem[] => [
    {
      icon: "clip",
      label: t("파일 및 폴더"),
      run: async () => {
        const picked = await pickFiles(t("첨부할 파일"));
        if (picked.length) add(picked);
      },
    },
    ...(props.plus ?? []),
  ];
  const [files, setFiles] = createSignal<string[]>([]);
  let el!: HTMLTextAreaElement;
  // each chat keeps its own unsent text: saved as it is typed, brought back when the
  // chat (or a new input for it) shows up
  createEffect(
    on(
      () => props.draftKey,
      (key) => {
        const d = (key !== undefined && drafts.get(key)) || { text: "", files: [] };
        setText(d.text);
        setFiles(d.files);
        if (el) {
          el.value = d.text;
          queueMicrotask(grow);
        }
        setPick(null);
      },
    ),
  );
  createEffect(() => {
    const t = text();
    const f = files();
    const key = untrack(() => props.draftKey);
    if (key === undefined) return;
    if (t || f.length) drafts.set(key, { text: t, files: f });
    else drafts.delete(key);
  });

  const add = (paths: string[]) => {
    setFiles((f) => [...f, ...paths.filter((p) => !f.includes(p))]);
    el?.focus();
  };
  const pane = usePane();
  onMount(() => {
    const me = { pane: pane?.id, add };
    drops.push(me);
    onCleanup(() => drops.splice(drops.indexOf(me), 1));
    void listenDrops();
  });

  // empty, it keeps its resting size: measured while the box was narrow (a pane opening, the
  // hero laying out), the placeholder wrapped letter by letter and the box stayed that tall
  const grow = () => {
    if (!el) return;
    if (!el.value) return void (el.style.height = "");
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  };
  // and when its width changes, its text re-wraps: measure again
  onMount(() => {
    let w = 0;
    const ro = new ResizeObserver(([e]) => {
      const now = Math.round(e.contentRect.width);
      if (now !== w) (w = now), grow();
    });
    queueMicrotask(() => el && ro.observe(el));
    onCleanup(() => ro.disconnect());
  });
  // ── "/" commands and "@" files
  const [pick, setPick] = createSignal<Pick | null>(null);
  const [sel, setSel] = createSignal(0);
  // the chosen row stays in view while the arrows walk a long list
  createEffect(on(sel, () => queueMicrotask(() => el?.closest("form")?.querySelector(".cpick-row.on")?.scrollIntoView({ block: "nearest" }))));
  let fileList: string[] | null = null;
  const refresh = async () => {
    const v = el.value;
    const caret = el.selectionStart ?? v.length;
    // "/" at the start: every command; after a space in the middle: skills only
    const cmd = /(^|\s)\/(\S*)$/.exec(v.slice(0, caret));
    if (cmd && props.commands?.length) {
      const q = cmd[2].toLowerCase();
      const at = caret - cmd[2].length - 1;
      const bare = (c: Command) => c.name.toLowerCase().replace(/^skill:/, "");
      // the name's start, then a word in it ("/review" → code-review), then the description (3+ letters)
      const rank = (c: Command) =>
        c.name.toLowerCase().startsWith(q) || bare(c).startsWith(q) ? 0 : bare(c).split(/[-_:.]/).some((w) => w.startsWith(q)) ? 1 : q.length >= 3 && c.desc.toLowerCase().includes(q) ? 2 : 9;
      const items = props.commands
        .filter((c) => (at === 0 || c.skill) && rank(c) < 9)
        .sort((a, b) => rank(a) - rank(b))
        .slice(0, 40);
      setPick(items.length ? { kind: "cmd", items, q, at } : null);
      setSel(0);
      return;
    }
    const at = /(^|\s)@([^\s@]*)$/.exec(v.slice(0, caret));
    if (at && props.files) {
      fileList ??= await props.files().catch(() => []);
      const q = at[2].toLowerCase();
      const score = (f: string) => {
        const l = f.toLowerCase();
        const b = base(l);
        return b.startsWith(q) ? 0 : b.includes(q) ? 1 : l.includes(q) ? 2 : 9;
      };
      const items = fileList
        .filter((f) => score(f) < 9)
        .sort((a, b) => score(a) - score(b) || a.length - b.length)
        .slice(0, 8);
      setPick(items.length ? { kind: "file", items, q, at: caret - at[2].length - 1 } : null);
      setSel(0);
      return;
    }
    setPick(null);
  };
  const choose = (i: number) => {
    const p = pick();
    if (!p) return;
    if (p.kind === "cmd") {
      const c = p.items[i];
      if (c.skill || p.at > 0) return complete(i);
      const arg = el.value.replace(/^\/\S*\s*/, "");
      keep(`/${c.name}${arg.trim() ? ` ${arg.trim()}` : ""}`);
      setText("");
      el.value = "";
      setPick(null);
      queueMicrotask(grow);
      ran(c.name);
      c.run(arg);
      return;
    }
    const f = p.items[i];
    const v = el.value;
    const caret = el.selectionStart ?? v.length;
    const next = `${v.slice(0, p.at)}@${f} ${v.slice(caret)}`;
    setText(next);
    el.value = next;
    const pos = p.at + f.length + 2;
    el.setSelectionRange(pos, pos);
    setPick(null);
    grow();
  };

  /** Tab: fill in the command, run nothing */
  const complete = (i: number) => {
    const p = pick();
    if (!p || p.kind !== "cmd") return;
    const v = el.value;
    const caret = el.selectionStart ?? v.length;
    const word = `/${p.items[i].name} `;
    const rest = v.slice(caret).replace(/^\S*\s?/, "");
    const next = `${v.slice(0, p.at)}${word}${rest}`;
    setText(next);
    el.value = next;
    const pos = p.at + word.length;
    el.setSelectionRange(pos, pos);
    setPick(null);
    grow();
  };
  /** quoted from a reply: a quiet line above what is typed (sent first, as a Markdown quote), the cursor stays in the text */
  const [quotes, setQuotes] = createSignal<string[]>([]);
  const quote = (t: string) => {
    const q = t.trim();
    if (!q) return;
    setQuotes((l) => (l.includes(q) ? l : [...l, q]));
    setEngaged(true);
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };
  // every menu that opens from this input (+, project, permission, model, account) goes where
  // there is room for it, never over the control that opened it
  onMount(() => {
    const mo = new MutationObserver((list) => {
      for (const m of list)
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          const pops = n.matches(".pop, .plus-menu") ? [n] : [...n.querySelectorAll<HTMLElement>(".pop, .plus-menu")];
          pops.forEach(placePop);
        }
    });
    mo.observe(wrap, { childList: true, subtree: true });
    onCleanup(() => mo.disconnect());
  });
  onMount(() => {
    const me = { root: wrap, quote };
    composers.add(me);
    onCleanup(() => composers.delete(me));
  });
  const insert = (t: string) => {
    const v = el.value;
    const next = v && !v.endsWith(" ") && !t.startsWith("/") ? `${v} ${t}` : t.startsWith("/") ? `${t}${v ? ` ${v}` : ""}` : `${v}${t}`;
    setText(next);
    el.value = next;
    el.focus();
    el.setSelectionRange(next.length, next.length);
    grow();
  };

  // ↑ / ↓ go through what was sent before in this space (any input, /btw and other commands too)
  const sent = () => state.sent?.[state.space] ?? [];
  const [back, setBack] = createSignal<number | null>(null);
  // a space switch starts browsing from the newest again
  createEffect(on(() => state.space, () => setBack(null), { defer: true }));
  const keep = (t: string) => {
    const v = t.trim();
    setBack(null);
    if (v) setState("sent", (all) => ({ ...(all ?? {}), [state.space]: [...(all?.[state.space] ?? []).filter((x) => x !== v).slice(-199), v] }));
  };
  const recall = (i: number | null) => {
    setBack(i);
    const v = i === null ? "" : sent()[i];
    setText(v);
    el.value = v;
    el.setSelectionRange(v.length, v.length);
    grow();
  };

  // a picture or file alone is enough to send
  const ready = () => (!!text().trim() || files().length > 0 || quotes().length > 0) && !props.disabled;
  const send = (queue = false) => {
    if (!ready()) return;
    // skills named anywhere ("이거 /skill:deep-research 로 조사해줘"): the first runs, with the rest of the text
    const skills = props.commands?.filter((c) => c.skill) ?? [];
    const named = [...text().matchAll(/(^|\s)\/(skill:\S+)/g)].map((x) => skills.find((c) => c.name === x[2])).filter((c): c is Command => !!c);
    if (named.length && !files().length) {
      const rest = text().replace(/(^|\s)\/skill:\S+/g, (_m, sp: string) => sp).replace(/\s{2,}/g, " ").trim();
      keep(text());
      setText("");
      el.value = "";
      queueMicrotask(grow);
      ran(named[0].name);
      named[0].run(rest, [...new Set(named.slice(1).map((c) => c.name.replace(/^skill:/, "")))]);
      return;
    }
    // "/name what" typed out in full runs the command
    const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text().trim());
    const cmd = m && props.commands?.find((c) => c.name === m[1]);
    if (cmd) {
      const f = cmd.files ? files() : [];
      keep(text());
      setText("");
      el.value = "";
      if (f.length) setFiles([]);
      queueMicrotask(grow);
      ran(cmd.name);
      cmd.run(m![2] ?? "", [], f);
      return;
    }
    const f = files();
    const v = withQuotes(quotes(), text());
    keep(text());
    setQuotes([]);
    setEngaged(false);
    // emptied before it is handed on: sending can close this input (a new task opens the task),
    // and a draft saved after that would come back the next time
    setText("");
    setFiles([]);
    el.value = "";
    const key = props.draftKey;
    if (key !== undefined) drafts.delete(key);
    (queue && props.onQueue ? props.onQueue : props.onSend)(withFiles(v, f));
    queueMicrotask(grow);
  };

  // Thin until used (ChatGPT-style): one row with +, model and send. Pressing or
  // typing in it opens it; a press anywhere else, sending or Esc closes it.
  // Closing waits until that press has finished as a click: shrinking under the
  // pointer moved the page (and the size transition covered it), so the first
  // click elsewhere used to do nothing. A new chat (big) starts open.
  const [engaged, setEngaged] = createSignal(false);
  let pressing = false;
  let closeAfterPress = false;
  let pressTimer: number | undefined;
  const close = () => (pressing ? (closeAfterPress = true) : setEngaged(false));
  // A press ends on whichever comes first: pointerup, mouseup, click or a short
  // timeout. WebKit can drop the pointerup (a press that starts a text selection),
  // which left the input open until the next click.
  const up = () => {
    if (!pressing) return;
    pressing = false;
    clearTimeout(pressTimer);
    if (!closeAfterPress) return;
    closeAfterPress = false;
    // after the click this press makes has been handled
    setTimeout(() => setEngaged(false), 0);
  };
  const down = (e: PointerEvent) => {
    pressing = true;
    clearTimeout(pressTimer);
    pressTimer = window.setTimeout(up, 700);
    const t = e.target as Element | null;
    if (!wrap.contains(t) && !t?.closest?.('[role="dialog"]')) close();
  };
  // never the input's own blur: that fires on the press itself, and closing then
  // moved the page under the pointer so the click missed what it was on
  const ends = ["pointerup", "pointercancel", "mouseup", "click", "dragstart"] as const;
  const left = (e: Event) => e.target === window && up();
  document.addEventListener("pointerdown", down, true);
  for (const k of ends) window.addEventListener(k, up, true);
  window.addEventListener("blur", left);
  onCleanup(() => {
    clearTimeout(pressTimer);
    document.removeEventListener("pointerdown", down, true);
    for (const k of ends) window.removeEventListener(k, up, true);
    window.removeEventListener("blur", left);
  });
  const want = () => !!props.big || engaged() || !!text() || files().length > 0 || quotes().length > 0 || plusOpen() || !!pick();
  // the to-do list and other strips above the input work on their own: touching them never opens the input
  const inStrips = (n: EventTarget | null) => n instanceof Element && !!n.closest(".strips");
  const [open, setOpenState] = createSignal(want());
  createEffect(
    on(want, (v) => {
      if (v === open()) return;
      // one box that grows or shrinks in place: no cross-fade of two pictures
      const box = wrap.querySelector<HTMLElement>(".composer");
      if (!box || matchMedia("(prefers-reduced-motion: reduce)").matches) return setOpenState(v);
      // a pill's radius is huge on paper: use what shows (half the height), so the
      // corners ease from round to square instead of snapping at the end
      const shape = () => {
        const h = box.offsetHeight;
        const r = Math.min(parseFloat(getComputedStyle(box).borderTopLeftRadius) || 0, h / 2);
        return { height: `${h}px`, borderRadius: `${r}px` };
      };
      const from = shape();
      for (const x of [box, ...box.children]) (x as HTMLElement).getAnimations().forEach((a) => a.cancel());
      // the signal lands after this effect: switch the class now to measure the end
      wrap.classList.toggle("slim", !v);
      setOpenState(v);
      const to = shape();
      if (from.height === to.height && from.borderRadius === to.borderRadius) return;
      box.style.overflow = "hidden";
      const ease = "cubic-bezier(0.32, 0.72, 0, 1)";
      const a = box.animate([from, to], { duration: 320, easing: ease });
      const done = () => (box.style.overflow = "");
      a.onfinish = done;
      a.oncancel = done;
      // what the bigger box adds comes in as it opens, not all at once
      if (v)
        for (const c of box.children)
          (c as HTMLElement).animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], { duration: 260, delay: 60, easing: ease, fill: "backwards" });
    }, { defer: true }),
  );
  let wrap!: HTMLDivElement;

  return (
    <div
      class="composer-wrap"
      ref={wrap}
      data-pops={props.popDown ? "down" : undefined}
      classList={{ slim: !open() }}
      onPointerDown={(e) => !inStrips(e.target) && setEngaged(true)}
      onMouseDown={(e) => !inStrips(e.target) && setEngaged(true)}
      onFocusIn={(e) => !inStrips(e.target) && setEngaged(true)}
      onFocusOut={(e) => {
        // leaving by keyboard (Tab); a press elsewhere is handled by `down`
        const to = e.relatedTarget as Node | null;
        if (!pressing && to && !wrap.contains(to)) close();
      }}
    >
      <Show when={props.top}>
        <div class="strips">{props.top}</div>
      </Show>
      <form
        class="composer"
        classList={{ big: props.big, drop: dragging() && dropTarget()?.add === add }}
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            el.focus();
          }
        }}
      >
        <Show when={pick()}>
          {(p) => (
            <div class="cpick" role="listbox" onMouseDown={(e) => e.preventDefault()}>
              <div class="cpick-head">{p().kind === "cmd" ? t("명령") : t("파일")}</div>
              <For each={p().items as (Command | string)[]}>
                {(it, i) => (
                  <button type="button" class="cpick-row" classList={{ on: sel() === i() }} onMouseEnter={() => setSel(i())} onClick={() => choose(i())}>
                    <Show
                      when={typeof it !== "string" && it}
                      fallback={
                        <>
                          <Icon name="file" size={14} />
                          <span class="cpick-name">{base(it as string)}</span>
                          <span class="cpick-desc" title={it as string}>{midTrim((it as string).split("/").slice(0, -1).join("/"), 48)}</span>
                        </>
                      }
                    >
                      {(c) => (
                        <>
                          <Icon name={c().icon ?? "dot"} size={14} />
                          <span class="cpick-name">/{c().name}</span>
                          <span class="cpick-desc">{c().desc}</span>
                          <Show when={c().keys}><kbd class="cpick-kbd">{c().keys}</kbd></Show>
                        </>
                      )}
                    </Show>
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>
        <Show when={files().length || quotes().length}>
          <div class="attach-row">
            {/* a quoted bit sits with the attachments, as a small card of its own */}
            <For each={quotes()}>
              {(q) => (
                <span class="cquote" title={q}>
                  <Icon name="quote" size={13} />
                  <span class="cquote-text">{q}</span>
                  <button type="button" class="cquote-x" aria-label={t("인용 빼기")} title={t("인용 빼기")} onClick={() => setQuotes((l) => l.filter((x) => x !== q))}>
                    <Icon name="x" size={11} />
                  </button>
                </span>
              )}
            </For>
            <For each={files()}>
              {(f) => (
                <Show
                  when={isImage(f)}
                  fallback={
                    <span class="attach" title={tilde(f)}>
                      <Icon name="file" size={13} />
                      <span class="attach-name">{base(f)}</span>
                      <button type="button" aria-label={t("제거")} title={t("제거")} onClick={() => setFiles((l) => l.filter((x) => x !== f))}>
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  }
                >
                  <span class="attach-img" title={tilde(f)}>
                    <img src={fileSrc(f)} alt={base(f)} onClick={() => openImage(f, files().filter(isImage))} />
                    <button type="button" aria-label={t("제거")} title={t("제거")} onClick={() => setFiles((l) => l.filter((x) => x !== f))}>
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                </Show>
              )}
            </For>
          </div>
        </Show>
        <textarea
          id={props.id}
          ref={(r) => {
            el = r;
            // a pane beside the focused one doesn't take the cursor when it opens
            if (props.autofocus) setTimeout(() => (!pane || pane.focused()) && r.focus(), 30);
          }}
          rows={1}
          value={text()}
          placeholder={props.placeholder}
          data-shortcut={props.id === "main-input" || props.id === "task-input" ? "focusInput" : undefined}
          aria-label={t("메시지")}
          title={`${t("메시지")} ${shortcutHint("focusInput")}`.trim()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            grow();
            void refresh();
            props.onTyping?.();
          }}
          onBlur={() => setTimeout(() => setPick(null), 120)}
          onPaste={async (e) => {
            // files copied as files (Finder, a screenshot tool): the web view only gets their names
            const plain = e.clipboardData?.getData("text/plain") ?? "";
            const names = plain.split("\n").map((l) => l.trim()).filter(Boolean);
            const fileish = names.length > 0 && names.length <= 20 && names.every((n) => /^[^/\\:*?"<>|]+\.[A-Za-z0-9]{1,6}$/.test(n) || n.startsWith("/"));
            if (fileish || e.clipboardData?.types.includes("Files")) {
              e.preventDefault();
              const at = el.selectionStart ?? el.value.length;
              const end = el.selectionEnd ?? at;
              const paths = await clipboardFiles().catch(() => [] as string[]);
              if (paths.length) return add(paths);
              const blobs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
              for (const f of blobs) {
                const path = await savePaste([...new Uint8Array(await f.arrayBuffer())], f.type.split("/")[1] ?? "png");
                if (path) add([path]);
              }
              if (blobs.length || !plain) return;
              // not files after all: paste the text as usual
              const next = `${el.value.slice(0, at)}${plain}${el.value.slice(end)}`;
              el.value = next;
              setText(next);
              el.setSelectionRange(at + plain.length, at + plain.length);
              grow();
              return;
            }
            const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
            if (!imgs.length) return;
            e.preventDefault();
            for (const f of imgs) {
              const path = await savePaste([...new Uint8Array(await f.arrayBuffer())], f.type.split("/")[1] ?? "png");
              if (path) add([path]);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && !e.isComposing && props.onQueue && !pick()) {
              e.preventDefault();
              send(true);
              return;
            }
            if (ignoredKey(e) || e.metaKey || e.ctrlKey || e.altKey) return;
            if (e.key === "Escape" && !pick() && noModifiers(e)) {
              e.preventDefault();
              e.stopPropagation();
              setEngaged(false);
              el.blur();
              return;
            }
            const p = pick();
            if (p && !e.isComposing) {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const n = p.items.length;
                setSel((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
                return;
              }
              if (e.key === "Tab" && p.kind === "cmd") {
                e.preventDefault();
                complete(sel());
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                choose(sel());
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setPick(null);
                return;
              }
            }
            if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.isComposing && !e.shiftKey && !e.altKey && !e.metaKey) {
              const i = back();
              // only while the input is empty or still shows an earlier message untouched
              const browsing = i !== null && text() === sent()[i];
              if (e.key === "ArrowUp" && sent().length && (!text() || browsing)) {
                e.preventDefault();
                recall(i === null ? sent().length - 1 : Math.max(0, i - 1));
                return;
              }
              if (e.key === "ArrowDown" && browsing) {
                e.preventDefault();
                recall(i < sent().length - 1 ? i + 1 : null);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div class="composer-bar">
          <div class="plus-wrap">
            <button
              type="button"
              class="cbtn"
              classList={{ on: plusOpen() }}
              title={t("첨부 및 기타")}
              aria-label={t("첨부 및 기타")}
              onClick={(e) => {
                e.stopPropagation();
                setPlusOpen(!plusOpen());
              }}
            >
              <Icon name="plus" size={16} />
            </button>
            <Show when={plusOpen()}>
              <div
                class="plus-menu"
                role="menu"
                onClick={(e) => e.stopPropagation()}
              >
                <For each={plusItems()}>
                  {(it, i) => (
                    <>
                      <Show when={it.section && it.section !== plusItems()[i() - 1]?.section}>
                        <div class="plus-sec">{it.section}</div>
                      </Show>
                      <button
                        type="button"
                        class="plus-row"
                        role="menuitem"
                        onClick={() => {
                          setPlusOpen(false);
                          it.run({ insert });
                        }}
                      >
                        <Icon name={it.icon} size={16} />
                        <span class="plus-label">{it.label}</span>
                        <Show when={it.desc}><span class="plus-desc" title={it.desc}>{it.desc}</span></Show>
                        <Show when={it.keys}><kbd class="cpick-kbd">{it.keys}</kbd></Show>
                      </button>
                    </>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <div class="composer-meta">{props.left}</div>
          <div class="composer-right">{props.right}</div>
          <Show
            when={props.running && props.onStop && !text().trim()}
            fallback={
              <button class="send" type="submit" disabled={!ready()} aria-label={t("보내기")} title={t("보내기 (↵)")}>
                <Icon name="send" size={14} stroke={2.25} />
              </button>
            }
          >
            <Show
              when={props.stopKind === "stop"}
              fallback={
                <button class="send stop pause" type="button" onClick={() => props.onStop?.()} aria-label={t("작업 일시정지")} title={t("작업 일시정지")}>
                  <span class="pause-glyph"><b /><b /></span>
                </button>
              }
            >
              <button class="send stop" type="button" onClick={() => props.onStop?.()} aria-label={t("응답 중지")} title={t("응답 중지")}>
                <i />
              </button>
            </Show>
          </Show>
        </div>
        <Show when={dragging() && dropTarget()?.add === add}>
          <div class="drop-hint">{t("놓아서 첨부")}</div>
        </Show>
      </form>
      <Show when={props.under || props.status}>
        <div class="ctray" classList={{ open: open() }} aria-hidden={!open()}>
          <div class="ctray-in">
            <Show when={props.under}><div class="composer-under">{props.under}</div></Show>
            <Show when={props.status}><div class="composer-status">{props.status}</div></Show>
          </div>
        </div>
      </Show>
    </div>
  );
}
