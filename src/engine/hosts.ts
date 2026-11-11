// Working on another Mac (Settings › 연결), like Codex's remote connections: its projects
// added here show in the sidebar beside this Mac's, and their jobs run over there. This Mac
// keeps a live copy of those jobs (state/mirror.ts) and sends what the user does with them
// (a message, stop, merge…) to that Mac's Ondra, which does it. The other side is
// engine/remote.ts; the network is the ondra-remote helper.
import { produce } from "solid-js/store";
import { remoteCmd, remoteHostName, remoteStart } from "../lib/native";
import { mirror, remoteProjectId, setMirror, type HostStatus } from "../state/mirror";
import { setState, state } from "../state/store";
import type { Entry, SpaceId, Task } from "../state/types";
import { toast } from "../state/ui";
import { t } from "../i18n";

const pending = new Map<number, { host: string; ok: (v: unknown) => void; no: (e: Error) => void }>();
let seq = 0;
const retry = new Map<string, { timer?: ReturnType<typeof setTimeout>; n: number }>();

export const hostName = (id: string) => state.settings.hosts?.find((h) => h.id === id)?.name ?? "Mac";

const sendTo = (host: string, data: Record<string, unknown>) => remoteCmd({ cmd: "peer-send", peer: host, data });

function status(host: string, s: HostStatus, reason?: string) {
  if (!mirror.hosts[host]) setMirror("hosts", host, { status: s, reason, projects: [], tasks: [] });
  else setMirror("hosts", host, (h) => ({ ...h, status: s, reason }));
}

/** ask that Mac's Ondra to do something; its answer (or why not) comes back */
export function viaHost<T = unknown>(host: string, fn: string, args: unknown[]): Promise<T> {
  if (mirror.hosts[host]?.status !== "ok") {
    toast(t("{name}에 연결되지 않았어요", { name: hostName(host) }), "bad");
    return Promise.reject(new Error("not connected"));
  }
  const n = ++seq;
  return new Promise<T>((ok, no) => {
    pending.set(n, { host, ok: ok as (v: unknown) => void, no });
    void sendTo(host, { t: "call", seq: n, fn, args }).catch((e) => (pending.delete(n), no(e)));
  }).catch((e) => {
    if (String(e?.message ?? e) !== "not connected") toast(String(e?.message ?? e), "bad");
    throw e;
  });
}

/** an action on a job: when the job is another Mac's, it goes there (and this says so) */
export function far(id: string, fn: string, args: unknown[]): Promise<unknown> | undefined {
  for (const [host, h] of Object.entries(mirror.hosts)) if (h.tasks.some((x) => x.id === id)) return viaHost(host, fn, args).catch(() => undefined);
  return undefined;
}

/** a new job in another Mac's project: shown here at once, made and run there */
export function startFar(host: string, task: Task, ask: { id: string; title: string; ask: string; project: string; display?: string }) {
  if (!mirror.hosts[host]) status(host, "lost");
  setMirror("hosts", host, "tasks", (l) => [...l, task]);
  void viaHost(host, "create", [ask]).catch(() => setMirror("hosts", host, "tasks", (l) => l.filter((x) => x.id !== task.id)));
}

/** the space and name a job of that Mac takes here: those of the project it was added to */
function place(host: string, t: Task, list: Task[]) {
  t.host = host;
  if (t.project && !t.project.startsWith("r:")) t.project = remoteProjectId(host, t.project);
  let root: Task | undefined = t;
  for (let i = 0; root?.parentId && i < 20; i++) root = list.find((x) => x.id === root!.parentId) ?? root;
  const pid = (root?.project ?? t.project)?.split(":").pop();
  const link = state.settings.hostProjects?.find((l) => l.host === host && l.id === pid);
  t.space = (link?.space ?? state.space) as SpaceId;
}

interface Patch { id: string; head?: Omit<Task, "entries">; from?: number; entries?: Entry[]; n?: number }

function apply(host: string, patches: Patch[], gone: string[] = [], all = false) {
  setMirror(
    "hosts",
    host,
    "tasks",
    produce((list: Task[]) => {
      if (all) {
        const keep = new Set(patches.map((p) => p.id));
        for (let i = list.length - 1; i >= 0; i--) if (!keep.has(list[i].id)) list.splice(i, 1);
      }
      for (const p of patches) {
        let x = list.find((y) => y.id === p.id);
        if (!x) {
          if (!p.head) continue;
          x = { ...(p.head as Task), entries: [] };
          list.push(x);
          x = list[list.length - 1];
        } else if (p.head) {
          for (const k of Object.keys(x)) if (k !== "entries" && !(k in p.head)) delete (x as unknown as Record<string, unknown>)[k];
          Object.assign(x, p.head);
        }
        if (p.head) place(host, x, list);
        if (p.entries) {
          x.entries.splice(p.from ?? 0, x.entries.length - (p.from ?? 0), ...p.entries);
          if (p.n !== undefined && x.entries.length > p.n) x.entries.length = p.n;
        }
      }
      for (const id of gone) {
        const i = list.findIndex((y) => y.id === id);
        if (i >= 0) list.splice(i, 1);
      }
    }),
  );
}

/** what this Mac wants from that one: the jobs of its projects added here */
function watch(host: string) {
  const projects = (state.settings.hostProjects ?? []).filter((l) => l.host === host).map((l) => l.id);
  void sendTo(host, { t: "watch", projects }).catch(() => {});
}

async function dial(host: string) {
  const h = state.settings.hosts?.find((x) => x.id === host);
  if (!h) return;
  status(host, "connecting");
  await remoteCmd({ cmd: "dial", peer: host, name: await remoteHostName(), ...(h.pair ? { pair: h.pair } : {}) }).catch(() => again(host));
}

function again(host: string) {
  const r = retry.get(host) ?? { n: 0 };
  clearTimeout(r.timer);
  if (!state.settings.hosts?.some((x) => x.id === host)) return;
  const wait = Math.min(60, 2 ** Math.min(r.n, 6));
  r.n++;
  r.timer = setTimeout(() => void dial(host), wait * 1000);
  retry.set(host, r);
}

/** the helper's word about the Macs this one dialed */
export function onPeer(ev: Record<string, unknown>) {
  const host = String(ev.peer ?? "");
  if (!host) return;
  if (ev.ev === "peer") {
    const s = String(ev.state);
    if (s === "ok") {
      retry.set(host, { n: 0 });
      status(host, "ok");
      // the code did its job: from now on this Mac is known there
      if (state.settings.hosts?.find((x) => x.id === host)?.pair) setState("settings", "hosts", (l) => (l ?? []).map((x) => (x.id === host ? { id: x.id, name: x.name } : x)));
      void sendTo(host, { t: "projects" }).catch(() => {});
      watch(host);
    } else if (s === "waiting") status(host, "waiting");
    else if (s === "connecting") status(host, "connecting");
    else if (s === "denied") {
      status(host, "denied", String(ev.reason ?? ""));
      // "off": that Mac turned it off for now; try again later. Refused or unknown: not until the user adds it again.
      if (ev.reason === "off") again(host);
    } else if (s === "closed") {
      for (const [n, p] of pending) if (p.host === host) (pending.delete(n), p.no(new Error(t("{name} 연결이 끊겼어요", { name: hostName(host) }))));
      if (mirror.hosts[host]?.status !== "denied") {
        status(host, "lost", String(ev.reason ?? ""));
        again(host);
      }
    }
    return;
  }
  const d = ev.data as Record<string, unknown> | undefined;
  if (!d) return;
  switch (d.t) {
    case "projects":
      setMirror("hosts", host, "projects", (d.list as { id: string; name: string; folder: string }[]) ?? []);
      break;
    case "patch":
      apply(host, (d.tasks as Patch[]) ?? [], (d.gone as string[]) ?? [], !!d.all);
      break;
    case "ret": {
      const p = pending.get(Number(d.seq));
      if (!p) break;
      pending.delete(Number(d.seq));
      if (d.error) p.no(new Error(String(d.error)));
      else p.ok(d.value);
      break;
    }
  }
}

/** a link from another Mac (its 연결 링크 복사): ondra://connect/<id>?code=…&name=… */
export function parseLink(text: string): { id: string; code: string; name: string } | undefined {
  const m = text.trim().match(/ondra:\/\/connect\/([0-9a-f]{64})\?([^\s]+)/i);
  if (!m) return undefined;
  const q = new URLSearchParams(m[2]);
  const code = q.get("code");
  return code ? { id: m[1].toLowerCase(), code, name: q.get("name") || "Mac" } : undefined;
}

/** add a Mac from its link: connects at once (that Mac asks its user to allow this one) */
export async function addHost(text: string): Promise<boolean> {
  const l = parseLink(text);
  if (!l) return false;
  const rest = (state.settings.hosts ?? []).filter((h) => h.id !== l.id);
  setState("settings", "hosts", [...rest, { id: l.id, name: l.name, pair: l.code }]);
  await startHosts();
  await dial(l.id);
  return true;
}

export function removeHost(id: string) {
  clearTimeout(retry.get(id)?.timer);
  retry.delete(id);
  setState("settings", "hosts", (l) => (l ?? []).filter((h) => h.id !== id));
  setState("settings", "hostProjects", (l) => (l ?? []).filter((p) => p.host !== id));
  void remoteCmd({ cmd: "hangup", peer: id }).catch(() => {});
  setMirror("hosts", produce((h) => void delete h[id]));
}

/** add one of that Mac's projects to this space's sidebar */
export function addHostProject(host: string, p: { id: string; name: string; folder: string }, space: SpaceId = state.space) {
  const rest = (state.settings.hostProjects ?? []).filter((l) => !(l.host === host && l.id === p.id));
  setState("settings", "hostProjects", [...rest, { host, id: p.id, space, name: p.name, folder: p.folder }]);
  watch(host);
}

/** a folder on that Mac made a project there, then added here */
export async function addHostFolder(host: string, folder: string) {
  const id = await viaHost<string>(host, "addProject", [folder]);
  const p = { id, name: folder.replace(/\/+$/, "").split("/").pop() || folder, folder };
  addHostProject(host, p);
  return remoteProjectId(host, id);
}

export function removeHostProject(host: string, id: string) {
  setState("settings", "hostProjects", (l) => (l ?? []).filter((x) => !(x.host === host && x.id === id)));
  watch(host);
  setMirror("hosts", host, "tasks", (l) => l.filter((x) => x.project !== remoteProjectId(host, id)));
}

let helper = false;
/** the helper runs while this Mac works on others or lets others in */
export async function startHosts() {
  if (!helper) {
    await remoteStart();
    helper = true;
  }
  await remoteCmd({ cmd: "host", on: !!state.settings.remote }).catch(() => {});
}
export const helperGone = () => void (helper = false);

/** at launch: connect to every Mac added before */
export async function connectHosts() {
  const list = state.settings.hosts ?? [];
  if (!list.length) return;
  await startHosts();
  for (const h of list) void dial(h.id);
}

/** a Mac's jobs and its live state, for the settings list */
export const hostState = (id: string) => mirror.hosts[id];
