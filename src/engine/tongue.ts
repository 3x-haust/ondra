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

/** small words of English grammar: a line built on them is English, whatever names sit in it */
const GLUE = /\b(the|a|an|to|for|of|in|on|at|with|from|and|but|so|then|now|next|is|are|was|be|it|this|that|i|i'll|i'm|let|let's|we|you|my|not|no|done|good|ok|okay)\b/i;

/** a line of English prose, as thinking aloud reads: four words or more; or three or more built on
 *  English grammar with a name of another script in it ("Next reel for 민정원.") */
export function englishLine(line: string): boolean {
  if (latinProse(line, 4)) return true;
  const s = line.trim();
  if (!s || s.includes("`") || /https?:\/\//.test(s)) return false;
  const words = s.match(WORD) ?? [];
  if (words.length < 3 || !words.some((w) => GLUE.test(w))) return false;
  // mostly Latin letters: the other script is a name or two, not the sentence
  const letters = [...s].filter((c) => /\p{L}/u.test(c));
  const other = letters.filter((c) => OTHER.test(c)).length;
  return other / Math.max(1, letters.length) <= 0.35;
}

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
