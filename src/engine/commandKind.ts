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

/** a heredoc's body is a script's text (python, a file being written), not commands */
const dropHeredocs = (cmd: string) => cmd.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?(\n\s*\2\s*(?=\n|$)|$)/g, "<<$2");
/** the chain's commands, each without the loop or group word in front of it (`do vitest run`) */
const steps = (cmd: string) => parts(dropHeredocs(cmd)).map((p) => p.replace(/^((do|then|else|elif|\{|\()\s+)+/, "")).filter(Boolean);

// Reading, printing and searching run nothing, whatever they read: `sed -n 1,18p
// src/__tests__/a.test.tsx` is no test, `rg "next build"` no build, `ls build` no
// check. Nor are the shell's own `test -f` and `[`.
const READS = /^(?:\S*\/)?(sed|cat|head|tail|less|more|bat|nl|wc|ls|tree|stat|file|rg|grep|egrep|fgrep|ag|ack|awk|jq|yq|cut|sort|uniq|diff|echo|printf|find|fd|du|which|pwd|test|\[)(?=\s|$)|^git\s+(grep|log|show|diff|status|blame)\b/;
export const onlyReads = (part: string) => READS.test(part);
/** paths and file names in a command (`src/a.test.ts`, `./gradlew`): what it reads or writes, not what it runs */
const noPaths = (p: string) => p.replace(/(['"]?)[^\s'"]*(\/|\.[A-Za-z]{1,5}\b)[^\s'"]*\1/g, " ");
const TEST = /\b(test|vitest|jest|pytest|mocha|cargo test|go test)\b/;
/** a script named for tests (`bash scripts/test.sh`, `./test-e2e.sh`, `python3 test_api.py`) */
const TEST_SCRIPT = /^(?:(?:bash|sh|zsh|node|python3?|bun|deno|tsx)\s+)?(?:\S*\/)?(?:[^\s/]*[-_.])?tests?(?:[-_.][^\s/]*)?\.(sh|m?js|cjs|ts|py)(\s|$)/;

/** A command that runs tests (`pnpm test`, `bunx vitest run src/a.test.ts`, `cargo test`), not one that reads a test file. */
export const isTestRun = (cmd: string) => steps(unwrap(cmd)).some((p) => !onlyReads(p) && (TEST.test(noPaths(p)) || TEST_SCRIPT.test(p)));

/** A command that runs `program` itself, not one that reads or searches for its name (`rg ondra-browser`). */
export const runsProgram = (cmd: string, program: RegExp) => steps(unwrap(cmd)).some((p) => !onlyReads(p) && program.test(p));

export function commandKind(cmd: string): "poll" | "check" | "other" {
  const ps = steps(cmd);
  if (!ps.length) return "other";
  const look = (p: string) => (STATUS.some((re) => re.test(p)) && !MUTATE.test(` ${p}`)) || HELP.test(p);
  const waits = (p: string) => WAIT.test(p);
  if (ps.every((p) => look(p) || waits(p)) && ps.some((p) => look(p) || /^(sleep|tail|pgrep|ps|date)\b/.test(p))) return "poll";
  if (ps.some((p) => CHECK.test(p) && !look(p) && !onlyReads(p))) return "check";
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

// Waiting for something local to come up: a loop that sleeps until a dev server
// answers (curl localhost, nc -z, lsof -i) or its log shows it is ready. A local
// server is up within a minute or two or not at all (it crashed, the port was
// taken, Ondra restarted). Waits on CI, a store review or a build's exit file
// are other waits: they keep their own deadlines.
const LOOP = /\b(for|while|until)\b[\s\S]*\bsleep\b/;
const LOCAL = /\b(curl|wget)\b[^|;&\n]*(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])|\bnc\s+(-\w+\s+)*-\w*z|\blsof\b[^|;&\n]*-i\s*[:\w]/;
// what a dev server prints once it is up ("Ready in 2s", "Local: http://…", "listening on 3000");
// not a store state (READY_FOR_SALE)
const READY = /listen|local:|started|running (at|on)|localhost|127\.0\.0\.1|https?:\/\/|server|vite|metro|watching|serving/i;
const isReady = (pattern: string) => /\b[Rr]eady\b/.test(pattern) || READY.test(pattern);
// grep's pattern (not its file: "server-test.log" waiting for EXIT is a test run)
const GREP_PATTERN = /\b[ef]?grep\s+(?:(?:-m\s*\d+|-[\w-]+)\s+)*(?:'([^']*)'|"([^"]*)"|([^\s|;&]+))/g;
const readyGrep = (cmd: string) => [...cmd.matchAll(GREP_PATTERN)].some((m) => isReady(m[1] ?? m[2] ?? m[3] ?? ""));

/** A command that waits for a local server or a "ready" log line. */
export const isLocalWait = (cmd: string) => /(^|[\s;&|(])(npx\s+)?wait-on\s/.test(cmd) || (LOOP.test(cmd) && (LOCAL.test(cmd) || readyGrep(cmd)));

/** How long a local wait may go without new output before Ondra stops it. */
export const WAIT_STALL_MS = 120_000;

/**
 * A wait on a local server or log line that has shown nothing new for
 * WAIT_STALL_MS: what it waits for isn't coming. A wait that prints as it
 * goes (one line per page it checks) is still moving.
 */
export function waitStalled(s: { command: string; startedAt: number; changedAt?: number; endedAt?: number }, now: number, ms = WAIT_STALL_MS): boolean {
  if (s.endedAt || !isLocalWait(s.command)) return false;
  return now - Math.max(s.startedAt, s.changedAt ?? 0) >= ms;
}

/**
 * Text that `ps` shows for the shell running this command (`/bin/bash -c <command>`)
 * and for no other command running beside it: the longest piece of its first line
 * that ps prints as is (it escapes newlines, tabs and backslashes). Parallel calls
 * often start alike (`cd <worktree> && …`), so a piece they share never counts.
 * None long enough to tell them apart: undefined.
 */
export function shellArg(cmd: string, others: string[] = []): string | undefined {
  const pieces = cmd.split("\n")[0].split(/[\t\\]/).map((p) => p.trim());
  const ok = pieces.filter((p) => p.length >= 12 && !others.some((o) => o.includes(p)));
  return ok.sort((a, b) => b.length - a.length)[0];
}
