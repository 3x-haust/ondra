// A project's badge: one or two letters on a tint picked from its name, so
// projects can be told apart at a glance (sidebar, job header, results).

const HUES = 8;

/** The badge's letters: the first word's first letter, then a digit in it, the last word's first letter, or its own last letter. Hangul keeps one syllable. */
export function projectLetters(name: string): string {
  const words = name.normalize("NFKC").trim().match(/[\p{L}\p{N}]+/gu) ?? [];
  const first = words[0];
  if (!first) return "·";
  const glyphs = Array.from(first);
  if (/\p{Script=Hangul}/u.test(glyphs[0])) return glyphs[0];
  const second = glyphs.slice(1).find((g) => /\p{N}/u.test(g)) ?? (words.length > 1 ? Array.from(words[words.length - 1])[0] : glyphs[1]);
  return `${glyphs[0]}${second ?? ""}`.toUpperCase();
}

/** A stable tint for a name, 0…7. */
export function projectHue(name: string): number {
  let n = 0;
  for (const g of name.normalize("NFKC").trim().toLowerCase()) n = (n * 31 + (g.codePointAt(0) ?? 0)) % 9973;
  return n % HUES;
}

export function ProjectBadge(props: { name: string; class?: string }) {
  return (
    <span class={`pbadge ${props.class ?? ""}`} data-hue={projectHue(props.name)} aria-hidden="true">
      {projectLetters(props.name)}
    </span>
  );
}
