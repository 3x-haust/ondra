#!/usr/bin/env node
// Main's decisions, simulated: each case is a made-up situation (jobs, projects,
// memory, chat) and the messages the user sends in it. Main decides with the real
// prompt and model, nothing is started, and each decision is checked.
// Needs the dev app running (`pnpm tauri dev`).
//
//   node evals/main-sim.mjs                 all cases in evals/main/
//   node evals/main-sim.mjs split-extra     some cases by name
//   node evals/main-sim.mjs --repeat 3      each case several times (decisions vary)
//   node evals/main-sim.mjs --note "..."    what this run should show (kept with the result)
//
// Writes evals/results/main-<time>/report.md (failures with main's routes and the
// context it saw), report.json and meta.json (commit, note, model, case hashes), and
// appends a line per run to evals/results/main-history.jsonl. Compare two runs with
// evals/compare.mjs. See evals/README.md.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lint } from "./main-sim-lint.mjs";
import { check } from "./main-sim-check.mjs";
import { loadCases, mainInput } from "./main-cases.mjs";
import { app } from "./devbridge.mjs";
import { headline, runMeta, tally } from "./tally.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const repeat = Number(argv[argv.indexOf("--repeat") + 1]) || 1;
const at = argv.indexOf("--parallel");
const parallel = Number(at >= 0 ? argv[at + 1] : 3) || 3;
const note = argv.includes("--note") ? argv[argv.indexOf("--note") + 1] : "";
const names = argv.filter((a, i) => !a.startsWith("--") && !["--repeat", "--parallel", "--note"].includes(argv[i - 1]));
const cases = loadCases(names);

async function runCase(c, i) {
  const t0 = Date.now();
  const steps = await app(`return await __ui.captain.simulateMain(${JSON.stringify(mainInput(c))})`);
  // a step per message, or the run didn't happen (an empty list would pass every check)
  if (!Array.isArray(steps) || steps.length !== c.messages.length) throw new Error(`${Array.isArray(steps) ? steps.length : "no"} steps for ${c.messages.length} messages`);
  const problems = steps.map((s, k) => [...check(s, (c.expect ?? [])[k] ?? {}), ...lint(s, c)]);
  const ok = problems.every((p) => !p.length);
  return { name: c.name, run: i, ok, secs: Math.round((Date.now() - t0) / 1000), problems, steps };
}

const jobs = cases.flatMap((c) => Array.from({ length: repeat }, (_, i) => ({ name: c.name, i, run: () => runCase(c, i) })));
const model = await app(`return __ui.store.state.settings?.captainModel || ""`).catch(() => "");
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
    while (next < jobs.length) {
      const j = jobs[next++];
      // a harness error (no answer from the app, a call that threw): counted apart from failures
      const r = await j.run().catch((e) => ({ name: j.name, run: j.i, ok: false, error: String(e), problems: [[`error: ${e}`]], steps: [] }));
      results.push(r);
      console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${repeat > 1 ? ` #${r.run + 1}` : ""} (${r.secs ?? "?"}s)${r.ok ? "" : `: ${r.problems.flat().join("; ")}`}`);
    }
  }),
);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const dir = join(HERE, "results", `main-${stamp}`);
mkdirSync(dir, { recursive: true });
const t = tally(results);
const meta = { at: stamp, ...runMeta({ cwd: HERE, note, repeat, model, cases }) };
const md = [`# Main simulation ${stamp}`, "", headline(t), "", `commit ${meta.commit}${meta.dirty ? " (with edits)" : ""} · model ${meta.model ?? "account default"}${note ? ` · note: ${note}` : ""}`, ""];
if (repeat > 1) md.push("| case | passed | harness errors |", "|---|---|---|", ...t.cases.map((c) => `| ${c.name}${c.flaky ? " (flaky)" : ""} | ${c.passed}/${c.runs - c.errors} | ${c.errors || ""} |`), "");
for (const r of results.sort((a, b) => a.name.localeCompare(b.name) || a.run - b.run)) {
  md.push(`## ${r.ok ? "PASS" : "FAIL"} ${r.name}${repeat > 1 ? ` #${r.run + 1}` : ""}`);
  if (r.error) md.push("", `harness error (not counted): ${r.error}`);
  r.steps.forEach((s, k) => {
    md.push("", `**${k + 1}. user:** ${s.text.replace(/\n/g, " ")}`, "", `reply: ${s.reply || "-"}`, "", "```json", JSON.stringify(s.routes, null, 1).slice(0, 3000), "```");
    if (r.problems[k]?.length) md.push("", ...r.problems[k].map((p) => `- ✗ ${p}`), "", "<details><summary>context main saw</summary>", "", "```", (s.context ?? "").slice(0, 6000), "```", "</details>");
  });
  md.push("");
}
writeFileSync(join(dir, "report.md"), md.join("\n"));
writeFileSync(join(dir, "report.json"), JSON.stringify(results, null, 1));
writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 1));
appendFileSync(join(HERE, "results", "main-history.jsonl"), JSON.stringify({ at: stamp, commit: meta.commit, dirty: meta.dirty, note: meta.note, passed: t.passed, total: t.runs - t.errors, errors: t.errors, flaky: t.flaky, failed: results.filter((r) => !r.ok && !r.error).map((r) => r.name) }) + "\n");
console.log(`\n${headline(t)} · ${join(dir, "report.md")}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
