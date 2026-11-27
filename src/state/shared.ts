// A workspace is the same on every device: its main and project chats, what is folded, where its canvas
// cards are, the text typed and not sent yet. They belong to the device that owns the workspace. A tab
// of another device's workspace (h:<host>:<space>) shows that device's copy and every change made here
// goes there; that device sends what changes on its side (engine/remote.ts, engine/hosts.ts).
// Its app settings (the settings page's) can be read and changed from here too.
//
// A device that doesn't share them (an older Ondra, or one that lets this device use only some of its
// workspaces) is left as before: its tabs keep this device's own main and screen state.
import { produce } from "solid-js/store";
import { askHost, viaHost } from "../engine/hosts";
import { SHARED_SETTINGS } from "../engine/appSettings";
import { deepHere, deepThere, mirror, setMirror, splitSpaceId, toThere, type FarMessage } from "./mirror";
import { AGENT_CHAT, ownSpaces, setState, state, uid } from "./store";
import { viewState } from "./viewState";
import { mainDrafts, pushDraft, setDraftRoute } from "./drafts";
import type { CaptainMessage } from "./types";

/** the device whose own chats and screen state a workspace tab shows, when it shares them */
export function farOf(space: string | undefined): string | undefined {
  const host = splitSpaceId(space)?.host;
  if (!host) return undefined;
  return mirror.hosts[host]?.chat || state.settings.hosts?.some((h) => h.id === host && h.same) ? host : undefined;
}

/** every message of a workspace's chats (main's and its projects'), wherever they are kept */
export function messagesIn(space: string): CaptainMessage[] {
  const host = farOf(space);
  return (host ? (mirror.hosts[host]?.chat ?? []) : state.captain).filter((m) => m.space === space);
}
/** one chat: the workspace's main, or a project's */
export const chatIn = (space: string, project?: string): FarMessage[] => messagesIn(space).filter((m) => (m.project ?? undefined) === (project || undefined));

// ───────── this device acting on another device's chats

/** that chat's key as that device has it */
const there = (host: string, space: string, project?: string) => ({ space: toThere(host, space), ...(project ? { project: toThere(host, project) } : {}) });

/** what is typed in another device's chat: shown here at once, sent to its main there. The id of the reply to watch. */
export function sayFar(host: string, text: string, space: string, project?: string): string {
  const me: CaptainMessage = { id: uid("c"), at: Date.now(), space, project, from: "me", text };
  const reply: CaptainMessage = { id: uid("c"), at: Date.now(), space, project, from: "captain", pending: true };
  setMirror("hosts", host, "chat", (l) => [...(l ?? []), me, reply]);
  void viaHost(host, "say", [{ me: me.id, reply: reply.id, text, ...there(host, space, project) }]).catch(() =>
    setMirror("hosts", host, "chat", (l) => (l ?? []).filter((m) => m.id !== me.id && m.id !== reply.id)),
  );
  return reply.id;
}
export const stopFar = (host: string, space: string, project?: string) => viaHost(host, "mainStop", [there(host, space, project)]).catch(() => {});
export const clearFar = (host: string, space: string, project?: string) => viaHost(host, "mainClear", [there(host, space, project)]).catch(() => {});
/** a message of that device's chat (its id), if it is one */
export const farMessage = (id: string): { host: string; m: FarMessage } | undefined => {
  for (const [host, h] of Object.entries(mirror.hosts)) {
    const m = h.chat?.find((x) => x.id === id);
    if (m) return { host, m };
  }
  return undefined;
};
export const editFar = (host: string, id: string, text: string) => viaHost(host, "mainEdit", [id, text]).catch(() => {});

// ───────── screen state of another device's workspace

const sends = new Map<string, { value: unknown; timer: ReturnType<typeof setTimeout> }>();
/** a screen value of that device's workspace (key and value in its ids): shown here at once, sent there a moment later */
function setUi(host: string, key: string, value: unknown) {
  setMirror("hosts", host, "ui", produce((u: Record<string, unknown> | undefined) => {
    if (!u) return;
    if (value === undefined) delete u[key];
    else u[key] = value;
  }));
  if (!mirror.hosts[host]?.ui) setMirror("hosts", host, "ui", value === undefined ? {} : { [key]: value });
  const id = `${host} ${key}`;
  clearTimeout(sends.get(id)?.timer);
  // typing and dragging send what they end on
  sends.set(id, { value, timer: setTimeout(() => (sends.delete(id), void askHost(host, "ui", [key, value ?? null]).catch(() => {})), 120) });
}
const uiOf = (host: string, key: string) => mirror.hosts[host]?.ui?.[key];

/** the device a key of this device's names a workspace of (sp:h:…/…, main:h:…), when it shares it */
const hostOfKey = (key: string) => farOf(/^(?:sp|main|pos):(h:[0-9a-f]{64}:[^/~:]+)/.exec(key)?.[1]);

viewState.setRoute({
  owns: (key) => key.startsWith("sp:h:") && !!hostOfKey(key),
  get: (key) => {
    const host = hostOfKey(key)!;
    return deepHere(host, uiOf(host, toThere(host, key)));
  },
  set: (key, v) => {
    const host = hostOfKey(key)!;
    setUi(host, toThere(host, key), deepThere(host, v));
  },
});
setDraftRoute({
  owns: (key) => key.startsWith("main:h:") && !!hostOfKey(key),
  get: (key) => {
    const host = hostOfKey(key)!;
    const v = uiOf(host, toThere(host, key));
    return typeof v === "string" ? v : undefined;
  },
  set: (key, text) => {
    const host = hostOfKey(key)!;
    const k = toThere(host, key);
    if ((uiOf(host, k) ?? "") !== text) setUi(host, k, text || undefined);
  },
});

/** where the user put a canvas card (none: where it falls) */
export function canvasPos(space: string, node: string): { x: number; y: number } | undefined {
  const host = farOf(space);
  if (!host) return state.canvas?.[`${space}:${node}`];
  return uiOf(host, `pos:${toThere(host, space)}:${toThere(host, node)}`) as { x: number; y: number } | undefined;
}
export function setCanvasPos(space: string, node: string, at: { x: number; y: number } | undefined) {
  const host = farOf(space);
  if (host) return setUi(host, `pos:${toThere(host, space)}:${toThere(host, node)}`, at);
  const key = `${space}:${node}`;
  if (at) setState("canvas", (c) => ({ ...(c ?? {}), [key]: at }));
  // a store merges objects: a key goes one by one
  else if (state.canvas?.[key]) setState("canvas", key, undefined!);
}
/** the cards of a workspace the user moved (their node ids) */
export function movedCards(space: string): string[] {
  const host = farOf(space);
  const prefix = host ? `pos:${toThere(host, space)}:` : `${space}:`;
  const keys = Object.keys((host ? mirror.hosts[host]?.ui : state.canvas) ?? {}).filter((k) => k.startsWith(prefix));
  return keys.map((k) => k.slice(prefix.length));
}

// ───────── this device's side: what it shares of its workspaces, and what another device changes in them

/** the workspace a shared key is about, and whether it may be shared (the agent's chat, the canvas's camera stay) */
export function uiSpace(key: string): string | undefined {
  const m = /^(?:sp:([^/]+)\/|pos:([^:]+):|main:([^~]+)(?:~|$))/.exec(key);
  const space = m?.[1] ?? m?.[2] ?? m?.[3];
  if (!space || key.endsWith("/canvas.view") || key.endsWith(`~${AGENT_CHAT}`)) return undefined;
  return ownSpaces().some((s) => s.id === space) ? space : undefined;
}

/** this device's screen state in its own workspaces, keyed as here */
export function sharedUi(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of viewState.entries("sp:")) if (uiSpace(k)) out[k] = v;
  for (const [k, v] of Object.entries(state.canvas ?? {})) if (v && uiSpace(`pos:${k}`)) out[`pos:${k}`] = v;
  for (const [k, text] of mainDrafts()) if (uiSpace(k)) out[k] = text;
  return out;
}

/** another device changed a screen value of one of this device's workspaces */
export function applyUi(key: string, value: unknown) {
  if (!uiSpace(key)) throw new Error("bad key");
  const v = value ?? undefined;
  if (key.startsWith("sp:")) viewState.put(key, v, { quiet: true });
  else if (key.startsWith("pos:")) {
    const k = key.slice(4);
    if (v && typeof v === "object" && typeof (v as { x?: unknown }).x === "number" && typeof (v as { y?: unknown }).y === "number") setState("canvas", (c) => ({ ...(c ?? {}), [k]: { x: (v as { x: number }).x, y: (v as { y: number }).y } }));
    else if (state.canvas?.[k]) setState("canvas", k, undefined!);
  } else pushDraft(key, typeof v === "string" ? v : "");
}

// ───────── another device's app settings

/** that device's settings the settings page offers, as it last sent them */
export const farSettings = (host: string) => mirror.hosts[host]?.settings;
/** change one there: shown here at once, back as it was when that device says no */
export async function setFarSetting(host: string, key: string, value: unknown) {
  if (!(SHARED_SETTINGS as readonly string[]).includes(key)) throw new Error(`no setting ${key}`);
  const was = farSettings(host)?.[key];
  setMirror("hosts", host, "settings", (s) => ({ ...(s ?? {}), [key]: value }));
  try {
    const now = await viaHost(host, "setSetting", [key, value]);
    setMirror("hosts", host, "settings", (s) => ({ ...(s ?? {}), [key]: now }));
  } catch (e) {
    setMirror("hosts", host, "settings", (s) => ({ ...(s ?? {}), [key]: was }));
    throw e;
  }
}
