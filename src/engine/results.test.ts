import { beforeEach, describe, expect, it } from "vitest";
import { freshState, setState, state } from "../state/store";
import type { CaptainMessage, ResultEntry, Task } from "../state/types";
import { jobShot, keepJobResult, keepResult, pinResult, removeResults, restoreResults, resultOfTask, resultPreview, resultsIn } from "./results";

const entry = (id: string, at: number, extra: Partial<ResultEntry> = {}): ResultEntry => ({ id, taskId: `t_${id}`, space: "work", title: id, answers: [], at, ...extra });

describe("results", () => {
  beforeEach(() => {
    setState(freshState());
    setState("results", [entry("a", 1), entry("b", 2), entry("c", 3)]);
  });

  it("removes and puts back in time order", () => {
    const gone = removeResults(["a", "c"]);
    expect(resultsIn("work").map((r) => r.id)).toEqual(["b"]);
    restoreResults(gone);
    expect(state.results!.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("pins and unpins", () => {
    pinResult("b", true);
    expect(state.results!.find((r) => r.id === "b")?.pinned).toBe(true);
    pinResult("b", false);
    expect(state.results!.find((r) => r.id === "b")?.pinned).toBeUndefined();
  });

  it("reads a report as one plain line", () => {
    const r = entry("d", 4, { reply: "정리했어요.", answers: [{ text: "- **설치**: DMG\n- 빠진 것: [CLI](x)\n1. 끝", blocks: [] }] });
    expect(resultPreview(r)).toBe("정리했어요. 설치: DMG 빠진 것: CLI 끝");
  });
});

const job = (x: Partial<Task> = {}): Task =>
  ({
    id: "j1", space: "work", topic: "t", title: "로그인 고치기", ask: "고쳐 줘", cwd: "~", status: "done", priority: 2, weight: "light", accountId: "a",
    createdAt: 1, finishedAt: 100, now: "", summary: "로그인 뒤 대시보드로 가요", plan: [], legs: [], shells: [], inbox: [],
    entries: [
      { id: "e0", at: 1, kind: "user", text: "고쳐 줘" },
      { id: "e1", at: 2, kind: "text", text: "가드를 고쳤어요." },
      { id: "e2", at: 3, kind: "block", block: { type: "evidence", items: [{ kind: "test", ref: "pnpm test", ok: true }, { kind: "shot", ref: "/s/after.png", ok: true }] } },
    ],
    ...x,
  }) as Task;

describe("a job's own result", () => {
  beforeEach(() => {
    setState(freshState());
    setState("results", []);
  });

  it("is kept from what the job reported, once per time it finishes", () => {
    const t = job();
    setState("tasks", [t]);
    keepJobResult(t);
    keepJobResult(t);
    const r = resultOfTask("j1")!;
    expect(state.results).toHaveLength(1);
    expect(r.reply).toBe("로그인 뒤 대시보드로 가요");
    expect(r.answers[0].text).toBe("가드를 고쳤어요.");
    expect(r.answers[0].blocks[0].type).toBe("evidence");
    keepJobResult(job({ finishedAt: 200, entries: [...t.entries, { id: "e3", at: 4, kind: "user", text: "PR도" }, { id: "e4", at: 5, kind: "text", text: "PR 올렸어요." }] }));
    expect(state.results).toHaveLength(2);
    expect(resultOfTask("j1")!.answers[0].text).toBe("PR 올렸어요.");
  });

  it("isn't kept for a failed job or a subagent", () => {
    keepJobResult(job({ status: "failed" }));
    keepJobResult(job({ parentId: "p" }));
    expect(state.results).toHaveLength(0);
  });

  it("takes main's line when it added one, and stays as it is when main added nothing", () => {
    const t = job();
    const quiet: CaptainMessage = { id: "c1", at: 101, space: "work", from: "captain", after: "j1", reply: "", routes: [] };
    const said: CaptainMessage = { id: "c2", at: 102, space: "work", from: "captain", after: "j1", reply: "", routes: [{ kind: "answer", text: "Safari는 아직 못 봤어요.", blocks: [] }] };
    setState("tasks", [t]);
    setState("captain", [quiet, said]);
    keepJobResult(t);
    keepResult("c1");
    expect(resultOfTask("j1")!.answers).toHaveLength(1);
    expect(resultOfTask("j1")!.msg).toBeUndefined();
    keepResult("c2");
    expect(resultOfTask("j1")!.answers.map((a) => a.text)).toEqual(["가드를 고쳤어요.", "Safari는 아직 못 봤어요."]);
    expect(resultOfTask("j1")!.msg).toBe("c2");
  });

  it("finds the screenshot the job left", () => {
    expect(jobShot(job())).toBe("/s/after.png");
    expect(jobShot(job({ entries: [{ id: "e1", at: 2, kind: "text", text: "끝" }] }))).toBeUndefined();
  });
});

describe("a job's report", () => {
  beforeEach(() => {
    setState(freshState());
    setState("results", []);
  });

  it("is its closing words, not every line of narration on the way", () => {
    const t = job({
      entries: [
        { id: "e0", at: 1, kind: "user", text: "리서치 해줘" },
        { id: "e1", at: 2, kind: "text", text: "증명을 붙여 설명할게요." },
        { id: "e2", at: 3, kind: "tool", tool: { name: "bash", kind: "bash", target: "python3 check.py", ok: true } },
        { id: "e3", at: 4, kind: "text", text: "이제 PDF를 만들게요." },
        { id: "e4", at: 5, kind: "tool", tool: { name: "bash", kind: "bash", target: "make pdf", ok: true } },
        { id: "e5", at: 6, kind: "text", text: "**있어요.** f(x)=|x| 는 f(f(x))=f(x)예요." },
        { id: "e6", at: 7, kind: "text", text: "PDF도 첨부했어요." },
      ],
    });
    setState("tasks", [t]);
    keepJobResult(t);
    expect(resultOfTask("j1")!.answers[0].text).toBe("**있어요.** f(x)=|x| 는 f(f(x))=f(x)예요.\n\nPDF도 첨부했어요.");
  });

  it("is its last words when it wrote nothing after its last tool call", () => {
    const t = job({
      entries: [
        { id: "e0", at: 1, kind: "user", text: "고쳐 줘" },
        { id: "e1", at: 2, kind: "text", text: "고치는 중이에요." },
        { id: "e2", at: 3, kind: "text", text: "가드를 고쳤어요." },
        { id: "e3", at: 4, kind: "tool", tool: { name: "bash", kind: "bash", target: "git commit", ok: true } },
      ],
    });
    setState("tasks", [t]);
    keepJobResult(t);
    expect(resultOfTask("j1")!.answers[0].text).toBe("가드를 고쳤어요.");
  });
});
