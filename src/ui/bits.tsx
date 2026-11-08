// Small shared pieces: status dot and labels, time formatting, a ticking clock.
import { createSignal, Show } from "solid-js";
import type { Status, Task } from "../state/types";
import { openUrl } from "../lib/native";
import { lang, t } from "../i18n";

export const statusLabel: Record<Status, string> = {
  running: "진행 중",
  waiting: "응답 필요",
  queued: "대기",
  done: "완료",
  paused: "일시정지",
  failed: "실패",
};

export const priorityLabel = ["긴급", "높음", "보통", "낮음"] as const;

export function Dot(props: { status: Status }) {
  return <span class={`dot ${props.status}`} aria-label={t(statusLabel[props.status])} />;
}

/** "#12" for a job started from a GitHub issue; opens the issue */
export function IssueTag(props: { t: Task }) {
  return (
    <Show when={props.t.issue}>
      {(i) => (
        <span
          class="issue-tag"
          role="link"
          title={t("GitHub에서 #{n} 열기", { n: i().n })}
          onClick={(e) => (e.stopPropagation(), void openUrl(i().url))}
        >
          #{i().n}
        </span>
      )}
    </Show>
  );
}

/** The sidebar's 새 작업 screen, open in the main pane (its project, if one is picked). MainView owns it; the sidebar highlights it. */
export const [newTaskOpen, setNewTaskOpen] = createSignal<{ project?: string } | null>(null);

const [tick, setTick] = createSignal(Date.now());
setInterval(() => setTick(Date.now()), 1000);
/** Current time, updated every second. */
export const now = tick;

const locale = () => (lang() === "en" ? "en-US" : "ko-KR");

/** 45초, 3분, 1시간 4분 (45s, 3m, 1h 4m) */
export function short(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("{n}초", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("{n}분", { n: m });
  return t("{h}시간 {m}분", { h: Math.floor(m / 60), m: m % 60 });
}

/** 2분 14초, 1시간 4분 (2m 14s, 1h 4m) */
export function long(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("{n}초", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? t("{m}분 {s}초", { m, s: s % 60 }) : t("{n}분", { n: m });
  return t("{h}시간 {m}분", { h: Math.floor(m / 60), m: m % 60 });
}

/** 방금, 3분 전, 2시간 전, 어제, 4일 전, then the date */
export function ago(at?: number) {
  if (!at) return "";
  const m = Math.max(0, Math.round((now() - at) / 60_000));
  if (m < 1) return t("방금");
  if (m < 60) return t("{n}분 전", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("{n}시간 전", { n: h });
  const d = Math.floor(h / 24);
  if (d === 1) return t("어제|ago");
  return d < 30 ? t("{n}일 전", { n: d }) : new Date(at).toLocaleDateString(locale(), { month: "short", day: "numeric" });
}

/** "~/01_Project/…/ondra": long paths keep their start and their end */
export function midTrim(s: string, max: number) {
  if (s.length <= max) return s;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${s.slice(0, max - 1 - tail)}…${s.slice(s.length - tail)}`;
}

export function tokens(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** How long a running task has been at it, for tight rows: 방금 시작 / 13분째 / 3시간째 / 2일째 (13m, 3h, 2d). Past times use ago(). */
export function compact(ms: number): string {
  const m = Math.floor(ms / 60000);
  if (m < 1) return t("방금 시작");
  if (m < 60) return t("{n}분째", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("{n}시간째", { n: h });
  return t("{n}일째", { n: Math.floor(h / 24) });
}

/** A time of day: 오후 10:37 / 10:37 PM. */
export function clock(at: number) {
  return new Date(at).toLocaleTimeString(locale(), { hour: "numeric", minute: "2-digit" });
}

/** 오후 7:04 (today) or 9월 27일 오전 4:49, in the app's language. */
export function stamp(at: number) {
  const d = new Date(at);
  const time = clock(at);
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString(locale(), { month: lang() === "en" ? "short" : "long", day: "numeric" })} ${time}`;
}

/** How full a context window is, one way everywhere (the input's strip, the context sheet): 0.4%, 5.2%, 11% */
export function ctxShare(used: number, of: number) {
  const p = of ? (used / of) * 100 : 0;
  return p >= 10 ? `${Math.round(p)}%` : p >= 0.1 ? `${p.toFixed(1)}%` : "0%";
}
