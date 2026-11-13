import type { CaptainMessage, Task } from "../state/types";
import { workState, type SpaceModel } from "./spaceModel";

/** Presentation data only. No host IDs are handed to the engine or remote store. */
export function spaceFixture(model: SpaceModel, at: number) {
  const tasks: Task[] = model.work.map((work, index) => {
    const unknown = workState(model, work) === "unknown";
    return {
      id: work.id, space: work.space, project: work.project,
      topic: model.projects.find((p) => p.id === work.project)?.name ?? "",
      title: work.title, ask: work.title, cwd: "", accountId: `preview-${work.space}`,
      status: unknown ? "paused" : work.status, priority: 1, weight: "light",
      createdAt: at + index, startedAt: at + index,
      now: unknown ? "연결 끊김 · 상태 미확인" : work.step,
      summary: work.status === "done" ? work.step : undefined,
      plan: work.status === "running" && !unknown ? [{ text: work.step, state: "now" }] : [],
      legs: [], shells: [], inbox: [], entries: [],
    };
  });
  const captain: CaptainMessage[] = model.messages.flatMap((m, i) => {
    const project = model.work.find((w) => w.id === m.work)?.project;
    const pair: CaptainMessage[] = [
      { id: `${m.id}-ask`, space: m.space, from: "me", text: m.text, at: at + i * 2 },
      { id: `${m.id}-reply`, space: m.space, from: "captain", reply: m.reply, routes: [{ kind: "new", taskId: m.work }], at: at + i * 2 + 1 },
    ];
    return project ? [...pair, ...pair.map((x) => ({ ...x, id: `${x.id}-project`, project }))] : pair;
  });
  return { tasks, captain };
}
