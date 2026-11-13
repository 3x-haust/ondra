// A job of another Mac (Settings › 연결), read and handled as if it were here: its files,
// its git diff, its pictures and results, PRs and issues, a terminal in its folder, its
// skills and memory all come from that Mac, which runs it. Each helper takes where the thing
// is (`host`: that Mac's id, undefined for this one) and does the same either way, so a panel
// asks once and doesn't care. That Mac's side is engine/farHost.ts.
//
// Paths go there in that Mac's terms: this Mac's home turned back into "~" (it has its own).
// Its files are cached here by path and version (src-tauri/src/farfs.rs) so a picture or a
// page shows like a local one; anything bigger than MAX_MEDIA isn't fetched.
import { createContext, createSignal, useContext } from "solid-js";
import { createStore } from "solid-js/store";
import {
  artifactsList,
  farCached,
  farPiece,
  farPut,
  farStat,
  fileSrc,
  fsFiles,
  fsGrep,
  fsRead,
  fsWrite,
  gitChanges,
  gitFileAt,
  gitMerged,
  openInEditor,
  reverseTrace,
  revealPath,
  type ArtifactFile,
  type FarStat,
  type FileAt,
  type FileText,
  type GitChanges,
  type Merged,
} from "../lib/native";
import { asHostPath, cacheName, uploadName } from "./farPaths";
import { askHost, onPeerKind, tellHost } from "./hosts";
import { engine } from "./rpc";
import { t } from "../i18n";

/** the Mac a thing is on: another Mac's id, or undefined for this one */
export type Where = string | undefined;

/** what a view shows is another Mac's (a remote job's thread and panels): pictures in it come from there */
export const HostCtx = createContext<() => Where>(() => undefined);
export const useHost = () => useContext(HostCtx);

/** a path as that Mac reads it */
export const there = (p: string) => asHostPath(p, engine.info.home);

/** The one switch: on another Mac it is asked there, here it is done here. */
export function onMac<T>(host: Where, fn: string, args: unknown[], here: () => Promise<T>): Promise<T> {
  return host ? askHost<T>(host, fn, args) : here();
}

/** a diff or file cut short over there (too big to send whole) */
export type Cut = { cut?: boolean };

export const listFiles = (host: Where, dir: string) => onMac<string[]>(host, "far.files", [there(dir)], () => fsFiles(dir));
export const readText = (host: Where, path: string) => onMac<FileText>(host, "far.read", [there(path)], () => fsRead(path));
export const grepFiles = (host: Where, dir: string, q: string) =>
  onMac<{ path: string; line: number; text: string }[]>(host, "far.grep", [there(dir), q], () => fsGrep(dir, q));
export const writeText = (host: Where, path: string, text: string, expect?: number) => onMac<number>(host, "far.write", [there(path), text, expect ?? null], () => fsWrite(path, text, expect));
/** `counts`: only what changed by file, not the diff (the sidebar's "+a −b") */
export const changesIn = (host: Where, dir: string, base?: string, counts = false) =>
  onMac<GitChanges & Cut>(host, "far.changes", [there(dir), base ?? null, counts], () => gitChanges(dir, base));
export const fileAtRev = (host: Where, dir: string, rev: string | null, path: string) => onMac<FileAt>(host, "far.fileAt", [there(dir), rev, path], () => gitFileAt(dir, rev, path));
export const mergedIn = (host: Where, repo: string, branch: string, into: string | undefined, base: string) =>
  onMac<(Merged & { changes: Cut }) | null>(host, "far.merged", [there(repo), branch, into ?? null, base], () => gitMerged(repo, branch, into, base));
export const artifactsOf = (host: Where, id: string) => onMac<ArtifactFile[]>(host, "far.artifacts", [id], () => artifactsList(id));
export const traceOf = (host: Where, id: string, from: number) => onMac<{ text: string; end: number }>(host, "far.trace", [id, from], () => reverseTrace(id, from));
/** Finder there (on that Mac's own screen) */
export const revealOn = (host: Where, path: string) => onMac<void>(host, "far.reveal", [there(path)], () => revealPath(path)).catch(() => {});
export const editorOn = (host: Where, path: string) => onMac<void>(host, "far.editor", [there(path)], () => openInEditor(path)).catch(() => {});

/** an error from there, in words for a panel: an older Ondra there doesn't know the call */
export function farError(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  // that Mac says why in Korean (as a job's error is kept there): in this Mac's language here
  return /^unknown: far\./.test(s) ? t("그 Mac의 Ondra를 업데이트해야 볼 수 있어요") : s.includes("|") ? s : t(s);
}

// ───────── pictures, videos and pages: fetched once per version, kept here

/** the biggest file fetched to show (a picture, a video, a page) */
export const MAX_MEDIA = 48 << 20;
const PIECE = 512 << 10;

const [local, setLocal] = createStore<Record<string, { path?: string; big?: boolean }>>({});
/** when each was last looked at, last asked for on screen, and how long until the next look (longer while it stays the same) */
const looked = new Map<string, { at: number; seen: number; wait: number; busy?: boolean }>();
let ticking: ReturnType<typeof setInterval> | undefined;

/** Fetch a file of that Mac into the cache here (in pieces, one at a time). */
async function fetchTo(host: string, path: string, name: string, size: number): Promise<string> {
  let out = "";
  for (let off = 0; off < size || off === 0; ) {
    const p = await askHost<{ data: string; size: number }>(host, "far.piece", [there(path), off, PIECE]);
    out = await farPut("cache", name, off, p.data);
    const n = Math.floor((p.data.length * 3) / 4) - (p.data.endsWith("==") ? 2 : p.data.endsWith("=") ? 1 : 0);
    if (!n) break;
    off += n;
  }
  return out;
}

async function look(host: string, path: string, key: string) {
  const l = looked.get(key)!;
  l.busy = true;
  l.at = Date.now();
  try {
    const st = await askHost<FarStat | null>(host, "far.stat", [there(path)]);
    if (!st || st.dir) return;
    if (st.size > MAX_MEDIA) return void setLocal(key, { big: true });
    const name = cacheName(host, path, st.modified);
    l.wait = local[key]?.path?.endsWith(name) ? Math.min(l.wait * 2, 60_000) : 4000;
    let file = await farCached(name);
    if (file && (await farStat(file))?.size !== st.size) file = null;
    file ??= await fetchTo(host, path, name, st.size);
    if (local[key]?.path !== file) setLocal(key, { path: file });
  } catch {
    // not there, not allowed, or an older Ondra: nothing to show
  } finally {
    l.busy = false;
  }
}

/** The file here for a file of that Mac, once it is fetched (reactive; "" until then). Looked at
 *  again every few seconds while shown: a screenshot is written over in place. */
export function localCopy(path: string, host: Where): string {
  if (!host || !path) return path;
  const key = `${host}|${path}`;
  const l = looked.get(key) ?? { at: 0, seen: 0, wait: 4000 };
  l.seen = Date.now();
  looked.set(key, l);
  if (!l.busy && Date.now() - l.at > l.wait) void look(host, path, key);
  ticking ??= setInterval(() => {
    for (const [k, x] of looked) {
      if (Date.now() - x.seen > 30_000) continue;
      const i = k.indexOf("|");
      if (!x.busy && Date.now() - x.at > x.wait) void look(k.slice(0, i), k.slice(i + 1), k);
    }
  }, 4000);
  return local[key]?.path ?? "";
}

/** too big to fetch from that Mac */
export const tooBig = (path: string, host: Where) => !!host && !!local[`${host}|${path}`]?.big;

/** an <img>/<video> src for a file here or on that Mac */
export function srcOf(path: string, host: Where): string {
  if (!host) return fileSrc(path);
  const p = localCopy(path, host);
  return p ? fileSrc(p) : "";
}

// ───────── attachments: sent to that Mac, its paths given back

/** the biggest attachment sent */
export const MAX_UPLOAD = 100 << 20;

/** Send files of this Mac to that one (into its attachments folder); the paths there, in order. */
export async function sendFiles(host: string, files: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const f of files) {
    const st = await farStat(f);
    if (!st) throw new Error(t("파일이 없어요 · {name}", { name: f.split("/").pop() ?? f }));
    if (st.dir) throw new Error(t("폴더는 다른 Mac에 보낼 수 없어요 · {name}", { name: f.split("/").pop() ?? f }));
    if (st.size > MAX_UPLOAD) throw new Error(t("파일이 너무 커요 · {name}", { name: f.split("/").pop() ?? f }));
    const name = uploadName(f, Date.now(), Math.random().toString(36).slice(2, 8));
    let at = "";
    for (let off = 0; off < st.size || off === 0; ) {
      const p = await farPiece(f, off, PIECE);
      at = await askHost<string>(host, "far.upload", [name, off, p.data], 60_000);
      const n = Math.floor((p.data.length * 3) / 4) - (p.data.endsWith("==") ? 2 : p.data.endsWith("=") ? 1 : 0);
      if (!n) break;
      off += n;
    }
    out.push(at);
  }
  return out;
}

// ───────── a terminal there

/** a job of another Mac whose terminal should open (its ⋯ menu's 터미널 열기): the panel's terminal tab takes it */
export const [farShell, setFarShell] = createSignal<string | null>(null);

export interface TermIO {
  /** hear its output and its end; gives back how to stop hearing */
  listen: (data: (s: string) => void, exit: (code: number | null) => void) => () => void;
  open: (cols: number, rows: number) => Promise<void>;
  write: (data: string) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

const terms = new Map<string, { data: (s: string) => void; exit: (code: number | null) => void }>();
let hearing = false;
function hear() {
  if (hearing) return;
  hearing = true;
  onPeerKind("pty", (host, d) => {
    const x = terms.get(`${host}|${String(d.id)}`);
    if (!x) return;
    if ("exit" in d) x.exit(typeof d.exit === "number" ? d.exit : null);
    else if (typeof d.data === "string") x.data(d.data);
  });
  onPeerKind("@closed", (host) => {
    for (const [k, x] of terms) if (k.startsWith(`${host}|`)) x.exit(null);
  });
}

/** A shell in a job's folder on that Mac; keys go there in small batches, the output comes back the same way. */
export function farTerm(host: string, task: string, id: string): TermIO {
  hear();
  const key = `${host}|${id}`;
  let typed = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sizeTimer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    if (typed) tellHost(host, { t: "pty-in", id, data: typed });
    typed = "";
  };
  return {
    listen: (data, exit) => {
      terms.set(key, { data, exit: (c) => (terms.delete(key), exit(c)) });
      return () => terms.delete(key);
    },
    open: (cols, rows) => askHost<boolean>(host, "far.ptyOpen", [id, task, cols, rows]).then(() => {}),
    write: (d) => {
      typed += d;
      timer ??= setTimeout(flush, 8);
    },
    resize: (cols, rows) => {
      clearTimeout(sizeTimer);
      sizeTimer = setTimeout(() => tellHost(host, { t: "pty-size", id, cols, rows }), 120);
    },
    close: () => {
      flush();
      terms.delete(key);
      void askHost(host, "far.ptyClose", [id]).catch(() => {});
    },
  };
}

// ───────── memory of a project there

export interface FarMemory { id: string; text: string; kind?: string; pinned?: boolean; by?: string; updatedAt?: number }
export const farMemList = (host: string, project: string) => askHost<FarMemory[]>(host, "far.memList", [project]);
export const farMemAdd = (host: string, o: { project?: string; task?: string; text: string }) => askHost<string | null>(host, "far.memAdd", [o]);
export const farMemEdit = (host: string, project: string, id: string, text: string) => askHost<void>(host, "far.memEdit", [project, id, text]);
export const farMemForget = (host: string, project: string, id: string) => askHost<void>(host, "far.memForget", [project, id]);
