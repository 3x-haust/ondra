import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import tauriConfig from "../../src-tauri/tauri.conf.json";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Task } from "../state/types";
import { CAPTAIN_SYSTEM, SUB_SYSTEM, TASK_SYSTEM, taskSystem } from "./prompts";
import { startRpc } from "./rpc";
import { chineseOnly } from "./tasks";
import { REVIEW_FIX } from "./crosscheck";
import { pauseTask, startTask } from "./tasks";

const bundledSkills = import.meta.glob<string>("../../skills/*/SKILL.md", { query: "?raw", import: "default", eager: true });
const flat = (s: string) => s.replace(/\s+/g, " ");

const task = (parentId?: string): Task => ({
  id: "coding-task", space: "home", topic: "Example", title: "Fix calculation",
  ask: "Fix the incorrect total.", cwd: "/workspace/example", status: "queued",
  priority: 2, weight: "light", accountId: "default", createdAt: 1,
  now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
  isolate: false, parentId,
});

beforeEach(() => {
  setState(reconcile(freshState()));
  setState("settings", "instructions", "Keep changes local.");
  setState("spaces", 0, "rules", "Follow repository checks.");
});

afterEach(() => {
  for (const t of state.tasks) pauseTask(t.id);
  vi.restoreAllMocks();
});

describe("coding defaults", () => {
  it.each([TASK_SYSTEM, SUB_SYSTEM])("includes the same core workflow in each worker role", (prompt) => {
    expect(prompt.match(/^# Coding work$/gm)).toHaveLength(1);
    for (const rule of [
      "AGENTS.md", "CLAUDE.md", "expected and actual", "root cause",
      "failing regression test", "smallest change", "same surface",
      "tests, type checks and lint", "unverified",
    ]) expect(prompt).toContain(rule);
    expect(prompt).not.toMatch(/Prove: once|no re-running checks|no new test files/);
  });

  it.each([
    ["task", TASK_SYSTEM],
    ["subagent", SUB_SYSTEM],
  ])("requires observable completion evidence for the %s role", (_role, prompt) => {
    for (const rule of [
      "execute it with a tool", "Reading code or predicting output",
      "already passed before the fix", "original failing path",
      "check -> command/action -> observed result",
      "what failed or was skipped, why", "report the work as incomplete",
    ]) expect(prompt.replace(/\s+/g, " ")).toContain(rule);
  });

  it.each([TASK_SYSTEM, SUB_SYSTEM])("keeps builds and scratch work out of the artifacts folder", (prompt) => {
    const p = flat(prompt);
    expect(p).toContain("$APP_ARTIFACTS_DIR holds only what the user will look at.");
    expect(p).toMatch(/Builds, caches \(CARGO_TARGET_DIR[^)]*\), unpacked copies and scratch work go in \$APP_SCRATCH_DIR\./);
  });

  it("keeps searches out of ~ and short, without cutting builds short", () => {
    const p = flat(TASK_SYSTEM);
    for (const rule of ["rg --files <dir> -g '<glob>'", "not `find .`", "-maxdepth", "-not -path '*/node_modules/*' -not -path '*/.git/*'", '"timeout" (60)', "90s"])
      expect(p).toContain(rule);
    expect(p).toMatch(/home folder or `\/`, you are not in a project/);
    expect(p).toMatch(/short "timeout" to anything that renders, converts, builds, installs or downloads/);
  });

  it("waits end when what they wait for is gone, with deadlines that fit", () => {
    const p = flat(TASK_SYSTEM);
    for (const rule of [
      "never one `sleep` per turn",
      "`bun run dev > /tmp/dev.log 2>&1 & echo $! > /tmp/dev.pid`",
      "kill -0 $(cat /tmp/dev.pid) 2>/dev/null || break",
      "tail -20 /tmp/dev.log",
      "90 s", "2 minutes",
      "wait for it in one call that ends when the pid is gone",
    ]) expect(p).toContain(rule);
    // no blanket long poll: the only 10-minute wait is a build or test run's
    expect(p.match(/10 minutes/g)).toHaveLength(1);
    expect(p).toMatch(/build or test run gets up to 10 minutes/);
    expect(p).toMatch(/Only remote work \(CI, a store review\)/);
  });

  it("checks a rule over many pages by the rule, not by crawling a dev server", () => {
    const p = flat(TASK_SYSTEM);
    for (const rule of ["the middleware's matcher", "a few representative pages", "`next build && next start`", "`xargs -P 4`", "never one by one on a dev server"])
      expect(p).toContain(rule);
  });

  it("asks before what leaves the machine, keeps logins and Ondra's own data off limits", () => {
    const p = flat(TASK_SYSTEM);
    for (const act of ["git push", "merge", "deploy", "publish", "deleting data", "payments", "account changes"]) expect(p).toContain(act);
    expect(p).toContain('{"type":"ask"');
    expect(p).toContain("sign in only through the keychain");
    expect(p).toMatch(/Ondra's own data \(its app-support folder[^)]*\) is not your material/);
    expect(p).toContain("never authorize pushing");
  });

  it("asks for parallel tool calls and few, wide reads", () => {
    for (const prompt of [TASK_SYSTEM, SUB_SYSTEM]) expect(flat(prompt)).toContain("parallel tool calls");
    expect(flat(TASK_SYSTEM)).toMatch(/never re-read an unchanged file/);
  });

  it("keeps the always-on worker prompts small", () => {
    // ~4 chars a token: 8.1k tokens before, 5.4k after; the catalog of pictures lives in the visual-report skill
    expect(TASK_SYSTEM.length).toBeLessThan(23_000);
    expect(SUB_SYSTEM.length).toBeLessThan(8_000);
    for (const type of ["arch", "er", "deps", "classes", "trace", "states"]) {
      expect(TASK_SYSTEM).not.toContain(`{"type":"${type}"`);
      expect(bundledSkills["../../skills/visual-report/SKILL.md"]).toContain(`| \`${type}\` |`);
    }
    // everyday result blocks stay in the prompt so a report needs no skill read
    for (const type of ["plan", "now", "tests", "checklist", "diff", "table", "done", "handoff", "ask"]) expect(TASK_SYSTEM).toContain(`{"type":"${type}"`);
  });

  it("doesn't send every job to read a skill it already has in short", () => {
    const report = bundledSkills["../../skills/visual-report/SKILL.md"];
    expect(report).not.toMatch(/Read before your first message in any task/);
    // a test run is no reason to read the test-writing skill
    for (const prompt of [TASK_SYSTEM, SUB_SYSTEM, CAPTAIN_SYSTEM]) {
      expect(prompt).toMatch(/writing tests or setting up CI → test-ci/);
      expect(prompt).not.toMatch(/- tests or CI → test-ci/);
    }
  });

  it.each([
    ["task", TASK_SYSTEM],
    ["subagent", SUB_SYSTEM],
  ])("keeps the %s role's lines between tool calls in Korean words", (_role, prompt) => {
    const p = prompt.replace(/\s+/g, " ");
    for (const rule of ["Korean sentences", "타입 검사, 미들웨어", "개발 서버", "in backticks", "capitalised English word"]) expect(p).toContain(rule);
  });

  it("keeps role boundaries and the routing format", () => {
    expect(SUB_SYSTEM).toContain("Don't start subagents.");
    expect(TASK_SYSTEM).toContain("at most 4 at a time");
    expect(CAPTAIN_SYSTEM).toContain("you never do long work yourself");
    expect(CAPTAIN_SYSTEM).toContain("```route");
    expect(CAPTAIN_SYSTEM).toContain("Keep reproduction, fix and verification with one owning fork");
    expect(CAPTAIN_SYSTEM).toContain("One request is one fork by default");
    expect(CAPTAIN_SYSTEM).not.toContain("Split other multi-part work into small concrete steps");
    expect(TASK_SYSTEM).toContain("Review: only for a risky change");
    expect(TASK_SYSTEM).not.toContain("the completion gate requires one");
  });

  it("keeps optional user instructions out when empty", () => {
    setState("settings", "instructions", "  ");
    const parts = taskSystem(task());
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe(TASK_SYSTEM);
    expect(parts.join("\n")).not.toContain("# User instructions");
  });
});

const mimikyuFile = "../../skills/mimikyu/SKILL.md";
const mimikyuPath = decodeURIComponent(new URL(mimikyuFile, import.meta.url).pathname);

describe("background host computer-use instructions", () => {
  it.each([["task", TASK_SYSTEM], ["subagent", SUB_SYSTEM]])("runs in the background on this Mac for the %s role", (_role, prompt) => {
    expect(prompt).toContain("background");
    // never teaches the raw host-GUI escape hatches as a fallback
    expect(prompt).toContain("blocked");
    expect(prompt).toMatch(/AppleScript\/System Events|agent-desktop/);
    // the guest VM survives only as an optional separate mode, no longer required
    expect(prompt).toContain("optional separate mode");
    expect(prompt).not.toContain("No host fallback");
  });

  it("does not teach host GUI commands as a background path", () => {
    const skill = bundledSkills["../../skills/computer-use/SKILL.md"];
    expect(skill).toContain("background");
    expect(skill).toContain("never take the user's focus");
    // the optional isolated guest is still documented, just not the default
    expect(skill).toContain("isolated macOS");
    // and raw host GUI automation is still refused, not demonstrated
    expect(skill).not.toMatch(/agent-desktop (launch|press|click|batch)|open -g -a/);
    expect(skill).toMatch(/cliclick|AppleScript or System Events/);
  });
});

describe("bundled design workflow", () => {
  it("ships an automatically discoverable mimikyu skill with the app", () => {
    expect(tauriConfig.bundle.resources["../skills/"]).toBe("app-skills/");
    expect(bundledSkills).toHaveProperty(mimikyuFile);
    const skill = bundledSkills[mimikyuFile];
    expect(skill).toMatch(/^---\nname: mimikyu\ndescription:/);
    expect(skill).not.toContain("disable-model-invocation: true");
    for (const trigger of ["figma.com", "피그마 링크", "디자인 그대로"]) expect(skill).toContain(trigger);
    for (const gate of ["overall_match >= 99%", "every region >= 99%", "structural mismatches == 0"])
      expect(skill).toContain(gate);
    expect(skill).not.toMatch(/~\/\.mimikyu|\.\.\/\.\.\/scripts\//);
  });

  it.each([
    ["captain", CAPTAIN_SYSTEM], ["task", TASK_SYSTEM], ["subagent", SUB_SYSTEM],
  ])("directs the %s role to the supplied-design workflow", (_role, prompt) => {
    expect(prompt).toContain("mimikyu skill");
    expect(prompt).toContain("피그마");
  });
});

describe("skill discovery instructions", () => {
  it.each([
    ["captain", CAPTAIN_SYSTEM], ["task", TASK_SYSTEM], ["subagent", SUB_SYSTEM],
  ])("tells the %s role to search before reading a selected skill", (_role, prompt) => {
    expect(prompt).toContain("skill_search");
    expect(prompt).toMatch(/skill_search[\s\S]*read[\s\S]*SKILL\.md/i);
    expect(prompt).not.toContain("Jobs come with skills (listed in the message when they change)");
  });
});

describe("worker prompt delivery", () => {
  // Only the native process/event boundary is replaced; prompt assembly, state,
  // task startup and RPC response handling all run their real implementations.
  beforeEach(async () => {
    const events = new Map<string, (payload: unknown) => void>();
    vi.spyOn(native, "onEvent").mockImplementation(async (name, fn) => {
      events.set(name, fn as (payload: unknown) => void);
      return () => { events.delete(name); };
    });
    vi.spyOn(native, "agentSpawn").mockResolvedValue();
    vi.spyOn(native, "agentSend").mockImplementation(async (id, command) => {
      events.get("agent:event")?.({
        id, ev: { id: command.id, type: "response", success: true, data: {} },
      });
    });
    await startRpc();
  });

  for (const role of ["task", "subagent"] as const) {
    it.each(["fresh", "resume", "handoff"])(`delivers ${role} defaults on %s without skills`, async (mode) => {
      const t = task(role === "subagent" ? "parent-task" : undefined);
      if (t.parentId) setState("tasks", [{ ...task(), id: t.parentId }]);
      if (mode === "handoff") t.legs = [{
        startedAt: 1, endedAt: 2,
        handoff: { did: ["Reproduced incorrect total"], next: "Fix the calculation", evidence: [] },
      }];
      setState("tasks", (list) => [...list, t]);

      await startTask(t.id, mode === "resume");

      expect(native.agentSpawn).toHaveBeenCalledTimes(1);
      const [id, cwd, args, env] = vi.mocked(native.agentSpawn).mock.calls[0];
      expect(id).toBe(`t:${t.id}`);
      expect(cwd).toBe(t.cwd);
      expect(args.includes("--continue")).toBe(mode === "resume");
      expect(args).not.toContain("--skill");
      expect(args).toContain("--no-skills");
      expect(env.filter(([key]) => key === "ONDRA_SKILL_PATHS")).toEqual([["ONDRA_SKILL_PATHS", "[]"]]);
      const prompts = args.flatMap((arg, i) => arg === "--append-system-prompt" ? [args[i + 1]] : []);
      expect(prompts).toHaveLength(3);
      expect(prompts[0]).toBe(role === "subagent" ? SUB_SYSTEM : TASK_SYSTEM);
      expect(prompts[1]).toBe("# User instructions\nKeep changes local.");
      expect(prompts[2]).toContain("Follow repository checks.");
      expect(prompts.join("\n").match(/^# Coding work$/gm)).toHaveLength(1);
      const sent = vi.mocked(native.agentSend).mock.calls.find(([, command]) => command.type === "prompt")?.[1];
      expect(sent?.message).toContain(mode === "resume" ? "다시 시작" : mode === "handoff" ? "Reproduced incorrect total" : t.ask);
      expect(state.tasks.find((x) => x.id === t.id)?.status).toBe("running");
    });

    it(`tells a resumed ${role} which background commands may be gone`, async () => {
      const t = task(role === "subagent" ? "parent-task" : undefined);
      if (t.parentId) setState("tasks", [{ ...task(), id: t.parentId }]);
      t.shells = [
        { id: "a", command: "(nohup bun run dev -- -p 3217 > /tmp/dev.log 2>&1 &)", startedAt: 1, endedAt: 2, tail: "", background: true },
        { id: "b", command: 'for i in $(seq 1 60); do grep -q "Ready" /tmp/dev.log && break; sleep 2; done', startedAt: 3, tail: "" },
      ];
      setState("tasks", (list) => [...list, t]);

      await startTask(t.id, true);

      const sent = vi.mocked(native.agentSend).mock.calls.find(([, command]) => command.type === "prompt")?.[1];
      expect(sent?.message).toContain('그때 돌던 명령 `for i in $(seq 1 60); do grep -q "Ready" /tmp/dev.log && break; sleep 2; done`은 재시작 때문에 끊겼어요');
      expect(sent?.message).toContain("백그라운드로 띄운 `(nohup bun run dev -- -p 3217 > /tmp/dev.log 2>&1 &)`는 아직 돌 수도, 꺼졌을 수도 있어요");
      expect(sent?.message).toContain("kill -0");
    });

    it.each(["fresh", "resume", "handoff"])(`makes skills searchable by ${role} on %s without loading the catalog`, async (mode) => {
      expect(bundledSkills).toHaveProperty(mimikyuFile);
      vi.spyOn(native, "workerSkills").mockResolvedValue([mimikyuPath]);
      const pack = Array.from({ length: 6 }, (_, i) => ({
        name: `aws-${i}`, path: `/global/aws-${i}/SKILL.md`, description: `Amazon procedure ${i}`,
      }));
      vi.spyOn(native, "globalSkills").mockResolvedValue(pack);
      setState("skills", [
        { name: "home", path: "/home/SKILL.md", description: "Home procedure", source: "ondra", enabled: true, space: "home" },
        { name: "work", path: "/work/SKILL.md", description: "Work procedure", source: "ondra", enabled: true, space: "work" },
        { name: "off", path: "/off/SKILL.md", description: "Disabled procedure", source: "ondra", enabled: false, space: "home" },
      ]);
      const t = task(role === "subagent" ? "parent-task" : undefined);
      // Availability must not depend on a design keyword or a personal skill.
      if (t.parentId) setState("tasks", [{ ...task(), id: t.parentId }]);
      if (mode === "handoff") t.legs = [{
        startedAt: 1, endedAt: 2,
        handoff: { did: ["Read the design"], next: "Measure the implementation", evidence: [] },
      }];
      setState("tasks", (list) => [...list, t]);

      await startTask(t.id, mode === "resume");

      expect(native.agentSpawn).toHaveBeenCalledTimes(1);
      const [, , args, env] = vi.mocked(native.agentSpawn).mock.calls[0];
      expect(args).toContain("--no-skills");
      expect(args).not.toContain("--skill");
      expect(env.filter(([key]) => key === "ONDRA_SKILL_PATHS")).toEqual([
        ["ONDRA_SKILL_PATHS", JSON.stringify([mimikyuPath, "/home/SKILL.md", ...pack.map((s) => s.path)])],
      ]);
      const sent = vi.mocked(native.agentSend).mock.calls.find(([, command]) => command.type === "prompt")?.[1];
      const context = `${args.join("\n")}\n${sent?.message}`;
      for (const description of ["Home procedure", "Work procedure", "Disabled procedure", ...pack.map((s) => s.description)])
        expect(context).not.toContain(description);
      expect(args.includes("--continue")).toBe(mode === "resume");
      const prompts = args.flatMap((arg, i) => arg === "--append-system-prompt" ? [args[i + 1]] : []);
      expect(prompts[0]).toContain("mimikyu skill");
      expect(state.tasks.find((x) => x.id === t.id)?.status).toBe("running");
    });
  }
});

describe("chineseOnly", () => {
  it("drops Chinese status lines, keeps Korean (with or without hanja)", () => {
    expect(chineseOnly("正在制作一页功能定义书")).toBe(true);
    expect(chineseOnly("기능 정의서를 만드는 중이에요")).toBe(false);
    expect(chineseOnly("修正 전 검증기 회귀 검사")).toBe(false);
    expect(chineseOnly("Running tests")).toBe(false);
  });
});

describe("교차 검토 in the task prompt and the review skill", () => {
  it("names the two lenses in step 5, still risky-only, once, before shipping", () => {
    const p = flat(TASK_SYSTEM);
    for (const rule of [
      "Review: only for a risky change", "at most one per job", "before anything goes out",
      '{"type":"subagent","review":true,"title":"교차 검토","task":"Review the changes in <folder> against: <the full requirement>"}',
      "설계 검토", "코드 검토", "one combined result", "never your own verdict", "one targeted check",
    ]) expect(p).toContain(rule);
    expect(p).not.toContain("Use the code-review skill. Review the changes");
  });

  it("says the same about P3 findings as the message that delivers them", () => {
    // the prompt once said "P3 when cheap" while the review result said not to fix P3s
    expect(flat(TASK_SYSTEM)).toMatch(/Fix every P1 and P2, note P3s/);
    expect(REVIEW_FIX).toContain("P3는 고치지 말고");
    expect(TASK_SYSTEM).not.toContain("P3 when cheap");
  });

  it("keeps the plan check before building a multi-part feature", () => {
    const p = flat(TASK_SYSTEM);
    expect(p).toContain('{"type":"subagent","plan_review":true,"title":"계획 검토"');
    expect(p).toMatch(/never a fix or a small change/);
  });

  it("gives both lenses evidence-first rules and a memory check, in Ondra's own words", () => {
    const skill = bundledSkills["../../skills/code-review/SKILL.md"].replace(/\s+/g, " ");
    for (const rule of [
      "**설계 검토 (design)**", "**코드 검토 (code)**", "https://github.com/sleeplesshan/dual-brain",
      "the requirement or contract it breaks", "the trigger", "the evidence", "the consequence",
      "There is no quota. \"P1·P2 없음\"", "generic hardening", "stays settled unless you have new evidence",
      '"type":"memory-check"', "`confirmed`", "`contradicted`", "`unchecked`", "a contradiction without a quote is dropped",
    ]) expect(skill).toContain(rule);
    expect(skill).not.toMatch(/left brain|right brain|dual-brain review/i);
  });
});
