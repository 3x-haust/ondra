import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const computerAssets = [
  ["runner", "ondra-computer-host"],
  ["endpoint", "ondra-computer-endpoint"],
  ["provisioner", "ondra-computer-provision"],
  ["installer", "install-setup.sh"],
  ["desktop", "agent-desktop"],
  ["helper", "agent-desktop-macos-helper"],
];
// npm agent-desktop@1.1.0, darwin-arm64; independent of adjacent checksum files.
const pinned = {
  "agent-desktop": "a89c781a3b2cf29bc0467c30a4e1063b6f564858540f2dc58a75c79ce2c9d9f3",
  "agent-desktop-macos-helper": "d81e5aa7ad8edb0e3eda72f010b1947ce7d6ad6d6d4ae95a69f4cce39bbbfe63",
};

function digest(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size === 0) throw new Error(`invalid computer asset: ${path}`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function verifyPin(name, hash) {
  if (pinned[name] && hash !== pinned[name]) throw new Error(`expected pinned agent-desktop@1.1.0 darwin-arm64 asset: ${name}`);
}
function inspect(directory) {
  if (!lstatSync(directory).isDirectory()) throw new Error(`invalid computer asset directory: ${directory}`);
  return computerAssets.map(([role, name]) => {
    const hash = digest(join(directory, name));
    verifyPin(name, hash);
    return [role, `computer/${name}`, hash];
  });
}

export function stageComputerAssets(projectRoot = root) {
  const packageRoot = join(projectRoot, "node_modules/agent-desktop");
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (pkg.name !== "agent-desktop" || pkg.version !== "1.1.0") throw new Error("computer assets require agent-desktop@1.1.0");
  for (const name of Object.keys(pinned)) verifyPin(name, digest(join(packageRoot, "bin", `${name}-darwin-arm64`)));
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("computer assets require macOS arm64");
  const resources = join(projectRoot, "src-tauri/resources");
  mkdirSync(resources, { recursive: true });
  const temporary = mkdtempSync(join(resources, ".computer-"));
  try {
    execFileSync("/bin/bash", [join(projectRoot, "scripts/computer-host/build.sh"), temporary], { cwd: projectRoot, stdio: "inherit" });
    for (const name of Object.keys(pinned)) copyFileSync(join(packageRoot, "bin", `${name}-darwin-arm64`), join(temporary, name));
    inspect(temporary);
    for (const [, name] of computerAssets) {
      chmodSync(join(temporary, name), 0o755);
      rmSync(join(temporary, `${name}.sha256`), { force: true });
    }
    const destination = join(resources, "computer");
    rmSync(destination, { recursive: true, force: true });
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function sealComputerAssets(directory, output, profile, target) {
  rmSync(output, { force: true });
  let assets;
  try {
    if (target !== "aarch64-apple-darwin") throw new Error(`unsupported computer asset target: ${target}`);
    assets = inspect(directory);
  } catch (error) {
    if (profile !== "debug") throw error;
    console.error(`computer assets unavailable: ${error.message}`);
  }
  const value = assets ? `Some([\n${assets.map((asset) => `    (${asset.map((v) => JSON.stringify(v)).join(", ")}),`).join("\n")}\n])` : "None";
  writeFileSync(output, `pub const COMPUTER_ASSETS: Option<[(&str, &str, &str); 6]> = ${value};\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === "stage" && args.length === 0) stageComputerAssets();
    else if (command === "seal" && args.length === 4) sealComputerAssets(...args);
    else throw new Error("usage: computer-assets.mjs stage | seal <directory> <output.rs> <profile> <target>");
  } catch (error) {
    console.error(`computer assets: ${error.message}`);
    process.exitCode = 1;
  }
}
