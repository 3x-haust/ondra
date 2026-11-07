#!/usr/bin/env python3
"""Run a known-source macOS calibration; never accepts an external executable."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import signal
import subprocess
import sys


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="new evidence directory (must not exist)")
    parser.add_argument("--runtime-only", action="store_true",
                        help="validate disassembly and normal execution only; explicitly leave debugger unverified")
    args = parser.parse_args()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)
    summary = {"status": "incomplete", "host": platform.platform(), "machine": platform.machine(),
               "scope": "owned known-source calibration; no decompilation or unknown binaries",
               "debugger": "not requested" if args.runtime_only else "unverified"}
    env = {"LC_ALL": "C", "LANG": "C"}
    sequence = 0

    def run(label, argv, expected=0, timeout=300):
        nonlocal sequence
        sequence += 1
        stem = f"{sequence:02d}-{label}"
        stdout, stderr = out / f"{stem}.stdout.txt", out / f"{stem}.stderr.txt"
        record = {"label": label, "argv": [str(a) for a in argv], "cwd": str(out), "env": env,
                  "time": datetime.now(timezone.utc).isoformat(), "stdout": stdout.name, "stderr": stderr.name,
                  "timeout_seconds": timeout}
        try:
            with stdout.open("w") as so, stderr.open("w") as se:
                with subprocess.Popen(record["argv"], cwd=out, env={**os.environ, **env},
                                      stdout=so, stderr=se) as process:
                    try:
                        returncode = process.wait(timeout=timeout)
                    except subprocess.TimeoutExpired:
                        # debugserver starts a separate session; a process-group kill misses it.
                        try:
                            rows = subprocess.check_output(["/bin/ps", "-axo", "pid=,ppid="], text=True, timeout=5)
                            parents = {int(pid): int(ppid) for pid, ppid in (row.split() for row in rows.splitlines())}
                            owned = {process.pid}
                            while True:
                                descendants = {pid for pid, parent in parents.items() if parent in owned}
                                if descendants <= owned:
                                    break
                                owned |= descendants
                            for pid in reversed(sorted(owned - {process.pid})):
                                try:
                                    os.kill(pid, signal.SIGTERM)
                                except ProcessLookupError:
                                    pass
                        except (OSError, subprocess.SubprocessError, ValueError) as cleanup_error:
                            record["cleanup_error"] = str(cleanup_error)
                        finally:
                            process.kill()
                            process.wait()
                        raise
            record["exit_code"] = returncode
        except (OSError, subprocess.TimeoutExpired) as error:
            record["error"] = str(error)
            raise RuntimeError(f"{label}: {error}") from error
        finally:
            with (out / "commands.jsonl").open("a") as log:
                log.write(json.dumps(record) + "\n")
        require(returncode == expected,
                f"{label}: expected exit {expected}, got {returncode}; see {stderr.name}")
        return stdout.read_text()

    try:
        require(platform.system() == "Darwin" and platform.machine() in ("arm64", "x86_64"),
                "This calibration needs native macOS arm64 or x86_64; use the tool guide for other hosts")
        tools = {name: shutil.which(name) for name in ("clang", "file", "nm", "otool", "lldb")}
        summary["tools"] = tools
        require(all(tools.values()), f"Missing tools: {', '.join(k for k, v in tools.items() if not v)}")
        for name in ("clang", "file", "otool", "lldb"):
            run(f"version-{name}", [tools[name], "--version"])
        source = Path(__file__).resolve().parents[1] / "samples" / "bucket.c"
        copied = out / "bucket.c"
        shutil.copyfile(source, copied)
        binary = out / "bucket"
        run("compile", [tools["clang"], "-O1", "-g0", "-Wall", "-Wextra", "-Werror", copied, "-o", binary])
        summary["target"] = {"path": str(binary), "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                             "bytes": binary.stat().st_size, "source_sha256": hashlib.sha256(copied.read_bytes()).hexdigest()}
        identity = run("identity", [tools["file"], binary])
        require("Mach-O" in identity, "Expected Mach-O identity")
        run("headers", [tools["otool"], "-hv", binary])
        symbols = run("symbols", [tools["nm"], binary])
        require("_classify_bucket" in symbols, "Sample function missing from symbols")
        run("disassembly", [tools["otool"], "-tvV", binary])
        static = run("function", [tools["lldb"], "--no-lldbinit", "--batch", str(binary),
                                  "-o", "disassemble --name classify_bucket --bytes"])
        require("ret" in static and "classify_bucket" in static, "Function disassembly missing")
        (out / "hypotheses.md").write_text(
            "# Known-source calibration predictions (before dynamic runs)\n\n"
            "H1: classify_bucket uses the low byte: 112 and 368 return 7; 113 and 0 return 3.\n"
            "Alternative H2: full integer equality with 112; 368 would return 3.\n"
            "Falsifier for H1: 368 returns 3, or a control returns 7.\n"
            "Static evidence: function/disassembly logs; inspect the mask and comparison.\n"
            "The compiler may fold XOR + comparison. No original-source recovery is claimed.\n"
            "This prediction is designed from the owned fixture, not a blind discovery.\n")
        observed = []
        for value, bucket in ((112, 7), (113, 3), (368, 7), (0, 3)):
            text = run(f"input-{value}", [binary, str(value)])
            require(text == f"bucket={bucket}\n", f"Unexpected output for {value}: {text!r}")
            observed.append({"input": value, "bucket": bucket})
        run("invalid-input", [binary, "invalid"], expected=2)
        summary["observations"] = observed
        arg_reg, ret_reg = ("w0", "w0") if platform.machine() == "arm64" else ("edi", "eax")
        for value, bucket in (() if args.runtime_only else ((112, 7), (113, 3), (368, 7))):
            commands = ["breakpoint set --name classify_bucket --skip-prologue false", f"run {value}",
                        "image list -o -f", "breakpoint list", f"register read {arg_reg}",
                        "disassemble --name classify_bucket --bytes", "thread step-out",
                        f"register read {ret_reg}", "continue"]
            argv = [tools["lldb"], "--no-lldbinit", "--batch", str(binary)]
            for command in commands:
                argv.extend(["-o", command])
            text = run(f"debug-{value}", argv, timeout=45)
            require("stop reason = breakpoint" in text and "hit count = 1" in text,
                    f"No actual breakpoint hit for {value}")
            values = re.findall(rf"\b(?:{arg_reg}|{ret_reg})\s*=\s*0x([0-9a-fA-F]+)", text)
            require([int(v, 16) for v in values] == [value, bucket],
                    f"Unexpected argument/return registers for {value}: {values}")
            require(f"bucket={bucket}" in text and "exited with status = 0" in text,
                    f"Debugged process did not finish as expected for {value}")
        summary.update(status="passed", observations=observed, debugger_cases=0 if args.runtime_only else 3,
                       debugger="not requested" if args.runtime_only else "passed",
                       conclusion="H1 supported on tested inputs; H2 rejected by input 368")
    except (OSError, RuntimeError) as error:
        summary["reason"] = str(error)
    (out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))
    return 0 if summary["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
