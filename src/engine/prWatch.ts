// Watching the pull requests jobs opened: what is new since the job last
// heard, and the message that hands it over. Pure; tasks.ts does the polling.
import type { PrWatch } from "../state/types";

export interface PrNote {
  id: string;
  kind: "comment" | "review" | "line";
  who: string;
  bot: boolean;
  body: string;
  at: number;
  state?: string;
  path?: string;
  line?: number;
}

export interface PrSnap {
  state: string;
  mergeable: string;
  head: string;
  me: string;
  checks: { name: string; bad: boolean; pending: boolean }[];
  notes: PrNote[];
}

export interface PrNews {
  notes: PrNote[];
  failed: string[];
  conflict: boolean;
}

const BAD = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "ERROR"]);
const PENDING = new Set(["PENDING", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "EXPECTED"]);
const isBot = (login: string) => /\[bot\]$|^(github-actions|vercel|netlify|codecov|changeset-bot|dependabot|renovate)/i.test(login);

/** The JSON gh_pr_state returns, made plain. */
export function parseSnap(raw: string): PrSnap {
  const j = JSON.parse(raw);
  const pr = j.pr ?? {};
  const checks = (pr.statusCheckRollup ?? []).map((c: Record<string, string>) => {
    const name = c.name || c.context || "check";
    const verdict = (c.conclusion || c.state || "").toUpperCase();
    const status = (c.status || "").toUpperCase();
    return { name, bad: BAD.has(verdict), pending: (!!status && status !== "COMPLETED") || PENDING.has(verdict) };
  });
  const notes: PrNote[] = [
    ...(pr.comments ?? []).map((c: Record<string, any>) => ({ id: String(c.id), kind: "comment" as const, who: c.author?.login ?? "", bot: isBot(c.author?.login ?? ""), body: c.body ?? "", at: Date.parse(c.createdAt) || 0 })),
    ...(pr.reviews ?? []).map((r: Record<string, any>) => ({ id: String(r.id), kind: "review" as const, who: r.author?.login ?? "", bot: isBot(r.author?.login ?? ""), body: r.body ?? "", at: Date.parse(r.submittedAt) || 0, state: r.state })),
    ...(j.lines ?? []).map((l: Record<string, any>) => ({ id: `line:${l.id}`, kind: "line" as const, who: l.who ?? "", bot: !!l.bot || isBot(l.who ?? ""), body: l.body ?? "", at: Date.parse(l.at) || 0, path: l.path, line: l.line ?? undefined })),
  ];
  return { state: pr.state ?? "", mergeable: pr.mergeable ?? "", head: pr.headRefOid ?? "", me: j.me ?? "", checks, notes };
}

/** What a job should hear about now: new reviews and comments from others, failed checks once everything has run, a new conflict. */
export function prNews(w: PrWatch, s: PrSnap): PrNews {
  const notes = s.notes.filter((n) => {
    if (w.seen.includes(n.id) || n.at < w.since) return false;
    if (s.me && n.who === s.me) return false;
    // deploy previews and coverage bots talk in plain comments; review bots leave reviews and line comments
    if (n.bot && n.kind === "comment") return false;
    if (n.kind === "review") return n.state === "CHANGES_REQUESTED" || !!n.body.trim();
    return !!n.body.trim();
  });
  const settled = s.checks.length > 0 && !s.checks.some((c) => c.pending);
  const failed = settled ? s.checks.filter((c) => c.bad).map((c) => `${c.name}@${s.head}`).filter((k) => !w.failed.includes(k)) : [];
  return { notes, failed, conflict: s.mergeable === "CONFLICTING" && !w.conflict };
}

export const hasNews = (n: PrNews) => n.notes.length > 0 || n.failed.length > 0 || n.conflict;

/** At most this many wake-ups a day for one PR, so a push that fails again can't keep a job looping. */
export const WAKES_PER_DAY = 6;
export const canWake = (w: PrWatch, now = Date.now()) => w.wakes.filter((t) => now - t < 86_400_000).length < WAKES_PER_DAY;

const clip = (s: string, n = 1500) => {
  const t = s.replace(/<!--[\s\S]*?-->/g, "").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** The message the job gets. */
export function wakeText(url: string, n: PrNews): string {
  const repo = url.replace(/^https:\/\/github\.com\//, "").replace(/\/pull\/\d+.*$/, "");
  const num = url.match(/\/pull\/(\d+)/)?.[1] ?? "";
  const lines = [`PR에 새로 온 것이 있어요: ${url}`, ""];
  for (const x of n.notes) {
    if (x.kind === "line") lines.push(`- 리뷰 코멘트 (id ${x.id.slice(5)}, ${x.who}, ${x.path}${x.line ? `:${x.line}` : ""}):\n${quote(clip(x.body))}`);
    else if (x.kind === "review") lines.push(`- 리뷰 (${x.who}${x.state === "CHANGES_REQUESTED" ? ", 수정 요청" : ""}):${x.body.trim() ? `\n${quote(clip(x.body))}` : ""}`);
    else lines.push(`- 코멘트 (${x.who}):\n${quote(clip(x.body))}`);
  }
  if (n.failed.length) lines.push(`- 실패한 검사: ${[...new Set(n.failed.map((k) => k.replace(/@[^@]*$/, "")))].join(", ")}`);
  if (n.conflict) lines.push("- 기본 브랜치와 충돌이 나요");
  lines.push(
    "",
    "고칠 것은 이 PR 브랜치에서 고치고 푸시해요. 리뷰 코멘트에는 그 스레드에 답해요" +
      ` (\`gh api repos/${repo}/pulls/${num}/comments/<id>/replies -f body=...\`, 화면이 바뀌었으면 \`pr-media.sh --reply\`로 바뀐 화면을 붙여요).` +
      " 일반 코멘트에는 `gh pr comment`로 답해요. 질문이거나 동의하지 않는 지적은 고치지 말고 이유를 답해요." +
      " 이 PR과 관계없는 원인으로 실패한 검사는 다시 돌리고 그렇게 적어요.",
  );
  return lines.join("\n");
}

const quote = (s: string) => s.split("\n").map((l) => `  > ${l}`).join("\n");

/** Short line shown in place of the long message when it starts a new job. */
export function wakeTitle(url: string, n: PrNews): string {
  const num = url.match(/\/pull\/(\d+)/)?.[1] ?? "";
  const parts = [n.notes.length ? `리뷰·코멘트 ${n.notes.length}개` : "", n.failed.length ? "검사 실패" : "", n.conflict ? "충돌" : ""].filter(Boolean);
  return `PR #${num}에 ${parts.join(", ")}`;
}
