// The Discord agent on several devices: one device holds the bot's connection (the hub); the talk
// and the agent's own memory are there, and its work runs on whichever device has the workspace.
// Each device tells the others whether it holds it ({t:"hub",on,at}, engine/remote.ts). The first
// one turned on holds it; 여기서 맡기 on another takes it only once the hub says it let go, with the
// agent's memory, ways, routines and settings (no two devices ever answer the same message). Two
// that both hold it when they meet (turned on apart): the later claim keeps it and takes the other's.
import { mirror, setMirror, hostSpaceId, splitSpaceId } from "../state/mirror";
import { ownSpaces, setState, state } from "../state/store";
import type { AgentNote, AgentPlace, AgentSettings, Routine } from "../state/types";
import { createEffect, createRoot } from "solid-js";
import { fsWrite } from "../lib/native";
import { askHost, hostName, onPeerKind } from "./hosts";
import { setAgent, startAgent, stopAgent } from "./discord";
import { readWays, waysPath } from "./agentWays";
import { t } from "../i18n";

/** what the hub hands over: its settings as the taker names things, and the agent's own memory */
export interface Handover {
  settings: Partial<AgentSettings>;
  notes: AgentNote[];
  ways: string;
  /** the agent's routines, with their workspace's name there (each goes to the taker's of that name) */
  routines: (Routine & { spaceLabel?: string })[];
}

/** this device holds the connection (or means to: on) */
export const holding = () => !!state.settings.agent?.on;

/** the connected device that holds it now: the latest claim when more than one says so */
export function hubElsewhere(): string | undefined {
  let best: { host: string; at: number } | undefined;
  for (const [host, h] of Object.entries(mirror.hosts)) if (h.status === "ok" && h.hub?.on && (!best || h.hub.at > best.at)) best = { host, at: h.hub.at };
  return best?.host;
}

/** the device that holds it as last known here (connected or not): one still added in Settings › 연결 */
export function knownHub(): string | undefined {
  if (holding()) return undefined;
  const h = hubElsewhere() ?? state.settings.agent?.hub;
  return h && (state.settings.hosts ?? []).some((x) => x.id === h) ? h : undefined;
}

/** a space id of the hub's, as the taker names it: the hub's own become its tab there, the taker's own its plain id */
export function spaceForTaker(id: string | undefined, hub: string, taker: string): string | undefined {
  if (!id) return undefined;
  const sp = splitSpaceId(id);
  if (!sp) return hostSpaceId(hub, id);
  return sp.host === taker ? sp.id : id;
}

/** On the hub, asked by `taker`: let the connection go (done once this returns) and hand everything over. */
export async function release(taker: string, me: string): Promise<Handover> {
  const a: AgentSettings = state.settings.agent ?? { on: false, name: "메타몽" };
  await stopAgent();
  setAgent({ on: false, hub: taker, claimAt: undefined });
  const map = (id?: string) => spaceForTaker(id, me, taker);
  // an account is this device's: it goes with no place but this device's own (it can't be one there)
  const place = (p: AgentPlace): AgentPlace => ({ channel: p.channel, ...(p.label ? { label: p.label } : {}), ...(map(p.space) ? { space: map(p.space) } : {}) });
  const { on: _on, hub: _hub, claimAt: _at, account: _acct, space, places, ...rest } = a;
  return {
    settings: { ...rest, ...(map(space) ? { space: map(space) } : {}), places: (places ?? []).map(place) },
    notes: state.agentNotes ?? [],
    ways: await readWays(),
    routines: (state.routines ?? []).filter((r) => r.agent && !r.host).map((r) => ({ ...r, spaceLabel: state.spaces.find((s) => s.id === r.space)?.label })),
  };
}

/** On the old hub, once the taker has it all: its memory and routines are the taker's now. */
export function released(taker: string) {
  if (state.settings.agent?.hub !== taker || holding()) return;
  setState("agentNotes", []);
  setState("routines", (l) => (l ?? []).filter((r) => !r.agent || !!r.host));
}

/** On the taker: what the hub handed over joins what is here. */
export async function adopt(h: Handover) {
  const own = ownSpaces();
  const have = new Map((state.agentNotes ?? []).map((n) => [n.id, n]));
  for (const n of h.notes ?? []) if (!have.has(n.id) || (n.updatedAt ?? n.at) > (have.get(n.id)!.updatedAt ?? have.get(n.id)!.at)) have.set(n.id, n);
  setState("agentNotes", [...have.values()]);
  if (h.ways?.trim()) await fsWrite(await waysPath(), h.ways.trim() + "\n").catch(() => {});
  const ids = new Set((state.routines ?? []).map((r) => r.id));
  const routines = (h.routines ?? [])
    .filter((r) => !ids.has(r.id))
    .map(({ spaceLabel, ...r }) => ({ ...r, space: (own.find((s) => s.label === spaceLabel) ?? own[0])?.id ?? r.space, accountId: undefined }));
  if (routines.length) setState("routines", (l) => [...(l ?? []), ...routines]);
  const cur = state.settings.agent ?? { on: false, name: "메타몽" };
  // an account is this device's own: the one picked here for the same place stays
  const kept = (p: AgentPlace) => cur.places?.find((x) => x.channel === p.channel && x.space === p.space)?.account;
  setAgent({ ...h.settings, account: cur.account, places: (h.settings.places ?? []).map((p) => (kept(p) ? { ...p, account: kept(p) } : p)) });
}

/** 여기서 맡기 (and turning it on here): from the hub once it let go, or at once when no device holds it. */
export async function takeHere() {
  const from = knownHub();
  if (from) {
    if (mirror.hosts[from]?.status !== "ok") throw new Error(t("{name}이(가) 연결돼 있어야 넘겨받을 수 있어요", { name: hostName(from) }));
    await adopt(await askHost<Handover>(from, "agentRelease", [], 60_000));
    void askHost(from, "agentReleased", []).catch(() => {});
  }
  setAgent({ on: true, hub: undefined, claimAt: Date.now() });
  await startAgent();
}

/** two devices both holding it: the later claim keeps it, taking the other's (it lets go first) */
let settling = false;
async function settle(host: string, at: number) {
  const mine = state.settings.agent?.claimAt ?? 0;
  if (settling || mine < at || (mine === at && host > (await import("./remote")).remote().id!)) return;
  settling = true;
  try {
    await adopt(await askHost<Handover>(host, "agentRelease", [], 60_000));
    void askHost(host, "agentReleased", []).catch(() => {});
  } catch {
    // it didn't answer: it is asked again the next time it says it holds it
  } finally {
    settling = false;
  }
}

onPeerKind("hub", (host, d) => {
  const on = d.on === true;
  const at = typeof d.at === "number" ? d.at : 0;
  if (mirror.hosts[host]) setMirror("hosts", host, "hub", { on, at });
  if (on && !holding() && state.settings.agent && state.settings.agent.hub !== host) setAgent({ hub: host });
});
// this device holding it while a connected one says it does too (whichever changed last)
createRoot(() =>
  createEffect(() => {
    if (!holding()) return;
    void state.settings.agent?.claimAt;
    for (const [host, h] of Object.entries(mirror.hosts)) if (h.status === "ok" && h.hub?.on) void settle(host, h.hub.at);
  }),
);
