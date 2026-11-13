// 루틴의 시간 계산: when a routine runs next, and how its timing reads. Pure (local time).
import type { RoutineWhen } from "../state/types";
import { t } from "../i18n";

export const MIN_EVERY = 15;
/** a run missed by more than this (the Mac slept, Ondra was closed) runs once when it can, not again and again */
export const LATE_OK = 12 * 3_600_000;

const hm = (time: string): [number, number] | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? [h, min] : undefined;
};
export const validTime = (time: string) => !!hm(time);

/** The next time after `from` (ms) this routine should start; undefined: none (events, a done "once"). */
export function nextRun(when: RoutineWhen, from: number): number | undefined {
  if (when.kind === "every") return from + Math.max(MIN_EVERY, Math.round(when.minutes)) * 60_000;
  if (when.kind === "once") return when.at > from ? when.at : undefined;
  if (when.kind === "event") return undefined;
  const at = hm(when.time);
  if (!at) return undefined;
  const days = when.days?.length ? new Set(when.days) : undefined;
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setHours(at[0], at[1]);
  for (let i = 0; i < 8; i++) {
    if (d.getTime() > from && (!days || days.has(d.getDay()))) return d.getTime();
    // the next calendar day at the same wall time (DST keeps the hour)
    d.setDate(d.getDate() + 1);
    d.setHours(at[0], at[1], 0, 0);
  }
  return undefined;
}

const DAY_NAMES = ["일|day", "월|day", "화|day", "수|day", "목|day", "금|day", "토|day"];
const WEEKDAYS = [1, 2, 3, 4, 5];

/** "매일 09:00", "평일 09:00", "월·수 18:30", "30분마다", "새 이슈가 오면" … */
export function describeWhen(when: RoutineWhen): string {
  switch (when.kind) {
    case "every": {
      const m = Math.max(MIN_EVERY, Math.round(when.minutes));
      return m % 1440 === 0 ? t("{n}일마다", { n: m / 1440 }) : m % 60 === 0 ? t("{n}시간마다", { n: m / 60 }) : t("{n}분마다", { n: m });
    }
    case "once": {
      const d = new Date(when.at);
      return t("{date} 한 번", { date: `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` });
    }
    case "event":
      return EVENT_LABEL[when.event] ? t(EVENT_LABEL[when.event]) : when.event;
    case "daily": {
      const days = [...new Set(when.days ?? [])].sort();
      const which =
        !days.length || days.length === 7
          ? t("매일")
          : days.join() === WEEKDAYS.join()
            ? t("평일")
            : days.join() === "0,6"
              ? t("주말")
              : days.map((d) => t(DAY_NAMES[d])).join("·");
      return `${which} ${when.time}`;
    }
  }
}

export const EVENT_LABEL: Record<string, string> = {
  issue: "새 이슈가 오면",
  pr: "새 PR이 오면",
  review: "내게 리뷰 요청이 오면",
  comment: "내 PR에 댓글·리뷰가 달리면",
  ci: "기본 브랜치 CI가 실패하면",
  release: "새 릴리즈가 나오면",
};

const EVENTS = ["issue", "pr", "review", "comment", "ci", "release"] as const;

/** A "when" as main wrote it (loose JSON) → a valid one, or undefined. */
export function parseWhen(v: unknown, now = Date.now()): RoutineWhen | undefined {
  if (!v || typeof v !== "object") return undefined;
  const w = v as Record<string, unknown>;
  switch (w.kind) {
    case "daily": {
      const time = typeof w.time === "string" && validTime(w.time) ? w.time.trim().padStart(5, "0") : undefined;
      if (!time) return undefined;
      const days = Array.isArray(w.days) ? [...new Set(w.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
      return days.length && days.length < 7 ? { kind: "daily", time, days } : { kind: "daily", time };
    }
    case "every": {
      const m = Number(w.minutes ?? (Number(w.hours) || 0) * 60);
      return Number.isFinite(m) && m > 0 ? { kind: "every", minutes: Math.max(MIN_EVERY, Math.round(m)) } : undefined;
    }
    case "once": {
      const at = typeof w.at === "number" ? w.at : typeof w.at === "string" ? Date.parse(w.at) : NaN;
      return Number.isFinite(at) && at > now - 60_000 ? { kind: "once", at } : undefined;
    }
    case "event": {
      const event = EVENTS.find((e) => e === w.event);
      if (!event) return undefined;
      const filter = typeof w.filter === "string" && w.filter.trim() ? w.filter.trim().slice(0, 200) : undefined;
      return filter ? { kind: "event", event, filter } : { kind: "event", event };
    }
  }
  return undefined;
}
