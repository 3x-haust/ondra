// The /commands in what is being typed that sending will run, so the input can colour them
// as it goes. The same rules as sending: "/name" opening the message (a known command,
// the whole word), and "/skill:name" anywhere for a skill that exists.

/** [start, end) of each command word, in order */
export type Mark = [number, number];

export function commandMarks(text: string, commands: { name: string; skill?: boolean }[]): Mark[] {
  const marks: Mark[] = [];
  const lead = /^(\s*)\/(\S+)/.exec(text);
  if (lead && commands.some((c) => c.name === lead[2])) marks.push([lead[1].length, lead[0].length]);
  for (const m of text.matchAll(/(^|\s)\/(skill:\S+)/g)) {
    const start = m.index + m[1].length;
    if (start === marks[0]?.[0]) continue;
    if (commands.some((c) => c.skill && c.name === m[2])) marks.push([start, start + m[2].length + 1]);
  }
  return marks;
}
