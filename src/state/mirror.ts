// Other Macs' work, as this app shows it: the projects the user added from another device
// (Settings › 연결) and their jobs, kept up to date over Ondra's own network (engine/hosts.ts).
// Held in memory only: it is the other Mac's, never written to this Mac's state.json.
import { createStore } from "solid-js/store";
import type { Limit } from "../lib/native";
import type { AgentNote, AgentPlace, CaptainMessage, Decision, Project, Routine, SpaceId, Task } from "./types";

/** "off": disconnected here for now (연결 끊기) */
export type HostStatus = "off" | "connecting" | "waiting" | "ok" | "denied" | "lost";

export interface HostMirror {
  status: HostStatus;
  /** why it isn't connected, when it says */
  reason?: string;
  /** connected once and then not: since when */
  since?: number;
  /** every project on that device (to pick from): its workspace's name there, and its id (newer devices) */
  projects: { id: string; name: string; folder: string; space?: string; spaceId?: string }[];
  /** the jobs of the projects added here, as that device has them (ids as there) */
  tasks: Task[];
  /** its workspaces, accounts and their plan use (sent by that device, refreshed as they change) */
  info?: HostInfo;
  /** the questions those jobs wait on, as that device has them (a Mac too old to send them: none) */
  decisions?: Decision[];
  /** its main and project chats in its workspaces, as they show here (a device that doesn't share
   *  them: none, and its workspace tabs keep this device's own main) */
  chat?: FarMessage[];
  /** the questions its main asks in those chats (taskId "main:<chat key here>") */
  asks?: Decision[];
  /** its screen state in its workspaces, keyed as there: "sp:<space>/…" (viewState), "pos:<space>:<node>"
   *  (canvas cards), "main:<chat key>" (unsent text) */
  ui?: Record<string, unknown>;
  /** its app settings the settings page offers (engine/appSettings.ts SHARED_SETTINGS) */
  settings?: Record<string, unknown>;
  /** its Discord agent, for its 에이전트 tab here (a device that doesn't show it: none) */
  agent?: FarAgent;
}

/** another device's Discord agent as it sends it (engine/remote.ts agentNow); its chat comes with the
 *  chats, its work and questions with the jobs */
export interface FarAgent {
  name: string;
  on: boolean;
  status: { state: "off" | "connecting" | "on" | "stopped"; why?: string };
  notes: AgentNote[];
  /** its agent/AGENT.md */
  ways: string;
  /** its routines (ids and workspaces as there) */
  routines: Routine[];
  /** its Settings › 에이전트, seen here (a device too old to send them: none) */
  settings?: FarAgentSettings;
}

/** another device's agent settings (engine/remote.ts agentSettingsNow): workspace and account ids as there */
export interface FarAgentSettings {
  /** a bot token is kept there (the token itself never leaves it) */
  token: boolean;
  ownerId?: string;
  voice?: string;
  others: boolean;
  /** where work goes from every channel not set apart */
  space?: string;
  account?: string;
  places: AgentPlace[];
  /** the channels it talks with others in; none = wherever it is called */
  channels: string[];
  /** the names its bot knows for those channels: id → "#name" */
  rooms: Record<string, string>;
}

/** a message of another device's chat: while main is still answering, what it has written and thought so far */
export type FarMessage = CaptainMessage & { draft?: string; thought?: string };

export interface HostInfo {
  /** that device's Ondra version */
  version?: string;
  spaces: { id: string; label: string }[];
  accounts: {
    id: string;
    space: string;
    name: string;
    email?: string;
    services: string[];
    limits: Limit[];
    credits?: string;
    /** its models, its own model and level there; a direct connection's levels and names per model */
    models: string[];
    model?: string;
    effort?: string;
    levels?: Record<string, string[]>;
    names?: Record<string, string>;
  }[];
  /** per workspace there: the account new work would run on now */
  pick: Record<string, string>;
}

/** a new job asked of another device (its "create" call). Past the first fields, what a Mac too old to
 *  know them leaves out: ids it follows or waits on are that device's (the ids shown here), `reach` names
 *  workspaces by label. */
export interface FarAsk {
  id: string;
  title: string;
  ask: string;
  project?: string;
  space: string;
  hostSpace?: string;
  spaceLabel?: string;
  account?: string;
  model?: string;
  thinking?: string;
  display?: string;
  branch?: string;
  priority?: Task["priority"];
  weight?: Task["weight"];
  origin?: Task["origin"];
  isolate?: boolean;
  after?: string[];
  reach?: string[];
  follows?: string;
  issue?: Task["issue"];
  by?: string;
  permission?: Task["permission"];
}

export const [mirror, setMirror] = createStore<{ hosts: Record<string, HostMirror> }>({ hosts: {} });

/** a project of another device, as this app names it: r:<host>:<its id> */
export const remoteProjectId = (host: string, id: string) => `r:${host}:${id}`;
export function splitProjectId(id?: string): { host: string; id: string } | undefined {
  const m = id?.match(/^r:([0-9a-f]{64}):(.+)$/);
  return m ? { host: m[1], id: m[2] } : undefined;
}

/** another device's workspace, as this app names it: h:<host>:<its id> (one tab per device and workspace) */
export const hostSpaceId = (host: string, id: string) => `h:${host}:${id}`;
export function splitSpaceId(id?: string): { host: string; id: string } | undefined {
  const m = id?.match(/^h:([0-9a-f]{64}):(.+)$/);
  return m ? { host: m[1], id: m[2] } : undefined;
}

/** every mirrored job (subagents included) */
export function mirroredTasks(): Task[] {
  const out: Task[] = [];
  for (const h of Object.values(mirror.hosts)) out.push(...h.tasks);
  return out;
}

/** every question another device's jobs wait on */
export function mirroredDecisions(): Decision[] {
  const out: Decision[] = [];
  for (const h of Object.values(mirror.hosts)) out.push(...(h.decisions ?? []), ...(h.asks ?? []));
  return out;
}
export const mirroredDecision = (id: string) => mirroredDecisions().find((d) => d.id === id);

/**
 * Read here: a mirrored job's unread is that device's, sent on every change. Opening it here notes how
 * many entries it had then, and it reads as unread again only once it has more.
 */
export const readAt = new Map<string, number>();
export const seenHere = (t: Task) => (readAt.get(t.id) ?? -1) >= t.entries.length;

/** the Mac a job runs on, when it is another device's */
export function hostOfTask(id: string): string | undefined {
  for (const [host, h] of Object.entries(mirror.hosts)) if (h.tasks.some((t) => t.id === id)) return host;
  return undefined;
}

/** projects added from other Macs, as projects of this app's space */
export function linkedProjects(links: { host: string; id: string; space: SpaceId; name?: string; folder?: string }[] | undefined, hostName: (h: string) => string): Project[] {
  return (links ?? []).map((l) => {
    const p = mirror.hosts[l.host]?.projects.find((x) => x.id === l.id);
    return { id: remoteProjectId(l.host, l.id), space: l.space, name: p?.name ?? l.name ?? "", folder: p?.folder ?? l.folder ?? "", host: l.host, hostName: hostName(l.host) };
  });
}

/** a device's link as the Mac bar's mark colors it: connected, trying for the first time (or
 *  waiting to be allowed), not connected after all, or disconnected here on purpose */
export type LinkTone = "ok" | "trying" | "down" | "off";
export function linkTone(h: HostMirror | undefined): LinkTone {
  const s = h?.status ?? "connecting";
  if (s === "ok" || s === "off") return s;
  return (s === "connecting" || s === "waiting") && !h?.since ? "trying" : "down";
}

/** a device's state in one word (the Mac bar's mark, read out): trying for the first time is
 *  "연결 중"; once it was connected and isn't, "연결 안 됨" even while it tries again */
export function linkWord(h: HostMirror | undefined): "연결됨" | "연결 중" | "연결 안 됨" {
  const tone = linkTone(h);
  return tone === "ok" ? "연결됨" : tone === "trying" ? "연결 중" : "연결 안 됨";
}

/** a Mac's state in words, the same everywhere (settings, sidebar, the run chip, a job): "연결됨",
 *  "10분 전부터 연결 안 됨" … */
export function hostStatusText(h: HostMirror | undefined, seen?: number, t: (k: string, v?: Record<string, string | number>) => string = (k) => k, ago: (at?: number) => string = () => ""): string {
  const s = h?.status ?? "connecting";
  if (s === "denied" && h?.reason === "off") return t("그 기기에서 연결을 꺼 뒀어요");
  if (s === "denied" && (h?.reason === "unknown" || h?.reason === "revoked")) return t("그 기기에서 이 기기를 제거했어요");
  if (s === "denied") return t("거절됨");
  if (s === "off") return t("연결 끊음");
  if (s === "lost" && h?.reason === "dropped") return t("그 기기에서 연결을 끊었어요");
  if (s === "waiting") return t("그 기기에서 허용을 기다려요");
  if (s === "ok") return t("연결됨");
  const at = h?.since ?? seen;
  if (s === "connecting" && !at) return t("연결 중");
  // just now: it's trying again; later: since when
  if (at && Date.now() - at < 60_000) return s === "connecting" ? t("연결이 끊겨서 다시 연결하는 중") : t("연결이 끊겼어요");
  return at ? t("{ago}부터 연결 안 됨", { ago: ago(at) }) : t("연결 안 됨");
}

// ───────── another device's chats and screen state, as they show here (state/shared.ts)

/** a message of that device's chat as it shows here: in its workspace's tab, its project's id here */
export function chatHere(host: string, m: FarMessage): FarMessage {
  return { ...m, space: hostSpaceId(host, m.space), ...(m.project ? { project: projectHere(host, m.project) } : {}), ...(m.up ? { up: remoteProjectId(host, m.up) } : {}) };
}

/** a question main asks there ("main:<space>~<project>"), as it shows in that chat here */
export function askHere(host: string, d: Decision): Decision {
  const [space, project] = d.taskId.slice(5).split("~");
  return { ...d, taskId: `main:${hostSpaceId(host, space)}${project ? `~${projectHere(host, project)}` : ""}` };
}
/** a chat's project there as named here: the agent's chat keeps its name, so it reads as the agent's */
const projectHere = (host: string, project: string) => (project === "@agent" || project.startsWith("@agent:") ? project : remoteProjectId(host, project));

/** a key or value of this device's for that device's workspace, in that device's own ids */
export const toThere = (host: string, s: string) => s.split(`h:${host}:`).join("").split(`r:${host}:`).join("");
export function deepThere(host: string, v: unknown): unknown {
  if (typeof v === "string") return toThere(host, v);
  if (Array.isArray(v)) return v.map((x) => deepThere(host, x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepThere(host, x)]));
  return v;
}
/** a value of that device's: what names one of its projects names it as here */
export function deepHere(host: string, v: unknown): unknown {
  if (typeof v === "string") return mirror.hosts[host]?.projects.some((p) => p.id === v) ? remoteProjectId(host, v) : v;
  if (Array.isArray(v)) return v.map((x) => deepHere(host, x));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepHere(host, x)]));
  return v;
}
