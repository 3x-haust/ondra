import { describe, expect, it } from "vitest";
import { placeTip } from "./tooltip";

const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
const view = { width: 800, height: 600 };

describe("where a tip goes", () => {
  it("centred under the element", () => {
    expect(placeTip(rect(100, 100, 40, 20), { width: 80, height: 24 }, view)).toEqual({ left: 80, top: 126, above: false });
  });
  it("over it when there's no room below", () => {
    expect(placeTip(rect(100, 570, 40, 20), { width: 80, height: 24 }, view)).toEqual({ left: 80, top: 540, above: true });
  });
  it("kept inside the window at either side", () => {
    expect(placeTip(rect(0, 100, 20, 20), { width: 200, height: 24 }, view).left).toBe(8);
    expect(placeTip(rect(780, 100, 20, 20), { width: 200, height: 24 }, view).left).toBe(592);
  });
});
