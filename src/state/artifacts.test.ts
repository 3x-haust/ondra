import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/native", () => ({ artifactsList: async () => [] }));
vi.mock("./store", () => {
  const tasks = [{ id: "pdf", entries: [{ kind: "tool", at: 1, tool: { kind: "write", detail: "/docs/report.pdf", ok: true } }] }];
  return { state: { tasks }, taskById: (id: string) => tasks.find((t) => t.id === id) };
});

import { artifacts, kindOf, loadArtifacts } from "./artifacts";

describe("PDF artifacts", () => {
  it.each(["report.pdf", "report.PDF"])("previews %s as a page", (name) => {
    expect(kindOf(name)).toBe("page");
  });
  it("includes PDFs written outside the artifacts directory", async () => {
    await loadArtifacts("pdf");
    expect(artifacts.pdf).toEqual([{ path: "/docs/report.pdf", name: "report.pdf", size: 0, modified: 1 }]);
  });
});
