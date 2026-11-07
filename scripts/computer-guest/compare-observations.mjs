#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { ComputerObservation } from "../../extensions/lib/computer-observation.ts";

const bytes = value => Buffer.byteLength(JSON.stringify(value), "utf8");
const clone = value => JSON.parse(JSON.stringify(value));

// Consumer of the documented wire format, not another diff/normalization implementation.
function restore(previous, observation, previousEpoch) {
  if (observation.kind === "full") return clone(observation.snapshot);
  if (observation.base_epoch !== previousEpoch) throw new Error("Broken observation epoch chain");
  let result = clone(previous);
  if (observation.kind === "delta") {
    for (const change of observation.changes) {
      if (!change.path.length) {
        if (change.op !== "set") throw new Error("Cannot remove the snapshot root");
        result = clone(change.value);
        continue;
      }
      let parent = result;
      for (const key of change.path.slice(0, -1)) {
        if (!Object.hasOwn(parent, key)) throw new Error("Missing delta parent");
        parent = parent[key];
      }
      const key = change.path.at(-1);
      if (change.op === "remove") delete parent[key];
      else Object.defineProperty(parent, key, {
        value: clone(change.value), enumerable: true, writable: true, configurable: true,
      });
    }
  }
  return result;
}

function desktopEnvelope(value) {
  if (value && value.version === 1 && Object.hasOwn(value, "result")) {
    // These fields identify a captured endpoint response; they are not authenticated here.
    if (!["requestId", "taskId", "vmUuid", "bootNonce"].every(key => typeof value[key] === "string" && value[key])) {
      throw new Error("Malformed endpoint response");
    }
    return value.result;
  }
  return value;
}

/** Replay one ordered session of captured endpoint responses or desktop snapshot envelopes. */
export function compareObservations(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) throw new Error("At least one snapshot is required");
  const baseline = new ComputerObservation("offline");
  const compact = new ComputerObservation("offline");
  const kinds = { full: 0, delta: 0, unchanged: 0 };
  const rows = [];
  let restored;
  let previousEpoch;
  let fullBytes = 0;
  let compactBytes = 0;
  let desktopBytes = 0;
  let endpointResponses = 0;
  let snapshotErrors = 0;
  for (const [index, input] of inputs.entries()) {
    let envelope, full, observation;
    try {
      envelope = desktopEnvelope(input);
      if (envelope !== input) endpointResponses++;
      full = baseline.accept(envelope, true);
      observation = compact.accept(envelope);
    } catch {
      // Captures may contain secrets: do not print envelopes or parser error excerpts.
      throw new Error(`Invalid snapshot at index ${index}`);
    }
    restored = restore(restored, observation, previousEpoch);
    if (!isDeepStrictEqual(restored, clone(full.snapshot)) || full.snapshot_id !== observation.snapshot_id ||
        !isDeepStrictEqual(full.blocked_refs, observation.blocked_refs)) {
      throw new Error(`Lossless comparison failed at index ${index}`);
    }
    previousEpoch = observation.epoch;
    // Equalize only the synthetic session epoch, so instance-counter width cannot bias bytes.
    const fullSize = bytes({ ...full, epoch: observation.epoch });
    const compactSize = bytes(observation);
    fullBytes += fullSize;
    compactBytes += compactSize;
    desktopBytes += bytes(envelope);
    if (!envelope.ok) snapshotErrors++;
    kinds[observation.kind]++;
    rows.push({ index, kind: observation.kind, full_json_bytes: fullSize, compact_json_bytes: compactSize });
  }
  return {
    version: 1,
    scope: "offline normalized structured snapshots; not model or guest execution",
    observations: inputs.length,
    endpoint_responses: endpointResponses,
    snapshot_errors: snapshotErrors,
    lossless: { verified: true, compared_observations: inputs.length, scope: "normalized snapshot, snapshot_id, blocked_refs" },
    desktop_envelope_json_bytes: desktopBytes,
    full: { observations: inputs.length, json_bytes: fullBytes },
    compact: { observations: inputs.length, json_bytes: compactBytes, kinds },
    saved_json_bytes: fullBytes - compactBytes,
    unavailable: {
      model_tokens: "unavailable", model_calls: "unavailable", tool_calls: "unavailable",
      elapsed_time: "unavailable", task_success: "unavailable", image_bytes: "unavailable",
    },
    rows,
  };
}

function main(paths) {
  if (!paths.length || paths.includes("--help")) {
    console.log("Usage: node scripts/computer-guest/compare-observations.mjs capture.json [capture.json ...]\nEach file: one snapshot envelope/endpoint response or an ordered JSON array. One session per invocation. No guest connection or model calls.");
    return paths.includes("--help") ? 0 : 1;
  }
  const inputs = [];
  let rawFileBytes = 0;
  for (const [index, path] of paths.entries()) {
    let document;
    try {
      const data = readFileSync(path);
      rawFileBytes += data.length;
      document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    } catch {
      throw new Error(`Cannot read UTF-8 JSON input file at index ${index}`);
    }
    if (Array.isArray(document)) inputs.push(...document);
    else inputs.push(document);
  }
  const report = compareObservations(inputs);
  console.log(JSON.stringify({ ...report, input_files: paths.length, raw_file_bytes: rawFileBytes }, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof Error ? error.message : "Offline comparison failed");
    process.exitCode = 1;
  }
}
