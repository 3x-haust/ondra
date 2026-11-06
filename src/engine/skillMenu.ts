// Every skill the user can call from the input with "/skill:<name>": the app's own
// (기본), the ones made in the app, and the user's (~/.agents/skills).

import { createSignal } from "solid-js";
import { fsRead, globalSkills, skillList } from "../lib/native";
import { state } from "../state/store";

export interface MenuSkill {
  name: string;
  description: string;
  from: "bundled" | "mine" | "user";
}

const [found, setFound] = createSignal<MenuSkill[]>([]);
let at = 0;

/** the description from a SKILL.md's frontmatter (one line or a folded block) */
export function skillDescription(md: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(md)?.[1] ?? "";
  const m = /^description:\s*(?:[>|][-+]?\s*\n((?:[ \t]+.*\n?)+)|(.*))/m.exec(fm);
  if (!m) return "";
  return (m[1] ?? m[2] ?? "").replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
}

async function load() {
  const [own, user] = await Promise.all([skillList().catch(() => []), globalSkills().catch(() => [])]);
  const bundled = await Promise.all(
    own.map(async (f) => ({ name: f.name, description: skillDescription((await fsRead(f.path).catch(() => ({ text: "" }))).text ?? ""), from: "bundled" as const })),
  );
  setFound([...bundled, ...user.map((g) => ({ name: g.name, description: g.description, from: "user" as const }))]);
}

/** Skills for the "/" menu; the list on disk is read again at most once a minute. */
export function menuSkills(): MenuSkill[] {
  if (Date.now() - at > 60_000) {
    at = Date.now();
    void load();
  }
  const seen = new Set<string>();
  return [...state.skills.filter((s) => s.enabled).map((s) => ({ name: s.name, description: s.description, from: "mine" as const })), ...found()].filter(
    (s) => s.name && !seen.has(s.name) && !!seen.add(s.name),
  );
}
