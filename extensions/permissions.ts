// Ondra's permission modes, enforced inside the engine.
//   ask   — ask before every edit and every command (reading is free)
//   auto  — the AI judges: edits inside the job's folder and plainly safe commands (reading, building,
//           testing) go through; anything else is weighed against the job's request by the job's model,
//           which lets it through or asks the user (when unsure, or when it can't tell, it asks).
//           Older Ondra called this slot "edits" (edits in the folder went through, commands asked):
//           "edits" is read as auto.
//   full  — no prompts; safety restrictions still apply
// Starts from ONDRA_PERMISSION and can be changed mid-run with `/ondra-permission <mode>`.
// Questions go out as ui.select, which Ondra shows as a decision card.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { visitShellCommands } from "./lib/shell-commands";

type Mode = "ask" | "auto" | "full";
const MODES: Mode[] = ["ask", "auto", "full"];
/** a mode as given (env, a command, an older app's "edits") */
export const modeOf = (v: unknown): Mode => (v === "edits" ? "auto" : MODES.includes(v as Mode) ? (v as Mode) : "auto");

// ───────────── auto: what needs no judging, and the judge

/** Programs that only read, or build and check inside the folder: they go through without a judgement. */
const QUIET = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "rg", "ag", "fd", "tree", "pwd", "echo", "printf", "which", "type", "file", "stat", "du", "df",
  "diff", "cmp", "sort", "uniq", "cut", "tr", "jq", "yq", "basename", "dirname", "realpath", "readlink", "date", "printenv",
  "true", "false", "test", "[", "sleep", "nl", "column", "less", "more", "od", "xxd", "hexdump", "shasum", "md5", "sha256sum", "tsc", "eslint", "prettier", "biome",
  "vitest", "jest", "pytest", "ruff", "mypy", "cargo-clippy",
]);
/** subcommands that only read or check, per tool */
const QUIET_SUB: Record<string, RegExp> = {
  // (not env, awk, xargs: they run other programs)
  git: /^(status|diff|log|show|rev-parse|ls-files|blame|grep|describe|config --get|stash list|worktree list|fetch|tag --list|shortlog|cat-file|merge-base)\b|^(branch|remote)( (-a|-r|-v|-vv|--list|--show-current|get-url \S+))*$/,
  npm: /^(test|run (test|build|lint|typecheck|check)|ls|view|outdated|ci|install)\b/,
  pnpm: /^(test|build|lint|typecheck|check|run (test|build|lint|typecheck|check)|ls|why|outdated|install|i)\b/,
  yarn: /^(test|build|lint|typecheck|install)\b/,
  bun: /^(test|run (test|build|lint|typecheck)|install)\b/,
  npx: /^(tsc|vitest|jest|eslint|prettier --check|biome check)\b/,
  cargo: /^(check|build|test|clippy|fmt --check|tree|metadata)\b/,
  go: /^(build|test|vet|list|env|version)\b/,
  python: /^(-m (pytest|mypy|ruff|unittest)|--version)\b/,
  python3: /^(-m (pytest|mypy|ruff|unittest)|--version)\b/,
  swift: /^(build|test)\b/,
  xcodebuild: /^(-list|-showBuildSettings)\b|\b(build|test)\b/,
  gh: /^(pr (view|list|diff|checks|status)|issue (view|list)|run (view|list)|repo view|api [^-]*$)/,
  find: /^(?!.*(-delete|-exec|-execdir|-ok)\b)/,
  sed: /^-n\b(?!.*(\bw\b|\s-i\b|--in-place))/,
};

/**
 * A command that needs no judging: every part of it (split on ; && || |) is a quiet program, and it
 * writes nowhere (no > redirect except to /dev/null). Anything else is judged.
 */
export function quietCommand(command: string): boolean {
  const c = command.trim();
  if (!c || /`|\$\(/.test(c)) return false;
  if (/(^|[^>&0-9])>{1,2}\s*(?!\/dev\/null|&)/.test(c.replace(/2>&1|>&2/g, ""))) return false;
  for (const part of c.split(/;|&&|\|\||\||\n/)) {
    const words = part.trim().replace(/^(\w+=\S*\s+)+/, "").split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let [cmd, ...rest] = words;
    if (cmd === "cd") continue;
    cmd = basename(cmd);
    if (QUIET.has(cmd)) continue;
    const sub = QUIET_SUB[cmd];
    if (sub && sub.test(rest.join(" "))) continue;
    return false;
  }
  return true;
}

export type Verdict = { allow: boolean; why: string };

/** What the judge is asked: the job's request, where it works, and the one action. */
export function judgePrompt(task: string, action: string, cwd: string): string {
  return [
    "You decide whether an AI coding job may do one action without asking its user first.",
    "The user picked \"auto\": let through what the job plainly needs for its request and what can be undone;",
    "ask about the rest. When unsure, ask.",
    "",
    "Let through: work inside the job's folder (building, testing, running it, installing its dependencies,",
    "formatting, generating files, local git commits on its own branch, starting local servers on free ports),",
    "reading anything, temporary files, network reads (downloads, docs, APIs that only read).",
    "Ask: deleting or overwriting outside the job's folder or anything not made by this job; git push, force",
    "push, merging into main, releases, deploys, publishing; sending messages, emails, posts, payments;",
    "writing to shared or production systems (databases, cloud resources, other people's issues); sudo,",
    "global installs, system settings; reading or printing secrets, keys, tokens; killing processes it did",
    "not start; anything unrelated to the request; anything the request says to ask about or not to do.",
    "",
    `The job's request:\n${task.slice(0, 2_000) || "(unknown)"}`,
    "",
    `The job's folder: ${cwd}`,
    "",
    `The action:\n${action.slice(0, 2_000)}`,
    "",
    'Answer with JSON only: {"allow": true | false, "why": "<one short line in Korean, 해요체: what this does and why it may go or needs asking>"}',
  ].join("\n");
}

/** The judge's answer; anything unreadable asks. */
export function readVerdict(text: string): Verdict {
  const m = text.match(/\{[\s\S]*\}/);
  try {
    const j = JSON.parse(m?.[0] ?? "");
    return { allow: j.allow === true, why: typeof j.why === "string" ? j.why.slice(0, 200) : "" };
  } catch {
    return { allow: false, why: "" };
  }
}

/** The job's request: its first message from the user. */
function taskOf(ctx: any): string {
  try {
    for (const e of ctx.sessionManager?.getBranch?.() ?? []) {
      if (e?.type !== "message" || e.message?.role !== "user") continue;
      const c = e.message.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("\n") : "";
      if (text.trim()) return text;
    }
  } catch {
    /* no session to read */
  }
  return "";
}

const JUDGE_MS = 20_000;

/** One judgement by the job's own model, quick (no long thinking). It fails closed: no model, no answer, too slow → ask. */
async function judge(ctx: any, action: string): Promise<Verdict> {
  const model = ctx.model;
  if (!model || !ctx.modelRegistry?.streamSimple) return { allow: false, why: "" };
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), JUDGE_MS);
  try {
    const reply = await ctx.modelRegistry
      .streamSimple(model, { messages: [{ role: "user", content: [{ type: "text", text: judgePrompt(taskOf(ctx), action, ctx.cwd) }], timestamp: Date.now() }] }, { reasoning: "minimal", signal: stop.signal })
      .result();
    const text = (reply?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
    return readVerdict(text);
  } catch {
    return { allow: false, why: "" };
  } finally {
    clearTimeout(timer);
  }
}
const ALLOW = "허용";
const DENY = "막기";
const HOST_POLICY = "Mac 앱 조작은 computer 도구(백그라운드 호스트 도우미)로만 하세요. 이 도우미는 앱을 앞으로 가져오거나 커서를 옮기거나 전역 이벤트를 보내지 않고, 매 동작 전후로 전경 앱·키 윈도·마우스가 그대로인지 확인해요. osascript·System Events UI 스크립팅, cliclick, 활성화되는 open, 직접 CGEvent 입력으로 우회하지 마세요. 배경으로 할 수 없는 동작이면 포기하지 말고 그대로 보고하세요.";

/** Conservative command checks, not a shell sandbox or an OS isolation boundary. */
export function hostComputerUse(command: string): string | undefined {
  let hit: string | undefined;
  visitShellCommands(command, ([executable]) => {
    const name = basename(executable);
    if (name === "osascript") hit ??= "호스트 AppleScript 실행";
    if (name === "open") hit ??= "호스트 앱·문서 열기";
  });
  return hit;
}

/**
 * A pkill / killall that names a program instead of something this job owns:
 * killall always, pkill unless its pattern holds a path (the job's folder) or a port.
 */
export function broadKill(command: string, cwd = ""): string | undefined {
  for (const part of command.split(/;|&&|\|\||\||\n/)) {
    const c = part.trim().replace(/^(sudo|command|exec)\s+/, "");
    if (/^killall\b/.test(c)) return c.slice(0, 60);
    if (!/^pkill\b/.test(c)) continue;
    const pattern = c.replace(/^pkill\s+/, "").replace(/(^|\s)-[a-zA-Z0-9]+(\s+(?=-))?/g, " ").trim().replace(/^['"]|['"]$/g, "");
    if (/\//.test(pattern) || (cwd && pattern.includes(cwd)) || /:\d{2,5}\b|--port[= ]\d+/.test(pattern)) continue;
    return c.slice(0, 60);
  }
  return undefined;
}

/**
 * Ondra's own data a job must not read: the app state, and other jobs' logs,
 * worktrees and results (another space's above all). `allowed` are the job ids
 * this job may look at (itself, the job it follows, its steps, its sub-agents).
 * Returns what was touched, or undefined.
 */
export function foreignData(text: string, data: string, allowed: string[], space = ""): string | undefined {
  if (!data || !text.includes(data)) return undefined;
  if (text.includes(`${data}/state.json`)) return "state.json";
  if (text.includes(`${data}/state-before-parts.json`)) return "state-before-parts.json";
  // the state as parts (store.rs): the folder, or anything in it
  const parts = `${data}/state`;
  for (let at = text.indexOf(parts); at >= 0; at = text.indexOf(parts, at + 1)) if (/^(\/|["'`\s]|$)/.test(text.slice(at + parts.length))) return "state/";
  for (const dir of ["sessions", "worktrees", "artifacts", "spaces", "browser"]) {
    const head = `${data}/${dir}/`;
    for (let at = text.indexOf(head); at >= 0; at = text.indexOf(head, at + 1)) {
      // the folder's name ends where a name's characters do: a path quoted in prose or markdown
      // ("…/artifacts/t1`.", "…/artifacts/t1였어요") is still that folder
      const name = (text.slice(at + head.length).match(/^[\w.-]*/)?.[0] ?? "").replace(/\.+$/, "");
      // a space's own folders (its browser, its recipes, its log view)
      if (dir === "browser" || dir === "spaces") {
        if (space && name === space) continue;
        return `${dir}/${name}`;
      }
      if (name && allowed.some((id) => name === id || name.includes(`-${id}`))) continue;
      return `${dir}/${name}`;
    }
  }
  return undefined;
}

/**
 * A command that would bring an app or window in front of the user, take the
 * keyboard or move the mouse: AppleScript activate / frontmost / System Events
 * keystrokes and clicks, and `open` without -g. Returns what it is and the
 * isolated execution requirement, or undefined.
 */
export function focusSteal(command: string): { what: string; how: string } | undefined {
  let what: string | undefined;
  visitShellCommands(command, ([executable, ...args]) => {
    const name = basename(executable);
    if (name === "osascript" && /\bactivate\b|\bset\s+frontmost\b|\bfrontmost\b[^'"]*\bto\s+true\b|\breopen\b/i.test(args.join(" ")))
      what ??= "앱을 앞으로 가져오는 AppleScript";
    if (name === "open") {
      const flags = args.filter((w) => /^-[a-zA-Z]+$/.test(w)).join("");
      if (!/g/.test(flags) && !args.includes("--background")) what ??= "`open` (앱이 앞으로 와요)";
    }
  });
  return what ? { what, how: HOST_POLICY } : undefined;
}

/** Known host input APIs, both system-wide and process-targeted. */
const SYSTEM_EVENT =
  /CGEventPost(?:ToPid)?\s*\(|\.postToPid\s*\(|\.post\s*\(\s*tap\s*:|CGEvent\s*\(\s*(keyboardEventSource|mouseEventSource)|CGEvent\s*\(\s*keyboardEvent|CGEventCreateKeyboardEvent|CGEventCreateMouseEvent|Quartz\.CGEventPost|\.cghidEventTap|\.cgSessionEventTap|kCGHIDEventTap|kCGSessionEventTap|CGEventTapLocation\.(HID|Session)/;
/** The same calls as a binary imports them, including process-targeted input. */
const SYSTEM_EVENT_SYMBOL = /_CGEventPost(?:ToPid)?\b|CGEventPost(?:ToPid)?\x00|_CGEventCreateKeyboardEvent|_CGEventCreateMouseEvent/;

/**
 * A command that types or clicks for the whole system rather than into one app
 * the job launched: code posting CGEvents to the HID or session tap (in the
 * command itself, a heredoc, a source file it compiles or runs, or a binary it
 * runs), cliclick, and AppleScript keystrokes / key codes / clicks. Those land
 * in whatever the user has in front (their terminal, their editor). PID-targeted
 * input is also rejected: process selection does not isolate app side effects.
 */
export function systemInput(command: string, cwd = ""): string | undefined {
  let input: string | undefined;
  visitShellCommands(command, ([executable, ...args]) => {
    const name = basename(executable);
    if (name === "cliclick") input ??= "cliclick";
    if (name === "osascript" && /\b(keystroke|key code|click at)\b/i.test(args.join(" "))) input ??= "AppleScript 키 입력·클릭";
  });
  if (input) return input;
  if (SYSTEM_EVENT.test(command)) return "호스트 키·마우스 이벤트 코드";
  // files the command compiles, runs or reads: their source, or the binary's imports
  for (const m of command.matchAll(/(?:^|[\s'"=])((?:\/|~\/|\.{1,2}\/)?[\w.\/~-]+)/g)) {
    const raw = m[1];
    if (!/\//.test(raw) && !/\.(swift|py|js|mjs|ts|m|c|scpt|applescript)$/.test(raw)) continue;
    const path = raw.startsWith("~/") ? `${process.env.HOME ?? ""}${raw.slice(1)}` : raw.startsWith("/") ? raw : join(cwd, raw);
    try {
      if (!existsSync(path)) continue;
      const st = statSync(path);
      const source = /\.(swift|py|js|mjs|ts|m|c|scpt|applescript)$/.test(path);
      // a binary only when it can be run (an executable the job built), never logs or data
      if (!st.isFile() || st.size > 30_000_000 || (!source && !(st.mode & 0o111))) continue;
      const body = readFileSync(path);
      if (source ? SYSTEM_EVENT.test(body.toString("utf8")) : SYSTEM_EVENT_SYMBOL.test(body.toString("latin1")))
        return `호스트 키·마우스 이벤트 (${raw})`;
    } catch {
      /* unreadable: not ours to judge */
    }
  }
  return undefined;
}

const GH_WRITES: Record<string, RegExp> = {
  issue: /^(create|new|close|reopen|edit|comment|delete|lock|unlock|pin|unpin|transfer|develop)$/,
  pr: /^(create|new|merge|close|reopen|edit|comment|review|ready|lock|unlock)$/,
  release: /^(create|new|delete|edit|upload|delete-asset)$/,
  repo: /^(create|new|delete|edit|rename|fork|archive|unarchive|sync|set-default)$/,
  label: /^(create|edit|delete|clone)$/,
  project: /^(create|close|copy|delete|edit|field-create|field-delete|item-add|item-archive|item-create|item-delete|item-edit|link|unlink|mark-template)$/,
  workflow: /^(run|enable|disable)$/,
  run: /^(cancel|rerun|delete)$/,
  gist: /^(create|new|edit|delete|rename|clone)$/,
  secret: /^(set|delete|remove)$/,
  variable: /^(set|delete|remove)$/,
  cache: /^(delete)$/,
};

/**
 * A `gh` command that changes something on GitHub: comments, issues, PRs, merges,
 * releases, labels, `gh api` with a writing method or fields. Reading stays free.
 */
export function githubWrite(command: string): string | undefined {
  let hit: string | undefined;
  visitShellCommands(command, ([executable, ...args]) => {
    if (basename(executable) !== "gh") return;
    const words = args.filter((a) => !a.startsWith("-"));
    const [group, sub] = words;
    if (group === "api") {
      const method = args.find((a, i) => /^(-X|--method)$/.test(args[i - 1] ?? "") || /^--method=/.test(a))?.replace(/^--method=/, "").toUpperCase();
      const fields = args.some((a) => /^(-f|-F|--field|--raw-field|--input)$/.test(a) || /^--(raw-)?field=/.test(a));
      if ((method && method !== "GET") || (!method && fields)) hit ??= `gh api ${method ?? "POST"}`;
      return;
    }
    if (group && sub && GH_WRITES[group]?.test(sub)) hit ??= `gh ${group} ${sub}`;
  });
  return hit;
}

/**
 * `gh pr merge --delete-branch` run in a linked git worktree (every Ondra job folder): gh merges,
 * then checks out the default branch to delete the local one, which fails because the user's
 * folder already has it checked out, so the remote branch is never deleted.
 */
export function worktreeMergeDelete(command: string, cwd: string): boolean {
  let hit = false;
  visitShellCommands(command, ([executable, ...args]) => {
    if (basename(executable) !== "gh") return;
    const words = args.filter((a) => !a.startsWith("-"));
    if (words[0] === "pr" && words[1] === "merge" && args.some((a) => /^(-d|--delete-branch(=true)?)$/.test(a))) hit = true;
  });
  return hit && linkedWorktree(cwd);
}

/** A folder inside a linked worktree: its `.git` is a file pointing into `<repo>/.git/worktrees/`. */
function linkedWorktree(cwd: string): boolean {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const git = join(dir, ".git");
    if (existsSync(git)) {
      try {
        return statSync(git).isFile() && /\/worktrees\//.test(readFileSync(git, "utf8"));
      } catch {
        return false;
      }
    }
    if (dirname(dir) === dir) return false;
  }
}

const UDID = /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/gi;

/**
 * A simctl / adb / emulator / agent-device command aimed at a device this job may
 * not drive (the other space's, the user's, another job's): the device named, or
 * "all" for every one. `mine` holds the ids, names and serials it may use.
 */
export function foreignDevice(command: string, mine: string[]): string | undefined {
  const ok = (x: string) => mine.some((m) => m.toLowerCase() === x.toLowerCase());
  for (const part of command.split(/;|&&|\|\||\||\n/)) {
    const c = part.trim();
    if (!/\b(simctl|adb|emulator|agent-device)\b/.test(c)) continue;
    if (/\bsimctl\s+(boot|shutdown|erase|delete)\b.*\ball\b/.test(c)) return "all";
    // "booted" is whichever simulator runs, maybe another space's
    if (/\bsimctl\b.*\sbooted\b/.test(c)) return "booted";
    // adb without a device picks the only one running, maybe another space's
    if (/\badb\s+(?!-s\b|devices\b|wait-for-device\b|version\b|start-server\b|kill-server\b|help\b)\w/.test(c) && !/\bANDROID_SERIAL=/.test(c)) return "adb";
    for (const m of c.matchAll(UDID)) if (!ok(m[0])) return m[0];
    const named = [
      ...c.matchAll(/\badb\b[^]*?\s-s\s+['"]?([\w.:-]+)/g),
      ...c.matchAll(/\bANDROID_SERIAL=['"]?([\w.:-]+)/g),
      ...c.matchAll(/--(?:serial|udid|device)[= ]['"]?([^\s'"]+)/g),
      ...c.matchAll(/\bemulator\b[^]*?\s-avd\s+['"]?([^\s'"]+)/g),
    ].map((m) => m[1]);
    for (const n of named) if (!ok(n)) return n;
  }
  return undefined;
}

/** This job's devices: its space's (from the app) and the one it made (from the device tool). */
function jobDevices(): string[] | undefined {
  if (process.env.ONDRA_DEVICES_ALLOWED === undefined) return undefined;
  const out = process.env.ONDRA_DEVICES_ALLOWED.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const m = JSON.parse(readFileSync(join(process.env.APP_ARTIFACTS_DIR || "", ".device.json"), "utf8"));
    out.push(...[m.udid, m.serial, m.name, m.clone].filter(Boolean));
  } catch {
    /* no device made yet */
  }
  return out;
}

export default function (pi: any) {
  let mode: Mode = modeOf(process.env.ONDRA_PERMISSION);
  /** auto's answers this run, so the same action isn't judged twice */
  const judged = new Map<string, Verdict>();

  pi.registerCommand("ondra-permission", {
    description: "Ondra 권한 모드 바꾸기 (ask · auto · full)",
    handler: async (args: string) => {
      const next = args.trim();
      if (next === "edits" || MODES.includes(next as Mode)) {
        mode = modeOf(next);
        // other tools of the job read it too: computer use's confirmations go through on full
        process.env.ONDRA_PERMISSION = mode;
      }
    },
  });

  const inside = (cwd: string, p: unknown) => {
    if (typeof p !== "string" || !p) return false;
    const rel = relative(cwd, resolve(cwd, p));
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
  };

  const data = (process.env.ONDRA_DATA_DIR ?? "").replace(/\/$/, "");
  // unset (a job the user opened to another space): no list to keep it to
  const allowed = process.env.ONDRA_JOBS_ALLOWED?.split(",").filter(Boolean);

  pi.on("tool_call", async (event: any, ctx: any) => {
    // in every mode: Ondra's data of other jobs and the other space stays closed
    if (data && allowed) {
      const hit = foreignData(JSON.stringify(event.input ?? {}), data, allowed, process.env.ONDRA_SPACE_KEY ?? "");
      if (hit) return { block: true, reason: `Ondra 데이터(${hit})는 이 일의 것이 아니에요. 필요한 건 일에 주어진 내용과 작업 폴더에서 찾으세요.` };
    }
    // a watch (background.ts monitor) runs a shell command too: the same rules and questions
    const shell = event.toolName === "bash" || event.toolName === "monitor";
    // in every mode: killing by name also kills the user's own apps (Electron → Discord, VS Code)
    if (shell) {
      const host = hostComputerUse(String(event.input?.command ?? ""));
      if (host) return { block: true, reason: `${host}는 이 실행 경로에서 지원하지 않아요. ${HOST_POLICY}` };
      const broad = broadKill(String(event.input?.command ?? ""), ctx.cwd);
      if (broad)
        return {
          block: true,
          reason: `\`${broad}\` 는 이름이 같은 사용자의 다른 앱까지 꺼요. 이 일이 띄운 것만 끄세요: \`pgrep -f '<이 작업 폴더 경로>'\`로 PID를 찾아 \`kill <PID>\`, 또는 \`lsof -ti :<포트> | xargs kill\`.`,
        };
      // in every mode: reject known host input APIs, including PID-targeted input
      const typed = systemInput(String(event.input?.command ?? ""), ctx.cwd);
      if (typed)
        return {
          block: true,
          reason: `${typed}는 호스트의 입력·포커스 보존을 확인할 수 없어 차단했어요. ${HOST_POLICY}`,
        };
      // A permission choice cannot turn a host action into an isolated action.
      const steal = focusSteal(String(event.input?.command ?? ""));
      if (steal) return { block: true, reason: `${steal.what}는 차단했어요. ${HOST_POLICY}` };
      // the user turned GitHub writes off: reading issues and PRs still works
      if (process.env.ONDRA_GITHUB_WRITE === "0") {
        const gh = githubWrite(String(event.input?.command ?? ""));
        if (gh)
          return {
            block: true,
            reason: `GitHub 쓰기가 꺼져 있어요 (\`${gh}\`). 읽기만 하고, GitHub에 남길 내용은 결과에 적어 사용자에게 넘기세요.`,
          };
      }
      if (worktreeMergeDelete(String(event.input?.command ?? ""), ctx.cwd))
        return {
          block: true,
          reason:
            "`gh pr merge --delete-branch`는 git worktree에서 기본 브랜치로 체크아웃하다 'already used by worktree' 오류로 멈춰 원격 브랜치를 남겨요. `--delete-branch` 없이 합친 뒤 `git push origin --delete <브랜치>`로 원격 브랜치를 지우세요.",
        };
      // in every mode: another space's (or the user's, or another job's) device is off-limits
      const mine = jobDevices();
      const other = mine && foreignDevice(String(event.input?.command ?? ""), mine);
      if (other)
        return {
          block: true,
          reason:
            other === "adb" || other === "booted"
              ? "디바이스를 지정하지 않으면 다른 공간의 디바이스를 건드릴 수 있어요. device 도구를 쓰거나 이 일의 디바이스를 -s / UDID로 지정하세요."
              : `\`${other}\` 는 이 일의 디바이스가 아니에요. device 도구로 이 일의 디바이스를 만들어 쓰세요 (action=start).`,
        };
    }
    if (mode === "full") return undefined;
    const name = event.toolName as string;
    const input = event.input ?? {};
    let question: string | undefined;
    let action = "";
    if (shell) {
      const command = String(input.command ?? "");
      if (mode === "auto" && quietCommand(command)) return undefined;
      question = `명령을 실행해도 될까요?\n\n${command.slice(0, 600)}`;
      action = `Run in a shell (in ${ctx.cwd}):\n${command}`;
    } else if (name === "edit" || name === "write") {
      if (mode === "auto" && inside(ctx.cwd, input.path)) return undefined;
      const where = inside(ctx.cwd, input.path) ? "" : " (작업 폴더 밖)";
      question = `${name === "write" ? "파일을 만들어도" : "파일을 고쳐도"} 될까요?${where}\n\n${input.path ?? ""}`;
      action = `${name === "write" ? "Write the file" : "Edit the file"} ${input.path ?? ""} (outside the job's folder)`;
    } else return undefined;

    // auto: the job's model weighs it; what it lets through goes, the rest is asked with its reason
    if (mode === "auto") {
      const key = `${name}\n${action}`;
      const v = judged.get(key) ?? (await judge(ctx, action));
      if (v.allow) {
        judged.set(key, v);
        return undefined;
      }
      if (v.why) question = `${question}\n\nAI 판단: ${v.why}`;
    }

    if (!ctx.hasUI) return { block: true, reason: "권한 모드 때문에 막았어요 (물어볼 화면이 없어요)" };
    const choice = await ctx.ui.select(question, [ALLOW, DENY]);
    return choice === ALLOW ? undefined : { block: true, reason: "사용자가 막았어요. 다른 방법을 찾거나 물어보세요." };
  });
}
