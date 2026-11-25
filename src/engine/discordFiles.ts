// Links to files and folders on this Mac in what goes to Discord ("[테스트 빌드 폴더](file:///…)"):
// Discord can't open a file:// link, so a file goes up with the message (to download), and a
// folder, or a file too big to send, becomes a button that shows it in Finder on this Mac.
import { fsRead } from "../lib/native";
import { expand } from "./rpc";

/** what Discord takes from a bot without a boosted server, with room to spare */
export const SEND_MAX = 9 * 1024 * 1024;
const OPEN = "ondra:open:";

/** a link's target as a path on this Mac, or undefined for anything else (a web page, an anchor) */
export function localPath(target: string): string | undefined {
  const t = target.trim().replace(/^<|>$/g, "");
  if (/^file:\/\//i.test(t)) {
    try {
      return decodeURI(t.replace(/^file:\/\/(localhost)?/i, ""));
    } catch {
      return t.replace(/^file:\/\/(localhost)?/i, "");
    }
  }
  return /^(\/|~\/)/.test(t) ? expand(t) : undefined;
}

type Kind = "file" | "big" | "folder" | "none";
/** a file (small enough to send), a big file, a folder, or nothing there */
async function kindOf(path: string): Promise<Kind> {
  try {
    const f = await fsRead(path);
    return f.size > SEND_MAX ? "big" : "file";
  } catch (e) {
    return /directory|os error 21/i.test(String(e instanceof Error ? e.message : e)) ? "folder" : "none";
  }
}

const home = (p: string) => p.replace(/^\/Users\/[^/]+/, "~");
const nameOf = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;

export type Local = { text: string; files: string[]; open: { label: string; path: string }[] };

/**
 * The words with their links to this Mac's files and folders taken out: files to send with them,
 * places to open with a button, and a path that isn't there left as its name and path in code.
 */
export async function localLinks(text: string, kind: (p: string) => Promise<Kind> = kindOf): Promise<Local> {
  const found: { all: string; label: string; path: string; pic?: boolean }[] = [];
  // a picture ("![](/tmp/board.png)") goes up as well, and its words go away
  for (const m of text.matchAll(/(!?)\[([^\]\n]*)\]\(\s*(<[^>]+>|[^)\s]+)\s*\)/g)) {
    const path = localPath(m[3]);
    if (path && (m[1] || m[2])) found.push({ all: m[0], label: m[2] || nameOf(path), path, pic: !!m[1] });
  }
  for (const m of text.matchAll(/(?<![(<\w])file:\/\/[^\s)>\]]+/gi)) {
    const path = localPath(m[0]);
    if (path) found.push({ all: m[0], label: nameOf(path), path });
  }
  const out: Local = { text, files: [], open: [] };
  for (const f of found) {
    const k = await kind(f.path);
    let said = f.label;
    if (k === "file" && out.files.length < 4) {
      out.files.push(f.path);
      if (f.pic) said = "";
    }
    else if (k === "none") said = `${f.label} (\`${home(f.path)}\`)`;
    else if (out.open.length < 5) out.open.push({ label: f.label, path: f.path });
    else said = `${f.label} (\`${home(f.path)}\`)`;
    out.text = out.text.replace(f.all, said);
  }
  if (found.some((f) => f.pic)) out.text = out.text.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

/** the places its buttons open, by key (kept while Ondra runs) */
const places = new Map<string, string>();

/** a row of buttons, one per place: a click shows it in Finder on this Mac */
export function openRow(open: Local["open"]): unknown[] {
  if (!open.length) return [];
  const buttons = open.slice(0, 5).map((o) => {
    const key = Math.random().toString(36).slice(2, 10);
    places.set(key, o.path);
    if (places.size > 300) places.delete(places.keys().next().value!);
    return { type: 2, style: 2, emoji: { name: "📂" }, label: o.label.slice(0, 80), custom_id: `${OPEN}${key}` };
  });
  return [{ type: 1, components: buttons }];
}

/** the place a click on one of those buttons is for (undefined: not one, or from before a restart) */
export const openClick = (customId?: string): { path?: string } | undefined => (customId?.startsWith(OPEN) ? { path: places.get(customId.slice(OPEN.length)) } : undefined);
