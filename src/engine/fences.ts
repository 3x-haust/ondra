// Agents talk to the app in fenced JSON: ```blocks (one object per line) for
// workers, ```route for the captain.

const fenceRe = (lang: string) => new RegExp("```" + lang + "[^\\n]*\\n([\\s\\S]*?)```", "g");

function parseBody(body: string): any[] {
  const trimmed = body.trim();
  if (!trimmed) return [];
  try {
    const whole = JSON.parse(trimmed);
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    // one object per line
  }
  const out: any[] = [];
  for (const line of trimmed.split("\n")) {
    const l = line.trim().replace(/,$/, "");
    if (!l.startsWith("{")) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* a half-written or broken line: skip it */
    }
  }
  return out;
}

/** Complete fences found in text[from..]; returns objects and where scanning stopped. */
export function readFences(text: string, lang: string, from = 0): { items: any[]; end: number } {
  const re = fenceRe(lang);
  re.lastIndex = from;
  const items: any[] = [];
  let end = from;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    items.push(...parseBody(m[1]));
    end = re.lastIndex;
  }
  return { items, end };
}

/** Prose left after removing every fence. */
export const prose = (text: string) => text.replace(/```[\s\S]*?(```|$)/g, "").trim();
