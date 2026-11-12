/** a part's name as a tag: the name before any explanation ("RAM — 작업 공간" → "RAM"), kept short */
export function short(label: string): string {
  const name = label.split(/\s+[—–-]\s+|:\s|\(/)[0].trim();
  return name.length > 18 ? name.slice(0, 17) + "…" : name;
}
