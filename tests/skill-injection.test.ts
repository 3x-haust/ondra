// ONDRA_INJECTION_SOURCE points at an extracted HEAD tree or this worktree.
// Run each revision separately against the same ONDRA_INJECTION_ARTIFACTS directory.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { reconcile } from "solid-js/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../src/state/types";

const engine = process.env.ONDRA_ENGINE_BIN;
const source = resolve(process.env.ONDRA_INJECTION_SOURCE || ".");
const output = process.env.ONDRA_INJECTION_ARTIFACTS;
const revision = process.env.ONDRA_INJECTION_REVISION;
const bytes = (s: string) => Buffer.byteLength(s, "utf8");
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe.skipIf(!engine || !output || !revision)("실제 시작 경계의 스킬 주입량", () => {
  it("실제 main/worker/subagent 시작 인자와 첫 메시지를 엔진에서 측정한다", async () => {
    const dir = resolve(output!);
    const home = join(dir, "fixture");
    const cwd = join(home, "workspace");
    mkdirSync(cwd, { recursive: true });
    const bundled = readdirSync(resolve("skills")).sort().map((name) => resolve("skills", name, "SKILL.md")).filter(existsSync);
    const skill = (name: string, description: string) => {
      const path = join(home, "skills", name, "SKILL.md");
      mkdirSync(join(home, "skills", name), { recursive: true });
      writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n${name} body\n`);
      return { name, description, path };
    };
    const app = skill("calculation", "계산 오류의 원인과 회귀 검사를 확인하는 절차");
    const other = skill("other-space", "다른 공간의 절차");
    const disabled = skill("disabled", "비활성 절차");
    const globals = Array.from({ length: 6 }, (_, i) => skill(`aws-${i}`, `Amazon procedure ${i}`));
    const ask = "계산 오류를 확인해줘";
    const fixture = { cwd, ask, bundled: bundled.map((path) => ({ path, sha256: hash(readFileSync(path, "utf8")) })), app, other, disabled, globals };
    const fixtureFile = join(dir, "fixture.json");
    if (existsSync(fixtureFile)) expect(JSON.parse(readFileSync(fixtureFile, "utf8"))).toEqual(fixture);
    else writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2));

    // Import the entire revision, not just its prompt strings. Only native
    // process/filesystem boundaries are replaced, as in prompts.test.ts.
    const native = await import(/* @vite-ignore */ join(source, "src/lib/native.ts"));
    const { freshState, setState, state } = await import(/* @vite-ignore */ join(source, "src/state/store.ts"));
    const { startRpc, markDead } = await import(/* @vite-ignore */ join(source, "src/engine/rpc.ts"));
    const { throwThought } = await import(/* @vite-ignore */ join(source, "src/engine/captain.ts"));
    const { startTask } = await import(/* @vite-ignore */ join(source, "src/engine/tasks.ts"));
    const events = new Map<string, (payload: unknown) => void>();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.spyOn(native, "onEvent").mockImplementation(async (name: string, fn: (payload: unknown) => void) => {
      events.set(name, fn);
      return () => { events.delete(name); };
    });
    vi.spyOn(native, "engineInfo").mockResolvedValue({ enginePath: engine, engineVersion: "fixture", home, dataDir: join(home, "data") });
    vi.spyOn(native, "agentSpawn").mockResolvedValue(undefined);
    vi.spyOn(native, "agentSend").mockImplementation(async (id: string, command: Record<string, unknown>) => {
      const emit = (ev: unknown) => events.get("agent:event")?.({ id, ev });
      emit({ id: command.id, type: "response", success: true, data: {} });
      if (id.startsWith("captain:") && command.type === "prompt") {
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "확인했어요." }] } });
        emit({ type: "agent_settled" });
      }
    });
    vi.spyOn(native, "workerExtensions").mockResolvedValue(readdirSync(join(source, "extensions")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort().map((f) => join(source, "extensions", f)));
    // Keep bridge-dependent tool registration realistic without contacting it.
    vi.spyOn(native, "workerEnv").mockImplementation(async (id: string) => [["ONDRA_BRIDGE", "http://127.0.0.1:1"], ["ONDRA_BRIDGE_TOKEN", "fixture"], ["APP_WORKER_ID", id]]);
    vi.spyOn(native, "workerSkills").mockResolvedValue(bundled);
    vi.spyOn(native, "globalSkills").mockResolvedValue(globals);
    vi.spyOn(native, "fsRead").mockResolvedValue({ text: "" });
    vi.spyOn(native, "fsRepos").mockResolvedValue([]);
    await startRpc();
    const reset = () => {
      setState(reconcile(freshState()));
      setState("spaces", 0, { folder: cwd, rules: "Follow repository checks." });
      setState("settings", "instructions", "Keep changes local.");
      setState("skills", [
        { ...app, source: "ondra", enabled: true, space: "home" },
        { ...other, source: "ondra", enabled: true, space: "work" },
        { ...disabled, source: "ondra", enabled: false, space: "home" },
      ]);
      vi.mocked(native.agentSpawn).mockClear();
      vi.mocked(native.agentSend).mockClear();
    };
    const captures: { role: string; id: string; cwd: string; args: string[]; env: [string, string][]; firstMessage: string }[] = [];
    for (const role of ["main", "worker", "subagent"]) {
      reset();
      if (role === "main") {
        const reply = throwThought(ask, "home");
        await vi.waitFor(() => expect(state.captain.find((m: { id: string }) => m.id === reply)?.pending).toBe(false));
        expect(state.captain.find((m: { id: string }) => m.id === reply)?.error).toBeUndefined();
      } else {
        const task: Task = { id: role, space: "home", topic: "Example", title: "계산 오류 확인", ask, cwd, status: "queued", priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [], isolate: false };
        if (role === "subagent") {
          task.parentId = "parent";
          setState("tasks", [{ ...task, id: "parent", parentId: undefined }]);
        }
        setState("tasks", (list: Task[]) => [...list, task]);
        await startTask(task.id);
        expect(state.tasks.find((t: Task) => t.id === task.id)?.error).toBeUndefined();
      }
      expect(native.agentSpawn).toHaveBeenCalledTimes(1);
      const [id, runCwd, args, env] = vi.mocked(native.agentSpawn).mock.calls[0] as [string, string, string[], [string, string][]];
      const prompts = vi.mocked(native.agentSend).mock.calls.filter(([, command]) => (command as Record<string, unknown>).type === "prompt");
      expect(prompts).toHaveLength(1);
      const firstMessage = String((prompts[0][1] as Record<string, unknown>).message);
      expect(firstMessage).toContain(ask);
      captures.push({ role, id, cwd: runCwd, args, env, firstMessage });
      markDead(id);
    }
    vi.clearAllTimers();
    vi.useRealTimers();
    writeFileSync(join(dir, `${revision}-startup.json`), JSON.stringify({ source, head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sources: ["captain", "tasks", "prompts", "skillPick"].map((name) => ({ name, sha256: hash(readFileSync(join(source, `src/engine/${name}.ts`), "utf8")) })), captures }, null, 2));

    const probe = join(dir, "probe.ts");
    writeFileSync(probe, `export default function(pi) {
      pi.registerCommand("injection-check", { handler: async (_args, ctx) => {
        ctx.ui.notify(JSON.stringify({ system: ctx.getSystemPrompt(), tools: pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name)).map(({name, description, parameters}) => ({name, description, parameters})) }), "info");
      }});
      pi.on("input", (event, ctx) => {
        if (event.text.startsWith("/injection-check")) return;
        ctx.ui.notify(JSON.stringify({ firstMessage: event.text }), "info");
        return { action: "handled" };
      });
    }`);
    const results = [];
    for (const capture of captures) {
      // Rust adds --no-extensions and --mode rpc. The remaining flags isolate
      // user resources and prevent network/model use; captured args are intact.
      const args = ["--no-extensions", "--mode", "rpc", ...capture.args, "--offline", "--no-approve", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-session", "--extension", probe];
      const env = { HOME: home, PATH: process.env.PATH, PI_PACKAGE_DIR: process.env.PI_PACKAGE_DIR, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_OFFLINE: "1", PI_TELEMETRY: "0", ...Object.fromEntries(capture.env) };
      const run = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
        const child = spawn(engine!, args, { cwd: capture.cwd, env });
        let stdout = "", stderr = "", pending = "";
        const timeout = setTimeout(() => { child.kill(); reject(new Error(`엔진 측정 시간 초과: ${capture.role}\n${stderr}`)); }, 30_000);
        child.stdout.on("data", (chunk) => {
          stdout += chunk; pending += chunk;
          const lines = pending.split("\n"); pending = lines.pop()!;
          for (const line of lines.filter(Boolean)) {
            const event = JSON.parse(line);
            if (event.type === "extension_ui_request" && event.method === "notify") {
              const notice = JSON.parse(event.message);
              if (notice.system) child.stdin.write(JSON.stringify({ id: "context", type: "get_context" }) + "\n");
              if (notice.firstMessage) child.stdin.end();
            }
            if (event.id === "context" && event.type === "response") child.stdin.write(JSON.stringify({ id: "first", type: "prompt", message: capture.firstMessage }) + "\n");
            if (event.type === "extension_error") child.stdin.end();
          }
        });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", (e) => { clearTimeout(timeout); reject(e); });
        child.on("close", (code) => { clearTimeout(timeout); done({ code, stdout, stderr }); });
        child.stdin.write(JSON.stringify({ id: "probe", type: "prompt", message: "/injection-check" }) + "\n");
      });
      writeFileSync(join(dir, `${revision}-${capture.role}-rpc.json`), JSON.stringify({ args, env, ...run }, null, 2));
      expect(run.code, run.stderr).toBe(0);
      const records = run.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(records.filter((r) => r.type === "extension_error"), run.stderr).toEqual([]);
      const notices = records.filter((r) => r.type === "extension_ui_request" && r.method === "notify").map((r) => JSON.parse(r.message));
      const report = notices.find((r) => r.system);
      expect(report, run.stdout + run.stderr).toBeDefined();
      expect(notices.find((r) => r.firstMessage)?.firstMessage).toBe(capture.firstMessage);
      const context = records.find((r) => r.id === "context" && r.type === "response");
      expect(context?.success, run.stdout).toBe(true);
      expect(context.data.systemPrompt).toBe(report.system);
      expect(context.data.tools.filter((t: { active: boolean }) => t.active).map((t: { name: string }) => t.name).sort()).toEqual(report.tools.map((t: { name: string }) => t.name).sort());
      if (revision === "before") {
        expect(report.system.includes("<available_skills>")).toBe(capture.role !== "main");
        if (capture.role === "main") expect(capture.firstMessage).toContain("# Skills jobs can use\n- calculation:");
      } else {
        expect(report.system).not.toContain("<available_skills>");
        expect(capture.firstMessage).not.toContain("# Skills jobs can use");
        expect(report.tools.map((t: { name: string }) => t.name)).toContain("skill_search");
      }
      if (capture.role !== "main") expect(report.tools.map((t: { name: string }) => t.name)).toContain("memory_search");
      const metrics = { role: capture.role, systemBytes: bytes(report.system), toolBytes: bytes(JSON.stringify(report.tools)), firstUserBytes: bytes(capture.firstMessage), totalBytes: bytes(report.system) + bytes(JSON.stringify(report.tools)) + bytes(capture.firstMessage), catalogEntries: (report.system.match(/<skill>/g) ?? []).length };
      writeFileSync(join(dir, `${revision}-${capture.role}.json`), JSON.stringify({ metrics, ...report, firstMessage: capture.firstMessage, context: context.data }, null, 2));
      console.log(JSON.stringify({ revision, ...metrics }));
      results.push(metrics);
    }
    writeFileSync(join(dir, `${revision}-metrics.json`), JSON.stringify(results, null, 2));
  }, 120_000);
});
