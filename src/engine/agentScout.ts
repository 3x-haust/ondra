// The agent looks over what the user asked it lately, once a day, for something asked again and
// again on a pattern (every morning, every Friday, after each release) that no routine does yet,
// and offers once, in its own voice, to do it on its own: "요즘 아침마다 PR 정리 시키던데 매일
// 9시에 알아서 해둘까?". A yes in that channel is the agent's chat making the routine (its note
// carries the offer). Each pattern is offered once; nothing is made without the user's yes.
import { AGENT_CHAT, setState, state } from "../state/store";
import type { AgentSettings, SpaceId } from "../state/types";
import { logError, logInfo } from "../lib/log";

const DAY = 86_400_000;
/** how far back it looks, and how many requests it needs before looking at all */
export const SCOUT_DAYS = 14;
export const SCOUT_MIN = 3;

export interface Asked { text: string; at: number; channel?: string }

/** what the user asked the agent lately (its chat, this space), oldest first */
export function askedLately(space: SpaceId, now = Date.now()): Asked[] {
  return state.captain
    .filter((m) => m.space === space && m.project === AGENT_CHAT && m.from === "me" && m.at >= now - SCOUT_DAYS * DAY && !!m.text?.trim())
    .map((m) => ({ text: m.text!.trim().slice(0, 300), at: m.at, channel: m.discord?.channel }));
}

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
const stamp = (at: number) => {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()}(${DAYS[d.getDay()]}) ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The prompt for the look: the requests with their times, the routines there are, what was offered before. */
export function scoutPrompt(a: AgentSettings, asked: Asked[], routines: string[], voice: string): string {
  return [
    `너는 디스코드에서 주인의 일을 해 주는 "${a.name}"이야. 아래는 주인이 최근 ${SCOUT_DAYS}일 동안 너한테 시킨 말이야(시간 순).`,
    `같은 종류의 일을 정해진 때마다(매일 아침, 매주 금요일, 배포할 때마다 등) ${SCOUT_MIN}번 이상 시켰고, 아래 루틴이 아직 안 하는 게 있으면, 그걸 네가 알아서 하겠다고 한 번 제안해.`,
    "확실하지 않으면, 한두 번뿐이면, 매번 내용이 다른 일이면, 이미 루틴이 하거나 전에 제안한 거면 none 이라고만 써.",
    "",
    "# 주인이 시킨 말",
    ...asked.map((x) => `- ${stamp(x.at)} ${x.text}`),
    "",
    `# 이미 있는 루틴\n${routines.length ? routines.map((r) => `- ${r}`).join("\n") : "(없음)"}`,
    "",
    `# 전에 제안한 것 (다시 제안하지 마)\n${a.suggested?.length ? a.suggested.map((k) => `- ${k}`).join("\n") : "(없음)"}`,
    "",
    "# 제안할 게 있으면 JSON 하나만",
    '{"key":"짧은 이름","say":"주인한테 할 말 한 줄","title":"루틴 이름","task":"매번 할 일(주인 말 그대로에 가깝게)","when":{"kind":"daily","time":"09:00","days":[1,2,3,4,5]}}',
    'when은 {"kind":"daily","time":"HH:MM","days":[0-6, 일=0]} (days 빼면 매일), {"kind":"every","minutes":N}, {"kind":"event","event":"issue|pr|ci|release"} 중 하나.',
    "",
    "# say는 이 말투로, 사람이 툭 묻듯이 한 줄 (\"요즘 아침마다 PR 정리 시키던데 매일 9시에 알아서 해둘까?\")",
    voice,
  ].join("\n");
}

/** what the look came back with: an offer, or nothing (none, or not one it can make) */
export function readScout(raw: string): Omit<NonNullable<AgentSettings["offer"]>, "channel" | "at"> & { key: string } | undefined {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    const o = JSON.parse(m[0]);
    const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    if (!s(o.key) || !s(o.say) || !s(o.task) || !o.when || typeof o.when !== "object") return undefined;
    return { key: s(o.key).slice(0, 60), say: s(o.say).slice(0, 300), title: (s(o.title) || s(o.key)).slice(0, 80), task: s(o.task).slice(0, 500), when: o.when };
  } catch {
    return undefined;
  }
}

let looking = false;
/**
 * Once a day at most: look, and offer what it found in the channel the user last asked from.
 * `say` posts a line to Discord (discord.ts gives it); `ask` is the quick model pass.
 */
export async function maybeScout(o: {
  a: AgentSettings;
  space: SpaceId;
  voice: string;
  ask: (prompt: string) => Promise<string>;
  say: (channel: string, text: string) => Promise<void>;
  set: (patch: Partial<AgentSettings>) => void;
  now?: number;
}): Promise<boolean> {
  const now = o.now ?? Date.now();
  if (looking || !o.a.on || (o.a.scoutAt && now - o.a.scoutAt < DAY)) return false;
  // an offer still waiting for an answer: one at a time
  if (o.a.offer && now - o.a.offer.at < DAY) return false;
  looking = true;
  try {
    o.set({ scoutAt: now });
    const asked = askedLately(o.space, now);
    if (asked.length < SCOUT_MIN) return false;
    const channel = [...asked].reverse().find((x) => x.channel)?.channel;
    if (!channel) return false;
    const routines = (state.routines ?? []).filter((r) => r.space === o.space && !r.draft && !r.alarm).map((r) => `${r.title}: ${r.prompt}`);
    const found = readScout(await o.ask(scoutPrompt(o.a, asked, routines, o.voice)));
    if (!found || o.a.suggested?.includes(found.key)) return false;
    const { key, ...offer } = found;
    o.set({ suggested: [...(o.a.suggested ?? []), key].slice(-50), offer: { ...offer, channel, at: now } });
    await o.say(channel, offer.say);
    // the agent's tab shows it said it
    setState("captain", (l) => [...l, { id: `scout-${now}`, at: now, space: o.space, project: AGENT_CHAT, from: "captain", relay: true, reply: offer.say }]);
    logInfo("agent", `offered a routine: ${key}`);
    return true;
  } catch (e) {
    logError("agent", `routine look: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  } finally {
    looking = false;
  }
}

/** For main's note on the user's next words there: the offer they may be answering. */
export function offerNote(a: AgentSettings, channel: string, now = Date.now()): string {
  const o = a.offer;
  if (!o || o.channel !== channel || now - o.at > 3 * DAY) return "";
  return [
    `You offered this in this channel earlier: "${o.say}". If these words say yes to it, make the routine now (routine route) with:`,
    JSON.stringify({ title: o.title, task: o.task, when: o.when }),
    "If they say no or change it, do as they say. Either way it is settled after this.",
  ].join("\n");
}
