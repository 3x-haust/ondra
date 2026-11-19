// A short sound when a job ends or needs the user, like other agent apps: on unless turned off
// in Settings › 작업 방식, at the volume picked there.
import { playSound } from "../lib/native";
import { state } from "../state/store";
import type { Task } from "../state/types";

/** Ondra's own sounds (src-tauri/sounds, made by scripts/make-sounds.py) */
const JOB_SOUNDS = { done: "done", waiting: "waiting", failed: "failed" } as const;
type SoundKind = keyof typeof JOB_SOUNDS;

export const soundOn = () => state.settings.jobSound !== false;
export const soundVolume = () => Math.min(1, Math.max(0, state.settings.jobSoundVolume ?? 0.5));

/** The sound a job's move from `was` to its status makes, if any (top-level jobs only). */
export function soundFor(t: Pick<Task, "status" | "parentId">, was: string | undefined): SoundKind | undefined {
  if (!was || was === t.status || t.parentId) return undefined;
  return t.status === "done" ? "done" : t.status === "waiting" ? "waiting" : t.status === "failed" ? "failed" : undefined;
}

let last = 0;
/** Play it, once for jobs that end together. `test`: the settings' preview, even when off. */
export function ring(kind: SoundKind, o: { test?: boolean } = {}) {
  if (!o.test && !soundOn()) return;
  const now = Date.now();
  if (!o.test && now - last < 1500) return;
  last = now;
  void playSound(JOB_SOUNDS[kind], soundVolume()).catch(() => {});
}
