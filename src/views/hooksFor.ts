import type { Hook } from "./Hooks";

/** the hooks a workspace's page (Settings › 훅) lists: its own, those for every workspace, and those of
 *  a workspace that isn't this device's (gone, or another device's) so they can still be fixed or removed */
export const hooksFor = (list: Hook[], space: string, own: string[]) => list.filter((h) => !h.space || h.space === space || !own.includes(h.space));
