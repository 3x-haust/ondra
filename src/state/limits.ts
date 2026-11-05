// Plan limits per account (5-hour / weekly windows), asked from the provider.
// Refreshed on start, every few minutes, and after each turn; never stored.
import { createStore } from "solid-js/store";
import { accountEmail, accountLimits, type Limit } from "../lib/native";

const [limits, setLimits] = createStore<Record<string, Limit[]>>({});
const asked = new Map<string, number>();

export { limits };

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
