import { beforeEach, describe, expect, it } from "vitest";
import { freshState, setState, state } from "../state/store";
import type { ResultEntry } from "../state/types";
import { pinResult, removeResults, restoreResults, resultPreview, resultsIn } from "./results";

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
