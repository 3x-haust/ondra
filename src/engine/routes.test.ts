import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState, state, taskById } from "../state/store";
import type { Task } from "../state/types";
import { applyRoutes, userParked } from "./captain";
import { trimEntries } from "./tasks";

const job = (id: string, space: Task["space"], status: Task["status"]): Task => ({
  id, space, topic: "Example", title: id, ask: `Do ${id}`, cwd: "/repo", status,
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
});

beforeEach(() => {
  setState(reconcile(freshState()));
  setState("tasks", [job("w-run", "work", "running"), job("w-done", "work", "done"), job("h-run", "home", "running")]);
});

describe("main's routes stay in their space", () => {
  it("ignores the other space's jobs", async () => {
    const out = await applyRoutes("home", [
      { kind: "stop", taskId: "w-run" },
      { kind: "append", taskId: "w-run", message: "also this" },
      { kind: "append", taskId: "w-done", message: "more" },
    ], "x");
    expect(out).toEqual([]);
    expect(taskById("w-run")?.status).toBe("running");
    expect(state.tasks.length).toBe(3);
  });

  it("acts on its own jobs, and new work never waits on or follows the other space", async () => {
    const out = await applyRoutes("home", [
      { kind: "stop", taskId: "h-run" },
      { kind: "new", title: "next", task: "do next", after: ["w-run", "h-run"], from: "w-done" },
    ], "x");
    expect(out.map((r) => r.kind)).toEqual(["stop", "new"]);
    const made = taskById((out[1] as { taskId: string }).taskId)!;
    expect(made.space).toBe("home");
    expect(made.after).toEqual(["h-run"]);
    expect(made.follows).toBeUndefined();
  });
});

describe("work the user ended stays ended", () => {
  const ended = (over: Partial<Task>) => ({ ...job("h-ended", "home", "done"), ...over });

  it("main's reaction to a job's end starts no successor for work the user marked done", async () => {
    setState("tasks", (list) => [...list, ended({ endedBy: "user" })]);
    const before = state.tasks.length;
    const out = await applyRoutes("home", [
      { kind: "answer", text: "정리했어요" },
      { kind: "new", title: "이어서", task: "finish the rest", from: "h-ended" },
      { kind: "append", taskId: "h-ended", message: "finish the rest" },
    ], "Fork h-ended finished.", undefined, false);
    expect(out.map((r) => r.kind)).toEqual(["answer"]);
    expect(state.tasks.length).toBe(before);
  });

  it("the user's own request still carries it on", async () => {
    setState("tasks", (list) => [...list, ended({ endedBy: "user" })]);
    const out = await applyRoutes("home", [{ kind: "new", title: "이어서", task: "finish the rest", from: "h-ended" }], "이어서 해줘");
    expect(out.map((r) => r.kind)).toEqual(["new"]);
  });

  it("a stop reaches main's own follow-ups, not a job the user asked for again", () => {
    setState("tasks", (list) => [
      ...list,
      ended({ id: "a", parkedAt: 5 }),
      ended({ id: "auto", follows: "a", endedBy: undefined }),
      ended({ id: "asked", follows: "a", endedBy: undefined }),
    ]);
    setState("captain", [
      { id: "c1", at: 1, space: "home", from: "captain", after: "a", routes: [{ kind: "new", taskId: "auto" }] },
      { id: "c2", at: 2, space: "home", from: "me", text: "다시 해줘" },
      { id: "c3", at: 3, space: "home", from: "captain", routes: [{ kind: "new", taskId: "asked" }] },
    ]);
    expect(userParked(taskById("auto"))).toBe(true);
    expect(userParked(taskById("asked"))).toBe(false);
    expect(userParked(taskById("h-run"))).toBe(false);
  });
});

describe("trimEntries", () => {
  it("drops the oldest entries past the cap but keeps the user's words", () => {
    const entries = [
      { id: "u1", at: 1, kind: "user", text: "원래 요청" },
      ...Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, at: 2 + i, kind: "note", text: `n${i}` })),
    ] as Task["entries"];
    trimEntries(entries, 3);
    expect(entries.map((e) => e.id)).toEqual(["u1", "n3", "n4"]);
  });
});

describe("a new job lands in the right project", () => {
  beforeEach(() => {
    setState("projects", [{ id: "ondra", space: "home", name: "ondra", folder: "/p/ondra" }]);
  });

  it("a brief that only mentions a project doesn't move work into it", async () => {
    const out = await applyRoutes("home", [{
      kind: "new", title: "메모 정리 도구", cwd: "/p/notes-agent",
      project: { name: "메모 정리", folder: "/p/notes-agent" },
      task: "메모 앱 정리 도구를 만들어요. Ondra 자체 수정이나 배포는 범위가 아니에요.",
    }], "메모 정리 도구 만들어줘");
    expect(taskById((out[0] as { taskId: string }).taskId)!.project).not.toBe("ondra");
  });

  it("a folder outside every project stays out, whatever the topic says", async () => {
    const out = await applyRoutes("home", [{ kind: "new", title: "메모 도구 검증", topic: "ondra", cwd: "/p/notes-agent", task: "검증해요" }], "검증해줘");
    expect(taskById((out[0] as { taskId: string }).taskId)!.project).not.toBe("ondra");
  });

  it("the user naming the project still finds it", async () => {
    const out = await applyRoutes("home", [{ kind: "new", title: "탭 고치기", task: "panel tabs" }], "ondra 탭 고쳐줘");
    expect(taskById((out[0] as { taskId: string }).taskId)!.project).toBe("ondra");
  });
});

describe("a reply's text outside its route", () => {
  it("drops the route written out again after the fence", async () => {
    const { strayProse } = await import("./captain");
    expect(strayProse('parameter\n- kind: answer\n- text: "하이! 무엇을 도와드릴까요?"', "하이! 무엇을 도와드릴까요?")).toBe("");
    expect(strayProse("하이! 무엇을 도와드릴까요?", "하이! 무엇을 도와드릴까요?")).toBe("");
    expect(strayProse("- kind: answer\n- text: 됐어요", "")).toBe("");
  });
  it("keeps a real answer written as prose", async () => {
    const { strayProse } = await import("./captain");
    expect(strayProse("설정 › 계정에서 바꿀 수 있어요.", "")).toBe("설정 › 계정에서 바꿀 수 있어요.");
    expect(strayProse("이유는 캐시 때문이에요. 자세히 보면…", "확인했어요")).toBe("이유는 캐시 때문이에요. 자세히 보면…");
  });
});
