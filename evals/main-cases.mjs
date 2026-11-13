// The main-simulation cases in evals/main/, each world filled in and "each" lists unrolled.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Every case, or those named (a file's name takes all its "each" cases). A case file can build
 *  on a shared world (evals/main/_worlds/<name>.json) and hold many one-message cases in
 *  "each": [{ "text", "expect" }]. */
export function loadCases(names = []) {
  const world = (n) => JSON.parse(readFileSync(join(HERE, "main", "_worlds", `${n}.json`), "utf8"));
  return readdirSync(join(HERE, "main"))
    .filter((f) => f.endsWith(".json"))
    .flatMap((f) => {
      const name = f.replace(/\.json$/, "");
      const raw = JSON.parse(readFileSync(join(HERE, "main", f), "utf8"));
      const c = { ...(raw.world ? world(raw.world) : {}), ...raw, world: undefined };
      if (!c.each) return [{ name, ...c }];
      // a case in "each" can also bring its own world fields (tasks, projects, memory …)
      return c.each.map(({ id, text, ...x }, i) => ({ ...c, ...x, each: undefined, name: `${name}:${id ?? i + 1}`, note: x.note, chat: x.chat ?? c.chat, messages: x.messages ?? [text], expect: x.expect ? (Array.isArray(x.expect) ? x.expect : [x.expect]) : [] }));
    })
    .filter((c) => !names.length || names.some((n) => c.name === n || c.name.startsWith(`${n}:`)));
}
