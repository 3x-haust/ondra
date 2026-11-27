// Moving a workspace to another Mac (Settings › 워크스페이스 › 다른 기기로 옮기기): everything that
// belongs to it goes to a Mac this one works on (Settings › 연결), and it is gone from here once
// that Mac has it all.
//
//   here → there  space.put [transfer, "<kind>/<name>/<file>", offset, base64]   (the bundle, then folders)
//                 space.import [transfer]   → { space, label, missing }
//                 space.cancel [transfer]
//
// What comes in waits apart (<data>/remote/moves/<transfer>) until space.import, which puts the
// folders in place where nothing is yet and adds the workspace to that Mac's state in one go: a
// move that fails part way leaves nothing behind there, and here keeps everything.
// Not moved: API keys and headers of direct connections (keychain), project folders and their
// worktrees (the code stays where it is), the browser profile, MCP keys.
import { createSignal } from "solid-js";
import { unwrap } from "solid-js/store";
import { farPiece, farPut, farStat, fsFiles, pathsExist, spaceGitIdentity, spaceMoveClear, spaceMovesIn, spaceTools } from "../lib/native";
import { setState, state, uid } from "../state/store";
import { hostSpaceId, mirror, setMirror } from "../state/mirror";
import type { Account, AppState, BtwEntry, CaptainMessage, JournalEntry, Memory, MemoryConflict, PrWatch, Project, ProjectNow, ResultEntry, Reviewer, Routine, SideMessage, Skill, Space, SpaceId, Task } from "../state/types";
import { t } from "../i18n";
import { askHost, hostName } from "./hosts";
import { readNotes, writeNotes } from "./notes";
import { installCommand, removeCommand } from "./spaceCli";
import { engine } from "./rpc";

export interface SpaceBundle {
  v: 1;
  /** the sending Mac's home and data folder: paths under them are made this Mac's */
  home: string;
  dataDir: string;
  space: Space;
  git?: { name: string; email: string };
  tasks: Task[];
  memory: Memory[];
  projects: Project[];
  captain: CaptainMessage[];
  routines: Routine[];
  accounts: Account[];
  skills: Skill[];
  journal: JournalEntry[];
  results: ResultEntry[];
  side: SideMessage[];
  btws: BtwEntry[];
  memoryConflicts: MemoryConflict[];
  memoryNow: Record<string, ProjectNow>;
  prWatch: Record<string, PrWatch>;
  /** project notes, by project id */
  notes: Record<string, string>;
  accountPick?: string;
  sent?: string[];
  chatCleared: Record<string, number>;
  computer?: NonNullable<AppState["settings"]["computers"]>[string];
  reviewers?: Reviewer[];
}

/** a folder of the app's data that goes with the workspace: <data>/<kind>/<name> */
export interface MoveFolder { kind: "sessions" | "artifacts" | "skills" | "accounts" | "spaces"; name: string }
const KINDS = new Set(["bundle", "sessions", "artifacts", "skills", "accounts", "spaces"]);

/** what a job that is going on now would lose: it has to end (or be stopped) first */
export const busyIn = (s: Pick<AppState, "tasks">, id: SpaceId) => s.tasks.filter((x) => x.space === id && !x.host && (x.status === "running" || x.status === "waiting" || x.status === "queued"));

/** the folder name a space keeps its command-line logins and logs under (src-tauri tools.rs space_base) */
export const spaceFolder = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "") || "home";

/** a skill of the app's own folder: <data>/skills/<dir>/… → dir */
const skillDir = (path: string, dataDir: string) => (path.startsWith(`${dataDir}/skills/`) ? path.slice(dataDir.length + 8).split("/")[0] || undefined : undefined);

const inChat = (scope: string, id: SpaceId) => scope === `main:${id}` || scope.startsWith(`main:${id}~`);

/** Everything of one workspace, as it is in the state (copied). */
export function buildBundle(s: AppState, id: SpaceId, from: { home: string; dataDir: string; git?: SpaceBundle["git"]; notes?: Record<string, string> }): SpaceBundle {
  const space = s.spaces.find((x) => x.id === id);
  if (!space) throw new Error("no such space");
  const copy = <T,>(v: T): T => JSON.parse(JSON.stringify(v ?? null)) as T;
  const tasks = s.tasks.filter((x) => x.space === id && !x.host);
  const taskIds = new Set(tasks.map((x) => x.id));
  const projects = (s.projects ?? []).filter((p) => p.space === id && !p.host);
  const folders = new Set(projects.map((p) => p.folder));
  const pick = <T,>(o: Record<string, T> | undefined, keep: (k: string, v: T) => boolean) => Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => keep(k, v)));
  return copy({
    v: 1,
    home: from.home,
    dataDir: from.dataDir,
    space,
    git: from.git,
    tasks: tasks.map(({ pickedFiles: _local, ...x }) => x as Task),
    memory: s.memory.filter((m) => m.space === id),
    projects,
    captain: s.captain.filter((m) => m.space === id),
    routines: (s.routines ?? []).filter((r) => r.space === id),
    accounts: s.accounts.filter((a) => a.space === id && a.id !== "default"),
    skills: s.skills.filter((k) => k.space === id && !!skillDir(k.path, from.dataDir)),
    journal: (s.journal ?? []).filter((j) => j.space === id),
    results: (s.results ?? []).filter((r) => r.space === id),
    side: (s.side ?? []).filter((m) => m.space === id),
    btws: (s.btws ?? []).filter((b) => inChat(b.scope, id) || (b.scope.startsWith("task:") && taskIds.has(b.scope.slice(5)))),
    memoryConflicts: (s.memoryConflicts ?? []).filter((c) => c.space === id),
    memoryNow: pick(s.memoryNow, (k) => folders.has(k)),
    prWatch: pick(s.prWatch, (_k, w) => taskIds.has(w.task)),
    notes: from.notes ?? {},
    accountPick: s.accountPick?.[id],
    sent: s.sent?.[id],
    chatCleared: pick(s.chatCleared, (k) => k === id || k.startsWith(`${id}~`)),
    computer: s.settings.computers?.[id],
    reviewers: s.settings.reviewersBySpace?.[id],
  } satisfies SpaceBundle);
}

/** the app folders that go with a bundle */
export function bundleFolders(b: SpaceBundle): MoveFolder[] {
  return [
    ...b.tasks.flatMap((x) => [{ kind: "sessions", name: x.id }, { kind: "artifacts", name: x.id }] as MoveFolder[]),
    ...b.skills.flatMap((k) => { const d = skillDir(k.path, b.dataDir); return d ? [{ kind: "skills", name: d } as MoveFolder] : []; }),
    ...b.accounts.map((a) => ({ kind: "accounts", name: a.id }) as MoveFolder),
    { kind: "spaces", name: spaceFolder(b.space.id) },
  ];
}

export interface Here {
  state: AppState;
  home: string;
  dataDir: string;
  /** the new workspace's id */
  space: SpaceId;
  /** the Macs this one works on (a routine or new work set to run on one it doesn't know runs here) */
  hosts: Set<string>;
  /** skill folders already in <data>/skills */
  skillDirs: Set<string>;
}

/** What to add here for a bundle: a new workspace with everything of it whose id isn't here yet,
 *  paths under the other Mac's home made this one's; and the folders to put in place. */
export function placeBundle(b: SpaceBundle, h: Here) {
  const sp = h.space;
  const old = b.space.id;
  const home = (p: string | undefined) => (typeof p !== "string" || !b.home || b.home === h.home ? p : p === b.home ? h.home : p.startsWith(`${b.home}/`) ? h.home + p.slice(b.home.length) : p);
  const fresh = <T extends { id: string }>(list: T[] | undefined, here: { id: string }[] | undefined) => {
    const taken = new Set((here ?? []).map((x) => x.id));
    return (list ?? []).filter((x) => x && typeof x.id === "string" && !taken.has(x.id));
  };
  const host = (x: string | undefined) => (x && h.hosts.has(x) ? x : undefined);
  const chat = (k: string) => (k === old ? sp : k.startsWith(`${old}~`) ? sp + k.slice(old.length) : k);

  const tasks = fresh(b.tasks, h.state.tasks).map((x) => {
    const { reach: _otherSpaces, ...rest } = x;
    return { ...rest, space: sp, cwd: home(x.cwd) ?? x.cwd, ...(x.worktree ? { worktree: { ...x.worktree, repo: home(x.worktree.repo)!, path: home(x.worktree.path)! } } : {}) } as Task;
  });
  const taskIds = new Set(tasks.map((x) => x.id));
  const accounts = fresh(b.accounts, h.state.accounts).map((a) => ({ ...a, space: sp, ...(a.connection ? { connection: { ...a.connection, hasKey: false } } : {}) }));
  const skills: Skill[] = [];
  const skillMoves: MoveFolder[] = [];
  const dirs = new Set(h.skillDirs);
  for (const k of b.skills ?? []) {
    const d = skillDir(k.path, b.dataDir);
    if (!d) continue;
    let to = d;
    for (let n = 2; dirs.has(to); n++) to = `${d}-${n}`;
    dirs.add(to);
    skills.push({ ...k, space: sp, path: `${h.dataDir}/skills/${to}${k.path.slice(b.dataDir.length + 8 + d.length)}` });
    skillMoves.push({ kind: "skills", name: `${d}>${to}` });
  }
  const projects = fresh(b.projects, h.state.projects).map((p) => ({ ...p, space: sp, folder: home(p.folder)! }));
  const routines = fresh(b.routines, h.state.routines).map((r) => {
    const on = host(r.host);
    return { ...r, space: sp, host: on, hostSpace: on ? r.hostSpace : undefined };
  });
  const computer = b.computer && host(b.computer.host) ? b.computer : undefined;
  const space: Space = { id: sp, label: b.space.label, folder: home(b.space.folder) ?? "~", rules: b.space.rules ?? "", ...(b.space.cliHome?.trim() && !b.space.cliHome.startsWith(b.dataDir) ? { cliHome: home(b.space.cliHome) } : {}) };
  return {
    space,
    tasks,
    memory: fresh(b.memory, h.state.memory).map((m) => ({ ...m, space: sp, project: home(m.project), cites: m.cites?.map((c) => home(c)!), from: home(m.from) })),
    projects,
    captain: fresh(b.captain, h.state.captain).map((m) => ({ ...m, space: sp })),
    routines,
    accounts,
    skills,
    journal: fresh(b.journal, h.state.journal).map((j) => ({ ...j, space: sp })),
    results: fresh(b.results, h.state.results).map((r) => ({ ...r, space: sp })),
    side: fresh(b.side, h.state.side).map((m) => ({ ...m, space: sp })),
    btws: fresh(b.btws, h.state.btws).map((x) => ({ ...x, scope: x.scope.startsWith("main:") ? `main:${chat(x.scope.slice(5))}` : x.scope })),
    memoryConflicts: fresh(b.memoryConflicts, h.state.memoryConflicts).map((c) => ({ ...c, space: sp, project: home(c.project) })),
    memoryNow: Object.fromEntries(Object.entries(b.memoryNow ?? {}).map(([k, v]) => [home(k)!, v])),
    prWatch: Object.fromEntries(Object.entries(b.prWatch ?? {}).filter(([k, w]) => taskIds.has(w.task) && !h.state.prWatch?.[k])),
    notes: Object.fromEntries(Object.entries(b.notes ?? {}).filter(([id]) => projects.some((p) => p.id === id))),
    accountPick: b.accountPick && (b.accountPick === "auto" || accounts.some((a) => a.id === b.accountPick)) ? b.accountPick : undefined,
    sent: b.sent,
    chatCleared: Object.fromEntries(Object.entries(b.chatCleared ?? {}).map(([k, v]) => [chat(k), v])),
    computer,
    reviewers: b.reviewers,
    folders: [
      ...tasks.flatMap((x) => [{ kind: "sessions", name: x.id }, { kind: "artifacts", name: x.id }] as MoveFolder[]),
      ...skillMoves,
      ...accounts.map((a) => ({ kind: "accounts", name: a.id }) as MoveFolder),
      { kind: "spaces", name: `${spaceFolder(old)}>${spaceFolder(sp)}` } as MoveFolder,
    ],
  };
}
export type Placed = ReturnType<typeof placeBundle>;

/** Put a placed workspace into the state (the folders are already in place). */
export function addPlaced(p: Placed) {
  setState("spaces", (l) => [...l, p.space]);
  setState("projects", (l) => [...(l ?? []), ...p.projects]);
  setState("accounts", (l) => [...l, ...p.accounts]);
  setState("skills", (l) => [...l, ...p.skills]);
  setState("memory", (l) => [...l, ...p.memory]);
  setState("captain", (l) => [...l, ...p.captain]);
  setState("routines", (l) => [...(l ?? []), ...p.routines]);
  setState("journal", (l) => [...(l ?? []), ...p.journal]);
  setState("results", (l) => [...(l ?? []), ...p.results]);
  setState("side", (l) => [...(l ?? []), ...p.side]);
  setState("btws", (l) => [...(l ?? []), ...p.btws]);
  setState("memoryConflicts", (l) => [...(l ?? []), ...p.memoryConflicts]);
  setState("memoryNow", (m) => ({ ...(m ?? {}), ...p.memoryNow }));
  setState("prWatch", (m) => ({ ...(m ?? {}), ...p.prWatch }));
  setState("chatCleared", (m) => ({ ...(m ?? {}), ...p.chatCleared }));
  if (p.accountPick) setState("accountPick", (m) => ({ ...(m ?? {}), [p.space.id]: p.accountPick! }));
  if (p.sent?.length) setState("sent", (m) => ({ ...(m ?? {}), [p.space.id]: p.sent! }));
  if (p.computer) setState("settings", "computers", (m) => ({ ...(m ?? {}), [p.space.id]: p.computer! }));
  if (p.reviewers) setState("settings", "reviewersBySpace", (m) => ({ ...(m ?? {}), [p.space.id]: p.reviewers! }));
  // the jobs last: everything they point at is here
  setState("tasks", (l) => [...l, ...p.tasks]);
}

/** A workspace and everything of it leave this Mac's state (it went to another Mac). The files on
 *  disk stay where they are; the user is put in `to`. */
export function dropSpace(id: SpaceId, to: SpaceId) {
  const gone = state.spaces.find((s) => s.id === id);
  if (!gone || id === "home") return;
  const tasks = new Set(state.tasks.filter((x) => x.space === id && !x.host).map((x) => x.id));
  const folders = new Set((state.projects ?? []).filter((p) => p.space === id && !p.host).map((p) => p.folder));
  const keys = <T,>(o: Record<string, T> | undefined, drop: (k: string, v: T) => boolean) => Object.entries(o ?? {}).filter(([k, v]) => drop(k, v)).map(([k]) => k);
  setState("decisions", (l) => l.filter((d) => !tasks.has(d.taskId)));
  setState("tasks", (l) => l.filter((x) => !tasks.has(x.id)));
  // another Mac's work shown in it, and its projects added here, go to 개인 (as deleting does)
  setState("tasks", (x) => x.space === id, "space", "home");
  setState("projects", (l) => (l ?? []).filter((p) => p.space !== id || !!p.host));
  setState("projects", (p) => p.space === id, "space", "home");
  setState("settings", "hostProjects", (l) => (l ?? []).map((p) => (p.space === id ? { ...p, space: "home" } : p)));
  for (const h of Object.keys(mirror.hosts)) setMirror("hosts", h, "tasks", (x) => x.space === id, "space", "home");
  setState("accounts", (l) => l.filter((a) => a.space !== id || a.id === "default"));
  setState("accounts", (a) => a.space === id, "space", "home");
  setState("memory", (l) => l.filter((m) => m.space !== id));
  setState("captain", (l) => l.filter((m) => m.space !== id));
  setState("skills", (l) => l.filter((k) => k.space !== id));
  setState("routines", (l) => (l ?? []).filter((r) => r.space !== id));
  setState("journal", (l) => (l ?? []).filter((j) => j.space !== id));
  setState("results", (l) => (l ?? []).filter((r) => r.space !== id));
  setState("side", (l) => (l ?? []).filter((m) => m.space !== id));
  setState("btws", (l) => (l ?? []).filter((b) => !inChat(b.scope, id) && !(b.scope.startsWith("task:") && tasks.has(b.scope.slice(5)))));
  setState("memoryConflicts", (l) => (l ?? []).filter((c) => c.space !== id));
  for (const k of keys(state.memoryNow, (k) => folders.has(k))) setState("memoryNow", k, undefined!);
  for (const k of keys(state.prWatch, (_k, w) => tasks.has(w.task))) setState("prWatch", k, undefined!);
  for (const k of keys(state.chatCleared, (k) => k === id || k.startsWith(`${id}~`))) setState("chatCleared", k, undefined!);
  if (state.accountPick?.[id] !== undefined) setState("accountPick", id, undefined!);
  if (state.sent?.[id] !== undefined) setState("sent", id, undefined!);
  if (state.settings.computers?.[id]) setState("settings", "computers", id, undefined!);
  if (state.settings.reviewersBySpace?.[id]) setState("settings", "reviewersBySpace", id, undefined!);
  for (const [dev, l] of Object.entries(state.settings.deviceSpaces ?? {})) if (l.includes(id)) setState("settings", "deviceSpaces", dev, l.filter((x) => x !== id));
  if (state.settings.agent?.space === id) setState("settings", "agent", "space", undefined);
  if (state.settings.agent?.places?.some((p) => p.space === id)) setState("settings", "agent", "places", (l) => (l ?? []).map((p) => (p.space === id ? { ...p, space: undefined } : p)));
  if (state.space === id) setState("space", to);
  void removeCommand(gone).catch(() => {});
  setState("spaces", (l) => l.filter((s) => s.id !== id));
}

// ───────── this Mac sends

const PIECE = 512 << 10;
export const [moving, setMoving] = createSignal<{ space: SpaceId; host: string; done: number; total: number }>();

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** An older Ondra there doesn't know the calls. */
function said(e: unknown): Error {
  const m = e instanceof Error ? e.message : String(e);
  return new Error(m.startsWith("unknown: space.") ? t("그 기기의 Ondra를 업데이트해야 옮길 수 있어요") : m);
}

/**
 * Move a workspace to that Mac: send it all, have it moved in there, then drop it here.
 * Throws (and keeps everything here) when it can't.
 */
export async function moveSpace(id: SpaceId, host: string): Promise<{ label: string; missing: string[] }> {
  if (moving()) throw new Error(t("다른 워크스페이스를 옮기는 중이에요"));
  const space = state.spaces.find((s) => s.id === id);
  if (!space || id === "home" || space.host) throw new Error(t("이 워크스페이스는 옮길 수 없어요"));
  if (mirror.hosts[host]?.status !== "ok") throw new Error(t("{name}에 연결되지 않았어요", { name: hostName(host) }));
  const busy = busyIn(state, id);
  if (busy.length) throw new Error(t("진행 중인 작업 {n}개가 끝나야 옮길 수 있어요", { n: busy.length }));
  const data = engine.info.dataDir;
  const tools = await spaceTools(space).catch(() => null);
  const notes: Record<string, string> = {};
  for (const p of (state.projects ?? []).filter((x) => x.space === id && !x.host)) {
    const n = await readNotes(p.id);
    if (n) notes[p.id] = n;
  }
  const bundle = buildBundle(unwrap(state), id, { home: engine.info.home, dataDir: data, notes, git: tools?.git_name || tools?.git_email ? { name: tools.git_name ?? "", email: tools.git_email ?? "" } : undefined });
  const json = new TextEncoder().encode(JSON.stringify(bundle));
  // every file of its folders, with its size (for how far along it is)
  const files: { path: string; rel: string; size: number }[] = [];
  for (const f of bundleFolders(bundle)) {
    const dir = `${data}/${f.kind}/${f.name}`;
    for (const rel of await fsFiles(dir).catch(() => [] as string[])) {
      const st = await farStat(`${dir}/${rel}`);
      if (st && !st.dir) files.push({ path: `${dir}/${rel}`, rel: `${f.kind}/${f.name}/${rel}`, size: st.size });
    }
  }
  const xid = uid("mv");
  const put = (rel: string, off: number, b64: string) => askHost(host, "space.put", [xid, rel, off, b64], 60_000).catch((e) => Promise.reject(said(e)));
  setMoving({ space: id, host, done: 0, total: json.length + files.reduce((n, f) => n + f.size, 0) });
  const step = (n: number) => setMoving((m) => m && { ...m, done: m.done + n });
  try {
    for (let off = 0; off < json.length; off += PIECE) {
      const part = json.subarray(off, off + PIECE);
      await put("bundle/b/bundle.json", off, toBase64(part));
      step(part.length);
    }
    for (const f of files) {
      for (let off = 0; off < f.size || off === 0; ) {
        const p = await farPiece(f.path, off, PIECE);
        await put(f.rel, off, p.data);
        const n = Math.floor((p.data.length * 3) / 4) - (p.data.endsWith("==") ? 2 : p.data.endsWith("=") ? 1 : 0);
        step(n);
        if (!n) break;
        off += n;
      }
    }
    const r = await askHost<{ space: string; label: string; missing: string[] }>(host, "space.import", [xid], 120_000).catch((e) => Promise.reject(said(e)));
    // that Mac's new workspace has its tab by now (its list came before the answer): the user goes there
    const tab = hostSpaceId(host, r.space);
    dropSpace(id, state.spaces.some((s) => s.id === tab) ? tab : "home");
    return { label: r.label, missing: r.missing ?? [] };
  } catch (e) {
    void askHost(host, "space.cancel", [xid]).catch(() => {});
    throw e;
  } finally {
    setMoving(undefined);
  }
}

// ───────── a Mac moves one here (engine/remote.ts routes its calls)

/** transfers going on, by id: the Mac sending each */
const transfers = new Map<string, string>();

function mine(device: string, xid: unknown): string {
  if (typeof xid !== "string" || !/^mv[a-z0-9]{4,40}$/.test(xid)) throw new Error("bad request");
  const by = transfers.get(xid);
  if (by && by !== device) throw new Error("bad request");
  transfers.set(xid, device);
  return xid;
}

/** a piece of the bundle or of one of its folders, kept apart until space.import */
export async function movePut(device: string, xid: unknown, rel: unknown, offset: unknown, data: unknown): Promise<null> {
  const id = mine(device, xid);
  if (typeof rel !== "string" || !KINDS.has(rel.split("/")[0]) || typeof data !== "string") throw new Error("bad request");
  await farPut("move", `${id}/${rel}`, Math.max(0, Number(offset) || 0), data);
  return null;
}

async function readBundle(xid: string): Promise<SpaceBundle> {
  const path = `${engine.info.dataDir}/remote/moves/${xid}/bundle/b/bundle.json`;
  const parts: Uint8Array[] = [];
  for (let off = 0; ; ) {
    const p = await farPiece(path, off, PIECE);
    const bytes = Uint8Array.from(atob(p.data), (c) => c.charCodeAt(0));
    if (!bytes.length) break;
    parts.push(bytes);
    off += bytes.length;
    if (off >= p.size) break;
  }
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (all.set(p, at), at + p.length), 0);
  const b = JSON.parse(new TextDecoder().decode(all)) as SpaceBundle;
  if (b?.v !== 1 || !b.space || typeof b.space.label !== "string" || !Array.isArray(b.tasks)) throw new Error(t("옮길 내용을 읽지 못했어요"));
  return b;
}

/** Everything is here: put the folders in place and add the workspace. */
export async function moveImport(device: string, xid: unknown, from: string): Promise<{ space: string; label: string; missing: string[] }> {
  const id = mine(device, xid);
  try {
    const b = await readBundle(id);
    const data = engine.info.dataDir;
    const skillDirs = new Set([...(await fsFiles(`${data}/skills`).catch(() => [] as string[])).map((f) => f.split("/")[0]), ...state.skills.map((k) => skillDir(k.path, data)).filter((d): d is string => !!d)]);
    const p = placeBundle(b, { state: unwrap(state), home: engine.info.home, dataDir: data, space: uid("sp"), hosts: new Set((state.settings.hosts ?? []).map((h) => h.id)), skillDirs });
    const items = p.folders.map((f) => { const [a, z = a] = f.name.split(">"); return { kind: f.kind, from: a, to: z }; });
    const went = await spaceMovesIn(id, items);
    // a skill whose folder couldn't be put in place has nothing to read
    const lost = new Set(items.flatMap((it, i) => (it.kind === "skills" && !went[i] ? [`${data}/skills/${it.to}/`] : [])));
    p.skills = p.skills.filter((k) => ![...lost].some((d) => k.path.startsWith(d)));
    addPlaced(p);
    for (const [pid, text] of Object.entries(p.notes)) await writeNotes(pid, text);
    void installCommand(p.space).catch(() => {});
    if (b.git) void spaceGitIdentity(p.space, b.git.name, b.git.email).catch(() => {});
    const folders = p.projects.map((x) => x.folder.replace(/^~(?=\/|$)/, engine.info.home));
    const there = await pathsExist(folders);
    const missing = p.projects.filter((_, i) => !there[i]).map((x) => x.name);
    void import("../state/ui").then((m) => m.toast(t("{name}에서 {space} 워크스페이스를 옮겨 왔어요", { name: from, space: p.space.label })));
    return { space: p.space.id, label: p.space.label, missing };
  } finally {
    transfers.delete(id);
    void spaceMoveClear(id).catch(() => {});
  }
}

export function moveCancel(device: string, xid: unknown): null {
  const id = mine(device, xid);
  transfers.delete(id);
  void spaceMoveClear(id).catch(() => {});
  return null;
}
