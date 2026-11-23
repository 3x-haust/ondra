// The real-job cases in evals/cases/ (one request each, run end to end by evals/run.mjs),
// and the rules a case must follow (checked by evals/cases.test.mjs).
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { META } from "./main-cases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function loadJobCases(names = [], dir = join(HERE, "cases")) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ name: f.replace(/\.json$/, ""), ...JSON.parse(readFileSync(join(dir, f), "utf8")) }))
    .filter((c) => !names.length || names.includes(c.name));
}

/** True inside a macOS virtual machine (the kernel reports a hypervisor), false on a real Mac. */
export function inMacVm() {
  try {
    return execFileSync("sysctl", ["-n", "kern.hv_vmm_present"], { encoding: "utf8" }).trim() === "1";
  } catch {
    return false;
  }
}

/**
 * Computer-use cases drive real Mac apps, so they run only inside a macOS VM, never on the
 * user's own Mac. Returns the cases that may run here and the names held back.
 */
export function vmOnly(cases, inVm) {
  const held = inVm ? [] : cases.filter((c) => c.kind === "computer").map((c) => c.name);
  return { run: cases.filter((c) => !held.includes(c.name)), held };
}

// Keys run.mjs reads from a case's "expect" (an unknown one would be skipped without a word).
export const JOB_EXPECT = ["asks", "textAny", "artifacts", "research", "maxSecs", "maxTools"];

export function jobCaseProblems(c) {
  const out = [];
  if (typeof c.ask !== "string" || !c.ask.trim()) out.push("no ask");
  const seen = String(c.ask ?? "").match(META);
  if (seen) out.push(`the job would see "${seen[0]}"`);
  for (const k of Object.keys(c.expect ?? {})) if (!JOB_EXPECT.includes(k)) out.push(`unknown expect key "${k}"`);
  return out;
}
