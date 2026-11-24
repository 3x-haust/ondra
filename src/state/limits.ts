// Plan limits per account (5-hour / weekly windows), asked from the provider.
// Refreshed on start, every two minutes for every account, when the window comes
// back to the front, and after each turn; never stored.
import { createStore } from "solid-js/store";
import { accountEmail, accountLimits, type Limit } from "../lib/native";
import { t } from "../i18n";

const [limits, setLimits] = createStore<Record<string, Limit[]>>({});
const asked = new Map<string, number>();

export { limits };

/** An account's windows as they stand at `at`: a window past its reset time has started over at 0%. */
export const usageOf = (accountId: string, at = Date.now()): Limit[] =>
  (limits[accountId] ?? []).filter((l) => l.window > 0).map((l) => (l.resetsAt && l.resetsAt <= at ? { ...l, used: 0, resetsAt: undefined } : l));

/** Paid credits that keep an account going past its plan, if it has any: "12.5" / "무제한" / "$61.95 / $200.00". */
export const creditsOf = (accountId: string): string | undefined => (limits[accountId] ?? []).find((l) => l.window === 0 && l.credits)?.credits;

let watching = false;
/** Keep every account's numbers fresh, also while the window is in the back (its timers slow down there). */
export function watchLimits(accountIds: () => string[]) {
  if (watching) return;
  watching = true;
  const all = (force: boolean) => {
    for (const id of accountIds()) void refreshLimits(id, force);
  };
  setInterval(() => all(true), 2 * 60_000);
  window.addEventListener("focus", () => all(false));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) all(false);
  });
}

export async function refreshLimits(accountId: string, force = false) {
  const last = asked.get(accountId) ?? 0;
  if (!force && Date.now() - last < 60_000) return;
  asked.set(accountId, Date.now());
  try {
    const l = await accountLimits(accountId);
    if (l.length) setLimits(accountId, l);
  } catch {
    /* best effort */
  }
}

/** "5시간" / "주간" / "N일", in the current language */
export function windowLabel(min: number) {
  if (min <= 300) return t("5시간");
  if (min >= 10_000 && min <= 10_100) return t("주간");
  if (min >= 1440) return t("{n}일", { n: Math.round(min / 1440) });
  return t("{n}시간", { n: Math.round(min / 60) });
}

/** How far a plan window has run (0–1) at `at`, when its length and reset time are known. */
export function elapsedOf(l: Pick<Limit, "window" | "resetsAt">, at = Date.now()): number | undefined {
  if (!l.resetsAt || l.window <= 0) return undefined;
  const len = l.window * 60_000;
  return Math.max(0, Math.min(1, (len - (l.resetsAt - at)) / len));
}

export type Pace = "ahead" | "on" | "under";
/** Spending faster than the window runs ("ahead"), about with it ("on"), or slower ("under"); 5 points either way. */
export function paceOf(l: Pick<Limit, "window" | "resetsAt" | "used">, at = Date.now()): Pace | undefined {
  const e = elapsedOf(l, at);
  if (e === undefined) return undefined;
  const gap = l.used - e * 100;
  return gap > 5 ? "ahead" : gap < -5 ? "under" : "on";
}

/** "40분" / "2시간" / "3일": how long until a plan window starts over */
export function resetIn(ms: number) {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return t("{m}분", { m });
  const h = Math.round(m / 60);
  return h < 48 ? t("{n}시간", { n: h }) : t("{n}일", { n: Math.round(h / 24) });
}

/** what a usage note keeps: the windows as they were then */
export const snapshot = (accountId: string) => (limits[accountId] ?? []).filter((l) => l.window > 0).map((l) => ({ window: l.window, used: Math.round(l.used) }));

/** Who each account is logged in as. */
export const [emails, setEmails] = createStore<Record<string, string>>({});
const askedEmail = new Set<string>();
export async function loadEmail(accountId: string) {
  if (askedEmail.has(accountId)) return;
  askedEmail.add(accountId);
  const e = await accountEmail(accountId);
  if (e) setEmails(accountId, e);
}
