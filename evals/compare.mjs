#!/usr/bin/env node
// Read saved runs, no app and no model calls.
//
//   node evals/compare.mjs <run>             one run: pass rate per case, flaky cases, errors
//   node evals/compare.mjs <before> <after>  two runs of the same runner: the verdict
//
// <run> is a folder under evals/results (e.g. main-2026-11-06T08-06-31) or a path to one.
// The verdict is better, worse, no measurable difference or inconclusive. It counts only
// cases that ran on both sides and didn't change in between, and leaves out harness
// errors. Fisher's exact test on the pooled passes; see evals/README.md for its limits.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compare, headline, tally } from "./tally.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function load(arg) {
  const dir = isAbsolute(arg) || existsSync(arg) ? arg : join(HERE, "results", arg);
  const report = join(dir, "report.json");
  if (!existsSync(report)) {
    console.error(`no report.json in ${dir}`);
    process.exit(2);
  }
  const meta = existsSync(join(dir, "meta.json")) ? JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) : {};
  return { dir, results: JSON.parse(readFileSync(report, "utf8")), meta };
}

const about = (m) => [m.commit ? `commit ${m.commit}${m.dirty ? " (with edits)" : ""}` : "commit not recorded", m.model ? `model ${m.model}` : "", m.note ? `note: ${m.note}` : ""].filter(Boolean).join(" · ");
const rate = ([k, n]) => `${k}/${n}`;

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log("usage: node evals/compare.mjs <run> [<run after>]   (folders under evals/results, or paths)");
} else if (args.length === 1) {
  const run = load(args[0]);
  const t = tally(run.results);
  console.log(headline(t));
  console.log(about(run.meta));
  for (const c of t.cases) if (c.passed < c.runs || c.errors) console.log(`  ${c.name}: ${c.passed}/${c.runs - c.errors}${c.flaky ? " flaky" : ""}${c.errors ? ` · ${c.errors} harness error(s)` : ""}`);
} else if (args.length === 2) {
  const [a, b] = args.map(load);
  const v = compare(a.results, b.results, { beforeMeta: a.meta, afterMeta: b.meta });
  console.log(`verdict: ${v.verdict}${v.why.length ? ` (${v.why.join("; ")})` : ""}`);
  console.log(`passed ${rate(v.before)} → ${rate(v.after)} · p = ${v.p.toFixed(3)}`);
  console.log(`before: ${about(a.meta)}`);
  console.log(`after:  ${about(b.meta)}`);
  if (v.single) console.log("one run per case on a side: a case that flips may be noise. Repeat with --repeat 3.");
  if (v.errors[0] || v.errors[1]) console.log(`harness errors left out: ${v.errors[0]} before, ${v.errors[1]} after`);
  for (const r of v.changed) console.log(`  ${r.name}: ${rate(r.before)} → ${rate(r.after)}${r.flaky ? " (flaky)" : ""}`);
  if (v.excluded.length) console.log(`not compared: ${v.excluded.join(", ")}`);
  if (v.onlyBefore.length) console.log(`only before: ${v.onlyBefore.join(", ")}`);
  if (v.onlyAfter.length) console.log(`only after: ${v.onlyAfter.join(", ")}`);
} else {
  console.log("usage: node evals/compare.mjs <run> [<run after>]");
  process.exit(2);
}
