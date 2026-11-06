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
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lint } from "./main-sim-lint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(homedir(), "Library/Application Support/dev.3xhaust.ondra");
const token = () => readFileSync(join(DATA, "devbridge.token"), "utf8").trim();
const argv = process.argv.slice(2);
const repeat = Number(argv[argv.indexOf("--repeat") + 1]) || 1;
const at = argv.indexOf("--parallel");
const parallel = Number(at >= 0 ? argv[at + 1] : 3) || 3;
const names = argv.filter((a, i) => !a.startsWith("--") && !["--repeat", "--parallel"].includes(argv[i - 1]));
// a case file can build on a shared world (evals/main/_worlds/<name>.json) and hold
// many one-message cases in "each": [{ "text", "expect" }]
const world = (n) => JSON.parse(readFileSync(join(HERE, "main", "_worlds", `${n}.json`), "utf8"));
const cases = readdirSync(join(HERE, "main"))
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => {
    const name = f.replace(/\.json$/, "");
    const raw = JSON.parse(readFileSync(join(HERE, "main", f), "utf8"));
    const c = { ...(raw.world ? world(raw.world) : {}), ...raw, world: undefined };
    if (!c.each) return [{ name, ...c }];
    return c.each.map((x, i) => ({ ...c, each: undefined, name: `${name}:${x.id ?? i + 1}`, note: x.note, chat: x.chat ?? c.chat, messages: x.messages ?? [x.text], expect: x.expect ? (Array.isArray(x.expect) ? x.expect : [x.expect]) : [] }));
  })
  .filter((c) => !names.length || names.some((n) => c.name === n || c.name.startsWith(`${n}:`)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function app(js) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch("http://127.0.0.1:17321/eval", { method: "POST", headers: { "x-token": token() }, body: js, signal: AbortSignal.timeout(600_000) });
      const t = await r.text();
      if (t.trim() && t.trim() !== '"unauthorized"') {
        const v = JSON.parse(t);
        if (typeof v === "string" && v.startsWith("ERR")) throw new Error(v);
        return v;
      }
    } catch (e) {
      if (String(e).includes("ERR")) throw e;
    }
    await sleep(3000);
  }
  throw new Error("dev bridge not answering: is `pnpm tauri dev` running?");
}

/** Every check a step's "expect" can hold; each returns a problem or "". */
function check(step, x) {
  const routes = step.routes ?? [];
  const kinds = routes.map((r) => r?.kind);
  const news = routes.filter((r) => r?.kind === "new");
  const text = (r) => `${r.title ?? ""} ${r.task ?? ""}`;
  const out = [];
  const need = (ok, msg) => ok || out.push(msg);
  if (step.error) return [`error: ${step.error}`];
  if (x.new !== undefined) {
    const [lo, hi] = typeof x.new === "number" ? [x.new, x.new] : [x.new.min ?? 0, x.new.max ?? 99];
    need(news.length >= lo && news.length <= hi, `new jobs: ${news.length}, expected ${lo === hi ? lo : `${lo}–${hi}`}`);
  }
  if (x.append !== undefined) {
    const ap = routes.filter((r) => r?.kind === "append").map((r) => r.taskId);
    if (x.append === false) need(!ap.length, `appended to ${ap.join(", ")}, expected no append`);
    else need(ap.includes(x.append), `expected append to ${x.append}, got ${ap.join(", ") || "none"}`);
  }
  if (x.stop) need(routes.some((r) => r?.kind === "stop" && r.taskId === x.stop), `expected stop of ${x.stop}`);
  if (x.answerOnly) need(kinds.length > 0 && kinds.every((k) => k === "answer"), `expected only an answer, got ${kinds.join(", ")}`);
  if (x.ask !== undefined) {
    const asked = kinds.includes("ask") || news.some((r) => /\bask\b|어느 쪽|골라|which one/i.test(r.task ?? ""));
    need(asked === x.ask, x.ask ? "expected a question to the user" : "asked the user, expected to just go");
  }
  if (x.project !== undefined) {
    const p = news.map((r) => r.project).filter(Boolean);
    const name = (v) => (typeof v === "string" ? v : v?.name ?? "");
    if (x.project === false) need(!p.length, `expected no project, got ${p.map(name).join(", ")}`);
    else if (x.project === true) need(p.length > 0, "expected a project on the new job");
    else need(p.some((v) => name(v).toLowerCase().includes(String(x.project).toLowerCase())), `expected project "${x.project}", got ${p.map(name).join(", ") || "none"}`);
  }
  if (x.cwdIncludes) need(news.some((r) => String(r.cwd ?? "").includes(x.cwdIncludes) || String(r.project?.folder ?? "").includes(x.cwdIncludes)), `expected cwd with "${x.cwdIncludes}", got ${news.map((r) => r.cwd || r.project?.folder || "-").join(", ")}`);
  if (x.reach !== undefined) {
    const got = [...new Set(news.flatMap((r) => (Array.isArray(r.reach) ? r.reach : [])))];
    if (!x.reach.length) need(!got.length, `expected no reach, got ${got.join(", ")}`);
    else need(x.reach.every((s) => got.includes(s)), `expected reach ${x.reach.join(", ")}, got ${got.join(", ") || "none"}`);
  }
  for (const w of x.taskIncludes ?? []) need(news.some((r) => text(r).toLowerCase().includes(w.toLowerCase())), `no new job's task mentions "${w}"`);
  for (const w of x.taskExcludes ?? []) need(!news.some((r) => text(r).toLowerCase().includes(w.toLowerCase())), `a new job's task mentions "${w}"`);
  for (const k of x.has ?? []) need(kinds.includes(k), `expected a "${k}" route, got ${kinds.join(", ") || "none"}`);
  for (const k of x.hasNot ?? []) need(!kinds.includes(k), `expected no "${k}" route`);
  if (x.stopCount !== undefined) need(routes.filter((r) => r?.kind === "stop").length === x.stopCount, `stops: ${routes.filter((r) => r?.kind === "stop").length}, expected ${x.stopCount}`);
  // a finished job is carried on by a new job with "from" (an append to it is turned into one, but main should say so)
  if (x.follows) need(news.some((r) => r.from === x.follows), routes.some((r) => r?.kind === "append" && r.taskId === x.follows) ? `appended to finished ${x.follows}, expected a new job with "from"` : `expected a new job following ${x.follows}`);
  if (x.appendAny) need(routes.some((r) => r?.kind === "append" && x.appendAny.includes(r.taskId)), `expected append to one of ${x.appendAny.join(", ")}`);
  if (x.cwdEmpty) need(news.every((r) => !r.cwd && !r.project), `expected no cwd/project, got ${news.map((r) => r.cwd || JSON.stringify(r.project)).join(", ")}`);
  if (x.appendOrAfter) need(routes.some((r) => r?.kind === "append" && r.taskId === x.appendOrAfter) || news.some((r) => Array.isArray(r.after) && r.after.includes(x.appendOrAfter)), `expected an append to ${x.appendOrAfter} or a job after it`);
  if (x.afterTask) need(news.some((r) => Array.isArray(r.after) && r.after.includes(x.afterTask)), `expected a job after ${x.afterTask}`);
  if (x.answerIncludes) {
    const t = routes.filter((r) => r?.kind === "answer").map((r) => r.text ?? "").join(" ");
    for (const w of x.answerIncludes) need(t.includes(w), `answer doesn't mention "${w}"`);
  }
  if (x.after) need(news.some((r) => Array.isArray(r.after) && r.after.length), "expected a job that waits (after)");
  if (x.noAfter) need(!news.some((r) => Array.isArray(r.after) && r.after.length), "a job waits (after) that should start now");
  return out;
}

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
