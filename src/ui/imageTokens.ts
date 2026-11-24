// "[Image #2]" in a message: the second picture attached to it, by the number the
// input gave it. The token sits in the words where the picture was put, and the
// attached files' list names it again ("- [Image #2] /path"), so whoever reads the
// message knows which picture "this" is.

const imageToken = (n: number) => `[Image #${n}]`;
const TOKEN = /\[Image #(\d+)\]/g;

/** "- [Image #2] /a/b.png" → the path and its number; "- /a/b.txt" → the path alone */
export function fileLine(line: string): { path: string; n?: number } {
  const rest = line.replace(/^- /, "").trim();
  const m = /^\[Image #(\d+)\]\s+(.+)$/.exec(rest);
  return m ? { path: m[2].trim(), n: Number(m[1]) } : { path: rest };
}

/** one line of the attached files' list */
export const listLine = (path: string, n?: number) => (n ? `- ${imageToken(n)} ${path}` : `- ${path}`);

/** the token the caret is inside of (not at its edges): its number */
export function tokenAt(text: string, caret: number): number | null {
  for (const m of text.matchAll(TOKEN)) {
    if (caret > m.index! && caret < m.index! + m[0].length) return Number(m[1]);
  }
  return null;
}

/** words and tokens, in order, for drawing the tokens as chips */
export function splitTokens(text: string): (string | { n: number })[] {
  const out: (string | { n: number })[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > at) out.push(text.slice(at, m.index));
    out.push({ n: Number(m[1]) });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** a picture taken off: its token out of the words, with the space it brought */
export function dropToken(text: string, n: number): string {
  const tok = imageToken(n).replace(/[[\]#]/g, "\\$&");
  return text.replace(new RegExp(` ?${tok} ?`, "g"), (m) => (m.startsWith(" ") && m.endsWith(" ") ? " " : ""));
}

/** text with the token put in at `at`, spaced from the words around it; and the caret after it */
export function putToken(text: string, at: number, end: number, n: number): { text: string; caret: number } {
  const before = text.slice(0, at);
  const after = text.slice(end);
  const tok = `${before && !/\s$/.test(before) ? " " : ""}${imageToken(n)}${/^\s/.test(after) ? "" : " "}`;
  return { text: before + tok + after, caret: before.length + tok.length };
}

/** the pictures the words still name, by number */
export function tokensIn(text: string): Set<number> {
  return new Set([...text.matchAll(TOKEN)].map((m) => Number(m[1])));
}

/**
 * Backspace right after a token (or inside it), or Delete right before it: the whole token goes as
 * one piece, with the space it brought, and the picture with it (`n`). Null: not on a token, or a
 * selection; the key does what it always does.
 */
export function eraseToken(text: string, start: number, end: number, back: boolean): { text: string; caret: number; n: number } | null {
  if (start !== end) return null;
  for (const m of text.matchAll(TOKEN)) {
    const a = m.index!;
    const b = a + m[0].length;
    if (back ? start > a && start <= b : start >= a && start < b) {
      let before = text.slice(0, a);
      let after = text.slice(b);
      if (after.startsWith(" ")) after = after.slice(1);
      else if (before.endsWith(" ")) before = before.slice(0, -1);
      return { text: before + after, caret: before.length, n: Number(m[1]) };
    }
  }
  return null;
}

/**
 * Words pasted with tokens that were cut or copied from an input (`held`: number → picture): each
 * such token brings its picture back. A picture still attached keeps the number it has; one that
 * went with the cut gets its old number back, or the next free one if another picture took it.
 * `back` is what to attach again; the text has the tokens renumbered where they had to be.
 */
export function carryTokens(pasted: string, held: ReadonlyMap<number, string>, nums: ReadonlyMap<string, number>): { text: string; back: [string, number][] } {
  const taken = new Map([...nums].map(([p, n]) => [n, p]));
  const back = new Map<string, number>();
  let top = Math.max(0, ...nums.values());
  const text = pasted.replace(TOKEN, (all, d: string) => {
    const path = held.get(Number(d));
    if (!path) return all;
    let n = nums.get(path) ?? back.get(path);
    if (n === undefined) {
      n = taken.has(Number(d)) ? ++top : Number(d);
      top = Math.max(top, n);
      taken.set(n, path);
      back.set(path, n);
    }
    return imageToken(n);
  });
  return { text, back: [...back] };
}
