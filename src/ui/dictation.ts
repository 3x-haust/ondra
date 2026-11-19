// Dictation's plain parts (VoiceButton.tsx is the button): the helper's lines
// (src-tauri/helpers/dictate.swift), how the level meter moves, and where the words go.
import type { Lang } from "../i18n";

export type DictateError = "mic-denied" | "speech-denied" | "no-mic" | "unavailable" | "no-on-device" | "failed";
const ERRORS: DictateError[] = ["mic-denied", "speech-denied", "no-mic", "unavailable", "no-on-device", "failed"];

type DictateEvent =
  | { kind: "ready" }
  | { kind: "level"; level: number }
  | { kind: "partial"; text: string }
  | { kind: "limit" }
  | { kind: "final"; text: string }
  | { kind: "error"; code: DictateError; detail?: string }
  /** the helper is gone; after a final or an error this changes nothing */
  | { kind: "end" };

/** A "dictate" event as what it says; null for another run's, or a line this app doesn't know. */
export function readDictate(ev: Record<string, unknown>, run: number): DictateEvent | null {
  if (!run || ev.id !== run) return null;
  if (typeof ev.error === "string") {
    const code = (ERRORS as string[]).includes(ev.error) ? (ev.error as DictateError) : "failed";
    return { kind: "error", code, ...(typeof ev.detail === "string" ? { detail: ev.detail } : {}) };
  }
  if (typeof ev.final === "string") return { kind: "final", text: ev.final };
  if (typeof ev.partial === "string") return { kind: "partial", text: ev.partial };
  if (typeof ev.level === "number" && Number.isFinite(ev.level)) return { kind: "level", level: Math.min(1, Math.max(0, ev.level)) };
  if (ev.ready === true) return { kind: "ready" };
  if (ev.limit === true) return { kind: "limit" };
  if (ev.end === true) return { kind: "end" };
  return null;
}

/** The recognizer's language for the app's. */
export const dictateLang = (lang: Lang) => (lang === "en" ? "en-US" : "ko-KR");

/** The meter rises at once and falls slowly: it follows the voice without flickering. */
export const smoothLevel = (shown: number, heard: number) => shown + (heard - shown) * (heard > shown ? 0.8 : 0.3);

/** The bars after a new level: it comes in on the right and the older ones move left. With
 *  reduced motion nothing travels sideways: every bar shows the newest. */
export const pushLevel = (bars: number[], level: number, still = false) => (still ? bars.map(() => level) : [...bars.slice(1), level]);

/** "m:ss" */
export const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The words put in at the cursor (over a selection), with a space where they would
 *  otherwise run into the text beside them. `caret` is just after them. */
export function insertWords(value: string, start: number, end: number, words: string) {
  const w = words.trim();
  const before = value.slice(0, start);
  const after = value.slice(end);
  if (!w) return { value, caret: end };
  const lead = before && !/[\s([{"'“‘]$/.test(before) && !/^[.,!?;:)\]}…]/.test(w) ? " " : "";
  const trail = after && !/^[\s.,!?;:)\]}…]/.test(after) ? " " : "";
  const head = `${before}${lead}${w}`;
  return { value: `${head}${trail}${after}`, caret: head.length };
}
