// A job of another Mac (Settings › 연결), read and handled as if it were here: its files,
// its git diff, its pictures and results, PRs and issues, a terminal in its folder, its
// skills and memory all come from that Mac, which runs it. Each helper takes where the thing
// is (`host`: that Mac's id, undefined for this one) and does the same either way, so a panel
// asks once and doesn't care. That Mac's side is engine/farHost.ts.
//
// Paths go there in that Mac's terms: this Mac's home turned back into "~" (it has its own).
// Its files are cached here by path and version (src-tauri/src/farfs.rs) so a picture or a
// page shows like a local one (a page with the files it links to, laid out as there); anything
// bigger than MAX_MEDIA isn't fetched.
import { createContext, createSignal, useContext } from "solid-js";
import { createStore } from "solid-js/store";
import {
  artifactsList,
  farCached,
  farPiece,
  farPut,
  farStat,
  fileSrc,
  pageSrc,
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
import { asHostPath, cacheName, pageRefs, resolveRef, scanKind, siteName, uploadName } from "./farPaths";
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
async function fetchTo(host: string, path: string, name: string, size: number, kind: "cache" | "site" = "cache"): Promise<string> {
  let out = "";
  for (let off = 0; off < size || off === 0; ) {
    const p = await askHost<{ data: string; size: number }>(host, "far.piece", [there(path), off, PIECE]);
    out = await farPut(kind, name, off, p.data);
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

// ───────── a page of that Mac, with what it uses

/** a page brings at most this many files with it, and this much in all */
export const SITE_FILES = 400;
export const SITE_BYTES = 200 << 20;
/** a file read for more links: no bigger than this */
const SCAN_MAX = 4 << 20;

interface Site {
  /** the page's copy here, and the folder the copies are laid out in */
  path?: string;
  root?: string;
  /** each file copied: its version there ("modified:size") */
  got: Map<string, string>;
  /** the page's version when last copied */
  page?: number;
  busy?: boolean;
  at: number;
  seen: number;
  wait: number;
}
const [sites, setSites] = createStore<Record<string, { path?: string; v: number; big?: boolean }>>({});
const siteState = new Map<string, Site>();
let siteTick: ReturnType<typeof setInterval> | undefined;

/**
 * Copy a page of that Mac here with every file it links to (its pictures, styles, scripts,
 * fonts, other pages, followed through those too), laid out as there so the page's relative
 * links find them. Files that Mac doesn't let this one read, or that are gone, are left out.
 */
async function syncSite(host: string, page: string, s: Site): Promise<boolean> {
  let changed = false;
  let bytes = 0;
  const seen = new Set<string>([page]);
  const queue = [page];
  const one = async (path: string) => {
    const st = await askHost<FarStat | null>(host, "far.stat", [there(path)]).catch(() => null);
    if (!st || st.dir || st.size > MAX_MEDIA || bytes + st.size > SITE_BYTES) return;
    bytes += st.size;
    const mark = `${st.modified}:${st.size}`;
    const name = siteName(host, path);
    // the same version as last time, still here: kept
    let file = s.root && s.got.get(path) === mark ? `${s.root}${name}` : undefined;
    if (file && (await farStat(file))?.size !== st.size) file = undefined;
    if (!file) {
      file = await fetchTo(host, path, name, st.size, "site").catch(() => undefined);
      if (!file) return;
      s.got.set(path, mark);
      s.root ??= file.slice(0, file.length - name.length);
      changed = true;
    }
    if (path === page) s.path = file;
    const kind = scanKind(path);
    if (!kind || st.size > SCAN_MAX) return;
    const text = (await fsRead(file).catch(() => null))?.text;
    if (!text) return;
    const dir = path.slice(0, path.lastIndexOf("/"));
    for (const r of pageRefs(text, kind)) {
      const next = resolveRef(dir, r);
      if (next && !seen.has(next) && seen.size < SITE_FILES) (seen.add(next), queue.push(next));
    }
  };
  // the page first (its folder is known from it), then the rest a few at a time
  await one(queue.shift()!);
  if (!s.path) return false;
  const work = async () => {
    for (let x = queue.shift(); x !== undefined; x = queue.shift()) await one(x);
  };
  await Promise.all([work(), work(), work(), work()]);
  return changed;
}

async function lookSite(host: string, page: string, key: string) {
  const s = siteState.get(key)!;
  s.busy = true;
  s.at = Date.now();
  try {
    const st = await askHost<FarStat | null>(host, "far.stat", [there(page)]);
    if (!st || st.dir) return;
    if (st.size > MAX_MEDIA) return void setSites(key, { v: 0, big: true });
    // the page itself changed (or was never copied): copy again what it uses
    if (s.page === st.modified && s.path) return void (s.wait = Math.min(s.wait * 2, 60_000));
    s.wait = 4000;
    const changed = await syncSite(host, page, s);
    s.page = st.modified;
    if (s.path && (changed || sites[key]?.path !== s.path)) setSites(key, { path: s.path, v: Date.now() });
  } catch {
    // not there, not allowed, or an older Ondra: nothing to show
  } finally {
    s.busy = false;
  }
}

/** An <iframe> src for a page here or on that Mac (reactive; "" until it is copied here). A page of
 *  that Mac comes with the files it uses, and shows again when it changes there. */
export function pageSrcOf(path: string, host: Where): string {
  if (!host || !path) return pageSrc(path);
  const key = `${host}|${path}`;
  const s: Site = siteState.get(key) ?? { got: new Map(), at: 0, seen: 0, wait: 4000 };
  s.seen = Date.now();
  siteState.set(key, s);
  if (!s.busy && Date.now() - s.at > s.wait) void lookSite(host, path, key);
  // looked at again while on screen: the page there is rewritten as the job works
  siteTick ??= setInterval(() => {
    for (const [k, x] of siteState) {
      if (Date.now() - x.seen > 30_000) continue;
      const i = k.indexOf("|");
      if (!x.busy && Date.now() - x.at > x.wait) void lookSite(k.slice(0, i), k.slice(i + 1), k);
    }
  }, 4000);
  const x = sites[key];
  return x?.path ? `${pageSrc(x.path)}?v=${x.v}` : "";
}
/** too big to copy from that Mac */
export const pageTooBig = (path: string, host: Where) => !!host && !!sites[`${host}|${path}`]?.big;

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
