// The main-simulation cases in evals/main/, each world filled in and "each" lists unrolled,
// and the rules a case must follow (checked by evals/cases.test.mjs).
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECT_KEYS } from "./main-sim-check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every case, or those named (a file's name takes all its "each" cases). A case file can build
 *  on a shared world (evals/main/_worlds/<name>.json) and hold many one-message cases in
 *  "each": [{ "text", "expect" }]. */
export function loadCases(names = [], dir = join(HERE, "main")) {
  const world = (n) => JSON.parse(readFileSync(join(dir, "_worlds", `${n}.json`), "utf8"));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => {
      const name = f.replace(/\.json$/, "");
      const raw = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const c = { ...(raw.world ? world(raw.world) : {}), ...raw, world: undefined };
      if (!c.each) return [{ name, ...c }];
      // a case in "each" can also bring its own world fields (tasks, projects, memory …)
      return c.each.map(({ id, text, ...x }, i) => ({ ...c, ...x, each: undefined, name: `${name}:${id ?? i + 1}`, note: x.note, chat: x.chat ?? c.chat, messages: x.messages ?? [text], expect: x.expect ? (Array.isArray(x.expect) ? x.expect : [x.expect]) : [] }));
    })
    .filter((c) => !names.length || names.some((n) => c.name === n || c.name.startsWith(`${n}:`)));
}

/** What main is sent from a case: everything but the name, the note and the expectations. */
export const mainInput = (c) => ({ ...c, name: undefined, note: undefined, expect: undefined, each: undefined });

// Words that tell the model it is being tested. Anything it sees (messages, chat, jobs,
// projects, memory, folder names) must read like a real user's day. Organic uses
// ("테스트 돌려줘", "시뮬레이터") are fine and are not matched. evals/job-cases.mjs uses it too.
export const META = /\beval(s|uat\w*)?\b|\brubric|\bjudg(e|ed|ing)\b|\bgrader\b|평가|채점|시뮬레이션/i;

/** Problems with a case: meta words main would see, unknown expect keys (check() skips them
 *  without a word, so a typo would pass every time), expectations that don't line up. */
export function caseProblems(c) {
  const out = [];
  const seen = JSON.stringify(mainInput(c)).match(META);
  if (seen) out.push(`main would see "${seen[0]}"`);
  if (!Array.isArray(c.messages) || !c.messages.length) out.push("no messages");
  if (c.expect !== undefined && !Array.isArray(c.expect)) out.push("expect must be a list, one per message");
  const ex = Array.isArray(c.expect) ? c.expect : [];
  if (Array.isArray(c.messages) && ex.length > c.messages.length) out.push(`${ex.length} expectations for ${c.messages.length} messages`);
  for (const x of ex) for (const k of Object.keys(x ?? {})) if (!EXPECT_KEYS.includes(k)) out.push(`unknown expect key "${k}"`);
  if (!ex.some((x) => Object.keys(x ?? {}).length)) out.push("nothing expected (only the shared lint would run)");
  return out;
}
