import { describe, expect, it } from "vitest";
import { buildModel } from "../src/views/memoryTree";

const base = {
  spaces: [{ id: "work", label: "회사", folder: "/u/work" }],
  memory: [],
  expand: (p: string) => p,
};
const labels = (m: ReturnType<typeof buildModel>) => [...m.homes.values()].filter((h) => h.kind === "project").map((h) => h.label).sort();

describe("project homes", () => {
  it("tells same-name folders apart by their parent", () => {
    const m = buildModel({
      ...base,
      projects: [{ id: "a", space: "work", name: "ondra", folder: "/u/work/ondra" }],
      now: { "/u/me/ondra": { text: "x", at: 1, taskId: "t", title: "t" } },
    });
    expect(labels(m)).toEqual(["ondra · me", "ondra · work"]);
  });
  it("leaves unique names alone", () => {
    const m = buildModel({ ...base, projects: [{ id: "a", space: "work", name: "ondra", folder: "/u/work/ondra" }] });
    expect(labels(m)).toEqual(["ondra"]);
  });
});
