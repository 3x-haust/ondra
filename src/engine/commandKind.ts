// What a shell command is, for the loop guard and the proof check:
//   poll  — looking in on something (waits, reads, status of a CI run, a store
//           review, a URL, read-only git, --help): repeating it is waiting, not
//           re-running a check, and its result doesn't go stale when code changes
//   check — tests, type checks, builds, lints: repeating one that passed with
//           nothing changed since is wasted
//   other — everything else

const WAIT = /^(sleep|tail|head|cat|less|ls|ps|pgrep|date|grep|rg|wc|cut|echo|printf|test|\[|cd|for|while|do|done|if|then|else|fi|break|true|jq|sed -n|awk|sort|uniq|stat|file|which|pwd)\b/;
const MUTATE = /\s(-X\s*|--method[= ]\s*|--request[= ]\s*)(POST|PUT|PATCH|DELETE)\b|\s(-d|--data[\w-]*|-F|--form|-f|--field|--raw-field|--input|-T|--upload-file)\b/i;
const STATUS = [
  /^gh\s+(run\s+(view|list|watch)|pr\s+(view|checks|list|status|diff)|release\s+(view|list)|issue\s+(view|list)|repo\s+view|workflow\s+(view|list)|api)\b/,
  /^asc\s+(status|builds?|apps?|versions?|reviews?|list)\b/,
  /^curl\b/,
  /^git\s+(status|log|diff|show|branch|rev-parse|remote|fetch|ls-files|ls-remote|describe|blame|reflog|shortlog|worktree\s+list|stash\s+list|config\s+--get|tag(\s+-l|\s*$))\b/,
  /^xcrun\s+simctl\s+list\b|^adb\s+devices\b|^emulator\s+-list-avds\b/,
];
const HELP = /(^|\s)(--help|-h|help)(\s|$)/;
const CHECK = /(^|[\s/:])(test|tests|typecheck|type-check|tsc|vitest|jest|pytest|build|lint|eslint|clippy|check|check:[\w:-]+|vet|xcodebuild|assemble\w*)(\s|$|:)/;

/** one command of a chain, without env assignments, `timeout N`, `command`, redirects */
function bare(part: string): string {
  return part
    .trim()
    .replace(/^\(+|\)+$/g, "")
    .replace(/^(\w+=("[^"]*"|'[^']*'|\S*)\s+)+/, "")
    .replace(/^(timeout\s+\d+[smh]?\s+|command\s+|exec\s+|time\s+)+/, "")
    .replace(/\s\d?>&?\d?\s*\S*$/g, "")
    .trim();
}

const parts = (cmd: string) => cmd.split(/;|&&|\|\||\||\n/).map(bare).filter(Boolean);

export function commandKind(cmd: string): "poll" | "check" | "other" {
  const ps = parts(cmd);
  if (!ps.length) return "other";
  const look = (p: string) => (STATUS.some((re) => re.test(p)) && !MUTATE.test(` ${p}`)) || HELP.test(p);
  const waits = (p: string) => WAIT.test(p);
  if (ps.every((p) => look(p) || waits(p)) && ps.some((p) => look(p) || /^(sleep|tail|pgrep|ps|date)\b/.test(p))) return "poll";
  if (ps.some((p) => CHECK.test(p) && !look(p))) return "check";
  return "other";
}
