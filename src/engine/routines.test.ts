import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState, state, taskById } from "../state/store";
import type { Routine } from "../state/types";
import { applyRoutes, nowLine } from "./captain";
import { CAPTAIN_SYSTEM } from "./prompts";
import { eventText, newEvents, parseEvents } from "./routineEvents";
import { addRoutine, ALARM_LATE, NOTHING, pollRoutine, quietRun, ringAlarm, routineById, routineLine, runRoutine, runMessage, saidNothing, saveRoutine, settleRun, SNOOZE_MIN, snoozeAlarm, tickRoutines } from "./routines";
import { dayTime, describeWhen, nextRun, parseWhen } from "./routineTime";
import { agentOf } from "./tasks";
import { markDead } from "./rpc";

// local wall times: the tests run in whatever zone the machine has
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe("when a routine runs", () => {
  it("finds the next daily time, on chosen weekdays only", () => {
    // Thu 2026-11-12 10:00
    const thu = at(2026, 11, 12, 10);
    expect(nextRun({ kind: "daily", time: "09:00" }, thu)).toBe(at(2026, 11, 13, 9));
    expect(nextRun({ kind: "daily", time: "18:30" }, thu)).toBe(at(2026, 11, 12, 18, 30));
    // weekdays: Friday, then Monday after the weekend
    expect(nextRun({ kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] }, at(2026, 11, 13, 9))).toBe(at(2026, 11, 16, 9));
    expect(nextRun({ kind: "daily", time: "bad" }, thu)).toBeUndefined();
  });

  it("repeats every n minutes (not under 15), once only in the future, never for events", () => {
    expect(nextRun({ kind: "every", minutes: 5 }, 0)).toBe(15 * 60_000);
    expect(nextRun({ kind: "once", at: 100 }, 50)).toBe(100);
    expect(nextRun({ kind: "once", at: 100 }, 150)).toBeUndefined();
    expect(nextRun({ kind: "event", event: "issue" }, 0)).toBeUndefined();
  });

  it("reads like the user would say it", () => {
    expect(describeWhen({ kind: "daily", time: "09:00" })).toBe("매일 09:00");
    expect(describeWhen({ kind: "daily", time: "09:00", days: [5, 1, 2, 3, 4] })).toBe("평일 09:00");
    expect(describeWhen({ kind: "daily", time: "18:30", days: [1, 3] })).toBe("월·수 18:30");
    expect(describeWhen({ kind: "every", minutes: 120 })).toBe("2시간마다");
    expect(describeWhen({ kind: "event", event: "ci" })).toBe("기본 브랜치 CI가 실패하면");
  });

  it("takes main's loose JSON and drops what can't be right", () => {
    expect(parseWhen({ kind: "daily", time: "9:00", days: [1, 1, 9, 2] })).toEqual({ kind: "daily", time: "09:00", days: [1, 2] });
    expect(parseWhen({ kind: "every", hours: 2 })).toEqual({ kind: "every", minutes: 120 });
    expect(parseWhen({ kind: "event", event: "review", filter: " repo:x " })).toEqual({ kind: "event", event: "review", filter: "repo:x" });
    expect(parseWhen({ kind: "event", event: "push" })).toBeUndefined();
    expect(parseWhen({ kind: "once", at: "2000-01-01T00:00" })).toBeUndefined();
    expect(parseWhen("tomorrow")).toBeUndefined();
  });
});

describe("GitHub events", () => {
  it("reads each kind gh prints", () => {
    expect(parseEvents("issue", JSON.stringify([{ number: 3, title: "B", url: "u3", createdAt: "2026-11-13T02:00:00Z", author: { login: "kim" } }, { number: 2, title: "A", createdAt: "2026-11-13T01:00:00Z" }])).map((e) => e.id)).toEqual(["issue#2", "issue#3"]);
    expect(parseEvents("pr", JSON.stringify([{ number: 1, title: "draft", isDraft: true }]))).toEqual([]);
    const comments = parseEvents("comment", JSON.stringify([{ number: 9, title: "Fix", me: "me", comments: [{ id: "c1", author: { login: "kim" }, body: "nit", createdAt: "2026-11-13T01:00:00Z" }, { id: "c2", author: { login: "me" }, body: "thanks" }], reviews: [{ id: "r1", author: { login: "lee" }, state: "APPROVED", submittedAt: "2026-11-13T02:00:00Z" }] }]));
    expect(comments.map((e) => [e.id, e.body])).toEqual([["comment:c1", "nit"], ["comment:r1", "APPROVED"]]);
    expect(parseEvents("ci", JSON.stringify([{ databaseId: 5, conclusion: "failure", workflowName: "test" }, { databaseId: 6, conclusion: "success" }, { databaseId: 7, conclusion: "" }])).map((e) => e.id)).toEqual(["run:5"]);
    expect(parseEvents("release", "not json")).toEqual([]);
  });

  it("fires only for what came after it started looking, once each", () => {
    const items = parseEvents("issue", JSON.stringify([{ number: 1, title: "old", createdAt: "2026-11-13T00:00:00Z" }]));
    const first = newEvents({ when: { kind: "event", event: "issue" } }, items, Date.parse("2026-11-13T01:00:00Z"));
    expect(first.fresh).toEqual([]);
    const more = parseEvents("issue", JSON.stringify([{ number: 1, title: "old", createdAt: "2026-11-13T00:00:00Z" }, { number: 2, title: "new", createdAt: "2026-11-13T02:00:00Z" }]));
    const next = newEvents({ when: { kind: "event", event: "issue" }, seen: first.seen, since: first.since }, more, Date.parse("2026-11-13T03:00:00Z"));
    expect(next.fresh.map((e) => e.id)).toEqual(["issue#2"]);
    expect(newEvents({ when: { kind: "event", event: "issue" }, seen: next.seen, since: next.since }, more, Date.now()).fresh).toEqual([]);
    expect(eventText(next.fresh)).toContain("#2 new");
  });
});

describe("routine runs", () => {
  beforeEach(() => {
    setState(reconcile(freshState()));
    setState("spaces", [{ id: "home", label: "개인", folder: "~", rules: "" }]);
    setState("projects", [{ id: "p-app", space: "home", name: "app", folder: "/repo/app" }] as never);
    vi.spyOn(native, "agentSend").mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    for (const t of state.tasks) markDead(agentOf(t.id));
    vi.restoreAllMocks();
  });
  const make = (over: Partial<Routine> = {}) => {
    const id = addRoutine({ space: "home", title: "PR 정리", prompt: "열린 PR 정리", when: { kind: "every", minutes: 60 }, mode: "fresh", project: "p-app", ...over });
    return routineById(id)!;
  };

  it("starts a job that says which routine and run it is, and marks it", () => {
    const r = make();
    const id = runRoutine(r.id, { manual: true })!;
    const t = taskById(id)!;
    expect(t.routine).toBe(r.id);
    expect(t.project).toBe("p-app");
    expect(t.ask).toContain("루틴 «PR 정리»");
    expect(t.ask).toContain("열린 PR 정리");
    expect(t.ask).toContain(NOTHING);
    expect(routineById(r.id)).toMatchObject({ runs: 1, lastTask: id, lastStatus: "running" });
  });

  it("fresh: the next run follows the last on its line, but waits while it still runs", () => {
    const r = make();
    const first = runRoutine(r.id, { manual: true })!;
    setState("tasks", (x) => x.id === first, { status: "running" });
    expect(runRoutine(r.id)).toBeUndefined();
    expect(routineById(r.id)!.lastStatus).toBe("skipped");
    setState("tasks", (x) => x.id === first, { status: "done" });
    const second = runRoutine(r.id)!;
    expect(taskById(second)!.follows).toBe(first);
  });

  it("continue: the next run goes on in the last run's conversation", () => {
    const r = make({ mode: "continue" });
    const first = runRoutine(r.id, { manual: true })!;
    setState("tasks", (x) => x.id === first, { status: "done" });
    const second = runRoutine(r.id)!;
    // a finished job carries on in a job on its line (relay)
    expect(taskById(second)!.follows).toBe(first);
    expect(taskById(second)!.routine).toBe(r.id);
  });

  it("starts what is due once, even after a long sleep, and sets the next time from now", async () => {
    const r = make();
    saveRoutine(r.id, { nextAt: Date.now() - 3 * 86_400_000 });
    await tickRoutines(Date.now());
    const after = routineById(r.id)!;
    expect(after.runs).toBe(1);
    expect(after.nextAt!).toBeGreaterThan(Date.now());
    expect(taskById(after.lastTask!)!.ask).toContain("Mac이 잠들어 있었어요");
    await tickRoutines(Date.now());
    expect(routineById(r.id)!.runs).toBe(1);
  });

  it("a draft or a switched-off routine doesn't run by itself", async () => {
    const d = make({ draft: true });
    const off = make();
    saveRoutine(d.id, { nextAt: 0 });
    saveRoutine(off.id, { enabled: false, nextAt: 0 } as never);
    await tickRoutines(Date.now());
    expect(routineById(d.id)!.runs + routineById(off.id)!.runs).toBe(0);
  });

  it("a run with nothing to report is put away quietly", () => {
    const r = make();
    const id = runRoutine(r.id, { manual: true })!;
    setState("tasks", (x) => x.id === id, { status: "done", summary: `${NOTHING} 새 PR 없음` });
    const t = taskById(id)!;
    expect(saidNothing(t)).toBe(true);
    expect(quietRun(t)).toBe(true);
    settleRun(t);
    expect(taskById(id)!.archived).toBe(true);
    expect(routineById(r.id)!.lastStatus).toBe("nothing");
  });

  it("an event routine looks at the repo and runs for what is new", async () => {
    const r = make({ when: { kind: "event", event: "issue" } });
    const spy = vi.spyOn(native, "ghWatch").mockResolvedValueOnce("[]").mockResolvedValueOnce(JSON.stringify([{ number: 7, title: "로그인 버그", createdAt: new Date(Date.now() + 1000).toISOString(), url: "https://x/7" }]));
    vi.spyOn(native, "spaceEnv").mockResolvedValue([]);
    await pollRoutine(routineById(r.id)!);
    expect(routineById(r.id)!.runs).toBe(0);
    await pollRoutine(routineById(r.id)!);
    expect(spy).toHaveBeenCalledWith("/repo/app", "issue", "", []);
    const t = taskById(routineById(r.id)!.lastTask!)!;
    expect(t.ask).toContain("#7 로그인 버그");
  });

  it("main proposes one as a card; it runs only once saved", async () => {
    const out = await applyRoutes("home", [{ kind: "routine", title: "아침 정리", task: "어제 머지된 PR 요약", when: { kind: "daily", time: "09:00", days: [1, 2, 3, 4, 5] }, project: "app" }], "평일 9시마다 어제 머지된 PR 요약해줘");
    expect(out[0].kind).toBe("routine");
    const r = routineById((out[0] as { routineId: string }).routineId)!;
    expect(r).toMatchObject({ draft: true, enabled: false, project: "p-app", mode: "continue", quiet: true });
    expect(runRoutine(r.id)).toBeUndefined();
    saveRoutine(r.id, { draft: false });
    expect(routineById(r.id)).toMatchObject({ draft: false, enabled: true });
    expect(routineById(r.id)!.nextAt).toBeGreaterThan(Date.now());
    expect(CAPTAIN_SYSTEM).toContain('"routine"');
  });

  it("runMessage gives the event part and the quiet rule", () => {
    const r = make({ quiet: false });
    const m = runMessage(routineById(r.id)!, Date.now(), "- #1 x");
    expect(m).toContain("## 새로 생긴 것");
    expect(m).not.toContain(NOTHING);
  });
});

describe("alarms", () => {
  let notified: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    setState(reconcile(freshState()));
    setState("spaces", [{ id: "home", label: "개인", folder: "~", rules: "" }]);
    setState("projects", [{ id: "p-app", space: "home", name: "app", folder: "/repo/app" }] as never);
    vi.spyOn(native, "agentSend").mockResolvedValue(undefined as never);
    notified = vi.spyOn(native, "notify").mockResolvedValue(undefined as never);
  });
  afterEach(() => vi.restoreAllMocks());
  const alarm = (over: Partial<Routine> = {}) => routineById(addRoutine({ space: "home", title: "회의", prompt: "회의 있어요", when: { kind: "once", at: Date.now() + 600_000 }, mode: "fresh", quiet: false, alarm: true, ...over }))!;
  const rang = () => state.captain.flatMap((m) => (m.routes ?? []).filter((r) => r.kind === "alarm").map((r) => ({ m, r: r as Extract<typeof r, { kind: "alarm" }> })));

  it("reads \"N분 뒤\" as minutes from now, and says a day as today or tomorrow", () => {
    const now = at(2026, 11, 13, 14, 3);
    expect(parseWhen({ kind: "once", in: 10 }, now)).toEqual({ kind: "once", at: now + 600_000 });
    expect(parseWhen({ kind: "once", in: 0 }, now)).toBeUndefined();
    expect(dayTime(at(2026, 11, 13, 15), now)).toBe("오늘 15:00");
    expect(dayTime(at(2026, 11, 14, 9), now)).toBe("내일 09:00");
    expect(dayTime(at(2026, 11, 20, 9), now)).toBe("11/20 09:00");
    expect(describeWhen({ kind: "once", at: at(2026, 11, 14, 9) }, now)).toBe("내일 09:00 한 번");
  });

  it("main sets one at once from the chat: on, no draft, no job, a card in the chat", async () => {
    const before = Date.now();
    const out = await applyRoutes("home", [{ kind: "alarm", text: "회의 있어요", when: { kind: "once", in: 10 } }], "10분 뒤에 회의 있다고 알려줘");
    expect(out).toEqual([{ kind: "routine", routineId: expect.any(String), alarm: true }]);
    const r = routineById((out[0] as { routineId: string }).routineId)!;
    expect(r).toMatchObject({ alarm: true, enabled: true, prompt: "회의 있어요", from: "chat" });
    expect(r.draft).toBeFalsy();
    expect(r.nextAt! - before).toBeGreaterThanOrEqual(600_000);
    expect(r.nextAt! - before).toBeLessThan(605_000);
    expect(state.tasks).toHaveLength(0);
    const daily = await applyRoutes("home", [{ kind: "alarm", text: "퇴근하세요", when: { kind: "daily", time: "18:00" } }], "매일 6시에 퇴근하라고 알려줘");
    expect(routineById((daily[0] as { routineId: string }).routineId)!.when).toEqual({ kind: "daily", time: "18:00" });
    // no time it can use (or a GitHub event): main asks instead
    const bad = await applyRoutes("home", [{ kind: "alarm", text: "x", when: { kind: "event", event: "issue" } }], "이슈 오면 알려줘");
    expect(bad[0].kind).toBe("answer");
    expect(CAPTAIN_SYSTEM).toContain('"alarm"');
  });

  it("an alarm set in a project's chat rings there", async () => {
    const out = await applyRoutes("home~p-app", [{ kind: "alarm", text: "PR 리뷰하기", when: { kind: "once", at: "2099-01-01T09:00" } }], "내일 아침 9시에 PR 리뷰하라고 알려줘");
    const r = routineById((out[0] as { routineId: string }).routineId)!;
    expect(r.project).toBe("p-app");
    expect(r.nextAt).toBe(new Date(2099, 0, 1, 9, 0).getTime());
    ringAlarm(r.id, r.nextAt!);
    expect(rang()[0].m).toMatchObject({ space: "home", project: "p-app", from: "captain" });
  });

  it("once: rings at its time with its words, a sound and the line's id; once only; no job, no model", async () => {
    const r = alarm();
    await tickRoutines(r.nextAt! - 1);
    expect(rang()).toHaveLength(0);
    await tickRoutines(r.nextAt! + 1_000, { alarmsOnly: true });
    const [{ m, r: route }] = rang();
    expect(route).toMatchObject({ routineId: r.id, text: "회의 있어요", due: r.nextAt });
    expect(route.late).toBeUndefined();
    expect(m).toMatchObject({ space: "home", from: "captain", relay: true });
    expect(notified).toHaveBeenCalledWith("회의 있어요", expect.stringContaining("알람"), { sound: true, tag: m.id });
    expect(routineById(r.id)).toMatchObject({ enabled: false, runs: 1, nextAt: undefined });
    expect(routineLine(routineById(r.id)!)).toBe("울렸어요");
    await tickRoutines(r.nextAt! + 120_000);
    expect(rang()).toHaveLength(1);
    expect(state.tasks).toHaveLength(0);
    expect(native.agentSend).not.toHaveBeenCalled();
  });

  it("daily: rings and is set for the next day", async () => {
    const r = alarm({ when: { kind: "daily", time: "18:00" } });
    const due = r.nextAt!;
    await tickRoutines(due + 5_000);
    expect(rang()).toHaveLength(1);
    const after = routineById(r.id)!;
    expect(after.enabled).toBe(true);
    expect(new Date(after.nextAt!).getHours()).toBe(18);
    expect(after.nextAt! - due).toBeGreaterThanOrEqual(23 * 3_600_000);
    expect(routineLine(after, due + 5_000)).toContain("다음 알림");
  });

  it("missed while Ondra was closed: rings once on the next launch, marked late", async () => {
    const r = alarm({ when: { kind: "daily", time: "09:00" } });
    saveRoutine(r.id, { nextAt: Date.now() - 3 * 86_400_000 });
    await tickRoutines(Date.now(), { alarmsOnly: true });
    await tickRoutines(Date.now(), { alarmsOnly: true });
    expect(rang()).toHaveLength(1);
    expect(rang()[0].r.late).toBe(true);
    expect(notified.mock.calls[0][1]).toContain("늦게 울렸어요");
    expect(routineById(r.id)!.nextAt!).toBeGreaterThan(Date.now());
    // a minute or two behind (the minute tick) is not late
    const soon = alarm();
    await tickRoutines(soon.nextAt! + ALARM_LATE - 1_000);
    expect(rang()[1].r.late).toBeUndefined();
  });

  it("switched off or not saved yet: never rings", async () => {
    const off = alarm();
    saveRoutine(off.id, { enabled: false });
    const draft = alarm({ draft: true });
    await tickRoutines(Date.now() + 86_400_000);
    expect(rang()).toHaveLength(0);
    expect(routineById(draft.id)!.runs + routineById(off.id)!.runs).toBe(0);
  });

  it("snooze rings it again later and leaves its own time alone; switching it off drops the snooze", async () => {
    const r = alarm({ when: { kind: "daily", time: "18:00" } });
    const t0 = r.nextAt!;
    await tickRoutines(t0);
    const next = routineById(r.id)!.nextAt;
    snoozeAlarm(r.id, t0);
    expect(routineLine(routineById(r.id)!, t0)).toContain("다시 알려요");
    await tickRoutines(t0 + SNOOZE_MIN * 60_000 - 1_000);
    expect(rang()).toHaveLength(1);
    await tickRoutines(t0 + SNOOZE_MIN * 60_000);
    expect(rang()).toHaveLength(2);
    expect(rang()[1].r.due).toBe(t0 + SNOOZE_MIN * 60_000);
    expect(routineById(r.id)).toMatchObject({ nextAt: next, snoozeAt: undefined });
    // a once alarm that rang can be snoozed too
    const once = alarm();
    await tickRoutines(once.nextAt!);
    snoozeAlarm(once.id, once.nextAt!);
    await tickRoutines(once.nextAt! + SNOOZE_MIN * 60_000);
    expect(rang().filter((x) => x.r.routineId === once.id)).toHaveLength(2);
    // off: no snooze either
    snoozeAlarm(r.id, t0);
    saveRoutine(r.id, { enabled: false });
    await tickRoutines(t0 + SNOOZE_MIN * 60_000);
    expect(rang()).toHaveLength(4);
  });

  it("the quick alarm look at launch starts no job routine", async () => {
    const job = addRoutine({ space: "home", title: "PR 정리", prompt: "열린 PR 정리", when: { kind: "every", minutes: 60 }, mode: "fresh", project: "p-app" });
    saveRoutine(job, { nextAt: Date.now() - 1_000 });
    await tickRoutines(Date.now(), { alarmsOnly: true });
    expect(routineById(job)!.runs).toBe(0);
  });

  it("main is told the time with each message", () => {
    expect(nowLine(at(2026, 11, 13, 9, 5))).toBe("2026-11-13 Fri 09:05");
  });
});
