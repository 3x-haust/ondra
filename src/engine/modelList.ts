// Model lists per account, shown at once: the last list is kept (localStorage) and
// refreshed in the background, so pickers never wait for an engine to start (~2s).
// Also the order people expect: what you use most, then the newest of each family,
// and older versions / dated snapshots folded away.
import { createStore } from "solid-js/store";
import { engineModels } from "../lib/native";
import { state } from "../state/store";

const KEY = "ondra.models.v1";
const read = (): Record<string, string[]> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};
const [lists, setLists] = createStore<Record<string, string[]>>(read());
const inflight = new Map<string, Promise<string[]>>();
const fresh = new Set<string>();

/** Ask the engine again (once per app run unless forced, e.g. after a login). */
export function refreshModels(accountId: string, force = false): Promise<string[]> {
  if (!force && fresh.has(accountId)) return Promise.resolve(lists[accountId] ?? []);
  const going = inflight.get(accountId);
  if (going && !force) return going;
  const p = engineModels(accountId)
    .then((l) => {
      fresh.add(accountId);
      if (l.length) {
        setLists(accountId, l);
        try {
          localStorage.setItem(KEY, JSON.stringify(lists));
        } catch {
          /* private mode */
        }
      }
      return l.length ? l : (lists[accountId] ?? []);
    })
    .catch(() => lists[accountId] ?? [])
    .finally(() => inflight.delete(accountId));
  inflight.set(accountId, p);
  return p;
}

/** The list right now (reactive); undefined until first known. */
export const modelsNow = (accountId: string): string[] | undefined => lists[accountId];

/** Kept list at once (refreshing behind), or wait for the first one. */
export async function modelsOf(accountId: string): Promise<string[]> {
  const have = lists[accountId];
  if (have?.length) {
    void refreshModels(accountId);
    return have;
  }
  return refreshModels(accountId);
}

/** At app start: every logged-in account's list, quietly. */
export function warmModels() {
  for (const a of state.accounts) if (a.providers.length) void refreshModels(a.id);
}

// ───────────── order

type Parsed = { m: string; provider: string; family: string; version: number[]; dated: boolean };
function parse(m: string): Parsed {
  const [provider, ...rest] = m.split("/");
  const id = rest.join("/") || provider;
  const dated = /-\d{8}$|-\d{4}-\d{2}-\d{2}$|-latest$|-preview(-\d+)?$/.test(id);
  const base = id.replace(/-\d{8}$|-\d{4}-\d{2}-\d{2}$/, "");
  const version = (base.match(/\d+/g) ?? []).map(Number);
  // "claude-opus-5-5" → "claude-opus", "gpt-6.1-sol" → "gpt-sol", "claude-3-5-sonnet" → "claude-sonnet"
  const family = base.replace(/[-.]?\d+(?=[-.]|$)/g, "").replace(/--+/g, "-").replace(/^-|-$/g, "") || base;
  return { m, provider, family, version, dated };
}
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
  return 0;
};

/** How often each model was used (jobs + account defaults). */
function uses(): Map<string, number> {
  const n = new Map<string, number>();
  for (const t of state.tasks) if (t.model) n.set(t.model, (n.get(t.model) ?? 0) + 1);
  for (const a of state.accounts) if (a.model) n.set(a.model, (n.get(a.model) ?? 0) + 2);
  return n;
}

/** light / cheap tiers go after the full ones */
const small = (p: Parsed) => (/haiku|mini|nano|lite|flash|luna/.test(p.family) ? 1 : 0);

export type Ranked = { often: string[]; latest: [provider: string, models: string[]][]; older: string[] };

export function rankModels(list: string[]): Ranked {
  const used = uses();
  const all = list.map(parse);
  const byFam = new Map<string, Parsed[]>();
  for (const p of all) {
    const k = `${p.provider}/${p.family}`;
    byFam.set(k, [...(byFam.get(k) ?? []), p]);
  }
  const latestSet = new Set<string>();
  for (const ps of byFam.values()) {
    const clean = ps.filter((p) => !p.dated);
    const top = (clean.length ? clean : ps).sort((a, b) => newer(a.version, b.version))[0];
    if (top) latestSet.add(top.m);
  }
  const often = [...used.entries()]
    .filter(([m]) => list.includes(m))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([m]) => m);
  const famUse = (p: Parsed) => all.filter((x) => x.provider === p.provider && x.family === p.family).reduce((s, x) => s + (used.get(x.m) ?? 0), 0);
  const providers = [...new Set(all.map((p) => p.provider))];
  const latest = providers
    .map((pv): [string, string[]] => [
      pv,
      all
        .filter((p) => p.provider === pv && latestSet.has(p.m) && !often.includes(p.m))
        .sort((a, b) => famUse(b) - famUse(a) || small(a) - small(b) || newer(a.version, b.version) || a.family.localeCompare(b.family))
        .map((p) => p.m),
    ])
    .filter(([, l]) => l.length);
  const older = all
    .filter((p) => !latestSet.has(p.m) && !often.includes(p.m))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.family.localeCompare(b.family) || newer(a.version, b.version))
    .map((p) => p.m);
  return { often, latest, older };
}
