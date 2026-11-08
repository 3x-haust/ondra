// The quiet row under a message (shown on hover): time, copy, edit, retry.
// A user message can be edited in place: the conversation goes back to that
// point and continues from the new text.
import { skillAsk } from "./Aside";
import { createSignal, For, onMount, Show } from "solid-js";
import { fileSrc } from "../lib/native";
import { isImage } from "./Composer";
import { openImage } from "./Lightbox";
import { editing, previewFile, setEditing } from "../state/ui";
import { stamp } from "./bits";
import { Icon } from "./Icon";
import { t } from "../i18n";

export function MsgActions(props: { text: string; at?: number; mine?: boolean; onEdit?: () => void; onRetry?: () => void }) {
  const [copied, setCopied] = createSignal(false);
  let timer: number | undefined;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.text);
    } catch {
      // the clipboard API can be refused: the old way still copies a selection
      const ta = Object.assign(document.createElement("textarea"), { value: props.text });
      ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (!ok) return;
    }
    // the icon turns into a check for a moment (and the row stays shown meanwhile)
    setCopied(true);
    clearTimeout(timer);
    timer = window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <div class="msg-actions" classList={{ mine: props.mine, copied: copied() }}>
      <Show when={props.mine && props.at}>
        <span class="msg-time">{stamp(props.at!)}</span>
      </Show>
      <button class="msg-act" classList={{ done: copied() }} title={copied() ? t("복사했어요") : t("복사")} aria-label={copied() ? t("복사했어요") : t("복사")} onClick={copy}>
        <Icon name={copied() ? "check" : "copy"} size={14} />
      </button>
      <Show when={props.onEdit}>
        <button class="msg-act" title={t("수정")} aria-label={t("수정")} onClick={() => props.onEdit?.()}>
          <Icon name="pencil" size={14} />
        </button>
      </Show>
      <Show when={props.onRetry}>
        <button class="msg-act" title={t("다시 시도")} aria-label={t("다시 시도")} onClick={() => props.onRetry?.()}>
          <Icon name="refresh" size={14} />
        </button>
      </Show>
    </div>
  );
}

/** A user message: grey bubble on the right, time / copy / edit on hover. */
export function UserMsg(props: { text: string; at?: number; from?: string; id?: string; onEdit?: (text: string) => void }) {
  const open = () => !!props.id && editing() === props.id;
  /** "…\n\n첨부한 파일:\n- a\n- b" → text and files */
  const split = () => {
    // files alone ("첨부한 파일:\n- a") or after the text ("…\n\n첨부한 파일:\n- a")
    const i = props.text.startsWith("첨부한 파일:\n") ? 0 : props.text.indexOf("\n\n첨부한 파일:\n");
    if (i < 0) return { body: props.text, files: [] as string[] };
    const files = props.text.slice(i).split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim());
    return { body: props.text.slice(0, i), files };
  };
  return (
    <div class="user-turn" classList={{ editing: open() }} data-mid={props.id}>
      <Show when={props.from}><div class="msg-from">{props.from}</div></Show>
      <Show
        when={open()}
        fallback={
          <>
            <Show when={split().body}>
              {/* a /skill: request shows the skill as a chip, not the line that tells main to use it */}
              <div class="msg-user">
                <For each={skillAsk(split().body).skills}>{(n) => <span class="msg-skill"><Icon name="skill" size={12} />{n}</span>}</For>
                {skillAsk(split().body).rest}
              </div>
            </Show>
            <Show when={split().files.length}>
              <div class="msg-files">
                <For each={split().files}>
                  {(f) => (
                    <Show
                      when={isImage(f)}
                      fallback={
                        <button class="msg-file" title={f} onClick={() => previewFile(f)}>
                          <Icon name="file" size={13} />
                          <span>{f.split("/").pop()}</span>
                        </button>
                      }
                    >
                      <img class="msg-img" src={fileSrc(f)} alt="" title={f.split("/").pop()} onClick={() => openImage(f, split().files.filter(isImage))} />
                    </Show>
                  )}
                </For>
              </div>
            </Show>
          </>
        }
      >
        <EditBox
          text={props.text}
          onCancel={() => setEditing(null)}
          onSave={(t) => {
            setEditing(null);
            // 보내기 always sends it again, changed or not
            if (t.trim()) props.onEdit?.(t.trim());
          }}
        />
      </Show>
      <Show when={!open()}>
        <MsgActions text={props.text} at={props.at} mine onEdit={props.onEdit && props.id ? () => setEditing(props.id!) : undefined} />
      </Show>
    </div>
  );
}

function EditBox(props: { text: string; onCancel: () => void; onSave: (t: string) => void }) {
  let el!: HTMLTextAreaElement;
  const grow = () => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  };
  onMount(() => {
    el.value = props.text;
    grow();
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  return (
    <div class="msg-edit">
      <textarea
        ref={el}
        rows={1}
        onInput={grow}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            props.onCancel();
          } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            props.onSave(el.value);
          }
        }}
      />
      <div class="msg-edit-bar">
        <span class="spacer" />
        <button class="btn sm ghost" onClick={() => props.onCancel()}>{t("취소")}</button>
        <button class="btn sm primary" onClick={() => props.onSave(el.value)}>{t("보내기")}</button>
      </div>
    </div>
  );
}
