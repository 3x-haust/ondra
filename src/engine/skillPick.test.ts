import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import * as native from "../lib/native";
import { freshState, setState } from "../state/store";
import type { Skill } from "../state/types";
import { skillPaths } from "./skillPick";

const skill = (name: string, extra: Partial<Skill> = {}): Skill => ({
  name, path: `/skills/${name}/SKILL.md`, description: `${name} procedure`,
  source: "ondra", enabled: true, ...extra,
});

beforeEach(() => {
  setState(reconcile(freshState()));
  vi.spyOn(native, "workerSkills").mockResolvedValue([]);
  vi.spyOn(native, "globalSkills").mockResolvedValue([]);
});
afterEach(() => vi.restoreAllMocks());

describe("skillPaths", () => {
  it("combines bundled, enabled space and global paths without duplicates", async () => {
    vi.mocked(native.workerSkills).mockResolvedValue(["/bundled/SKILL.md", "/shared/SKILL.md"]);
    setState("skills", [skill("local", { space: "home" }), skill("shared", { path: "/shared/SKILL.md" })]);
    vi.mocked(native.globalSkills).mockResolvedValue([
      { name: "shared", path: "/shared/SKILL.md", description: "Shared procedure" },
      { name: "personal", path: "/personal/SKILL.md", description: "Personal procedure" },
    ]);

    expect(await skillPaths("home")).toEqual([
      "/bundled/SKILL.md", "/shared/SKILL.md", "/skills/local/SKILL.md", "/personal/SKILL.md",
    ]);
  });

  it("excludes disabled and other-space skills but keeps shared and menu-hidden skills", async () => {
    setState("skills", [
      skill("home", { space: "home" }), skill("work", { space: "work" }),
      skill("disabled", { space: "home", enabled: false }),
      skill("shared"), skill("hidden", { space: "home", menu: false }),
    ]);

    expect(await skillPaths("home")).toEqual([
      "/skills/home/SKILL.md", "/skills/shared/SKILL.md", "/skills/hidden/SKILL.md",
    ]);
    expect(await skillPaths("work")).toEqual(["/skills/work/SKILL.md", "/skills/shared/SKILL.md"]);
  });

  it("keeps every user-global pack discoverable without a task keyword", async () => {
    const packs = ["aws", "asc", "vercel"].flatMap((family) => Array.from({ length: 6 }, (_, i) => ({
      name: `${family}-${i}`, path: `/global/${family}-${i}/SKILL.md`, description: `${family} procedure ${i}`,
    })));
    vi.mocked(native.globalSkills).mockResolvedValue(packs);

    expect(await skillPaths("home")).toEqual(packs.map((s) => s.path));
  });

  it("returns an empty search scope when no skills are available", async () => {
    expect(await skillPaths("home")).toEqual([]);
  });
});
