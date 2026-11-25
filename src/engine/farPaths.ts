// Which files another device may reach on this one (Settings › 연결): only what lies inside the
// folders of the projects it added and of the jobs it sees (their folders, worktrees and
// result folders), or a file one of those jobs named itself (a screenshot in its reply).
// Never the disk at large: a folder as wide as the home folder doesn't count.
// Pure, so it can be tested; engine/farHost.ts applies it.

/** Pick the grammar from the serving machine's home, never from what the peer asks for. */
export const windowsHome = (home: string) => /^(?:[A-Za-z]:[/\\]|\\\\|\/\/)/.test(home);
const winPart = (s: string) => !!s && !/[\\<>:"|?*\x00-\x1f]|[. ]$/.test(s) && !/^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\.|$)/i.test(s);

/** An old Mac expects absolute slash paths, including for the files next to a page. The
 * markers have no special meaning on a POSIX host, and are legal site-cache directories. */
const DRIVE = "/@drive/";
const SHARE = "/@share/";

/** "~/x", a local file URL or an absolute native path → one slash-separated absolute path. */
export function normPath(p: string, home: string): string | undefined {
  if (typeof p !== "string" || !p || p.includes("\0")) return undefined;
  const win = windowsHome(home);
  let s = win ? p.replace(/\\/g, "/") : p.trim();
  if (s.startsWith("file://")) {
    try {
      s = decodeURI(s.slice(7));
      if (win) s = /^\/[a-z]:\//i.test(s) ? s.slice(1) : !s.startsWith("/") ? `//${s}` : s;
    } catch {
      return undefined;
    }
  }
  if (s.includes("\0")) return undefined;
  if (s === "~" || s.startsWith("~/")) s = (win ? home.replace(/\\/g, "/") : home).replace(/\/+$/, "") + s.slice(1);
  let root = "/";
  if (win) {
    if (s.startsWith(DRIVE)) s = s.slice(DRIVE.length).replace(/^([a-z])(?:\/|$)/i, "$1:/");
    else if (s.startsWith(SHARE)) s = `//${s.slice(SHARE.length)}`;
    const drive = /^([a-z]):\//i.exec(s);
    const share = /^\/\/([^/]+)\/([^/]+)(?:\/|$)/.exec(s);
    if (drive) {
      root = `${drive[1].toUpperCase()}:/`;
      s = s.slice(3);
    } else if (share && winPart(share[1]) && winPart(share[2]) && !/^(pipe|mailslot|ipc\$)$/i.test(share[2])) {
      root = `//${share[1]}/${share[2]}/`;
      s = s.slice(share[0].length);
    } else return undefined;
  } else if (!s.startsWith("/")) return undefined;
  const out: string[] = [];
  for (const part of s.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return undefined;
      out.pop();
    } else if (win && !winPart(part)) return undefined;
    else out.push(part);
  }
  return root + out.join("/");
}

/** the path is the folder or inside it */
export const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/** a folder too wide to open to another device: the disk, /Users, /Volumes, the home folder or anything above it */
export function tooWide(root: string, home: string): boolean {
  const h = normPath(home, home) ?? home;
  if (windowsHome(home)) return root.endsWith("/") || under(h.toLowerCase(), root.toLowerCase());
  return root === "/" || root === "/Users" || root === "/Volumes" || root === "/private" || root === "/tmp" || under(h, root);
}

/** the folders another device may reach, cleaned up: the wide ones dropped, the same one once */
export function cleanRoots(roots: (string | undefined)[], home: string): string[] {
  const out = new Set<string>();
  for (const r of roots) {
    const n = r ? normPath(r, home) : undefined;
    if (n && !tooWide(n, home)) out.add(n);
  }
  return [...out];
}

/** The absolute path, when it is inside one of the folders (or one of the named files); else undefined. */
export function allowedPath(p: string, roots: string[], home: string, named: (abs: string) => boolean = () => false): string | undefined {
  const abs = normPath(p, home);
  if (!abs) return undefined;
  // Only the lexical filter folds case. The host still compares canonical paths exactly
  // so a case-sensitive Windows directory cannot grant access to its differently cased sibling.
  const win = windowsHome(home);
  return roots.some((r) => win ? under(abs.toLowerCase(), r.toLowerCase()) : under(abs, r)) || named(abs) ? abs : undefined;
}

/** The text names that path as a whole: not as the start of a longer one ("/a/b.png" in "/a/b.png.bak"
 *  doesn't count). Ends may be a line number ("/a/b.ts:12"), a quote, a bracket or a space. */
export function mentions(text: string, abs: string): boolean {
  for (let i = text.indexOf(abs); i >= 0; i = text.indexOf(abs, i + 1)) {
    const before = i ? text[i - 1] : " ";
    const after = text[i + abs.length] ?? " ";
    if (/[\s"'`(<[{]/.test(before) && /[\s"'`)>\]},:;!?]/.test(after)) return true;
    // a sentence's full stop right after it
    if (/[\s"'`(<[{]/.test(before) && after === "." && /^\.(\s|$)/.test(text.slice(i + abs.length, i + abs.length + 2))) return true;
  }
  return false;
}

/** a path inside a repo, as git takes it: relative, without ".." */
export function repoPath(p: string, home = ""): string | undefined {
  if (typeof p !== "string") return undefined;
  if (windowsHome(home)) {
    p = p.replace(/\\/g, "/");
    if (p.split("/").some((part) => !winPart(part))) return undefined;
  }
  if (!p || p.startsWith("/") || p.includes("\0")) return undefined;
  return p.split("/").some((x) => x === "..") ? undefined : p;
}

/** A path as the other Mac reads it: this Mac's home turned back into "~" (it has its own). */
export function asHostPath(p: string, myHome: string): string {
  if (windowsHome(myHome) && windowsHome(p)) {
    const h = normPath(myHome, myHome);
    const abs = normPath(p, myHome);
    return abs && h && under(abs, h) ? `~${abs.slice(h.length)}` : p;
  }
  const h = myHome.replace(/\/+$/, "");
  if (!h || !p) return p;
  return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/** What a Windows host calls its path in the mirror. POSIX senders stay byte-for-byte unchanged. */
export function mirrorPath(path: string, home: string): string {
  if (!windowsHome(home)) return path;
  const p = normPath(path, home);
  return !p ? path : p.startsWith("//") ? SHARE + p.slice(2) : DRIVE + p[0] + p.slice(2);
}

/** Rust canonicalize uses a verbatim prefix on Windows. Strip it only on a trusted native result. */
export function realPath(path: string | null, home: string): string | undefined {
  if (!path) return undefined;
  if (!windowsHome(home)) return path.startsWith("/") ? path : undefined;
  return normPath(path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\(?=[A-Za-z]:\\)/, ""), home);
}

/** a file from another device, as this Mac caches it: one name per Mac, path and version */
export function cacheName(host: string, path: string, modified: number): string {
  let h = 2166136261;
  const s = `${host}\n${path}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(path)?.[1]?.toLowerCase() ?? "bin";
  return `${(h >>> 0).toString(36)}-${modified.toString(36)}.${ext}`;
}

/** A picked file's name in the sender's filesystem (backslashes can be part of a Mac filename). */
export const uploadBase = (path: string, home: string) => path.split(windowsHome(home) ? /[/\\]/ : "/").pop() || "file";

/** A name for a file sent to another device: unique, and still readable ("shot.png" stays in it). */
export function uploadName(path: string, stamp: number, rand: string): string {
  const base = (path.split("/").pop() ?? "file").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+|\.+$/g, "").slice(-80) || "file";
  return `${stamp.toString(36)}-${rand}-${base}`;
}

/** Cut text to at most `max` UTF-8 bytes, at a line end when there is one: what is kept, and if it was cut. */
export function capText(text: string, max: number): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return { text, cut: false };
  let s = new TextDecoder().decode(bytes.slice(0, max));
  // the last character may have been split
  s = s.replace(/�$/, "");
  const nl = s.lastIndexOf("\n");
  return { text: nl > 0 ? s.slice(0, nl + 1) : s, cut: true };
}

// ───────── a page of another device, with what it uses

/** the files a page may use that are read for more of them (a page, its styles, its scripts, a drawing) */
export const scanKind = (path: string): "html" | "css" | "js" | undefined => {
  const ext = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
  return ext === "html" || ext === "htm" || ext === "svg" || ext === "xhtml" ? "html" : ext === "css" ? "css" : ext === "js" || ext === "mjs" ? "js" : undefined;
};

const CSS_REFS = [/url\(\s*["']?([^"')\s]+)["']?\s*\)/g, /@import\s+["']([^"']+)["']/g];
const JS_REFS = [
  /\b(?:import|export)\s[^"'`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bfetch\(\s*["']([^"']+)["']/g,
  /\bnew\s+(?:URL|Worker)\(\s*["']([^"']+)["']/g,
];
const HTML_REFS = [/\b(?:src|href|poster|data|xlink:href)\s*=\s*["']([^"']+)["']/gi, /\b(?:src|href|poster)\s*=\s*([^\s"'>]+)/gi];

/** The relative links in a page, a style sheet or a script (anything with a scheme, an anchor or a
 *  template left out): what it needs next to it to show as it does there. */
export function pageRefs(text: string, kind: "html" | "css" | "js"): string[] {
  const out: string[] = [];
  const take = (res: RegExp[], s: string) => {
    for (const re of res) for (const m of s.matchAll(re)) out.push(m[1]);
  };
  if (kind === "css") take(CSS_REFS, text);
  else if (kind === "js") take(JS_REFS, text);
  else {
    take(HTML_REFS, text);
    for (const m of text.matchAll(/\bsrcset\s*=\s*["']([^"']+)["']/gi)) for (const part of m[1].split(",")) out.push(part.trim().split(/\s+/)[0] ?? "");
    // inline styles and module scripts
    take(CSS_REFS, text);
    for (const m of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) take(JS_REFS, m[1]);
  }
  const keep = (r: string) => !!r && !/^[a-z][a-z0-9+.-]*:/i.test(r) && !r.startsWith("//") && !r.startsWith("#") && !r.startsWith("/") && !/[{}$<>`]/.test(r);
  return [...new Set(out.map((r) => r.trim()).filter(keep))];
}

/** `ref` (relative, as written in a file in `dir`) as a path on that device; undefined when it isn't one */
export function resolveRef(dir: string, ref: string): string | undefined {
  let r = ref.replace(/[?#].*$/, "");
  try {
    r = decodeURIComponent(r);
  } catch {
    return undefined;
  }
  if (!r || r.includes("\0")) return undefined;
  const parts = dir.split("/");
  for (const seg of r.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length <= 1) return undefined;
      parts.pop();
    } else parts.push(seg);
  }
  const p = parts.join("/");
  return p.startsWith("/") || p.startsWith("~") ? p : undefined;
}

/** where a file of that device goes in the page copies here: the same layout, under that device's own folder */
export function siteName(host: string, path: string): string {
  let h = 2166136261;
  for (let i = 0; i < host.length; i++) h = Math.imul(h ^ host.charCodeAt(i), 16777619);
  return `${(h >>> 0).toString(36)}/${path.replace(/^[/~]+/, "")}`;
}
