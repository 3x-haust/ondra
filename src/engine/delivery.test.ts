import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state } from "../state/store";
import type { Entry, Task } from "../state/types";
import { startRpc } from "./rpc";
import { finishTask, pauseTask, startTask, tell } from "./tasks";

const job = (over: Partial<Task> = {}): Task => ({
  id: "job", space: "home", topic: "Example", title: "Guest first",
  ask: "Make the app usable without login.", cwd: "/workspace/example", status: "queued",
  priority: 2, weight: "light", accountId: "default", createdAt: 1,
  now: "", plan: [], legs: [{ startedAt: 1 }], entries: [], shells: [], inbox: [],
  isolate: false, answer: true, ...over,
});
const review = (over: Partial<Task> = {}): Task =>
  job({ id: "review", parentId: "job", review: true, status: "running", title: "코드 리뷰", result: "P2: the guest bookmark still writes to the server", answer: undefined, ...over });

const FINDING = "P2: the guest bookmark still writes to the server";
const sent = (type: string) => vi.mocked(native.agentSend).mock.calls.filter(([, c]) => c.type === type).map(([, c]) => String(c.message));
const last = (xs: string[]) => xs[xs.length - 1];
const task = (id: string) => state.tasks.find((t) => t.id === id)!;

let emit: (ev: unknown) => void;
let exit: () => void;
/** what the engine still has queued when asked to clear it */
let queued: string[] = [];

beforeEach(async () => {
  setState(reconcile(freshState()));
  queued = [];
  const events = new Map<string, (payload: unknown) => void>();
  vi.spyOn(native, "onEvent").mockImplementation(async (name, fn) => {
    events.set(name, fn as (payload: unknown) => void);
    return () => { events.delete(name); };
  });
  vi.spyOn(native, "agentSpawn").mockResolvedValue();
  vi.spyOn(native, "agentSend").mockImplementation(async (id, command) => {
    emit = (ev: unknown) => events.get("agent:event")?.({ id, ev });
    exit = () => events.get("agent:exit")?.({ id, code: null });
    const data = command.type === "clear_queue" ? { steering: [], followUp: queued } : {};
    emit({ id: command.id, type: "response", success: true, data });
    // the job's first prompt: it starts working (a long bash call) and keeps going
    if (command.type === "prompt" && sent("prompt").length === 1) setTimeout(() => emit({ type: "agent_start" }));
  });
  await startRpc();
});
afterEach(() => {
  for (const t of state.tasks) pauseTask(t.id);
  vi.restoreAllMocks();
});

/** the job is working; its review ends and the result is queued for it */
async function reviewArrives() {
  setState("tasks", [job(), review()]);
  await startTask("job");
  await vi.waitFor(() => expect(sent("prompt")).toHaveLength(1));
  await new Promise((r) => setTimeout(r));
  finishTask("review");
  await vi.waitFor(() => expect(sent("follow_up")).toHaveLength(1));
  return sent("follow_up")[0];
}

describe("a subagent's result reaches its job", () => {
  it("is kept while queued and goes in with the resume after the engine died", async () => {
    const message = await reviewArrives();
    expect(message).toContain(FINDING);
    expect(task("job").pending).toEqual([{ text: message, from: "review" }]);

    // Ondra restarts (an update) before the job's turn ends: the engine and its queue are gone
    exit();
    await startTask("job", true);

    const resumed = last(sent("prompt"));
    expect(resumed).toContain("Ondra가 다시 시작됐어요");
    expect(resumed).toContain(FINDING);
    expect(task("job").pending).toBeUndefined();
    expect(task("review").taken).toBeTypeOf("number");
  });

  it("is not given twice once the model took it", async () => {
    const message = await reviewArrives();
    emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: message }] } });
    expect(task("job").pending).toBeUndefined();
    expect(task("review").taken).toBeTypeOf("number");

    exit();
    await startTask("job", true);

    expect(last(sent("prompt"))).not.toContain(FINDING);
  });

  it("still queued when the turn ended goes in then; taken ones are let go", async () => {
    const message = await reviewArrives();
    queued = [message];
    emit({ type: "agent_settled" });
    await vi.waitFor(() => expect(last(sent("prompt"))).toBe(message));
    expect(vi.mocked(native.agentSend).mock.calls.some(([, c]) => c.type === "clear_queue")).toBe(true);
  });

  it("taken before the turn ended (no start heard) is not sent again", async () => {
    await reviewArrives();
    queued = [];
    emit({ type: "agent_settled" });
    await vi.waitFor(() => expect(task("job").pending).toBeUndefined());
    // the review is not sent again; the only other prompt is Ondra asking once whether the job is finished
    expect(sent("prompt").filter((m) => !m.includes("without a done block"))).toHaveLength(1);
    expect(task("review").taken).toBeTypeOf("number");
  });

  it("the user's steered words come back once after the engine died", async () => {
    setState("tasks", [job()]);
    await startTask("job");
    await vi.waitFor(() => expect(sent("prompt")).toHaveLength(1));
    await new Promise((r) => setTimeout(r));
    await tell("job", "also do the onboarding pages", { now: true });
    expect(sent("steer")).toHaveLength(1);
    // the user's words first, then the note that a question gets answered before more work
    expect(sent("steer")[0]).toMatch(/^also do the onboarding pages\n\n\(Ondra\) The user said this while you were working/);

    exit();
    await startTask("job", true);

    expect(last(sent("prompt")).split("also do the onboarding pages")).toHaveLength(2);
  });
});

describe("a resumed job with a finished review it never got", () => {
  const turn = (at: number): Entry => ({ id: `e${at}`, at, kind: "turn", ms: 2000 });

  it("is given the review's findings", async () => {
    setState("tasks", [job({ entries: [turn(3)] }), review({ status: "done", finishedAt: 5, legs: [{ startedAt: 2, endedAt: 5 }] })]);
    await startTask("job", true);

    const resumed = last(sent("prompt"));
    expect(resumed).toContain('리뷰 결과가 왔어요 ("코드 리뷰")');
    expect(resumed).toContain(FINDING);
    expect(task("review").taken).toBeTypeOf("number");
  });

  it("is not, when a turn of the job ended after the review did", async () => {
    setState("tasks", [job({ entries: [turn(9)] }), review({ status: "done", finishedAt: 5, legs: [{ startedAt: 2, endedAt: 5 }] })]);
    await startTask("job", true);

    expect(last(sent("prompt"))).not.toContain(FINDING);
  });
});

describe("a refused request", () => {
  it("is told apart from limits and outages", async () => {
    const { isRefusedRequest } = await import("./tasks");
    expect(isRefusedRequest('{"detail":"Bad Request"}')).toBe(true);
    expect(isRefusedRequest('400 {"error":{"type":"invalid_request_error","message":"bad image"}}')).toBe(true);
    expect(isRefusedRequest("400 context_length_exceeded: maximum context length")).toBe(false);
    expect(isRefusedRequest("429 rate limit")).toBe(false);
  });
});
