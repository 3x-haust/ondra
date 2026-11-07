import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compareObservations } from "../scripts/computer-guest/compare-observations.mjs";

function snapshot(id: string) {
  return {
    version: "2.6", command: "snapshot", ok: true,
    data: {
      snapshot_id: id, complete: true,
      tree: { role: "window", name: "문서 👋", children: Array.from({ length: 20 }, (_, index) => ({
        role: "textfield", ref_id: `@${id}:e${index + 10}`, name: `항목 ${index}`, value: "원래 내용",
      })) },
    },
    future: JSON.parse('{"a/b~.c":[1,null,{"enabled":false}],"__proto__":{"value":"before"},"removed":true}'),
  };
}
const errorSnapshot = {
  version: "2.6", command: "snapshot", ok: false,
  error: { code: "TIMEOUT", message: "Not delivered", disposition: { delivery: "not_delivered", retry: "safe" } },
};
const endpoint = (result: unknown) => ({
  version: 1, requestId: "fixture-request", taskId: "fixture-task", vmUuid: "fixture-vm",
  bootNonce: "private-fixture-nonce", result,
});
const script = resolve("scripts/computer-guest/compare-observations.mjs");

function runFiles(files: string[]) {
  const directory = mkdtempSync(join(tmpdir(), "ondra-observation-comparison-"));
  try {
    const paths = files.map((data, index) => {
      const path = join(directory, `${index}.json`);
      writeFileSync(path, data, { mode: 0o600 });
      return path;
    });
    return spawnSync(process.execPath, [script, ...paths], { encoding: "utf8", timeout: 10_000 });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe("offline observation comparison", () => {
  it("uses the same snapshots for full and compact and verifies lossless reconstruction", () => {
    const inputs = [snapshot("s1"), snapshot("s2"), snapshot("s3")];
    inputs[2].data.tree.children[3].value = "새 값 👨‍👩‍👧‍👦";
    const original = structuredClone(inputs);
    const report = compareObservations(inputs);
    expect(report.lossless).toMatchObject({ verified: true, compared_observations: 3 });
    expect(report.full.observations).toBe(3);
    expect(report.compact.observations).toBe(3);
    expect(report.compact.kinds).toEqual({ full: 1, delta: 1, unchanged: 1 });
    expect(report.saved_json_bytes).toBeGreaterThan(0);
    expect(report.saved_json_bytes).toBe(report.full.json_bytes - report.compact.json_bytes);
    expect(report.desktop_envelope_json_bytes).toBe(inputs.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0));
    expect(report.rows.reduce((sum: number, row: { compact_json_bytes: number }) => sum + row.compact_json_bytes, 0)).toBe(report.compact.json_bytes);
    expect(inputs).toEqual(original);
    expect(Object.values(report.unavailable).every(value => value === "unavailable")).toBe(true);
  });

  it("preserves literal keys, prototype-like keys, removals and array topology", () => {
    const before = snapshot("s1"), after = snapshot("s2");
    after.future["a/b~.c"][2].enabled = true;
    after.future.__proto__.value = "after";
    delete after.future.removed;
    after.data.tree.children.pop();
    const report = compareObservations([before, after]);
    expect(report.lossless.verified).toBe(true);
    expect(Object.prototype).not.toHaveProperty("value");
  });

  it("retains partial and duplicate-ref evidence without claiming task success", () => {
    const partial = snapshot("s2");
    partial.data.complete = false;
    partial.data.tree.children[1].ref_id = partial.data.tree.children[0].ref_id;
    const report = compareObservations([snapshot("s1"), partial]);
    expect(report.lossless.verified).toBe(true);
    expect(report.unavailable.task_success).toBe("unavailable");
  });

  it("includes error envelopes and requires a fresh full after errors", () => {
    const report = compareObservations([snapshot("s1"), errorSnapshot, snapshot("s2")]);
    expect(report.snapshot_errors).toBe(1);
    expect(report.compact.kinds).toEqual({ full: 3, delta: 0, unchanged: 0 });
    expect(report.saved_json_bytes).toBe(0);
  });

  it("rejects empty inputs, malformed observations and non-snapshot captures", () => {
    expect(() => compareObservations([])).toThrow("At least one snapshot");
    expect(() => compareObservations([snapshot("s1"), { private: "secret" }])).toThrow("Invalid snapshot at index 1");
    expect(() => compareObservations([{ ...snapshot("s1"), command: "screenshot" }])).toThrow("Invalid snapshot");
    expect(() => compareObservations([{ version: 1, result: snapshot("s1") }])).toThrow("Invalid snapshot");
  });

  it("runs directly in Node on endpoint files, counts exact UTF-8 file bytes and exposes no payload", () => {
    const files = [JSON.stringify(endpoint(snapshot("s1")), null, 2) + "\n", JSON.stringify([endpoint(snapshot("s2"))])];
    const result = runFiles(files);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.input_files).toBe(2);
    expect(report.raw_file_bytes).toBe(files.reduce((sum, file) => sum + Buffer.byteLength(file), 0));
    expect(report.endpoint_responses).toBe(2);
    expect(report.compact.kinds.unchanged).toBe(1);
    expect(result.stdout).not.toContain("private-fixture-nonce");
    expect(result.stdout).not.toContain("원래 내용");
    expect(result.stdout).not.toContain("fixture-task");
    expect(report.unavailable.model_tokens).toBe("unavailable");
  });

  it("fails CLI parsing without leaking private input excerpts or partial reports", () => {
    const result = runFiles(['{"secret":"private-fixture-secret",']);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Cannot read UTF-8 JSON input file at index 0");
    expect(result.stderr).not.toContain("private-fixture-secret");
  });

  it("documents usage without opening a connection", () => {
    const result = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("No guest connection or model calls");
  });
});
