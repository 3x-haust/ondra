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

// Searches and listings walk a folder tree: from a small project folder they are
// quick, from ~ or / they can run for many minutes and print nothing.
//   `rg foo src | head` still counts: rg walks src either way, and while it prints
//   it isn't stalled. Plain `grep foo file` and `ls` read one place: not searches.
const WALK = /^(?:\S*\/)?(find|fd|fdfind|rg|ag|mdfind|locate|tree|du)(?=\s|$)/;
const LS_R = /^(?:\S*\/)?ls(?=\s)(?:.*\s)?(-[a-zA-Z]*R|--recursive)/;
const GREP_R = /^(?:\S*\/)?[ef]?grep(?=\s)(?:.*\s)?(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)(?=\s|$)/;

/** `$(…)`, backticks and `<(…)` run their own commands: `list=$(find .)` is a find */
const unwrap = (cmd: string) => cmd.replace(/\$\(|`|<\(/g, "\n");
// a quote cut by the chain split (`rg 'a|b'`) leaves a stray mark: drop it too
const words = (s: string) => (s.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((w) => w.replace(/^['"]|['"]$/g, ""));

/**
 * The first search or listing in a shell command: its program and first
 * argument, as they show in `ps` (no argument when the shell rewrites it:
 * variables, globs; `~` stays for the caller to expand).
 */
export function searchCall(cmd: string): { program: string; arg?: string } | undefined {
  const p = parts(unwrap(cmd))
    .map((x) => x.replace(/^((sudo|env|nohup|nice|builtin|do|then|else)\s+)+/, ""))
    .find((x) => WALK.test(x) || LS_R.test(x) || GREP_R.test(x));
  if (!p) return undefined;
  const [first, arg] = words(p);
  const program = first.split("/").pop()!;
  return { program, arg: arg && !/[$*?[{`]/.test(arg) ? arg : undefined };
}

/** A command that walks folders looking for files or text (find, rg, grep -r, du, ls -R, mdfind, tree …). */
export const isSearch = (cmd: string) => !!searchCall(cmd);

/** How long a search may go without new output before Ondra stops it. */
export const SEARCH_STALL_MS = 90_000;

/**
 * A running search whose output hasn't changed for SEARCH_STALL_MS: it is walking
 * a folder far too big (~, Library), not about to finish. Background commands
 * and anything that isn't a search are never stale.
 */
export function searchStalled(s: { command: string; startedAt: number; changedAt?: number; endedAt?: number; background?: boolean }, now: number, ms = SEARCH_STALL_MS): boolean {
  if (s.endedAt || s.background || !isSearch(s.command)) return false;
  return now - Math.max(s.startedAt, s.changedAt ?? 0) >= ms;
}
