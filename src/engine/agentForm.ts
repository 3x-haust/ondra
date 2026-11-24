// Metamong turning into someone: for a while its words go out under their name and picture and
// it talks like them. Each message carries that name and picture itself (through a webhook of the
// channel), so only what it says while turned shows that face: its own name and picture, and all it
// said before, stay as they were. When the time is up (or it decides a hit undid it) it pops back.
// The time keeps across a restart.
import { discordApi } from "../lib/native";
import { setState, state } from "../state/store";
import type { AgentSettings } from "../state/types";

export type Form = NonNullable<AgentSettings["form"]>;

/** how long a turn lasts when it doesn't say (minutes), and the most it can */
const DEFAULT_MIN = 30;
const MAX_MIN = 240;
/** the name of the webhook it keeps in a channel to speak as someone else */
const HOOK = "Ondra 변신";

let timer: ReturnType<typeof setTimeout> | undefined;
/** channel → its webhook; the token stays in memory, never in state or logs */
const hooks = new Map<string, { id: string; token: string } | null>();

const setForm = (form: Form | undefined) => setState("settings", "agent", (a) => (a ? { ...a, form } : a));

/** it can turn into someone only while it is Metamong (the agent's name in Settings › 에이전트) */
export const isDitto = (a: AgentSettings | undefined = state.settings.agent) => !!a && /메타몽|ditto/i.test(a.name);

/** what it is now: the form while it holds, nothing once its time is up */
export function formNow(a: AgentSettings | undefined = state.settings.agent, now = Date.now()): Form | undefined {
  return isDitto(a) && a?.form && a.form.until > now ? a.form : undefined;
}

/** the line its prompts get while it is someone else */
export function formNote(a: AgentSettings | undefined, now = Date.now()): string {
  const f = formNow(a, now);
  if (!f) return "";
  const left = Math.max(1, Math.round((f.until - now) / 60_000));
  return `지금 너는 ${f.who}(으)로 변신해 있어 (${left}분쯤 남음). 말투랑 성격만 ${f.who}처럼 바꿔서 말해. 너는 그대로 너고, 누가 누군지도 그대로야. 변신이 풀리면 원래 말투로 돌아와.`;
}

/** Turn into someone for `minutes`: what it says till then goes out under their name and picture. */
export function become(o: { who: string; picture?: string; minutes?: number }): { who: string; until: number; picture?: string } | { error: string } {
  // Discord takes a webhook name of 1–80 characters, without "discord" or "clyde" in it
  if (!isDitto()) return { error: "only Metamong can turn into someone (the agent's name in Settings › 에이전트)" };
  const who = o.who.trim().slice(0, 80);
  if (!who || /discord|clyde/i.test(who)) return { error: "that name can't be a Discord name (empty, or has discord/clyde in it)" };
  const picture = o.picture?.trim();
  if (picture && !/^https?:\/\//.test(picture)) return { error: "picture is the web address of their picture (https://…), as found by searching" };
  const minutes = Math.min(MAX_MIN, Math.max(1, Math.round(o.minutes ?? DEFAULT_MIN)));
  const until = Date.now() + minutes * 60_000;
  setForm({ who, until, ...(picture ? { picture } : {}) });
  keepTime();
  return { who, until, ...(picture ? { picture } : {}) };
}

/** Pop back to itself. */
export function back(): { back: true } {
  if (timer) clearTimeout(timer), (timer = undefined);
  setForm(undefined);
  return { back: true };
}

/** When the time is up it pops back on its own, also after the app was closed meanwhile. */
export function keepTime() {
  if (timer) clearTimeout(timer), (timer = undefined);
  const f = state.settings.agent?.form;
  if (!f) return;
  const left = f.until - Date.now();
  if (left <= 0) return void back();
  timer = setTimeout(() => void back(), Math.min(left, 2 ** 31 - 1));
}

/** its webhook in a channel, made the first time; null where it may not (no 웹후크 관리, a thread, a DM) */
async function hookOf(channel: string): Promise<{ id: string; token: string } | null> {
  if (hooks.has(channel)) return hooks.get(channel)!;
  let h: { id: string; token: string } | null = null;
  try {
    const list = (await discordApi("GET", `/channels/${channel}/webhooks`)) as { id: string; name?: string; token?: string }[];
    const had = list.find((w) => w.name === HOOK && w.token);
    const made = had ?? ((await discordApi("POST", `/channels/${channel}/webhooks`, { name: HOOK })) as { id: string; token?: string });
    if (made?.id && made.token) h = { id: made.id, token: made.token };
  } catch {
    h = null;
  }
  hooks.set(channel, h);
  return h;
}

/**
 * Say `text` there as who it turned into: their name and picture on these messages only.
 * Nothing (undefined) when it isn't turned or the channel won't let it: then it says it as itself.
 */
export async function sayAsForm(channel: string, text: string): Promise<string[] | undefined> {
  const f = formNow();
  if (!f) return undefined;
  const h = await hookOf(channel);
  if (!h) return undefined;
  const ids: string[] = [];
  try {
    for (let i = 0; i < text.length; i += 2000) {
      const m = (await discordApi("POST", `/webhooks/${h.id}/${h.token}?wait=true`, { content: text.slice(i, i + 2000), username: f.who, ...(f.picture ? { avatar_url: f.picture } : {}), allowed_mentions: { parse: [] } })) as { id?: string };
      if (m?.id) ids.push(m.id);
    }
  } catch {
    // the webhook went away: made again next time; what's left goes out as itself
    hooks.delete(channel);
    if (!ids.length) return undefined;
  }
  return ids;
}
