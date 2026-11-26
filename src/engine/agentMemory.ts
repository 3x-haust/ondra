// The Discord agent's own memory (Settings › 에이전트 › 기억): people, the places it talks in, and
// lessons. Kept apart from the work memory (state.memory) on purpose, both ways: nothing of the
// user's work is in here for talk with others to leak, and nothing said by others on Discord
// becomes work memory. It is what makes the agent the same one tomorrow ("프롬프트는 뼈대,
// 메모리는 업보"): who someone is, how they talk with it, the jokes of a channel, what it got wrong.
//
// Filled by a quiet pass over a channel's talk once it has gone quiet (digest), read into the
// prompt of talk with others and into main's note for the user's own words from Discord. What is
// learned about people and a place stays in the channel it was learned in; lessons go everywhere.
import { setState, state } from "../state/store";
import type { AgentNote, AgentSettings } from "../state/types";

const MAX_NOTES = 300;
const MAX_LESSONS = 30;
const LEN = { person: 500, place: 700, lesson: 240 } as const;

const notes = (): AgentNote[] => state.agentNotes ?? [];
const uid = () => `an${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Where the talk is: its channel (a DM's too), and whether that is a DM. */
export type Where = { channel?: string; dm: boolean };

/**
 * What is said in one channel stays in that channel: a person's or a place's card is used only in the
 * channel it was learned in, lessons (how it talks and behaves) everywhere. A card kept before channels
 * were told apart is used nowhere, as where it came from isn't known; but a DM card, which came from
 * the DM with that person, is used in DMs (only theirs: a card is looked up for the people in the talk).
 */
const fits = (n: AgentNote, at: Where) => n.kind === "lesson" || (n.channel ? n.channel === at.channel : n.kind === "person" && !!n.dm && at.dm);

/** A person's card in this channel. */
export const personNote = (who: string, at: Where) => notes().find((n) => n.kind === "person" && n.who === who && fits(n, at));
/** This channel's card (a DM has none). */
export const placeNote = (at: Where) => (at.dm || !at.channel ? undefined : notes().find((n) => n.kind === "place" && n.channel === at.channel));
export const lessons = () => notes().filter((n) => n.kind === "lesson");

/** What it knows that fits this talk, as prompt lines (empty when nothing). */
export function memoryLines(ctx: Where & { speaker?: string; people?: string[] }): string {
  const out: string[] = [];
  for (const who of new Set([ctx.speaker, ...(ctx.people ?? [])])) {
    const n = who ? personNote(who, ctx) : undefined;
    if (n) out.push(`- ${n.name ?? who}: ${n.text}`);
  }
  const place = placeNote(ctx);
  if (place) out.push(`- 이곳: ${place.text}`);
  for (const l of lessons().slice(-12)) out.push(`- 교훈: ${l.text}`);
  return out.join("\n");
}

type Op = { kind?: string; who?: string; name?: string; text?: string };

/** The pass's answer: a JSON array of cards to write (a person's or the place's whole card again, or a new lesson), kept to this channel. */
export function applyDigest(raw: string, ctx: Where & { channel: string; room?: string; people: Record<string, string> }, now = Date.now()): number {
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
  const here = { channel: ctx.channel, ...(ctx.room ? { room: ctx.room } : {}) };
  for (const op of ops.slice(0, 12)) {
    const text = typeof op?.text === "string" ? op.text.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    if (op.kind === "person") {
      // only people who were in this talk: a card can't be made up for someone else
      const who = String(op.who ?? "");
      if (!(who in ctx.people)) continue;
      // their card here (a DM card kept before channels were told apart is bound to this DM now)
      const i = list.findIndex((x) => x.kind === "person" && x.who === who && fits(x, ctx));
      const note: AgentNote = { id: i >= 0 ? list[i].id : uid(), kind: "person", who, name: ctx.people[who] || op.name, dm: ctx.dm || undefined, ...here, text: text.slice(0, LEN.person), at: i >= 0 ? list[i].at : now, updatedAt: now };
      list = i >= 0 ? list.map((x, j) => (j === i ? note : x)) : [...list, note];
      n++;
    } else if (op.kind === "place" && !ctx.dm) {
      const i = list.findIndex((x) => x.kind === "place" && x.channel === ctx.channel);
      const note: AgentNote = { id: i >= 0 ? list[i].id : uid(), kind: "place", ...here, text: text.slice(0, LEN.place), at: i >= 0 ? list[i].at : now, updatedAt: now };
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
export function digestPrompt(a: AgentSettings, heard: Heard[], ctx: Where): string {
  const people = [...new Map(heard.filter((h) => !h.me).map((h) => [h.who, h.name])).keys()];
  const known = memoryLines({ people, ...ctx });
  return [
    `너는 디스코드 에이전트 "${a.name}"의 기억을 정리해. 아래 대화에서, 다음에 이 사람들과 얘기할 때 도움이 될 오래 갈 것만 뽑아.`,
    "사람 카드와 이곳 카드는 이 채널에서만 쓰여. 교훈은 모든 채널에서 쓰여.",
    "",
    "남길 것:",
    "- 사람(person): 누구인지(하는 일, 관심사), 말투와 나와의 사이(반말·존댓말, 친한 정도, 장난을 받아 주는지), 다시 나올 만한 부탁이나 질문",
    ctx.dm ? "" : "- 이곳(place): 무슨 곳인지, 자주 나오는 얘기, 굳어진 농담이나 분위기",
    "- 교훈(lesson): 내가 틀려서 정정한 것, 주인이 디스코드에서 이렇게 하라·하지 말라고 한 것. 어느 채널에서나 맞는 말하기·행동 방식만 써. 누가 한 얘기나 이 채널 얘기는 교훈에 넣지 말고 사람·이곳 카드에 써",
    "",
    "남기지 말 것:",
    "- 주인의 일: 프로젝트, 코드, 계획, 아직 안 나온 것, 버전, 링크, 계정, 화면. 주인이 직접 말했어도 남기지 않아",
    "- 비밀번호, 키, 연락처, 주소, 건강 같은 개인 정보",
    "- 한 번 지나가는 잡담, 지금만 맞는 것",
    "",
    "사람 카드와 이곳 카드는 이미 아는 것과 합쳐서 카드 전체를 새로 써(짧게, 한두 문장). 바뀐 게 없으면 그 카드는 빼.",
    known ? `# 이미 아는 것\n${known}` : "",
    "",
    `# 대화 (오래된 것부터)${ctx.dm ? " · DM" : ""}`,
    ...heard.map((h) => `${h.me ? `${a.name}(너)` : `${h.name}[${h.who}]${h.owner ? "(주인)" : ""}`}: ${h.text.slice(0, 500)}`),
    "",
    'JSON 배열만 써: [{"kind":"person","who":"<대괄호 안 id>","text":"…"},{"kind":"place","text":"…"},{"kind":"lesson","text":"…"}]. 남길 게 없으면 [].',
  ].filter((l) => l !== "").join("\n");
}
