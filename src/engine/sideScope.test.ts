import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { freshState, setState } from "../state/store";
import { continueInSide, sideOf } from "./aside";

beforeEach(() => setState(reconcile(freshState())));

describe("each place has its own side chat, as btw", () => {
  it("main chats, projects and jobs each keep theirs; older ones belong to the space's main chat", () => {
    setState("side", [{ id: "old", space: "work", at: 1, from: "me", text: "예전 거" }]);
    continueInSide("task:t1", "이 작업 왜 느려?", "빌드 캐시가 없어서요");
    continueInSide("main:work~p1", "이 프로젝트 뭐해?", "정리 중이에요");
    expect(sideOf("main:work").map((m) => m.text)).toEqual(["예전 거"]);
    expect(sideOf("task:t1").map((m) => m.text)).toEqual(["이 작업 왜 느려?", "빌드 캐시가 없어서요"]);
    expect(sideOf("main:work~p1").map((m) => m.text)).toEqual(["이 프로젝트 뭐해?", "정리 중이에요"]);
    expect(sideOf("task:t2")).toEqual([]);
  });
});
