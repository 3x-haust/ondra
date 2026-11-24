// A round of questions (the sharpen skill): the questions whose answers don't wait on one
// another, sent in one ask block. They show one at a time on the usual card (its one choice
// is the recommendation; any other answer is typed in the chat box), the next at once with no
// model turn, and all the answers go back together after the last.
import type { Block, Decision } from "../state/types";

export type RoundQ = { question: string; recommend: string; note?: string };
export type Clarity = NonNullable<Decision["clarity"]>;

const unit = (x: unknown): number | undefined => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n > 1 ? n / 100 : n));
};

/** how clear the request is now (0–1) and by part; a percentage is read as one */
export function readClarity(x: unknown): Clarity | undefined {
  const raw = x && typeof x === "object" ? (x as { score?: unknown; parts?: unknown }) : { score: x };
  const score = unit(raw.score);
  if (score === undefined) return undefined;
  const parts = (Array.isArray(raw.parts) ? raw.parts : [])
    .map((p: any) => ({ label: String(p?.label ?? "").trim().slice(0, 24), score: unit(p?.score) }))
    .filter((p): p is { label: string; score: number } => !!p.label && p.score !== undefined)
    .slice(0, 6);
  return { score, ...(parts.length ? { parts } : {}) };
}

/** an ask block with "questions" (two or more is a round; one is a round of one) */
export function readRound(b: any): { qs: RoundQ[]; clarity?: Clarity } | undefined {
  if (!Array.isArray(b?.questions)) return undefined;
  const qs = (b.questions as any[])
    .map((q) => {
      const first = Array.isArray(q?.options) ? q.options[0] : undefined;
      const recommend = String(q?.recommend ?? (first && typeof first === "object" ? first.label : first) ?? "").trim();
      const note = String(q?.why ?? q?.note ?? (first && typeof first === "object" ? (first.note ?? "") : "")).trim();
      return { question: String(q?.question ?? "").trim(), recommend, ...(note ? { note } : {}) };
    })
    .filter((q) => q.question && q.recommend)
    .slice(0, 6);
  if (!qs.length) return undefined;
  const clarity = readClarity(b.clarity);
  return { qs, ...(clarity ? { clarity } : {}) };
}

/** the card for the first of `qs` (what's left of the round), after `answers` */
export function roundDecision(
  base: { id: string; taskId: string; at: number; context: Block[] },
  qs: RoundQ[],
  answers: { q: string; a: string }[],
  clarity?: Clarity,
): Decision {
  const [q, ...rest] = qs;
  return {
    ...base,
    kind: "ask",
    question: q.question,
    // the recommendation is the only choice: any other answer is typed in the chat box
    options: [{ id: "o0", label: q.recommend, primary: true, ...(q.note ? { note: q.note } : {}) }],
    round: { rest, answers, n: answers.length + 1, total: answers.length + qs.length, recommend: q.recommend },
    ...(clarity ? { clarity } : {}),
  };
}

/** The answer to this card: the next card of the round, or (after the last) every answer. */
export function answerRound(d: Decision, optionId: string): { next?: Decision; answers: { q: string; a: string }[] } {
  const r = d.round!;
  const a = optionId === "o0" ? r.recommend : optionId;
  const answers = [...r.answers, { q: d.question, a }];
  if (!r.rest.length) return { answers };
  return { answers, next: roundDecision({ id: `${d.id}.${answers.length}`, taskId: d.taskId, at: Date.now(), context: [] }, r.rest, answers, d.clarity) };
}

/** the answers as the model gets them, one `"question" → answer` per line */
export const roundText = (answers: { q: string; a: string }[]) => answers.map((x) => `"${x.q}" → ${x.a}`).join("\n");
