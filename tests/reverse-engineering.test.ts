import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve("skills/reverse-engineering/scripts/verify.py");
let home: string;
let out: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ondra-reverse-test-"));
  out = join(home, "evidence");
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function python(args: string[]) {
  const result = spawnSync("python3", ["-I", "-B", ...args], {
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH, LC_ALL: "C", LANG: "C" },
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  return result;
}

const load = `
import json, runpy, subprocess, sys
from pathlib import Path
from unittest.mock import MagicMock, patch
module = runpy.run_path(sys.argv[1], run_name="verification_probe")
out = Path(sys.argv[2])
sys.argv = [sys.argv[1], "--out", str(out)]
`;

function boundary(code: string) {
  return python(["-c", load + code, script, out]);
}

function incomplete(result: ReturnType<typeof python>) {
  expect(result.status, result.stdout + result.stderr).toBe(1);
  const summary = JSON.parse(readFileSync(join(out, "summary.json"), "utf8"));
  expect(summary.status).toBe("incomplete");
  expect(summary.debugger).toBe("unverified");
  expect(summary).not.toHaveProperty("target");
  expect(summary).not.toHaveProperty("observations");
  return summary;
}

// These exercise CLI orchestration and OS error boundaries, not binary analysis.
describe("reverse-engineering verification CLI", () => {
  it("shows help without creating evidence or running analysis", () => {
    const result = python([script, "--help"]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("--out");
    expect(result.stdout).toContain("--runtime-only");
    expect(result.stdout).toContain("never accepts an external executable");
    expect(readdirSync(home)).toEqual([]);
  });

  it.each(["positional", "target-option"])("rejects an external target supplied as %s", (mode) => {
    const target = join(home, "external-target");
    writeFileSync(target, "not an executable\n");
    const args = mode === "positional" ? [target] : ["--target", target];

    const result = python([script, "--out", out, ...args]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unrecognized arguments");
    expect(existsSync(out)).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("not an executable\n");
  });

  it("refuses to overwrite an existing evidence directory", () => {
    const sentinel = join(home, "summary.json");
    writeFileSync(sentinel, "existing evidence\n");

    const result = python([script, "--out", home]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("FileExistsError");
    expect(readdirSync(home)).toEqual(["summary.json"]);
    expect(readFileSync(sentinel, "utf8")).toBe("existing evidence\n");
  });

  it.each([["Linux", "arm64"], ["Darwin", "riscv64"]])(
    "reports incomplete on unsupported platform %s/%s without launching tools",
    (system, machine) => {
      const result = boundary(`
with patch("platform.platform", return_value="test-boundary"), \\
     patch("platform.system", return_value=${JSON.stringify(system)}), \\
     patch("platform.machine", return_value=${JSON.stringify(machine)}), \\
     patch("subprocess.Popen", side_effect=AssertionError("must not launch tools")):
    sys.exit(module["main"]())
`);

      expect(incomplete(result).reason).toContain("needs native macOS arm64 or x86_64");
      expect(existsSync(join(out, "commands.jsonl"))).toBe(false);
    },
  );

  it("reports missing tooling as incomplete without launching commands", () => {
    const result = boundary(`
with patch("platform.platform", return_value="test-boundary"), \\
     patch("platform.system", return_value="Darwin"), \\
     patch("platform.machine", return_value="arm64"), \\
     patch("shutil.which", return_value=None), \\
     patch("subprocess.Popen", side_effect=AssertionError("must not launch tools")):
    sys.exit(module["main"]())
`);

    const summary = incomplete(result);
    expect(summary.reason).toBe("Missing tools: clang, file, nm, otool, lldb");
    expect(summary.tools).toEqual({ clang: null, file: null, nm: null, otool: null, lldb: null });
    expect(existsSync(join(out, "commands.jsonl"))).toBe(false);
  });

  it.each(["discovery", "sigterm"])(
    "kills and reaps the owned parent before context exit when timeout cleanup fails at %s",
    (failure) => {
      const result = boundary(`
failure = ${JSON.stringify(failure)}
process = MagicMock()
process.pid = 910001
process.__enter__.return_value = process
process.wait.side_effect = [subprocess.TimeoutExpired(["fake-clang"], 300), 0]
exits = []
def exit_process(*args):
    # Real Popen.__exit__ waits; record its entry instead of hanging this test.
    exits.append({"killed": process.kill.called, "wait_calls": process.wait.call_count})
    return False
process.__exit__.side_effect = exit_process
with patch("platform.platform", return_value="test-boundary"), \\
     patch("platform.system", return_value="Darwin"), \\
     patch("platform.machine", return_value="arm64"), \\
     patch("shutil.which", return_value="/controlled/fake-tool"), \\
     patch("subprocess.Popen", return_value=process), \\
     patch("subprocess.check_output", return_value="910002 910001\\n", 
           side_effect=OSError("ps unavailable") if failure == "discovery" else None) as discover, \\
     patch("os.kill", side_effect=PermissionError("SIGTERM denied")) as terminate:
    status = module["main"]()
(out / "boundary.json").write_text(json.dumps({
    "exits": exits,
    "kill_calls": process.kill.call_count,
    "discovery_calls": discover.call_count,
    "terminate_calls": terminate.call_count,
    "process_calls": [call[0] for call in process.mock_calls],
}))
sys.exit(status)
`);

      const summary = incomplete(result);
      expect(summary.reason).toContain("version-clang");
      const cleanup = JSON.parse(readFileSync(join(out, "boundary.json"), "utf8"));
      expect(cleanup.discovery_calls).toBe(1);
      expect(cleanup.terminate_calls).toBe(failure === "sigterm" ? 1 : 0);
      expect(cleanup.kill_calls, "owned parent must be killed even when descendant cleanup fails").toBe(1);
      expect(cleanup.exits).toEqual([{ killed: true, wait_calls: 2 }]);
      expect(cleanup.process_calls).toEqual(["__enter__", "wait", "kill", "wait", "__exit__"]);
      const records = readFileSync(join(out, "commands.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(records).toHaveLength(1);
      expect(records[0].label).toBe("version-clang");
      expect(records[0].error).toContain("timed out after 300 seconds");
      expect(records[0].cleanup_error).toBe(failure === "discovery" ? "ps unavailable" : "SIGTERM denied");
      expect(records[0]).not.toHaveProperty("exit_code");
    },
  );
});
