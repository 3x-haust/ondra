// What folds away under a sidebar group: finished jobs after a few minutes, and a job paused and
// left for days (nothing will pick it up by itself; it is still there, one click away).
import { t as tr } from "../i18n";
import type { Task } from "./types";
import { discarded } from "./progress";

/** paused and untouched this long: it folds away with the finished ones */
export const PAUSED_FOR = 3 * 24 * 3600_000;
const lastTouched = (t: Task) => Math.max(t.resumedAt ?? 0, t.startedAt ?? t.createdAt, ...t.entries.slice(-1).map((e) => e.at));
export const stale = (t: Task, now: number) => t.status === "paused" && !t.pinned && !discarded(t) && lastTouched(t) < now - PAUSED_FOR;

/** "완료 12개 · 멈춤 2개 · 버림 1개": what the fold holds */
export function foldLabel(tasks: Task[]): string {
  const gone = tasks.filter(discarded).length;
  const paused = tasks.filter((t) => t.status === "paused" && !discarded(t)).length;
  const n = tasks.length - gone - paused;
  return [n && tr("완료 {n}개", { n }), paused && tr("멈춤 {n}개", { n: paused }), gone && tr("버림 {n}개", { n: gone })].filter(Boolean).join(" · ");
}
