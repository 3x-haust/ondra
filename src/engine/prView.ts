// A pull request as the PR view shows it: header, checks, the conversation
// (comments, reviews, line threads in time order) and the changed files.
// Pure; the raw JSON comes from gh_pr_view.
import type { PrNote } from "./prWatch";

export type CheckState = "ok" | "bad" | "run" | "skip";
export interface PrCheck { name: string; state: CheckState; url?: string }
export interface PrLine { id: number; who: string; body: string; at: number; url?: string; reply?: number; path: string; line?: number; side?: string }
export interface PrThread { id: number; path: string; line?: number; side?: string; notes: PrLine[]; at: number }
export type PrItem =
  | { kind: "comment"; id: string; who: string; body: string; at: number }
  | { kind: "review"; id: string; who: string; body: string; at: number; state: string }
  | { kind: "thread"; thread: PrThread; at: number };
export interface PrView {
  url: string;
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  draft: boolean;
  conflict: boolean;
  base: string;
  head: string;
  author: string;
  decision: string;
  checks: PrCheck[];
  items: PrItem[];
  threads: PrThread[];
  files: { path: string; add: number; del: number }[];
  add: number;
  del: number;
  patch: string;
  cut: boolean;
  me: string;
}

const BAD = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR", "CANCELLED"]);
const SKIP = new Set(["SKIPPED", "NEUTRAL", "STALE"]);

function checkOf(c: Record<string, string>): PrCheck {
  const verdict = (c.conclusion || c.state || "").toUpperCase();
  const status = (c.status || "").toUpperCase();
  const state: CheckState =
    (status && status !== "COMPLETED") || ["PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED"].includes(verdict) ? "run" : BAD.has(verdict) ? "bad" : SKIP.has(verdict) ? "skip" : "ok";
  return { name: c.name || c.context || "check", state, url: c.detailsUrl || c.targetUrl || undefined };
}

/** line comments into threads: a reply joins its root */
export function threadsOf(lines: PrLine[]): PrThread[] {
  const byId = new Map<number, PrThread>();
  const out: PrThread[] = [];
  for (const l of [...lines].sort((a, b) => a.at - b.at)) {
    const root = l.reply ? byId.get(l.reply) : undefined;
    if (root) {
      root.notes.push(l);
      byId.set(l.id, root);
      continue;
    }
    const t: PrThread = { id: l.id, path: l.path, line: l.line, side: l.side, notes: [l], at: l.at };
    byId.set(l.id, t);
    out.push(t);
  }
  return out;
}

export function parsePrView(raw: string): PrView {
  const j = JSON.parse(raw);
  const pr = j.pr ?? {};
  const lines: PrLine[] = (j.lines ?? []).map((l: Record<string, any>) => ({
    id: Number(l.id),
    who: l.who ?? "",
    body: l.body ?? "",
    at: Date.parse(l.at) || 0,
    url: l.url ?? undefined,
    reply: l.reply ?? undefined,
    path: l.path ?? "",
    line: l.line ?? undefined,
    side: l.side ?? undefined,
  }));
  const threads = threadsOf(lines);
  const items: PrItem[] = [
    ...(pr.comments ?? []).map((c: Record<string, any>) => ({ kind: "comment" as const, id: String(c.id), who: c.author?.login ?? "", body: c.body ?? "", at: Date.parse(c.createdAt) || 0 })),
    // a review without words that only carries line comments shows as those threads
    ...(pr.reviews ?? [])
      .filter((r: Record<string, any>) => (r.body ?? "").trim() || r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")
      .map((r: Record<string, any>) => ({ kind: "review" as const, id: String(r.id), who: r.author?.login ?? "", body: r.body ?? "", at: Date.parse(r.submittedAt) || 0, state: r.state ?? "COMMENTED" })),
    ...threads.map((t) => ({ kind: "thread" as const, thread: t, at: t.at })),
  ].sort((a, b) => a.at - b.at);
  return {
    url: pr.url ?? "",
    number: pr.number ?? 0,
    title: pr.title ?? "",
    state: pr.state === "MERGED" || pr.state === "CLOSED" ? pr.state : "OPEN",
    draft: !!pr.isDraft,
    conflict: pr.mergeable === "CONFLICTING",
    base: pr.baseRefName ?? "",
    head: pr.headRefName ?? "",
    author: pr.author?.login ?? "",
    decision: pr.reviewDecision ?? "",
    checks: (pr.statusCheckRollup ?? []).map(checkOf),
    items,
    threads,
    files: (pr.files ?? []).map((f: Record<string, any>) => ({ path: f.path, add: f.additions ?? 0, del: f.deletions ?? 0 })),
    add: pr.additions ?? 0,
    del: pr.deletions ?? 0,
    patch: j.diff ?? "",
    cut: !!j.cut,
    me: j.me ?? "",
  };
}

/** a thread or comment from the view, in the shape the watch hands to a job */
export function noteOf(x: PrItem): PrNote[] {
  if (x.kind === "thread") {
    const t = x.thread;
    const last = t.notes[t.notes.length - 1];
    const body = t.notes.length > 1 ? t.notes.map((n) => `${n.who}: ${n.body}`).join("\n\n") : t.notes[0].body;
    return [{ id: `line:${last.id}`, kind: "line", who: t.notes[0].who, bot: false, body, at: last.at, path: t.path, line: t.line }];
  }
  return [{ id: x.id, kind: x.kind, who: x.who, bot: false, body: x.body, at: x.at, state: x.kind === "review" ? x.state : undefined }];
}

/** GitHub writes pictures as <img> tags; the app's markdown drops raw HTML, so turn them into markdown images */
export function githubBody(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<img\b[^>]*?src="([^"]+)"[^>]*>/gi, (tag, src) => `![${/alt="([^"]*)"/i.exec(tag)?.[1] ?? ""}](${src})`)
    .replace(/<\/?(details|summary|p|div|br|sub|sup)\b[^>]*>/gi, "\n")
    .trim();
}
