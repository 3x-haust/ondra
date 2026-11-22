import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState } from "../state/store";
import { staleAnswerNote } from "./tasks";

const H = 3600_000;
beforeEach(() => {
  setState(reconcile(freshState()));
  setState("projects", [{ id: "ondra", space: "home", name: "ondra", folder: "/repo/ondra" }]);
  vi.spyOn(native, "spaceEnv").mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("main's question answered long after", () => {
  it("names the releases published since it was asked, also ones no Ondra job made", async () => {
    const now = Date.UTC(2026, 10, 20, 3, 20);
    vi.spyOn(native, "gitOnGithub").mockResolvedValue(true);
    vi.spyOn(native, "ghWatch").mockResolvedValue(
      JSON.stringify([
        { tagName: "v0.59.0", name: "Ondra 0.59.0", publishedAt: new Date(now - 4 * H).toISOString(), isDraft: false },
        { tagName: "v0.58.0", name: "Ondra 0.58.0", publishedAt: new Date(now - 20 * H).toISOString(), isDraft: false },
      ]),
    );
    const note = await staleAnswerNote(now - 9 * H, "home", "ondra", now);
    expect(note).toContain("v0.59.0");
    expect(note).not.toContain("v0.58.0");
  });

  it("says nothing about releases for a folder not on GitHub, and nothing at all for a fresh answer", async () => {
    vi.spyOn(native, "gitOnGithub").mockResolvedValue(false);
    const watch = vi.spyOn(native, "ghWatch");
    const now = 100 * H;
    expect(await staleAnswerNote(now - 9 * H, "home", "ondra", now)).not.toContain("Releases");
    expect(await staleAnswerNote(now - 60_000, "home", "ondra", now)).toBeUndefined();
    expect(watch).not.toHaveBeenCalled();
  });
});
