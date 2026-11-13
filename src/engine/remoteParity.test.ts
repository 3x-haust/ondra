// Another Mac's jobs work here as this Mac's do: every action on one goes to that Mac (far), its
// questions come over and are answered there, and a new job in its project carries all it was asked with.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { decisionFor, decisionsIn, freshState, queueWith, setState, state, taskById } from "../state/store";
import { mirror, readAt, remoteProjectId, setMirror } from "../state/mirror";
import type { Decision, Task } from "../state/types";
import { apply, onFarEnded, onPeer } from "./hosts";
import { create, decisionsFor, secretCalls } from "./remote";
import { createTask, decide, duplicateTask, finishTask, markRead, pauseTask, setPriority, setTaskAccount, setWeight, togglePin } from "./tasks";

// remote.ts names accounts with the picker's words (a UI module, not loadable without a window)
vi.mock("../ui/AccountPicker", () => ({ accountName: () => "", service: (p: string) => p }));

const HOST = "a".repeat(64);
const job = (over: Partial<Task> = {}): Task => ({
  id: "far1", space: "home", topic: "Example", title: "Fix login",
  ask: "Fix the login redirect.", cwd: "/there/repo", status: "running",
  priority: 2, weight: "light", accountId: "acc-there", createdAt: 1,
  now: "", plan: [], legs: [], entries: [], shells: [], inbox: [],
  ...over,
});
/** a job's fields as that Mac sends them (its entries go apart) */
const head = (over: Partial<Task> = {}) => {
  const { entries: _, ...rest } = job(over);
  return rest;
};
const ask = (over: Partial<Decision> = {}): Decision => ({ id: "d1", taskId: "far1", at: 1, question: "Which one?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], context: [], kind: "ask", ...over });

let sent: Record<string, unknown>[] = [];
/** the calls sent to that Mac, in order */
const calls = () => sent.filter((c) => c.cmd === "peer-send").map((c) => c.data as { t: string; seq: number; fn: string; args: unknown[] });
const answer = (seq: number, value: unknown) => onPeer({ ev: "peer-msg", peer: HOST, data: { t: "ret", seq, value } });

beforeEach(() => {
  setState(reconcile(freshState()));
  setMirror("hosts", reconcile({}));
  readAt.clear();
  sent = [];
  vi.spyOn(native, "remoteCmd").mockImplementation(async (cmd) => void sent.push(cmd));
  setState("settings", "hosts", [{ id: HOST, name: "Studio" }]);
  setState("settings", "hostProjects", [{ host: HOST, id: "repo", space: "home", name: "repo", folder: "/there/repo" }]);
  setMirror("hosts", HOST, { status: "ok", projects: [{ id: "repo", name: "repo", folder: "/there/repo" }], tasks: [job({ host: HOST, project: remoteProjectId(HOST, "repo") })] });
});
afterEach(() => vi.restoreAllMocks());

describe("actions on another Mac's job", () => {
  it("go to that Mac instead of this Mac's (missing) copy", async () => {
    finishTask("far1");
    pauseTask("far1");
    togglePin("far1");
    setPriority("far1", 0);
    setWeight("far1", "heavy");
    setTaskAccount("far1", "acc-other");
    await Promise.resolve();
    expect(calls().map((c) => [c.fn, c.args])).toEqual([
      ["finishTask", ["far1"]],
      ["pauseTask", ["far1"]],
      ["togglePin", ["far1"]],
      ["setPriority", ["far1", 0]],
      ["setWeight", ["far1", "heavy"]],
      ["setTaskAccount", ["far1", "acc-other"]],
    ]);
    expect(state.tasks).toEqual([]);
  });

  it("stay here for this Mac's own jobs", () => {
    setState("tasks", [job({ id: "here", accountId: "default" })]);
    togglePin("here");
    setPriority("here", 1);
    expect(calls()).toEqual([]);
    expect(state.tasks[0]).toMatchObject({ pinned: true, priority: 1 });
  });

  it("다시 실행 opens the new job that Mac made", async () => {
    const got = duplicateTask("far1");
    expect(got).toBeInstanceOf(Promise);
    const c = calls()[0];
    expect(c.fn).toBe("duplicateTask");
    answer(c.seq, "far2");
    await expect(got).resolves.toBe("far2");
  });

  it("reading it here keeps it read until it says more", () => {
    setMirror("hosts", HOST, "tasks", 0, "unread", true);
    markRead("far1");
    expect(taskById("far1")?.unread).toBe(false);
    // that Mac still has it unread: its next patch doesn't bring the dot back
    apply(HOST, [{ id: "far1", head: head({ unread: true }) }]);
    expect(taskById("far1")?.unread).toBe(false);
    // it said more: unread again
    apply(HOST, [{ id: "far1", from: 0, entries: [{ id: "e1", at: 2, kind: "text", text: "done" }], n: 1 }]);
    apply(HOST, [{ id: "far1", head: head({ unread: true }) }]);
    expect(taskById("far1")?.unread).toBe(true);
    expect(calls()).toEqual([]);
  });

  it("is in line with that Mac's own queue, not this Mac's", () => {
    setState("tasks", [job({ id: "here", status: "queued", priority: 0 })]);
    setMirror("hosts", HOST, "tasks", (l) => [...l, job({ id: "far2", status: "queued", host: HOST, createdAt: 5 }), job({ id: "far3", status: "queued", host: HOST, createdAt: 3 })]);
    expect(queueWith(taskById("far2")!).map((t) => t.id)).toEqual(["far3", "far2"]);
    expect(queueWith(taskById("here")!).map((t) => t.id)).toEqual(["here"]);
  });

  it("main hears when one ends there", () => {
    const ended: string[] = [];
    onFarEnded((t) => ended.push(t.id));
    apply(HOST, [{ id: "far1", head: head({ status: "done" }) }]);
    // already over when first heard of: not news
    apply(HOST, [{ id: "old", head: head({ id: "old", status: "done" }) }]);
    expect(ended).toEqual(["far1"]);
  });
});

describe("its questions", () => {
  it("come over and show as this Mac's do", () => {
    onPeer({ ev: "peer-msg", peer: HOST, data: { t: "decisions", list: [ask()] } });
    expect(decisionFor("far1")?.question).toBe("Which one?");
    expect(decisionsIn("home").map((d) => d.id)).toEqual(["d1"]);
  });

  it("are answered there, the card going at once", async () => {
    setMirror("hosts", HOST, "decisions", [ask()]);
    const done = decide("d1", "b");
    expect(decisionFor("far1")).toBeUndefined();
    const c = calls()[0];
    expect([c.fn, c.args]).toEqual(["decide", ["d1", "b"]]);
    answer(c.seq, null);
    await done;
    expect(decisionFor("far1")).toBeUndefined();
  });

  it("come back when that Mac couldn't take the answer", async () => {
    setMirror("hosts", HOST, "decisions", [ask()]);
    const done = decide("d1", "b");
    onPeer({ ev: "peer-msg", peer: HOST, data: { t: "ret", seq: calls()[0].seq, error: "unknown: decide" } });
    await done;
    expect(decisionFor("far1")?.id).toBe("d1");
  });

  it("are sent for the jobs that Mac keeps only", () => {
    setState("projects", [{ id: "p1", space: "home", name: "p1", folder: "/repo/p1" }]);
    setState("tasks", [job({ id: "kept", project: "p1" }), job({ id: "asked", from: { device: "dev", space: "home" } }), job({ id: "other" })]);
    setState("decisions", [ask({ id: "d-kept", taskId: "kept" }), ask({ id: "d-asked", taskId: "asked" }), ask({ id: "d-other", taskId: "other" }), ask({ id: "d-main", taskId: "main:home" })]);
    expect(decisionsFor("dev", new Set(["p1"])).map((d) => d.id)).toEqual(["d-kept", "d-asked"]);
  });
});

describe("a new job in that Mac's project", () => {
  it("is asked with everything a job here would get", () => {
    setMirror("hosts", HOST, "tasks", 0, "status", "done");
    setState("spaces", (l) => [...l, { id: "work", label: "회사", folder: "~", rules: "" }]);
    createTask({
      space: "home", title: "Ship it", topic: "repo", ask: "Ship the fix", project: remoteProjectId(HOST, "repo"),
      priority: 0, weight: "heavy", branch: "fix/ship", after: ["far1"], reach: ["work"], follows: "far1", by: "far1", isolate: false,
      issue: { n: 7, url: "https://example.com/7", title: "Broken" },
    });
    const c = calls().find((x) => x.fn === "create")!;
    expect(c.args[0]).toMatchObject({
      project: "repo", priority: 0, weight: "heavy", branch: "fix/ship", after: ["far1"], reach: ["회사"], follows: "far1", by: "far1", isolate: false,
      issue: { n: 7 }, permission: "edits",
    });
    expect(mirror.hosts[HOST].tasks.some((t) => t.title === "Ship it")).toBe(true);
  });

  it("is made there with them, and only with that Mac's own jobs to build on", () => {
    setState("spaces", (l) => [...l, { id: "work", label: "회사", folder: "~", rules: "" }]);
    setState("projects", [{ id: "repo", space: "home", name: "repo", folder: "/repo" }]);
    setState("tasks", [job({ id: "j1", status: "done", project: "repo" }), job({ id: "elsewhere", space: "work" })]);
    const id = create({ device: "dev" }, {
      id: "n1", title: "Ship it", ask: "Ship the fix", project: "repo", space: "home",
      priority: 0, weight: "heavy", branch: "fix/ship", after: ["j1", "elsewhere", "ghost"], reach: ["회사", "없음"], follows: "j1", by: "j1", permission: "full", isolate: false,
    });
    expect(id).toBe("n1");
    expect(taskById("n1")).toMatchObject({
      project: "repo", cwd: "/repo", priority: 0, weight: "heavy", branch: "fix/ship", after: ["j1"], reach: ["work"], follows: "j1", permission: "full", isolate: false,
      from: { device: "dev", space: "home" },
    });
    expect(taskById("n1")?.entries[0]).toMatchObject({ kind: "user", by: "j1" });
  });

  it("a Mac too old to send the new fields gets the old defaults", () => {
    setState("projects", [{ id: "repo", space: "home", name: "repo", folder: "/repo" }]);
    create({ device: "dev" }, { id: "n2", title: "Old", ask: "Old ask", project: "repo", space: "home" });
    expect(taskById("n2")).toMatchObject({ priority: 2, weight: "light", permission: "edits" });
    expect(taskById("n2")?.after).toBeUndefined();
  });
});

describe("a project's secrets, asked from the Mac that added it", () => {
  const saved = (projects: Record<string, string[]>): native.SavedSecrets => ({ global: ["GLOBAL_KEY"], projects });
  beforeEach(() => setState("projects", [{ id: "repo", space: "home", name: "repo", folder: "/repo" }, { id: "other", space: "home", name: "other", folder: "/other" }]));

  it("say only that project's names, never a value or another's", async () => {
    vi.spyOn(native, "secretSync").mockResolvedValue({ saved: saved({ repo: ["API_KEY"], other: ["SECRET"] }), added: ["API_KEY"] });
    await expect(secretCalls.secretSync("repo")).resolves.toEqual({ items: ["API_KEY"], added: 1 });
    expect(native.secretSync).toHaveBeenCalledWith([["repo", "/repo"]]);
  });

  it("save in that project's folder there, and ask before touching .gitignore", async () => {
    const set = vi.spyOn(native, "secretSet").mockRejectedValueOnce(new Error("ENV_NOT_IGNORED")).mockResolvedValue(saved({ repo: ["API_KEY"] }));
    vi.spyOn(native, "secretList").mockResolvedValue(saved({}));
    await expect(secretCalls.secretSet({ project: "repo", name: "API_KEY", value: "v", writeDotenv: true })).resolves.toEqual({ items: [], notIgnored: true });
    await expect(secretCalls.secretSet({ project: "repo", name: "API_KEY", value: "v", writeDotenv: true, addIgnore: true })).resolves.toEqual({ items: ["API_KEY"] });
    expect(set).toHaveBeenLastCalledWith({ name: "API_KEY", value: "v", project: "repo", folder: "/repo", writeDotenv: true, addIgnore: true });
  });

  it("refuse a project that Mac doesn't have", async () => {
    await expect(secretCalls.secretList("ghost")).rejects.toThrow();
    await expect(secretCalls.secretDelete({ project: remoteProjectId(HOST, "repo"), name: "X" })).rejects.toThrow();
  });
});
