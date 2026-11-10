/** A selection from a reply as a Markdown quote. */
export const asQuote = (text: string) =>
  text
    .trim()
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");

/** The quotes a message starts with ("> …" paragraphs), and what was said after them. */
export function splitQuotes(text: string): { quotes: string[]; rest: string } {
  const quotes: string[] = [];
  const paras = text.split(/\n{2,}/);
  let i = 0;
  for (; i < paras.length; i++) {
    const lines = paras[i].split("\n");
    if (!lines.every((l) => /^>( |$)/.test(l))) break;
    quotes.push(lines.map((l) => l.replace(/^> ?/, "")).join("\n").trim());
  }
  return { quotes: quotes.filter(Boolean), rest: paras.slice(i).join("\n\n") };
}

/** What is sent: the quotes first, then the words about them. */
export const withQuotes = (quotes: string[], text: string) => [...quotes.map(asQuote), text.trim()].filter(Boolean).join("\n\n");
