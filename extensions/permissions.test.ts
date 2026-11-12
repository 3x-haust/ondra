import { afterEach, describe, expect, it, vi } from "vitest";
import permissions, { focusSteal, foreignData, githubWrite, hostComputerUse, systemInput } from "./permissions";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => vi.unstubAllEnvs());

// Exercise the engine hook without dispatching shell commands or GUI input.
describe("host computer-use boundary", () => {
  it.each([
    "agent-desktop launch Calculator",
    "agent-desktop press cmd+n --app Calculator",
    "agent-desktop click @s1:e2",
    `agent-desktop batch '[{"command":"launch","args":{"app":"Calculator","activate":true}}]'`,
    `sh -c 'agent-desktop launch Calculator --activate'`,
    '"/Applications/Ondra.app/Contents/MacOS/agent-desktop" click @s1:e2',
    "open -g -a TextEdit document.txt",
    "open -gj -a Calculator",
    "open -a Calculator",
    `sh -c 'open -g -a Calculator'`,
    '"/usr/bin/open" -g -a Calculator',
    `osascript -e 'tell application "TextEdit" to activate'`,
    `python3 -c 'import Quartz; Quartz.CGEventPostToPid(123, event)'`,
  ])("refuses %s even with full permissions and a UI", async (command) => {
    vi.stubEnv("ONDRA_PERMISSION", "full");
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const select = vi.fn().mockResolvedValue("이 일에서는 계속 허용");
    permissions({ registerCommand: vi.fn(), on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn) });

    const result = await handlers.get("tool_call")!({ toolName: "bash", input: { command } }, { cwd: process.cwd(), hasUI: true, ui: { select } });

    expect(result).toMatchObject({ block: true });
    expect(select).not.toHaveBeenCalled();
  });
});

describe.each(["full", "ask"])("shell execution contexts in %s mode", (mode) => {
  async function decision(command: string) {
    vi.stubEnv("ONDRA_PERMISSION", mode);
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    const select = vi.fn().mockResolvedValue("허용");
    permissions({ registerCommand: vi.fn(), on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn) });
    const result = await handlers.get("tool_call")!({ toolName: "bash", input: { command } }, { cwd: process.cwd(), hasUI: true, ui: { select } });
    return { result, select };
  }

  it.each([
    `bash -lc 'open -g -a Calculator'`,
    `printf "%s" "$(open -g -a Calculator)"`,
    `env FOO=bar open -g -a Calculator`,
    `bash <<'EOF'\nopen -g -a Calculator\nEOF`,
    `sh <<EOF\nopen -g -a Calculator\nEOF`,
    `bash -lc 'agent-desktop launch Calculator'`,
    `printf "%s" "$(agent-desktop launch Calculator)"`,
    `env FOO=bar osascript -e 'return 1'`,
    `sh <<'EOF'\nagent-desktop launch Calculator\nEOF`,
    `cat <<EOF\n$(open -g -a Calculator)\nEOF`,
    'printf "%s" "`open -g -a Calculator`"',
    `printf "%s" "$(printf '%s' "$(open -g -a Calculator)")"`,
  ])("blocks executable GUI commands: %s", async (command) => {
    const { result, select } = await decision(command);
    expect(result).toMatchObject({ block: true });
    expect(select).not.toHaveBeenCalled();
  });

  it.each([
    `rg -n "agent-desktop" skills`,
    `git log --oneline --grep=osascript`,
    `rg -n 'osascript.*activate' skills`,
    `rg -n 'osascript keystroke' skills`,
    `rg -n agent-desktop skills -- --activate`,
    `printf '%s' '$(open -g -a Calculator)'`,
    `bash -lc 'rg -n "agent-desktop" skills'`,
    `cat <<'EOF'\nagent-desktop launch Calculator\n$(open -g -a Calculator)\nEOF`,
    `python3 notes.py <<'EOF'\n{"title":"open source driver"}\nEOF`,
  ])("allows search terms and document data: %s", async (command) => {
    const { result, select } = await decision(command);
    expect(result).toBeUndefined();
    expect(select).toHaveBeenCalledTimes(mode === "ask" ? 1 : 0);
  });
});

describe("host command detection", () => {
  it.each([
    "git status --short",
    "pnpm openapi:gen",
    `echo "done | open it later"`,
    `python3 notes.py <<'EOF'\n{"title":"open source driver"}\nopen questions\nEOF`,
  ])("does not reject ordinary work: %s", (command) => {
    expect(hostComputerUse(command)).toBeUndefined();
  });
});

const D = "/Users/me/Library/Application Support/ondra";
describe("foreignData", () => {
  const ok = ["t1", "t0"];
  it("lets a job read its own worktree, log and results", () => {
    expect(foreignData(`cat "${D}/worktrees/app-t1/src/a.ts"`, D, ok, "home")).toBeUndefined();
    expect(foreignData(`rg x ${D}/sessions/t0/a.jsonl`, D, ok, "home")).toBeUndefined();
    expect(foreignData(`ls ${D}/artifacts/t1`, D, ok, "home")).toBeUndefined();
    expect(foreignData(`ls ${D}/browser/home/recipes/github.com`, D, ok, "home")).toBeUndefined();
  });
  it("blocks the app state and anything of other jobs or the other space", () => {
    expect(foreignData(`cat ${D}/state.json`, D, ok, "home")).toBe("state.json");
    expect(foreignData(`rg token ${D}/sessions/t9/x.jsonl`, D, ok, "home")).toBe("sessions/t9");
    expect(foreignData(`ls ${D}/sessions/`, D, ok, "home")).toBe("sessions/");
    expect(foreignData(`cat ${D}/worktrees/app-t9/.env`, D, ok, "home")).toBe("worktrees/app-t9");
    expect(foreignData(`ls ${D}/browser/work/recipes`, D, ok, "home")).toBe("browser/work");
    expect(foreignData(`ls ${D}/spaces/work/logs`, D, ok, "home")).toBe("spaces/work");
  });
  it("leaves paths outside the data folder alone", () => {
    expect(foreignData("cat ~/projects/app/README.md", D, ok, "home")).toBeUndefined();
  });
});

describe("focusSteal", () => {
  it("catches what brings a window in front of the user", () => {
    expect(focusSteal(`osascript -e 'tell application "TextEdit" to activate'`)?.what).toMatch(/AppleScript/);
    expect(focusSteal("open -a TextEdit note.txt")).toBeDefined();
    expect(focusSteal("cd x && open https://example.com")).toBeDefined();
    expect(focusSteal("agent-desktop launch Calculator --activate")).toBeDefined();
    expect(focusSteal("agent-desktop focus-window --app Notes")).toBeDefined();
    expect(focusSteal("agent-desktop mouse-click --xy 10,10")).toBeDefined();
    expect(focusSteal('agent-desktop click @s1:e2 --headed --session "$SID"')).toBeDefined();
    expect(focusSteal('agent-desktop press cmd+k --session "$SID"')?.what).toMatch(/press/);
  });
  it("only detects explicit foreground requests, not isolation", () => {
    expect(focusSteal("open -g -a TextEdit note.txt")).toBeUndefined();
    expect(focusSteal("open -gj -a Calculator")).toBeUndefined();
    expect(focusSteal(`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`)).toBeUndefined();
    expect(focusSteal('agent-desktop press cmd+k --app Electron --session "$SID"')).toBeUndefined();
    expect(focusSteal('agent-desktop --session "$SID" snapshot --app Pebble -i')).toBeUndefined();
    expect(focusSteal('agent-desktop click @s1:e2 --session "$SID"')).toBeUndefined();
    expect(focusSteal("agent-desktop launch Calculator")).toBeUndefined();
    expect(focusSteal("git log --oneline | head")).toBeUndefined();
    expect(focusSteal("pnpm openapi:gen")).toBeUndefined();
  });
});

describe("systemInput", () => {
  const dir = mkdtempSync(join(tmpdir(), "si-"));
  writeFileSync(join(dir, "keys.swift"), "let s = CGEventSource(stateID: .hidSystemState)\nlet e = CGEvent(keyboardEventSource: s, virtualKey: 0, keyDown: true)\ne?.post(tap: .cghidEventTap)\n");
  writeFileSync(join(dir, "pid.swift"), "let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)\ne?.postToPid(pid)\n".replace("CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)", "makeKey()"));
  writeFileSync(join(dir, "keys"), Buffer.from("\x00\x00_CGEventPost\x00_CGEventSourceCreate\x00", "latin1"), { mode: 0o755 });
  writeFileSync(join(dir, "pidbin"), Buffer.from("\x00_CGEventPostToPid\x00", "latin1"), { mode: 0o755 });
  writeFileSync(join(dir, "notes.log"), "_CGEventPost seen in a crash log\n");
  it("blocks keys and clicks made for the whole system", () => {
    expect(systemInput(`swiftc ${dir}/keys.swift -o /tmp/k && /tmp/k`)).toMatch(/keys\.swift/);
    expect(systemInput(`swift ${dir}/keys.swift`)).toBeDefined();
    expect(systemInput(`${dir}/keys`)).toBeDefined();
    expect(systemInput("cat > /tmp/k.swift <<'EOF'\nlet e = CGEvent(keyboardEventSource: nil, virtualKey: 1, keyDown: true)\ne?.post(tap: .cghidEventTap)\nEOF\nswift /tmp/k.swift")).toBeDefined();
    expect(systemInput(`python3 -c "import Quartz; Quartz.CGEventPost(Quartz.kCGHIDEventTap, e)"`)).toBeDefined();
    expect(systemInput("cliclick c:100,200")).toBe("cliclick");
    expect(systemInput(`osascript -e 'tell application "System Events" to keystroke "v" using command down'`)).toBeDefined();
    expect(systemInput(`osascript -e 'tell application "System Events" to key code 36'`)).toBeDefined();
  });
  it("rejects PID-targeted input in source and executable imports", () => {
    expect(systemInput(`swift ${dir}/pid.swift`)).toBeDefined();
    expect(systemInput(`${dir}/pidbin`)).toBeDefined();
  });
  it("leaves ordinary commands to the other permission checks", () => {
    expect(systemInput(`tail -20 ${dir}/notes.log`)).toBeUndefined();
    expect(systemInput('agent-desktop press cmd+k --app Electron --session "$SID"')).toBeUndefined();
    expect(systemInput("swift test && git status")).toBeUndefined();
    expect(systemInput(`osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`)).toBeUndefined();
  });
});

describe("GitHub writes switched off", () => {
  it.each([
    "gh pr merge 38 --squash",
    "gh issue comment 214 --body done",
    "gh pr create --title x --body y",
    "cd repo && gh release create v1.0.0 app.dmg",
    "gh api repos/acme/web/issues/214/comments -f body=hi",
    "gh api -X DELETE repos/acme/web/labels/bug",
    "gh label create agent-working",
  ])("sees %s as a write", (command) => {
    expect(githubWrite(command)).toBeTruthy();
  });

  it.each(["gh pr view 38 --json state", "gh issue list --search is:open", "gh api repos/acme/web/issues/214", "gh api -X GET user", "git push origin main", "gh run view 1 --log"])(
    "lets %s through",
    (command) => {
      expect(githubWrite(command)).toBeUndefined();
    },
  );

  it("blocks a write only when the switch is off", async () => {
    const run = async (flag: string | undefined) => {
      vi.stubEnv("ONDRA_PERMISSION", "full");
      if (flag !== undefined) vi.stubEnv("ONDRA_GITHUB_WRITE", flag);
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      permissions({ registerCommand: vi.fn(), on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn) });
      return handlers.get("tool_call")!({ toolName: "bash", input: { command: "gh pr merge 38" } }, { cwd: process.cwd(), hasUI: true, ui: { select: vi.fn() } });
    };

    expect(await run("0")).toMatchObject({ block: true });
    vi.unstubAllEnvs();
    expect(await run(undefined)).toBeUndefined();
  });
});
