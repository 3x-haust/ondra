// Which files another Mac may reach on this one (Settings › 연결): only what lies inside the
// folders of the projects it added and of the jobs it sees (their folders, worktrees and
// result folders), or a file one of those jobs named itself (a screenshot in its reply).
// Never the disk at large: a folder as wide as the home folder doesn't count.
// Pure, so it can be tested; engine/farHost.ts applies it.

/** "~/x", "file:///x", "/a/./b/../c" → one absolute path; undefined when it isn't one */
export function normPath(p: string, home: string): string | undefined {
  if (typeof p !== "string" || !p || p.includes("\0")) return undefined;
  let s = p.trim();
  if (s.startsWith("file://")) {
    try {
      s = decodeURI(s.slice(7));
    } catch {
      return undefined;
    }
  }
  if (s === "~" || s.startsWith("~/")) s = home.replace(/\/+$/, "") + s.slice(1);
  if (!s.startsWith("/")) return undefined;
  const out: string[] = [];
  for (const part of s.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return undefined;
      out.pop();
    } else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** the path is the folder or inside it */
export const under = (p: string, root: string) => p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);

/** a folder too wide to open to another Mac: the disk, /Users, /Volumes, the home folder or anything above it */
export function tooWide(root: string, home: string): boolean {
  const h = normPath(home, home) ?? home;
  return root === "/" || root === "/Users" || root === "/Volumes" || root === "/private" || root === "/tmp" || under(h, root);
}

/** the folders another Mac may reach, cleaned up: the wide ones dropped, the same one once */
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
  return roots.some((r) => under(abs, r)) || named(abs) ? abs : undefined;
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
export function repoPath(p: string): string | undefined {
  if (typeof p !== "string" || !p || p.startsWith("/") || p.includes("\0")) return undefined;
  return p.split("/").some((x) => x === "..") ? undefined : p;
}

/** A path as the other Mac reads it: this Mac's home turned back into "~" (it has its own). */
export function asHostPath(p: string, myHome: string): string {
  const h = myHome.replace(/\/+$/, "");
  if (!h || !p) return p;
  return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/** a file from another Mac, as this Mac caches it: one name per Mac, path and version */
export function cacheName(host: string, path: string, modified: number): string {
  let h = 2166136261;
  const s = `${host}\n${path}`;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(path)?.[1]?.toLowerCase() ?? "bin";
  return `${(h >>> 0).toString(36)}-${modified.toString(36)}.${ext}`;
}

/** A name for a file sent to another Mac: unique, and still readable ("shot.png" stays in it). */
export function uploadName(path: string, stamp: number, rand: string): string {
  const base = (path.split("/").pop() ?? "file").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "").slice(-80) || "file";
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
