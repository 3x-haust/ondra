// Working on another Mac (Settings › 연결): its projects
// added here show in the sidebar beside this Mac's, and their jobs run over there. This Mac
// keeps a live copy of those jobs (state/mirror.ts) and sends what the user does with them
// (a message, stop, merge…) to that Mac's Ondra, which does it. The other side is
// engine/remote.ts; the network is the ondra-remote helper.
//
// Two ways to stop: 연결 끊기 (disconnect for now: kept, not dialed until 다시 연결) and 제거
// (remove: everything of that Mac goes from here, and that Mac is told to forget this one; when it
// can't be reached it's told the next time it can, see `leaving`).
import { produce } from "solid-js/store";
import { remoteCmd, remoteHostName, remoteStart } from "../lib/native";
import { hostOfTask, mirror, readAt, remoteProjectId, seenHere, setMirror, splitProjectId, type FarAsk, type HostInfo, type HostMirror, type HostStatus } from "../state/mirror";
import { accountsIn, projectsIn, setState, state, tasksIn, uid } from "../state/store";
import { switchSpace } from "../state/workspace";
import type { Decision, Entry, SpaceId, Task } from "../state/types";
import { goMain, toast, view } from "../state/ui";
import { t } from "../i18n";
import { BYE_GIVE_UP, byeWait, linkPlan, withoutHost } from "./remoteRules";

const pending = new Map<number, { host: string; ok: (v: unknown) => void; no: (e: Error) => void }>();
let seq = 0;
const retry = new Map<string, { timer?: ReturnType<typeof setTimeout>; n: number }>();
/** removed Macs not told yet: when to try again */
const byeRetry = new Map<string, { timer?: ReturnType<typeof setTimeout>; n: number }>();

export const hostName = (id: string) => state.settings.hosts?.find((h) => h.id === id)?.name ?? state.settings.leaving?.find((h) => h.id === id)?.name ?? "Mac";
const hostOf = (id: string) => state.settings.hosts?.find((h) => h.id === id);
const leavingOf = (id: string) => state.settings.leaving?.find((h) => h.id === id);
/** the helper is needed for this side: a Mac to work on, or one still to be told it was removed */
export const wantsHelper = () => !!state.settings.hosts?.length || !!state.settings.leaving?.length;

const sendTo = (host: string, data: Record<string, unknown>) => remoteCmd({ cmd: "peer-send", peer: host, data });

function status(host: string, s: HostStatus, reason?: string) {
  const was = mirror.hosts[host]?.status;
  // the moment it stopped being connected (kept while it tries again), and when it last was
  const since = s === "ok" ? undefined : was === "ok" ? Date.now() : mirror.hosts[host]?.since;
  if (was === "ok" && s !== "ok") setState("settings", "hosts", (l) => (l ?? []).map((x) => (x.id === host ? { ...x, seen: Date.now() } : x)));
  if (!mirror.hosts[host]) setMirror("hosts", host, { status: s, reason, since, projects: [], tasks: [] });
  else setMirror("hosts", host, (h) => ({ ...h, status: s, reason, since }));
}

/** try now (the "다시 연결" button), not at the next retry; a Mac disconnected for now is back on */
export function reconnect(host: string) {
  const r = retry.get(host);
  clearTimeout(r?.timer);
  retry.set(host, { n: 0 });
  if (hostOf(host)?.off) setState("settings", "hosts", (l) => (l ?? []).map((x) => (x.id === host ? { ...x, off: undefined } : x)));
  void startHosts().then(() => dial(host));
}

/** the calls still waiting on that Mac: they won't be answered */
function dropPending(host: string) {
  for (const [n, p] of pending) if (p.host === host) (pending.delete(n), p.no(new Error(t("{name} 연결이 끊겼어요", { name: hostName(host) }))));
}

/** 연결 끊기: stop connecting to that Mac for now. Its projects stay; 다시 연결 brings it back. */
export function disconnectHost(host: string) {
  clearTimeout(retry.get(host)?.timer);
  retry.delete(host);
  setState("settings", "hosts", (l) => (l ?? []).map((x) => (x.id === host ? { ...x, off: true } : x)));
  void remoteCmd({ cmd: "hangup", peer: host }).catch(() => {});
  dropPending(host);
  status(host, "off");
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

// ───────── files, folders and terminals of that Mac (engine/far.ts; its side is engine/farHost.ts)

/** Ask that Mac quietly (a panel reading a file says what went wrong itself, no toast), and give up
 *  after a while: a Mac whose Ondra is older doesn't know the newer calls and says so, but one
 *  that went quiet must not hold a panel forever. */
export function askHost<T = unknown>(host: string, fn: string, args: unknown[], wait = 30_000): Promise<T> {
  if (mirror.hosts[host]?.status !== "ok") return Promise.reject(new Error(t("{name}에 연결되지 않았어요", { name: hostName(host) })));
  const n = ++seq;
  return new Promise<T>((ok, no) => {
    const timer = setTimeout(() => pending.delete(n) && no(new Error(t("{name}이(가) 답하지 않아요", { name: hostName(host) }))), wait);
    const done = <A,>(f: (a: A) => void) => (a: A) => (clearTimeout(timer), f(a));
    pending.set(n, { host, ok: done(ok as (v: unknown) => void), no: done(no) });
    void sendTo(host, { t: "call", seq: n, fn, args }).catch((e) => (pending.delete(n), clearTimeout(timer), no(e)));
  });
}

/** a message to that Mac that wants no answer (keys typed in its terminal) */
export const tellHost = (host: string, data: Record<string, unknown>) => void sendTo(host, data).catch(() => {});

/** what that Mac sends of its own accord beyond the jobs (a terminal's output): by its "t";
 *  "@closed" hears the connection go */
const peerKinds = new Map<string, (host: string, d: Record<string, unknown>) => void>();
export const onPeerKind = (kind: string, f: (host: string, d: Record<string, unknown>) => void) => void peerKinds.set(kind, f);

/** an action on a job: when the job is another Mac's, it goes there (and this says so) */
export function far(id: string, fn: string, args: unknown[]): Promise<unknown> | undefined {
  for (const [host, h] of Object.entries(mirror.hosts)) if (h.tasks.some((x) => x.id === id)) return viaHost(host, fn, args).catch(() => undefined);
  return undefined;
}

/** a new job in another Mac's project: shown here at once, made and run there */
export function startFar(host: string, task: Task, ask: FarAsk) {
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
  t.space = (link?.space ?? root?.from?.space ?? t.from?.space ?? state.space) as SpaceId;
}

interface Patch { id: string; head?: Omit<Task, "entries">; from?: number; entries?: Entry[]; n?: number }

/** a job of a project hidden here (or a subagent of one): kept off the list with it */
function hiddenHere(host: string, t: Task, list: Task[]): boolean {
  const hidden = hostOf(host)?.hidden;
  if (!hidden?.length) return false;
  let root: Task = t;
  for (let i = 0; root.parentId && i < 20; i++) root = list.find((x) => x.id === root.parentId) ?? root;
  const pid = splitProjectId(root.project)?.id ?? root.project;
  return !!pid && hidden.includes(pid);
}

const ending = (s?: string) => s === "done" || s === "failed";

export function apply(host: string, patches: Patch[], gone: string[] = [], all = false) {
  // the jobs seen to end in this patch (not those already ended when first heard of)
  const was = new Map((mirror.hosts[host]?.tasks ?? []).map((x) => [x.id, x.status]));
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
        // opened here since it last said something: still read here
        if (x.unread && seenHere(x)) x.unread = false;
      }
      for (const id of gone) {
        const i = list.findIndex((y) => y.id === id);
        if (i >= 0) list.splice(i, 1);
      }
      // jobs this Mac started in a project hidden since still come (that Mac sends what it asked for)
      for (let i = list.length - 1; i >= 0; i--) if (hiddenHere(host, list[i], list)) list.splice(i, 1);
    }),
  );
  for (const x of mirror.hosts[host]?.tasks ?? []) {
    const before = was.get(x.id);
    if (before && !ending(before) && ending(x.status)) for (const f of endedHooks) f(x);
  }
}

const endedHooks: ((t: Task) => void)[] = [];
/** another Mac's job was seen to end (done or failed): main hears it as it hears this Mac's own */
export const onFarEnded = (f: (t: Task) => void) => void endedHooks.push(f);

/** the questions that Mac's jobs (those kept here) wait on */
export const applyDecisions = (host: string, list: Decision[]) => mirror.hosts[host] && setMirror("hosts", host, "decisions", list);

/** opened here: its dot goes here until it says more (that Mac's own dot is left alone) */
export function markFarRead(id: string) {
  for (const [host, h] of Object.entries(mirror.hosts)) {
    const i = h.tasks.findIndex((x) => x.id === id);
    if (i < 0) continue;
    readAt.set(id, h.tasks[i].entries.length);
    if (h.tasks[i].unread) setMirror("hosts", host, "tasks", i, "unread", false);
  }
}

/** answer another Mac's question there; its card goes now and comes back if that Mac can't take it */
export async function farDecide(d: Decision, optionId: string) {
  const host = Object.keys(mirror.hosts).find((h) => mirror.hosts[h].decisions?.some((x) => x.id === d.id));
  if (!host) return;
  setMirror("hosts", host, "decisions", (l) => (l ?? []).filter((x) => x.id !== d.id));
  const ok = await viaHost(host, "decide", [d.id, optionId]).then(() => true, () => false);
  if (!ok && mirror.hosts[host] && !mirror.hosts[host].decisions?.some((x) => x.id === d.id)) setMirror("hosts", host, "decisions", (l) => [...(l ?? []), d]);
}

/** what this Mac wants from that one: the jobs of its projects added here */
function watch(host: string) {
  const projects = (state.settings.hostProjects ?? []).filter((l) => l.host === host).map((l) => l.id);
  void sendTo(host, { t: "watch", projects }).catch(() => {});
}

async function dial(host: string) {
  const h = hostOf(host);
  if (!h || h.off) return;
  status(host, "connecting");
  await remoteCmd({ cmd: "dial", peer: host, name: await remoteHostName(), ...(h.pair ? { pair: h.pair } : {}) }).catch(() => again(host));
}

function again(host: string) {
  const r = retry.get(host) ?? { n: 0 };
  clearTimeout(r.timer);
  const h = hostOf(host);
  if (!h || h.off) return;
  const wait = Math.min(60, 2 ** Math.min(r.n, 6));
  r.n++;
  r.timer = setTimeout(() => void dial(host), wait * 1000);
  retry.set(host, r);
}

/** tell a removed Mac to forget this one (a dial that only says goodbye) */
async function sayBye(host: string) {
  const l = leavingOf(host);
  if (!l) return;
  const r = byeRetry.get(host);
  if (r) r.timer = undefined;
  if (Date.now() - l.at > BYE_GIVE_UP) return byeDone(host);
  await startHosts();
  await remoteCmd({ cmd: "dial", peer: host, name: await remoteHostName(), bye: true }).catch(() => byeLater(host));
}
function byeLater(host: string) {
  const r = byeRetry.get(host) ?? { n: 0 };
  clearTimeout(r.timer);
  if (!leavingOf(host)) return;
  r.timer = setTimeout(() => void sayBye(host), byeWait(r.n++));
  byeRetry.set(host, r);
}
function byeDone(host: string) {
  clearTimeout(byeRetry.get(host)?.timer);
  byeRetry.delete(host);
  setState("settings", "leaving", (l) => (l ?? []).filter((x) => x.id !== host));
}

/** the helper's word about a removed Mac being told */
function onBye(host: string, s: string, reason: unknown) {
  // it forgot this Mac, or never knew it (removed there too, or a link never allowed)
  if (s === "bye" || (s === "denied" && (reason === "unknown" || reason === "revoked"))) return byeDone(host);
  if (s === "ok") {
    // an older Ondra there let it in as a visit (the helper left at once): this Mac stays in its list
    toast(t("{name}의 Ondra가 이전 버전이라, 그 Mac에서도 이 Mac을 제거해야 해요", { name: hostName(host) }), "info", undefined, { stay: true });
    return byeDone(host);
  }
  // not reachable, or connections are off there: try again later
  if (s === "denied" || s === "closed") byeLater(host);
}

/**
 * That Mac said no. Connections off there is for now: tried again later. Removed there, refused,
 * or a link that no longer works is for good, so that Mac goes from here too (nothing but a new
 * link could bring it back) and the user is told why.
 */
function denied(host: string, reason: string) {
  dropPending(host);
  if (reason === "off") {
    status(host, "denied", reason);
    return again(host);
  }
  const name = hostName(host);
  const why =
    reason === "refused" ? t("{name}에서 연결을 거절했어요", { name })
    : reason === "unknown" && hostOf(host)?.pair ? t("연결 링크가 만료됐거나 이미 쓰였어요")
    : reason === "unknown" || reason === "revoked" ? t("{name}에서 이 Mac을 제거했어요", { name })
    : undefined;
  if (!why) return status(host, "denied", reason);
  forgetHost(host);
  toast(why, "info", undefined, { stay: true });
}

/** the helper's word about the Macs this one dialed */
export function onPeer(ev: Record<string, unknown>) {
  const host = String(ev.peer ?? "");
  if (!host) return;
  if (!hostOf(host)) {
    // a Mac removed here: only the goodbye dial's word counts; an older dial still connecting is let go
    if (ev.ev === "peer" && leavingOf(host) && ev.bye) onBye(host, String(ev.state), ev.reason);
    else if (ev.ev === "peer" && ev.state === "ok") void remoteCmd({ cmd: "hangup", peer: host }).catch(() => {});
    return;
  }
  if (ev.ev === "peer") {
    const s = String(ev.state);
    if (s === "ok") {
      retry.set(host, { n: 0 });
      // disconnected here meanwhile (a dial already on its way): not wanted now
      if (hostOf(host)?.off) return void remoteCmd({ cmd: "hangup", peer: host }).catch(() => {});
      status(host, "ok");
      // the code did its job: from now on this Mac is known there
      if (hostOf(host)?.pair) setState("settings", "hosts", (l) => (l ?? []).map((x) => (x.id === host ? { ...x, pair: undefined } : x)));
      void sendTo(host, { t: "projects" }).catch(() => {});
      watch(host);
    } else if (s === "waiting") status(host, "waiting");
    else if (s === "connecting") status(host, "connecting");
    else if (s === "denied") denied(host, String(ev.reason ?? ""));
    else if (s === "closed") {
      dropPending(host);
      peerKinds.get("@closed")?.(host, {});
      if (mirror.hosts[host]?.status === "denied" || mirror.hosts[host]?.status === "off") return;
      status(host, "lost", String(ev.reason ?? ""));
      // cut off there for now: not again until the user says (다시 연결) or the app starts again
      if (ev.reason !== "dropped") again(host);
    }
    return;
  }
  const d = ev.data as Record<string, unknown> | undefined;
  if (!d) return;
  switch (d.t) {
    case "projects":
      setMirror("hosts", host, "projects", (d.list as HostMirror["projects"]) ?? []);
      linkAll(host);
      break;
    case "info": {
      const info = d.info as HostInfo;
      setMirror("hosts", host, "info", info);
      const labels = info.spaces.map((s) => s.label);
      if (JSON.stringify(state.settings.hosts?.find((x) => x.id === host)?.spaces) !== JSON.stringify(labels)) {
        setState("settings", "hosts", (l) => (l ?? []).map((x) => (x.id === host ? { ...x, spaces: labels } : x)));
        syncSpaces();
      }
      linkAll(host);
      break;
    }
    case "patch":
      apply(host, (d.tasks as Patch[]) ?? [], (d.gone as string[]) ?? [], !!d.all);
      break;
    case "decisions":
      applyDecisions(host, Array.isArray(d.list) ? (d.list as Decision[]) : []);
      break;
    case "ret": {
      const p = pending.get(Number(d.seq));
      if (!p) break;
      pending.delete(Number(d.seq));
      if (d.error) p.no(new Error(String(d.error)));
      else p.ok(d.value);
      break;
    }
    default:
      peerKinds.get(String(d.t))?.(host, d);
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
  // removed before and added again: it isn't to be told goodbye anymore
  if (leavingOf(l.id)) byeDone(l.id);
  retry.delete(l.id);
  await startHosts();
  await dial(l.id);
  return true;
}

/**
 * The workspace tabs: this Mac's, and those of the Macs added here, matched by name. A workspace
 * only another Mac has gets a tab of its own here (its work runs on that Mac); it goes when no
 * added Mac has it anymore, unless something of this Mac's was put in it since.
 */
export function syncSpaces() {
  const want = new Set((state.settings.hosts ?? []).flatMap((h) => h.spaces ?? []));
  const add = [...want].filter((l) => !state.spaces.some((s) => s.label === l));
  const drop = state.spaces.filter((s) => s.only && !want.has(s.label) && !accountsIn(s.id).length && !projectsIn(s.id).length && !tasksIn(s.id).length).map((s) => s.id);
  if (!add.length && !drop.length) return;
  if (drop.includes(state.space)) {
    const to = state.spaces.find((s) => !drop.includes(s.id));
    if (to) switchSpace(to.id, { name: "main" });
  }
  setState("spaces", (l) => [...l.filter((s) => !drop.includes(s.id)), ...add.map((label) => ({ id: uid("sp"), label, folder: "~", rules: "", only: true }))]);
}

/** the view leaves what was that Mac's (its project's chat, one of its jobs) */
function leaveViewOf(host: string) {
  const v = view();
  const shown = v.name === "main" ? splitProjectId(v.project)?.host : "id" in v && typeof v.id === "string" ? hostOfTask(v.id) : undefined;
  if (shown === host) goMain();
}

/**
 * Everything of that Mac goes from here: its entry, its projects and jobs shown here, a run
 * location on it, and a workspace tab only it had. Nothing is said to that Mac (see removeHost).
 */
function forgetHost(id: string) {
  clearTimeout(retry.get(id)?.timer);
  retry.delete(id);
  dropPending(id);
  leaveViewOf(id);
  const rest = withoutHost(state.settings, id);
  setState("settings", "hosts", rest.hosts);
  setState("settings", "hostProjects", rest.hostProjects);
  // replaced whole: a store merges objects
  setState("settings", "computers", undefined);
  setState("settings", "computers", rest.computers);
  void remoteCmd({ cmd: "hangup", peer: id }).catch(() => {});
  setMirror("hosts", produce((h) => void delete h[id]));
  syncSpaces();
}

/** 제거: that Mac goes from here, and it is told to forget this one (now, or once it can be reached) */
export function removeHost(id: string) {
  const name = hostName(id);
  forgetHost(id);
  setState("settings", "leaving", (l) => [...(l ?? []).filter((x) => x.id !== id), { id, name, at: Date.now() }]);
  byeRetry.delete(id);
  void sayBye(id);
}

/**
 * Every project of that Mac shows here by itself, as it would there: in the tab of its workspace's
 * name (made by syncSpaces when only that Mac has it). One gone there, or hidden here, goes here too.
 */
function linkAll(host: string) {
  const list = mirror.hosts[host]?.projects ?? [];
  const mine = (state.settings.hostProjects ?? []).filter((l) => l.host === host);
  // a Mac too old to say the workspace: its projects go to the first tab
  const spaceFor = (label?: string) => (label ? state.spaces.find((s) => s.label === label)?.id : state.spaces[0]?.id);
  const { gone, add } = linkPlan(list, mine, hostOf(host)?.hidden, spaceFor);
  if (!gone.length && !add.length) return;
  const rest = (state.settings.hostProjects ?? []).filter((l) => !(l.host === host && gone.includes(l.id)));
  setState("settings", "hostProjects", [...rest, ...add.map((p) => ({ host, id: p.id, space: spaceFor(p.space)!, name: p.name, folder: p.folder }))]);
  watch(host);
}

/** 목록에서 숨기기: one of that Mac's projects off the list here (it stays there; 다시 보이기 brings it back) */
export function hideHostProject(host: string, id: string) {
  const pid = remoteProjectId(host, id);
  const v = view();
  if (v.name === "main" && v.project === pid) goMain();
  setState("settings", "hosts", (l) => (l ?? []).map((x) => (x.id === host ? { ...x, hidden: [...new Set([...(x.hidden ?? []), id])] } : x)));
  setState("settings", "hostProjects", (l) => (l ?? []).filter((x) => !(x.host === host && x.id === id)));
  watch(host);
  setMirror("hosts", host, "tasks", (l) => l.filter((x) => !hiddenHere(host, x, l)));
}

/** 다시 보이기: a hidden project back on the list */
export function showHostProject(host: string, id: string) {
  setState("settings", "hosts", (l) => (l ?? []).map((x) => (x.id === host ? { ...x, hidden: (x.hidden ?? []).filter((h) => h !== id) } : x)));
  linkAll(host);
}

/** that Mac's projects hidden here, with their names as last known */
export function hiddenProjects(host: string): { id: string; name: string }[] {
  return (hostOf(host)?.hidden ?? []).map((id) => ({ id, name: mirror.hosts[host]?.projects.find((p) => p.id === id)?.name ?? id }));
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

/** at launch: connect to every Mac added before (not one disconnected for now), and tell the removed ones */
export async function connectHosts() {
  if (!wantsHelper()) return;
  await startHosts();
  for (const h of state.settings.hosts ?? []) {
    if (h.off) status(h.id, "off");
    else void dial(h.id);
  }
  for (const l of state.settings.leaving ?? []) if (!byeRetry.get(l.id)?.timer) void sayBye(l.id);
}

/** a Mac's jobs and its live state, for the settings list */
export const hostState = (id: string) => mirror.hosts[id];
