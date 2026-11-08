// Small shared pieces: status dot and labels, time formatting, a ticking clock.
import { createSignal, Show } from "solid-js";
import type { Status, Task } from "../state/types";
import { openUrl } from "../lib/native";

export const statusLabel: Record<Status, string> = {
  running: "진행 중",
  waiting: "답 필요",
  queued: "대기",
  done: "완료",
  paused: "멈춤",
  failed: "실패",
};

export const priorityLabel = ["긴급", "높음", "보통", "낮음"] as const;

export function Dot(props: { status: Status }) {
  return <span class={`dot ${props.status}`} aria-label={statusLabel[props.status]} />;
}

/** "#12" for a job started from a GitHub issue; opens the issue */
export function IssueTag(props: { t: Task }) {
  return (
    <Show when={props.t.issue}>
      {(i) => (
        <span
          class="issue-tag"
          role="link"
          title={`GitHub에서 #${i().n} 열기`}
          onClick={(e) => (e.stopPropagation(), void openUrl(i().url))}
        >
          #{i().n}
        </span>
      )}
    </Show>
  );
}

const [tick, setTick] = createSignal(Date.now());
setInterval(() => setTick(Date.now()), 1000);
/** Current time, updated every second. */
export const now = tick;

/** 45s, 3m, 1h 4m */
export function short(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

/** 2분 14초, 1시간 4분 */
export function long(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`;
  return `${Math.floor(m / 60)}시간 ${m % 60}분`;
}

export function ago(t?: number) {
  if (!t) return "";
  const m = Math.max(0, Math.round((now() - t) / 60_000));
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}일 전` : new Date(t).toLocaleDateString("ko-KR", { month: "short", day: "numeric" });
}

export function tokens(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Compact age for tight rows: 방금 / 13분 / 3시간 / 2일. */
export function compact(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간`;
  return `${Math.floor(h / 24)}일`;
}

/** 오후 7:04 (today) or 9월 27일 오전 4:49. */
export function stamp(t: number) {
  const d = new Date(t);
  const time = d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString("ko-KR", { month: "long", day: "numeric" })} ${time}`;
}
