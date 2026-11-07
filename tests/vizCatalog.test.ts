import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FAMILY_KINDS } from "../src/ui/viz/kinds";

const builtIn = new Set([...readFileSync("src/state/types.ts", "utf8").matchAll(/\{ type: "(\w+)"/g)].map((m) => m[1]));

describe("chart catalog", () => {
  const all = Object.entries(FAMILY_KINDS).flatMap(([f, ks]) => ks.map((k) => ({ f, k })));
  it("each kind is registered once and doesn't shadow a built-in block", () => {
    const seen = new Set<string>();
    for (const { k } of all) {
      expect(seen.has(k), `duplicate kind ${k}`).toBe(false);
      expect(builtIn.has(k), `${k} shadows a built-in block`).toBe(false);
      seen.add(k);
    }
  });
  it("each kind is documented in its family's reference for the agents", () => {
    for (const [f, ks] of Object.entries(FAMILY_KINDS)) {
      const doc = `skills/visual-report/references/${f}.md`;
      expect(existsSync(doc), doc).toBe(true);
      const text = readFileSync(doc, "utf8");
      for (const k of ks) expect(text.includes(`\`${k}\``), `${k} missing from ${doc}`).toBe(true);
    }
  });
});
