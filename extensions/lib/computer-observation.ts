type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Change = { op: "set"; path: (string | number)[]; value: Json } | { op: "remove"; path: (string | number)[] };
type Observation = {
  epoch: string;
  snapshot_id?: string;
  blocked_refs?: string[];
} & (
  | { kind: "full"; snapshot: JsonObject }
  | { kind: "delta"; base_epoch: string; changes: Change[] }
  | { kind: "unchanged"; base_epoch: string }
);

// Limits apply to the entire JSON envelope, including unknown fields. Nothing is clipped.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_VALUES = 100_000;
const MAX_DEPTH = 128;
const encoder = new TextEncoder();
let instances = 0;
const has = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function object(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Copy JSON without invoking getters/toJSON or silently discarding non-JSON values. */
function copyJson(input: unknown): Json {
  let bytes = 0;
  let values = 0;
  const ancestors = new Set<object>();
  function charge(size: number) {
    bytes += size;
    if (bytes > MAX_BYTES) throw new Error("Observation exceeds the 8 MiB JSON input limit");
  }
  function string(value: string) {
    if (value.length > MAX_BYTES) throw new Error("Observation exceeds the 8 MiB JSON input limit");
    charge(encoder.encode(JSON.stringify(value)).length);
  }
  function visit(value: unknown, depth: number): Json {
    if (++values > MAX_VALUES || depth > MAX_DEPTH) {
      throw new Error("Observation exceeds the 100000 value / 128 depth input limit");
    }
    if (value === null || typeof value === "boolean") {
      charge(String(value).length);
      return value;
    }
    if (typeof value === "string") { string(value); return value; }
    if (typeof value === "number" && Number.isFinite(value)) {
      charge(JSON.stringify(value).length);
      return value;
    }
    if (typeof value !== "object" || value === null) throw new Error("Observation must contain only JSON values");
    const array = Array.isArray(value);
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new Error("Observation must contain only plain JSON objects");
    }
    if (ancestors.has(value)) throw new Error("Observation contains a cycle");
    ancestors.add(value);
    const keys = Reflect.ownKeys(value).filter(key => !(array && key === "length"));
    if (keys.length > MAX_VALUES || (array && value.length > MAX_VALUES)) {
      throw new Error("Observation exceeds the 100000 value input limit");
    }
    if (array && keys.length !== value.length) throw new Error("Observation contains a sparse or extended array");
    charge(2 + Math.max(0, keys.length - 1));
    const result: JsonObject | Json[] = array ? [] : Object.create(null);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) || (array && key !== String(i))) {
        throw new Error("Observation must contain only enumerable JSON data properties");
      }
      if (!array) { string(key); charge(1); }
      const child = visit(descriptor.value, depth + 1);
      if (Array.isArray(result)) result.push(child);
      else result[key] = child;
    }
    ancestors.delete(value);
    return result;
  }
  return visit(input, 0);
}

function changes(before: Json, after: Json, path: (string | number)[] = [], result: Change[] = []): Change[] {
  if (before === after) return result;
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    for (let i = 0; i < after.length; i++) changes(before[i], after[i], [...path, i], result);
  } else if (object(before) && object(after)) {
    for (const key of Object.keys(before)) {
      if (!has(after, key)) result.push({ op: "remove", path: [...path, key] });
    }
    for (const key of Object.keys(after)) {
      if (!has(before, key)) result.push({ op: "set", path: [...path, key], value: after[key] });
      else changes(before[key], after[key], [...path, key], result);
    }
  } else {
    // Different-length arrays are replaced atomically; remove only ever deletes an object key.
    result.push({ op: "set", path, value: after });
  }
  return result;
}

/**
 * One instance owns one desktop session. Construct a new instance when the session changes.
 *
 * full.snapshot is the CLI envelope with tree ref_id values replaced by epoch-local eN aliases
 * and data.snapshot_id moved to the observation's snapshot_id. Other fields are unchanged.
 * delta.changes applies to that normalized envelope from base_epoch, in order: set replaces
 * a value at a literal key/index path (an empty path replaces the root); remove deletes an
 * object key. unchanged reuses that envelope. Always adopt the new epoch and snapshot_id,
 * even for unchanged. No alias denotes persistent element identity across observations.
 *
 * resolve is the only alias-to-CLI boundary. Partial/identity-unproven snapshots remain
 * visible but cannot authorize actions. blocked_refs lists aliases with duplicated raw IDs.
 * Errors are full envelopes with no actionable refs; the next success starts a new baseline.
 */
export class ComputerObservation {
  private readonly prefix: string;
  private revision = 0;
  private epoch = "";
  private baselineEpoch = "";
  private rawSnapshot?: JsonObject;
  private snapshot?: JsonObject;
  private refs = new Map<string, string>();
  private blocked = new Set<string>();
  private refusal?: string;

  constructor(sessionId: string) {
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256) {
      throw new Error("A session ID of 1 to 256 characters is required");
    }
    this.prefix = `${encodeURIComponent(sessionId)}:${++instances}`;
  }

  accept(envelope: unknown, full = false): Observation {
    // A failed observation must never leave the previous action targets live.
    const baseEpoch = this.baselineEpoch;
    this.invalidateRefs();
    try {
      const raw = copyJson(envelope);
      if (!object(raw) || raw.version !== "2.6" || raw.command !== "snapshot" || typeof raw.ok !== "boolean") {
        throw new Error("Expected an agent-desktop 2.6 snapshot envelope");
      }
      const epoch = `${this.prefix}:${++this.revision}`;
      if (!raw.ok) {
        if (!object(raw.error) || typeof raw.error.code !== "string" || typeof raw.error.message !== "string" ||
            !object(raw.error.disposition) || typeof raw.error.disposition.delivery !== "string" ||
            typeof raw.error.disposition.retry !== "string") {
          throw new Error("Malformed snapshot error envelope");
        }
        this.invalidate();
        return { epoch, kind: "full", snapshot: raw };
      }
      const data = raw.data;
      if (!object(data) || typeof data.snapshot_id !== "string" || !/^[^\s:]+$/.test(data.snapshot_id) ||
          typeof data.complete !== "boolean" || !object(data.tree)) {
        throw new Error("Malformed snapshot data");
      }
      const snapshotId = data.snapshot_id;
      if (!data.complete) this.refusal = "Partial snapshot refs cannot be resolved";
      const checkEvidence = (value: JsonObject) => {
        for (const key of ["truncated", "subtree_truncated", "identity_unproven"]) {
          if (has(value, key) && typeof value[key] !== "boolean") throw new Error(`Malformed ${key} evidence`);
          if (value[key] === true) this.refusal = "Partial or identity_unproven snapshot refs cannot be resolved";
        }
      };
      checkEvidence(data);
      const snapshot = JSON.parse(JSON.stringify(raw)) as JsonObject;
      const normalizedData = snapshot.data as JsonObject;
      delete normalizedData.snapshot_id;
      const rawAliases = new Map<string, string[]>();
      const visit = (node: Json) => {
        if (!object(node) || typeof node.role !== "string" || !node.role) throw new Error("Malformed snapshot tree node");
        checkEvidence(node);
        if (has(node, "ref_id")) {
          const ref = node.ref_id;
          if (typeof ref !== "string" || !ref.startsWith(`@${snapshotId}:`) || !/^e\d+$/.test(ref.slice(snapshotId.length + 2))) {
            throw new Error("Malformed or foreign snapshot ref_id");
          }
          const alias = `e${this.refs.size + 1}`;
          this.refs.set(alias, ref);
          const aliases = rawAliases.get(ref) ?? [];
          aliases.push(alias);
          rawAliases.set(ref, aliases);
          node.ref_id = alias;
        }
        if (has(node, "children")) {
          if (!Array.isArray(node.children)) throw new Error("Malformed snapshot children");
          for (const child of node.children) visit(child);
        }
      };
      visit(normalizedData.tree);
      for (const aliases of rawAliases.values()) {
        if (aliases.length > 1) for (const alias of aliases) this.blocked.add(alias);
      }
      const header = {
        epoch,
        snapshot_id: snapshotId,
        ...(this.blocked.size ? { blocked_refs: [...this.blocked] } : {}),
      };
      const complete: Observation = { ...header, kind: "full", snapshot };
      let output: Observation = complete;
      if (!full && this.rawSnapshot && this.snapshot && baseEpoch) {
        const patch = changes(this.snapshot, snapshot);
        const compact: Observation = patch.length
          ? { ...header, kind: "delta", base_epoch: baseEpoch, changes: patch }
          : { ...header, kind: "unchanged", base_epoch: baseEpoch };
        if (encoder.encode(JSON.stringify(compact)).length <= encoder.encode(JSON.stringify(complete)).length) output = compact;
      }
      this.rawSnapshot = raw;
      // Keep caller mutations of the returned envelope/patch out of the next baseline.
      this.snapshot = JSON.parse(JSON.stringify(snapshot)) as JsonObject;
      this.epoch = epoch;
      this.baselineEpoch = epoch;
      return output;
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }

  resolve(epoch: string, ref: string): string {
    if (!this.epoch || epoch !== this.epoch) throw new Error("Stale observation epoch");
    if (this.refusal) throw new Error(this.refusal);
    const raw = this.refs.get(ref);
    if (!raw) throw new Error("Unknown observation ref");
    if (this.blocked.has(ref)) throw new Error("Duplicate raw ref cannot be resolved");
    return raw;
  }

  /** Consume action targets while retaining the last emitted comparison baseline. */
  invalidateRefs(): void {
    this.epoch = "";
    this.refs.clear();
    this.blocked.clear();
    this.refusal = undefined;
  }

  invalidate(): void {
    this.invalidateRefs();
    this.baselineEpoch = "";
    this.rawSnapshot = undefined;
    this.snapshot = undefined;
  }
}
