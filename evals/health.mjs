#!/usr/bin/env node
// Harness health from real sessions: prompt-cache use and tool failures.
//   node evals/health.mjs            # last 24h
//   node evals/health.mjs 6          # last 6h
//   node evals/health.mjs 24 --json  # machine-readable
// Targets: cache ≥ 96%, tool failures ≤ 1%.
//
// Cache, two numbers per call:
//   hit   = cacheRead / whole prompt            (what the reply-foot shows; new text always counts as a miss)
//   reuse = cacheRead / what was already sent   (prompt of the previous call in the same session; 100% = nothing
//                                                 that could come from the cache was paid again)
// A session's first call reuses the shared system-prompt cache when there is one; it counts toward reuse
// only with what it read.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA = process.env.ONDRA_DATA ?? join(homedir(), "Library/Application Support/dev.3xhaust.ondra");
const hours = Number(process.argv.find((a) => /^\d+(\.\d+)?$/.test(a)) ?? 24);
const asJson = process.argv.includes("--json");
const since = Date.now() - hours * 3600_000;

const files = [];
const root = join(DATA, "sessions");
for (const dir of readdirSync(root)) {
  const d = join(root, dir);
  if (!statSync(d).isDirectory()) continue;
  for (const f of readdirSync(d)) if (f.endsWith(".jsonl") && statSync(join(d, f)).mtimeMs >= since) files.push({ dir, path: join(d, f) });
}

const sum = () => ({ calls: 0, prompt: 0, read: 0, reusable: 0, reused: 0, misses: [] });
const cache = { main: sum(), job: sum() };
const tools = { calls: 0, failed: 0, byTool: {}, samples: [] };

for (const { dir, path } of files) {
  const who = dir.startsWith("captain") ? "main" : "job";
  let prev = 0;
  const pending = new Map();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.timestamp && Date.parse(o.timestamp) < since) continue;
    const m = o.message;
    if (!m || typeof m !== "object") continue;
    if (m.role === "assistant") {
      for (const c of Array.isArray(m.content) ? m.content : []) if (c?.type === "toolCall") pending.set(c.id, { name: c.name, args: c.arguments });
      const u = m.usage;
      if (u && (u.input || u.cacheRead || u.cacheWrite)) {
        const s = cache[who];
        const prompt = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        const read = u.cacheRead ?? 0;
        s.calls++;
        s.prompt += prompt;
        s.read += read;
        const reusable = prev || read;
        s.reusable += reusable;
        s.reused += Math.min(read, reusable);
        if (prev && read < prev * 0.9) s.misses.push({ session: `${dir}/${path.split("/").pop()}`, at: o.timestamp, read, before: prev, model: m.model });
        prev = prompt;
      }
    }
    if (m.role === "toolResult") {
      const call = pending.get(m.toolCallId) ?? { name: m.toolName ?? "?" };
      const name = m.toolName ?? call.name;
      tools.calls++;
      const t = (tools.byTool[name] ??= { calls: 0, failed: 0 });
      t.calls++;
      if (m.isError) {
        tools.failed++;
        t.failed++;
        const text = (Array.isArray(m.content) ? m.content.map((c) => c?.text ?? "").join(" ") : String(m.content ?? "")).replace(/\s+/g, " ").slice(0, 220);
        const arg = call.args ? JSON.stringify(call.args).slice(0, 160) : "";
        tools.samples.push({ session: dir, tool: name, arg, error: text });
      }
    }
  }
}

const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);
const report = {
  hours,
  sessions: files.length,
  cache: Object.fromEntries(
    Object.entries(cache).map(([k, s]) => [k, { calls: s.calls, hit: pct(s.read, s.prompt), reuse: pct(s.reused, s.reusable), misses: s.misses.length, missList: s.misses.slice(0, 10) }]),
  ),
  tools: {
    calls: tools.calls,
    failed: tools.failed,
    failRate: pct(tools.failed, tools.calls),
    byTool: Object.fromEntries(Object.entries(tools.byTool).sort((a, b) => b[1].failed - a[1].failed).map(([k, v]) => [k, { ...v, rate: pct(v.failed, v.calls) }])),
    samples: tools.samples,
  },
};
report.pass = { cache: Math.min(report.cache.main.reuse, report.cache.job.reuse) >= 96, tools: report.tools.failRate <= 1 };

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`last ${hours}h · ${files.length} sessions`);
  for (const [k, c] of Object.entries(report.cache)) console.log(`cache ${k.padEnd(4)} calls ${String(c.calls).padStart(5)}  hit ${c.hit}%  reuse ${c.reuse}%  prefix misses ${c.misses}`);
  console.log(`tools      calls ${tools.calls}  failed ${tools.failed}  (${report.tools.failRate}%)`);
  for (const [k, v] of Object.entries(report.tools.byTool).slice(0, 8)) if (v.failed) console.log(`  ${k.padEnd(12)} ${v.failed}/${v.calls} (${v.rate}%)`);
  console.log(`pass: cache ${report.pass.cache ? "yes" : "no"} · tools ${report.pass.tools ? "yes" : "no"}`);
}
