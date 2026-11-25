// Every skill the user can call from the input with "/skill:<name>": the app's own
// (기본) but those only the work picks up (menuHidden), the ones made in the app,
// and the user's (~/.agents/skills).

import { createSignal } from "solid-js";
import { createStore } from "solid-js/store";
import { fsRead, globalSkills, skillList } from "../lib/native";
import { state } from "../state/store";
import type { SpaceId } from "../state/types";
import { skillsIn } from "./memory";
import { askHost } from "./hosts";

interface MenuSkill {
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

/** A skill the work picks up by itself and the user never calls (frontmatter `metadata: ondra-menu: hidden`):
 *  left out of the "/" menu, listed apart in Settings › 스킬. */
export function menuHidden(md: string): boolean {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? "";
  return /^[ \t]+ondra-menu:[ \t]*["']?hidden["']?[ \t]*$/m.test(fm);
}

async function load() {
  const [own, user] = await Promise.all([skillList().catch(() => []), globalSkills().catch(() => [])]);
  const bundled = await Promise.all(
    own.map(async (f) => {
      const md = (await fsRead(f.path).catch(() => ({ text: "" }))).text ?? "";
      return menuHidden(md) ? undefined : { name: f.name, description: skillDescription(md), from: "bundled" as const };
    }),
  );
  setFound([...bundled.filter((s) => s !== undefined), ...user.map((g) => ({ name: g.name, description: g.description, from: "user" as const }))]);
}

const mine = (space: SpaceId) => skillsIn(space).map((s) => ({ name: s.name, description: s.description, from: "mine" as const }));
const once = (list: MenuSkill[]) => {
  const seen = new Set<string>();
  return list.filter((s) => s.name && !seen.has(s.name) && !!seen.add(s.name));
};

/** The skills a job of that workspace gets, read now: what another device shows for its jobs here (engine/farHost.ts). */
export async function skillsFor(space: SpaceId): Promise<MenuSkill[]> {
  if (Date.now() - at > 60_000 || !found().length) {
    at = Date.now();
    await load();
  }
  return once([...mine(space), ...found()]);
}

/** another device's skills, per Mac and place (a job, a project): its jobs run with those, not this Mac's */
const [far, setFar] = createStore<Record<string, MenuSkill[]>>({});
const farAt = new Map<string, number>();

/** Skills for the "/" menu; the list on disk is read again at most once a minute. A job or project
 *  of another device (`on`) lists that device's skills, asked again at most once a minute too. */
export function menuSkills(on?: { host: string; task?: string; project?: string }): MenuSkill[] {
  if (on) {
    const key = `${on.host}|${on.task ?? ""}|${on.project ?? ""}`;
    if (Date.now() - (farAt.get(key) ?? 0) > 60_000) {
      farAt.set(key, Date.now());
      void askHost<MenuSkill[]>(on.host, "far.skills", [{ task: on.task, project: on.project }])
        .then((l) => void (Array.isArray(l) && setFar(key, l)))
        // an older Ondra there: none listed, asked again in a minute
        .catch(() => {});
    }
    return far[key] ?? [];
  }
  if (Date.now() - at > 60_000) {
    at = Date.now();
    void load();
  }
  return once([...mine(state.space), ...found()]);
}
