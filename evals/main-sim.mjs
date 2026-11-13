#!/usr/bin/env node
// Main's decisions, simulated: each case is a made-up situation (jobs, projects,
// memory, chat) and the messages the user sends in it. Main decides with the real
// prompt and model, nothing is started, and each decision is checked.
// Needs the dev app running (`pnpm tauri dev`).
//
//   node evals/main-sim.mjs                 all cases in evals/main/
//   node evals/main-sim.mjs split-extra     some cases by name
//   node evals/main-sim.mjs --repeat 3      each case several times (decisions vary)
//
// Writes evals/results/main-<time>/report.md (failures with main's routes and the
// context it saw) and appends a line per run to evals/results/main-history.jsonl.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lint } from "./main-sim-lint.mjs";
import { check } from "./main-sim-check.mjs";
import { loadCases } from "./main-cases.mjs";
import { app } from "./devbridge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const repeat = Number(argv[argv.indexOf("--repeat") + 1]) || 1;
const at = argv.indexOf("--parallel");
const parallel = Number(at >= 0 ? argv[at + 1] : 3) || 3;
const names = argv.filter((a, i) => !a.startsWith("--") && !["--repeat", "--parallel"].includes(argv[i - 1]));
const cases = loadCases(names);


async function runCase(c, i) {
  const t0 = Date.now();
  const steps = await app(`return await __ui.captain.simulateMain(${JSON.stringify({ ...c, name: undefined, note: undefined, expect: undefined, each: undefined })})`);
  const problems = steps.map((s, k) => [...check(s, (c.expect ?? [])[k] ?? {}), ...lint(s, c)]);
  const ok = problems.every((p) => !p.length);
  return { name: c.name, run: i, ok, secs: Math.round((Date.now() - t0) / 1000), problems, steps };
}

const jobs = cases.flatMap((c) => Array.from({ length: repeat }, (_, i) => () => runCase(c, i)));
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      const r = await j().catch((e) => ({ name: "?", ok: false, problems: [[String(e)]], steps: [] }));
      results.push(r);
      console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${repeat > 1 ? ` #${r.run + 1}` : ""} (${r.secs ?? "?"}s)${r.ok ? "" : `: ${r.problems.flat().join("; ")}`}`);
    }
  }),
);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(HERE, "results", `main-${stamp}`);
mkdirSync(dir, { recursive: true });
const md = [`# Main simulation ${stamp}`, "", `${results.filter((r) => r.ok).length}/${results.length} passed`, ""];
for (const r of results.sort((a, b) => a.name.localeCompare(b.name))) {
  md.push(`## ${r.ok ? "PASS" : "FAIL"} ${r.name}${repeat > 1 ? ` #${r.run + 1}` : ""}`);
  r.steps.forEach((s, k) => {
    md.push("", `**${k + 1}. user:** ${s.text.replace(/\n/g, " ")}`, "", `reply: ${s.reply || "-"}`, "", "```json", JSON.stringify(s.routes, null, 1).slice(0, 3000), "```");
    if (r.problems[k]?.length) md.push("", ...r.problems[k].map((p) => `- ✗ ${p}`), "", "<details><summary>context main saw</summary>", "", "```", (s.context ?? "").slice(0, 6000), "```", "</details>");
  });
  md.push("");
}
writeFileSync(join(dir, "report.md"), md.join("\n"));
writeFileSync(join(dir, "report.json"), JSON.stringify(results, null, 1));
appendFileSync(join(HERE, "results", "main-history.jsonl"), JSON.stringify({ at: stamp, passed: results.filter((r) => r.ok).length, total: results.length, failed: results.filter((r) => !r.ok).map((r) => r.name) }) + "\n");
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed · ${join(dir, "report.md")}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
