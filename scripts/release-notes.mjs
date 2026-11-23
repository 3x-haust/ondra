// The notes of a release, as users read them in the app's "what's new" sheet: in Korean,
// one `## 바뀐 점` heading, then only bullets (`- …`, nested `  - …` allowed). scripts/release.mjs
// refuses notes that don't have that shape; held by tests/releaseNotesFormat.test.ts.
export const HEADING = "## 바뀐 점";
const hangul = /[\uac00-\ud7a3]/;

/** What is wrong with these notes, one line each; [] when they can be published. */
export function notesProblems(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trimEnd());
  const body = lines.filter((l) => l.trim());
  if (body[0] !== HEADING) return [`the notes must start with "${HEADING}" (the first line is "${body[0] ?? ""}")`];
  const problems = [];
  const bullets = body.slice(1);
  if (!bullets.length) problems.push(`no bullets under "${HEADING}": write each change as "- …"`);
  for (const line of bullets) {
    if (!/^\s*- \S/.test(line)) problems.push(`not a bullet: "${line}": every line under "${HEADING}" is "- …"`);
    else if (!hangul.test(line)) problems.push(`not in Korean: "${line}"`);
  }
  return problems;
}
