// 루틴의 GitHub 사건: what `gh` printed for one kind of event, made into plain items, and which of
// them are new since the routine last looked. Pure; routines.ts does the polling (gh_watch).
import type { Routine, RoutineEvent } from "../state/types";

export interface RepoEvent {
  /** stable across polls: "issue#12", "comment:IC_kw…", "run:123" */
  id: string;
  title: string;
  url?: string;
  who?: string;
  at: number;
  /** a short body, for the run's message */
  body?: string;
}

const time = (v: unknown) => {
  const n = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : 0;
};
const login = (a: any) => (typeof a?.login === "string" ? a.login : undefined);
const clip = (s: unknown, n = 600) => (typeof s === "string" ? s.trim().slice(0, n) : undefined);

/** gh's JSON for one event kind → items, oldest first. Unknown shapes give nothing. */
export function parseEvents(event: RoutineEvent, raw: string): RepoEvent[] {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return [];
  }
  const list: any[] = Array.isArray(j) ? j : [];
  const out: RepoEvent[] = [];
  for (const x of list) {
    if (!x || typeof x !== "object") continue;
    if (event === "issue" || event === "pr" || event === "review") {
      if (typeof x.number !== "number") continue;
      if (event === "pr" && x.isDraft) continue;
      out.push({ id: `${event}#${x.number}`, title: `#${x.number} ${x.title ?? ""}`.trim(), url: x.url, who: login(x.author), at: time(x.createdAt), body: clip(x.body) });
    } else if (event === "comment") {
      // my open PRs with their comments and reviews: each comment or review is one item
      const pr = `#${x.number} ${x.title ?? ""}`.trim();
      for (const c of [...(x.comments ?? []), ...(x.reviews ?? [])]) {
        const id = c?.id ?? c?.url;
        if (!id) continue;
        // a bare approval or a review with no words is still news; my own words are not
        if (login(c.author) && login(c.author) === x.me) continue;
        out.push({ id: `comment:${id}`, title: pr, url: c.url ?? x.url, who: login(c.author), at: time(c.createdAt ?? c.submittedAt), body: clip(c.body) || (c.state ? String(c.state) : undefined) });
      }
    } else if (event === "ci") {
      // only finished runs that failed (a running one has no conclusion yet)
      if (!["failure", "timed_out", "startup_failure"].includes(x.conclusion)) continue;
      const id = x.databaseId ?? x.url;
      if (!id) continue;
      out.push({ id: `run:${id}`, title: `${x.workflowName ?? "CI"} · ${x.displayTitle ?? ""}`.trim(), url: x.url, at: time(x.createdAt), body: x.headBranch ? `branch ${x.headBranch}` : undefined });
    } else if (event === "release") {
      if (x.isDraft || !x.tagName) continue;
      out.push({ id: `release:${x.tagName}`, title: x.name || x.tagName, url: x.url, at: time(x.publishedAt ?? x.createdAt) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** A filter typed for a routine: GitHub search words for issues and PRs, else words the title must hold. */
export const searchFilter = (event: RoutineEvent) => event === "issue" || event === "pr" || event === "review";

export function matches(e: RepoEvent, event: RoutineEvent, filter?: string): boolean {
  const f = filter?.trim().toLowerCase();
  if (!f || searchFilter(event)) return true;
  return f.split(/\s+/).every((w) => `${e.title} ${e.body ?? ""}`.toLowerCase().includes(w));
}

export const SEEN_MAX = 500;

/**
 * What is new for a routine: items after it started looking that it hasn't handed over yet.
 * The first look only marks what is there (nothing fires for what existed before the routine).
 */
export function newEvents(r: Pick<Routine, "seen" | "since" | "when">, items: RepoEvent[], now: number): { fresh: RepoEvent[]; seen: string[]; since: number } {
  const event = r.when.kind === "event" ? r.when : undefined;
  if (r.since === undefined) return { fresh: [], seen: items.map((e) => e.id).slice(-SEEN_MAX), since: now };
  const seen = new Set(r.seen ?? []);
  const fresh = items.filter((e) => !seen.has(e.id) && e.at >= r.since! - 60_000 && (!event || matches(e, event.event, event.filter)));
  const next = [...(r.seen ?? []), ...items.filter((e) => !seen.has(e.id)).map((e) => e.id)].slice(-SEEN_MAX);
  return { fresh, seen: next, since: r.since };
}

/** The part of a run's message that says what happened. */
export function eventText(fresh: RepoEvent[]): string {
  return fresh
    .slice(0, 20)
    .map((e) => [`- ${e.title}${e.who ? ` (@${e.who})` : ""}${e.url ? ` ${e.url}` : ""}`, e.body ? `  > ${e.body.replace(/\n+/g, " ").slice(0, 300)}` : ""].filter(Boolean).join("\n"))
    .join("\n")
    .concat(fresh.length > 20 ? `\n- … ${fresh.length - 20} more` : "");
}
