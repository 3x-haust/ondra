#!/usr/bin/env node
// The user's real messages again, each in the situation it was sent in (see replayMain).
// There is no right answer to check against, so every decision gets the shared checks
// (evals/main-sim.mjs lint) and a short line per decision for a person to read through.
//   node evals/main-replay.mjs [--last 40] [--space work|home]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const last = Number(opt("--last", 40));
const only = opt("--space", "");
const { app } = await import("./devbridge.mjs");
const { lint } = await import("./main-sim-lint.mjs");
const msgs = await app(`return __ui.store.state.captain.filter(m => m.from === "me" && m.text && (${JSON.stringify(only)} === "" || m.space === ${JSON.stringify(only)})).slice(-${last}).map(m => ({ id: m.id, space: m.space, text: m.text }))`);
const out = [];
let next = 0;
await Promise.all(
  Array.from({ length: 4 }, async () => {
    while (next < msgs.length) {
      const m = msgs[next++];
      const steps = await app(`return await __ui.captain.replayMain(${JSON.stringify(m.id)})`).catch((e) => [{ error: String(e), routes: [] }]);
      const s = steps[0] ?? { routes: [], error: "no step" };
      const problems = s.error ? [`error: ${s.error}`] : lint(s, { space: m.space, tasks: [] }, true);
      const said = (s.routes ?? []).map((r) => `${r.kind}${r.taskId ? `→${r.taskId}` : ""}${r.title ? ` "${r.title}"` : ""}${r.project ? ` [${typeof r.project === "string" ? r.project : r.project.name}]` : ""}${r.reach?.length ? ` reach:${r.reach}` : ""}${r.after?.length ? ` after:${r.after}` : ""}`).join(" + ");
      out.push({ ...m, reply: s.reply, said, problems, routes: s.routes });
      console.log(`${problems.length ? "✗" : "·"} [${m.space}] ${m.text.replace(/\s+/g, " ").slice(0, 60)}\n    ${said}${problems.length ? `\n    ${problems.join("; ")}` : ""}`);
    }
  }),
);
const dir = join(HERE, "results");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, `replay-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`), JSON.stringify(out, null, 1));
