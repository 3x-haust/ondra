import { describe, expect, it } from "vitest";
import { namedSpaces } from "./memory";

const spaces = [
  { id: "work", label: "회사" },
  { id: "home", label: "개인" },
];
const from = (text: string, here = "home") => namedSpaces(text, here, spaces);

describe("namedSpaces", () => {
  it("opens another space only when the message points at its things", () => {
    expect(from("회사 기억 참고해서 이력서 정리해줘")).toEqual(["work"]);
    expect(from("회사에서 했던 거 기반으로 블로그 글 써줘")).toEqual(["work"]);
    expect(from("회사 레포에 있는 스크립트 가져와")).toEqual(["work"]);
    expect(from("회사 쪽 메모리도 봐줘")).toEqual(["work"]);
    expect(from("회사 일을 정리해줘")).toEqual(["work"]);
    expect(from("개인 공간에 있는 스킬 써줘", "work")).toEqual(["home"]);
  });
  it("leaves plain mentions and the current space alone", () => {
    expect(from("회사에 낼 서류 양식 만들어줘")).toEqual([]);
    expect(from("회사 일정 캘린더에 넣어줘")).toEqual([]);
    expect(from("개인 기억 봐줘")).toEqual([]);
    expect(from("오늘 날씨 어때")).toEqual([]);
  });
});

describe("namedSpaces, words that only look like a space", () => {
  it("doesn't open a space for compound words or loose nouns", () => {
    expect(from("Ondra workspace 설정 바꿔줘")).toEqual([]);
    expect(from("network 폴더 정리")).toEqual([]);
    expect(from("framework 작업")).toEqual([]);
    expect(from("개인 프로젝트로 빼자", "work")).toEqual([]);
    expect(from("개인 메모 앱 만들어줘", "work")).toEqual([]);
    expect(from("회사의 프로젝트 목록 봐줘")).toEqual(["work"]);
    expect(from("work 기억 참고해")).toEqual(["work"]);
  });
});
