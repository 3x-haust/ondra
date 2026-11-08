import { describe, expect, it } from "vitest";
import { arrows, calls, cellDepths, depth, emptyTrace, fnAt, readTrace, shortName, span } from "./reverse";
import text from "../state/fixture-reverse.jsonl?raw";

// a real trace: ondra-binary run on Ondra's own ondra-cuhost helper

describe("reverse trace", () => {
  const tr = readTrace(emptyTrace(), text);
  const b = tr.bins[0];
  const secure = 0x10000632c;

  it("reads the binary, its functions and what was read of them", () => {
    expect(tr.bins).toHaveLength(1);
    expect(b.file).toBe("ondra-cuhost");
    expect(b.target.lang).toBe("swift");
    expect(b.fns.length).toBe(549);
    expect(b.sections.some((s) => s.name.endsWith("__text"))).toBe(true);
    expect(b.matched.has(secure)).toBe(true);
    expect(b.asm.get(secure)!.ops).toHaveLength(44);
    expect(b.code.get(secure)!.code).toContain("{");
    expect(depth(b, secure)).toBe(4);
    expect(fnAt(b, secure + 8)?.addr).toBe(secure);
  });

  it("pairs each start with its end, and keeps failures", () => {
    expect(tr.steps.every((s) => s.state !== "live")).toBe(true);
    const fail = tr.steps.filter((s) => s.state === "fail");
    expect(fail).toHaveLength(1);
    expect(fail[0].op).toBe("decompile");
    expect(tr.steps.find((s) => s.op === "functions" && s.filter === "secure")?.count).toBe(2);
    expect(tr.steps.filter((s) => s.state === "ok").every((s) => s.ms !== undefined)).toBe(true);
  });

  it("reads lines in pieces the same as at once, and shows a running step", () => {
    const lines = text.trim().split("\n");
    let t = emptyTrace();
    for (const l of lines) t = readTrace(t, `${l}\n`);
    expect(t.bins[0].fns.length).toBe(549);
    expect(t.steps.map((s) => s.state)).toEqual(tr.steps.map((s) => s.state));
    const half = readTrace(emptyTrace(), lines.slice(0, 7).join("\n"));
    expect(half.steps[half.steps.length - 1].state).toBe("live");
  });

  it("lays the map over the code and marks what was read", () => {
    const { lo, hi } = span(b);
    expect(lo).toBeLessThanOrEqual(b.fns[0].addr);
    expect(hi).toBeGreaterThan(b.fns[b.fns.length - 1].addr);
    const cells = cellDepths(b, 1024);
    expect(Math.max(...cells)).toBe(4);
    expect(cells.filter((c) => c === 4).length).toBeGreaterThan(0);
  });

  it("draws jump arrows without lanes crossing and finds calls", () => {
    const { list, lanes } = arrows(b.asm.get(secure)!.ops);
    expect(list.length).toBeGreaterThan(0);
    expect(lanes).toBeGreaterThan(0);
    for (const a of list)
      for (const c of list)
        if (a !== c && a.lane === c.lane) {
          const [a0, a1] = [Math.min(a.from, a.to), Math.max(a.from, a.to)];
          const [c0, c1] = [Math.min(c.from, c.to), Math.max(c.from, c.to)];
          expect(a1 < c0 || c1 < a0).toBe(true);
        }
    expect(calls(b, secure).out.length).toBeGreaterThan(0);
  });

  it("reads mangled names", () => {
    expect(shortName("sym.__s4main8isSecure4role7subroleSbSS_SSSgtF")).toBe("main.isSecure");
    expect(shortName("method.main.AXMap.id")).toBe("main.AXMap.id");
    expect(shortName("sym._ZN3foo3barEv")).toBe("foo::bar");
    expect(shortName("main")).toBe("main");
  });
});
