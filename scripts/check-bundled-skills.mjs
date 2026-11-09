// Checks the actual macOS bundle without personal skills, credentials or model calls.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length !== 3 || process.argv[2] === "--help") {
  console.log("Usage: node scripts/check-bundled-skills.mjs <path/to/Ondra.app>");
  process.exit(process.argv[2] === "--help" ? 0 : 1);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const contents = resolve(process.argv[2], "Contents");
const resources = join(contents, "Resources");
const bundled = join(resources, "app-skills");
// the engine component inside the dmg's app; an app built before components had it in MacOS
const engineDir = [join(resources, "components", "engine"), join(resources, "engine")].find((d) => existsSync(join(d, "package.json"))) ?? join(resources, "engine");
const engine = [join(engineDir, "ondra-engine"), join(contents, "MacOS", "ondra-engine")].find(existsSync) ?? join(engineDir, "ondra-engine");
const mimikyu = join(bundled, "mimikyu", "SKILL.md");
const search = join(resources, "app-extensions", "skills.ts");

// Check every supporting file too, preserving paths and bytes.
function checkFiles(source, target) {
  const entries = readdirSync(source, { withFileTypes: true });
  assert.deepEqual(readdirSync(target).sort(), entries.map((e) => e.name).sort(), `File list differs: ${target}`);
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) checkFiles(from, to);
    else assert.ok(readFileSync(from).equals(readFileSync(to)), `Bundled content differs: ${to}`);
  }
}
checkFiles(join(root, "skills", "mimikyu"), join(bundled, "mimikyu"));
assert.ok(existsSync(engine), `Missing bundled engine: ${engine}`);
assert.ok(readFileSync(search).equals(readFileSync(join(root, "extensions", "skills.ts"))), "Bundled skill search differs");

// Match worker_skills' immediate child SKILL.md paths, not Pi's auto-discovery.
const paths = readdirSync(bundled).sort().map((name) => join(bundled, name, "SKILL.md")).filter(existsSync);
assert.ok(paths.includes(mimikyu), "mimikyu is missing from worker skill paths");
assert.ok(paths.includes(join(bundled, "browser-use", "SKILL.md")), "Missing browser-use prerequisite");
const home = mkdtempSync(join(tmpdir(), "ondra-skill-check-"));
try {
  const result = spawnSync(engine, [
    "--mode", "rpc", "--no-session", "--offline", "--no-approve", "--no-context-files",
    "--no-extensions", "--no-prompt-templates", "--no-themes", "--no-skills",
    "--extension", search,
  ], {
    cwd: home,
    env: {
      HOME: home,
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      PI_PACKAGE_DIR: engineDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      ONDRA_SKILL_PATHS: JSON.stringify(paths),
    },
    input: '{"id":"context","type":"get_context"}\n',
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const records = result.stdout.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  const context = records.find((record) => record.type === "response" && record.id === "context");
  assert.equal(context?.success, true);
  assert.deepEqual(context.data.skills, []);
  assert.ok(!context.data.systemPrompt.includes("<available_skills>"));
  assert.ok(context.data.tools.some((tool) => tool.name === "skill_search" && tool.active));
  console.log(JSON.stringify({ bundle: resolve(process.argv[2]), filesMatch: true, personalSkills: false, modelCalls: 0, searchablePaths: paths.length }, null, 2));
} finally {
  rmSync(home, { recursive: true, force: true });
}
