/**
 * Main must never offer work as a question ("원하시면 …", "~할까요?"): what was asked
 * is routed, the rest left out. Models still add such a line at the end now and then,
 * so it is taken out here. Never leaves a text empty; code and tables are left alone.
 */
const OFFER = /원하시면|원하면|필요하시면|필요하면 말씀|말씀만 해|(할|볼|드릴|갈|만들|올릴|넣을|고칠|해 볼|해볼)까요\s*\?|하실래요\s*\?|해 드릴까요/;

export function dropOffers(text: string): string {
  if (!text || !OFFER.test(text)) return text;
  let fence = false;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence || /^\s*```/.test(line) || /^\s*\|/.test(line) || !OFFER.test(line)) {
      out.push(line);
      continue;
    }
    const kept = line
      .split(/(?<=[.!?。])\s+/)
      .filter((s) => !OFFER.test(s))
      .join(" ");
    if (kept.trim() && !/^\s*[-*]\s*$/.test(kept)) out.push(kept);
  }
  const s = out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return s || text;
}
