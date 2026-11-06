// Ondra's permission modes, enforced inside the engine.
//   ask   — ask before every edit and every command (reading is free)
//   edits — edits inside the job's folder go through; commands and paths outside ask
//   full  — nothing asks
// Starts from ONDRA_PERMISSION and can be changed mid-run with `/ondra-permission <mode>`.
// Questions go out as ui.select, which Ondra shows as a decision card.
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

type Mode = "ask" | "edits" | "full";
const MODES: Mode[] = ["ask", "edits", "full"];
const ALLOW = "허용";
const DENY = "막기";

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
      const broad = broadKill(String(event.input?.command ?? ""), ctx.cwd);
      if (broad)
        return {
          block: true,
          reason: `\`${broad}\` 는 이름이 같은 사용자의 다른 앱까지 꺼요. 이 일이 띄운 것만 끄세요: \`pgrep -f '<이 작업 폴더 경로>'\`로 PID를 찾아 \`kill <PID>\`, 또는 \`lsof -ti :<포트> | xargs kill\`.`,
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
