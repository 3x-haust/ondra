// Ondra's permission modes, enforced inside the engine.
//   ask   — ask before every edit and every command (reading is free)
//   edits — edits inside the job's folder go through; commands and paths outside ask
//   full  — no prompts; safety restrictions still apply
// Starts from ONDRA_PERMISSION and can be changed mid-run with `/ondra-permission <mode>`.
// Questions go out as ui.select, which Ondra shows as a decision card.
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { visitShellCommands } from "./lib/shell-commands";

type Mode = "ask" | "edits" | "full";
const MODES: Mode[] = ["ask", "edits", "full"];
const ALLOW = "허용";
const DENY = "막기";
const GUEST_ONLY = "Mac 앱 조작은 별도 macOS 게스트 안에서만 실행하세요. 게스트가 준비되지 않았으면 중단하고 준비가 필요하다고 알려주세요. 호스트 앱 실행·AX·PID 입력이나 전경 조작으로 우회하지 마세요.";

/** Conservative command checks, not a shell sandbox or an OS isolation boundary. */
export function hostComputerUse(command: string): string | undefined {
  let hit: string | undefined;
  visitShellCommands(command, ([executable]) => {
    const name = basename(executable);
    if (/^agent-desktop(?:-macos-helper)?$/.test(name)) hit ??= "호스트 데스크톱 도구";
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
  for (const dir of ["sessions", "worktrees", "artifacts", "spaces", "browser"]) {
    const head = `${data}/${dir}/`;
    for (let at = text.indexOf(head); at >= 0; at = text.indexOf(head, at + 1)) {
      const name = text.slice(at + head.length).split(/[/\s'"\\]/)[0];
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
 * keystrokes and clicks, `open` without -g, and agent-desktop's headed and
 * focus commands (or `press` without --app). Returns what it is and the
 * isolated execution requirement, or undefined.
 */
export function focusSteal(command: string): { what: string; how: string } | undefined {
  let what: string | undefined;
  visitShellCommands(command, ([executable, ...args]) => {
    const name = basename(executable);
    const c = [name, ...args].join(" ");
    if (name === "osascript" && /\bactivate\b|\bset\s+frontmost\b|\bfrontmost\b[^'"]*\bto\s+true\b|\breopen\b/i.test(args.join(" ")))
      what ??= "앱을 앞으로 가져오는 AppleScript";
    if (name === "open") {
      const flags = args.filter((w) => /^-[a-zA-Z]+$/.test(w)).join("");
      if (!/g/.test(flags) && !args.includes("--background")) what ??= "`open` (앱이 앞으로 와요)";
    }
    if (name !== "agent-desktop") return;
    const sub = c.match(/\bagent-desktop\s+(?:--?[\w-]+(?:\s+(?!-)\S+)?\s+)*?([\w-]+)/)?.[1] ?? "";
    if (/^(focus|focus-window|maximize|hover|drag|cursor-overlay)$|^mouse-/.test(sub) || /--activate\b|--headed\b|--xy\b|--cursor\b/.test(c))
      what ??= `agent-desktop ${sub || "앞으로 가져오는 옵션"}`;
    if (sub === "press" && !args.includes("--app"))
      what ??= "`agent-desktop press` (--app 없이 쓰면 사용자가 보는 앱에 키가 가요)";
  });
  return what ? { what, how: GUEST_ONLY } : undefined;
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
  let mode: Mode = MODES.includes(process.env.ONDRA_PERMISSION as Mode) ? (process.env.ONDRA_PERMISSION as Mode) : "edits";

  pi.registerCommand("ondra-permission", {
    description: "Ondra 권한 모드 바꾸기 (ask · edits · full)",
    handler: async (args: string) => {
      const next = args.trim() as Mode;
      if (MODES.includes(next)) mode = next;
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
    // in every mode: killing by name also kills the user's own apps (Electron → Discord, VS Code)
    if (event.toolName === "bash") {
      const host = hostComputerUse(String(event.input?.command ?? ""));
      if (host) return { block: true, reason: `${host}는 이 실행 경로에서 지원하지 않아요. ${GUEST_ONLY}` };
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
          reason: `${typed}는 호스트의 입력·포커스 보존을 확인할 수 없어 차단했어요. ${GUEST_ONLY}`,
        };
      // A permission choice cannot turn a host action into an isolated action.
      const steal = focusSteal(String(event.input?.command ?? ""));
      if (steal) return { block: true, reason: `${steal.what}는 차단했어요. ${GUEST_ONLY}` };
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
    if (name === "bash") {
      question = `명령을 실행해도 될까요?\n\n${String(input.command ?? "").slice(0, 600)}`;
    } else if (name === "edit" || name === "write") {
      if (mode === "edits" && inside(ctx.cwd, input.path)) return undefined;
      const where = inside(ctx.cwd, input.path) ? "" : " (작업 폴더 밖)";
      question = `${name === "write" ? "파일을 만들어도" : "파일을 고쳐도"} 될까요?${where}\n\n${input.path ?? ""}`;
    } else return undefined;

    if (!ctx.hasUI) return { block: true, reason: "권한 모드 때문에 막았어요 (물어볼 화면이 없어요)" };
    const choice = await ctx.ui.select(question, [ALLOW, DENY]);
    return choice === ALLOW ? undefined : { block: true, reason: "사용자가 막았어요. 다른 방법을 찾거나 물어보세요." };
  });
}
