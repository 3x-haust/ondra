// Letting other Macs work on this one (Settings › 연결 › 이 Mac): a Mac the user allowed
// adds this Mac's projects to its sidebar and runs jobs in them here. Its Ondra keeps a
// live copy of those jobs (engine/hosts.ts); this side sends what changed and does what it
// asks, as if the user had done it here.
//
//   them → here  {t:"projects"} {t:"watch",projects} {t:"call",seq,fn,args}
//   here → them  {t:"projects",list} {t:"info",info} {t:"patch",tasks,gone?,all?} {t:"ret",seq,value|error}
//
// A job goes as its fields and its entries; after the first time only what changed: the
// fields when they did, and the entries from the first one that differs.
import { createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import { inTauri, onRemote, remoteCmd, remoteHostName, remoteStop } from "../lib/native";
import { addProject, onWrite, projectById, setState, state, taskById } from "../state/store";
import type { Task } from "../state/types";
import type { HostInfo } from "../state/mirror";
import { creditsOf, usageOf } from "../state/limits";
import { accountName, service } from "../ui/AccountPicker";
import { modelsNow, refreshModels } from "./modelList";
import { connectionOf, connModelLabel, effortLevels } from "./connections";
import { effortFor } from "./models";
import * as jobs from "./tasks";
import { connectHosts, helperGone, onPeer, startHosts } from "./hosts";

export interface RemoteDevice { id: string; name: string; addedAt: number; lastSeen: number }
export interface PairAsk { conn: number; device: { id: string; name: string } }

/** what the window shows about this Mac's side */
export const [remote, setRemote] = createSignal<{
  /** this Mac's id on the network, once it is reachable */
  id?: string;
  devices: RemoteDevice[];
  /** Macs connected now (by connection) */
  live: Record<number, { id: string; name: string }>;
  /** a Mac asking to be let in */
  asks: PairAsk[];
  /** the code in the link copied last, and when it stops working */
  pair?: { code: string; until: number };
}>({ devices: [], live: {}, asks: [] });

interface Conn {
  /** the Mac's id */
  device: string;
  /** the projects (ids here) whose jobs it keeps */
  watch: Set<string>;
  /** each job as last sent: its fields' JSON and each entry's */
  sent: Map<string, { head: string; ents: string[] }>;
  /** send everything again (just asked) */
  all: boolean;
  /** the workspaces and accounts as last sent */
  info?: string;
}
const conns = new Map<number, Conn>();
const send = (conn: number, data: Record<string, unknown>) => remoteCmd({ cmd: "send", conn, data }).catch(() => {});

// ───────── what changed

const dirty = new Set<string>();
let dirtyAll = false;
let projectsDirty = false;
onWrite((args) => {
  if (!conns.size) return;
  if (args[0] === "projects") projectsDirty = true;
  if (args[0] !== "tasks") return soon();
  const sel = args[1];
  if (args.length < 3) dirtyAll = true;
  else if (typeof sel === "function") state.tasks.forEach((x, i) => (sel as (t: Task, i: number) => boolean)(x, i) && dirty.add(x.id));
  else if (typeof sel === "number") state.tasks[sel] && dirty.add(state.tasks[sel].id);
  else if (Array.isArray(sel)) for (const i of sel) state.tasks[i] && dirty.add(state.tasks[i].id);
  else dirtyAll = true;
  soon();
});

let timer: ReturnType<typeof setTimeout> | undefined;
const soon = () => (timer ??= setTimeout(flush, 300));

/** a job's top job (a subagent's parent, up the line) */
function rootOf(t: Task): Task {
  let x: Task = t;
  for (let i = 0; x.parentId && i < 20; i++) x = taskById(x.parentId) ?? x;
  return x;
}
/** what that Mac keeps: the jobs of the projects it added, and the jobs it asked for */
function wanted(c: Conn, t: Task): boolean {
  const r = rootOf(t);
  return (!!r.project && c.watch.has(r.project)) || (!!c.device && r.from?.device === c.device);
}

function flush() {
  timer = undefined;
  const live = state.tasks.filter((x) => x.status === "running" || x.status === "waiting");
  for (const [conn, c] of conns) {
    if (projectsDirty) void sendProjects(conn);
    if (!c.watch.size && !c.sent.size && !c.all) continue;
    const pick = c.all || dirtyAll ? state.tasks : [...new Set([...[...dirty].map((id) => taskById(id)).filter((x): x is Task => !!x && !x.host), ...live])];
    const out: Record<string, unknown>[] = [];
    let size = 0;
    const seen = new Set<string>();
    const ship = (last = false) => {
      if (!out.length && !last) return;
      const gone = last && (c.all || dirtyAll) ? [...c.sent.keys()].filter((id) => !seen.has(id)) : last ? [...c.sent.keys()].filter((id) => !taskById(id) || !wanted(c, taskById(id)!)) : [];
      for (const id of gone) c.sent.delete(id);
      if (out.length || gone.length) void send(conn, { t: "patch", tasks: out.splice(0), ...(gone.length ? { gone } : {}) });
      size = 0;
    };
    for (const t of pick) {
      if (!wanted(c, t)) continue;
      seen.add(t.id);
      const raw = unwrap(t);
      const { entries, ...rest } = raw;
      const head = JSON.stringify(rest);
      const ents = entries.map((e) => JSON.stringify(e));
      const before = c.sent.get(t.id);
      let from = 0;
      if (before) while (from < ents.length && from < before.ents.length && ents[from] === before.ents[from]) from++;
      const sameHead = before?.head === head;
      if (before && sameHead && from === ents.length && before.ents.length === ents.length) continue;
      c.sent.set(t.id, { head, ents });
      out.push({ id: t.id, ...(sameHead ? {} : { head: rest }), from, entries: entries.slice(from), n: ents.length });
      size += head.length + ents.slice(from).reduce((n, s) => n + s.length, 0);
      if (size > 4 << 20) ship();
    }
    ship(true);
    c.all = false;
  }
  dirty.clear();
  dirtyAll = false;
  projectsDirty = false;
}

/** this Mac's workspaces, accounts and how much of each plan is used: what the other Mac shows */
function info(): HostInfo {
  return {
    spaces: state.spaces.map((s) => ({ id: s.id, label: s.label })),
    accounts: state.accounts
      .filter((a) => a.providers.length)
      .map((a) => {
        const models = modelsNow(a.id) ?? [];
        const direct = !!connectionOf(a.id);
        const levels = direct ? Object.fromEntries(models.flatMap((m) => { const l = effortLevels(a.id, m); return l ? [[m, l]] : []; })) : undefined;
        const names = direct ? Object.fromEntries(models.flatMap((m) => { const n = connModelLabel(a.id, m); return n ? [[m, n]] : []; })) : undefined;
        return { id: a.id, space: a.space, name: accountName(a, true), services: [...new Set(a.providers.map(service))], limits: usageOf(a.id), credits: creditsOf(a.id), models, model: a.model || undefined, effort: effortFor(a.id), levels, names };
      }),
    pick: Object.fromEntries(state.spaces.map((s) => [s.id, jobs.chooseAccount(s.id, "")])),
  };
}

function sendInfo(conn: number, c: Conn) {
  const now = info();
  const json = JSON.stringify(now);
  if (json === c.info) return;
  c.info = json;
  void send(conn, { t: "info", info: now });
}

async function sendProjects(conn: number) {
  const list = (state.projects ?? []).map((p) => ({ id: p.id, name: p.name, folder: p.folder }));
  await send(conn, { t: "projects", list });
}

// ───────── what it asks

/** a new job here, from another Mac (it chose the id): in one of this Mac's projects (its workspace),
 *  or in the workspace that Mac picked; on the account it picked there, else that workspace's choice */
function create(c: Conn, f: { id: string; title: string; ask: string; project?: string; space?: string; hostSpace?: string; spaceLabel?: string; account?: string; model?: string; thinking?: string; display?: string }) {
  const p = f.project ? projectById(f.project) : undefined;
  if (f.project && !p) throw new Error("그 프로젝트가 이 Mac에 없어요");
  const space = p?.space ?? state.spaces.find((s) => s.id === f.hostSpace)?.id ?? state.spaces.find((s) => s.label === f.spaceLabel)?.id ?? state.space;
  const from = { device: c.device, space: f.space ?? "" };
  const account = f.account && state.accounts.some((a) => a.id === f.account && a.space === space) ? f.account : jobs.chooseAccount(space, p?.name ?? "");
  return jobs.createTask({ id: f.id, space, title: f.title, topic: p?.name ?? "", ask: f.ask, display: f.display, cwd: p?.folder, project: p?.id, isolate: state.settings.isolate, accountId: account, from, model: f.model, thinking: f.thinking });
}

/** what another Mac may do here: the same the user does with a job, and add a project */
const CALLS: Record<string, (...a: never[]) => unknown> = {
  addProject: (folder: string) => addProject(state.space, folder),
  tell: jobs.tell,
  stopTask: jobs.stopTask,
  resumeTask: jobs.resumeTask,
  startTask: jobs.startTask,
  mergeTask: jobs.mergeTask,
  discardTask: jobs.discardTask,
  closeWorktree: jobs.closeWorktree,
  archiveTask: jobs.archiveTask,
  removeTask: jobs.removeTask,
  renameTask: jobs.renameTask,
  duplicateTask: jobs.duplicateTask,
  editTurn: jobs.editTurn,
  steerQueued: jobs.steerQueued,
  dropQueued: jobs.dropQueued,
  editQueued: jobs.editQueued,
  moveQueued: jobs.moveQueued,
  setTaskModel: jobs.setTaskModel,
  setTaskPermission: jobs.setTaskPermission,
};

async function handle(conn: number, msg: Record<string, unknown>) {
  const c = conns.get(conn);
  if (!c) return;
  switch (msg.t) {
    case "projects":
      await sendProjects(conn);
      c.info = undefined;
      sendInfo(conn, c);
      // the model lists, asked once (they're kept): the next info carries them
      void Promise.all(state.accounts.filter((a) => a.providers.length).map((a) => refreshModels(a.id).catch(() => {}))).then(() => sendInfo(conn, c));
      break;
    case "watch":
      c.watch = new Set(Array.isArray(msg.projects) ? msg.projects.map(String) : []);
      c.all = true;
      soon();
      break;
    case "call": {
      const fn = msg.fn === "create" ? (f: Parameters<typeof create>[1]) => create(c, f) : CALLS[String(msg.fn)];
      const seq = msg.seq;
      try {
        if (!fn) throw new Error(`unknown: ${String(msg.fn)}`);
        const value = await (fn as (...a: unknown[]) => unknown)(...(Array.isArray(msg.args) ? msg.args : []));
        await send(conn, { t: "ret", seq, value: value ?? null });
      } catch (e) {
        await send(conn, { t: "ret", seq, error: e instanceof Error ? e.message : String(e) });
      }
      soon();
      break;
    }
  }
}

// ───────── letting Macs in

/** a link another Mac can add this one with, good for ten minutes and one Mac */
export async function connectLink(): Promise<string | undefined> {
  const id = remote().id;
  if (!id) return undefined;
  const code = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  await remoteCmd({ cmd: "pair", code, ttl: 600 });
  setRemote((r) => ({ ...r, pair: { code, until: Date.now() + 10 * 60_000 } }));
  const name = await remoteHostName();
  return `ondra://connect/${id}?code=${code}&name=${encodeURIComponent(name)}`;
}

export function answerPair(conn: number, ok: boolean) {
  void remoteCmd({ cmd: "approve", conn, ok }).catch(() => {});
  setRemote((r) => ({ ...r, asks: r.asks.filter((a) => a.conn !== conn), ...(ok ? { pair: undefined } : {}) }));
}

export const revokeDevice = (id: string) => void remoteCmd({ cmd: "revoke", id }).catch(() => {});

export async function setRemoteOn(on: boolean) {
  setState("settings", "remote", on);
  if (on) await startHosts();
  else {
    await remoteCmd({ cmd: "host", on: false }).catch(() => {});
    setRemote((r) => ({ ...r, live: {}, asks: [], pair: undefined }));
    if (!state.settings.hosts?.length) {
      await remoteStop();
      helperGone();
    }
  }
}

let started = false;
/** Hear the helper (both sides), and connect to the Macs added before. */
export function initRemote() {
  if (!inTauri || started) return;
  started = true;
  void onRemote((ev) => {
    switch (ev.ev) {
      case "ready":
        setRemote((r) => ({ ...r, id: String(ev.id) }));
        break;
      case "devices":
        setRemote((r) => ({ ...r, devices: (ev.list as RemoteDevice[]) ?? [] }));
        break;
      case "pair":
        setRemote((r) => ({ ...r, asks: [...r.asks, { conn: Number(ev.conn), device: ev.device as PairAsk["device"] }] }));
        break;
      case "open": {
        const conn = Number(ev.conn);
        conns.set(conn, { device: String((ev.device as { id?: string })?.id ?? ""), watch: new Set(), sent: new Map(), all: true });
        setRemote((r) => ({ ...r, live: { ...r.live, [conn]: ev.device as { id: string; name: string } } }));
        break;
      }
      case "close": {
        const conn = Number(ev.conn);
        conns.delete(conn);
        setRemote((r) => {
          const live = { ...r.live };
          delete live[conn];
          return { ...r, live, asks: r.asks.filter((a) => a.conn !== conn) };
        });
        break;
      }
      case "msg":
        if (ev.data && typeof ev.data === "object") void handle(Number(ev.conn), ev.data as Record<string, unknown>);
        break;
      case "peer":
      case "peer-msg":
        onPeer(ev);
        break;
      case "stopped":
        helperGone();
        conns.clear();
        setRemote((r) => ({ ...r, id: undefined, live: {}, asks: [] }));
        // it went away on its own while still wanted: bring it back
        if (state.settings.remote || state.settings.hosts?.length) setTimeout(() => void startHosts().then(connectHosts), 2000);
        break;
    }
  });
  // running jobs change without a store write now and then (a streamed line): look again each second
  setInterval(() => conns.size && soon(), 1000);
  // plan use moves on its own (refreshed every couple of minutes): the other Macs hear it when it does
  setInterval(() => {
    for (const [conn, c] of conns) sendInfo(conn, c);
  }, 20_000);
  if (state.settings.remote) void startHosts();
  void connectHosts();
}
