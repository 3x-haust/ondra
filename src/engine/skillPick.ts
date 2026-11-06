// Which of the user's own skills (~/.agents/skills) a job gets. Packs of many
// skills on one product (aws-*, asc-*) cost ~1k characters each in every job's
// prompt and almost never apply, so a pack is given only when the job is about
// that product. Single skills are always given.

import { globalSkills, workerSkills } from "../lib/native";
import { skillsIn } from "./memory";
import type { Task } from "../state/types";

export interface GlobalSkill {
  name: string;
  path: string;
  description: string;
}

/** words that mean a job is about a pack's product (default: the pack's own name) */
const ABOUT: Record<string, RegExp> = {
  aws: /\b(aws|amazon|lambda|s3|dynamodb|cloudformation|cloudwatch|cdk|bedrock|cognito|sagemaker|ec2|ecs|eks)\b/i,
  asc: /\b(app ?store|testflight|asc|notari[sz]|xcode ?cloud)\b|앱 ?스토어|테스트플라이트|심사|출시/i,
  vercel: /\b(vercel|next\.?js)\b/i,
};
const PACK_SIZE = 5;

const family = (name: string) => name.split(/[-_:]/)[0].toLowerCase();
const about = (pack: string) => ABOUT[pack] ?? new RegExp(`\\b${pack}\\b`, "i");

export function pickSkills(all: GlobalSkill[], text: string): string[] {
  const size = new Map<string, number>();
  for (const s of all) size.set(family(s.name), (size.get(family(s.name)) ?? 0) + 1);
  const packs = [...size].filter(([, n]) => n >= PACK_SIZE).map(([f]) => f);
  // a skill belongs to a pack by its name (aws-iam, launch-with-aws) or by what its
  // description opens with (amazon-bedrock, setting-up-cloudwatch-observability)
  const packOf = (s: GlobalSkill) =>
    packs.find((p) => family(s.name) === p || new RegExp(`(^|-)${p}(-|$)`, "i").test(s.name)) ??
    packs.find((p) => about(p).test(`${s.name} ${s.description.slice(0, 160)}`));
  return all
    .filter((s) => {
      const p = packOf(s);
      return !p || about(p).test(text);
    })
    .map((s) => s.path);
}

/** Every skill a job gets: Ondra's own, the ones added in the app, and the user's that fit the job. */
export async function jobSkills(t: Task): Promise<string[]> {
  const text = [t.title, t.ask, t.topic, t.cwd].filter(Boolean).join(" ");
  return [
    ...(await workerSkills()),
    ...skillsIn(t.space).map((s) => s.path),
    ...pickSkills(await globalSkills(), text),
  ];
}
