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

/** for tests */
export const forgetPeople = () => names.clear();

/** the one id a name stands for (none when it is unknown or two people share it) */
function idOf(word: string): { id: string; len: number } | undefined {
  const w = word.toLowerCase();
  // the longest known name it starts with ("@정원아" is 정원 called)
  let best: { id: string; len: number } | undefined;
  for (const [n, ids] of names) if (ids.size === 1 && w.startsWith(n) && (!best || n.length > best.len)) best = { id: [...ids][0], len: n.length };
  return best;
}

/** The line with "@name" of someone known made their mention (code left as it is), and the ids it tags. */
export function tagged(text: string, me?: string): { text: string; pings: string[] } {
  let fence = false;
  const out = text
    .split("\n")
    .map((l) => {
      if (/^\s*```/.test(l)) return (fence = !fence), l;
      if (fence || l.includes("`")) return l;
      return l.replace(/(^|[\s(])@([^\s@<>()`]{1,40})/g, (all, pre: string, word: string) => {
        const hit = idOf(word);
        return hit && hit.id !== me ? `${pre}<@${hit.id}>${word.slice(hit.len)}` : all;
      });
    })
    .join("\n");
  return { text: out, pings: pingsIn(out, me) };
}

/** Discord's allowed_mentions: only these people are notified (left as before when none) */
export const allowed = (pings: string[]) => ({ parse: [] as string[], ...(pings.length ? { users: pings } : {}) });

/** the people a line tags by id (not itself) */
export const pingsIn = (text: string, me?: string): string[] => [...new Set([...text.matchAll(/<@!?(\d{1,25})>/g)].map((x) => x[1]))].filter((id) => id !== me).slice(0, 100);
