// What goes to Discord is said to people, in their language. A model writing for Korean speakers
// sometimes thinks aloud in English between its words ("Sent once at the bottom. Releasing the
// session.", "The owner spoke within 1 minute…, so take."): those lines are its own, never posted.

const HANGUL = /[가-힣]/;

/** whether the talk is in Korean: any of these has Hangul */
export const isKorean = (...texts: (string | undefined)[]) => texts.some((t) => !!t && HANGUL.test(t));

/** a line in English prose: no Hangul, no code (backticks), four words or more */
export function englishLine(line: string): boolean {
  const s = line.trim();
  if (!s || HANGUL.test(s) || s.includes("`")) return false;
  return (s.match(/\b[A-Za-z]{2,}\b/g) ?? []).length >= 4;
}

/** What is for them: in Korean talk, its English lines are dropped (code blocks kept as they are). */
export function forThem(text: string, korean: boolean): string {
  if (!korean) return text;
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
