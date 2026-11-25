// Who is who on Discord, as the messages it sees show them, so a person can be tagged the way
// people do it: "@정원아" or "@jeongwon0047" in a line becomes their mention, and whoever a line
// tags by id is notified (never @everyone or a role; those stay off).

type Seen = { author: { id: string; name: string; user?: string; bot?: boolean } };

/** a lowercased name or account name → the ids seen under it */
const names = new Map<string, Set<string>>();

/** Note the people in these messages (their shown name and account name). */
export function seePeople(ms: Seen[]): void {
  for (const m of ms) {
    for (const n of [m.author.name, m.author.user]) {
      const k = (n ?? "").trim().toLowerCase();
      if (!k || /\s/.test(k) || k.length > 32) continue;
      const ids = names.get(k) ?? new Set<string>();
      ids.add(m.author.id);
      names.set(k, ids);
    }
  }
}

/** a server's channels by name → their ids, so "#orbit" written in a line becomes its link */
const rooms = new Map<string, Set<string>>();
/** servers and channels by id, with their names: where a message is, said by name */
const servers = new Map<string, string>();
const channels = new Map<string, { name: string; category?: string; guild?: string }>();
export function seeServers(list: { id: string; name: string }[]): void {
  for (const g of list) if (g.name) servers.set(g.id, g.name);
}
export function seeChannels(list: { id: string; name: string; kind?: string; category?: string | null }[], guild?: string): void {
  const cats = new Map(list.filter((c) => c.kind === "category").map((c) => [c.id, c.name]));
  for (const c of list) if (c.kind !== "category") channels.set(c.id, { name: c.name, category: (c.category && cats.get(c.category)) || undefined, guild });
  for (const c of list) {
    if (c.kind && c.kind !== "text") continue;
    const k = c.name.trim().toLowerCase();
    if (!k) continue;
    rooms.set(k, (rooms.get(k) ?? new Set()).add(c.id));
  }
}

/** for tests */
export const forgetPeople = () => (names.clear(), rooms.clear(), servers.clear(), channels.clear());

/**
 * Where a message is, by name: a DM with someone, or a server's channel (its category, and whether
 * work is shown there). Ids stay beside the names, so a way written for a place finds it again.
 */
export function placeOf(m: { guild?: string | null; channel: string; author: { name: string } }, o: { work?: boolean; ko?: boolean } = {}): string {
  if (!m.guild) return o.ko ? `${m.author.name}와의 DM` : `a DM with ${m.author.name}`;
  const g = servers.get(m.guild), c = channels.get(m.channel);
  if (o.ko)
    return `${g ? `"${g}" 서버` : "서버"}(id ${m.guild})의 ${c ? `#${c.name} 채널` : "채널"}(id ${m.channel})${c?.category ? `, "${c.category}" 카테고리` : ""}${o.work ? ", 작업을 보여 주는 방" : ""}`;
  return `the server ${g ? `"${g}" ` : ""}(id ${m.guild}), channel ${c ? `#${c.name} ` : ""}(id ${m.channel})${c?.category ? ` under "${c.category}"` : ""}${o.work ? ", a room where work is shown" : ""}`;
}

/** the one id a name stands for (none when it is unknown or two people share it) */
function idOf(word: string): { id: string; len: number } | undefined {
  const w = word.toLowerCase();
  // the longest known name it starts with ("@정원아" is 정원 called)
  let best: { id: string; len: number } | undefined;
  for (const [n, ids] of names) if (ids.size === 1 && w.startsWith(n) && (!best || n.length > best.len)) best = { id: [...ids][0], len: n.length };
  return best;
}

/** The line with "@name" of someone known made their mention and "#name" of a known channel its
 *  link (code left as it is), and the people it tags. */
export function tagged(text: string, me?: string): { text: string; pings: string[] } {
  let fence = false;
  const out = text
    .split("\n")
    .map((l) => {
      if (/^\s*```/.test(l)) return (fence = !fence), l;
      if (fence || l.includes("`")) return l;
      return l
        .replace(/(^|[\s(])@([^\s@<>()`]{1,40})/g, (all, pre: string, word: string) => {
          const hit = idOf(word);
          return hit && hit.id !== me ? `${pre}<@${hit.id}>${word.slice(hit.len)}` : all;
        })
        .replace(/(^|[\s(])#([\p{L}\p{N}_-]{1,100})/gu, (all, pre: string, word: string) => {
          // the longest known channel name it starts with ("#orbit에서"), one channel only
          let best: { id: string; len: number } | undefined;
          for (const [n, ids] of rooms) if (ids.size === 1 && word.toLowerCase().startsWith(n) && (!best || n.length > best.len)) best = { id: [...ids][0], len: n.length };
          return best ? `${pre}<#${best.id}>${word.slice(best.len)}` : all;
        });
    })
    .join("\n");
  return { text: out, pings: pingsIn(out, me) };
}

/** Discord's allowed_mentions: only these people are notified (left as before when none) */
export const allowed = (pings: string[]) => ({ parse: [] as string[], ...(pings.length ? { users: pings } : {}) });

/** the people a line tags by id (not itself) */
export const pingsIn = (text: string, me?: string): string[] => [...new Set([...text.matchAll(/<@!?(\d{1,25})>/g)].map((x) => x[1]))].filter((id) => id !== me).slice(0, 100);
