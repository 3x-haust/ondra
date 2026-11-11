// Remote control: phones the user approved see the jobs and steer them, over Ondra's own
// private network (remote/host: end-to-end encrypted, devices known by their keys).
//
// The helper does the network and who may come in; this side speaks for the app:
//   phone → Mac  {t:"tasks"} {t:"open",id} {t:"close"} {t:"tell",id,text,queue?}
//                {t:"new",text,project?} {t:"stop",id}
//   Mac → phone  {t:"hello",mac,projects} {t:"tasks",tasks} {t:"task",task} {t:"created",id}
//                {t:"error",message}
// What a phone gets is the same as the window shows, in short: titles, states, the words,
// each step as one line.
import { createEffect, createRoot, createSignal, on } from "solid-js";
import { inTauri, onRemote, remoteCmd, remoteHostName, remoteStart, remoteStop } from "../lib/native";
import { projectById, setState, state } from "../state/store";
import type { Entry, Task } from "../state/types";
import { describeBrowser, describeCommand, describeComputer, nowText } from "./describe";
import { chooseAccount, createTask, stopTask, tell } from "./tasks";
import { t } from "../i18n";

export interface RemoteDevice { id: string; name: string; addedAt: number; lastSeen: number }
export interface PairAsk { conn: number; device: { id: string; name: string } }

/** what the window shows about remote control */
export const [remote, setRemote] = createSignal<{
  on: boolean;
  /** the Mac's id on the network, once it is reachable */
  id?: string;
  devices: RemoteDevice[];
  /** phones connected now (by connection) */
  live: Record<number, { id: string; name: string }>;
  /** a phone asking to be let in */
  asks: PairAsk[];
  /** the code in the QR shown now, and when it stops working */
  pair?: { code: string; until: number };
}>({ on: false, devices: [], live: {}, asks: [] });

const watching = new Map<number, string | undefined>();
const sentList = new Map<number, string>();
const sentTask = new Map<number, string>();

const send = (conn: number, data: Record<string, unknown>) => void remoteCmd({ cmd: "send", conn, data }).catch(() => {});

const VERB: Record<string, string> = {
  read: "읽음", search: "찾음", edit: "수정함", write: "작성함", bash: "실행함", test: "테스트함",
  web: "웹 검색함", browser: "브라우저 씀", desktop: "앱 조작함", agent: "에이전트 씀", other: "도구 씀",
};

/** one step as the window's line says it ("실행함 npm test", "클릭함 ‘보내기’") */
function stepLine(x: Extract<Entry, { kind: "tool" }>["tool"]): { verb: string; target: string } {
  if (x.name === "computer") {
    const d = describeComputer(x.act, x.target || undefined);
    return { verb: x.endedAt ? d.label : d.now, target: d.target ?? x.app ?? "" };
  }
  if (x.kind === "bash" || x.kind === "test") {
    const d = describeCommand(x.target ?? "");
    return { verb: x.endedAt ? d.label : d.now, target: d.target ?? (x.target ?? "").slice(0, 120) };
  }
  if (x.kind === "browser") {
    const d = describeBrowser(x.target ?? "");
    return { verb: x.endedAt ? d.label : d.now, target: d.target ?? "" };
  }
  if (x.image) return { verb: t("이미지 {n}개 확인함", { n: 1 }), target: "" };
  const name = (x.target ?? "").split("/").pop() ?? "";
  return { verb: t(VERB[x.kind] ?? VERB.other), target: name };
}

const projectName = (task: Task) => projectById(task.project)?.name ?? task.topic ?? "";

function summary(task: Task) {
  const last = task.entries[task.entries.length - 1];
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    now: task.status === "running" ? nowText(task.now) : "",
    project: projectName(task),
    at: last?.at ?? task.startedAt ?? task.createdAt ?? 0,
    parent: task.parentId ?? null,
  };
}

function list() {
  return state.tasks
    .filter((x) => !x.parentId && !x.archived)
    .map(summary)
    .sort((a, b) => b.at - a.at)
    .slice(0, 80);
}

/** a job for the phone: its words and each step as a line (the newest 160) */
function detail(task: Task) {
  const items: Record<string, unknown>[] = [];
  for (const e of task.entries.slice(-160)) {
    if (e.kind === "user") items.push({ k: "user", id: e.id, text: e.text, by: e.by ?? null });
    else if (e.kind === "text") items.push({ k: "text", id: e.id, text: e.text });
    else if (e.kind === "error") items.push({ k: "error", id: e.id, text: e.text });
    else if (e.kind === "tool") {
      const s = stepLine(e.tool);
      items.push({ k: "step", id: e.id, verb: s.verb, target: s.target, ok: e.tool.ok !== false, running: !e.tool.endedAt && !e.tool.stopped });
    } else if (e.kind === "block") {
      const b = e.block;
      if (b.type === "link") items.push({ k: "link", id: e.id, title: b.title, ref: b.ref, kind: b.kind });
      else if (b.type === "checklist") items.push({ k: "checks", id: e.id, label: b.label ?? "", items: b.items });
      else if (b.type === "text") items.push({ k: "text", id: e.id, text: b.text });
      else if (b.type === "evidence") items.push({ k: "checks", id: e.id, label: t("확인"), items: b.items.map((i) => ({ label: i.note || i.ref, done: i.ok !== false && ["ran", "exists", "read"].includes(i.check ?? "") })) });
    } else if (e.kind === "turn") items.push({ k: "turn", id: e.id, ms: e.ms });
  }
  return {
    ...summary(task),
    plan: task.plan,
    queue: (task.queue ?? []).map((q) => q.text),
    items,
  };
}

/** what changed goes to each phone (lists and the job it has open), a moment after it changes */
let timer: ReturnType<typeof setTimeout> | undefined;
function flush() {
  timer = undefined;
  const conns = Object.keys(remote().live).map(Number);
  if (!conns.length) return;
  const tasks = list();
  const listJson = JSON.stringify(tasks);
  for (const c of conns) {
    if (sentList.get(c) !== listJson) {
      sentList.set(c, listJson);
      send(c, { t: "tasks", tasks });
    }
    const id = watching.get(c);
    const task = id ? state.tasks.find((x) => x.id === id) : undefined;
    if (task) {
      const d = detail(task);
      const j = JSON.stringify(d);
      if (sentTask.get(c) !== j) {
        sentTask.set(c, j);
        send(c, { t: "task", task: d });
      }
    }
  }
}
const soon = () => (timer ??= setTimeout(flush, 250));

function handle(conn: number, msg: Record<string, unknown>) {
  const id = typeof msg.id === "string" ? msg.id : undefined;
  const text = typeof msg.text === "string" ? msg.text.trim() : "";
  switch (msg.t) {
    case "tasks":
      sentList.delete(conn);
      break;
    case "open":
      watching.set(conn, id);
      sentTask.delete(conn);
      break;
    case "close":
      watching.set(conn, undefined);
      break;
    case "tell":
      if (id && text && state.tasks.some((x) => x.id === id)) void tell(id, text, msg.queue ? {} : { now: true });
      break;
    case "new": {
      if (!text) break;
      const p = typeof msg.project === "string" ? projectById(msg.project) : undefined;
      const space = p?.space ?? state.space;
      const made = createTask({
        space,
        title: text.split("\n")[0].slice(0, 60),
        topic: p?.name ?? "",
        ask: text,
        cwd: p?.folder,
        project: p?.id,
        isolate: state.settings.isolate,
        accountId: chooseAccount(space, p?.name ?? ""),
      });
      send(conn, { t: "created", id: made });
      watching.set(conn, made);
      sentTask.delete(conn);
      break;
    }
    case "stop":
      if (id) stopTask(id);
      break;
  }
  soon();
}

async function hello(conn: number) {
  const projects = (state.projects ?? []).map((p) => ({ id: p.id, name: p.name, space: p.space }));
  send(conn, { t: "hello", mac: { name: await remoteHostName() }, projects });
  sentList.delete(conn);
  soon();
}

/** a fresh QR code, good for ten minutes */
export function newPairing() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const code = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const until = Date.now() + 10 * 60_000;
  void remoteCmd({ cmd: "pair", code, ttl: 600 }).catch(() => {});
  setRemote((r) => ({ ...r, pair: { code, until } }));
}

export function stopPairing() {
  void remoteCmd({ cmd: "unpair" }).catch(() => {});
  setRemote((r) => ({ ...r, pair: undefined }));
}

export function answerPair(conn: number, ok: boolean) {
  void remoteCmd({ cmd: "approve", conn, ok }).catch(() => {});
  setRemote((r) => ({ ...r, asks: r.asks.filter((a) => a.conn !== conn), ...(ok ? { pair: undefined } : {}) }));
}

export const revokeDevice = (id: string) => void remoteCmd({ cmd: "revoke", id }).catch(() => {});

export async function setRemoteOn(on: boolean) {
  setState("settings", "remote", on);
  if (on) await remoteStart();
  else {
    await remoteStop();
    setRemote({ on: false, devices: remote().devices, live: {}, asks: [] });
  }
}

let started = false;
/** Listen for the helper and keep phones up to date; turns it on if the user left it on. */
export function initRemote() {
  if (!inTauri || started) return;
  started = true;
  void onRemote((ev) => {
    switch (ev.ev) {
      case "ready":
        setRemote((r) => ({ ...r, on: true, id: String(ev.id) }));
        break;
      case "devices":
        setRemote((r) => ({ ...r, on: true, devices: (ev.list as RemoteDevice[]) ?? [] }));
        break;
      case "pair":
        setRemote((r) => ({ ...r, asks: [...r.asks, { conn: Number(ev.conn), device: ev.device as PairAsk["device"] }] }));
        break;
      case "open": {
        const conn = Number(ev.conn);
        setRemote((r) => ({ ...r, live: { ...r.live, [conn]: ev.device as { id: string; name: string } } }));
        void hello(conn);
        break;
      }
      case "close": {
        const conn = Number(ev.conn);
        watching.delete(conn);
        sentList.delete(conn);
        sentTask.delete(conn);
        setRemote((r) => {
          const live = { ...r.live };
          delete live[conn];
          return { ...r, live, asks: r.asks.filter((a) => a.conn !== conn) };
        });
        break;
      }
      case "msg":
        if (ev.data && typeof ev.data === "object") handle(Number(ev.conn), ev.data as Record<string, unknown>);
        break;
      case "stopped":
        setRemote((r) => ({ ...r, on: false, id: undefined, live: {}, asks: [] }));
        break;
    }
  });
  createRoot(() => {
    // anything about the jobs changed: phones hear it (batched)
    createEffect(on(() => JSON.stringify(state.tasks.map((x) => [x.id, x.status, x.now, x.title, x.entries.length, x.entries[x.entries.length - 1]?.id, (x.entries[x.entries.length - 1] as { tool?: { endedAt?: number } })?.tool?.endedAt, x.queue?.length])), soon));
  });
  if (state.settings.remote) void remoteStart().catch(() => {});
}
