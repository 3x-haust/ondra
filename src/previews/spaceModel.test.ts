import { describe, expect, it } from "vitest";
import {
  addSpace, canSend, computersIn, connectComputer, makeSpaceModel, memoriesIn,
  selectComputer, selectedComputer, sendMessage, setAccess, setOnline,
  showComputerPicker, showSpacePicker, workState, type Scenario, type SpaceModel,
} from "./spaceModel";

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("space and computer pickers", () => {
  it.each<{
    scenario: Scenario; spaces: string[]; computers: string[];
    spacePicker: boolean; computerPicker: boolean;
  }>([
    { scenario: "simple", spaces: ["personal"], computers: ["local"], spacePicker: false, computerPicker: false },
    { scenario: "devices", spaces: ["personal"], computers: ["local", "mini"], spacePicker: false, computerPicker: true },
    { scenario: "spaces", spaces: ["personal", "studio"], computers: ["local"], spacePicker: true, computerPicker: false },
    { scenario: "multi", spaces: ["personal", "studio"], computers: ["local", "mini"], spacePicker: true, computerPicker: true },
  ])("shows only the pickers needed for $scenario", ({ scenario, spaces, computers, spacePicker, computerPicker }) => {
    const model = makeSpaceModel(scenario);

    expect(ids(model.spaces)).toEqual(spaces);
    expect(ids(computersIn(model, "personal"))).toEqual(computers);
    expect(showSpacePicker(model)).toBe(spacePicker);
    expect(showComputerPicker(model, "personal")).toBe(computerPicker);
    expect(canSend(model, "personal")).toBe(true);
    if (spaces.includes("studio")) {
      expect(ids(computersIn(model, "studio"))).toEqual(["local"]);
      expect(showComputerPicker(model, "studio")).toBe(false);
      expect(canSend(model, "studio")).toBe(true);
    }
  });

  it("shows the computer picker even with one computer when no selection can send", () => {
    const model = setAccess(makeSpaceModel("devices"), "mini", []);

    expect(ids(computersIn(model, "personal"))).toEqual(["local"]);
    expect(showComputerPicker(model, "personal")).toBe(true);
    expect(canSend(model, "personal")).toBe(false);
  });

  it("shows recovery choices when the only allowed computer is offline", () => {
    const model = setAccess(makeSpaceModel("offline"), "local", ["studio"]);

    expect(ids(computersIn(model, "personal"))).toEqual(["mini"]);
    expect(showComputerPicker(model, "personal")).toBe(true);
    expect(canSend(model, "personal")).toBe(false);
  });
});

describe("computer selection per space", () => {
  it("remembers the last selection independently for each space ID", () => {
    const initial = setAccess(makeSpaceModel(), "mini", ["personal", "studio"]);
    const personal = selectComputer(initial, "personal", "local");
    const studio = selectComputer(personal, "studio", "mini");
    const returned = selectComputer(studio, "personal", "mini");

    expect(initial.selected).toEqual({ personal: "mini", studio: "local" });
    expect(personal.selected).toEqual({ personal: "local", studio: "local" });
    expect(studio.selected).toEqual({ personal: "local", studio: "mini" });
    expect(returned.selected).toEqual({ personal: "mini", studio: "mini" });
    expect(selectedComputer(studio, "personal")?.id).toBe("local");
    expect(selectedComputer(studio, "studio")?.id).toBe("mini");
  });

  it.each([
    { scenario: "multi", space: "studio", computer: "mini", reason: "not allowed" },
    { scenario: "offline", space: "personal", computer: "mini", reason: "offline" },
    { scenario: "multi", space: "personal", computer: "missing", reason: "unknown computer" },
    { scenario: "multi", space: "missing", computer: "local", reason: "unknown space" },
  ] as const)("rejects a selection that is $reason", ({ scenario, space, computer }) => {
    const model = selectComputer(makeSpaceModel(scenario), "personal", "local");
    const before = structuredClone(model);

    expect(selectComputer(model, space, computer)).toBe(model);
    expect(model).toEqual(before);
  });

  it("does not resolve a stale selection that lacks access to its space", () => {
    const model = makeSpaceModel();
    model.selected.studio = "mini";

    expect(selectedComputer(model, "studio")).toBeUndefined();
    expect(canSend(model, "studio")).toBe(false);
    expect(sendMessage(model, "studio", "확인해 줘")).toBe(model);
  });
});

describe("connecting computers and changing access", () => {
  it.each([
    { name: "", access: ["personal"], reason: "empty name" },
    { name: " \n\t ", access: ["personal"], reason: "blank name" },
    { name: "작업용 Mac", access: [], reason: "no spaces" },
    { name: "작업용 Mac", access: ["missing"], reason: "no valid spaces" },
  ])("rejects a connection with $reason", ({ name, access }) => {
    const model = makeSpaceModel();
    const before = structuredClone(model);

    expect(connectComputer(model, name, access)).toBe(model);
    expect(model).toEqual(before);
  });

  it("connects a named computer only to distinct valid spaces without changing selection", () => {
    const model = makeSpaceModel();
    const before = structuredClone(model);

    const connected = connectComputer(model, "  작업용 Mac  ", ["studio", "missing", "studio"]);
    const computer = connected.computers[connected.computers.length - 1];

    expect(computer).toEqual({ id: `computer-${model.next}`, name: "작업용 Mac", access: ["studio"], online: true, local: false });
    expect(ids(computersIn(connected, "studio"))).toEqual(["local", computer.id]);
    expect(ids(computersIn(connected, "personal"))).toEqual(["local", "mini"]);
    expect(connected.selected).toEqual(model.selected);
    expect(connected.next).toBe(model.next + 1);
    expect(selectedComputer(selectComputer(connected, "studio", computer.id), "studio")).toEqual(computer);
    expect(model).toEqual(before);
  });

  it("clears only revoked selections and blocks sending instead of silently switching computers", () => {
    const model = selectComputer(setAccess(makeSpaceModel(), "mini", ["personal", "studio"]), "studio", "mini");
    const before = structuredClone(model);

    const revoked = setAccess(model, "mini", ["studio", "missing", "studio"]);

    expect(revoked.computers.find((c) => c.id === "mini")?.access).toEqual(["studio"]);
    expect(revoked.selected).toEqual({ personal: null, studio: "mini" });
    expect(selectedComputer(revoked, "personal")).toBeUndefined();
    expect(canSend(revoked, "personal")).toBe(false);
    expect(sendMessage(revoked, "personal", "전송하지 마")).toBe(revoked);
    expect(canSend(revoked, "studio")).toBe(true);
    expect(model).toEqual(before);

    const restored = setAccess(revoked, "mini", ["personal", "studio"]);
    expect(restored.selected.personal).toBeNull();
    expect(canSend(restored, "personal")).toBe(false);
    expect(canSend(selectComputer(restored, "personal", "mini"), "personal")).toBe(true);
  });

  it("removes all access when none of the supplied spaces exist", () => {
    const model = setAccess(makeSpaceModel(), "mini", ["missing"]);

    expect(model.computers.find((c) => c.id === "mini")?.access).toEqual([]);
    expect(model.selected.personal).toBeNull();
    expect(canSend(model, "personal")).toBe(false);
  });

  it("rejects access changes for an unknown computer", () => {
    const model = makeSpaceModel();

    expect(setAccess(model, "missing", ["personal"])).toBe(model);
  });
});

describe("space and project memory", () => {
  it("separates space memory from project memory and from other spaces", () => {
    const model = makeSpaceModel();

    expect(ids(memoriesIn(model, "personal"))).toEqual(["personal-language", "personal-style"]);
    expect(ids(memoriesIn(model, "studio"))).toEqual(["studio-tone"]);
    expect(ids(memoriesIn(model, "personal", "~/Projects/portfolio"))).toEqual(["portfolio-menu"]);
    expect(ids(memoriesIn(model, "studio", "~/Studio/website"))).toEqual(["website-contact"]);
    expect(memoriesIn(model, "personal", "~/Studio/website")).toEqual([]);
    expect(memoriesIn(model, "studio", "~/Projects/portfolio")).toEqual([]);
    expect(memoriesIn(model, "personal", "missing")).toEqual([]);
    expect(memoriesIn(model, "missing")).toEqual([]);
  });

  it("keeps identical project paths isolated by space ID", () => {
    const model = makeSpaceModel();
    model.memory = model.memory.map((memory) => memory.id === "website-contact" ? { ...memory, project: "~/Projects/portfolio" } : memory);

    expect(ids(memoriesIn(model, "personal", "~/Projects/portfolio"))).toEqual(["portfolio-menu"]);
    expect(ids(memoriesIn(model, "studio", "~/Projects/portfolio"))).toEqual(["website-contact"]);
  });

  it("excludes invalidated memories at both scopes", () => {
    const model = makeSpaceModel();
    model.memory = model.memory.map((memory) => ["personal-language", "portfolio-menu"].includes(memory.id) ? { ...memory, invalidAt: 10 } : memory);

    expect(ids(memoriesIn(model, "personal"))).toEqual(["personal-style"]);
    expect(memoriesIn(model, "personal", "~/Projects/portfolio")).toEqual([]);
    expect(ids(memoriesIn(model, "studio"))).toEqual(["studio-tone"]);
  });

  it("creates distinct IDs for equal space names without merging memory or selections", () => {
    const model = makeSpaceModel();
    const before = structuredClone(model);
    const first = addSpace(model, "  개인  ");
    const second = addSpace(first, "개인");
    const firstId = first.spaces[first.spaces.length - 1].id;
    const secondId = second.spaces[second.spaces.length - 1].id;

    expect(new Set(ids(second.spaces)).size).toBe(second.spaces.length);
    expect(firstId).not.toBe("personal");
    expect(secondId).not.toBe(firstId);
    expect(second.spaces.slice(-2).map((space) => space.label)).toEqual(["개인", "개인"]);
    expect(second.selected).toEqual({ personal: "mini", studio: "local", [firstId]: "local", [secondId]: "local" });
    expect(ids(computersIn(second, firstId))).toEqual(["local"]);
    expect(ids(computersIn(second, secondId))).toEqual(["local"]);
    expect(memoriesIn(second, firstId)).toEqual([]);
    expect(memoriesIn(second, secondId)).toEqual([]);
    expect(ids(memoriesIn(second, "personal"))).toEqual(["personal-language", "personal-style"]);
    expect(second.memory).toEqual(model.memory);
    expect(second.next).toBe(model.next + 2);
    expect(model).toEqual(before);
  });

  it.each(["", " \n\t "])("rejects a blank space name %j", (label) => {
    const model = makeSpaceModel();

    expect(addSpace(model, label)).toBe(model);
  });
});

describe("computer disconnection and recovery", () => {
  it("keeps selection and work while marking running work unknown and blocking new sends", () => {
    const model = makeSpaceModel();
    const before = structuredClone(model);
    const running = model.work.find((work) => work.id === "mobile")!;

    const offline = setOnline(model, "mini", false);

    expect(workState(model, running)).toBe("running");
    expect(workState(offline, running)).toBe("unknown");
    expect(offline.work).toEqual(model.work);
    expect(offline.selected).toEqual(model.selected);
    expect(selectedComputer(offline, "personal")).toMatchObject({ id: "mini", online: false });
    expect(canSend(offline, "personal")).toBe(false);
    expect(sendMessage(offline, "personal", "새 작업", "portfolio")).toBe(offline);
    expect(canSend(offline, "studio")).toBe(true);
    expect(model).toEqual(before);

    const recovered = setOnline(offline, "mini", true);
    expect(workState(recovered, running)).toBe("running");
    expect(recovered.selected).toEqual(model.selected);
    expect(canSend(recovered, "personal")).toBe(true);
    expect(sendMessage(recovered, "personal", "복구 후 작업", "portfolio").work.slice(-1)[0]).toMatchObject({ space: "personal", computer: "mini", project: "portfolio", status: "queued" });
  });

  it.each(["queued", "waiting", "paused", "done", "failed"] as const)("preserves %s work status on an offline computer", (status) => {
    const model = makeSpaceModel("offline");
    const work = { ...model.work[0], status };

    expect(workState(model, work)).toBe(status);
  });

  it("treats running work on a missing computer as unknown", () => {
    const model = makeSpaceModel();

    expect(workState(model, { ...model.work[0], computer: "missing" })).toBe("unknown");
  });

  it("does not take the local computer offline", () => {
    const model = setOnline(makeSpaceModel("simple"), "local", false);

    expect(selectedComputer(model, "personal")).toMatchObject({ id: "local", online: true });
    expect(canSend(model, "personal")).toBe(true);
  });
});

describe("sending messages", () => {
  it.each([
    { space: "personal", project: "portfolio", computer: "mini" },
    { space: "studio", project: "website", computer: "local" },
    { space: "personal", project: undefined, computer: "mini" },
  ])("queues exactly one task for $space on $computer with project $project", ({ space, project, computer }) => {
    const model = makeSpaceModel();
    const before = structuredClone(model);

    const sent = sendMessage(model, space, "  화면을 확인해 줘  ", project);

    expect(sent.work).toEqual([...model.work, {
      id: `work-${model.next}`, space, project, computer,
      title: "화면을 확인해 줘", status: "queued", step: "시작 대기",
    }]);
    expect(sent.messages).toEqual([...model.messages, {
      id: `message-${model.next}`, space, text: "화면을 확인해 줘", reply: "작업을 준비했어요.", work: `work-${model.next}`,
    }]);
    expect(sent.next).toBe(model.next + 1);
    expect(sent.selected).toEqual(model.selected);
    expect(sent.memory).toEqual(model.memory);
    expect(model).toEqual(before);
  });

  it("uses the latest selected computer rather than the scenario default", () => {
    const model = selectComputer(makeSpaceModel(), "personal", "local");

    expect(sendMessage(model, "personal", "새 작업", "portfolio").work.slice(-1)[0]).toMatchObject({ space: "personal", computer: "local", project: "portfolio", status: "queued" });
  });

  it.each(["website", "missing"])("does not attach invalid project %s to a task in another space", (project) => {
    const model = makeSpaceModel();

    const sent = sendMessage(model, "personal", "공간 작업", project);

    expect(sent.work).toHaveLength(model.work.length + 1);
    expect(sent.work[sent.work.length - 1]).toMatchObject({ space: "personal", computer: "mini", project: undefined, status: "queued" });
  });

  it.each(["", " \n\t "])("rejects blank message %j without changing state", (text) => {
    const model = makeSpaceModel();
    const before = structuredClone(model);

    expect(sendMessage(model, "personal", text, "portfolio")).toBe(model);
    expect(model).toEqual(before);
  });

  it("rejects an unknown space even if a stale computer selection grants access", () => {
    const model = makeSpaceModel();
    model.selected.missing = "local";
    model.computers = model.computers.map((c) => c.id === "local" ? { ...c, access: [...c.access, "missing"] } : c);

    expect(sendMessage(model, "missing", "새 작업")).toBe(model);
  });

  it("assigns distinct task and message IDs to successive sends", () => {
    const model = makeSpaceModel();
    const first = sendMessage(model, "personal", "첫 작업", "portfolio");
    const second = sendMessage(first, "studio", "다음 작업", "website");

    expect(new Set(ids(second.work)).size).toBe(second.work.length);
    expect(new Set(ids(second.messages)).size).toBe(second.messages.length);
    expect(second.messages.slice(-2).map((message) => message.work)).toEqual(ids(second.work.slice(-2)));
    expect(second.work.slice(-2).map((work) => [work.space, work.computer, work.project])).toEqual([
      ["personal", "mini", "portfolio"], ["studio", "local", "website"],
    ]);
    expect(second.next).toBe(model.next + 2);
  });

  it("creates independent initial state for every model", () => {
    const model: SpaceModel = makeSpaceModel();
    const other = makeSpaceModel();
    const before = structuredClone(other);

    model.selected.personal = null;
    model.computers[0].access.push("extra");
    model.memory[0].text = "바뀐 기억";

    expect(other).toEqual(before);
  });
});
