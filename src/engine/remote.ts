// Letting other Macs work on this one (Settings › 연결): a Mac the user allowed
// adds this Mac's projects to its sidebar and runs jobs in them here. Its Ondra keeps a
// live copy of those jobs (engine/hosts.ts); this side sends what changed and does what it
// asks, as if the user had done it here.
//
//   them → here  {t:"projects"} {t:"watch",projects,sessions?,same?} {t:"call",seq,fn,args}
//   here → them  {t:"projects",list} {t:"info",info} {t:"patch",tasks,gone?,all?} {t:"decisions",list}
//                {t:"chat",msgs,gone?,asks?,all?} {t:"ui",set,all?} {t:"settings",settings} {t:"agent",agent} {t:"ret",seq,value|error}
// A device that asks for `same` (and may use every workspace here) also gets this device's main and
// project chats, its screen state in its workspaces and its app settings, and may act on them
// (state/shared.ts): a workspace is then the same on both. One that asks for `agent` as well sees this
// device's Discord agent in its 에이전트 tab: its chat (not written to from there), its work and
// questions, its memory, ways and routines, and its Settings › 에이전트 (seen, not changed from there).
// Files, folders and terminals of those jobs ("far.*" calls, {t:"pty…"}) are engine/farHost.ts.
//
// A job goes as its fields and its entries; after the first time only what changed: the
// fields when they did, and the entries from the first one that differs.
//
// A Mac allowed in sees and acts on only what it may reach (remoteRules.ts): the jobs of the
// projects it keeps and the ones it asked for, in the workspaces it may use here.
import type { FormValues } from "./form";
import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { produce, unwrap } from "solid-js/store";
import { discordTokenHas, ghWatch, inTauri, onRemote, remoteAwake, remoteCmd, remoteDevices, remoteForget, remoteHostName, secretDelete, secretList, secretSet, secretSync, spaceEnv, type SavedSecrets } from "../lib/native";
import { forgetSecret, noteSecrets } from "./secretMemory";
import { isAgentChat, onWrite, ownSpaces, projectById, setState, spaceById, state, taskById, updateTask } from "../state/store";
import { applyUi, sharedUi, uiSpace } from "../state/shared";
import { viewState } from "../state/viewState";
import { onDraft } from "../state/drafts";
import { sharedSettings, setShared } from "./appSettings";
import * as captain from "./captain";
import { permissionOf } from "../state/persist";
import type { CaptainMessage, Decision, SpaceId, Task } from "../state/types";
import type { FarAgent, FarAgentSettings, FarAsk, HostInfo } from "../state/mirror";
import { roomName } from "./discordPeople";
import { creditsOf, emails, loadEmail, usageOf } from "../state/limits";
import { toast } from "../state/ui";
import { t } from "../i18n";
import { accountName, service } from "../ui/AccountPicker";
import { modelsNow, refreshModels } from "./modelList";
import { connectionOf, connModelLabel, effortLevels } from "./connections";
import { effortFor } from "./models";
import * as jobs from "./tasks";
import { connectHosts, dialBack, forgotBy, fromInSide, helperGone, hostName, onPeer, removeHost, startHosts, wantsHelper } from "./hosts";
import { checkCall, jobsFrom, mayReach, spaceAllowed, type JobCall, type Reach } from "./remoteRules";
import { farCall, farClosed, farMsg, type FarPeer } from "./farHost";
import { moveCancel, moveImport, movePut } from "./spaceMove";
import { mirrorReplacer } from "./farMirror";
import { mirrorPath, normPath } from "./farPaths";
import { engine } from "./rpc";
import { agentStatus, onAgentStatus } from "./discord";
import { readWays } from "./agentWays";
import { forgetNote } from "./agentMemory";
import * as hub from "./agentHub";
import { AGENT_JOB_KEYS } from "./agentJobs";

interface RemoteDevice { id: string; name: string; addedAt: number; lastSeen: number }
interface PairAsk { conn: number; device: { id: string; name: string } }

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
  /** it keeps the work done in its workspaces too (newer devices ask for it) */
  sessions?: boolean;
  /** each job as last sent: its fields' JSON and each entry's */
  sent: Map<string, { head: string; ents: string[] }>;
  /** send everything again (just asked) */
  all: boolean;
  /** the workspaces and accounts as last sent */
  info?: string;
  /** the questions of its jobs as last sent */
  decisions?: string;
  /** it wants the chats, screen state and settings too (state/shared.ts) */
  same?: boolean;
  /** it shows this device's Discord agent too */
  agent?: boolean;
  /** each chat message as last sent; main's questions; each screen value; the settings */
  chatSent?: Map<string, string>;
  asksSent?: string;
  uiSent?: Map<string, string>;
  settingsSent?: string;
  agentSent?: string;
  hubSent?: string;
}
const conns = new Map<number, Conn>();
const send = (conn: number, data: Record<string, unknown>) => remoteCmd({ cmd: "send", conn, data }).catch(() => {});

// ───────── what changed

const dirty = new Set<string>();
let dirtyAll = false;
let projectsDirty = false;
/** the chats, screen state or settings changed */
let sharedDirty = false;
viewState.onPut((k) => k.startsWith("sp:") && ((sharedDirty = true), soon()));
onDraft(() => ((sharedDirty = true), soon()));
onWrite((args) => {
  if (!conns.size) return;
  if (args[0] === "projects") projectsDirty = true;
  if (args[0] === "captain" || args[0] === "decisions" || args[0] === "canvas" || args[0] === "settings" || args[0] === "agentNotes" || args[0] === "routines") sharedDirty = true;
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
type Asked = Pick<Conn, "device" | "watch" | "sessions" | "same" | "agent">;
const reach = (c: Asked): Reach => ({ device: c.device, watch: c.watch, sessions: c.sessions, agent: showsAgent(c), hub: holdsAgent(c), spaces: spacesOf(c.device) });
/** the device holding the Discord agent's connection (engine/agentHub.ts): the agent's work here goes to it */
const holdsAgent = (c: Pick<Conn, "device">) => !!c.device && state.settings.agent?.hub === c.device;
/** what that device keeps: the jobs of the projects it added, and the jobs it asked for (where it may) */
const wanted = (c: Conn, t: Task) => mayReach(reach(c), t, taskById);

function flush() {
  timer = undefined;
  const paths = mirrorReplacer(engine.info.home);
  const live = state.tasks.filter((x) => x.status === "running" || x.status === "waiting");
  for (const [conn, c] of conns) {
    if (projectsDirty) void sendProjects(conn);
    sendHub(conn, c);
    if (!c.watch.size && !c.sessions && !c.sent.size && !c.all && !holdsAgent(c)) continue;
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
      const { entries, pickedFiles: _hostOnly, ...rest } = raw;
      const head = JSON.stringify(rest, paths);
      const ents = entries.map((e) => JSON.stringify(e, paths));
      const before = c.sent.get(t.id);
      let from = 0;
      if (before) while (from < ents.length && from < before.ents.length && ents[from] === before.ents[from]) from++;
      const sameHead = before?.head === head;
      if (before && sameHead && from === ents.length && before.ents.length === ents.length) continue;
      c.sent.set(t.id, { head, ents });
      out.push({ id: t.id, ...(sameHead ? {} : { head: paths ? JSON.parse(head) : rest }), from, entries: paths ? ents.slice(from).map((e) => JSON.parse(e)) : entries.slice(from), n: ents.length });
      size += head.length + ents.slice(from).reduce((n, s) => n + s.length, 0);
      if (size > 4 << 20) ship();
    }
    ship(true);
    c.all = false;
    sendDecisions(conn, c);
  }
  // main still answering: its words come in without a store write
  const answering = sharedDirty || state.captain.some((m) => m.pending);
  for (const [conn, c] of conns) if (answering || !c.chatSent) sendShared(conn, c);
  sharedDirty = false;
  dirty.clear();
  dirtyAll = false;
  projectsDirty = false;
}

/** a device that sees this one's chats, screen state and settings: it asked, and it may use every workspace */
function sharesWith(c: Pick<Conn, "device" | "same">) {
  return !!c.same && !spacesOf(c.device);
}
/** such a device that shows this one's Discord agent too (it asked) */
function showsAgent(c: Pick<Conn, "device" | "same" | "agent">) {
  return !!c.agent && sharesWith(c);
}
const ownChat = (space: string) => ownSpaces().some((s) => s.id === space);
/** a chat such a device may act on: in this device's own workspaces, never the Discord agent's */
const sharedChat = (space: string, project?: string) => ownChat(space) && !isAgentChat(captain.chatKey(space as SpaceId, project));
/** a chat it sees: those, and the agent's when it shows the agent */
const seenChat = (c: Conn, space: string, project?: string) => sharedChat(space, project) || (showsAgent(c) && ownChat(space));
const chatOf = (key: string) => {
  const [space, project] = key.split("~");
  return { space: space as SpaceId, project: project || undefined };
};

/** what changed of this device's chats, screen state and settings since that device last heard */
function sendShared(conn: number, c: Conn) {
  if (!sharesWith(c)) return;
  const paths = mirrorReplacer(engine.info.home);
  const all = !c.chatSent;
  const sent = (c.chatSent ??= new Map());
  const msgs: unknown[] = [];
  const seen = new Set<string>();
  for (const m of state.captain) {
    if (!seenChat(c, m.space, m.project)) continue;
    seen.add(m.id);
    const key = captain.chatKey(m.space, m.project);
    const draft = m.pending ? captain.mainDraft(key, m.id) : "";
    const thought = m.pending ? captain.mainThought(key) : "";
    const json = JSON.stringify({ ...unwrap(m), ...(draft ? { draft } : {}), ...(thought ? { thought } : {}) }, paths);
    if (sent.get(m.id) === json) continue;
    sent.set(m.id, json);
    msgs.push(JSON.parse(json));
  }
  const gone = [...sent.keys()].filter((id) => !seen.has(id));
  for (const id of gone) sent.delete(id);
  const asks = state.decisions.filter((d) => d.taskId.startsWith("main:") && seenChat(c, chatOf(d.taskId.slice(5)).space, chatOf(d.taskId.slice(5)).project));
  const asksJson = JSON.stringify(asks);
  const asksNew = asksJson !== c.asksSent;
  c.asksSent = asksJson;
  // in parts a message can carry (the first says it's all of them)
  let part: unknown[] = [];
  let size = 0;
  let first = true;
  const out = (last: boolean) => {
    void send(conn, { t: "chat", msgs: part, ...(first && all ? { all: true } : {}), ...(last && gone.length ? { gone } : {}), ...(last && (asksNew || all) ? { asks } : {}) });
    first = false;
    part = [];
    size = 0;
  };
  for (const m of msgs) {
    part.push(m);
    size += sent.get((m as CaptainMessage).id)?.length ?? 0;
    if (size > 2 << 20) out(false);
  }
  if (part.length || gone.length || asksNew || all) out(true);

  const ui = sharedUi();
  const uiAll = !c.uiSent;
  const uiSent = (c.uiSent ??= new Map());
  const set: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ui)) {
    const json = JSON.stringify(v);
    if (uiSent.get(k) === json) continue;
    uiSent.set(k, json);
    set[k] = v;
  }
  for (const k of [...uiSent.keys()]) if (!(k in ui)) (uiSent.delete(k), (set[k] = null));
  if (uiAll || Object.keys(set).length) void send(conn, { t: "ui", set, ...(uiAll ? { all: true } : {}) });

  const settings = sharedSettings();
  const json = JSON.stringify(settings);
  if (json !== c.settingsSent) (c.settingsSent = json), void send(conn, { t: "settings", settings });

  if (!showsAgent(c)) return;
  const agent = agentNow();
  const agentJson = JSON.stringify(agent);
  if (agentJson !== c.agentSent) (c.agentSent = agentJson), void send(conn, { t: "agent", agent });
}

/** the agent's ways (agent/AGENT.md) and whether a bot token is kept, as last read: read now and then */
let ways = "";
let token = false;
async function readAgentWays() {
  const [now, has] = await Promise.all([readWays().catch(() => ways), discordTokenHas().catch(() => token)]);
  if (now !== ways || has !== token) (ways = now), (token = has), (sharedDirty = true), soon();
}

/** whether this device holds the Discord agent's connection, to every device let in (engine/agentHub.ts) */
function sendHub(conn: number, c: Conn) {
  const now = JSON.stringify({ on: hub.holding(), at: state.settings.agent?.claimAt ?? 0 });
  if (now !== c.hubSent) (c.hubSent = now), void send(conn, { t: "hub", ...JSON.parse(now) });
}

/** this device's Discord agent as another device's 에이전트 tab shows it */
function agentNow(): FarAgent {
  const a = state.settings.agent;
  const s = agentStatus();
  return {
    name: a?.name || "메타몽",
    on: !!a?.on,
    status: { state: s.state, ...(s.why ? { why: s.why } : {}) },
    notes: state.agentNotes ?? [],
    ways,
    routines: (state.routines ?? []).filter((r) => r.agent && !r.draft && ownChat(r.space)),
    settings: agentSettingsNow(),
  };
}

/** its Settings › 에이전트 as that device's settings page shows it: whether a token is kept, never the token */
function agentSettingsNow(): FarAgentSettings {
  const a = state.settings.agent;
  const places = a?.places ?? [];
  // a place may be a workspace of a third device: named here, as this device knows it
  const spaces: Record<string, { label: string; device?: string }> = {};
  for (const id of [a?.space, ...places.map((p) => p.space)]) {
    const sp = id ? state.spaces.find((x) => x.id === id) : undefined;
    if (sp) spaces[sp.id] = { label: sp.label, ...(sp.host ? { device: hostName(sp.host) } : {}) };
  }
  const channels = a?.channels ?? [];
  const rooms: Record<string, string> = {};
  for (const id of [...places.map((p) => p.channel), ...channels]) {
    const name = roomName(id);
    if (name) rooms[id] = `#${name}`;
  }
  return {
    token,
    ...(a?.ownerId ? { ownerId: a.ownerId } : {}),
    ...(a?.voice ? { voice: a.voice } : {}),
    others: a?.others !== false,
    ...(a?.space ? { space: a.space } : {}),
    ...(a?.account ? { account: a.account } : {}),
    places: places.map((p) => ({ channel: p.channel, ...(p.label ? { label: p.label } : {}), ...(p.space ? { space: p.space } : {}), ...(p.account ? { account: p.account } : {}) })),
    spaces,
    channels,
    rooms,
  };
}

/** a chat of this device's, as that device names it: one it may see */
function sharedChatOf(c: Conn, o: unknown): { space: SpaceId; project?: string } {
  const a = (o ?? {}) as { space?: unknown; project?: unknown };
  const space = String(a.space ?? "") as SpaceId;
  const project = typeof a.project === "string" && a.project ? a.project : undefined;
  const p = project ? projectById(project) : undefined;
  if (!sharesWith(c) || !sharedChat(space, project) || (project && (!p || p.host || p.space !== space))) throw new Error("그 채팅은 쓸 수 없어요");
  return { space, project };
}

/** what a device that shares this one's chats and settings may do in them (as the user would here) */
const SHARED_CALLS: Record<string, (c: Conn, args: unknown[]) => unknown> = {
  say: (c, [o]) => {
    const a = (o ?? {}) as { text?: unknown; me?: unknown; reply?: unknown };
    const { space, project } = sharedChatOf(c, o);
    if (typeof a.text !== "string" || !a.text.trim()) throw new Error("bad request");
    const id = (x: unknown) => (typeof x === "string" && /^[\w-]{1,64}$/.test(x) && !state.captain.some((m) => m.id === x) ? x : undefined);
    return captain.throwThought(a.text, space, { project, ids: { me: id(a.me), reply: id(a.reply) } });
  },
  mainStop: (c, [o]) => {
    const { space, project } = sharedChatOf(c, o);
    return captain.stopMain(captain.chatKey(space, project));
  },
  mainClear: (c, [o]) => {
    const { space, project } = sharedChatOf(c, o);
    return captain.resetMain(space, project);
  },
  mainEdit: (c, [id, text]) => {
    const m = state.captain.find((x) => x.id === id);
    if (!m || typeof text !== "string") throw new Error("bad request");
    sharedChatOf(c, m);
    return captain.editMain(m.id, text);
  },
  ui: (c, [key, value]) => {
    if (!sharesWith(c) || typeof key !== "string" || !uiSpace(key)) throw new Error("bad request");
    applyUi(key, value);
    // that device has it already: not sent back over what is typed or dragged there now
    c.uiSent?.set(key, JSON.stringify(sharedUi()[key] ?? null));
    if (!(key in sharedUi())) c.uiSent?.delete(key);
  },
  setSetting: (c, [key, value]) => {
    if (!sharesWith(c)) throw new Error("bad request");
    return setShared(String(key), value);
  },
  // a tab of this device's settings for that device's Settings (views/farPages.ts), in its language;
  // loaded when asked, as it reads the settings pages' helpers
  settingsPage: async (c, [tab, l]) => {
    if (!sharesWith(c) || typeof tab !== "string") throw new Error("bad request");
    return (await import("../views/farPages")).farPage(tab, l === "en" ? "en" : "ko");
  },
  // 잊기 in that device's 에이전트 tab: one of the agent's own notes here
  agentForget: (c, [id]) => {
    if (!showsAgent(c) || typeof id !== "string" || !state.agentNotes?.some((n) => n.id === id)) throw new Error("bad request");
    forgetNote(id);
  },
};

/** the questions the jobs that device keeps wait on (its cards, "내 차례"), sent when they change.
 *  A Mac too old to know {t:"decisions"} passes it by. */
export function decisionsFor(c: Asked): Decision[] {
  return state.decisions.filter((d) => {
    const t = d.taskId.startsWith("main:") ? undefined : taskById(d.taskId);
    return !!t && !t.host && mayReach(reach(c), t, taskById);
  });
}
function sendDecisions(conn: number, c: Conn) {
  const list = decisionsFor(c);
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
  const spaces = ownSpaces().filter((s) => spaceAllowed(may, s.id));
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
  // each with its workspace (its id, and its name for a device too old to know the id), so the other
  // device shows it in that workspace's tab
  const list = (state.projects ?? []).filter((p) => !p.host && spaceAllowed(may, p.space)).map((p) => ({ id: p.id, name: p.name, folder: mirrorPath(p.folder, engine.info.home), space: state.spaces.find((s) => s.id === p.space)?.label, spaceId: p.space }));
  await send(conn, { t: "projects", list });
}

// ───────── what it asks

/** a new job here, from another device (it chose the id): in one of this Mac's projects (its workspace),
 *  or in the workspace that device picked; on the account it picked there, else that workspace's choice */
export function create(c: Asked, f: FarAsk) {
  if (!f || typeof f !== "object" || typeof f.ask !== "string") throw new Error("bad request");
  // this Mac's own project only (never one shown here from a third Mac)
  const p = f.project && !f.project.startsWith("r:") ? projectById(f.project) : undefined;
  if (f.project && !p) throw new Error("그 프로젝트가 이 기기에 없어요");
  const own = ownSpaces();
  const space = p?.space ?? own.find((s) => s.id === f.hostSpace)?.id ?? own.find((s) => s.label === f.spaceLabel)?.id ?? (own.some((s) => s.id === state.space) ? state.space : own[0]?.id);
  if (!space) throw new Error("그 워크스페이스는 쓸 수 없어요");
  const access = reach(c);
  if (!spaceAllowed(access.spaces, space)) throw new Error("그 워크스페이스는 쓸 수 없어요");
  const from = { device: c.device, space: f.space ?? "" };
  const account = f.account && state.accounts.some((a) => a.id === f.account && a.space === space) ? f.account : jobs.chooseAccount(space, p?.name ?? "");
  // ids it builds on must be jobs of this Mac in that workspace (the ones that device was shown)
  const mine = (id: unknown) => {
    const t = typeof id === "string" ? taskById(id) : undefined;
    return t && t.space === space && mayReach(access, t, taskById) ? t.id : undefined;
  };
  const after = (Array.isArray(f.after) ? f.after : []).map(mine).filter((x): x is string => !!x);
  const extraSpaces = (Array.isArray(f.reach) ? f.reach : []).map((l) => own.find((s) => s.label === l)?.id).filter((x): x is Task["space"] => !!x && x !== space && spaceAllowed(access.spaces, x));
  const id = jobs.createTask({
    id: f.id, space, title: f.title, topic: p?.name ?? "", ask: f.ask, display: f.display, cwd: p?.folder, project: p?.id,
    isolate: typeof f.isolate === "boolean" ? f.isolate : state.settings.isolate, accountId: account, accountPinned: account === f.account, from, model: f.model, thinking: f.thinking,
    ...(typeof f.branch === "string" && f.branch ? { branch: f.branch } : {}),
    ...(f.priority === 0 || f.priority === 1 || f.priority === 2 || f.priority === 3 ? { priority: f.priority } : {}),
    ...(f.weight === "light" || f.weight === "heavy" ? { weight: f.weight } : {}),
    ...(f.origin && typeof f.origin.path === "string" ? { origin: f.origin } : {}),
    ...(after.length ? { after } : {}),
    ...(extraSpaces.length ? { reach: extraSpaces } : {}),
    ...(mine(f.follows) ? { follows: mine(f.follows) } : {}),
    ...(f.issue && typeof f.issue.n === "number" ? { issue: f.issue } : {}),
    ...(typeof f.by === "string" && f.by ? { by: f.by } : {}),
    ...(agentAsk(f.agent) ? { agent: agentAsk(f.agent) } : {}),
  });
  // asked with a permission of its own (that device's default, or the one picked there)
  // an older Mac still says "edits" for auto
  const perm = permissionOf(f.permission);
  if (perm) updateTask(id, (x) => (x.permission = perm));
  return id;
}

/** this device's id on the network as it is now (connected: always known) */
function ownIdNow(): string {
  const id = remote().id;
  if (!id) throw new Error("not ready");
  return id;
}

/** a device that may take the Discord agent from here (its memory goes with it): one let in to every workspace */
function mayHold(c: Conn): string {
  if (!c.device || spacesOf(c.device)) throw new Error(t("이 기기의 워크스페이스를 모두 쓸 수 있는 기기만 맡을 수 있어요"));
  return c.device;
}

/** the device holding the agent shows one of its jobs here on Discord: where (its thread, its head line…) */
function agentJob(c: Conn, id: unknown, patch: unknown) {
  const tk = typeof id === "string" ? taskById(id) : undefined;
  if (!tk?.agent || !holdsAgent(c) || !mayReach(reach(c), tk, taskById) || !patch || typeof patch !== "object") throw new Error("그 작업은 쓸 수 없어요");
  const p = patch as Record<string, unknown>;
  const ok: Record<string, unknown> = {};
  for (const k of AGENT_JOB_KEYS) {
    const v = p[k];
    if (v === undefined || typeof v === "boolean" || (typeof v === "string" && v.length <= 32)) ok[k] = v;
  }
  updateTask(tk.id, (x) => (x.agent = { ...x.agent, ...ok }));
}

/** the Discord agent's work asked from another device: where it was asked, nothing else */
function agentAsk(a: unknown): FarAsk["agent"] {
  if (!a || typeof a !== "object") return undefined;
  const o = a as Record<string, unknown>;
  const id = (x: unknown) => (typeof x === "string" && /^\d{5,25}$/.test(x) ? x : undefined);
  if (!id(o.channel)) return undefined;
  return { channel: id(o.channel), ...(id(o.room) ? { room: id(o.room) } : {}), ...(o.quiet === true ? { quiet: true } : {}), ...(o.shots === false ? { shots: false } : {}) };
}

/** One of this Mac's projects' secrets, for Settings › 시크릿 on the Mac that added it: its saved names
 *  (and how many came in from its .env), never a value. A value comes this way only to be saved. */
export interface FarSecrets { items: string[]; added?: number; notIgnored?: boolean }
const projectFolder = (id: unknown) => {
  const p = typeof id === "string" ? projectById(id) : undefined;
  if (!p || p.host) throw new Error("그 프로젝트가 이 기기에 없어요");
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
      // .env isn't ignored by git there: that device's user is asked first, as here
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

/** Legacy folder lookup: only a project already registered here can be shared. */
function addProjectFor(c: Conn, folder: unknown, label?: unknown) {
  if (typeof folder !== "string" || !folder.trim()) throw new Error("bad request");
  const may = spacesOf(c.device);
  const own = ownSpaces();
  const named = own.find((s) => s.label === label)?.id;
  const space = named && spaceAllowed(may, named) ? named : own.some((s) => s.id === state.space) && spaceAllowed(may, state.space) ? state.space : own.find((s) => spaceAllowed(may, s.id))?.id;
  if (!space) throw new Error("그 워크스페이스는 쓸 수 없어요");
  const path = normPath(folder, engine.info.home);
  const pr = path && state.projects?.find((p) => !p.host && p.space === space && normPath(p.folder, engine.info.home) === path);
  if (!pr) throw new Error("그 프로젝트는 쓸 수 없어요");
  return pr.id;
}

/** what another device may do with a job here: the same the user does (checked by checkCall first) */
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
 *  only a project that device keeps, in a workspace it may use */
const PROJECT_CALLS: Record<string, (...a: never[]) => unknown> = {
  // a project's secrets (Settings › 시크릿): names come back, never a value
  ...secretCalls,
  // 루틴 on another device: a routine there that watches one of this Mac's projects looks at its GitHub
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
  const watch = new Set([...c.watch].filter((id) => { const p = projectById(id); return !!p && !p.host && spaceAllowed(may, p.space); }));
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
      c.sessions = msg.sessions === true;
      c.same = msg.same === true;
      c.agent = msg.agent === true;
      c.chatSent = c.uiSent = c.asksSent = c.settingsSent = c.agentSent = c.hubSent = undefined;
      if (c.agent) void readAgentWays();
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
        // the Discord agent moving to that device (여기서 맡기 there): a device that may use every workspace here
        else if (fn === "agentRelease") value = await hub.release(mayHold(c), ownIdNow());
        else if (fn === "agentReleased") value = hub.released(mayHold(c));
        else if (fn === "agentJob") value = agentJob(c, args[0], args[1]);
        else if (fn === "addProject") value = addProjectFor(c, args[0], args[1]);
        // a workspace moving here from that device (engine/spaceMove.ts)
        else if (fn === "space.put") value = await movePut(c.device, args[0], args[1], args[2], args[3]);
        else if (fn === "space.cancel") value = moveCancel(c.device, args[0]);
        else if (fn === "space.import") {
          const r = await moveImport(c.device, args[0], deviceName(c.device));
          // a device kept to some workspaces may use the one it brought; it sees it at once
          const may = state.settings.deviceSpaces?.[c.device];
          setDeviceSpaces(c.device, may ? [...may, r.space] : undefined);
          value = r;
        }
        else if (fn === "decide") {
          // a question of a job that device may reach
          const d = state.decisions.find((x: Decision) => x.id === args[0]);
          // or one main asks in a chat it shares
          const ask = d?.taskId.startsWith("main:") && sharesWith(c) && seenChat(c, chatOf(d.taskId.slice(5)).space, chatOf(d.taskId.slice(5)).project);
          if (!d || (!ask && !mayReach(reach(c), taskById(d.taskId), taskById))) throw new Error("그 작업은 쓸 수 없어요");
          value = await jobs.decide(String(args[0]), String(args[1]), args[2] && typeof args[2] === "object" ? (args[2] as FormValues) : undefined);
        } else if (fn === "handOn") {
          // both ends of the hand-over must be jobs it may reach
          if (![args[0], args[1]].every((id) => typeof id === "string" && mayReach(reach(c), taskById(id), taskById))) throw new Error("그 작업은 쓸 수 없어요");
          value = jobs.handOn(String(args[0]), String(args[1]));
        } else if (fn.startsWith("far.")) {
          // a job's files, folders and terminal: farHost.ts checks each path and job
          const f = farCall(peerOf(conn, c), fn);
          if (!f) throw new Error(`unknown: ${fn}`);
          value = await f(...args);
        } else if (SHARED_CALLS[fn]) {
          value = await SHARED_CALLS[fn](c, args);
        } else if (PROJECT_CALLS[fn]) {
          mayUseProject(c, projectOfArgs(args));
          value = await (PROJECT_CALLS[fn] as (...a: unknown[]) => unknown)(...args);
        } else {
          // only a job that device may reach, and only the calls a job has
          const ok = checkCall(reach(c), fn, args, taskById);
          value = await (JOBS[fn as JobCall] as (...a: unknown[]) => unknown)(...ok);
          // the copy is that device's too: it sees it like the one it copied
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

/** the helper is needed: a device this one uses, one let in here, or one still to be told it was removed */
const needsHelper = () => wantsHelper() || remote().devices.length > 0;

/** this Mac's id on the network, starting the helper for it when it isn't running (undefined: not reachable yet) */
async function ownId(): Promise<string | undefined> {
  await startHosts();
  for (const end = Date.now() + 25_000; !remote().id && Date.now() < end; ) await new Promise((r) => setTimeout(r, 250));
  return remote().id;
}

/** start getting this Mac reachable (기기 추가 opened), so its link is ready when asked for */
export const getReady = () => void startHosts().catch(() => {});

/** a link another device can connect with (both ways, once allowed here), good for ten minutes and one device */
export async function connectLink(): Promise<string | undefined> {
  const id = await ownId();
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

/** 연결 끊기 (this side): that device's connection ends now; it stays allowed and may come back */
export function dropDevice(id: string) {
  remoteCmd({ cmd: "drop", id }).catch((e) => toast(t("연결을 끊지 못했어요: {error}", { error: String(e) }), "bad"));
}

/** that device may no longer come in. Works with the helper running or not. */
async function forgetDevice(id: string): Promise<boolean> {
  try {
    const list = await remoteForget(id);
    if (list) setRemote((r) => ({ ...r, devices: list }));
    return true;
  } catch (e) {
    toast(t("제거하지 못했어요: {error}", { error: String(e) }), "bad");
    return false;
  }
}

/** 제거: the connection goes both ways. This one stops using that device (and it is told to forget this
 *  one), and it may no longer come in. */
export async function removeDevice(id: string): Promise<boolean> {
  const name = state.settings.hosts?.find((h) => h.id === id)?.name ?? deviceName(id);
  // not let in first: if that fails, nothing else changes
  if (!(await forgetDevice(id))) return false;
  // told to forget this one too, even one that only came in here
  removeHost(id, name);
  forgotten(id, name, t("{name}을(를) 제거했어요", { name }));
  return true;
}

/** removed just now: the same removal heard twice (cut off, then its goodbye) is said once */
const justGone = new Set<string>();

/** a Mac is gone from the list (removed here, or it removed this one): its grants go, its jobs are named */
function forgotten(id: string, name: string, said?: string) {
  if (justGone.has(id)) return;
  justGone.add(id);
  setTimeout(() => justGone.delete(id), 60_000);
  if (state.settings.deviceSpaces?.[id]) setDeviceSpaces(id, undefined);
  const left = jobsFrom(state.tasks, id);
  if (!left.length) return void (said && toast(said));
  // they keep running: the user decides
  toast(t("{name}에서 시킨 작업 {n}개는 계속 돌아요", { name, n: left.length }), "info", { label: t("정리|jobs"), run: () => askStopJobs(id, name) }, { stay: true });
}

/** stop and archive the jobs that device asked for here, after asking (named, so it's plain which) */
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

/** connected to another device: one this one uses, or one let in here */
const connected = () => !!state.settings.hosts?.length || remote().devices.length > 0;

/** keep this Mac awake while it is connected to other devices (and only then) */
export function keepAwake() {
  void remoteAwake(!!state.settings.remoteAwake && connected()).catch(() => {});
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
        const d = ev.device as { id: string; name: string; both?: boolean };
        conns.set(conn, { device: d.id, watch: new Set(), sent: new Map(), all: true });
        setRemote((r) => ({ ...r, live: { ...r.live, [conn]: { id: d.id, name: d.name } } }));
        // it lets this Mac in too (an older Ondra doesn't): this one uses it as well
        if (d.both) dialBack(d.id, d.name || "Mac");
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
        // that device removed this one on its side: it's gone from the list here too (the helper did it)
        const d = ev.device as { id?: string; name?: string } | undefined;
        if (!d?.id) break;
        forgotBy(d.id);
        forgotten(d.id, d.name || "Mac", t("{name}에서 이 기기 연결을 제거했어요", { name: d.name || "Mac" }));
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
        // a link it made is gone with it
        const linking = !!remote().pair;
        setRemote((r) => ({ ...r, id: undefined, live: {}, asks: [], pair: undefined }));
        // it went away on its own while still wanted: bring it back
        if (needsHelper() || linking) setTimeout(() => void startHosts().then(connectHosts), 2000);
        break;
    }
  });
  // running jobs change without a store write now and then (a streamed line): look again each second
  setInterval(() => conns.size && soon(), 1000);
  // plan use moves on its own (refreshed every couple of minutes): the other Macs hear it when it does
  setInterval(() => {
    for (const [conn, c] of conns) sendInfo(conn, c);
    // the agent's ways change when it is told on Discord: read again for the devices that show it
    if ([...conns.values()].some(showsAgent)) void readAgentWays();
  }, 20_000);
  // the agent's state (connected, stopped…) goes to the devices that show it
  onAgentStatus(() => ((sharedDirty = true), soon()));
  fromInSide({
    cameIn: (id) => Object.values(remote().live).some((d) => d.id === id),
    // that device removed this one and said so by cutting it off (its goodbye may not come): not let in either
    removedThere: (id, name) => void forgetDevice(id).then((ok) => ok && forgotten(id, name)),
  });
  // awake while connected, and no longer once the last device goes
  createRoot(() => createEffect(on(createMemo(() => !!state.settings.remoteAwake && connected()), keepAwake)));
  void startUp();
}

/** the Macs allowed in show (and can be removed) even while the helper isn't running; what an older
 *  version left is settled before any of them may come in, then the helper runs */
async function startUp() {
  const list = await remoteDevices().catch(() => [] as RemoteDevice[]);
  setRemote((r) => (r.devices.length ? r : { ...r, devices: list }));
  // removed in an older version and not told yet: not let in either
  const gone = new Set((state.settings.leaving ?? []).map((l) => l.id));
  // let in, but not while 다른 기기에서 이 기기 쓰기 was off: those that only came in stay out
  const legacy = state.settings as { remote?: boolean };
  if (legacy.remote === false) for (const d of list) if (!state.settings.hosts?.some((h) => h.id === d.id)) gone.add(d.id);
  for (const id of gone) if (list.some((d) => d.id === id)) await forgetDevice(id);
  if ("remote" in legacy) setState("settings", produce((s) => void delete (s as { remote?: boolean }).remote));
  if (remote().devices.length) await startHosts().catch(() => {});
  await connectHosts();
}
