// Run with ONDRA_ENGINE_BIN and PI_PACKAGE_DIR to check the shipped RPC engine.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CAPTAIN_SYSTEM, TASK_SYSTEM, SUB_SYSTEM } from "../src/engine/prompts";

const engine = process.env.ONDRA_ENGINE_BIN;
const root = resolve(".");
const bundled = readdirSync(join(root, "skills")).sort().map((name) => join(root, "skills", name, "SKILL.md")).filter(existsSync);

// No credentials, personal settings, external calls or model responses are used.
describe.skipIf(!engine)("skill loading in the RPC engine", () => {
  for (const [role, prompt] of [["main", CAPTAIN_SYSTEM], ["task", TASK_SYSTEM], ["subagent", SUB_SYSTEM]]) {
    it(`${role}: keeps the catalog out and reads only the selected skill and reference`, async () => {
      const home = mkdtempSync(join(tmpdir(), "ondra-skill-loading-"));
      try {
        const selected = join(home, "chosen", "SKILL.md");
        mkdirSync(join(home, "chosen", "references"), { recursive: true });
        writeFileSync(selected, "---\nname: selected-example\ndescription: Zebra reference workflow, 얼룩말 참조\n---\nSELECTED_BODY_ONLY\nRead references/check.md.\n");
        writeFileSync(join(home, "chosen", "references", "check.md"), "REFERENCE_ONLY");
        const hidden = join(home, "manual.md");
        writeFileSync(hidden, "---\nname: manual-only\ndescription: Zebra manual workflow\ndisable-model-invocation: true\n---\nMANUAL_BODY_ONLY\n");
        const paths = [...bundled, selected, hidden];
        const probe = join(home, "probe.ts");
        writeFileSync(probe, `
import { createReadTool } from "@earendil-works/pi-coding-agent";
import skills from ${JSON.stringify(join(root, "extensions/skills.ts"))};
export default function(pi) {
  const registered = new Map();
  skills(new Proxy(pi, { get(target, key) {
    if (key === "registerTool") return (def) => { registered.set(def.name, def); target.registerTool(def); };
    return target[key];
  }}));
  pi.on("input", (event, ctx) => {
    if (!event.text.includes("MANUAL_BODY_ONLY")) return;
    ctx.ui.notify(JSON.stringify({ explicit: event.text }), "info");
    return { action: event.text.includes("queued argument") ? "continue" : "handled" };
  });
  pi.registerCommand("skill-check", { handler: async (_args, ctx) => {
    const initial = ctx.getSystemPrompt();
    const declarations = pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name)).map(({name, description, parameters}) => ({name, description, parameters}));
    const report = { initial, declarations, commands: pi.getCommands() };
    const search = registered.get("skill_search");
    report.search = await search.execute("search", {query: "Zebra", limit: 3}, undefined, undefined, ctx);
    report.korean = await search.execute("korean", {query: "얼룩말", limit: 3}, undefined, undefined, ctx);
    report.empty = await search.execute("empty", {query: "zzunmatched987654"}, undefined, undefined, ctx);
    report.blank = await search.execute("blank", {query: "   "}, undefined, undefined, ctx);
    report.design = await search.execute("design", {query: "피그마", limit: 3}, undefined, undefined, ctx);
    report.limited = await search.execute("limited", {query: "use", limit: 1}, undefined, undefined, ctx);
    report.reversing = [];
    for (const query of ["리버싱", "역공학", "바이너리 분석", "reverse-engineering", "disassembly", "decompilation", "LLDB", "REA"]) {
      report.reversing.push({ query, result: await search.execute("reverse", {query, limit: 3}, undefined, undefined, ctx) });
    }
    const reversing = JSON.parse(report.reversing[0].result.content[0].text).skills.find(s => s.name === "reverse-engineering");
    report.reverseBody = await createReadTool(ctx.cwd).execute("reverse-body", {path: reversing.path});
    report.reverseReference = await createReadTool(ctx.cwd).execute("reverse-reference", {path: reversing.baseDir + "/references/evidence.md"});
    const found = JSON.parse(report.search.content[0].text).skills[0];
    const reader = createReadTool(ctx.cwd);
    report.selected = await reader.execute("selected", {path: found.path});
    report.reference = await reader.execute("reference", {path: found.baseDir + "/references/check.md"});
    report.after = ctx.getSystemPrompt();
    ctx.ui.notify(JSON.stringify(report), "info");
  }});
}`);
        const child = spawn(engine!, [
          "--mode", "rpc", "--no-session", "--offline", "--no-approve", "--no-context-files",
          "--no-extensions", "--no-prompt-templates", "--no-themes", "--no-skills",
          ...(role === "main" ? ["--no-builtin-tools", "--extension", join(root, "extensions/lazy-core.ts")] : []),
          "--extension", "builtin:tool-search", "--tools", "+tool_search",
          "--extension", probe, "--append-system-prompt", prompt,
        ], {
          cwd: home,
          env: { HOME: home, PATH: process.env.PATH, PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR,
            PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0",
            ONDRA_MAIN: role === "main" ? "1" : "0", ONDRA_SKILL_PATHS: JSON.stringify(paths) },
        });
        const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
          let stdout = "", stderr = "", selected = false, queued = false;
          const deadline = setTimeout(() => { child.kill(); reject(new Error("Engine probe did not finish")); }, 60_000);
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
            const notifications = stdout.split("\n").filter((line) => line.includes('"method":"notify"')).length;
            if (stdout.includes('"type":"extension_error"') || stdout.includes('"command":"follow_up"')) child.stdin.end();
            else if (notifications >= 2 && !queued) {
              queued = true;
              child.stdin.write('{"id":"steer","type":"steer","message":"/skill:manual-only queued argument"}\n{"id":"follow","type":"follow_up","message":"/skill:manual-only queued argument"}\n');
            }
            else if (notifications === 1 && !selected) {
              selected = true;
              child.stdin.write('{"id":"explicit","type":"prompt","message":"/skill:manual-only explicit argument"}\n');
            }
          });
          child.stderr.on("data", (chunk) => { stderr += chunk; });
          child.on("error", (error) => { clearTimeout(deadline); reject(error); });
          child.on("close", (status) => { clearTimeout(deadline); done({ status, stdout, stderr }); });
          child.stdin.write('{"id":"check","type":"prompt","message":"/skill-check"}\n');
        });
        expect(run.status, run.stderr).toBe(0);
        const records = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
        const notification = records.find((r) => r.type === "extension_ui_request" && r.method === "notify");
        expect(notification, run.stdout + run.stderr).toBeDefined();
        const result = JSON.parse(notification.message);
        expect(result.initial).not.toContain("<available_skills>");
        expect(result.initial).not.toContain("Zebra reference workflow");
        expect(result.initial).not.toContain("SELECTED_BODY_ONLY");
        expect(result.declarations.map((t) => t.name)).toContain("skill_search");
        expect(result.initial).toContain("skill_search");
        const matches = JSON.parse(result.search.content[0].text).skills;
        expect(matches).toEqual([{ name: "selected-example", description: "Zebra reference workflow, 얼룩말 참조", path: selected, baseDir: join(home, "chosen") }]);
        expect(result.search.content[0].text).not.toContain("SELECTED_BODY_ONLY");
        expect(JSON.parse(result.korean.content[0].text).skills).toEqual(matches);
        expect(JSON.parse(result.empty.content[0].text).skills).toEqual([]);
        expect(JSON.parse(result.blank.content[0].text).skills).toEqual([]);
        expect(JSON.parse(result.design.content[0].text).skills.map((s) => s.name)).toContain("mimikyu");
        for (const { query, result: searchResult } of result.reversing) {
          const found = JSON.parse(searchResult.content[0].text).skills;
          expect(found.map((s) => s.name), query).toContain("reverse-engineering");
          expect(searchResult.content[0].text).not.toContain("Establish the target and boundary");
        }
        expect(result.reverseBody.content[0].text).toContain("Establish the target and boundary");
        expect(result.reverseReference.content[0].text).toContain("Completion gates");
        expect(result.initial).not.toContain("Evidence-driven reverse engineering");
        expect(result.selected.content[0].text).toContain("SELECTED_BODY_ONLY");
        expect(result.reference.content[0].text).toBe("REFERENCE_ONLY");
        expect(result.after).not.toContain("<available_skills>");
        expect(result.commands.some((c) => c.name === "skill:manual-only")).toBe(false);
        expect(JSON.parse(result.limited.content[0].text).skills).toHaveLength(1);
        const explicitNotice = records.filter((r) => r.type === "extension_ui_request" && r.method === "notify")[1];
        const explicit = JSON.parse(explicitNotice.message).explicit;
        expect(explicit).toContain("MANUAL_BODY_ONLY");
        expect(explicit).toContain("explicit argument");
        expect(explicit).toContain(home);
        expect(explicit).not.toContain("SELECTED_BODY_ONLY");
        expect(explicit).not.toContain("<available_skills>");
        for (const id of ["steer", "follow"]) {
          const response = records.find((r) => r.type === "response" && r.id === id);
          expect(response?.success, JSON.stringify(response)).toBe(true);
          expect(response.data.disposition).toBe("queued");
        }
        const queuedNotices = records.filter((r) => r.type === "extension_ui_request" && r.method === "notify").slice(2);
        expect(queuedNotices).toHaveLength(2);
        for (const notice of queuedNotices) {
          const text = JSON.parse(notice.message).explicit;
          expect(text).toContain("MANUAL_BODY_ONLY");
          expect(text).toContain("queued argument");
          expect(text).not.toContain("SELECTED_BODY_ONLY");
        }
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
