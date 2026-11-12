// Agents talk to the app in fenced JSON: ```blocks (one object per line) for
// workers, ```route for the captain, and a few others for helpers. A JSON fence
// ends at the first ``` outside a JSON string, so an answer that carries its own
// fence (a ```board, a code block) inside a string doesn't cut the route short.
// Any other fence (code, a board) ends at a ``` that starts a line.

const JSON_FENCES = new Set(["route", "blocks", "tidy", "pieces", "suggest"]);

type Span = { lang: string; start: number; body: string; end: number; closed: boolean };

/** where a JSON body's fence closes: the first ``` not inside a string, or -1 */
function closeJson(text: string, from: number): number {
  let inStr = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "`" && text.startsWith("```", i)) return i;
  }
  return -1;
}

/** where any other fence closes: a ``` at the start of a line, or -1 */
function closeLine(text: string, from: number): number {
  const m = /(^|\n)[ \t]*```/g;
  m.lastIndex = from === 0 ? 0 : from - 1;
  const hit = m.exec(text);
  return hit ? hit.index + hit[0].length - 3 : -1;
}

function spans(text: string, from = 0): Span[] {
  const out: Span[] = [];
  let i = from;
  for (;;) {
    const open = text.indexOf("```", i);
    if (open < 0) break;
    const nl = text.indexOf("\n", open + 3);
    const info = text.slice(open + 3, nl < 0 ? text.length : nl).trim();
    const lang = info.split(/\s/)[0] ?? "";
    if (nl < 0) {
      out.push({ lang, start: open, body: "", end: text.length, closed: false });
      break;
    }
    const close = JSON_FENCES.has(lang) ? closeJson(text, nl + 1) : closeLine(text, nl + 1);
    if (close < 0) {
      out.push({ lang, start: open, body: text.slice(nl + 1), end: text.length, closed: false });
      break;
    }
    out.push({ lang, start: open, body: text.slice(nl + 1, close), end: close + 3, closed: true });
    i = close + 3;
  }
  return out;
}

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
  const items: any[] = [];
  let end = from;
  for (const s of spans(text, from)) {
    if (!s.closed || !s.lang.startsWith(lang)) continue;
    items.push(...parseBody(s.body));
    end = s.end;
  }
  return { items, end };
}

/** a JSON string's value from just after its opening quote, as far as it has come */
function partialString(s: string, i: number): string {
  let out = "";
  for (; i < s.length; i++) {
    const c = s[i];
    if (c === '"') break;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) break;
    if (n === "u") {
      const hex = s.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += ({ n: "\n", t: "\t", r: "", b: "", f: "" } as Record<string, string>)[n] ?? n;
    i++;
  }
  return out;
}

/**
 * The answer main is still writing inside its ```route: the "text" of the
 * answer route, as far as it has come, so the chat can show it (and draw its
 * board) while it is written. Empty until an answer's text has started.
 */
export function draftAnswer(text: string): string {
  const open = text.lastIndexOf("```route");
  if (open < 0) return "";
  const body = text.slice(open);
  const m = /"(?:kind|type)"\s*:\s*"answer"[^{}]*?"text"\s*:\s*"/.exec(body);
  return m ? partialString(body, m.index + m[0].length) : "";
}

/**
 * Text left after removing the app's own fences (finished or still being written).
 * Fences meant for the reader (a board, code) stay.
 */
export function prose(text: string): string {
  let out = "";
  let at = 0;
  for (const s of spans(text)) {
    // a fence whose name is still coming in is hidden until it is known
    const hide = JSON_FENCES.has(s.lang) || (!s.closed && !text.includes("\n", s.start));
    if (!hide) continue;
    out += text.slice(at, s.start);
    at = s.end;
  }
  return (out + text.slice(at)).trim();
}
