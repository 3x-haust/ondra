// Ondra's permission modes, enforced inside the engine.
//   ask   — ask before every edit and every command (reading is free)
//   edits — edits inside the job's folder go through; commands and paths outside ask
//   full  — nothing asks
// Starts from ONDRA_PERMISSION and can be changed mid-run with `/ondra-permission <mode>`.
// Questions go out as ui.select, which Ondra shows as a decision card.
import { isAbsolute, relative, resolve } from "node:path";

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

  pi.on("tool_call", async (event: any, ctx: any) => {
    // in every mode: killing by name also kills the user's own apps (Electron → Discord, VS Code)
    if (event.toolName === "bash") {
      const broad = broadKill(String(event.input?.command ?? ""), ctx.cwd);
      if (broad)
        return {
          block: true,
          reason: `\`${broad}\` 는 이름이 같은 사용자의 다른 앱까지 꺼요. 이 일이 띄운 것만 끄세요: \`pgrep -f '<이 작업 폴더 경로>'\`로 PID를 찾아 \`kill <PID>\`, 또는 \`lsof -ti :<포트> | xargs kill\`.`,
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
