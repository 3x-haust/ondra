// A card that keeps changing: a block sent again with the same "live" key replaces the earlier
// one (the newest at the end), so progress shows as one card, not a pile of copies.
import type { Block } from "../state/types";

/** the key a block carries, checked: a short word, or undefined */
export function liveKey(v: unknown): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const k = String(v).trim().slice(0, 60);
  return k || undefined;
}

/** the keys of the live blocks in a list */
export const liveKeys = (blocks: readonly unknown[]): Set<string> =>
  new Set(blocks.map((b) => liveKey((b as Block | undefined)?.live)).filter((k): k is string => !!k));
