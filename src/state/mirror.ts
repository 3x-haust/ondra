// Other Macs' work, as this app shows it: the projects the user added from another Mac
// (Settings › 연결) and their jobs, kept up to date over Ondra's own network (engine/hosts.ts).
// Held in memory only: it is the other Mac's, never written to this Mac's state.json.
import { createStore } from "solid-js/store";
import type { Limit } from "../lib/native";
import type { Project, SpaceId, Task } from "./types";

export type HostStatus = "off" | "connecting" | "waiting" | "ok" | "denied" | "lost";

export interface HostMirror {
  status: HostStatus;
  /** why it isn't connected, when it says */
  reason?: string;
  /** connected once and then not: since when */
  since?: number;
  /** every project on that Mac (to pick from) */
  projects: { id: string; name: string; folder: string }[];
  /** the jobs of the projects added here, as that Mac has them (ids as there) */
  tasks: Task[];
  /** its workspaces, accounts and their plan use (sent by that Mac, refreshed as they change) */
  info?: HostInfo;
}

export interface HostInfo {
  /** that Mac's Ondra version */
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

export const [mirror, setMirror] = createStore<{ hosts: Record<string, HostMirror> }>({ hosts: {} });

/** a project of another Mac, as this app names it: r:<host>:<its id> */
export const remoteProjectId = (host: string, id: string) => `r:${host}:${id}`;
export function splitProjectId(id?: string): { host: string; id: string } | undefined {
  const m = id?.match(/^r:([0-9a-f]{64}):(.+)$/);
  return m ? { host: m[1], id: m[2] } : undefined;
}

/** every mirrored job (subagents included) */
export function mirroredTasks(): Task[] {
  const out: Task[] = [];
  for (const h of Object.values(mirror.hosts)) out.push(...h.tasks);
  return out;
}

/** the Mac a job runs on, when it is another Mac's */
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

/** a Mac's state in words, the same everywhere (settings, sidebar, the run chip, a job): "연결됨",
 *  "10분 전부터 연결 안 됨" … */
export function hostStatusText(h: HostMirror | undefined, seen?: number, t: (k: string, v?: Record<string, string | number>) => string = (k) => k, ago: (at?: number) => string = () => ""): string {
  const s = h?.status ?? "connecting";
  if (s === "denied" && h?.reason === "off") return t("그 Mac에서 연결을 꺼 뒀어요");
  if (s === "denied" && h?.reason === "unknown") return t("그 Mac에서 이 Mac을 뺐어요");
  if (s === "denied") return t("거절됨");
  if (s === "waiting") return t("그 Mac에서 허용을 기다려요");
  if (s === "ok") return t("연결됨");
  const at = h?.since ?? seen;
  if (s === "connecting" && !at) return t("연결 중");
  // just now: it's trying again; later: since when
  if (at && Date.now() - at < 60_000) return s === "connecting" ? t("연결이 끊겨서 다시 연결하는 중") : t("연결이 끊겼어요");
  return at ? t("{ago}부터 연결 안 됨", { ago: ago(at) }) : t("연결 안 됨");
}
