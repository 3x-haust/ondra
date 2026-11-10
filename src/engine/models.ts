// Picking a model that actually works for an account, without asking.
// Start with the account's model (or the engine default); when the provider
// rejects it, remember that and move to the next candidate.
import { accountById, updateAccount } from "../state/store";
import { modelsOf } from "./modelList";
import { canUseTools } from "./connections";

const RANK = [/opus/i, /sonnet/i, /gpt-6/i, /gpt-5\.6/i, /gpt-5/i, /gemini.*pro/i, /claude/i, /gpt/i];
const WEAK = /mini|nano|haiku|flash|lite/i;
const score = (m: string) => {
  const i = RANK.findIndex((r) => r.test(m));
  return (i < 0 ? RANK.length : i) + (WEAK.test(m) ? 20 : 0);
};

const idOf = (m: string) => m.split("/").pop() ?? m;

/** The model to pass with --model, or undefined for the engine default. */
/** the account's default 생각 깊이 */
/** The level picked for a model on this account (each model keeps its own); `model` defaults to the account's. */
export function effortFor(accountId: string, model?: string): string | undefined {
  const a = accountById(accountId);
  if (!a) return undefined;
  const m = model || a.model;
  return (m && a.efforts?.[m]) || a.effort || undefined;
}
/** Remember a level for one model of an account (and make that model the account's when given). */
export function setModelEffort(x: { model: string; effort?: string; efforts?: Record<string, string> }, model: string, effort: string) {
  if (model) x.model = model;
  const m = model || x.model;
  if (m && effort) x.efforts = { ...(x.efforts ?? {}), [m]: effort };
}

export function modelFor(accountId: string): string | undefined {
  const a = accountById(accountId);
  return a?.model || undefined;
}

/**
 * The current model failed for this account. Mark it bad and switch to the
 * best remaining candidate. Returns the new model, or null when none is left.
 */
export async function nextModel(accountId: string, failed: string | undefined): Promise<string | null> {
  const a = accountById(accountId);
  if (!a) return null;
  const bad = new Set(a.badModels.map(idOf));
  if (failed) bad.add(idOf(failed));
  if (a.model) bad.add(idOf(a.model));
  const all = await modelsOf(accountId);
  const logged = a.providers;
  const pool = all
    .filter((m) => !bad.has(idOf(m)))
    .filter((m) => !logged.length || logged.some((p) => m.startsWith(`${p}/`)))
    // a connection's model that can use tools before one that can't
    .sort((x, y) => Number(!canUseTools(accountId, x)) - Number(!canUseTools(accountId, y)) || score(x) - score(y));
  const pick = pool[0] ?? null;
  updateAccount(accountId, (x) => {
    x.badModels = [...bad];
    x.model = pick ?? "";
  });
  return pick;
}

/** The model name inside a provider error, e.g. 'gpt-5.5'. */
export const failedModelIn = (message: string) => message.match(/'([^']+)' model/i)?.[1];
