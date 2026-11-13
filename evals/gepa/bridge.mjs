#!/usr/bin/env node
// The optimizer's (optimize.py) one door to Ondra: one JSON request on stdin, one JSON answer on
// stdout. Everything that needs the app goes through the dev bridge (evals/devbridge.mjs), the
// same path evals/main-sim.mjs takes, so no credential is read or passed here.
//
//   echo '{}' | node evals/gepa/bridge.mjs cases
//   echo '{}' | node evals/gepa/bridge.mjs seed            main's system prompt as the app has it
//   echo '{"case":…,"system":"…"}' | node evals/gepa/bridge.mjs sim
//   echo '{"prompt":"…"}' | node evals/gepa/bridge.mjs reflect
//
// GEPA_MOCK=1: no app, no model. sim and reflect are faked (deterministically) so the whole loop
// can be run for free; seed is read from src/engine/prompts.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCases, mainInput } from "../main-cases.mjs";
import { check } from "../main-sim-check.mjs";
import { lint } from "../main-sim-lint.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = process.env.GEPA_MOCK === "1";
const op = process.argv[2];
const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const app = async (js) => (await import("../devbridge.mjs")).app(js);

/** main's system prompt as written in the source (its ${…} parts left as they are) */
function seedFromFile() {
  const src = readFileSync(join(HERE, "../../src/engine/prompts.ts"), "utf8");
  const m = src.match(/export const CAPTAIN_SYSTEM = `([\s\S]*?)`;\n/);
  if (!m) throw new Error("CAPTAIN_SYSTEM not found in src/engine/prompts.ts");
  return m[1].replace(/\\`/g, "`");
}

/** a case's decisions, checked: per step its problems, and a score = share of clean steps */
function grade(c, steps) {
  const problems = steps.map((s, k) => [...check(s, (c.expect ?? [])[k] ?? {}), ...lint(s, c)]);
  const clean = problems.filter((p) => !p.length).length;
  return { score: steps.length ? clean / steps.length : 0, problems };
}

// a fixed, fake world: a case passes when the prompt holds the rule of its file (so a lesson from
// one case can carry to its siblings), or by luck of its name
const hash = (s) => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7);
function mockSim(c, system) {
  return c.messages.map((m) => {
    const text = typeof m === "string" ? m : m.text;
    const rule = c.name.split(":")[0];
    const ok = system.includes(`[[${rule}]]`) || Math.abs(hash(c.name)) % 3 !== 0;
    return { text, reply: ok ? "ok" : "", routes: ok ? [{ kind: "answer", text: "ok" }] : [], context: "(mock)", ms: 1, mock: ok ? "" : `mock: the prompt has no rule for ${rule}` };
  });
}
function mockReflect(prompt) {
  // the proposer asks for JSON edits to one part (see optimize.py); add a rule line per failing case
  const part = (prompt.match(/<part>\n([\s\S]*?)\n<\/part>/) ?? [])[1] ?? "";
  const names = [...new Set([...prompt.matchAll(/mock: the prompt has no rule for ([\w.-]+)/g)].map((m) => m[1]))];
  const last = part.split("\n").filter(Boolean).pop() ?? "";
  if (!names.length || !last) return "```json\n[]\n```";
  return "```json\n" + JSON.stringify([{ old: last, new: `${last}\n${names.map((n) => `[[${n}]]`).join(" ")}` }]) + "\n```";
}

async function run() {
  switch (op) {
    case "cases":
      return loadCases(input.names ?? []);
    case "seed": {
      if (MOCK || input.fromFile) return { text: seedFromFile(), from: "file" };
      // this branch's app says it; an app without the hook gives its source module's value
      const text = await app(`return __ui.captain.mainSystem ? __ui.captain.mainSystem() : (await import("/src/engine/prompts.ts")).CAPTAIN_SYSTEM`);
      const hook = await app(`return typeof __ui.captain.mainSystem === "function" && typeof __ui.captain.evalOneShot === "function"`);
      return { text, from: "app", hook };
    }
    case "sim": {
      const c = input.case;
      const system = input.system;
      let steps;
      if (MOCK) steps = mockSim(c, system ?? seedFromFile());
      else {
        if (system !== undefined && !(await app(`return typeof __ui.captain.mainSystem === "function"`)))
          throw new Error("the running dev app can't try another prompt: start `pnpm tauri dev` from this branch");
        const sim = { ...mainInput(c), ...(system !== undefined ? { system } : {}) };
        // an answer that isn't a list is the bridge hiccuping, not main deciding: try again
        for (let i = 0; i < 3 && !Array.isArray(steps); i++) steps = await app(`return await __ui.captain.simulateMain(${JSON.stringify(sim)})`);
        if (!Array.isArray(steps)) throw new Error(`simulateMain gave ${JSON.stringify(steps)?.slice(0, 200)}`);
      }
      const g = grade(c, steps);
      if (MOCK) g.problems = steps.map((s) => (s.mock ? [s.mock] : []));
      if (MOCK) g.score = steps.filter((s) => !s.mock).length / steps.length;
      return { ...g, steps: steps.map((s) => ({ text: s.text, reply: s.reply, routes: s.routes, error: s.error, context: (s.context ?? "").slice(0, 4000), ms: s.ms })) };
    }
    case "reflect": {
      if (MOCK) return { text: mockReflect(input.prompt) };
      return { text: await app(`return await __ui.captain.evalOneShot(${JSON.stringify(input.prompt)})`) };
    }
    default:
      throw new Error(`unknown op ${op}`);
  }
}

run().then(
  (v) => process.stdout.write(JSON.stringify(v)),
  (e) => {
    process.stdout.write(JSON.stringify({ error: String(e?.message ?? e) }));
    process.exit(1);
  },
);
