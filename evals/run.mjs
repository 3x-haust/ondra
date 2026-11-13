#!/usr/bin/env node
// Ondra evals: send each case to main (in its own "평가" project chat), wait for
// the jobs it starts, and score them. Needs the dev app running (`pnpm tauri dev`).
//
//   node evals/run.mjs                 all cases
//   node evals/run.mjs cu-calculator   one or more cases by name
//   node evals/run.mjs --repeat 3      run each case several times
//
// Writes evals/results/<time>/report.{json,md} (with each failed tool's output,
// for finding the cause) and appends one line per run to evals/results/history.jsonl.
import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(homedir(), "Library/Application Support/dev.3xhaust.ondra");
// read on every call: the app writes a new one each time it restarts
const token = () => readFileSync(join(DATA, "devbridge.token"), "utf8").trim();
const SPACE = "home";
// outside any repo: a folder inside ondra made jobs open ondra worktrees and task branches
const PROJECT_DIR = join(DATA, "evals-workspace");

const argv = process.argv.slice(2);
const repeat = Number(argv[argv.indexOf("--repeat") + 1]) || 1;
const names = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--repeat");
const cases = readdirSync(join(HERE, "cases"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ name: f.replace(/\.json$/, ""), ...JSON.parse(readFileSync(join(HERE, "cases", f), "utf8")) }))
  .filter((c) => !names.length || names.includes(c.name));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run JS inside the app (dev bridge). The body must `return` a JSON-able value. */
async function app(js) {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch("http://127.0.0.1:17321/eval", { method: "POST", headers: { "x-token": token() }, body: js, signal: AbortSignal.timeout(130_000) });
      const t = await r.text();
      if (t.trim() && t.trim() !== '"unauthorized"') {
        const v = JSON.parse(t);
        if (typeof v === "string" && v.startsWith("ERR")) throw new Error(v);
        return v;
      }
    } catch (e) {
      if (String(e).includes("ERR")) throw e;
    }
    await sleep(3000); // app restarting
  }
  throw new Error("dev bridge not answering — is `pnpm tauri dev` running?");
}

const devices = () => {
  const out = {};
  try {
    out.sims = execFileSync("xcrun", ["simctl", "list", "devices"], { encoding: "utf8" }).split("\n").filter((l) => /ondra-/.test(l) && /Booted/.test(l)).map((l) => l.trim());
  } catch { out.sims = []; }
  try {
    out.emulators = execFileSync("pgrep", ["-fl", "qemu-system"], { encoding: "utf8" }).split("\n").filter(Boolean).length;
  } catch { out.emulators = 0; }
  return out;
};

// commands that would take the user's focus or draw on their screen
const FOCUS = [/--activate\b/, /\bfocus-window\b/, /--headed\b/, /--cursor\b/, /cursor-overlay/, /\bmouse-(move|click|down|up|wheel)\b/, /(^|\s)open\s+(?!.*-g)(-[a-zA-Z]+\s+)*-a\b/];

/** The failed tool calls with their output, from the job's engine session. */
function failedOutputs(taskId) {
  const dir = join(DATA, "sessions", taskId);
  if (!existsSync(dir)) return [];
  const calls = new Map();
  const out = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      const m = o.message ?? {};
      if (Array.isArray(m.content)) for (const c of m.content) if (c.type === "toolCall") calls.set(c.id, c.arguments);
      if (m.role === "toolResult" && m.isError) {
        const text = (m.content ?? []).map((x) => x.text ?? "").join("").split("\n").filter((l) => !/\bWARN\b/.test(l)).join("\n");
        out.push({ call: JSON.stringify(calls.get(m.toolCallId) ?? {}).slice(0, 300), output: text.slice(-1200) });
      }
    }
  }
  return out;
}

async function runCase(c) {
  const t0 = Date.now();
  // its own project (folder + main chat) per run, so main can't pick up an
  // earlier run's job or its old screenshot
  // a neutral name: a folder called after the case sent jobs searching memory for it
  const dir = join(PROJECT_DIR, `w-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  const project = await app(`return __ui.store.addProject("${SPACE}", ${JSON.stringify(dir)}, ${JSON.stringify(`평가 ${dir.split("-").pop()}`)});`);
  const replyId = await app(`return __ui.captain.throwThought(${JSON.stringify(c.ask)}, "${SPACE}", { project: ${JSON.stringify(project)} });`);
  let reply;
  for (let i = 0; i < 100; i++) {
    reply = await app(`const m = __ui.store.state.captain.find((m) => m.id === ${JSON.stringify(replyId)}); return m && { pending: !!m.pending, text: m.reply ?? "", error: m.error ?? "", routes: (m.routes ?? []).map((r) => r.taskId).filter(Boolean) };`);
    if (reply && !reply.pending) break;
    await sleep(2000);
  }
  const routedSecs = Math.round((Date.now() - t0) / 1000);
  const ids = reply?.routes ?? [];
  const limit = (c.expect?.maxSecs ?? 300) * 3 * 1000;
  let asked = 0;
  let tasks = [];
  while (Date.now() - t0 < limit) {
    tasks = await app(`return ${JSON.stringify(ids)}.map((id) => { const t = __ui.store.state.tasks.find((t) => t.id === id); const d = __ui.store.state.decisions.find((d) => d.taskId === id); return t && { id, status: t.status, decision: d && { id: d.id, q: d.question, options: d.options.map((o) => o.id) } }; }).filter(Boolean);`);
    if (!Array.isArray(tasks)) throw new Error(`unexpected task list: ${JSON.stringify(tasks).slice(0, 300)}`);
    const open = tasks.filter((t) => !["done", "failed", "cancelled"].includes(t.status));
    const waiting = open.filter((t) => t.decision);
    for (const w of waiting) {
      asked++;
      if (c.expect?.asks || c.answer !== "first") continue;
      await app(`__ui.tasks.decide(${JSON.stringify(w.decision.id)}, ${JSON.stringify(w.decision.options[0])}); return 1;`);
    }
    if (!open.length || (waiting.length === open.length && (c.expect?.asks || c.answer !== "first"))) break;
    await sleep(5000);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  const detail = await app(`return ${JSON.stringify(ids)}.map((id) => { const t = __ui.store.state.tasks.find((t) => t.id === id); if (!t) return null; const tools = t.entries.filter((e) => e.kind === "tool" && e.at >= ${t0}); return { id, title: t.title, status: t.status, final: (t.entries.filter((e) => e.kind === "text").pop()?.text ?? "").slice(0, 1500), tools: tools.map((e) => ({ kind: e.tool.kind, cmd: ((e.tool.detail || e.tool.target) ?? "").slice(0, 300), ok: e.tool.ok !== false, secs: e.tool.endedAt ? Math.round((e.tool.endedAt - e.at) / 1000) : null })) }; }).filter(Boolean);`);
  const tools = detail.flatMap((d) => d.tools);
  const text = [reply?.text ?? "", ...detail.map((d) => d.final)].join("\n");
  const artifacts = ids.flatMap((id) => {
    const dir = join(DATA, "artifacts", id);
    return existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith(".") && statSync(join(dir, f)).mtimeMs >= t0) : [];
  });
  const e = c.expect ?? {};
  const checks = {};
  let research;
  if (e.asks) checks.asked = asked > 0;
  else checks.done = detail.length > 0 && detail.every((d) => d.status === "done");
  if (e.textAny) checks.text = e.textAny.some((s) => text.includes(s));
  if (e.artifacts) checks.artifacts = e.artifacts.every((ext) => artifacts.some((a) => a.toLowerCase().endsWith(`.${ext}`)));
  if (e.research) {
    // deep-research: score the newest research folder with the skill's own checker (writes eval.json)
    const dirs = ids.flatMap((id) => {
      const dir = join(DATA, "artifacts", id);
      return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("research-")).map((f) => join(dir, f)) : [];
    }).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    research = dirs.length ? scoreResearch(dirs[0]) : { pass: false, failed: ["no research folder"] };
    checks.research = !!research.pass;
    if (e.research.blocked) checks.blockedRead = (research.rescued_reads ?? 0) > 0;
    checks.pdf = !!dirs[0] && readdirSync(dirs[0]).some((f) => f.endsWith(".pdf"));
  }
  if (e.maxSecs) checks.fast = secs <= e.maxSecs;
  if (e.maxTools) checks.fewTools = tools.length <= e.maxTools;
  checks.noFailedTools = tools.every((t) => t.ok);
  checks.noFocus = !tools.some((t) => FOCUS.some((re) => re.test(t.cmd)));
  if (c.kind === "device") {
    await sleep(5000);
    const left = devices();
    checks.cleanedUp = !left.sims.length && !left.emulators;
  }
  // out of main's sight for the next case (it would add to these instead of starting fresh)
  // tidy up: stop what's still going (timed out), archive the jobs, drop the run's project
  await app(`for (const id of ${JSON.stringify(ids)}) { const t = __ui.store.state.tasks.find((t) => t.id === id); if (!t) continue; if (["running", "queued", "waiting"].includes(t.status)) await __ui.tasks.pauseTask(id); __ui.tasks.archiveTask(id); } __ui.store.setState("projects", (l) => l.filter((p) => p.id !== ${JSON.stringify(project)})); return 1;`).catch(() => {});
  const failedChecks = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
  return {
    name: c.name, ask: c.ask, pass: !failedChecks.length, failedChecks, checks,
    secs, routedSecs, tools: tools.length, failedTools: tools.filter((t) => !t.ok).length, asked, research,
    slowest: [...tools].sort((a, b) => (b.secs ?? 0) - (a.secs ?? 0)).slice(0, 3),
    reply: reply?.text, routes: ids, jobs: detail,
    failures: ids.flatMap(failedOutputs),
  };
}

/** The deep-research checker's scorecard for one research folder ($R/eval.json). */
function scoreResearch(dir) {
  const checker = join(HERE, "..", "skills", "deep-research", "check-research.py");
  try {
    execFileSync("python3", [checker, dir, "--score"], { encoding: "utf8", timeout: 600_000 });
  } catch {} // exit 1 = [error] hits left; the scorecard is still written
  try {
    return JSON.parse(readFileSync(join(dir, "eval.json"), "utf8"));
  } catch (err) {
    return { pass: false, failed: [`checker: ${String(err).slice(0, 200)}`] };
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = join(HERE, "results", stamp);
mkdirSync(outDir, { recursive: true });
const results = [];
for (let r = 0; r < repeat; r++) {
  for (const c of cases) {
    process.stdout.write(`${c.name} … `);
    let res;
    try {
      res = await runCase(c);
    } catch (err) {
      res = { name: c.name, ask: c.ask, pass: false, failedChecks: ["runner"], error: String(err) };
    }
    results.push(res);
    console.log(`${res.pass ? "PASS" : "FAIL"} ${res.secs ?? "-"}s tools=${res.tools ?? "-"} failed=${res.failedTools ?? "-"} ${res.failedChecks.join(",")}`);
    writeFileSync(join(outDir, "report.json"), JSON.stringify(results, null, 2));
  }
}

const md = [
  `# Ondra evals ${stamp}`,
  "",
  `${results.filter((r) => r.pass).length}/${results.length} passed`,
  "",
  "| case | pass | secs | tools | failed tools | asked | failed checks |",
  "|---|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.name} | ${r.pass ? "yes" : "no"} | ${r.secs ?? "-"} | ${r.tools ?? "-"} | ${r.failedTools ?? "-"} | ${r.asked ?? "-"} | ${r.failedChecks.join(", ")} |`),
  "",
  ...results.filter((r) => !r.pass).flatMap((r) => [
    `## ${r.name}`,
    "",
    r.error ? `runner error: ${r.error}` : "",
    `slowest: ${(r.slowest ?? []).map((t) => `${t.secs}s ${t.cmd.slice(0, 80)}`).join(" · ")}`,
    r.research ? `research: ${JSON.stringify(r.research)}` : "",
    "",
    ...(r.failures ?? []).slice(0, 5).flatMap((f) => ["```", f.call, f.output.slice(-600), "```"]),
    "",
    "final answer:",
    "",
    ...(r.jobs ?? []).map((j) => `> ${j.final.replace(/\n/g, "\n> ")}`),
    "",
  ]),
].join("\n");
writeFileSync(join(outDir, "report.md"), md);
appendFileSync(join(HERE, "results", "history.jsonl"), JSON.stringify({ at: stamp, results: results.map(({ name, pass, secs, tools, failedTools, failedChecks }) => ({ name, pass, secs, tools, failedTools, failedChecks })) }) + "\n");
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed → ${join(outDir, "report.md")}`);
