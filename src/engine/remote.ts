// Letting other Macs work on this one (Settings › 연결 › 이 Mac): a Mac the user allowed
// adds this Mac's projects to its sidebar and runs jobs in them here. Its Ondra keeps a
// live copy of those jobs (engine/hosts.ts); this side sends what changed and does what it
// asks, as if the user had done it here.
//
//   them → here  {t:"projects"} {t:"watch",projects} {t:"call",seq,fn,args}
//   here → them  {t:"projects",list} {t:"info",info} {t:"patch",tasks,gone?,all?} {t:"ret",seq,value|error}
// Files, folders and terminals of those jobs ("far.*" calls, {t:"pty…"}) are engine/farHost.ts.
//
// A job goes as its fields and its entries; after the first time only what changed: the
// fields when they did, and the entries from the first one that differs.
//
// A Mac allowed in sees and acts on only what it may reach (remoteRules.ts): the jobs of the
// projects it keeps and the ones it asked for, in the workspaces it may use here.
import { createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import { ghWatch, inTauri, onRemote, remoteAwake, remoteCmd, remoteDevices, remoteForget, remoteHostName, remoteStop, secretDelete, secretList, secretSet, secretSync, spaceEnv, type SavedSecrets } from "../lib/native";
import { forgetSecret, noteSecrets } from "./secretMemory";
import { addProject, onWrite, projectById, setState, spaceById, state, taskById, updateTask } from "../state/store";
import type { Decision, Task } from "../state/types";
import type { FarAsk, HostInfo } from "../state/mirror";
import { creditsOf, emails, loadEmail, usageOf } from "../state/limits";
import { toast } from "../state/ui";
import { t } from "../i18n";
import { accountName, service } from "../ui/AccountPicker";
import { modelsNow, refreshModels } from "./modelList";
import { connectionOf, connModelLabel, effortLevels } from "./connections";
import { effortFor } from "./models";
import * as jobs from "./tasks";
import { connectHosts, helperGone, onPeer, startHosts, wantsHelper } from "./hosts";
import { checkCall, jobsFrom, mayReach, spaceAllowed, type JobCall, type Reach } from "./remoteRules";
import { farCall, farClosed, farMsg, type FarPeer } from "./farHost";

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
  /** the questions of its jobs as last sent */
  decisions?: string;
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

/** the workspaces a Mac may use here (undefined: all) */
function spacesOf(device: string): Set<string> | undefined {
  const l = state.settings.deviceSpaces?.[device];
  return l ? new Set(l) : undefined;
}
const reach = (c: Conn): Reach => ({ device: c.device, watch: c.watch, spaces: spacesOf(c.device) });
/** what that Mac keeps: the jobs of the projects it added, and the jobs it asked for (where it may) */
const wanted = (c: Conn, t: Task) => mayReach(reach(c), t, taskById);

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
    sendDecisions(conn, c);
  }
  dirty.clear();
  dirtyAll = false;
  projectsDirty = false;
}

/** the questions the jobs that Mac keeps wait on (its cards, "내 차례"), sent when they change.
 *  A Mac too old to know {t:"decisions"} passes it by. */
export function decisionsFor(device: string, watch: Set<string>): Decision[] {
  const c = { device, watch } as Conn;
  return state.decisions.filter((d) => {
    const t = d.taskId.startsWith("main:") ? undefined : taskById(d.taskId);
    return !!t && !t.host && wanted(c, t);
  });
}
function sendDecisions(conn: number, c: Conn) {
  const list = decisionsFor(c.device, c.watch);
  const json = JSON.stringify(list);
  if (json === c.decisions) return;
  c.decisions = json;
  void send(conn, { t: "decisions", list });
}

/** this Mac's workspaces, accounts and how much of each plan is used: what the other Mac shows */
let version: string | undefined;
void import("@tauri-apps/api/app").then((m) => m.getVersion()).then((v) => (version = v)).catch(() => {});

function info(device: string): HostInfo {
  const may = spacesOf(device);
  const spaces = state.spaces.filter((s) => spaceAllowed(may, s.id));
  return {
    version,
    spaces: spaces.map((s) => ({ id: s.id, label: s.label })),
    accounts: state.accounts
      .filter((a) => a.providers.length && spaceAllowed(may, a.space))
      .map((a) => {
        const models = modelsNow(a.id) ?? [];
        const direct = !!connectionOf(a.id);
        const levels = direct ? Object.fromEntries(models.flatMap((m) => { const l = effortLevels(a.id, m); return l ? [[m, l]] : []; })) : undefined;
        const names = direct ? Object.fromEntries(models.flatMap((m) => { const n = connModelLabel(a.id, m); return n ? [[m, n]] : []; })) : undefined;
        return { id: a.id, space: a.space, name: accountName(a, true), email: emails[a.id] || undefined, services: [...new Set(a.providers.map(service))], limits: usageOf(a.id), credits: creditsOf(a.id), models, model: a.model || undefined, effort: effortFor(a.id), levels, names };
      }),
    pick: Object.fromEntries(spaces.map((s) => [s.id, jobs.chooseAccount(s.id, "")])),
  };
}

function sendInfo(conn: number, c: Conn) {
  const now = info(c.device);
  const json = JSON.stringify(now);
  if (json === c.info) return;
  c.info = json;
  void send(conn, { t: "info", info: now });
}

async function sendProjects(conn: number) {
  const may = spacesOf(conns.get(conn)?.device ?? "");
  // each with its workspace's name, so the other Mac shows it in the tab of that name
  const list = (state.projects ?? []).filter((p) => spaceAllowed(may, p.space)).map((p) => ({ id: p.id, name: p.name, folder: p.folder, space: state.spaces.find((s) => s.id === p.space)?.label }));
  await send(conn, { t: "projects", list });
}

// ───────── what it asks

/** a new job here, from another Mac (it chose the id): in one of this Mac's projects (its workspace),
 *  or in the workspace that Mac picked; on the account it picked there, else that workspace's choice */
export function create(c: { device: string }, f: FarAsk) {
  if (!f || typeof f !== "object" || typeof f.ask !== "string") throw new Error("bad request");
  // this Mac's own project only (never one shown here from a third Mac)
  const p = f.project && !f.project.startsWith("r:") ? projectById(f.project) : undefined;
  if (f.project && !p) throw new Error("그 프로젝트가 이 Mac에 없어요");
  const space = p?.space ?? state.spaces.find((s) => s.id === f.hostSpace)?.id ?? state.spaces.find((s) => s.label === f.spaceLabel)?.id ?? state.space;
  if (!spaceAllowed(spacesOf(c.device), space)) throw new Error("그 워크스페이스는 쓸 수 없어요");
  const from = { device: c.device, space: f.space ?? "" };
  const account = f.account && state.accounts.some((a) => a.id === f.account && a.space === space) ? f.account : jobs.chooseAccount(space, p?.name ?? "");
  // ids it builds on must be jobs of this Mac in that workspace (the ones that Mac was shown)
  const mine = (id: unknown) => {
    const t = typeof id === "string" ? taskById(id) : undefined;
    return t && !t.host && t.space === space ? t.id : undefined;
  };
  const after = (Array.isArray(f.after) ? f.after : []).map(mine).filter((x): x is string => !!x);
  const reach = (Array.isArray(f.reach) ? f.reach : []).map((l) => state.spaces.find((s) => s.label === l)?.id).filter((x): x is Task["space"] => !!x && x !== space);
  const id = jobs.createTask({
    id: f.id, space, title: f.title, topic: p?.name ?? "", ask: f.ask, display: f.display, cwd: p?.folder, project: p?.id,
    isolate: typeof f.isolate === "boolean" ? f.isolate : state.settings.isolate, accountId: account, from, model: f.model, thinking: f.thinking,
    ...(typeof f.branch === "string" && f.branch ? { branch: f.branch } : {}),
    ...(f.priority === 0 || f.priority === 1 || f.priority === 2 || f.priority === 3 ? { priority: f.priority } : {}),
    ...(f.weight === "light" || f.weight === "heavy" ? { weight: f.weight } : {}),
    ...(f.origin && typeof f.origin.path === "string" ? { origin: f.origin } : {}),
    ...(after.length ? { after } : {}),
    ...(reach.length ? { reach } : {}),
    ...(mine(f.follows) ? { follows: mine(f.follows) } : {}),
    ...(f.issue && typeof f.issue.n === "number" ? { issue: f.issue } : {}),
    ...(typeof f.by === "string" && f.by ? { by: f.by } : {}),
  });
  // asked with a permission of its own (that Mac's default, or the one picked there)
  if (f.permission === "ask" || f.permission === "edits" || f.permission === "full") updateTask(id, (x) => (x.permission = f.permission));
  return id;
}

/** One of this Mac's projects' secrets, for Settings › 시크릿 on the Mac that added it: its saved names
 *  (and how many came in from its .env), never a value. A value comes this way only to be saved. */
export interface FarSecrets { items: string[]; added?: number; notIgnored?: boolean }
const projectFolder = (id: unknown) => {
  const p = typeof id === "string" ? projectById(id) : undefined;
  if (!p || p.host) throw new Error("그 프로젝트가 이 Mac에 없어요");
  return p;
};
const namesOf = (s: SavedSecrets, project: string): string[] => s.projects[project] ?? [];
export const secretCalls = {
  secretList: async (project: string): Promise<FarSecrets> => ({ items: namesOf(await secretList(), projectFolder(project).id) }),
  // what its .env files hold comes in first, as when the page opens here
  secretSync: async (project: string): Promise<FarSecrets> => {
    const p = projectFolder(project);
    const r = await secretSync([[p.id, p.folder]]);
    noteSecrets(r.saved, state.projects ?? []);
    return { items: namesOf(r.saved, p.id), added: r.added.length };
  },
  secretSet: async (o: { project: string; name: string; value: string; writeDotenv?: boolean; addIgnore?: boolean }): Promise<FarSecrets> => {
    const p = projectFolder(o?.project);
    if (typeof o.name !== "string" || typeof o.value !== "string" || !o.name || !o.value) throw new Error("이름과 값이 필요해요");
    try {
      const s = await secretSet({ name: o.name, value: o.value, project: p.id, folder: p.folder, writeDotenv: !!o.writeDotenv, addIgnore: !!o.addIgnore });
      noteSecrets(s, state.projects ?? []);
      return { items: namesOf(s, p.id) };
    } catch (e) {
      // .env isn't ignored by git there: that Mac's user is asked first, as here
      if (String(e instanceof Error ? e.message : e).startsWith("ENV_NOT_IGNORED")) return { items: namesOf(await secretList(), p.id), notIgnored: true };
      throw e;
    }
  },
  secretDelete: async (o: { project: string; name: string }): Promise<FarSecrets> => {
    const p = projectFolder(o?.project);
    const s = await secretDelete({ name: String(o.name ?? ""), project: p.id, folder: p.folder });
    forgetSecret(p.id, String(o.name ?? ""));
    return { items: namesOf(s, p.id) };
  },
};

/** a folder there made a project here: in the workspace that Mac named (by its name here) if it may
 *  use it, else the one in use, else the first one it may use */
function addProjectFor(c: Conn, folder: unknown, label?: unknown) {
  if (typeof folder !== "string" || !folder.trim()) throw new Error("bad request");
  const may = spacesOf(c.device);
  const named = state.spaces.find((s) => s.label === label)?.id;
  const space = named && spaceAllowed(may, named) ? named : spaceAllowed(may, state.space) ? state.space : state.spaces.find((s) => spaceAllowed(may, s.id))?.id;
  if (!space) throw new Error("그 워크스페이스는 쓸 수 없어요");
  return addProject(space, folder);
}

/** what another Mac may do with a job here: the same the user does (checked by checkCall first) */
const JOBS: Record<JobCall, (...a: never[]) => unknown> = {
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
  finishTask: jobs.finishTask,
  pauseTask: jobs.pauseTask,
  togglePin: jobs.togglePin,
  setPriority: jobs.setPriority,
  setWeight: jobs.setWeight,
  setTaskAccount: jobs.setTaskAccount,
};

/** calls about one of this Mac's projects (its id first, or in the first argument's `project`):
 *  only a project that Mac keeps, in a workspace it may use */
const PROJECT_CALLS: Record<string, (...a: never[]) => unknown> = {
  // a project's secrets (Settings › 시크릿): names come back, never a value
  ...secretCalls,
  // 루틴 on another Mac: a routine there that watches one of this Mac's projects looks at its GitHub
  // repo here, as this Mac's GitHub login (only a project this Mac has, never a path)
  ghWatch: async (project: string, event: string, search: string) => {
    const p = projectById(project)!;
    return ghWatch(p.folder, event, typeof search === "string" ? search : "", await spaceEnv(spaceById(p.space)));
  },
};
const projectOfArgs = (args: unknown[]) => (typeof args[0] === "string" ? args[0] : typeof (args[0] as { project?: unknown })?.project === "string" ? (args[0] as { project: string }).project : undefined);
function mayUseProject(c: Conn, id: string | undefined) {
  const p = id ? projectById(id) : undefined;
  if (!p || p.host || !c.watch?.has(p.id) || !spaceAllowed(spacesOf(c.device), p.space)) throw new Error("그 프로젝트는 쓸 수 없어요");
}

// ───────── files, folders and terminals of the jobs it sees (engine/farHost.ts checks each path and job)

/** the Mac on that connection, as farHost.ts asks about it: only the projects it keeps in the
 *  workspaces it may use, and the jobs it may reach */
const peerOf = (conn: number, c: Conn): FarPeer => {
  const may = spacesOf(c.device);
  const watch = new Set([...c.watch].filter((id) => { const p = projectById(id); return !!p && spaceAllowed(may, p.space); }));
  return { conn, device: c.device, watch, sees: (t) => !t.host && wanted(c, t), send: (data) => void send(conn, data) };
};

async function handle(conn: number, msg: Record<string, unknown>) {
  const c = conns.get(conn);
  if (!c) return;
  if (msg.t === "pty-in" || msg.t === "pty-size") return farMsg(peerOf(conn, c), msg);
  switch (msg.t) {
    case "projects":
      await sendProjects(conn);
      c.info = undefined;
      sendInfo(conn, c);
      // the model lists, asked once (they're kept): the next info carries them
      void Promise.all(state.accounts.filter((a) => a.providers.length).flatMap((a) => [refreshModels(a.id).catch(() => {}), loadEmail(a.id).catch(() => {})])).then(() => sendInfo(conn, c));
      break;
    case "watch":
      c.watch = new Set(Array.isArray(msg.projects) ? msg.projects.map(String) : []);
      c.all = true;
      soon();
      break;
    case "call": {
      const fn = String(msg.fn);
      const args: unknown[] = Array.isArray(msg.args) ? msg.args : [];
      const seq = msg.seq;
      try {
        let value: unknown;
        if (fn === "create") value = create(c, args[0] as Parameters<typeof create>[1]);
        else if (fn === "addProject") value = addProjectFor(c, args[0], args[1]);
        else if (fn === "decide") {
          // a question of a job that Mac may reach
          const d = state.decisions.find((x: Decision) => x.id === args[0]);
          if (!d || !mayReach(reach(c), taskById(d.taskId), taskById)) throw new Error("그 작업은 쓸 수 없어요");
          value = await jobs.decide(String(args[0]), String(args[1]));
        } else if (fn === "handOn") {
          // both ends of the hand-over must be jobs it may reach
          if (![args[0], args[1]].every((id) => typeof id === "string" && mayReach(reach(c), taskById(id), taskById))) throw new Error("그 작업은 쓸 수 없어요");
          value = jobs.handOn(String(args[0]), String(args[1]));
        } else if (fn.startsWith("far.")) {
          // a job's files, folders and terminal: farHost.ts checks each path and job
          const f = farCall(peerOf(conn, c), fn);
          if (!f) throw new Error(`unknown: ${fn}`);
          value = await f(...args);
        } else if (PROJECT_CALLS[fn]) {
          mayUseProject(c, projectOfArgs(args));
          value = await (PROJECT_CALLS[fn] as (...a: unknown[]) => unknown)(...args);
        } else {
          // only a job that Mac may reach, and only the calls a job has
          const ok = checkCall(reach(c), fn, args, taskById);
          value = await (JOBS[fn as JobCall] as (...a: unknown[]) => unknown)(...ok);
          // the copy is that Mac's too: it sees it like the one it copied
          const was = taskById(String(ok[0]));
          if (fn === "duplicateTask" && typeof value === "string") updateTask(value, (x) => (x.from = { device: c.device, space: was?.from?.space ?? "" }));
        }
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

const deviceName = (id: string) => remote().devices.find((d) => d.id === id)?.name ?? Object.values(remote().live).find((d) => d.id === id)?.name ?? "Mac";

/** 연결 끊기 (this side): that Mac's connection ends now; it stays allowed and may come back */
export function dropDevice(id: string) {
  remoteCmd({ cmd: "drop", id }).catch((e) => toast(t("연결을 끊지 못했어요: {error}", { error: String(e) }), "bad"));
}

/** 제거 (this side): that Mac may no longer come in. Works with the helper running or not. */
export async function forgetDevice(id: string) {
  const name = deviceName(id);
  try {
    const list = await remoteForget(id);
    if (list) setRemote((r) => ({ ...r, devices: list }));
  } catch (e) {
    toast(t("제거하지 못했어요: {error}", { error: String(e) }), "bad");
    return;
  }
  forgotten(id, name, t("{name}을(를) 제거했어요", { name }));
}

/** a Mac is gone from the list (removed here, or it removed this one): its grants go, its jobs are named */
function forgotten(id: string, name: string, said: string) {
  if (state.settings.deviceSpaces?.[id]) setDeviceSpaces(id, undefined);
  const left = jobsFrom(state.tasks, id);
  if (!left.length) return void toast(said);
  // they keep running: the user decides
  toast(t("{name}에서 시킨 작업 {n}개는 계속 돌아요", { name, n: left.length }), "info", { label: t("정리|jobs"), run: () => askStopJobs(id, name) }, { stay: true });
}

/** stop and archive the jobs that Mac asked for here, after asking (named, so it's plain which) */
export function askStopJobs(id: string, name: string) {
  const left = jobsFrom(state.tasks, id);
  if (!left.length) return;
  const shown = left.slice(0, 3).map((x) => x.title);
  if (left.length > 3) shown.push(t("외 {n}개", { n: left.length - 3 }));
  void import("../ui/taskMenu").then((m) =>
    m.confirmAsk({
      title: t("{name}에서 시킨 작업 {n}개를 멈추고 보관할까요?", { name, n: left.length }),
      body: shown.join(" · "),
      action: t("멈추고 보관"),
      run: () => {
        for (const x of left) {
          if (x.status === "running" || x.status === "waiting" || x.status === "queued") jobs.stopTask(x.id);
          updateTask(x.id, (y) => ((y.archived = true), (y.pinned = false)));
        }
        toast(t("작업 {n}개를 보관했어요", { n: left.length }));
      },
    }),
  );
}

/** the workspaces a Mac allowed in may use here (undefined: all); what it sees changes at once */
export function setDeviceSpaces(id: string, spaces: string[] | undefined) {
  const next = { ...(state.settings.deviceSpaces ?? {}) };
  delete next[id];
  if (spaces) next[id] = spaces;
  // replaced whole: a store merges objects
  setState("settings", "deviceSpaces", undefined);
  setState("settings", "deviceSpaces", next);
  for (const [conn, c] of conns) {
    if (c.device !== id) continue;
    c.all = true;
    c.info = undefined;
    void sendProjects(conn);
    sendInfo(conn, c);
  }
  soon();
}

/** keep this Mac awake while others may work on it (and only then) */
export function keepAwake() {
  void remoteAwake(!!state.settings.remote && !!state.settings.remoteAwake).catch(() => {});
}

export async function setRemoteOn(on: boolean) {
  setState("settings", "remote", on);
  keepAwake();
  if (on) await startHosts();
  else {
    await remoteCmd({ cmd: "host", on: false }).catch(() => {});
    setRemote((r) => ({ ...r, live: {}, asks: [], pair: undefined }));
    if (!wantsHelper()) {
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
  keepAwake();
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
        farClosed(conn);
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
      case "bye": {
        // that Mac removed this one on its side: it's gone from the list here too (the helper did it)
        const d = ev.device as { id?: string; name?: string } | undefined;
        if (d?.id) forgotten(d.id, d.name || "Mac", t("{name}에서 이 Mac 연결을 제거했어요", { name: d.name || "Mac" }));
        break;
      }
      case "peer":
      case "peer-msg":
        onPeer(ev);
        break;
      case "stopped":
        helperGone();
        for (const conn of conns.keys()) farClosed(conn);
        conns.clear();
        setRemote((r) => ({ ...r, id: undefined, live: {}, asks: [] }));
        // it went away on its own while still wanted: bring it back
        if (state.settings.remote || wantsHelper()) setTimeout(() => void startHosts().then(connectHosts), 2000);
        break;
    }
  });
  // running jobs change without a store write now and then (a streamed line): look again each second
  setInterval(() => conns.size && soon(), 1000);
  // plan use moves on its own (refreshed every couple of minutes): the other Macs hear it when it does
  setInterval(() => {
    for (const [conn, c] of conns) sendInfo(conn, c);
  }, 20_000);
  // the Macs allowed in show (and can be removed) even while the helper isn't running
  void remoteDevices().then((list) => setRemote((r) => (r.devices.length ? r : { ...r, devices: list }))).catch(() => {});
  if (state.settings.remote) void startHosts();
  void connectHosts();
}
