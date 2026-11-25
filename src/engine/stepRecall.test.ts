import { describe, expect, it } from "vitest";
import { setState } from "../state/store";
import type { Memory, Task } from "../state/types";
import { programsOf } from "./commandKind";
import { RECALL_CAP, recallNow, stepThings } from "./stepRecall";

const piece = (o: Partial<Memory>): Memory => ({ id: o.id ?? Math.random().toString(36).slice(2), text: "x", scope: "space", space: "work", createdAt: Date.now(), updatedAt: Date.now(), uses: 0, by: "user", ...o }) as Memory;
const job = (o: Partial<Task> = {}): Task => ({ id: "t1", space: "work", cwd: "/Users/u/Work/app", title: "로그인 버그 고치기", topic: "app", ask: "로그인 버그 고쳐줘", entries: [], plan: [], shells: [], ...o }) as Task;

function reset(memory: Memory[]) {
  setState("spaces", [{ id: "work", label: "회사", folder: "/Users/u/Work" }, { id: "home", label: "개인", folder: "/Users/u/p" }] as never);
  setState("projects", [] as never);
  setState("memory", memory);
}

const windows = piece({ id: "win", scope: "global", space: undefined, text: "윈도우 작업할 때는 화면 끄기를 1분으로 바꿔 두고 해요", kind: "rule", keys: ["Windows", "윈도우", "화면 끄기", "절전"] });
const filler = Array.from({ length: 30 }, (_, i) => piece({ text: `회사 서비스 ${i}번 배포는 금요일에 하지 않아요` }));

describe("what a step turns to", () => {
  it("names the app, device, site and programs, not reads or the shell's own words", () => {
    expect(stepThings("computer", { action: "start", app: "Windows App" })).toEqual(["Windows App"]);
    expect(stepThings("computer", { action: "start", app: "com.microsoft.rdc.macos" })).toEqual([]);
    expect(stepThings("device", { action: "start", platform: "android", device: "Pixel 9" })).toEqual(["Pixel 9", "Android"]);
    expect(stepThings("web_fetch", { url: "https://www.notion.so/acme/x" })).toEqual(["notion"]);
    expect(stepThings("bash", { command: "cd app && rg login src | head && pnpm test" })).toEqual(["pnpm"]);
    expect(stepThings("read", { path: "a.ts" })).toEqual([]);
  });

  it("finds the host an ssh step reaches", () => {
    expect(programsOf("ssh -p 22 me@win-pc 'powershell Get-Date'")).toEqual(["ssh", "win-pc"]);
    expect(programsOf("sleep 30; gh run view 1 && git push")).toEqual(["gh", "git"]);
    expect(programsOf("export A=1; python3 x.py && node y.js")).toEqual([]);
  });
});

describe("memory on the way", () => {
  it("brings an everywhere rule about the app the job turned to, once", () => {
    reset([windows, ...filler]);
    const t = job();
    expect(recallNow(t, "Windows App", true).map((m) => m.id)).toEqual(["win"]);
    expect(recallNow({ ...t, recalled: ["win"] }, "Windows App", true)).toEqual([]);
    expect(recallNow({ ...t, memorySnapshot: ["- ★ [win] 윈도우 …"] }, "Windows App", true)).toEqual([]);
  });

  it("brings nothing for a thing its memory doesn't talk about", () => {
    reset([windows, ...filler]);
    expect(recallNow(job(), "pnpm", true)).toEqual([]);
  });

  it("a step's sentence needs more than one shared word", () => {
    reset([windows, piece({ id: "rel", text: "앱 릴리즈 노트는 한국어 불릿으로 써요" }), ...filler]);
    expect(recallNow(job(), "릴리즈 노트 쓰기", false).map((m) => m.id)).toEqual(["rel"]);
    expect(recallNow(job(), "윈도우 쪽 확인", false)).toEqual([]);
  });

  it("stops once a job was sent its share", () => {
    reset([windows, ...filler]);
    expect(recallNow(job({ recalled: Array.from({ length: RECALL_CAP }, (_, i) => `x${i}`) }), "Windows App", true)).toEqual([]);
  });

  it("another space's piece never comes", () => {
    reset([piece({ id: "home", space: "home", text: "윈도우 PC는 집 거실에 있어요", keys: ["Windows"] }), ...filler]);
    expect(recallNow(job(), "Windows App", true)).toEqual([]);
  });
});
