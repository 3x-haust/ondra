import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Task } from "../state/types";
import { startRpc } from "./rpc";
import { finishTask, mergeCards, pauseTask, resumeTask, startTask, stopStalledCommands, tell } from "./tasks";

// What the Orbit jobs of 11-06 to 11-14 ran into: another job's words read as the user's, a job
// failed by Ondra's own new session, a stale "released" summary on a failed job, a failed job
// resumed over the job that had carried it on, and a model request that hung for hours.

const job = (over: Partial<Task> = {}): Task => ({
  id: "job", space: "home", topic: "Orbit", title: "Convert files",
  ask: "Build the file conversion feature.", cwd: "/workspace/orbit", status: "queued",
  priority: 2, weight: "light", accountId: "default", createdAt: 1,
  now: "", plan: [], legs: [{ startedAt: 1 }], entries: [], shells: [], inbox: [],
  isolate: false, answer: true, ...over,
});
const kid = (over: Partial<Task> = {}): Task =>
  job({ id: "kid", parentId: "job", status: "running", title: "Document engine", answer: undefined, legs: [{ startedAt: 2 }], ...over });

const calls = () => vi.mocked(native.agentSend).mock.calls.map(([, c]) => c as { type: string; message?: string });
const sent = (type: string) => calls().filter((c) => c.type === type).map((c) => String(c.message ?? ""));
const task = (id: string) => state.tasks.find((t) => t.id === id)!;
const tick = () => new Promise((r) => setTimeout(r));

let emit: (ev: unknown) => void;

beforeEach(async () => {
  setState(reconcile(freshState()));
  const events = new Map<string, (payload: unknown) => void>();
  vi.spyOn(native, "onEvent").mockImplementation(async (name, fn) => {
    events.set(name, fn as (payload: unknown) => void);
    return () => { events.delete(name); };
  });
  vi.spyOn(native, "agentSpawn").mockResolvedValue();
  vi.spyOn(native, "agentSend").mockImplementation(async (id, command) => {
    emit = (ev: unknown) => events.get("agent:event")?.({ id, ev });
    emit({ id: command.id, type: "response", success: true, data: command.type === "clear_queue" ? { steering: [], followUp: [] } : {} });
  });
  await startRpc();
});
afterEach(() => {
  for (const t of state.tasks) pauseTask(t.id);
  vi.restoreAllMocks();
});

/** the job is in a turn */
async function working(tasks: Task[]) {
  setState("tasks", tasks);
  await startTask("job");
  await vi.waitFor(() => expect(sent("prompt")).toHaveLength(1));
  emit({ type: "agent_start" });
  await tick();
}

/** the model writes a handoff card and its turn ends */
async function handsOff() {
  const text = '```blocks\n{"type":"handoff","did":["built the converter"],"next":"bundle the document engine","evidence":[]}\n```';
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  emit({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
  emit({ type: "agent_settled" });
  await tick();
  await tick();
}

describe("another job's message while the job works", () => {
  it("is not wrapped as the user's words", async () => {
    await working([job(), kid({ status: "done" })]);
    await tell("job", "(Ondra) A message from another job in this space, \"DEXA\" (t2). It is not the user.\n\nIs the ffmpeg load yours?", { by: "t2" });

    expect(sent("steer")).toHaveLength(1);
    expect(sent("steer")[0]).not.toContain("The user said this");
  });
});

describe("a job waiting to hand off until its subagent is done", () => {
  it("keeps the subagent's message for the next session instead of waking the old one", async () => {
    await working([job(), kid()]);
    await handsOff();
    expect(task("job").now).toContain("기다리는 중");
    const before = calls().length;

    await tell("job", "공용 변경 부탁해요", { by: "kid" });

    expect(calls().slice(before).filter((c) => c.type === "prompt" || c.type === "steer")).toEqual([]);
    expect(task("job").inbox).toContain("공용 변경 부탁해요");
  });

  it("opens the new session after a turn still going ends, and that turn's abort doesn't fail the job", async () => {
    await working([job(), kid()]);
    await handsOff();
    // something woke the old session anyway: a turn is going when the subagent ends
    emit({ type: "agent_start" });
    await tick();
    finishTask("kid");
    await tick();
    await tick();
    expect(sent("new_session" as never)).toHaveLength(0);
    expect(calls().filter((c) => c.type === "new_session")).toHaveLength(0);

    emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "The operation was aborted." } });
    emit({ type: "agent_settled" });
    await vi.waitFor(() => expect(calls().filter((c) => c.type === "new_session")).toHaveLength(1));
    expect([task("job").status, task("job").error]).toEqual(["running", undefined]);
    expect(task("job").legs).toHaveLength(2);
  });
});

describe("the user speaking while the job waits to hand off", () => {
  it("starts the new session now instead of after the subagents", async () => {
    await working([job(), kid()]);
    await handsOff();
    await tell("job", "설치까지 해줘");

    await vi.waitFor(() => expect(calls().filter((c) => c.type === "new_session")).toHaveLength(1));
    const prompt = sent("prompt").find((m) => m.includes("# Handoff card"))!;
    expect(prompt).toContain("- 설치까지 해줘");
    expect(prompt).toContain("bundle the document engine");
    expect(task("job").status).toBe("running");
  });
});

describe("a job that fails after it had finished once", () => {
  it("drops the earlier run's summary and unverified list", async () => {
    await working([job({ summary: "수정을 반영한 릴리스를 공개했어요", unverified: ["Shift 드래그"] })]);
    emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "provider exploded" } });
    emit({ type: "agent_settled" });
    await vi.waitFor(() => expect(task("job").status).toBe("failed"));

    expect(task("job").summary).toBeUndefined();
    expect(task("job").unverified).toBeUndefined();
  });
});

describe("resuming a failed job another job carried on", () => {
  const failed = job({ status: "failed", error: "engine exited (143)" });

  it("is refused while the follower still works", () => {
    setState("tasks", [failed, job({ id: "next", follows: "job", status: "running", title: "Finish conversion" })]);
    resumeTask("job");
    expect(task("job").status).toBe("failed");
  });

  it("tells the job what the follower already did", () => {
    setState("tasks", [failed, job({ id: "next", follows: "job", status: "done", title: "Finish conversion", summary: "PR #68 merged" })]);
    resumeTask("job");
    expect(task("job").status).toBe("queued");
    expect(task("job").inbox.join("\n")).toMatch(/"Finish conversion" \(next\) carried it on and is done: PR #68 merged/);
  });
});

describe("a model request that hangs", () => {
  it("is cut after ten silent minutes and asked again, without failing the job", async () => {
    await working([job()]);
    stopStalledCommands(Date.now() + 5 * 60_000);
    expect(calls().filter((c) => c.type === "abort")).toHaveLength(0);

    stopStalledCommands(Date.now() + 11 * 60_000);
    await vi.waitFor(() => expect(calls().filter((c) => c.type === "abort")).toHaveLength(1));
    emit({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "Request was aborted" } });
    emit({ type: "agent_settled" });

    await vi.waitFor(() => expect(sent("prompt").some((m) => m.includes("sent nothing for over 10 minutes"))).toBe(true));
    expect(task("job").status).not.toBe("failed");
  });

  it("leaves a turn alone while it compacts", async () => {
    await working([job()]);
    emit({ type: "compaction_start" });
    stopStalledCommands(Date.now() + 15 * 60_000);
    await tick();
    expect(calls().filter((c) => c.type === "abort")).toHaveLength(0);
  });

  it("leaves a turn alone while one of its tools runs", async () => {
    await working([job()]);
    emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "xcodebuild build" } });
    await tick();
    stopStalledCommands(Date.now() + 30 * 60_000);
    await tick();
    expect(calls().filter((c) => c.type === "abort")).toHaveLength(0);
  });
});

describe("looking things up", () => {
  const look = (n: number, command: string) => {
    emit({ type: "tool_execution_start", toolCallId: `p${n}`, toolName: "bash", args: { command } });
    emit({ type: "tool_execution_end", toolCallId: `p${n}`, result: { content: [{ type: "text", text: "ok" }] } });
  };
  const nudges = () => sent("steer").filter((m) => m.includes("checking on the same thing"));

  it("is not taken for checking on the same thing", async () => {
    await working([job()]);
    ["git status --short", "git log --oneline -5", "gh pr view 68", "xcodebuild -help", "gh release view v1.4.18", "git diff --stat", "gh run list", "codesign --help"].forEach((c, i) => look(i, c));
    await tick();
    expect(nudges()).toHaveLength(0);
  });

  it("the same look over and over still gets the nudge", async () => {
    await working([job()]);
    for (let i = 0; i < 4; i++) look(i, "gh run view 123");
    await tick();
    expect(nudges()).toHaveLength(1);
  });
});

describe("a handoff card sent again in the same session", () => {
  it("adds to the first one instead of replacing it", () => {
    const first = { did: ["built the converter", "ran 38 checks"], found: ["LibreOffice needs both arches"], next: "bundle the engine", evidence: [{ kind: "test", ref: "run-tests.sh" }], doneWhen: "a release is out" };
    const late = { did: ["checked the install log"], next: "sign and build", evidence: [{ kind: "test", ref: "run-tests.sh" }, { kind: "file", ref: "/tmp/install.log" }] };

    expect(mergeCards(first, late)).toEqual({
      did: ["built the converter", "ran 38 checks", "checked the install log"],
      found: ["LibreOffice needs both arches"],
      next: "sign and build",
      evidence: [{ kind: "test", ref: "run-tests.sh" }, { kind: "file", ref: "/tmp/install.log" }],
      doneWhen: "a release is out",
    });
    expect(mergeCards(undefined, late)).toBe(late);
  });
});
