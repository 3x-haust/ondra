/**
 * The page a job's browser was last on, read from its browser steps: a real
 * address in the command ("open http://localhost:8137/study"), else the
 * argument of an open ("open stopic.mmhs.app"). Other words that look like a
 * domain are not pages ("storage local remove stopic.token", "screenshot a.png").
 */
export function lastPage(targets: string[]): string | undefined {
  for (const t of [...targets].reverse()) {
    const url = t.match(/https?:\/\/[^\s'"`<>)]+/)?.[0];
    if (url) return url;
    const arg = t.match(/^(?:open|goto|navigate)\s+['"]?([\w-]+(?:\.[\w-]+)*\.[a-z]{2,}(?::\d+)?(?:\/[^\s'"]*)?)/i)?.[1];
    if (arg && !/\.(png|jpe?g|gif|webp|html?|json|txt|md|pdf)$/i.test(arg.split("/")[0])) return `https://${arg}`;
  }
  return undefined;
}
