// Where the Discord agent's work goes (Settings › 에이전트 › 일하는 곳): for every channel, and per
// channel or DM. A place is a workspace of this device or of a connected one (its tab here,
// "h:<device>:<id>"), or none: then main finds the workspace by the project named, else asks.
import { ownSpaces, projectsShown, state } from "../state/store";
import type { AgentSettings, SpaceId } from "../state/types";

export type WorkPlace =
  | { kind: "none"; account?: string }
  | { kind: "here"; space: SpaceId; account?: string }
  | { kind: "device"; host: string; space: SpaceId; label: string };

/** a workspace id as a place: this device's, a connected device's tab, or none (unknown or gone) */
export function placeOfSpace(space: string | undefined, account?: string): WorkPlace {
  const s = space ? state.spaces.find((x) => x.id === space) : undefined;
  if (!s) return { kind: "none", ...(account ? { account } : {}) };
  if (!s.host) return { kind: "here", space: s.id, ...(account ? { account } : {}) };
  return { kind: "device", host: s.host, space: s.id, label: s.label };
}

/** the place a channel's work goes to: its own row (a row left on 없음 is none), else every channel's */
export function placeFor(a: AgentSettings, channel?: string): WorkPlace {
  const p = channel ? a.places?.find((x) => x.channel === channel) : undefined;
  return p ? placeOfSpace(p.space, p.account) : placeOfSpace(a.space, a.account);
}

/**
 * The workspace the agent's chat for a channel lives in (its model calls, account and memory): the
 * channel's place when it is this device's; for another device's, this device's workspace of the
 * same name; else the first of this device's.
 */
export function agentHome(a: AgentSettings, channel?: string): SpaceId {
  const p = placeFor(a, channel);
  const own = ownSpaces();
  if (p.kind === "here") return p.space;
  const same = p.kind === "device" ? own.find((s) => s.label === p.label) : undefined;
  return (same ?? own[0])?.id ?? state.space;
}

/** the workspaces a place can be, by device: this one's first, then each connected device's */
export function placeChoices(thisName: string, hostName: (id: string) => string): { host?: string; name: string; spaces: { id: SpaceId; label: string }[] }[] {
  const out: { host?: string; name: string; spaces: { id: SpaceId; label: string }[] }[] = [{ name: thisName, spaces: ownSpaces().map((s) => ({ id: s.id, label: s.label })) }];
  for (const h of state.settings.hosts ?? []) {
    const spaces = state.spaces.filter((s) => s.host === h.id).map((s) => ({ id: s.id, label: s.label }));
    if (spaces.length) out.push({ host: h.id, name: hostName(h.id), spaces });
  }
  return out;
}

/** "개인", or "MacBook › 회사" for another device's */
export const placeName = (space: string | undefined, hostName: (id: string) => string): string => {
  const s = space ? state.spaces.find((x) => x.id === space) : undefined;
  if (!s) return "";
  return s.host ? `${hostName(s.host)} › ${s.label}` : s.label;
};

/**
 * What main is told about where work from this channel goes. A place of this device needs nothing
 * (the chat is there); another device's is named; none lists every place with its projects.
 */
export function placeNote(a: AgentSettings, channel: string | undefined, hostName: (id: string) => string): string {
  const p = placeFor(a, channel);
  if (p.kind === "here") return "";
  if (p.kind === "device") return `Work asked here runs on the device "${hostName(p.host)}", in its workspace "${p.label}" (space id ${p.space}): new work from here goes there on its own; give another "space" on the new route only when they name another place.`;
  const places = placeChoices("this device", hostName).flatMap((d) =>
    d.spaces.map((s) => {
      const projects = projectsShown(s.id).map((x) => x.name);
      return `- ${d.name} › ${s.label} (space id ${s.id})${projects.length ? `: ${projects.join(", ")}` : ""}`;
    }),
  );
  if (places.length < 2) return "";
  return [
    "No workspace is set for work asked here. Find where it belongs by the project they name (or the one it is plainly about) among these places, and put that place's space id as \"space\" on the new route:",
    ...places,
    "When it isn't clear which, ask them with an ask whose options are those places (they show as buttons), and start the work once they pick.",
  ].join("\n");
}

