import { describe, expect, it } from "vitest";
import { boardOf, completePart, isProgram } from "./program";

describe("board programs", () => {
  it("tells a program from the line form", () => {
    expect(isProgram('title("x")\nbox(1, 2, 3, 4)')).toBe(true);
    expect(isProgram("for (let i = 0; i < 3; i++) dot(i, 0)")).toBe(true);
    expect(isProgram('title 커피\nbox 1 2 3 4 "물 (뜨거움)"')).toBe(false);
  });

  it("runs only what is complete: a call still open or a string still going waits", () => {
    expect(completePart('box(1, 2, 3, 4)\nfor (let i = 0; i < 3; i++) {\n  dot(i, 0)\n')).toBe("box(1, 2, 3, 4)\n");
    expect(completePart('text(1, 2, "a\\n(b")\nline(0, 0,')).toBe('text(1, 2, "a\\n(b")\n');
    expect(completePart("// note (\nbox(1, 2, 3, 4)\n")).toBe("// note (\nbox(1, 2, 3, 4)\n");
  });

  it("keeps only what is safe to draw from what came back", () => {
    const b = boardOf({
      title: "t", w: 800, h: 450, steps: ["1. 첫째"],
      marks: [
        { kind: "path", d: "M0 0L10 10Z", step: 0, color: "green", fill: true },
        { kind: "path", d: "M0 0 url(javascript:x)", step: 0 },
        { kind: "box", x: 1, y: 2, w: 3, h: 4, step: 0, color: "#12ab34" },
        { kind: "box", x: 1, y: 2, w: 3, h: 4, step: 0, color: "url(#x)" },
        { kind: "script", step: 0 },
        { kind: "text", x: 1e9, y: 0, text: "far", step: 0, align: "center" },
      ],
      parts: [{ step: 0, label: "판", shape: "box", dims: [1, 1, 1], at: [0, 0, 0], rot: [0, 0, 0], look: "green" }, { shape: "teapot", dims: [1] }],
    });
    expect(b.steps[0].text).toBe("첫째");
    expect(b.marks.map((m) => m.kind)).toEqual(["path", "box", "box", "text"]);
    expect(b.marks[0]).toMatchObject({ color: "#3fa66a", fill: true });
    expect(b.marks[1]).toMatchObject({ color: "#12ab34" });
    expect(b.marks[2].color).toBeUndefined();
    expect(b.marks[3]).toMatchObject({ x: 5000, align: "middle" });
    expect(b.parts).toHaveLength(1);
    expect(b.parts[0].look).toBe("#1f6b3e");
  });
});

describe("drawing helpers", () => {
  it("place shapes by the ones before them", async () => {
    const { loadEngine, runProgram } = await import("./program");
    await loadEngine();
    const out = runProgram(
      'const t = row(0, 0, ["오늘", "날씨"], { gap: 20 })\n' +
      "connect(t[0], t[1])\n" +
      'bars(0, 100, [["a", 0.6], ["b", 0.4]], { pick: 0 })\n' +
      'text(0, 0, String(t[1].left - t[0].right))\n',
    )!;
    const kinds = out.board.marks.map((m) => m.kind);
    expect(kinds.slice(0, 3)).toEqual(["box", "box", "arrow"]);
    const [a, b] = out.board.marks as any[];
    const arrow = out.board.marks[2] as any;
    // the arrow runs between the two tags' edges, not their centres
    expect(arrow.pts[0][0]).toBeGreaterThan(a.x + a.w);
    expect(arrow.pts[1][0]).toBeLessThan(b.x);
    expect((out.board.marks[out.board.marks.length - 1] as any).text).toBe("20");
    expect(out.board.marks.filter((m) => m.kind === "text").map((m: any) => m.text)).toContain("60%");
  });
});
