// The same accessible skill paths for main and jobs. Paths go to the search
// extension, never to Pi's prompt catalog. Product packs stay searchable even
// when the first request does not name their product.
import { globalSkills, workerSkills } from "../lib/native";
import { skillsIn } from "./memory";
import type { SpaceId } from "../state/types";

export interface GlobalSkill {
  name: string;
  path: string;
  description: string;
}

export async function skillScope(space: SpaceId) {
  const [bundled, global] = await Promise.all([workerSkills(), globalSkills()]);
  const local = skillsIn(space).map(({ name, path, description }) => ({ name, path, description }));
  return {
    paths: [...new Set([...bundled, ...local.map((s) => s.path), ...global.map((s) => s.path)])],
    signature: JSON.stringify([bundled, local, global]),
  };
}

export async function skillPaths(space: SpaceId): Promise<string[]> {
  return (await skillScope(space)).paths;
}
