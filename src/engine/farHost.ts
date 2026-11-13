// What another Mac may read and run here for the jobs it sees (Settings › 연결): the files of
// their folders, their git diff, their results and screenshots, a terminal in their folder,
// this Mac's skills and the memory of its projects. The other side is engine/far.ts.
//
//   them → here  {t:"call",fn:"far.*",args}  {t:"pty-in",id,data}  {t:"pty-size",id,cols,rows}
//   here → them  {t:"ret",…}  {t:"pty",id,data?|exit?}
//
// Every call checks what it touches: a path must lie inside a folder of a project the Mac added
// or of a job it sees (engine/farPaths.ts), a job must be one it sees. Nothing else is reached.
import { onEvent, artifactsList, farPiece, farPut, farReal, farStat, fsFiles, fsGrep, fsRead, fsWrite, ghIssue, ghIssues, ghPrView, gitChanges, gitCommit, gitFileAt, gitMerged, gitPr, gitPush, openInEditor, ptyClose, ptyOpen, ptyResize, ptyWrite, reverseTrace, revealPath, spaceEnv, type Env } from "../lib/native";
import { homeDir, spaceById, state } from "../state/store";
import type { Memory, Project, Task } from "../state/types";
import { allowedPath, capText, cleanRoots, mentions, normPath, repoPath, under } from "./farPaths";
import { engine, expand } from "./rpc";
import { addMemory, isLive, removeMemory, updateMemory } from "./memory";
import { skillsFor } from "./skillMenu";
import { gitEnv, prOf } from "./tasks";

/** the Mac asking, as engine/remote.ts knows it */
export interface FarPeer {
  conn: number;
  device: string;
  /** the projects (ids here) it added */
  watch: Set<string>;
  /** a job it sees: of those projects, or one it started */
  sees: (t: Task) => boolean;
  send: (data: Record<string, unknown>) => void;
}

/** a diff, a trace piece: at most this much in one answer (a bigger one says it was cut) */
const MAX_TEXT = 3 << 20;
/** a piece of a file: the other Mac asks for the next when this one is in */
const MAX_PIECE = 512 << 10;
/** terminals one Mac may keep open here */
const MAX_PTYS = 6;

const home = () => engine.info.home;
const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "");
const fail = (why: string): never => {
  throw new Error(why);
};
const NOT_THERE = "그 Mac에서 열 수 없는 위치예요";

const myTask = (p: FarPeer, id: unknown): Task => {
  const t = state.tasks.find((x) => x.id === id);
  return t && p.sees(t) ? t : fail("그 작업이 이 Mac에 없어요");
};
const myProject = (p: FarPeer, id: unknown): Project => {
  const pr = (state.projects ?? []).find((x) => x.id === id);
  return pr && p.watch.has(pr.id) ? pr : fail("그 프로젝트가 이 Mac에 없어요");
};

/** the folders that Mac may reach here */
export function rootsFor(p: FarPeer): string[] {
  const dirs: (string | undefined)[] = [];
  for (const pr of state.projects ?? []) if (p.watch.has(pr.id)) dirs.push(pr.folder);
  const data = engine.info.dataDir;
  for (const t of state.tasks) {
    if (!p.sees(t)) continue;
    dirs.push(t.cwd, t.worktree?.path, t.worktree?.repo);
    if (data) dirs.push(`${data}/artifacts/${safeId(t.id)}`);
  }
  if (data) dirs.push(`${data}/attachments/remote`);
  return cleanRoots(dirs, home());
}

/** a file one of its jobs named itself (a screenshot in a reply, its last browser shot): the whole
 *  path, not a part of a longer one */
function named(p: FarPeer, abs: string): boolean {
  if (!/\/[^/]*[^/.]\.[A-Za-z0-9]+$/.test(abs)) return false;
  for (const t of state.tasks) {
    if (!p.sees(t)) continue;
    if (t.shot && expand(t.shot) === abs) return true;
    for (const e of t.entries) {
      const hit =
        e.kind === "tool" ? !!e.tool.image && expand(e.tool.image) === abs
        : e.kind === "text" || e.kind === "user" ? mentions(e.text, abs)
        : e.kind === "block" ? mentions(JSON.stringify(e.block), abs)
        : false;
      if (hit) return true;
    }
  }
  return false;
}

/** The path, absolute, when that Mac may reach it; else an error. Links are followed: one
 *  pointing out of the folders counts as outside. `files`: a single file a job named is fine too
 *  (as it named it: that one file, wherever it is). */
async function reach(p: FarPeer, path: unknown, files = false): Promise<string> {
  if (typeof path !== "string") fail(NOT_THERE);
  const abs = normPath(path as string, home()) ?? fail(NOT_THERE);
  if (files && named(p, abs)) return abs;
  const roots = rootsFor(p);
  if (!allowedPath(abs, roots, home())) fail(NOT_THERE);
  const [real, ...rootsReal] = await farReal([abs, ...roots]).catch(() => [abs, ...roots]);
  if (real && real !== abs && !rootsReal.some((r, i) => under(real, r ?? roots[i]))) fail(NOT_THERE);
  return abs;
}

/** the env of a folder's space here (gh signed in as that space) */
const envOf = async (dir: string): Promise<Env> => {
  const pr = (state.projects ?? []).find((x) => under(dir, expand(x.folder)));
  const space = pr?.space ?? state.space;
  return spaceEnv(spaceById(space)).catch(() => []);
};

/** pieces kept for a project of this Mac: its own (by folder), the same way the Memory page files them */
const memoryOf = (pr: Project): Memory[] => state.memory.filter((m) => m.scope === "project" && !!m.project && expand(m.project) === expand(pr.folder) && isLive(m));
const sentMemory = (m: Memory) => ({ id: m.id, text: m.text, kind: m.kind, pinned: m.pinned, by: m.by, updatedAt: m.updatedAt ?? m.createdAt });

// ───────── terminals

const ptys = new Map<string, { conn: number; id: string; out: string; timer?: ReturnType<typeof setTimeout>; send: FarPeer["send"] }>();
const ptyKey = (conn: number, id: string) => `far-${conn}-${String(id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}`;
/** output is sent in batches, not per read: a flood (cat of a big file) doesn't swamp the line */
const FLUSH_MS = 40;
const MAX_OUT = 256 << 10;
function flushPty(key: string) {
  const x = ptys.get(key);
  if (!x) return;
  x.timer = undefined;
  if (!x.out) return;
  const data = x.out;
  x.out = "";
  x.send({ t: "pty", id: x.id, data });
}
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  void onEvent<{ id: string; data: string }>("pty:data", (e) => {
    const x = ptys.get(e.id);
    if (!x) return;
    x.out += e.data;
    // too much waiting to go: keep the end (what the screen shows), say some was skipped
    if (x.out.length > MAX_OUT * 4) x.out = `\r\n\x1b[2m[…]\x1b[0m\r\n${x.out.slice(-MAX_OUT)}`;
    if (x.out.length > MAX_OUT) flushPty(e.id);
    else x.timer ??= setTimeout(() => flushPty(e.id), FLUSH_MS);
  });
  void onEvent<{ id: string; code: number | null }>("pty:exit", (e) => {
    const x = ptys.get(e.id);
    if (!x) return;
    flushPty(e.id);
    clearTimeout(x.timer);
    ptys.delete(e.id);
    x.send({ t: "pty", id: x.id, exit: e.code ?? null });
  });
}

/** that Mac went: its terminals here close */
export function farClosed(conn: number) {
  for (const [key, x] of ptys) {
    if (x.conn !== conn) continue;
    clearTimeout(x.timer);
    ptys.delete(key);
    void ptyClose(key).catch(() => {});
  }
}

/** keys typed and size changes, sent without waiting for an answer */
export function farMsg(p: FarPeer, msg: Record<string, unknown>) {
  const key = ptyKey(p.conn, String(msg.id ?? ""));
  if (!ptys.has(key)) return;
  if (msg.t === "pty-in" && typeof msg.data === "string") void ptyWrite(key, msg.data.slice(0, 64 << 10)).catch(() => {});
  else if (msg.t === "pty-size") void ptyResize(key, Number(msg.cols) || 80, Number(msg.rows) || 24).catch(() => {});
}

// ───────── the calls

type Fn = (p: FarPeer, ...a: never[]) => unknown;
const FAR: Record<string, Fn> = {
  /** every file of a folder (relative paths) */
  "far.files": async (p, dir: string) => fsFiles(await reach(p, dir)),
  "far.read": async (p, path: string) => fsRead(await reach(p, path, true)),
  "far.grep": async (p, dir: string, q: string) => fsGrep(await reach(p, dir), String(q ?? "")),
  "far.write": async (p, path: string, text: string, expect?: number) => fsWrite(await reach(p, path), String(text ?? ""), typeof expect === "number" ? expect : undefined),
  "far.stat": async (p, path: string) => farStat(await reach(p, path, true)),
  "far.piece": async (p, path: string, offset: number, len: number) => farPiece(await reach(p, path, true), Math.max(0, Number(offset) || 0), Math.min(MAX_PIECE, Math.max(0, Number(len) || MAX_PIECE))),
  "far.changes": async (p, dir: string, base?: string, counts?: boolean) => {
    const c = await gitChanges(await reach(p, dir), typeof base === "string" ? base : undefined);
    if (counts === true) return { ...c, patch: "" };
    const { text, cut } = capText(c.patch ?? "", MAX_TEXT);
    return { ...c, patch: text, cut };
  },
  "far.fileAt": async (p, dir: string, rev: string | null, path: string) => {
    const f = await gitFileAt(await reach(p, dir), typeof rev === "string" ? rev : null, repoPath(path) ?? fail(NOT_THERE));
    if (f.text === null) return f;
    const { text, cut } = capText(f.text, MAX_TEXT);
    return { ...f, text, cut: f.cut || cut };
  },
  "far.merged": async (p, repo: string, branch: string, into: string | undefined, base: string) => {
    const m = await gitMerged(await reach(p, repo), String(branch), typeof into === "string" ? into : undefined, String(base));
    if (!m) return m;
    const { text, cut } = capText(m.changes.patch ?? "", MAX_TEXT);
    return { ...m, changes: { ...m.changes, patch: text, cut } };
  },
  "far.artifacts": (p, id: string) => artifactsList(myTask(p, id).id),
  "far.trace": async (p, id: string, from: number) => {
    const r = await reverseTrace(myTask(p, id).id, Math.max(0, Number(from) || 0));
    const { text, cut } = capText(r.text, 1 << 20);
    // cut short: the next ask goes on from where this piece ends
    return cut ? { text, end: (Number(from) || 0) + new TextEncoder().encode(text).length } : r;
  },
  /** on this Mac's screen: Finder, or the editor */
  "far.reveal": async (p, path: string) => revealPath(await reach(p, path, true)),
  "far.editor": async (p, path: string) => openInEditor(await reach(p, path)),
  "far.ghIssues": async (p, dir: string, q: string) => {
    const d = await reach(p, dir);
    return ghIssues(d, String(q ?? ""), await envOf(d));
  },
  "far.ghIssue": async (p, dir: string, n: number) => {
    const d = await reach(p, dir);
    return ghIssue(d, Number(n), await envOf(d));
  },
  "far.prView": async (p, id: string) => {
    const t = myTask(p, id);
    const pr = prOf(t) ?? fail("PR 없음");
    return ghPrView(pr.url, await gitEnv(t));
  },
  "far.commit": async (p, id: string) => {
    const t = myTask(p, id);
    return gitCommit(expand(t.cwd), t.title, await gitEnv(t));
  },
  "far.push": async (p, id: string) => {
    const t = myTask(p, id);
    return gitPush(expand(t.cwd), await gitEnv(t));
  },
  "far.pr": async (p, id: string) => {
    const t = myTask(p, id);
    return gitPr(expand(t.cwd), t.title, `${t.ask}\n\n— Ondra`, await gitEnv(t));
  },
  /** a piece of an attachment: kept in this app's attachments/remote, its path given back */
  "far.upload": (_p, name: string, offset: number, data: string) => farPut("upload", String(name), Math.max(0, Number(offset) || 0), String(data ?? "")),
  /** a shell in the job's folder, its output sent as it comes ({t:"pty"}) */
  "far.ptyOpen": async (p, id: string, task: string, cols: number, rows: number) => {
    const t = myTask(p, task);
    const key = ptyKey(p.conn, id);
    if (!ptys.has(key) && [...ptys.values()].filter((x) => x.conn === p.conn).length >= MAX_PTYS) fail("터미널이 너무 많이 열려 있어요");
    listen();
    ptys.set(key, { conn: p.conn, id: String(id), out: "", send: p.send });
    try {
      await ptyOpen(key, expand(homeDir(t) || t.cwd), null, [], await gitEnv(t), Number(cols) || 80, Number(rows) || 24);
    } catch (e) {
      ptys.delete(key);
      throw e;
    }
    return true;
  },
  "far.ptyClose": (p, id: string) => {
    const key = ptyKey(p.conn, id);
    const x = ptys.get(key);
    if (!x) return;
    clearTimeout(x.timer);
    ptys.delete(key);
    return ptyClose(key);
  },
  /** the skills a job here gets, for the input's "/" menu there: in that job's (or project's) workspace */
  "far.skills": (p, o: { task?: string; project?: string }) => {
    const space = o?.task ? myTask(p, o.task).space : o?.project ? myProject(p, o.project).space : state.space;
    return skillsFor(space);
  },
  // a project's memory here: what its jobs are told
  "far.memList": (p, project: string) => memoryOf(myProject(p, project)).map(sentMemory),
  "far.memAdd": (p, o: { project?: string; task?: string; text: string }) => {
    const text = String(o?.text ?? "").trim().slice(0, 4000);
    if (!text) return null;
    // from a job: filed under its folder, as /remember in a job here does
    if (o.task) {
      const t = myTask(p, o.task);
      return addMemory(text, "project", { project: homeDir(t), space: t.space, quiet: true });
    }
    const pr = myProject(p, o.project);
    return addMemory(text, "project", { project: pr.folder, space: pr.space, quiet: true });
  },
  "far.memEdit": (p, project: string, id: string, text: string) => {
    const m = memoryOf(myProject(p, project)).find((x) => x.id === id) ?? fail("그 메모리가 없어요");
    updateMemory(m.id, String(text ?? "").slice(0, 4000));
  },
  "far.memForget": (p, project: string, id: string) => {
    const m = memoryOf(myProject(p, project)).find((x) => x.id === id) ?? fail("그 메모리가 없어요");
    removeMemory(m.id);
  },
};

/** the call of that name for that Mac, when it is one of these */
export function farCall(p: FarPeer, fn: string): ((...a: unknown[]) => unknown) | undefined {
  const f = Object.prototype.hasOwnProperty.call(FAR, fn) ? FAR[fn] : undefined;
  // always a promise: a refusal is an answer like any other
  return f && (async (...a: unknown[]) => (f as (p: FarPeer, ...a: unknown[]) => unknown)(p, ...a));
}
