import { describe, expect, it } from "vitest";
import { boardOf, completePart, iconName, isProgram, loadEngine, runProgram } from "./program";

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

  it("names a box that holds other shapes above them, not across them", async () => {
    const { loadEngine, runProgram } = await import("./program");
    const { headings } = await import("./parse");
    await loadEngine();
    const out = runProgram(
      'const f = box(0, 0, 226, 130, { label: "바깥 살펴보기" })\n' +
      'row(f.x + 13, f.y + 53, ["토스증권", "로빈후드", "듀오링고"], { down: true, size: 14 })\n' +
      'box(300, 0, 120, 50, { label: "혼자" })\n',
    )!;
    const [frame, first, , , alone] = headings(out.board.marks) as any[];
    // its 20px name ends above the first tag inside it
    expect(frame.labelY + 10).toBeLessThanOrEqual(first.y);
    expect(alone.labelY).toBeUndefined();
  });

  it("frames shapes already placed, with room for the frame's name above them", async () => {
    const { loadEngine, runProgram } = await import("./program");
    await loadEngine();
    const out = runProgram('const r = row(100, 100, ["토스증권", "듀오링고"], { down: true })\nconst p = panel(r, "바깥 살펴보기")\nchip(p.x, p.bottom + 20, "다음")\n')!;
    const [a, b, frame, name, next] = out.board.marks as any[];
    for (const c of [a, b]) {
      expect(c.x).toBeGreaterThan(frame.x);
      expect(c.y + c.h).toBeLessThan(frame.y + frame.h);
      expect(c.x + c.w).toBeLessThan(frame.x + frame.w);
    }
    expect(name).toMatchObject({ kind: "text", text: "바깥 살펴보기" });
    expect(name.y + name.size / 2).toBeLessThan(a.y);
    expect(name.y - name.size / 2).toBeGreaterThan(frame.y);
    expect(next.y).toBe(frame.y + frame.h + 20);
  });

  it("draws things as pictures, and what happens as motion: travel, count, pulse", async () => {
    expect(isProgram('icon("server", 1, 2)')).toBe(true);
    expect(iconName("fileText")).toBe("file-text");
    expect(iconName("Credit Card")).toBe("credit-card");
    expect(iconName("../x")).toBeUndefined();
    await loadEngine();
    const out = runProgram(`step("묻기")
const a = icon("laptop", 40, 80, { label: "노트북" })
const b = icon("server", 400, 80)
connect(a, b)
travel(a, b, { label: "GET /", bend: 30 })
step("답")
count(40, 300, 0, 120, { unit: "ms" })
pulse(b)`)!;
    const kinds = out.board.marks.map((m) => [m.kind, m.step]);
    expect(kinds).toEqual([["icon", 0], ["icon", 0], ["arrow", 0], ["travel", 0], ["count", 1], ["pulse", 1]]);
    expect(out.board.marks[0]).toMatchObject({ name: "laptop", size: 48, label: "노트북" });
    expect(out.board.marks[3]).toMatchObject({ kind: "travel", curve: true, label: "GET /", tone: "accent" });
    expect(out.board.marks[4]).toMatchObject({ from: 0, to: 120, unit: "ms" });
    // a bad icon name or a way with no points is dropped
    expect(boardOf({ marks: [{ kind: "icon", name: "<script>", x: 0, y: 0 }, { kind: "travel", pts: [[0, 0]] }] }).marks).toEqual([]);
  });
});
