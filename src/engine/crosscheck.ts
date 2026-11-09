// 교차 검토: a job's one review runs as two read-only lenses side by side
// (설계 검토 and 코드 검토, the code-review skill). The job gets one combined
// result once both are over; a lens that failed is named, it doesn't block.
import { state, uid } from "../state/store";
import type { Task } from "../state/types";

export const CROSSCHECK = "교차 검토";

export const LENSES = [
  {
    lens: "design",
    title: "설계 검토",
    how: "Use the code-review skill with the 설계 검토 (design) lens: does the approach solve the user's whole problem end to end, and does it fit the project's architecture, decisions and memory. The 코드 검토 lens reviews the same change beside you; don't do its job.",
  },
  {
    lens: "code",
    title: "코드 검토",
    how: "Use the code-review skill with the 코드 검토 (code) lens: contracts, data and control flow, realistic edge cases, failure paths, tests against what is claimed. The 설계 검토 lens reviews the same change beside you; don't do its job.",
  },
] as const;

/** The two lens subagents one review block starts: the job's requirement, each with its lens and the memory the job was given. */
export function lensKids(job: Task, ask: string): { title: string; ask: string; extra: Partial<Task> }[] {
  const pair = uid("x");
  const what = ask.replace(/^\s*use the code-review skill[.:]?\s*/i, "").trim() || ask;
  return LENSES.map((l) => ({ title: l.title, ask: `${l.how}\n\n${what}`, extra: { lens: l.lens, pair, memorySnapshot: job.memorySnapshot ?? [] } }));
}

const active = (x: Task) => x.status === "queued" || x.status === "running" || x.status === "waiting";

/** both lenses of the review this one belongs to (just itself for a single, older review) */
export const lensesOf = (k: Task): Task[] => (k.pair ? state.tasks.filter((x) => x.parentId === k.parentId && x.pair === k.pair) : [k]);
export const reviewName = (k: Task) => (k.pair ? CROSSCHECK : k.title);
/** a lens of it still works */
export const reviewGoing = (k: Task) => lensesOf(k).some(active);

/** A review that is over: one lens (or a single review) done, and no lens of it still going. */
export function reviewSettled(kids: Task[]): boolean {
  return kids.some((k) => k.review && k.status === "done" && !(k.pair && kids.some((o) => o.pair === k.pair && active(o))));
}

const missing = (k?: Task) => (!k ? "시작 안 됨" : k.status === "failed" ? `실패 — ${k.error ?? "알 수 없는 오류"}` : k.status === "done" ? "" : "끝나지 않음");

/** What each lens found, one section per lens; a lens that didn't finish says so. */
export function lensText(group: Task[]): string {
  if (group.length === 1 && !group[0].pair) return group[0].result ?? group[0].summary ?? "";
  return LENSES.map((l) => {
    const k = group.find((x) => x.lens === l.lens);
    const why = missing(k);
    return `# ${l.title}\n${why ? `(빠졌어요: ${why})` : (k!.result ?? k!.summary ?? "(적은 게 없어요)").trim()}`;
  }).join("\n\n");
}

type Finding = { p: number; path: string; line?: number };

/** "- P1 `src/a.ts:12` — …" lines of a lens's result */
export function findingsIn(text: string): Finding[] {
  const out: Finding[] = [];
  for (const l of text.split("\n")) {
    const m = /^\s*(?:[-*]\s*)?\**P([123])\b[^`\n]*`([^`\s]+?)(?::(\d+)(?:[-–]\d+)?)?`/.exec(l);
    if (m) out.push({ p: Number(m[1]), path: m[2].replace(/^\.\//, ""), line: m[3] ? Number(m[3]) : undefined });
  }
  return out;
}

/** The same place, judged differently: one lens calls it P1/P2, the other a different level. */
export function disagreements(design: string, code: string): string[] {
  const near = (a: Finding, b: Finding) => a.path === b.path && (a.line == null || b.line == null || Math.abs(a.line - b.line) <= 3);
  const out = new Set<string>();
  for (const d of findingsIn(design))
    for (const c of findingsIn(code))
      if (near(d, c) && d.p !== c.p && Math.min(d.p, c.p) <= 2) out.add(`- \`${d.path}${d.line ? `:${d.line}` : ""}\` — 설계 P${d.p} · 코드 P${c.p}`);
  return [...out];
}

/** What the job does with a review's findings. */
export const REVIEW_FIX =
  "P1·P2만 고쳐 줘. P3는 고치지 말고 done의 unverified나 메모에 적기만 해. 고친 뒤에는 그 부분을 다루는 테스트만 다시 돌려(전체 검사·리뷰를 다시 돌리지 말고, 앞에서 통과한 게 그대로 유효하니 다시 안 돌린 걸 unverified에 적지도 마). 그다음 계획에 남은 단계(설치, 사진, 올리기처럼 맡은 일에 있던 것)를 이어서 하고 끝내. 고칠 게 없으면 바로 남은 단계로 넘어가.";

/**
 * The one message the job gets when both lenses are over: each lens's findings,
 * where they disagree (on code and on memory), what memory the check settled, and
 * how to settle a disagreement (one targeted check, not another review).
 */
export function crosscheckMessage(group: Task[], memory: { lines: string[]; split: string[] }): string {
  const done = group.filter((k) => k.status === "done");
  if (!done.length) {
    const why = LENSES.map((l) => `${l.title}: ${missing(group.find((x) => x.lens === l.lens))}`).join(" · ");
    return `${CROSSCHECK}가 두 관점 모두 실패했어요 (${why}). 리뷰를 한 번 다시 띄워도 돼요.`;
  }
  const text = (lens: string) => group.find((k) => k.lens === lens && k.status === "done")?.result ?? "";
  const both = done.length === LENSES.length;
  const split = both ? [...disagreements(text("design"), text("code")), ...memory.split] : [];
  const gone = LENSES.filter((l) => !done.some((k) => k.lens === l.lens)).map((l) => l.title);
  return [
    `${CROSSCHECK} 결과가 왔어요 (${LENSES.map((l) => l.title).join(" · ")}):`,
    "",
    lensText(group),
    ...(both ? ["", "# 두 검토가 갈리는 곳", ...(split.length ? split : ["- 같은 곳을 다르게 본 지적은 없어요."])] : []),
    ...(memory.lines.length ? ["", "# 메모리 확인", ...memory.lines] : []),
    "",
    ...(gone.length ? [`${gone.join(", ")}는 빠졌어요: 다시 띄우지 말고 done의 unverified에 "${gone.join(", ")} 빠짐"이라고 적어.`] : []),
    ...(both
      ? ["두 검토가 갈리는 곳은 리뷰를 다시 띄우지 말고, 그 지점 하나만 직접 확인해서(그 코드 한 곳 읽기, 그 테스트 하나 돌리기) 증거가 맞는 쪽으로 정해. 두 검토가 같은 문제를 짚었으면 한 번만 고쳐."]
      : []),
    REVIEW_FIX,
  ].join("\n");
}

/** One line for the resume summary: the pair as one review. */
export function crosscheckLine(group: Task[], clip: (s: string, n: number) => string): string {
  const where = LENSES.map((l) => `${l.title} ${group.find((x) => x.lens === l.lens)?.status ?? "missing"}`).join(", ");
  if (group.some(active)) return `- review "${CROSSCHECK}": still running (${where}). Its combined result comes to you by itself; don't start it again and never ask the user for it.`;
  if (!group.some((k) => k.status === "done")) return `- review "${CROSSCHECK}": failed (${clip(lensText(group).replace(/\s+/g, " "), 300)})`;
  return `- review "${CROSSCHECK}": done (${where}).\n${clip(lensText(group), 4000)}`;
}
