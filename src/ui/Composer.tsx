// The one input (a new request, or a follow-up to one task).
// Card with the text area; a bar below it: [+] and left chips, right chips,
// send ↔ stop. Strips (paused, plan, background…) dock on top, an optional
// row sits under the card. Files can be attached with + or dropped on the window.
// Enter sends (never mid-IME), Shift+Enter is a new line.
import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { fileSrc, inTauri, pickFiles, savePaste } from "../lib/native";
import { usePop } from "./ModelPicker";
import { openImage } from "./Lightbox";
import { tilde } from "../engine/rpc";
import { Icon } from "./Icon";

/** The composer on screen receives dropped files (there is one per view). */
let dropInto: ((paths: string[]) => void) | null = null;
const [dragging, setDragging] = createSignal(false);
let listening = false;
async function listenDrops() {
  if (listening || !inTauri) return;
  listening = true;
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  await getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") setDragging(!!dropInto);
    else if (p.type === "leave") setDragging(false);
    else if (p.type === "drop") {
      setDragging(false);
      if (p.paths.length) dropInto?.(p.paths);
    }
  });
}

const base = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
export const isImage = (p: string) => /\.(png|jpe?g|gif|webp|heic|bmp|svg)$/i.test(p);

/** An entry of the + menu. */
export interface PlusItem {
  section?: string;
  icon: string;
  label: string;
  desc?: string;
  run: (api: { insert: (text: string) => void }) => void;
}

export interface Command {
  name: string;
  desc: string;
  icon?: string;
  /** keep the text after the command as an argument */
  run: (arg: string) => void;
}

type Pick = { kind: "cmd"; items: Command[]; q: string } | { kind: "file"; items: string[]; q: string; at: number };

export function Composer(props: {
  placeholder: string;
  onSend: (text: string) => void;
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
  /** strips docked on top of the input (plan progress, background commands…) */
  top?: JSX.Element;
  /** "/" menu: things you can do from the input */
  commands?: Command[];
  /** "@" menu: files you can point at (relative paths) */
  files?: () => Promise<string[]>;
  /** ↑ in an empty input: edit what you sent last */
  onEditLast?: () => void;
  /** quiet info inside the bar: account, plan windows, context */
  status?: JSX.Element;
  /** more entries for the + menu (after "파일 및 폴더") */
  plus?: PlusItem[];
}) {
  const [text, setText] = createSignal("");
  const [plusOpen, setPlusOpen] = usePop();
  const plusItems = (): PlusItem[] => [
    {
      icon: "clip",
      label: "파일 및 폴더",
      desc: "끌어다 놓거나 ⌘V로 사진을 붙여도 돼요",
      run: async () => {
        const picked = await pickFiles("첨부할 파일");
        if (picked.length) add(picked);
      },
    },
    ...(props.plus ?? []),
  ];
  const [files, setFiles] = createSignal<string[]>([]);
  let el!: HTMLTextAreaElement;

  const add = (paths: string[]) => {
    setFiles((f) => [...f, ...paths.filter((p) => !f.includes(p))]);
    el?.focus();
  };
  onMount(() => {
    dropInto = add;
    void listenDrops();
  });
  onCleanup(() => {
    if (dropInto === add) dropInto = null;
  });

  const grow = () => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  };
  // ── "/" commands and "@" files
  const [pick, setPick] = createSignal<Pick | null>(null);
  const [sel, setSel] = createSignal(0);
  let fileList: string[] | null = null;
  const refresh = async () => {
    const v = el.value;
    const caret = el.selectionStart ?? v.length;
    const cmd = /^\/(\S*)$/.exec(v.slice(0, caret));
    if (cmd && props.commands?.length) {
      const q = cmd[1].toLowerCase();
      const items = props.commands.filter((c) => c.name.toLowerCase().startsWith(q) || c.desc.includes(q));
      setPick(items.length ? { kind: "cmd", items, q } : null);
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
      const arg = el.value.replace(/^\/\S*\s*/, "");
      setText("");
      el.value = "";
      setPick(null);
      queueMicrotask(grow);
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
    const next = `/${p.items[i].name} `;
    setText(next);
    el.value = next;
    el.setSelectionRange(next.length, next.length);
    setPick(null);
    grow();
  };
  const insert = (t: string) => {
    const v = el.value;
    const next = v && !v.endsWith(" ") && !t.startsWith("/") ? `${v} ${t}` : t.startsWith("/") ? `${t}${v ? ` ${v}` : ""}` : `${v}${t}`;
    setText(next);
    el.value = next;
    el.focus();
    el.setSelectionRange(next.length, next.length);
    grow();
  };

  // a picture or file alone is enough to send
  const ready = () => (!!text().trim() || files().length > 0) && !props.disabled;
  const send = () => {
    if (!ready()) return;
    // "/name what" typed out in full runs the command
    const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text().trim());
    const cmd = m && props.commands?.find((c) => c.name === m[1]);
    if (cmd) {
      setText("");
      el.value = "";
      queueMicrotask(grow);
      cmd.run(m![2] ?? "");
      return;
    }
    const f = files();
    setEngaged(false);
    const list = `첨부한 파일:\n${f.map((p) => `- ${p}`).join("\n")}`;
    props.onSend(f.length ? (text().trim() ? `${text().trim()}\n\n${list}` : list) : text().trim());
    setText("");
    setFiles([]);
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
  const want = () => !!props.big || engaged() || !!text() || files().length > 0 || plusOpen() || !!pick();
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
        classList={{ big: props.big, drop: dragging() && dropInto === add }}
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
              <div class="cpick-head">{p().kind === "cmd" ? "명령" : "파일"}</div>
              <For each={p().items as (Command | string)[]}>
                {(it, i) => (
                  <button type="button" class="cpick-row" classList={{ on: sel() === i() }} onMouseEnter={() => setSel(i())} onClick={() => choose(i())}>
                    <Show
                      when={typeof it !== "string" && it}
                      fallback={
                        <>
                          <Icon name="file" size={14} />
                          <span class="cpick-name">{base(it as string)}</span>
                          <span class="cpick-desc">{(it as string).split("/").slice(0, -1).join("/")}</span>
                        </>
                      }
                    >
                      {(c) => (
                        <>
                          <Icon name={c().icon ?? "dot"} size={14} />
                          <span class="cpick-name">/{c().name}</span>
                          <span class="cpick-desc">{c().desc}</span>
                        </>
                      )}
                    </Show>
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>
        <Show when={files().length}>
          <div class="attach-row">
            <For each={files()}>
              {(f) => (
                <Show
                  when={isImage(f)}
                  fallback={
                    <span class="attach" title={tilde(f)}>
                      <Icon name="file" size={13} />
                      <span class="attach-name">{base(f)}</span>
                      <button type="button" aria-label="빼기" onClick={() => setFiles((l) => l.filter((x) => x !== f))}>
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  }
                >
                  <span class="attach-img" title={tilde(f)}>
                    <img src={fileSrc(f)} alt={base(f)} onClick={() => openImage(f, files().filter(isImage))} />
                    <button type="button" aria-label="빼기" onClick={() => setFiles((l) => l.filter((x) => x !== f))}>
                      <Icon name="x" size={11} />
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
            if (props.autofocus) setTimeout(() => r.focus(), 30);
          }}
          rows={1}
          value={text()}
          placeholder={props.placeholder}
          onInput={(e) => {
            setText(e.currentTarget.value);
            grow();
            void refresh();
            props.onTyping?.();
          }}
          onBlur={() => setTimeout(() => setPick(null), 120)}
          onPaste={async (e) => {
            const imgs = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
            if (!imgs.length) return;
            e.preventDefault();
            for (const f of imgs) {
              const path = await savePaste([...new Uint8Array(await f.arrayBuffer())], f.type.split("/")[1] ?? "png");
              if (path) add([path]);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !pick() && !e.isComposing) {
              setEngaged(false);
              el.blur();
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
            if (e.key === "ArrowUp" && !text() && props.onEditLast) {
              e.preventDefault();
              props.onEditLast();
              return;
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
              title="첨부하고 더 하기"
              aria-label="더 하기"
              onClick={(e) => {
                e.stopPropagation();
                setPlusOpen(!plusOpen());
              }}
            >
              <Icon name="plus" size={17} />
            </button>
            <Show when={plusOpen()}>
              <div
                class="plus-menu"
                role="menu"
                onClick={(e) => e.stopPropagation()}
                ref={(el) =>
                  // fits in the room above it (under the top bar), scrolling the rest
                  queueMicrotask(() => {
                    const top = el.parentElement?.getBoundingClientRect().top ?? 0;
                    el.style.maxHeight = `${Math.max(160, Math.min(420, top - 10 - 60))}px`;
                  })
                }
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
                        <Icon name={it.icon} size={15} />
                        <span class="plus-label">{it.label}</span>
                        <Show when={it.desc}><span class="plus-desc">{it.desc}</span></Show>
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
              <button class="send" type="submit" disabled={!ready()} aria-label="보내기" title="보내기 (⏎)">
                <Icon name="send" size={16} stroke={2.25} />
              </button>
            }
          >
            <button class="send stop" type="button" onClick={() => props.onStop?.()} aria-label="멈추기" title="멈추기">
              <i />
            </button>
          </Show>
        </div>
        <Show when={dragging() && dropInto === add}>
          <div class="drop-hint">여기에 놓으면 첨부돼요</div>
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
