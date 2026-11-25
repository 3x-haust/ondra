import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { carriedOn, freshState, groupGoing, groupOf, lineHead, setState, state, stillGoing, taskById } from "../state/store";
import type { Task } from "../state/types";
import { applyRoutes } from "./captain";
import { keepJobResult } from "./results";

const job = (id: string, status: Task["status"], x: Partial<Task> = {}): Task => ({
  id, space: "home", topic: "4cut", title: id, ask: `Do ${id}`, cwd: "/repo", status,
  priority: 2, weight: "light", accountId: "default", createdAt: 1, now: "", plan: [], legs: [], entries: [], shells: [], inbox: [], ...x,
});

beforeEach(() => setState(reconcile(freshState())));

describe("a spec's tickets are one piece of work", () => {
  it("main puts steps that build on a job, and named ones, under it", async () => {
    const out = await applyRoutes("home", [
      { kind: "new", key: "spec", title: "기획서·티켓", task: "write the spec and tickets" },
      { kind: "new", key: "t1", title: "① 촬영", task: "ticket 1", after: ["spec"] },
      { kind: "new", key: "t2", title: "② 다시 찍기", task: "ticket 2", after: ["t1"] },
      { kind: "new", title: "③ 저장", task: "ticket 3", under: "spec" },
      { kind: "new", title: "딴 일", task: "unrelated" },
    ], "x");
    const [spec, t1, t2, t3, other] = out.map((r) => taskById((r as { taskId: string }).taskId)!);
    // flat: a ticket after a ticket is still under the spec
    expect([t1.group, t2.group, t3.group]).toEqual([spec.id, spec.id, spec.id]);
    expect(spec.group).toBeUndefined();
    expect(other.group).toBeUndefined();
    expect(groupOf(t2).map((x) => x.id)).toEqual([spec.id, t1.id, t2.id, t3.id]);
    // the sidebar lists them under the spec
    expect(carriedOn(t3)?.id).toBe(spec.id);
    expect(lineHead(t2).id).toBe(spec.id);
  });

  it("a fork main starts when a job ends joins that job's group", async () => {
    setState("tasks", [job("spec", "done"), job("t1", "done", { group: "spec" })]);
    setState("captain", [{ id: "c1", at: 1, space: "home", from: "captain", pending: true, after: "t1" }]);
    // main is answering c1 (t1's end): applyRoutes sees it through the message being answered
    const { mainAnswering } = await import("./captain");
    mainAnswering("home", "c1");
    const out = await applyRoutes("home", [{ kind: "new", title: "④ 배포", task: "deploy" }], "Fork t1 finished.", undefined, false);
    expect(taskById((out[0] as { taskId: string }).taskId)?.group).toBe("spec");
  });

  it("its end is the group's only when nothing else of it can still run", () => {
    setState("tasks", [
      job("spec", "done"),
      job("t1", "done", { group: "spec" }),
      job("t2", "queued", { group: "spec", after: ["t1"] }),
    ]);
    expect(groupGoing(taskById("t1")!)).toBe(true);
    // a step whose step failed never starts: it isn't going
    setState("tasks", (l) => l.map((x) => (x.id === "t1" ? { ...x, status: "failed" as const } : x)));
    expect(stillGoing(taskById("t2")!)).toBe(false);
    expect(groupGoing(taskById("t1")!)).toBe(false);
  });

  it("keeps one result for the group, each job's words under its title", () => {
    const said = (text: string) => [{ id: "u", at: 1, kind: "user" as const, text: "go" }, { id: "s", at: 2, kind: "text" as const, text }];
    const spec = job("spec", "done", { title: "4cut 기획서", summary: "티켓 5개", finishedAt: 10, entries: said("스펙을 썼어요") });
    const t1 = job("t1", "done", { title: "① 촬영", group: "spec", summary: "촬영 돼요", finishedAt: 20, entries: said("촬영을 만들었어요") });
    const t2 = job("t2", "failed", { title: "② 다시", group: "spec", finishedAt: 30 });
    setState("tasks", [spec, t1, t2]);
    keepJobResult(t1, undefined, [spec, t2, t1]);
    expect(state.results).toHaveLength(1);
    const r = state.results![0];
    expect([r.taskId, r.title]).toEqual(["spec", "4cut 기획서"]);
    expect(r.answers.map((a) => a.text)).toEqual(["### 4cut 기획서\n\n스펙을 썼어요", "### ① 촬영\n\n촬영을 만들었어요"]);
  });
});
