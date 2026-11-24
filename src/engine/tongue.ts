// What goes to Discord is said to people, in their language. A model answering people who write in
// one script (Korean, Japanese, Russian…) sometimes thinks aloud in English between its words
// ("Sent once at the bottom. Releasing the session.", "The owner spoke within 1 minute…, so take."):
// those lines are its own, never posted. Whose language counts is the words being answered, not
// the agent's voice: someone writing English gets English, kept as it is.

/** a letter of a script other than Latin (Hangul, kana, Han, Cyrillic, Arabic…) */
const OTHER = /(?!\p{Script=Latin})\p{L}/u;
const WORD = /\b[A-Za-z]{2,}\b/g;

/** whether the text has letters of a non-Latin script */
export const nonLatin = (text?: string) => !!text && OTHER.test(text);

/** a line of Latin-script prose: no other script, no code (backticks) or link, `least` words or more */
const latinProse = (line: string, least: number) => {
  const s = line.trim();
  if (!s || OTHER.test(s) || s.includes("`") || /https?:\/\//.test(s)) return false;
  return (s.match(WORD) ?? []).length >= least;
};

/** whether the people answered write in a non-Latin script (and not also in a Latin one) */
export function otherScript(...heard: (string | undefined)[]): boolean {
  const said = heard.filter(Boolean).join("\n");
  return nonLatin(said) && !said.split("\n").some((l) => latinProse(l, 2));
}

/** a line of English prose (four words or more), as thinking aloud reads */
export const englishLine = (line: string) => latinProse(line, 4);

/** What is for them: when they write in a non-Latin script, the reply's English-prose lines are the
 *  model's own and dropped (code blocks kept as they are); else it is kept whole. */
export function forThem(text: string, ...heard: (string | undefined)[]): string {
  if (!otherScript(...heard)) return text;
  let fence = false;
  return text
    .split("\n")
    .filter((l) => {
      if (/^\s*```/.test(l)) return (fence = !fence), true;
      return fence || !englishLine(l);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
