// The Discord agent's own memory (Settings › 에이전트 › 기억): people, the places it talks in, and
// lessons. Kept apart from the work memory (state.memory) on purpose, both ways: nothing of the
// user's work is in here for talk with others to leak, and nothing said by others on Discord
// becomes work memory. It is what makes the agent the same one tomorrow ("프롬프트는 뼈대,
// 메모리는 업보"): who someone is, how they talk with it, the jokes of a channel, what it got wrong.
//
// Filled by a quiet pass over a channel's talk once it has gone quiet (digest), read into the
// prompt of talk with others and into main's note for the user's own words from Discord.
import { setState, state } from "../state/store";
import type { AgentNote, AgentSettings } from "../state/types";

const MAX_NOTES = 300;
const MAX_LESSONS = 30;
const LEN = { person: 500, place: 700, lesson: 240 } as const;

const notes = (): AgentNote[] => state.agentNotes ?? [];
const uid = () => `an${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A person's card: one per person, and one more for what they said in a DM (kept to DMs with them). */
export const personNote = (who: string, dm: boolean) => notes().find((n) => n.kind === "person" && n.who === who && !!n.dm === dm);
export const placeNote = (place: string) => notes().find((n) => n.kind === "place" && n.place === place);
export const lessons = () => notes().filter((n) => n.kind === "lesson");

/** What it knows that fits this talk, as prompt lines (empty when nothing). */
export function memoryLines(ctx: { speaker?: string; people?: string[]; place?: string; dm: boolean }): string {
  const out: string[] = [];
  const seen = new Set<string>();
  const card = (who: string, own: boolean) => {
    if (seen.has(who)) return;
    seen.add(who);
    const pub = personNote(who, false);
    // what someone said in a DM is used only in a DM with them
    const dm = own && ctx.dm ? personNote(who, true) : undefined;
    for (const n of [pub, dm]) if (n) out.push(`- ${n.name ?? who}${n.dm ? " (DM에서)" : ""}: ${n.text}`);
  };
  if (ctx.speaker) card(ctx.speaker, true);
  for (const p of ctx.people ?? []) card(p, false);
  const place = ctx.place ? placeNote(ctx.place) : undefined;
  if (place) out.push(`- 이곳: ${place.text}`);
  for (const l of lessons().slice(-12)) out.push(`- 교훈: ${l.text}`);
  return out.join("\n");
}

/** Public social context for actions whose destination the model has yet to choose. */
export function actionMemory(): string {
  const lines = notes().filter((n) => !n.dm).map((n) =>
    `- ${n.kind === "place" ? `server ${n.place}` : n.kind === "person" ? `person ${n.who} (${n.name ?? n.who})` : "lesson"}: ${n.text}`,
  );
  return lines.length ? `Your Discord memory (separate from work memory; apply each server/person note only in its own context):\n${lines.join("\n")}` : "";
}

type Op = { kind?: string; who?: string; name?: string; text?: string };

/** The pass's answer: a JSON array of cards to write (a person's or the place's whole card again, or a new lesson). */
export function applyDigest(raw: string, ctx: { place?: string; dm: boolean; people: Record<string, string> }, now = Date.now()): number {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return 0;
  let ops: Op[];
  try {
    ops = JSON.parse(m[0]);
  } catch {
    return 0;
  }
  if (!Array.isArray(ops)) return 0;
  let list = [...notes()];
  let n = 0;
  for (const op of ops.slice(0, 12)) {
    const text = typeof op?.text === "string" ? op.text.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    if (op.kind === "person") {
      // only people who were in this talk: a card can't be made up for someone else
      const who = String(op.who ?? "");
      if (!(who in ctx.people)) continue;
      const i = list.findIndex((x) => x.kind === "person" && x.who === who && !!x.dm === ctx.dm);
      const note: AgentNote = { id: i >= 0 ? list[i].id : uid(), kind: "person", who, name: ctx.people[who] || op.name, dm: ctx.dm || undefined, text: text.slice(0, LEN.person), at: i >= 0 ? list[i].at : now, updatedAt: now };
      list = i >= 0 ? list.map((x, j) => (j === i ? note : x)) : [...list, note];
      n++;
    } else if (op.kind === "place" && ctx.place && !ctx.dm) {
      const i = list.findIndex((x) => x.kind === "place" && x.place === ctx.place);
      const note: AgentNote = { id: i >= 0 ? list[i].id : uid(), kind: "place", place: ctx.place, text: text.slice(0, LEN.place), at: i >= 0 ? list[i].at : now, updatedAt: now };
      list = i >= 0 ? list.map((x, j) => (j === i ? note : x)) : [...list, note];
      n++;
    } else if (op.kind === "lesson") {
      if (list.some((x) => x.kind === "lesson" && x.text === text)) continue;
      list = [...list, { id: uid(), kind: "lesson", text: text.slice(0, LEN.lesson), at: now }];
      const all = list.filter((x) => x.kind === "lesson");
      if (all.length > MAX_LESSONS) list = list.filter((x) => x !== all[0]);
      n++;
    }
  }
  if (n) setState("agentNotes", list.slice(-MAX_NOTES));
  return n;
}

export function forgetNote(id: string) {
  setState("agentNotes", notes().filter((n) => n.id !== id));
}

/** A line of talk the pass reads. */
export type Heard = { who: string; name: string; text: string; me?: boolean; owner?: boolean; at?: number };

/** The prompt of the quiet pass over a channel's talk. */
export function digestPrompt(a: AgentSettings, heard: Heard[], ctx: { place?: string; dm: boolean }): string {
  const people = [...new Map(heard.filter((h) => !h.me).map((h) => [h.who, h.name])).entries()];
  const known = memoryLines({ people: people.map(([id]) => id), place: ctx.place, dm: false });
  const dmKnown = ctx.dm ? people.map(([id]) => personNote(id, true)).filter(Boolean).map((n) => `- ${n!.name} (DM에서): ${n!.text}`) : [];
  return [
    `너는 디스코드 에이전트 "${a.name}"의 기억을 정리해. 아래 대화에서, 다음에 이 사람들과 얘기할 때 도움이 될 오래 갈 것만 뽑아.`,
    "",
    "남길 것:",
    "- 사람(person): 누구인지(하는 일, 관심사), 말투와 나와의 사이(반말·존댓말, 친한 정도, 장난을 받아 주는지), 다시 나올 만한 부탁이나 질문",
    ctx.dm ? "" : "- 이곳(place): 무슨 곳인지, 자주 나오는 얘기, 굳어진 농담이나 분위기",
    "- 교훈(lesson): 내가 틀려서 정정한 것, 주인이 디스코드에서 이렇게 하라·하지 말라고 한 것",
    "",
    "남기지 말 것:",
    "- 주인의 일: 프로젝트, 코드, 계획, 아직 안 나온 것, 버전, 링크, 계정, 화면. 주인이 직접 말했어도 남기지 않아",
    "- 비밀번호, 키, 연락처, 주소, 건강 같은 개인 정보",
    "- 한 번 지나가는 잡담, 지금만 맞는 것",
    "",
    "사람 카드와 이곳 카드는 이미 아는 것과 합쳐서 카드 전체를 새로 써(짧게, 한두 문장). 바뀐 게 없으면 그 카드는 빼.",
    known || dmKnown.length ? `# 이미 아는 것\n${[known, ...dmKnown].filter(Boolean).join("\n")}` : "",
    "",
    `# 대화 (오래된 것부터)${ctx.dm ? " · DM" : ""}`,
    ...heard.map((h) => `${h.me ? `${a.name}(너)` : `${h.name}[${h.who}]${h.owner ? "(주인)" : ""}`}: ${h.text.slice(0, 500)}`),
    "",
    'JSON 배열만 써: [{"kind":"person","who":"<대괄호 안 id>","text":"…"},{"kind":"place","text":"…"},{"kind":"lesson","text":"…"}]. 남길 게 없으면 [].',
  ].filter((l) => l !== "").join("\n");
}
