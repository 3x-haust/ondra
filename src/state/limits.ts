// Plan limits per account (5-hour / weekly windows), asked from the provider.
// Refreshed on start, every two minutes for every account, when the window comes
// back to the front, and after each turn; never stored.
import { createStore } from "solid-js/store";
import { accountEmail, accountLimits, type Limit } from "../lib/native";

const [limits, setLimits] = createStore<Record<string, Limit[]>>({});
const asked = new Map<string, number>();

export { limits };

/** An account's windows as they stand at `at`: a window past its reset time has started over at 0%. */
export const usageOf = (accountId: string, at = Date.now()): Limit[] =>
  (limits[accountId] ?? []).map((l) => (l.resetsAt && l.resetsAt <= at ? { ...l, used: 0, resetsAt: undefined } : l));

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

/** "5시간" / "주간" / "N일" */
export function windowLabel(min: number) {
  if (min <= 300) return "5시간";
  if (min >= 10_000 && min <= 10_100) return "주간";
  if (min >= 1440) return `${Math.round(min / 1440)}일`;
  return `${Math.round(min / 60)}시간`;
}

/** what a usage note keeps: the windows as they were then */
export const snapshot = (accountId: string) => (limits[accountId] ?? []).map((l) => ({ window: l.window, used: Math.round(l.used) }));

/** Who each account is logged in as. */
export const [emails, setEmails] = createStore<Record<string, string>>({});
const askedEmail = new Set<string>();
export async function loadEmail(accountId: string) {
  if (askedEmail.has(accountId)) return;
  askedEmail.add(accountId);
  const e = await accountEmail(accountId);
  if (e) setEmails(accountId, e);
}
