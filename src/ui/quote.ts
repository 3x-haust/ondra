/** A selection from a reply as a Markdown quote. */
export const asQuote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
