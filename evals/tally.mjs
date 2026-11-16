// Counting runs: pass rates per case, flaky cases, harness errors, and a verdict
// when two runs are compared. Pure functions, except runMeta (reads git).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

/**
 * One result from either runner, in one shape. An error is a run where the harness
 * failed (app not answering, a route that threw): it says nothing about the model,
 * so it is counted apart from failures.
 */
export function normalize(r) {
  const problems = (r.problems ?? []).flat();
  const error = !!r.error || (r.failedChecks ?? []).includes("runner") || r.name === "?" || problems.some((p) => String(p).startsWith("error:"));
  return { name: r.name, pass: !error && !!(r.pass ?? r.ok), error };
}

/** Per case: runs, passes and harness errors. A case that both passed and failed is flaky. */
export function tally(results) {
  const by = new Map();
  for (const r of results.map(normalize)) {
    const t = by.get(r.name) ?? { name: r.name, runs: 0, passed: 0, errors: 0 };
    t.runs++;
    if (r.error) t.errors++;
    else if (r.pass) t.passed++;
    by.set(r.name, t);
  }
  const cases = [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of cases) c.flaky = c.passed > 0 && c.passed < c.runs - c.errors;
  const sum = (k) => cases.reduce((s, c) => s + c[k], 0);
  return { cases, runs: sum("runs"), passed: sum("passed"), errors: sum("errors"), flaky: cases.filter((c) => c.flaky).map((c) => c.name) };
}

/** One line for a report's head: the number with what it rests on. */
export function headline(t) {
  const counted = t.runs - t.errors;
  const reps = new Set(t.cases.map((c) => c.runs));
  const per = reps.size === 1 ? `${[...reps][0]} run${[...reps][0] > 1 ? "s" : ""} per case` : "runs per case vary";
  return [
    `${t.passed}/${counted} passed (${t.cases.length} case${t.cases.length === 1 ? "" : "s"}, ${per})`,
    t.errors ? `${t.errors} harness error${t.errors > 1 ? "s" : ""} not counted` : "",
    t.flaky.length ? `flaky: ${t.flaky.join(", ")}` : reps.has(1) && reps.size === 1 ? "one run per case: flakiness unknown" : "no flaky case",
  ].filter(Boolean).join(" · ");
}

const logFact = (() => {
  const memo = [0];
  return (n) => {
    for (let i = memo.length; i <= n; i++) memo[i] = memo[i - 1] + Math.log(i);
    return memo[n];
  };
})();

/** Fisher's exact test, two-sided: a of n passed before, b of m after. */
export function fisher(a, n, b, m) {
  const k = a + b;
  const N = n + m;
  const p = (x) => Math.exp(logFact(k) + logFact(N - k) + logFact(n) + logFact(m) - logFact(x) - logFact(k - x) - logFact(n - x) - logFact(m - k + x) - logFact(N));
  const seen = p(a);
  let total = 0;
  for (let x = Math.max(0, k - m); x <= Math.min(k, n); x++) {
    const q = p(x);
    if (q <= seen * (1 + 1e-7)) total += q;
  }
  return Math.min(1, total);
}

/**
 * Before vs after. Only cases that ran on both sides, unchanged (same hash when both
 * runs recorded one), count. Verdict: better, worse, no measurable difference, or
 * inconclusive (nothing comparable, or the two sides ran on different models).
 */
export function compare(before, after, { beforeMeta = {}, afterMeta = {}, alpha = 0.05 } = {}) {
  const A = tally(before);
  const B = tally(after);
  const hashA = beforeMeta.cases ?? {};
  const hashB = afterMeta.cases ?? {};
  const excluded = [];
  const rows = [];
  for (const a of A.cases) {
    const b = B.cases.find((x) => x.name === a.name);
    if (!b) continue;
    if (hashA[a.name] && hashB[a.name] && hashA[a.name] !== hashB[a.name]) {
      excluded.push(`${a.name} (case changed)`);
      continue;
    }
    if (a.runs === a.errors || b.runs === b.errors) {
      excluded.push(`${a.name} (only harness errors on one side)`);
      continue;
    }
    rows.push({ name: a.name, before: [a.passed, a.runs - a.errors], after: [b.passed, b.runs - b.errors], flaky: a.flaky || b.flaky });
  }
  const only = (x, y) => x.cases.filter((c) => !y.cases.some((d) => d.name === c.name)).map((c) => c.name);
  const sum = (side, i) => rows.reduce((s, r) => s + r[side][i], 0);
  const [a, n, b, m] = [sum("before", 0), sum("before", 1), sum("after", 0), sum("after", 1)];
  const p = rows.length ? fisher(a, n, b, m) : 1;
  const why = [];
  if (!rows.length) why.push("no case ran on both sides");
  if (beforeMeta.model && afterMeta.model && beforeMeta.model !== afterMeta.model) why.push(`different models (${beforeMeta.model} vs ${afterMeta.model})`);
  const verdict = why.length ? "inconclusive" : p < alpha ? (b / m > a / n ? "better" : "worse") : "no measurable difference";
  const single = rows.length > 0 && rows.every((r) => r.before[1] === 1 || r.after[1] === 1);
  return {
    verdict,
    why,
    p,
    before: [a, n],
    after: [b, m],
    changed: rows.filter((r) => r.before[0] / r.before[1] !== r.after[0] / r.after[1]),
    excluded,
    onlyBefore: only(A, B),
    onlyAfter: only(B, A),
    errors: [A.errors, B.errors],
    single,
  };
}

/** A short hash of a case as the runner reads it (text, world and expectations). */
export const caseHash = (c) => createHash("sha1").update(JSON.stringify(c)).digest("hex").slice(0, 10);

/** What a run rests on: the commit (and whether the tree had edits), the note, the cases' hashes. */
export function runMeta({ cwd, note, repeat, model, cases }) {
  const git = (...a) => {
    try {
      return execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  return {
    commit: git("rev-parse", "--short", "HEAD") || null,
    // paths from the repo's root (":/"), whatever folder the runner runs in
    dirty: git("status", "--porcelain", "--", ":/src", ":/skills", ":/evals", ":/src-tauri/src") !== "",
    note: note || null,
    repeat,
    model: model || null,
    cases: Object.fromEntries(cases.map((c) => [c.name, caseHash({ ...c, name: undefined })])),
  };
}
