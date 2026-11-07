import { describe, expect, it } from "vitest";
import { forPeople } from "../src/state/artifacts";

describe("forPeople", () => {
  it("keeps what a person opens", () => {
    for (const n of ["report.pdf", "summary.html", "shot.png", "demo.mp4", "notes.md", "table.csv", "app.dmg"]) expect(forPeople(n)).toBe(true);
  });
  it("drops data and logs", () => {
    for (const n of ["launcher-metadata.json", "run.log", "events.jsonl", "config.yaml", "dump.xml", "state.plist", "out.txt"]) expect(forPeople(n)).toBe(false);
  });
});
