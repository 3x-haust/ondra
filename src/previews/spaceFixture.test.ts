import { describe, expect, it } from "vitest";
import { spaceFixture } from "./spaceFixture";
import { makeSpaceModel, sendMessage, setOnline } from "./spaceModel";

const at = 1_700_000_000_000;
const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("space fixture tasks", () => {
  it("maps running work to display data without changing the model", () => {
    const model = makeSpaceModel();
    const before = structuredClone(model);

    const { tasks } = spaceFixture(model, at);

    expect(tasks[0]).toEqual({
      id: "mobile", space: "personal", project: "portfolio", topic: "포트폴리오",
      title: "모바일 화면 점검", ask: "모바일 화면 점검", cwd: "", accountId: "preview-personal",
      status: "running", priority: 1, weight: "light", createdAt: at, startedAt: at,
      now: "메뉴와 입력창을 확인하고 있어요", summary: undefined,
      plan: [{ text: "메뉴와 입력창을 확인하고 있어요", state: "now" }],
      legs: [], shells: [], inbox: [], entries: [],
    });
    expect(tasks.map((task) => [task.id, task.createdAt, task.startedAt])).toEqual([
      ["mobile", at, at], ["images", at + 1, at + 1], ["contact", at + 2, at + 2],
    ]);
    expect(model).toEqual(before);
  });

  it("keeps task space and project IDs distinct even when project names match", () => {
    const model = sendMessage(makeSpaceModel(), "personal", "공간 전체 점검");
    model.projects = model.projects.map((project) => ({ ...project, name: "같은 이름" }));

    const { tasks } = spaceFixture(model, at);

    expect(tasks.map((task) => [task.id, task.space, task.project, task.topic, task.accountId])).toEqual([
      ["mobile", "personal", "portfolio", "같은 이름", "preview-personal"],
      ["images", "personal", "portfolio", "같은 이름", "preview-personal"],
      ["contact", "studio", "website", "같은 이름", "preview-studio"],
      ["work-1", "personal", undefined, "", "preview-personal"],
    ]);
  });

  it("uses an empty topic when the referenced project no longer exists", () => {
    const model = makeSpaceModel();
    model.projects = [];

    const { tasks } = spaceFixture(model, at);

    expect(tasks.map((task) => [task.project, task.topic])).toEqual([
      ["portfolio", ""], ["portfolio", ""], ["website", ""],
    ]);
  });

  it("does not expose execution host IDs in tasks or captain messages", () => {
    const model = makeSpaceModel();
    const hostId = "execution-host-must-not-leak";
    model.computers = model.computers.map((computer) => ({ ...computer, id: hostId }));
    model.work = model.work.map((work) => ({ ...work, computer: hostId }));
    model.selected = { personal: hostId, studio: hostId };

    const fixture = spaceFixture(model, at);

    expect(JSON.stringify(fixture)).not.toContain(hostId);
    for (const item of [...fixture.tasks, ...fixture.captain]) {
      expect(item).not.toHaveProperty("computer");
      expect(item).not.toHaveProperty("hostId");
      expect(item).not.toHaveProperty("remote");
    }
    expect(fixture.tasks.map((task) => [task.cwd, task.accountId])).toEqual([
      ["", "preview-personal"], ["", "preview-personal"], ["", "preview-studio"],
    ]);
  });
});

describe("space fixture captain messages", () => {
  it("pairs each user message with its reply and task in both space and project chats", () => {
    const model = makeSpaceModel();

    const { captain } = spaceFixture(model, at);

    expect(captain).toEqual([
      { id: "first-ask", space: "personal", from: "me", text: "포트폴리오의 모바일 화면을 점검해 줘", at },
      { id: "first-reply", space: "personal", from: "captain", reply: "모바일 메뉴와 입력창부터 살펴볼게요.", routes: [{ kind: "new", taskId: "mobile" }], at: at + 1 },
      { id: "first-ask-project", space: "personal", project: "portfolio", from: "me", text: "포트폴리오의 모바일 화면을 점검해 줘", at },
      { id: "first-reply-project", space: "personal", project: "portfolio", from: "captain", reply: "모바일 메뉴와 입력창부터 살펴볼게요.", routes: [{ kind: "new", taskId: "mobile" }], at: at + 1 },
    ]);
  });

  it("isolates chats across spaces and projects without losing task routes or message order", () => {
    const initial = makeSpaceModel();
    initial.projects.push({ id: "notes", space: "personal", name: "메모", folder: "~/Projects/notes" });
    const studio = sendMessage(initial, "studio", "문의 화면 확인", "website");
    const personal = sendMessage(studio, "personal", "공간 전체 확인");
    const model = sendMessage(personal, "personal", "메모 확인", "notes");

    const { captain, tasks } = spaceFixture(model, at);
    const chat = (space: string, project?: string) => captain.filter((message) => message.space === space && message.project === project);

    expect(ids(chat("personal"))).toEqual(["first-ask", "first-reply", "message-2-ask", "message-2-reply", "message-3-ask", "message-3-reply"]);
    expect(ids(chat("personal", "portfolio"))).toEqual(["first-ask-project", "first-reply-project"]);
    expect(ids(chat("personal", "notes"))).toEqual(["message-3-ask-project", "message-3-reply-project"]);
    expect(ids(chat("studio"))).toEqual(["message-1-ask", "message-1-reply"]);
    expect(ids(chat("studio", "website"))).toEqual(["message-1-ask-project", "message-1-reply-project"]);
    expect(chat("personal", "website")).toEqual([]);
    expect(chat("studio", "portfolio")).toEqual([]);
    expect(captain).toHaveLength(14);
    expect(new Set(ids(captain)).size).toBe(14);
    for (const [index, message] of model.messages.entries()) {
      const pair = chat(message.space).filter((item) => item.id === `${message.id}-ask` || item.id === `${message.id}-reply`);
      expect(pair).toEqual([
        { id: `${message.id}-ask`, space: message.space, from: "me", text: message.text, at: at + index * 2 },
        { id: `${message.id}-reply`, space: message.space, from: "captain", reply: message.reply, routes: [{ kind: "new", taskId: message.work }], at: at + index * 2 + 1 },
      ]);
      expect(tasks.find((task) => task.id === message.work)?.space).toBe(message.space);
    }
  });

  it.each(["unscoped", "missing"] as const)("does not invent a project chat for %s work", (kind) => {
    const model = sendMessage(makeSpaceModel("simple"), "personal", "첫 작업");
    if (kind === "missing") model.work = [];

    const { captain } = spaceFixture(model, at);

    expect(captain).toEqual([
      { id: "message-1-ask", space: "personal", from: "me", text: "첫 작업", at },
      { id: "message-1-reply", space: "personal", from: "captain", reply: "작업을 준비했어요.", routes: [{ kind: "new", taskId: "work-1" }], at: at + 1 },
    ]);
  });
});

describe("space fixture disconnection and recovery", () => {
  it("shows disconnected running work as unknown and restores its progress after reconnecting", () => {
    const model = makeSpaceModel();
    const before = spaceFixture(model, at);
    const offline = setOnline(model, "mini", false);

    const disconnected = spaceFixture(offline, at);
    const recovered = spaceFixture(setOnline(offline, "mini", true), at);

    expect(disconnected.tasks[0]).toEqual({
      ...before.tasks[0], status: "paused", now: "연결 끊김 · 상태 미확인", plan: [],
    });
    expect(disconnected.tasks.slice(1)).toEqual(before.tasks.slice(1));
    expect(disconnected.captain).toEqual(before.captain);
    expect(offline.work).toEqual(model.work);
    expect(offline.work[0].status).toBe("running");
    expect(recovered).toEqual(before);
  });

  it("shows running work on a missing computer as unknown rather than running", () => {
    const model = makeSpaceModel();
    model.computers = model.computers.filter((computer) => computer.id !== "mini");

    const { tasks } = spaceFixture(model, at);

    expect(tasks[0]).toMatchObject({ id: "mobile", status: "paused", now: "연결 끊김 · 상태 미확인", plan: [] });
  });

  it.each(["queued", "waiting", "paused", "done", "failed"] as const)("preserves %s work on an offline computer without a running plan", (status) => {
    const model = makeSpaceModel("offline");
    model.work = [{ ...model.work[0], status }];

    const { tasks } = spaceFixture(model, at);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      status, now: "메뉴와 입력창을 확인하고 있어요", plan: [],
      summary: status === "done" ? "메뉴와 입력창을 확인하고 있어요" : undefined,
    });
  });
});

describe("empty space fixture", () => {
  it("starts with no tasks or messages in the simple scenario", () => {
    const model = makeSpaceModel("simple");

    expect(spaceFixture(model, at)).toEqual({ tasks: [], captain: [] });
  });
});
