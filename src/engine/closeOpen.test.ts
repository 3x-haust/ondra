import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState, state } from "../state/store";
import type { Entry, Task } from "../state/types";
import { closeOpen, createTask, pauseTask, stopTask } from "./tasks";

const tool = (id: string, endedAt?: number, ok?: boolean): Entry => ({ id, at: 1, kind: "tool", tool: { name: "bash", kind: "bash", target: "pnpm test", ...(endedAt ? { endedAt, ok } : {}) } });
const job = (over: Partial<Task> = {}): Task => ({
  id: "job", space: "home", topic: "Example", title: "Run tests", ask: "Run the tests.", cwd: "/x", status: "running",
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "테스트 실행 중", plan: [], legs: [{ startedAt: 1 }],
  entries: [tool("a", 5, true), tool("b")], shells: [{ id: "b", command: "pnpm test", startedAt: 2, tail: "" }], inbox: [], ...over,
});
const tools = (id: string) => state.tasks.find((t) => t.id === id)!.entries.flatMap((e) => (e.kind === "tool" ? [e.tool] : []));

beforeEach(() => setState(reconcile(freshState())));

describe("a run that ends leaves nothing spinning", () => {
  it("closes open tool calls and shells, as stopped (no ok)", () => {
    const t = job();
    closeOpen(t, 9);
    const [done, cut] = t.entries.flatMap((e) => (e.kind === "tool" ? [e.tool] : []));
    expect(done).toMatchObject({ endedAt: 5, ok: true });
    expect(cut.endedAt).toBe(9);
    expect(cut.ok).toBeUndefined();
    expect(t.shells[0].endedAt).toBe(9);
  });

  it("on pause", () => {
    setState("tasks", [job()]);
    pauseTask("job");
    expect(tools("job").every((x) => x.endedAt)).toBe(true);
    expect(tools("job")[1].ok).toBeUndefined();
    expect(state.tasks[0].status).toBe("paused");
  });

  it("on stop, for its running subagents too", () => {
    setState("tasks", [job(), job({ id: "kid", parentId: "job" })]);
    stopTask("job");
    expect(tools("job").every((x) => x.endedAt)).toBe(true);
    expect(tools("kid").every((x) => x.endedAt)).toBe(true);
  });
});

describe("a new task's title", () => {
  it("is cut where a word ends, with …", () => {
    const id = createTask({ space: "home", topic: "", title: "로그인 후 원래 보던 페이지로 돌아가게 리다이렉트 처리를 고치고 테스트까지 추가하기", ask: "x" });
    const title = state.tasks.find((t) => t.id === id)!.title;
    expect(title).toBe("로그인 후 원래 보던 페이지로 돌아가게 리다이렉트 처리를 고치고…");
  });
  it("stays whole when it fits", () => {
    const id = createTask({ space: "home", topic: "", title: "  README 정리 ", ask: "x" });
    expect(state.tasks.find((t) => t.id === id)!.title).toBe("README 정리");
  });
});
