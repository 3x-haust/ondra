import { describe, expect, it } from "vitest";
import { commandMarks } from "./commandMarks";

const commands = [{ name: "btw" }, { name: "new" }, { name: "skill:deep-research", skill: true }, { name: "skill:qa", skill: true }];

describe("commandMarks", () => {
  it("marks a known command opening the message, not the words after it", () => {
    expect(commandMarks("/btw 그럼 그", commands)).toEqual([[0, 4]]);
    expect(commandMarks("/btw", commands)).toEqual([[0, 4]]);
    expect(commandMarks("  /new\n일", commands)).toEqual([[2, 6]]);
  });
  it("leaves a word that is not a whole known command", () => {
    expect(commandMarks("/bt", commands)).toEqual([]);
    expect(commandMarks("/btwx 그럼", commands)).toEqual([]);
    expect(commandMarks("그럼 /btw", commands)).toEqual([]);
    expect(commandMarks("/", commands)).toEqual([]);
  });
  it("marks skills named anywhere, once each place", () => {
    expect(commandMarks("이거 /skill:deep-research 로 하고 /skill:qa", commands)).toEqual([
      [3, 23],
      [29, 38],
    ]);
    expect(commandMarks("/skill:qa 해줘", commands)).toEqual([[0, 9]]);
    expect(commandMarks("이거 /skill:nope", commands)).toEqual([]);
  });
});
