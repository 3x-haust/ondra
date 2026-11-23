// 교차 검토: a job's one review runs as two read-only lenses side by side
// (설계 검토 and 코드 검토, the code-review skill). The job gets one combined
// result once both are over; a lens that failed is named, it doesn't block.
import { state, uid } from "../state/store";
import type { Reviewer, SpaceId, Task } from "../state/types";

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

export const PLAN_REVIEW = "계획 검토";

// what both plan readers are, and how they answer
const FRESH =
  "You read a plan as a newcomer, not its author: you have the requirement, the plan below and the repository, not the conversation that produced them. Read only; change nothing.";
const PLAN_OUT =
  "Answer with findings, most serious first, one line each: `- P1|P2|P3 <section or \`path:line\`> — <what's wrong> → <what to change>`. P1: it would build the wrong thing or break something; P2: a gap the builder would trip on; P3: worth a line. Asking for more than the requirement needs (extra guarantees, states, checks, safety or structure) is never P1 or P2. For a mockup, a draft or a temporary page, only what would show the user the wrong thing counts. A choice only the user can make (a trade-off, not a fact you could check) goes on its own line as `- 질문: …`. Nothing to fix: say so in one line.";

/** 계획 검토: two fresh readers of a plan before anything is built. */
const PLAN_LENSES = [
  {
    lens: "scope",
    title: "범위 검토",
    how: `${FRESH} Check it from above: does it solve the root problem the requirement states, not a symptom; is any part not needed now (options, abstractions, config, caching, structure "for later"); does the code already have something that does a part of it (search before you say so, and name the file); does a choice box the project in. Whether names and steps match the code is the other reader's job. ${PLAN_OUT}`,
  },
  {
    lens: "fit",
    title: "실행 검토",
    how: `${FRESH} First write, in your own words, what the plan proposes and how the existing code works (2–4 sentences each): the author compares it with what they meant, so a wrong paraphrase is a finding. Then check it against the code: every file, function, command or table it says exists does, and works as it says (read it); every step says what changes where, so the builder never has to make a design decision; open choices (data shape, errors, migration, what happens to existing data and users) are named. A file it says it will create is not a finding. Scope and reuse are the other reader's job. ${PLAN_OUT}`,
  },
] as const;

/** the two readers a plan_review block starts: the requirement and the plan, nothing else */
export function planKids(ask: string): { title: string; ask: string; extra: Partial<Task> }[] {
  const pair = uid("x");
  return PLAN_LENSES.map((l) => ({ title: l.title, ask: `${l.how}\n\n${ask}`, extra: { lens: l.lens, pair } }));
}

/** a lens of a plan review (not a code review) */
export const isPlan = (k: Task) => k.lens === "scope" || k.lens === "fit";
const setOf = (group: Task[]) => (group.some(isPlan) ? PLAN_LENSES : LENSES);

/**
 * Where one reviewer of Settings › 코드 리뷰 runs: its account when that is of the job's workspace,
 * else one of this workspace with the same provider; none that fits: left out.
 */
function placeOf(job: Task, r: Reviewer): Partial<Task> | undefined {
  const provider = r.model ? r.model.split("/")[0] : state.accounts.find((a) => a.id === r.account)?.providers[0];
  const here = state.accounts.filter((a) => a.space === job.space);
  const acct = here.find((a) => a.id === r.account) ?? (provider ? here.find((a) => a.providers.includes(provider)) : undefined);
  return acct ? { accountId: acct.id, ...(r.model ? { model: r.model } : {}), ...(r.thinking ? { thinking: r.thinking } : {}) } : undefined;
}

/** a model's short name, "gpt-6-astra" */
export const shortModel = (m?: string) => (m ? m.split("/").pop()! : "");

/**
 * The subagents one review block starts, as one review: each model of Settings › 코드 리뷰 reads
 * the change through both lenses (none set: the job's own model). Each gets the job's requirement,
 * its lens and the memory the job was given.
 */
/** the models that review a change in this workspace: its own list, else the shared one */
export function reviewersFor(space: SpaceId): Reviewer[] {
  const own = state.settings.reviewersBySpace?.[space];
  if (Array.isArray(own)) return own;
  return Array.isArray(state.settings.reviewers) ? state.settings.reviewers : [];
}

export function lensKids(job: Task, ask: string): { title: string; ask: string; extra: Partial<Task> }[] {
  const pair = uid("x");
  const what = ask.replace(/^\s*use the code-review skill[.:]?\s*/i, "").trim() || ask;
  const set = reviewersFor(job.space);
  const seen = new Set<string>();
  const places = set
    .map((r) => placeOf(job, r))
    .filter((p): p is Partial<Task> => !!p && !seen.has(`${p.accountId}|${p.model}`) && !!seen.add(`${p.accountId}|${p.model}`))
    .slice(0, 3);
  const many = places.length > 1;
  return (places.length ? places : [{}]).flatMap((p) =>
    LENSES.map((l) => ({
      title: many || p.model ? `${l.title} · ${shortModel(p.model ?? state.accounts.find((a) => a.id === p.accountId)?.model)}`.replace(/ · $/, "") : l.title,
      ask: `${l.how}${many ? " Other models review the same change through the same lens; the job merges what you all find, so just write yours." : ""}\n\n${what}`,
      extra: { lens: l.lens, pair, memorySnapshot: job.memorySnapshot ?? [], ...p },
    })),
  );
}

const active = (x: Task) => x.status === "queued" || x.status === "running" || x.status === "waiting";

/** both lenses of the review this one belongs to (just itself for a single, older review) */
export const lensesOf = (k: Task): Task[] => (k.pair ? state.tasks.filter((x) => x.parentId === k.parentId && x.pair === k.pair) : [k]);
export const reviewName = (k: Task) => (!k.pair ? k.title : isPlan(k) ? PLAN_REVIEW : CROSSCHECK);
/** a lens of it still works */
export const reviewGoing = (k: Task) => lensesOf(k).some(active);

/** A review that is over: one lens (or a single review) done, and no lens of it still going. */
export function reviewSettled(kids: Task[]): boolean {
  return kids.some((k) => k.review && k.status === "done" && !(k.pair && kids.some((o) => o.pair === k.pair && active(o))));
}

const missing = (k?: Task) => (!k ? "시작 안 됨" : k.status === "failed" ? `실패 — ${k.error ?? "알 수 없는 오류"}` : k.status === "done" ? "" : "끝나지 않음");

const said = (k?: Task) => {
  const why = missing(k);
  return why ? `(빠졌어요: ${why})` : (k!.result ?? k!.summary ?? "(적은 게 없어요)").trim();
};

/** the models that read a code review (one each, in order); a plan review or one model: one */
const modelsOf = (group: Task[]) => (group.some(isPlan) ? [] : [...new Set(group.map((k) => k.model ?? ""))]);

/** What each lens found, one section per lens (and in it, one per model when several read it); a lens or model that didn't finish says so. */
export function lensText(group: Task[]): string {
  if (group.length === 1 && !group[0].pair) return group[0].result ?? group[0].summary ?? "";
  const models = modelsOf(group);
  return setOf(group).map((l) => {
    if (models.length > 1)
      return [`# ${l.title}`, ...models.map((m) => `## ${shortModel(m) || "작업 모델"}\n${said(group.find((x) => x.lens === l.lens && (x.model ?? "") === m))}`)].join("\n");
    const k = group.find((x) => x.lens === l.lens);
    const by = k?.model && !isPlan(k) ? ` · ${shortModel(k.model)}` : "";
    return `# ${l.title}${by}\n${said(k)}`;
  }).join("\n\n");
}

type Finding = { p: number; path: string; line?: number };

/** "- P1 `src/a.ts:12` — …" lines of a lens's result */
function findingsIn(text: string): Finding[] {
  const out: Finding[] = [];
  for (const l of text.split("\n")) {
    const m = /^\s*(?:[-*]\s*)?\**P([123])\b[^`\n]*`([^`\s]+?)(?::(\d+)(?:[-–]\d+)?)?`/.exec(l);
    if (m) out.push({ p: Number(m[1]), path: m[2].replace(/^\.\//, ""), line: m[3] ? Number(m[3]) : undefined });
  }
  return out;
}

const near = (a: Finding, b: Finding) => a.path === b.path && (a.line == null || b.line == null || Math.abs(a.line - b.line) <= 3);
const at = (f: Finding) => `\`${f.path}${f.line ? `:${f.line}` : ""}\``;

/**
 * Several models on one review: the places two or more of them flagged (the surest findings), and the
 * places they rated differently (one calls it P1/P2, another a different level). Each model's
 * findings are both its lenses'.
 */
export function acrossModels(group: Task[]): { agree: string[]; split: string[] } {
  const by = modelsOf(group).map((m) => ({
    m: shortModel(m) || "작업 모델",
    f: findingsIn(group.filter((k) => (k.model ?? "") === m && k.status === "done").map((k) => k.result ?? "").join("\n")),
  }));
  const agree = new Set<string>();
  const split = new Set<string>();
  const taken = new Set<string>();
  for (let i = 0; i < by.length; i++)
    for (const a of by[i].f) {
      if (taken.has(`${i}|${at(a)}`)) continue;
      const others = by.flatMap((o, j) => (j === i ? [] : o.f.filter((b) => near(a, b)).slice(0, 1).map((b) => ({ m: o.m, b, j }))));
      if (!others.length) continue;
      others.forEach((o) => taken.add(`${o.j}|${at(o.b)}`));
      const line = `- ${at(a)} — ${[`${by[i].m} P${a.p}`, ...others.map((o) => `${o.m} P${o.b.p}`)].join(" · ")}`;
      const ps = [a.p, ...others.map((o) => o.b.p)];
      if (ps.every((p) => p === a.p)) agree.add(line);
      else if (Math.min(...ps) <= 2) split.add(line);
    }
  return { agree: [...agree], split: [...split] };
}

/** The same place, judged differently: one lens calls it P1/P2, the other a different level. */
export function disagreements(design: string, code: string): string[] {
  const out = new Set<string>();
  for (const d of findingsIn(design))
    for (const c of findingsIn(code))
      if (near(d, c) && d.p !== c.p && Math.min(d.p, c.p) <= 2) out.add(`- \`${d.path}${d.line ? `:${d.line}` : ""}\` — 설계 P${d.p} · 코드 P${c.p}`);
  return [...out];
}

/** What the job does with a review's findings. */
export const REVIEW_FIX =
  "P1·P2만 고쳐 줘. P3는 고치지 말고 done의 unverified나 메모에 적기만 해. 고친 뒤에는 그 부분을 다루는 테스트만 다시 돌려(전체 검사·리뷰를 다시 돌리지 말고, 앞에서 통과한 게 그대로 유효하니 다시 안 돌린 걸 unverified에 적지도 마). 그다음 계획에 남은 단계(설치, 사진, 올리기처럼 맡은 일에 있던 것)와 아직 통과 못 한 목표 검사를 이어서 해. 리뷰를 반영했다고 일이 끝난 건 아니야: 맡은 일이 다 됐을 때 끝내고, 못 한 건 unverified에 적어. 고칠 게 없으면 바로 남은 단계로 넘어가.";

/**
 * The one message the job gets when both lenses are over: each lens's findings,
 * where they disagree (on code and on memory), what memory the check settled, and
 * how to settle a disagreement (one targeted check, not another review).
 */
export function crosscheckMessage(group: Task[], memory: { lines: string[]; split: string[] }): string {
  if (group.some(isPlan)) return planMessage(group);
  const done = group.filter((k) => k.status === "done");
  if (!done.length) {
    const why = LENSES.map((l) => `${l.title}: ${missing(group.find((x) => x.lens === l.lens))}`).join(" · ");
    return `${CROSSCHECK}가 두 관점 모두 실패했어요 (${why}). 리뷰를 한 번 다시 띄워도 돼요.`;
  }
  const text = (lens: string) => done.filter((k) => k.lens === lens).map((k) => k.result ?? "").join("\n");
  const both = LENSES.every((l) => done.some((k) => k.lens === l.lens));
  const split = both ? [...disagreements(text("design"), text("code")), ...memory.split] : [];
  const gone = LENSES.filter((l) => !done.some((k) => k.lens === l.lens)).map((l) => l.title);
  const models = modelsOf(group);
  const across = models.length > 1 ? acrossModels(group) : undefined;
  return [
    `${CROSSCHECK} 결과가 왔어요 (${LENSES.map((l) => l.title).join(" · ")}${models.length > 1 ? `, ${models.map((m) => shortModel(m) || "작업 모델").join(" · ")}` : ""}):`,
    "",
    lensText(group),
    ...(both ? ["", "# 두 검토가 갈리는 곳", ...(split.length ? split : ["- 같은 곳을 다르게 본 지적은 없어요."])] : []),
    ...(across?.agree.length ? ["", "# 여러 모델이 같이 짚은 곳", ...across.agree] : []),
    ...(across?.split.length ? ["", "# 모델끼리 갈리는 곳", ...across.split] : []),
    ...(memory.lines.length ? ["", "# 메모리 확인", ...memory.lines] : []),
    "",
    ...(gone.length ? [`${gone.join(", ")}는 빠졌어요: 다시 띄우지 말고 done의 unverified에 "${gone.join(", ")} 빠짐"이라고 적어.`] : []),
    ...(across
      ? ["여러 모델의 결과를 하나로 합쳐: 같은 문제는 한 번만 고치고, 여러 모델이 같이 짚은 곳부터 봐. 한 모델만 짚은 P1·P2와 모델끼리 갈리는 곳은 리뷰를 다시 띄우지 말고 그 지점만 직접 확인해서 정해."]
      : []),
    ...(both
      ? ["두 검토가 갈리는 곳은 리뷰를 다시 띄우지 말고, 그 지점 하나만 직접 확인해서(그 코드 한 곳 읽기, 그 테스트 하나 돌리기) 증거가 맞는 쪽으로 정해. 두 검토가 같은 문제를 짚었으면 한 번만 고쳐."]
      : []),
    REVIEW_FIX,
  ].join("\n");
}

/** What to do with a plan review's findings. */
export const PLAN_FIX =
  "계획을 이 결과대로 고쳐 줘(P1·P2는 꼭, P3는 쉬우면). 다만 사용자가 요청하지 않은 보장·상태·검사·안전장치를 더하라는 지적은 P2여도 넣지 말고 보고에 한 줄로 남겨. 사용자만 정할 수 있는 질문이 있으면 decision 하나로 묻고 답을 기다려. 없으면 바로 만들기 시작해. 계획 검토는 다시 띄우지 마.";

function planMessage(group: Task[]): string {
  const done = group.filter((k) => k.status === "done");
  if (!done.length) return `${PLAN_REVIEW}가 둘 다 실패했어요. 다시 띄우지 말고 계획대로 만들기 시작해.`;
  const gone = PLAN_LENSES.filter((l) => !done.some((k) => k.lens === l.lens)).map((l) => l.title);
  return [
    `${PLAN_REVIEW} 결과가 왔어요 (${PLAN_LENSES.map((l) => l.title).join(" · ")}):`,
    "",
    lensText(group),
    "",
    ...(gone.length ? [`${gone.join(", ")}는 빠졌어요. 다시 띄우지 마.`] : []),
    PLAN_FIX,
  ].join("\n");
}

/** One line for the resume summary: the pair as one review. */
export function crosscheckLine(group: Task[], clip: (s: string, n: number) => string): string {
  const name = reviewName(group[0]);
  const where = setOf(group).map((l) => `${l.title} ${group.find((x) => x.lens === l.lens)?.status ?? "missing"}`).join(", ");
  if (group.some(active)) return `- review "${name}": still running (${where}). Its combined result comes to you by itself; don't start it again and never ask the user for it.`;
  if (!group.some((k) => k.status === "done")) return `- review "${name}": failed (${clip(lensText(group).replace(/\s+/g, " "), 300)})`;
  return `- review "${name}": done (${where}).\n${clip(lensText(group), 4000)}`;
}
