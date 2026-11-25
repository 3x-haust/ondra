// The composer's mic: press to talk, press again and the words go in at the cursor.
// Recognition runs on this Mac (ondra-dictate, Apple's on-device speech recognition);
// no audio leaves it. While recording, a small level meter and the time sit beside the
// button and the words heard so far show under the text; Esc (or a press while it is
// starting or finishing) drops it. One dictation at a time across every composer.
// The flow follows deepseek-ai/chat-demo's voice input (MIT), with its cloud ASR left out.
import { createEffect, createSignal, Index, onCleanup, Show } from "solid-js";
import { lang, t } from "../i18n";
import { logWarn } from "../lib/log";
import { dictateCancel, dictateStart, dictateStop, onDictate, openPrivacySettings } from "../lib/native";
import { toast } from "../state/ui";
import { clock, type DictateError, dictateLang, pushLevel, readDictate, smoothLevel } from "./dictation";
import { Icon } from "./Icon";

type Status = "idle" | "starting" | "recording" | "finishing";

const BARS = 14;
const quiet = () => Array<number>(BARS).fill(0);
const [status, setStatus] = createSignal<Status>("idle");
/** the composer it belongs to */
const [owner, setOwner] = createSignal<object | null>(null);
const [partial, setPartial] = createSignal("");
const [bars, setBars] = createSignal(quiet());
const [since, setSince] = createSignal(0);
/** the run in progress (0: none); the helper's lines carry it */
let run = 0;
let shown = 0;
let deliver: ((words: string) => void) | null = null;
let listening: Promise<unknown> | null = null;

const still = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function reset() {
  run = 0;
  shown = 0;
  deliver = null;
  setStatus("idle");
  setOwner(null);
  setPartial("");
  setBars(quiet());
  window.removeEventListener("keydown", onEsc, true);
}

// before the input's own Esc (which closes it) and anything else's
function onEsc(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing) return;
  e.preventDefault();
  e.stopPropagation();
  cancelDictation();
}

const pane = { "mic-denied": "microphone", "speech-denied": "speech" } as const;

function explain(code: DictateError, detail?: string) {
  logWarn("dictate", detail ? `${code}: ${detail}` : code);
  const text = {
    "mic-denied": t("마이크 권한이 꺼져 있어요. 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 Ondra를 켜 주세요."),
    "speech-denied": t("음성 인식 권한이 꺼져 있어요. 시스템 설정 › 개인정보 보호 및 보안 › 음성 인식에서 Ondra를 켜 주세요."),
    "no-mic": t("쓸 수 있는 마이크가 없어요."),
    unavailable: t("지금은 이 기기에서 음성 인식을 쓸 수 없어요."),
    "no-on-device": t("이 언어는 Mac 안에서 받아쓸 수 없어요. 시스템 설정 › 키보드에서 받아쓰기를 켠 뒤 다시 해 보세요."),
    failed: t("받아쓰기에 실패했어요."),
  }[code];
  const where = code === "mic-denied" || code === "speech-denied" ? pane[code] : null;
  toast(text, "bad", where ? { label: t("설정 열기"), run: () => void openPrivacySettings(where).catch(() => {}) } : undefined);
}

function onEvent(raw: Record<string, unknown>) {
  const ev = readDictate(raw, run);
  if (!ev) return;
  switch (ev.kind) {
    case "ready":
      setSince(Date.now());
      setStatus("recording");
      return;
    case "level":
      shown = smoothLevel(shown, ev.level);
      setBars((b) => pushLevel(b, shown, still()));
      return;
    case "partial":
      setPartial(ev.text);
      return;
    case "limit":
      setStatus("finishing");
      toast(t("2분이 지나 받아쓰기를 마쳤어요."));
      return;
    case "final": {
      const to = deliver;
      const words = ev.text.trim();
      reset();
      if (words) to?.(words);
      else toast(t("들린 말이 없어요."));
      return;
    }
    case "error":
      reset();
      explain(ev.code, ev.detail);
      return;
    case "end":
      // gone without a word: it crashed or was stopped from outside (the window was closed)
      reset();
      return;
  }
}

let seq = 0;
async function startDictation(me: object, onText: (words: string) => void) {
  cancelDictation();
  // unique across reloads of the page: a helper from before one can still say goodbye
  const id = Date.now() * 100 + (++seq % 100);
  run = id;
  deliver = onText;
  setOwner(me);
  setPartial("");
  setStatus("starting");
  window.addEventListener("keydown", onEsc, true);
  try {
    listening ??= onDictate(onEvent);
    await listening;
    // dropped while the listener was being set up
    if (run !== id) return;
    await dictateStart(id, dictateLang(lang()));
  } catch (e) {
    if (run !== id) return;
    reset();
    toast(e instanceof Error ? e.message : String(e), "bad");
  }
}

function stopDictation() {
  if (status() === "starting") return cancelDictation();
  if (status() !== "recording") return;
  setStatus("finishing");
  void dictateStop(run).catch(() => {});
}

/** Drop the dictation in progress, and what it heard. */
export function cancelDictation(me?: object) {
  if (!run || (me && owner() !== me)) return;
  const id = run;
  reset();
  void dictateCancel(id).catch(() => {});
}

/** This composer is dictating: it stays open meanwhile. */
export const dictating = (me: object) => owner() === me && status() !== "idle";

/** The words heard so far, under the text. */
export function DictateLive(props: { owner: object }) {
  return (
    <Show when={dictating(props.owner)}>
      <div class="dictate-live" classList={{ waiting: !partial() }} aria-live="polite">
        {partial() || (status() === "starting" ? t("마이크를 켜는 중…") : t("듣고 있어요…"))}
      </div>
    </Show>
  );
}

export function VoiceButton(props: { owner: object; onText: (words: string) => void }) {
  const st = (): Status => (owner() === props.owner ? status() : "idle");
  const [now, setNow] = createSignal(Date.now());
  createEffect(() => {
    if (st() !== "recording") return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 500);
    onCleanup(() => clearInterval(tick));
  });
  onCleanup(() => cancelDictation(props.owner));
  const label = () =>
    ({
      idle: t("말로 입력"),
      starting: t("받아쓰기 취소"),
      recording: t("받아쓰기 끝내기 (Esc: 취소)"),
      finishing: t("받아쓰기 취소"),
    })[st()];
  const press = () => {
    const s = st();
    if (s === "idle") void startDictation(props.owner, props.onText);
    else if (s === "recording") stopDictation();
    else cancelDictation();
  };
  return (
    <>
      <Show when={st() === "recording"}>
        <span class="dictate-meter" aria-hidden="true">
          <Index each={bars()}>{(b) => <i style={{ transform: `scaleY(${(0.12 + 0.88 * b()).toFixed(3)})` }} />}</Index>
        </span>
        <span class="dictate-clock">{clock((now() - since()) / 1000)}</span>
      </Show>
      <button
        type="button"
        class="cbtn dictate-btn"
        classList={{ on: st() !== "idle", rec: st() === "recording" }}
        aria-pressed={st() === "recording"}
        aria-label={label()}
        title={label()}
        onClick={(e) => {
          e.stopPropagation();
          press();
        }}
      >
        <Show when={st() === "starting" || st() === "finishing"} fallback={<Icon name="mic" size={16} />}>
          <span class="dictate-spin" />
        </Show>
      </button>
    </>
  );
}
