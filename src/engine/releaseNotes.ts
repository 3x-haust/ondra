// What changed in each version, from GitHub Releases. After an update, the first
// launch of the new version shows its notes once (a fresh install shows nothing).
import { createSignal } from "solid-js";

export interface ReleaseEntry { version: string; date?: number; notes: string; url: string }

const REPO = "3x-haust/ondra";
const CACHE = "ondra.releases";
const LAST_RUN = "ondra.lastRunVersion";

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private storage off */ } };

const cached = (): ReleaseEntry[] => { try { return JSON.parse(read(CACHE) ?? "[]"); } catch { return []; } };
const [releases, setReleases] = createSignal<ReleaseEntry[]>(cached());
const [loading, setLoading] = createSignal(false);
const [failed, setFailed] = createSignal(false);
/** the version the notes sheet opens at ("" for the newest); null when closed */
const [notesFor, setNotesFor] = createSignal<string | null>(null);
export { failed as releasesFailed, loading as releasesLoading, notesFor, releases, setNotesFor };

/** a.b.c is newer than x.y.z */
export function newer(a: string, b: string): boolean {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

export async function loadReleases(): Promise<ReleaseEntry[]> {
  if (loading()) return releases();
  setLoading(true);
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=30`, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) throw new Error(String(res.status));
    const list = ((await res.json()) as any[])
      .filter((r) => !r.draft && !r.prerelease)
      .map((r): ReleaseEntry => ({
        version: String(r.tag_name).replace(/^v/, ""),
        date: r.published_at ? Date.parse(r.published_at) : undefined,
        notes: String(r.body ?? "").trim(),
        url: String(r.html_url),
      }));
    setReleases(list);
    setFailed(false);
    write(CACHE, JSON.stringify(list));
  } catch {
    setFailed(!releases().length);
  } finally {
    setLoading(false);
  }
  return releases();
}

/** At launch: the first run of a newer version than last time shows what's new in it. */
export async function afterLaunch(current: string) {
  if (!current) return;
  const last = read(LAST_RUN);
  write(LAST_RUN, current);
  if (!last || !newer(current, last)) return;
  const list = await loadReleases();
  if (list.some((r) => r.version === current && r.notes)) setNotesFor(current);
}
