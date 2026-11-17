import { describe, expect, it } from "vitest";
import { bodyBox, bodyHeight } from "./spec";

/** a w×h picture, see-through but for the rows listed */
const pic = (w: number, h: number, rows: number[]) => {
  const d = new Uint8ClampedArray(w * h * 4);
  for (const y of rows) d[(y * w + Math.floor(w / 2)) * 4 + 3] = 255;
  return d;
};

describe("bodyHeight", () => {
  it("is the character, not the room drawn around it", () => {
    expect(bodyHeight(pic(10, 120, [25, 60, 119]), 10, 120)).toBe(95);
  });
  it("is the whole picture when cut close", () => {
    expect(bodyHeight(pic(4, 96, [0, 95]), 4, 96)).toBe(96);
  });
  it("ignores faint pixels and says null for nothing", () => {
    const d = pic(4, 10, []);
    d[3] = 20;
    expect(bodyHeight(d, 4, 10)).toBeNull();
  });
});

describe("bodyBox", () => {
  it("finds the character's sides inside the room around it", () => {
    const w = 128, h = 120;
    const d = new Uint8ClampedArray(w * h * 4);
    for (const [x, y] of [[40, 25], [90, 119], [60, 70]]) d[(y * w + x) * 4 + 3] = 255;
    expect(bodyBox(d, w, h)).toEqual({ l: 40, r: 90, t: 25, b: 119 });
  });
});
