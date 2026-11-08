import { describe, expect, it } from "vitest";
import { buildModel } from "../src/views/memoryTree";

const base = {
  spaces: [{ id: "work", label: "회사", folder: "/u/work" }],
  memory: [],
  expand: (p: string) => p,
};
const labels = (m: ReturnType<typeof buildModel>) => [...m.homes.values()].filter((h) => h.kind === "project").map((h) => h.label).sort();
const hints = (m: ReturnType<typeof buildModel>) => [...m.homes.values()].filter((h) => h.kind === "project").map((h) => `${h.label}${h.hint ? ` · ${h.hint}` : ""}`).sort();

describe("project homes", () => {
  it("keeps the project name for same-name folders and shows the folder each sits in", () => {
    const m = buildModel({
      ...base,
      projects: [{ id: "a", space: "work", name: "ondra", folder: "/u/work/ondra" }],
      now: { "/u/me/ondra": { text: "x", at: 1, taskId: "t", title: "t" } },
    });
    expect(labels(m)).toEqual(["ondra", "ondra"]);
    expect([...m.homes.values()].filter((h) => h.kind === "project").map((h) => h.path).sort()).toEqual(["/u/me/ondra", "/u/work/ondra"]);
    expect(hints(m)).toEqual(["ondra · me", "ondra · work"]);
  });
  it("calls the home folder 홈", () => {
    const m = buildModel({
      ...base,
      projects: [{ id: "a", space: "work", name: "ondra", folder: "/u/work/ondra" }],
      now: { "/Users/me/ondra": { text: "x", at: 1, taskId: "t", title: "t" } },
    });
    expect(hints(m)).toEqual(["ondra · work", "ondra · 홈"]);
  });
  it("leaves unique names alone", () => {
    const m = buildModel({ ...base, projects: [{ id: "a", space: "work", name: "ondra", folder: "/u/work/ondra" }] });
    expect(labels(m)).toEqual(["ondra"]);
    expect(hints(m)).toEqual(["ondra"]);
  });
});

describe("the home folder as a project", () => {
  it("is named 홈, not ~", () => {
    const m = buildModel({ ...base, projects: [], now: { "~": { text: "x", at: 1, taskId: "t", title: "t" } } });
    expect(labels(m)).toEqual(["홈"]);
  });
});
